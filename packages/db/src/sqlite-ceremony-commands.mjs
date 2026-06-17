import { randomUUID } from "node:crypto";
import { ceremonyRunDto } from "../../contracts/src/index.mjs";
import { isCeremonyType } from "../../domain/src/index.mjs";

export function createCeremonyCommands({
  database,
  getCountMap,
  getProjectPolicyRow,
  getProjectRow,
  getRepoTargetsByTicketId,
  getStore,
  insertEvent,
  listTicketRows,
  mapProjectPolicy,
  mapRepo,
  mapTicket,
  now,
  optionalText,
  requiredText,
  withTransaction,
}) {
  const commands = {
    listCeremonyRuns(projectId) {
      if (!getProjectRow(database, projectId)) {
        return null;
      }

      const runs = database
        .prepare("select * from ceremony_runs where project_id = ? order by created_at desc limit 20")
        .all(projectId)
        .map(mapCeremonyRun);
      const proposalsByRunId = getCeremonyProposalsByRunId(
        database,
        projectId,
        runs.map((run) => run.id),
      );
      const participantsByRunId = getCeremonyParticipantsByRunId(
        database,
        projectId,
        runs.map((run) => run.id),
      );
      return runs.map((run) =>
        ceremonyRunDto(run, proposalsByRunId.get(run.id) || [], participantsByRunId.get(run.id) || []),
      );
    },

    getCeremonyRun(projectId, runId) {
      const row = database
        .prepare("select * from ceremony_runs where project_id = ? and id = ?")
        .get(projectId, runId);
      if (!row) {
        return null;
      }
      const run = mapCeremonyRun(row);
      return ceremonyRunDto(
        run,
        getCeremonyProposalsByRunId(database, projectId, [run.id]).get(run.id) || [],
        getCeremonyParticipantsByRunId(database, projectId, [run.id]).get(run.id) || [],
      );
    },

    createCeremonyRun(projectId, input) {
      const project = getProjectRow(database, projectId);
      if (!project) {
        return null;
      }
      if (!isCeremonyType(input.type)) {
        throw new Error(`Invalid ceremony type: ${input.type}`);
      }

      const timestamp = now();
      const runId = `ceremony_${randomUUID()}`;
      const snapshot = buildCeremonyInputSnapshot(database, projectId);
      const scope = buildCeremonyScope(input.type, input);
      const proposals = buildCeremonyProposals(input.type, snapshot, timestamp);
      const summary = buildCeremonySummary(input.type, snapshot, proposals, scope);
      const run = {
        id: runId,
        projectId,
        type: input.type,
        status: "proposed",
        scope,
        inputSnapshot: snapshot,
        summaryMd: summary.summaryMd,
        questionsMd: summary.questionsMd,
        riskMd: summary.riskMd,
        createdByKind: optionalText(input.createdByKind, "human"),
        createdByRef: optionalText(input.createdByRef, "operator"),
        startedAt: timestamp,
        finishedAt: timestamp,
        appliedAt: "",
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      withTransaction(database, () => {
        database
          .prepare(
            `insert into ceremony_runs (
              id, project_id, type, status, scope_json, input_snapshot_json, summary_md,
              questions_md, risk_md, created_by_kind, created_by_ref, started_at,
              finished_at, applied_at, created_at, updated_at
            ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            run.id,
            run.projectId,
            run.type,
            run.status,
            JSON.stringify(run.scope),
            JSON.stringify(run.inputSnapshot),
            run.summaryMd,
            run.questionsMd,
            run.riskMd,
            run.createdByKind,
            run.createdByRef,
            run.startedAt,
            run.finishedAt,
            run.appliedAt || null,
            run.createdAt,
            run.updatedAt,
          );

        insertEvent(database, {
          projectId,
          type: "ceremony.started",
          summary: `${prettyCeremonyType(input.type)} started`,
          detail: `${snapshot.tickets.length} ticket(s), ${snapshot.repos.length} repo(s) in scope. Participants: ${scope.participantRoles.join(", ")}. Decider: ${scope.deciderRole}.`,
          reasonCode: input.type,
          reasonSource: "ceremony",
        });

        for (const proposal of proposals) {
          database
            .prepare(
              `insert into ceremony_proposals (
                id, project_id, run_id, kind, status, summary, ticket_id,
                payload_json, applied_ticket_id, applied_at, created_at, updated_at
              ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              proposal.id,
              projectId,
              runId,
              proposal.kind,
              "pending",
              proposal.summary,
              proposal.ticketId || null,
              JSON.stringify(proposal.payload || {}),
              null,
              null,
              timestamp,
              timestamp,
            );
        }

        for (const role of scope.participantRoles || []) {
          database
            .prepare(
              `insert into ceremony_participants (
                id, project_id, run_id, role, status, outcome, summary_md,
                questions_md, risk_md, payload_json, started_at, finished_at,
                created_at, updated_at
              ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              `ceremony_participant_${randomUUID()}`,
              projectId,
              runId,
              role,
              "pending",
              "",
              "",
              "",
              "",
              "{}",
              null,
              null,
              timestamp,
              timestamp,
            );
        }

        insertEvent(database, {
          projectId,
          type: "ceremony.proposed",
          summary: `${prettyCeremonyType(input.type)} proposed ${proposals.length} change(s)`,
          detail: summary.summaryMd,
          reasonCode: input.type,
          reasonSource: "ceremony",
        });
      });

      return commands.getCeremonyRun(projectId, runId);
    },

    listPendingCeremonyParticipants() {
      return database
        .prepare(
          `select cp.*, cr.type as ceremony_type
           from ceremony_participants cp
           join ceremony_runs cr on cr.id = cp.run_id
           where cp.status = 'pending'
           order by cp.created_at asc`,
        )
        .all()
        .map(mapCeremonyParticipant);
    },

    startCeremonyParticipant(projectId, participantId) {
      const existing = database
        .prepare("select * from ceremony_participants where project_id = ? and id = ?")
        .get(projectId, participantId);
      if (!existing || existing.status !== "pending") {
        return existing ? mapCeremonyParticipant(existing) : null;
      }
      const timestamp = now();
      database
        .prepare(
          "update ceremony_participants set status = 'running', started_at = ?, updated_at = ? where project_id = ? and id = ?",
        )
        .run(timestamp, timestamp, projectId, participantId);
      database
        .prepare("update ceremony_runs set status = 'running', updated_at = ? where project_id = ? and id = ? and status = 'proposed'")
        .run(timestamp, projectId, existing.run_id);
      return mapCeremonyParticipant(
        database.prepare("select * from ceremony_participants where project_id = ? and id = ?").get(projectId, participantId),
      );
    },

    completeCeremonyParticipant(projectId, participantId, input = {}) {
      const existing = database
        .prepare("select * from ceremony_participants where project_id = ? and id = ?")
        .get(projectId, participantId);
      if (!existing || existing.status === "completed") {
        return existing ? mapCeremonyParticipant(existing) : null;
      }
      const timestamp = now();
      database
        .prepare(
          `update ceremony_participants
           set status = 'completed', outcome = ?, summary_md = ?, questions_md = ?,
               risk_md = ?, payload_json = ?, finished_at = ?, updated_at = ?
           where project_id = ? and id = ?`,
        )
        .run(
          optionalText(input.outcome, "completed"),
          optionalText(input.summaryMd, `${existing.role} completed ceremony participation.`),
          optionalText(input.questionsMd, ""),
          optionalText(input.riskMd, ""),
          JSON.stringify(input.payload || {}),
          timestamp,
          timestamp,
          projectId,
          participantId,
        );
      if (input.outcome === "blocked" && optionalText(input.questionsMd, input.summaryMd)) {
        const questionMd = optionalText(input.questionsMd, input.summaryMd);
        getStore().createAgentMessage(projectId, {
          actor: existing.role,
          source: "ceremony_participant",
          intent: "submit_ceremony_input",
          target: {
            runId: existing.run_id,
            participantId,
            role: existing.role,
          },
          summary: `${existing.role} ceremony question`,
          body: questionMd,
          metadata: {
            ceremonyHitlQuestion: true,
            participantId,
            role: existing.role,
            outcome: "blocked",
          },
        });
      }
      maybeSynthesizeCeremonyParticipants(database, projectId, existing.run_id, timestamp);
      return mapCeremonyParticipant(
        database.prepare("select * from ceremony_participants where project_id = ? and id = ?").get(projectId, participantId),
      );
    },

    applyCeremonyRun(projectId, runId, input = {}) {
      const run = database
        .prepare("select * from ceremony_runs where project_id = ? and id = ?")
        .get(projectId, runId);
      if (!run) {
        return null;
      }

      const requestedIds = new Set(input.proposalIds || []);
      const proposals = getCeremonyProposalRows(database, projectId, runId)
        .filter((proposal) => proposal.status === "pending")
        .filter((proposal) => requestedIds.size === 0 || requestedIds.has(proposal.id));
      const timestamp = now();
      const applied = [];

      for (const proposal of proposals) {
        const payload = parseJsonObject(proposal.payload_json, {});
        const appliedTicketId = applyCeremonyProposal(getStore(), projectId, proposal, payload);
        database
          .prepare(
            `update ceremony_proposals
             set status = 'applied', applied_ticket_id = ?, applied_at = ?, updated_at = ?
             where project_id = ? and id = ?`,
          )
          .run(appliedTicketId || null, timestamp, timestamp, projectId, proposal.id);
        applied.push(proposal);
      }

      const pendingCount = Number(
        database
          .prepare("select count(*) as count from ceremony_proposals where project_id = ? and run_id = ? and status = 'pending'")
          .get(projectId, runId).count,
      );
      database
        .prepare("update ceremony_runs set status = ?, applied_at = ?, updated_at = ? where project_id = ? and id = ?")
        .run(pendingCount === 0 ? "applied" : "partially_applied", timestamp, timestamp, projectId, runId);

      insertEvent(database, {
        projectId,
        type: "ceremony.applied",
        summary: `${prettyCeremonyType(run.type)} applied ${applied.length} proposal(s)`,
        detail: applied.map((proposal) => proposal.summary).join("\n"),
        reasonCode: run.type,
        reasonSource: "ceremony",
      });

      return commands.getCeremonyRun(projectId, runId);
    },


  };

  function mapCeremonyRun(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    type: row.type,
    status: row.status,
    scope: parseJsonObject(row.scope_json, {}),
    inputSnapshot: parseJsonObject(row.input_snapshot_json, {}),
    summaryMd: row.summary_md,
    questionsMd: row.questions_md,
    riskMd: row.risk_md,
    createdByKind: row.created_by_kind,
    createdByRef: row.created_by_ref,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    appliedAt: row.applied_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCeremonyProposal(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    runId: row.run_id,
    kind: row.kind,
    status: row.status,
    summary: row.summary,
    ticketId: row.ticket_id,
    ticketKey: row.ticket_key,
    ticketTitle: row.ticket_title,
    payload: parseJsonObject(row.payload_json, {}),
    appliedTicketId: row.applied_ticket_id,
    appliedAt: row.applied_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCeremonyParticipant(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    runId: row.run_id,
    role: row.role,
    status: row.status,
    outcome: row.outcome,
    summaryMd: row.summary_md,
    questionsMd: row.questions_md,
    riskMd: row.risk_md,
    payload: parseJsonObject(row.payload_json, {}),
    ceremonyType: row.ceremony_type || "",
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getCeremonyParticipantsByRunId(database, projectId, runIds) {
  const byRunId = new Map(runIds.map((runId) => [runId, []]));
  if (runIds.length === 0) {
    return byRunId;
  }
  const placeholders = runIds.map(() => "?").join(", ");
  const rows = database
    .prepare(
      `select *
       from ceremony_participants
       where project_id = ? and run_id in (${placeholders})
       order by created_at asc`,
    )
    .all(projectId, ...runIds);
  for (const row of rows) {
    byRunId.get(row.run_id)?.push(mapCeremonyParticipant(row));
  }
  return byRunId;
}

function maybeSynthesizeCeremonyParticipants(database, projectId, runId, timestamp) {
  const participants = database
    .prepare("select * from ceremony_participants where project_id = ? and run_id = ? order by created_at asc")
    .all(projectId, runId)
    .map(mapCeremonyParticipant);
  if (participants.length === 0 || participants.some((participant) => participant.status !== "completed")) {
    return;
  }

  const existingSynthesis = database
    .prepare(
      "select id from ceremony_proposals where project_id = ? and run_id = ? and kind = 'note' and summary like 'Agent consensus:%'",
    )
    .get(projectId, runId);
  if (existingSynthesis) {
    return;
  }

  const run = mapCeremonyRun(
    database.prepare("select * from ceremony_runs where project_id = ? and id = ?").get(projectId, runId),
  );
  const deciderRole = run.scope?.deciderRole || "operator";
  const participantSummary = participants
    .map((participant) => `${participant.role}: ${participant.summaryMd || participant.outcome || "completed"}`)
    .join("\n");
  const unresolvedQuestions = participants
    .map((participant) => participant.questionsMd)
    .filter(Boolean)
    .join("\n");
  const risks = participants
    .map((participant) => participant.riskMd)
    .filter(Boolean)
    .join("\n");
  const summary = `Agent consensus: ${deciderRole} synthesized ${participants.length} participant contribution(s).`;
  const agentProposals = buildParticipantRecommendationProposals(run, participants, timestamp);

  const insertProposal = database.prepare(
    `insert into ceremony_proposals (
      id, project_id, run_id, kind, status, summary, ticket_id,
      payload_json, applied_ticket_id, applied_at, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertProposal.run(
    `ceremony_proposal_${randomUUID()}`,
    projectId,
    runId,
    "note",
    "pending",
    summary,
    null,
    JSON.stringify({
      note: summary,
      deciderRole,
      participantSummary,
      unresolvedQuestions,
      risks,
    }),
    null,
    null,
    timestamp,
    timestamp,
  );
  for (const item of agentProposals) {
    insertProposal.run(
      item.id,
      projectId,
      runId,
      item.kind,
      "pending",
      item.summary,
      item.ticketId || null,
      JSON.stringify(item.payload || {}),
      null,
      null,
      timestamp,
      timestamp,
    );
  }

  database
    .prepare(
      `update ceremony_runs
       set status = 'proposed', summary_md = ?, questions_md = ?, risk_md = ?, finished_at = ?, updated_at = ?
       where project_id = ? and id = ?`,
    )
    .run(
      `${run.summaryMd}\n\n${summary}`,
      unresolvedQuestions || run.questionsMd,
      risks || run.riskMd,
      timestamp,
      timestamp,
      projectId,
      runId,
    );

  insertEvent(database, {
    projectId,
    type: "ceremony.proposed",
    summary,
    detail: agentProposals.length
      ? `${participantSummary}\n\nAgent refinement recommendations produced ${agentProposals.length} proposal(s).`
      : participantSummary,
    reasonCode: run.type,
    reasonSource: "ceremony",
  });
}

function buildParticipantRecommendationProposals(run, participants, timestamp) {
  if (run.type !== "refinement") {
    return [];
  }
  const tickets = Array.isArray(run.inputSnapshot?.tickets) ? run.inputSnapshot.tickets : [];
  const ticketsById = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  const cleanupActions = [];
  const proposals = [];
  const seenCleanup = new Set();
  for (const participant of participants) {
    for (const recommendation of refinementRecommendationsFromParticipant(participant)) {
      const type = String(recommendation.type || "").trim();
      if (type === "combine") {
        const keeper = ticketsById.get(String(recommendation.keeperTicketId || ""));
        const duplicate = ticketsById.get(String(recommendation.duplicateTicketId || ""));
        if (!keeper || !duplicate || keeper.id === duplicate.id) {
          continue;
        }
        const key = `combine:${keeper.id}:${duplicate.id}`;
        if (seenCleanup.has(key)) {
          continue;
        }
        seenCleanup.add(key);
        cleanupActions.push({
          type: "combine",
          keeperTicketId: keeper.id,
          keeperTicketKey: keeper.key,
          duplicateTicketId: duplicate.id,
          duplicateTicketKey: duplicate.key,
          reason: textOr(recommendation.reason, `${participant.role} recommended combining ${duplicate.key} into ${keeper.key}.`),
          keeperPatch: {
            brief: mergeBacklogText(keeper.brief, duplicate.brief, duplicate),
            latestSummary: `Refinement agent ${participant.role} recommended combining overlapping backlog item ${duplicate.key} into this ticket.`,
          },
          duplicateTransition: {
            targetState: "CANCELLED",
            reason: `Combined into ${keeper.key} by agent-assisted refinement.`,
            reasonCode: "ceremony_backlog_combined",
            reasonSource: "ceremony",
            mode: "automatic",
          },
          participantRole: participant.role,
        });
      } else if (type === "cancel") {
        const ticket = ticketsById.get(String(recommendation.ticketId || ""));
        if (!ticket) {
          continue;
        }
        const key = `cancel:${ticket.id}`;
        if (seenCleanup.has(key)) {
          continue;
        }
        seenCleanup.add(key);
        cleanupActions.push({
          ...cancelBacklogAction(ticket, textOr(recommendation.reason, `${participant.role} recommended removing this backlog item.`)),
          participantRole: participant.role,
        });
      } else if (type === "split") {
        const source = ticketsById.get(String(recommendation.sourceTicketId || recommendation.ticketId || ""));
        const childTickets = Array.isArray(recommendation.tickets) ? recommendation.tickets : [];
        for (const child of childTickets.slice(0, 6)) {
          const ticket = normalizeRecommendedTicket(child, source);
          if (!ticket) {
            continue;
          }
          proposals.push(proposal("ticket_create", `Split ${source?.key || "refinement item"} into ${ticket.title}`, timestamp, {
            ticket,
            sourceTicketId: source?.id || "",
            sourceTicketKey: source?.key || "",
            participantRole: participant.role,
            reason: textOr(recommendation.reason, `${participant.role} recommended splitting broad work into executable tickets.`),
          }, source?.id || ""));
        }
      } else if (type === "question") {
        const ticket = ticketsById.get(String(recommendation.ticketId || ""));
        const questionMd = textOr(recommendation.questionMd, "");
        if (!questionMd) {
          continue;
        }
        proposals.push(proposal("note", `Refinement question${ticket?.key ? ` for ${ticket.key}` : ""}`, timestamp, {
          note: questionMd,
          ticketId: ticket?.id || "",
          ticketKey: ticket?.key || "",
          participantRole: participant.role,
          reason: textOr(recommendation.reason, "Agent-assisted refinement needs more context before planning."),
          refinementQuestion: true,
        }, ticket?.id || ""));
      }
    }
  }
  if (cleanupActions.length > 0) {
    proposals.unshift(proposal("ticket_backlog_cleanup", `Agent-assisted cleanup for ${cleanupActions.length} backlog item(s)`, timestamp, {
      actions: cleanupActions,
      source: "participant_recommendations",
    }));
  }
  return proposals;
}

function refinementRecommendationsFromParticipant(participant) {
  const payload = participant.payload && typeof participant.payload === "object" ? participant.payload : {};
  const value = payload.refinementRecommendations || payload.recommendations || [];
  return Array.isArray(value)
    ? value.filter((item) => item && typeof item === "object" && !Array.isArray(item))
    : [];
}

function normalizeRecommendedTicket(input, source) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const title = textOr(input.title, "");
  const brief = textOr(input.brief, "");
  if (!title || !brief) {
    return null;
  }
  return {
    parentTicketId: source?.id || textOr(input.parentTicketId, ""),
    title,
    brief,
    acceptanceCriteriaMd: textOr(input.acceptanceCriteriaMd, ""),
    definitionOfDoneMd: textOr(input.definitionOfDoneMd, ""),
    priority: textOr(input.priority, source?.priority || "medium"),
    state: textOr(input.state, "PROPOSED"),
    assignedRole: textOr(input.assignedRole, "developer"),
    repoTargets: Array.isArray(input.repoTargets) ? input.repoTargets : source?.repoTargets || [],
    latestSummary: "Agent-assisted refinement split this from broader backlog work.",
  };
}

function textOr(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function getCeremonyProposalRows(database, projectId, runId) {
  return database
    .prepare(
      `select cp.*, t.key as ticket_key, t.title as ticket_title
       from ceremony_proposals cp
       left join tickets t on t.project_id = cp.project_id and t.id = cp.ticket_id
       where cp.project_id = ? and cp.run_id = ?
       order by cp.created_at asc`,
    )
    .all(projectId, runId);
}

function getCeremonyProposalsByRunId(database, projectId, runIds) {
  const byRunId = new Map(runIds.map((runId) => [runId, []]));
  if (runIds.length === 0) {
    return byRunId;
  }
  const placeholders = runIds.map(() => "?").join(", ");
  const rows = database
    .prepare(
      `select cp.*, t.key as ticket_key, t.title as ticket_title
       from ceremony_proposals cp
       left join tickets t on t.project_id = cp.project_id and t.id = cp.ticket_id
       where cp.project_id = ? and cp.run_id in (${placeholders})
       order by cp.created_at asc`,
    )
    .all(projectId, ...runIds);
  for (const row of rows) {
    byRunId.get(row.run_id)?.push(mapCeremonyProposal(row));
  }
  return byRunId;
}

function buildCeremonyInputSnapshot(database, projectId) {
  const tickets = listTicketRows(database, projectId).map(mapTicket);
  const ticketIds = tickets.map((ticket) => ticket.id);
  const repoTargetsByTicketId = getRepoTargetsByTicketId(database, ticketIds);
  const dependencyCountsByTicketId = getCountMap(
    database,
    "select blocked_ticket_id as ticketId, count(*) as count from ticket_dependencies where project_id = ? group by blocked_ticket_id",
    [projectId],
  );
  return {
    generatedAt: now(),
    policy: mapProjectPolicy(getProjectPolicyRow(database, projectId)),
    repos: database.prepare("select * from repos where project_id = ? order by created_at asc").all(projectId).map(mapRepo),
    tickets: tickets.map((ticket) => ({
      ...ticket,
      repoTargets: repoTargetsByTicketId.get(ticket.id) || [],
      dependencyCount: dependencyCountsByTicketId.get(ticket.id) || 0,
    })),
  };
}

function buildCeremonyProposals(type, snapshot, timestamp) {
  switch (type) {
    case "refinement":
      return buildRefinementProposals(snapshot, timestamp);
    case "planning":
      return buildPlanningProposals(snapshot, timestamp);
    case "daily_triage":
      return buildDailyTriageProposals(snapshot, timestamp);
    case "review_demo_prep":
      return buildReviewDemoPrepProposals(snapshot, timestamp);
    case "work_generation":
      return buildWorkGenerationProposals(snapshot, timestamp);
    case "retro":
      return buildRetroProposals(snapshot, timestamp);
    default:
      return [];
  }
}

function buildRefinementProposals(snapshot, timestamp) {
  const candidates = snapshot.tickets
    .filter((ticket) => ticket.state === "DRAFT" || ticket.state === "PROPOSED")
    .slice(0, 6);
  const cleanup = buildBacklogCleanupProposal(candidates, timestamp);
  const patches = candidates.map((ticket) => {
    const patch = {
      latestSummary: "Refinement pass proposed clearer scope and readiness criteria.",
    };
    if (!ticket.brief || ticket.brief.length < 40) {
      patch.brief = `${ticket.brief || ticket.title}\n\nRefinement note: clarify the user outcome, repo touch points, and expected evidence before execution.`;
    }
    if (!ticket.acceptanceCriteriaMd) {
      patch.acceptanceCriteriaMd = "- Scope is explicit enough for an agent to execute\n- Expected behavior and evidence are named\n- Blocking decisions are captured before work starts";
    }
    if (!ticket.definitionOfDoneMd) {
      patch.definitionOfDoneMd = "- Acceptance criteria satisfied\n- Review and validation evidence attached\n- Follow-up work captured as separate tickets";
    }
    return {
      ticketId: ticket.id,
      ticketKey: ticket.key,
      ticketTitle: ticket.title,
      patch,
    };
  });
  if (patches.length === 0) {
    return [noteProposal("Backlog refinement found no draft or proposed tickets needing action.", timestamp)];
  }
  const proposals = [
    proposal("ticket_batch_patch", `Refine ${patches.length} ticket(s) before agent execution`, timestamp, {
      patches,
    }),
  ];
  if (cleanup) {
    proposals.push(cleanup);
  }
  return proposals;
}

function buildBacklogCleanupProposal(candidates, timestamp) {
  const actions = [];
  const consumed = new Set();
  for (let index = 0; index < candidates.length; index += 1) {
    const ticket = candidates[index];
    if (consumed.has(ticket.id)) {
      continue;
    }
    if (isClearlyUnnecessaryBacklogTicket(ticket)) {
      actions.push(cancelBacklogAction(ticket, "Refinement marked this backlog item unnecessary or out of scope."));
      consumed.add(ticket.id);
      continue;
    }
    for (let otherIndex = index + 1; otherIndex < candidates.length; otherIndex += 1) {
      const other = candidates[otherIndex];
      if (consumed.has(other.id) || !ticketsAppearSimilar(ticket, other)) {
        continue;
      }
      const keeper = chooseBacklogKeeper(ticket, other);
      const duplicate = keeper.id === ticket.id ? other : ticket;
      actions.push({
        type: "combine",
        keeperTicketId: keeper.id,
        keeperTicketKey: keeper.key,
        duplicateTicketId: duplicate.id,
        duplicateTicketKey: duplicate.key,
        reason: `${duplicate.key} appears to overlap ${keeper.key}; refinement should keep one clearer backlog item.`,
        keeperPatch: {
          brief: mergeBacklogText(keeper.brief, duplicate.brief, duplicate),
          latestSummary: `Refinement combined overlapping backlog item ${duplicate.key} into this ticket.`,
        },
        duplicateTransition: {
          targetState: "CANCELLED",
          reason: `Combined into ${keeper.key} during backlog refinement.`,
          reasonCode: "ceremony_backlog_combined",
          reasonSource: "ceremony",
          mode: "automatic",
        },
      });
      consumed.add(duplicate.id);
      if (duplicate.id === ticket.id) {
        break;
      }
    }
  }
  if (actions.length === 0) {
    return null;
  }
  return proposal("ticket_backlog_cleanup", `Clean up ${actions.length} similar or unnecessary backlog item(s)`, timestamp, {
    actions,
  });
}

function cancelBacklogAction(ticket, reason) {
  return {
    type: "cancel",
    ticketId: ticket.id,
    ticketKey: ticket.key,
    reason,
    transition: {
      targetState: "CANCELLED",
      reason,
      reasonCode: "ceremony_backlog_removed",
      reasonSource: "ceremony",
      mode: "automatic",
    },
  };
}

function isClearlyUnnecessaryBacklogTicket(ticket) {
  const text = `${ticket.title || ""}\n${ticket.brief || ""}\n${ticket.latestSummary || ""}`.toLowerCase();
  return /\b(duplicate|unnecessary|not needed|obsolete|out of scope|wontfix|won't fix)\b/.test(text);
}

function ticketsAppearSimilar(left, right) {
  if (left.parentTicketId && right.parentTicketId && left.parentTicketId !== right.parentTicketId) {
    return false;
  }
  const leftTitle = normalizeBacklogText(left.title);
  const rightTitle = normalizeBacklogText(right.title);
  if (!leftTitle || !rightTitle) {
    return false;
  }
  if (leftTitle.includes(rightTitle) || rightTitle.includes(leftTitle)) {
    return true;
  }
  const leftTokens = tokenSet(leftTitle);
  const rightTokens = tokenSet(rightTitle);
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size || 1;
  return intersection / union >= 0.55;
}

function chooseBacklogKeeper(left, right) {
  const leftScore = backlogCompletenessScore(left);
  const rightScore = backlogCompletenessScore(right);
  if (rightScore > leftScore) {
    return right;
  }
  return left;
}

function backlogCompletenessScore(ticket) {
  return [
    ticket.acceptanceCriteriaMd,
    ticket.definitionOfDoneMd,
    ticket.brief && ticket.brief.length >= 80,
    (ticket.repoTargets || []).length > 0,
  ].filter(Boolean).length;
}

function mergeBacklogText(keeperBrief = "", duplicateBrief = "", duplicate) {
  const duplicateText = String(duplicateBrief || "").trim();
  if (!duplicateText || String(keeperBrief || "").includes(duplicateText)) {
    return keeperBrief || duplicateText || duplicate.title;
  }
  return `${keeperBrief || duplicate.title}\n\nMerged during refinement from ${duplicate.key}: ${duplicateText}`;
}

function normalizeBacklogText(value = "") {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(add|build|create|implement|support|make|the|a|an|for|to|and|with|ticket|task)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSet(value) {
  return new Set(value.split(/\s+/).filter((token) => token.length >= 3));
}

function buildWorkGenerationProposals(snapshot, timestamp) {
  const childCounts = new Map();
  for (const ticket of snapshot.tickets) {
    if (ticket.parentTicketId) {
      childCounts.set(ticket.parentTicketId, (childCounts.get(ticket.parentTicketId) || 0) + 1);
    }
  }
  const candidates = snapshot.tickets
    .filter((ticket) => ["DRAFT", "PROPOSED", "READY"].includes(ticket.state))
    .filter((ticket) => !ticket.parentTicketId && !childCounts.get(ticket.id) && !hasProductBreakdownTitle(ticket.title))
    .slice(0, 4);
  const proposals = [];
  for (const ticket of candidates) {
    proposals.push(proposal("ticket_create", `Create product breakdown child for ${ticket.key}`, timestamp, {
      ticket: {
        parentTicketId: ticket.id,
        title: `Break down ${ticket.key}: ${ticket.title}`,
        brief: `Turn the product idea into an executable plan.\n\nParent idea: ${ticket.title}\n\n${ticket.brief || ""}`.trim(),
        acceptanceCriteriaMd:
          "- Product boundaries and non-goals are captured\n- Child feature tickets are created with acceptance criteria and repo targets\n- Validation and demo evidence expectations are named for each feature\n- Open product questions are asked as HITL comments instead of guessed",
        definitionOfDoneMd:
          "- Feature tickets exist and are ready for planning\n- Architecture, implementation, review, validation, demo, and merge expectations are explicit\n- The parent idea can be tracked from plan through demo evidence",
        priority: ticket.priority || "high",
        state: "READY",
        assignedRole: "product_manager",
        repoTargets: ticket.repoTargets || [],
        latestSummary: "Refinement created a product breakdown lane for autonomous planning.",
      },
    }, ticket.id));
  }
  return proposals.length ? proposals : [noteProposal("Work generation found no broad parent tickets needing new child work.", timestamp)];
}

function hasProductBreakdownTitle(title = "") {
  return /\bbreak\s+down\b|\bfeature\s+breakdown\b|\bproduct\s+plan\b/i.test(String(title));
}

function buildPlanningProposals(snapshot, timestamp) {
  const capacity = Number(snapshot.policy?.maxParallelExecutions || 1);
  const ready = snapshot.tickets.filter((ticket) => ticket.state === "READY");
  const proposedReady = snapshot.tickets
    .filter((ticket) => ticket.state === "PROPOSED" && ticket.acceptanceCriteriaMd && ticket.repoTargets.length > 0)
    .slice(0, Math.max(1, capacity));
  const proposals = proposedReady.map((ticket) =>
    proposal("ticket_transition", `Promote ${ticket.key} into the next agent-ready plan`, timestamp, {
      ticketId: ticket.id,
      targetState: "READY",
      reason: "Planning ceremony approved this refined ticket for agent execution.",
    }, ticket.id),
  );
  proposals.push(noteProposal(`Planning snapshot: ${ready.length} ticket(s) already Ready; execution capacity is ${capacity}.`, timestamp));
  return proposals;
}

function buildDailyTriageProposals(snapshot, timestamp) {
  const active = snapshot.tickets.filter((ticket) => ["WORKING", "REVIEWING", "VALIDATING"].includes(ticket.state));
  const blocked = snapshot.tickets.filter((ticket) => ticket.state === "BLOCKED" || ticket.state === "REWORK");
  const proposals = blocked.slice(0, 5).map((ticket) =>
    proposal("ticket_patch", `Triage ${ticket.key} for PO decision or unblock path`, timestamp, {
      ticketId: ticket.id,
      patch: {
        latestSummary: "Daily triage flagged this ticket for an unblock decision.",
      },
    }, ticket.id),
  );
  proposals.push(noteProposal(`Daily triage: ${active.length} active ticket(s), ${blocked.length} blocked or rework ticket(s).`, timestamp));
  return proposals;
}

function buildReviewDemoPrepProposals(snapshot, timestamp) {
  const demoTickets = snapshot.tickets
    .filter((ticket) => ticket.state === "READY_TO_MERGE" || ticket.state === "DONE")
    .slice(-6);
  if (demoTickets.length === 0) {
    return [noteProposal("Review/demo prep found no done or merge-ready tickets.", timestamp)];
  }
  return [
    noteProposal(
      `Demo prep candidate set: ${demoTickets.map((ticket) => `${ticket.key} ${ticket.title}`).join("; ")}.`,
      timestamp,
    ),
  ];
}

function buildRetroProposals(snapshot, timestamp) {
  const reworkCount = snapshot.tickets.filter((ticket) => ticket.state === "REWORK").length;
  const blockedCount = snapshot.tickets.filter((ticket) => ticket.state === "BLOCKED").length;
  if (reworkCount + blockedCount === 0) {
    return [noteProposal("Retro found no blocked or rework tickets in the current board snapshot.", timestamp)];
  }
  return [
    proposal("ticket_create", "Create a process-improvement follow-up from retro findings", timestamp, {
      ticket: {
        title: "Reduce blocked and rework loops",
        brief: `Retro observed ${blockedCount} blocked ticket(s) and ${reworkCount} rework ticket(s). Identify one policy, prompt, or validation improvement that would reduce repeat stalls.`,
        acceptanceCriteriaMd: "- Root cause is named\n- One concrete system or process change is proposed\n- Success signal is measurable from Floop events",
        definitionOfDoneMd: "- Improvement is implemented or documented\n- Floop evidence shows the change is inspectable",
        priority: blockedCount > 0 ? "high" : "medium",
        state: "PROPOSED",
        assignedRole: "product_manager",
        repoTargets: [],
      },
    }),
  ];
}

function buildCeremonyScope(type, input = {}) {
  const defaults = defaultCeremonyFanOut(type);
  const participantRoles = normalizeRoleList(input.participantRoles, defaults.participantRoles);
  const deciderRole =
    typeof input.deciderRole === "string" && input.deciderRole.trim()
      ? input.deciderRole.trim()
      : defaults.deciderRole;
  const consensusPolicy =
    typeof input.consensusPolicy === "string" && input.consensusPolicy.trim()
      ? input.consensusPolicy.trim()
      : defaults.consensusPolicy;

  return {
    ...(input.scope || {}),
    participantRoles,
    deciderRole,
    consensusPolicy,
  };
}

function defaultCeremonyFanOut(type) {
  switch (type) {
    case "planning":
      return {
        participantRoles: ["product_manager", "architect", "developer", "integrator"],
        deciderRole: "integrator",
        consensusPolicy: "decider_synthesizes_objections",
      };
    case "daily_triage":
      return {
        participantRoles: ["product_manager", "developer", "reviewer", "validator"],
        deciderRole: "product_manager",
        consensusPolicy: "blockers_and_stale_work_win",
      };
    case "review_demo_prep":
      return {
        participantRoles: ["product_manager", "reviewer", "validator", "integrator"],
        deciderRole: "reviewer",
        consensusPolicy: "only_evidence_backed_done_work_is_demoable",
      };
    case "work_generation":
      return {
        participantRoles: ["product_manager", "architect", "developer", "reviewer"],
        deciderRole: "product_manager",
        consensusPolicy: "decider_synthesizes_objections",
      };
    case "retro":
      return {
        participantRoles: ["product_manager", "architect", "developer", "reviewer", "validator"],
        deciderRole: "product_manager",
        consensusPolicy: "recurring_systemic_risk_wins",
      };
    case "refinement":
    default:
      return {
        participantRoles: ["product_manager", "architect", "developer", "reviewer"],
        deciderRole: "product_manager",
        consensusPolicy: "decider_synthesizes_objections",
      };
  }
}

function normalizeRoleList(value, fallback) {
  const source = Array.isArray(value) && value.length > 0 ? value : fallback;
  const roles = [];
  for (const role of source) {
    if (typeof role === "string" && role.trim() && !roles.includes(role.trim())) {
      roles.push(role.trim());
    }
  }
  return roles;
}

function buildCeremonySummary(type, snapshot, proposals, scope = {}) {
  const pendingMutations = proposals.filter((item) => item.kind !== "note").length;
  const participantText =
    Array.isArray(scope.participantRoles) && scope.participantRoles.length > 0
      ? scope.participantRoles.join(", ")
      : "none";
  const deciderText = scope.deciderRole || "operator";
  const consensusText = scope.consensusPolicy || "decider_synthesizes_objections";
  return {
    summaryMd: `${prettyCeremonyType(type)} reviewed ${snapshot.tickets.length} ticket(s) with ${participantText}. ${deciderText} is the decider and consensus policy is ${consensusText}. The run produced ${proposals.length} proposal(s), including ${pendingMutations} ticket change(s).`,
    questionsMd:
      pendingMutations > 0
        ? "Approve the proposals that match your current PO intent; leave the rest pending. Agent objections should remain visible when the decider synthesizes consensus."
        : "No ticket mutation is proposed. Use comments or direct chat follow-up to resolve open questions before asking implementation agents to work.",
    riskMd:
      "Fan-out participants advise the ceremony. The decider synthesizes consensus, but proposals do not mutate tickets until applied by an operator.",
  };
}

function proposal(kind, summary, timestamp, payload, ticketId = "") {
  return {
    id: `ceremony_proposal_${randomUUID()}`,
    kind,
    summary,
    ticketId,
    payload,
    createdAt: timestamp,
  };
}

function noteProposal(summary, timestamp) {
  return proposal("note", summary, timestamp, { note: summary });
}

function applyCeremonyProposal(store, projectId, proposalRow, payload) {
  switch (proposalRow.kind) {
    case "ticket_patch":
      store.updateTicket(projectId, requiredText(payload.ticketId, "ticketId"), payload.patch || {});
      return payload.ticketId;
    case "ticket_batch_patch": {
      let lastTicketId = "";
      for (const item of Array.isArray(payload.patches) ? payload.patches : []) {
        const ticketId = requiredText(item.ticketId, "ticketId");
        store.updateTicket(projectId, ticketId, item.patch || {});
        lastTicketId = ticketId;
      }
      return lastTicketId;
    }
    case "ticket_backlog_cleanup": {
      let lastTicketId = "";
      for (const action of Array.isArray(payload.actions) ? payload.actions : []) {
        if (action.type === "combine") {
          const keeperTicketId = requiredText(action.keeperTicketId, "keeperTicketId");
          const duplicateTicketId = requiredText(action.duplicateTicketId, "duplicateTicketId");
          store.updateTicket(projectId, keeperTicketId, action.keeperPatch || {});
          store.transitionTicket(projectId, duplicateTicketId, action.duplicateTransition || {});
          lastTicketId = duplicateTicketId;
        } else if (action.type === "cancel") {
          const ticketId = requiredText(action.ticketId, "ticketId");
          store.transitionTicket(projectId, ticketId, action.transition || {});
          lastTicketId = ticketId;
        }
      }
      return lastTicketId;
    }
    case "ticket_create":
      return store.createTicket(projectId, payload.ticket || {})?.id || "";
    case "ticket_transition":
      store.transitionTicket(projectId, requiredText(payload.ticketId, "ticketId"), {
        targetState: payload.targetState,
        reason: payload.reason || proposalRow.summary,
        reasonCode: payload.reasonCode || "ceremony_transition",
        reasonSource: "ceremony",
        mode: "automatic",
      });
      return payload.ticketId;
    case "dependency":
      store.addDependency(projectId, requiredText(payload.blockedTicketId, "blockedTicketId"), {
        blockingTicketId: payload.blockingTicketId,
        dependencyType: payload.dependencyType,
      });
      return payload.blockedTicketId;
    case "note":
      return "";
    default:
      throw new Error(`Unsupported ceremony proposal kind: ${proposalRow.kind}`);
  }
}

function prettyCeremonyType(type) {
  return String(type || "").replace(/_/g, " ");
}

function parseJsonObject(value, fallback) {
  try {
    const parsed = JSON.parse(value || "");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

  return commands;
}
