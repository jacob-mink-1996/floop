import { randomUUID } from "node:crypto";
import { mergeQueueItemDto, mergeRunDto } from "../../contracts/src/index.mjs";
import { compactTicketSummary } from "./ticket-summary.mjs";

export function createMergeCommands({
  database,
  addMs,
  assertProjectCanStartMerge,
  buildMergeStatus,
  deriveMergeEventReason,
  deriveTicketStateForMergeStatus,
  describeMergePolicyBlock,
  getArtifactsByMergeRunId,
  getArtifactsByValidationRunId,
  getLatestMergeRunRow,
  getLatestReviewRow,
  getLatestValidationRunRow,
  getProjectRow,
  getTicketRow,
  getWorktreesByTicketId,
  insertArtifacts,
  insertEvent,
  isExpiredIso,
  listTicketRows,
  mapMergeRun,
  mapTicket,
  now,
  optionalText,
  readPolicyBoolean,
  requiredProjectPolicy,
  requiredText,
  withTransaction,
  assertAutomaticTicketTransition,
}) {
  const commands = {
    listMergeQueue(projectId) {
      if (!getProjectRow(database, projectId)) {
        return null;
      }

      const tickets = listTicketRows(database, projectId, {
        states: ["READY_TO_MERGE"],
      }).map(mapTicket);
      const worktreesByTicketId = getWorktreesByTicketId(database, projectId, tickets.map((ticket) => ticket.id));

      return tickets.map((ticket) =>
        mergeQueueItemDto(ticket, buildMergeStatus(database, ticket, worktreesByTicketId.get(ticket.id) || [])),
      );
    },

    getMergeStatus(projectId, ticketId) {
      const ticket = getTicketRow(database, projectId, ticketId);
      if (!ticket) {
        return null;
      }

      const worktrees = getWorktreesByTicketId(database, projectId, [ticketId]).get(ticketId) || [];
      return buildMergeStatus(database, mapTicket(ticket), worktrees);
    },

    listActiveMergeRuns(projectId = "") {
      const rows = projectId
        ? database
            .prepare(
              `select project_id, id
               from merge_runs
               where project_id = ? and status = 'running' and finished_at is null
               order by started_at asc`,
            )
            .all(projectId)
        : database
            .prepare(
              `select project_id, id
               from merge_runs
               where status = 'running' and finished_at is null
               order by started_at asc`,
            )
            .all();

      return rows.map((row) => commands.getMergeRun(row.project_id, row.id)).filter(Boolean);
    },

    listMergeRuns(projectId, options = {}) {
      if (!getProjectRow(database, projectId)) {
        return null;
      }
      const limit = boundedLimit(options.limit, 20, 100);
      return database
        .prepare(
          `select project_id, id
           from merge_runs
           where project_id = ?
           order by coalesce(nullif(finished_at, ''), started_at) desc, started_at desc
           limit ?`,
        )
        .all(projectId, limit)
        .map((row) => commands.getMergeRun(row.project_id, row.id))
        .filter(Boolean);
    },

    getMergeRun(projectId, mergeRunId) {
      const row = database.prepare("select * from merge_runs where project_id = ? and id = ?").get(projectId, mergeRunId);
      if (!row) {
        return null;
      }
      const artifacts = getArtifactsByMergeRunId(database, [mergeRunId]).get(mergeRunId) || [];
      return mergeRunDto({ ...mapMergeRun(row), artifacts });
    },

    startMergeRun(projectId, ticketId, input = {}) {
      const ticket = getTicketRow(database, projectId, ticketId);
      if (!ticket) {
        return null;
      }
      if (ticket.state !== "READY_TO_MERGE") {
        throw new Error(`Ticket ${ticket.key} is not ready for merge`);
      }

      const policy = requiredProjectPolicy(database, projectId);
      const latestReview = getLatestReviewRow(database, projectId, ticketId);
      const latestValidation = withValidationArtifacts(
        getLatestValidationRunRow(database, projectId, ticketId),
      );
      const requiresHumanApproval =
        policy.interaction_mode === "fully_autonomous"
          ? false
          : readPolicyBoolean(
              policy,
              "requireHumanApprovalBeforeMerge",
              "require_human_approval_before_merge",
            );
      const mergePolicyBlock = describeMergePolicyBlock(policy, latestReview, latestValidation);
      const approvedByKind = optionalText(input.approvedByKind);
      const approvedByRef = optionalText(input.approvedByRef);

      if (mergePolicyBlock) {
        throw new Error(mergePolicyBlock);
      }
      if (input.requireApproval !== false && requiresHumanApproval && (!approvedByKind || !approvedByRef)) {
        throw new Error(`Ticket ${ticket.key} requires human approval before merge`);
      }

      const timestamp = optionalText(input.startedAt, now());
      const claimToken = requiredText(input.claimToken, "claimToken");
      const leaseMs = Number.isInteger(input.leaseMs) && input.leaseMs > 0 ? input.leaseMs : 30_000;
      const mergeRun = {
        id: `merge_${randomUUID()}`,
        projectId,
        ticketId,
        status: "running",
        strategy: requiredText(input.strategy, "strategy"),
        approvedByKind,
        approvedByRef,
        summaryMd: optionalText(input.summaryMd, `${ticket.key} merge running`),
        failureKind: "",
        claimToken,
        claimExpiresAt: addMs(timestamp, leaseMs),
        startedAt: timestamp,
        finishedAt: null,
      };
      const approvalDetail =
        approvedByKind && approvedByRef
          ? `Approved by ${approvedByKind}:${approvedByRef}`
          : requiresHumanApproval
            ? "No approval recorded"
            : "Approval bypassed by policy";
      assertProjectCanStartMerge(database, projectId, ticket.key);

      const started = withTransaction(database, () => {
        const latestRun = getLatestMergeRunRow(database, projectId, ticketId);
        if (latestRun?.status === "running" && !latestRun.finished_at && !isExpiredIso(latestRun.claim_expires_at, timestamp)) {
          return false;
        }
        if (latestRun?.status === "running" && !latestRun.finished_at && isExpiredIso(latestRun.claim_expires_at, timestamp)) {
          database
            .prepare(
              `update merge_runs
               set status = 'blocked', failure_kind = 'interrupted', summary_md = ?, claim_token = '', claim_expires_at = null, finished_at = ?, started_at = started_at
               where project_id = ? and id = ?`,
            )
            .run(
              "Floop recovered after restart before this merge lane reported a final result.",
              timestamp,
              projectId,
              latestRun.id,
            );
        }

        database
          .prepare(
            `insert into merge_runs (
              id, project_id, ticket_id, status, strategy, approved_by_kind,
              approved_by_ref, summary_md, failure_kind, claim_token, claim_expires_at, started_at, finished_at
            ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            mergeRun.id,
            mergeRun.projectId,
            mergeRun.ticketId,
            mergeRun.status,
            mergeRun.strategy,
            mergeRun.approvedByKind,
            mergeRun.approvedByRef,
            mergeRun.summaryMd,
            mergeRun.failureKind,
            mergeRun.claimToken,
            mergeRun.claimExpiresAt,
            mergeRun.startedAt,
            mergeRun.finishedAt,
          );

        database
          .prepare("update tickets set latest_summary = ?, updated_at = ? where project_id = ? and id = ?")
          .run(mergeRun.summaryMd, timestamp, projectId, ticketId);

        insertEvent(database, {
          projectId,
          ticketId,
          type: "merge.started",
          summary: `${ticket.key} merge started`,
          detail: `${mergeRun.strategy} · ${approvalDetail}`,
          reasonCode: approvedByKind && approvedByRef ? "merge_approved" : "",
          reasonSource: approvedByKind && approvedByRef ? "approval" : "",
        });
        return true;
      });

      return started ? commands.getMergeRun(projectId, mergeRun.id) : null;
    },

    completeMergeRun(projectId, mergeRunId, input = {}) {
      const mergeRun = database.prepare("select * from merge_runs where project_id = ? and id = ?").get(projectId, mergeRunId);
      if (!mergeRun) {
        return null;
      }
      if (mergeRun.finished_at) {
        return commands.getMergeRun(projectId, mergeRunId);
      }

      const ticket = getTicketRow(database, projectId, mergeRun.ticket_id);
      const timestamp = optionalText(input.finishedAt, now());
      const status = optionalText(input.status, "completed");
      const summaryMd = optionalText(input.summaryMd);
      const failureKind = optionalText(input.failureKind);
      const artifacts = input.artifacts || [];
      const ticketSummary =
        compactTicketSummary(
          summaryMd,
          `${ticket.key} merge ${status === "completed" ? "completed" : status === "blocked" ? "blocked" : "needs rework"}`,
        );
      const nextState = deriveTicketStateForMergeStatus(status);
      const transitionReason = deriveMergeEventReason(status, failureKind);
      assertAutomaticTicketTransition({
        fromState: ticket.state,
        toState: nextState,
        reasonCode: transitionReason.reasonCode || "merge_completed",
      });
      const approvalDetail =
        mergeRun.approved_by_kind && mergeRun.approved_by_ref
          ? `Approved by ${mergeRun.approved_by_kind}:${mergeRun.approved_by_ref}`
          : "No approval recorded";

      withTransaction(database, () => {
        database
          .prepare(
            `update merge_runs
             set status = ?, summary_md = ?, failure_kind = ?, claim_token = '', claim_expires_at = null, finished_at = ?
             where project_id = ? and id = ?`,
          )
          .run(status, summaryMd, failureKind, timestamp, projectId, mergeRunId);

        insertArtifacts(
          database,
          projectId,
          mergeRun.ticket_id,
          {
            mergeRunId,
          },
          artifacts,
          timestamp,
        );

        database
          .prepare("update tickets set state = ?, latest_summary = ?, updated_at = ? where project_id = ? and id = ?")
          .run(nextState, ticketSummary, timestamp, projectId, mergeRun.ticket_id);

        insertEvent(database, {
          projectId,
          ticketId: mergeRun.ticket_id,
          type: "merge.completed",
          summary: `${ticket.key} merge ${status}`,
          detail: summaryMd || `${mergeRun.strategy} · ${approvalDetail}`,
          ...transitionReason,
        });
      });

      return commands.getMergeRun(projectId, mergeRunId);
    },

    reconcileActiveMergeRuns(input = {}) {
      const summaryMd = optionalText(
        input.summaryMd,
        "Floop recovered after restart before this merge lane reported a final result.",
      );
      return commands.listActiveMergeRuns()
        .map((mergeRun) =>
          commands.completeMergeRun(mergeRun.projectId, mergeRun.id, {
            status: "blocked",
            summaryMd,
            failureKind: "interrupted",
          }),
        )
        .filter(Boolean);
    },

    mergeTicket(projectId, ticketId, input) {
      const ticket = getTicketRow(database, projectId, ticketId);
      if (!ticket) {
        return null;
      }
      if (ticket.state !== "READY_TO_MERGE") {
        throw new Error(`Ticket ${ticket.key} is not ready for merge`);
      }

      const policy = requiredProjectPolicy(database, projectId);
      const status = optionalText(input.status, "completed");
      const latestReview = getLatestReviewRow(database, projectId, ticketId);
      const latestValidation = withValidationArtifacts(
        getLatestValidationRunRow(database, projectId, ticketId),
      );
      const requiresHumanApproval =
        policy.interaction_mode === "fully_autonomous"
          ? false
          : readPolicyBoolean(
              policy,
              "requireHumanApprovalBeforeMerge",
              "require_human_approval_before_merge",
            );
      const mergePolicyBlock = describeMergePolicyBlock(policy, latestReview, latestValidation);
      const approvedByKind = optionalText(input.approvedByKind);
      const approvedByRef = optionalText(input.approvedByRef);

      if (mergePolicyBlock) {
        throw new Error(mergePolicyBlock);
      }
      if (status === "completed" && requiresHumanApproval && (!approvedByKind || !approvedByRef)) {
        throw new Error(`Ticket ${ticket.key} requires human approval before merge`);
      }

      const timestamp = now();
      const summaryMd = optionalText(input.summaryMd);
      const ticketSummary =
        compactTicketSummary(
          summaryMd,
          `${ticket.key} merge ${status === "completed" ? "completed" : status === "blocked" ? "blocked" : "needs rework"}`,
        );
      const mergeRun = {
        id: `merge_${randomUUID()}`,
        projectId,
        ticketId,
        status,
        strategy: requiredText(input.strategy, "strategy"),
        approvedByKind,
        approvedByRef,
        summaryMd,
        startedAt: timestamp,
        finishedAt: timestamp,
      };
      const artifacts = input.artifacts || [];

      const started = commands.startMergeRun(projectId, ticketId, {
        strategy: mergeRun.strategy,
        approvedByKind,
        approvedByRef,
        summaryMd: `${ticket.key} merge started`,
        claimToken: `manual-${mergeRun.id}`,
        startedAt: timestamp,
        requireApproval: status === "completed",
      });
      commands.completeMergeRun(projectId, started.id, {
        status,
        summaryMd: ticketSummary,
        failureKind: status === "blocked" ? "merge_blocked" : "",
        artifacts,
        finishedAt: timestamp,
      });
      return commands.getMergeStatus(projectId, ticketId);
    },

    renewMergeRunClaim(projectId, mergeRunId, input = {}) {
      const claimToken = requiredText(input.claimToken, "claimToken");
      const renewedAt = optionalText(input.renewedAt, now());
      const leaseMs = Number.isInteger(input.leaseMs) && input.leaseMs > 0 ? input.leaseMs : 30_000;
      const leaseExpiresAt = addMs(renewedAt, leaseMs);
      const result = database
        .prepare(
          `update merge_runs
           set claim_expires_at = ?
           where project_id = ? and id = ? and claim_token = ? and finished_at is null`,
        )
        .run(leaseExpiresAt, projectId, mergeRunId, claimToken);
      return result.changes > 0 ? commands.getMergeRun(projectId, mergeRunId) : null;
    },
  };

  return commands;

  function withValidationArtifacts(validation) {
    if (!validation) {
      return null;
    }
    return {
      ...validation,
      artifacts: getArtifactsByValidationRunId(database, [validation.id]).get(validation.id) || [],
    };
  }
}

function boundedLimit(value, defaultLimit, maxLimit) {
  return Number.isInteger(value) && value > 0 ? Math.min(value, maxLimit) : defaultLimit;
}
