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

  database
    .prepare(
      `insert into ceremony_proposals (
        id, project_id, run_id, kind, status, summary, ticket_id,
        payload_json, applied_ticket_id, applied_at, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
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
    detail: participantSummary,
    reasonCode: run.type,
    reasonSource: "ceremony",
  });
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
  const childCounts = new Map();
  for (const ticket of snapshot.tickets) {
    if (ticket.parentTicketId) {
      childCounts.set(ticket.parentTicketId, (childCounts.get(ticket.parentTicketId) || 0) + 1);
    }
  }
  const proposals = candidates.map((ticket) => {
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
    return proposal("ticket_patch", `Refine ${ticket.key} before agent execution`, timestamp, {
      ticketId: ticket.id,
      patch,
    }, ticket.id);
  });
  for (const ticket of candidates) {
    if (ticket.parentTicketId || childCounts.get(ticket.id) || hasProductBreakdownTitle(ticket.title)) {
      continue;
    }
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
  return proposals.length ? proposals : [noteProposal("Backlog refinement found no draft or proposed tickets needing action.", timestamp)];
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
