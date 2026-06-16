import { randomUUID } from "node:crypto";
import { executionDto, worktreeDto } from "../../contracts/src/index.mjs";
import { compactTicketSummary } from "./ticket-summary.mjs";

export function createExecutionCommands({
  database,
  assertProjectCanStartExecution,
  deriveAgentCreatedTicketState,
  deriveExecutionEventReason,
  deriveTicketStateForExecutionOutcome,
  deriveTicketStateForExecutionStart,
  deriveWorktreeStatusForOutcome,
  getExecutionRow,
  getStore,
  getTicketRow,
  getWorktreeRow,
  insertArtifacts,
  insertEvent,
  planExecutionWorktrees,
  requiredProjectPolicy,
  resolveAgentProfileForExecution,
  startAutoRoutedLaneExecution,
  withTransaction,
  now,
  requiredText,
  optionalText,
  addMs,
  isExpiredIso,
  mapExecution,
  mapWorktree,
  getArtifactsByExecutionId,
  getWorktreesByExecutionId,
  listWorktreeRows,
  assertAutomaticTicketTransition,
}) {
  const commands = {
    listExecutions(projectId, ticketId) {
      if (!getTicketRow(database, projectId, ticketId)) {
        return null;
      }

      return database
        .prepare(
          `select * from executions
           where project_id = ? and ticket_id = ?
           order by started_at desc, iteration desc`,
        )
        .all(projectId, ticketId)
        .map((row) => commands.getExecution(projectId, row.id));
    },

    listProjectExecutions(projectId, options = {}) {
      const limit = boundedLimit(options.limit, 20, 100);
      return database
        .prepare(
          `select project_id, id
           from executions
           where project_id = ?
           order by coalesce(nullif(finished_at, ''), started_at) desc, started_at desc, iteration desc
           limit ?`,
        )
        .all(projectId, limit)
        .map((row) => commands.getExecution(row.project_id, row.id))
        .filter(Boolean);
    },

    getExecution(projectId, executionId) {
      const execution = getExecutionRow(database, projectId, executionId);
      if (!execution) {
        return null;
      }

      const ticket = getTicketRow(database, projectId, execution.ticket_id);
      const worktrees = getWorktreesByExecutionId(database, projectId, [execution.id]).get(execution.id) || [];
      const artifacts = getArtifactsByExecutionId(database, projectId, [execution.id]).get(execution.id) || [];
      return executionDto({
        ...mapExecution(execution),
        ticketKey: ticket?.key || "",
        ticketTitle: ticket?.title || "",
        ticketState: ticket?.state || "",
        artifacts,
        worktrees,
      });
    },

    listActiveExecutions() {
      return database
        .prepare(
          `select project_id, id
           from executions
           where finished_at is null and status = 'running'
           order by started_at asc`,
        )
        .all()
        .map((row) => commands.getExecution(row.project_id, row.id))
        .filter(Boolean);
    },

    claimExecution(projectId, executionId, input = {}) {
      const claimToken = requiredText(input.claimToken, "claimToken");
      const claimedAt = optionalText(input.claimedAt, now());
      const leaseMs = Number.isInteger(input.leaseMs) && input.leaseMs > 0 ? input.leaseMs : 30_000;
      const leaseExpiresAt = addMs(claimedAt, leaseMs);

      const claimed = withTransaction(database, () => {
        const execution = getExecutionRow(database, projectId, executionId);
        if (!execution || execution.finished_at || execution.status !== "running") {
          return false;
        }
        if (execution.claim_token && execution.claim_token !== claimToken && !isExpiredIso(execution.claim_expires_at, claimedAt)) {
          return false;
        }

        database
          .prepare(
            `update executions
             set claim_token = ?, claim_expires_at = ?, updated_at = ?
             where project_id = ? and id = ?`,
          )
          .run(claimToken, leaseExpiresAt, claimedAt, projectId, executionId);
        return true;
      });

      return claimed ? commands.getExecution(projectId, executionId) : null;
    },

    releaseExecutionClaim(projectId, executionId, input = {}) {
      const claimToken = requiredText(input.claimToken, "claimToken");
      const releasedAt = optionalText(input.releasedAt, now());
      database
        .prepare(
          `update executions
           set claim_token = '', claim_expires_at = null, updated_at = ?
           where project_id = ? and id = ? and claim_token = ? and finished_at is null`,
        )
        .run(releasedAt, projectId, executionId, claimToken);
      return commands.getExecution(projectId, executionId);
    },

    reconcileActiveExecutions(input = {}) {
      const activeExecutions = commands.listActiveExecutions();
      const summaryMd = optionalText(
        input.summaryMd,
        "Floop recovered after restart before this lane reported a final result.",
      );
      const remainingWorkMd = optionalText(
        input.remainingWorkMd,
        "Retry or continue this lane now that the control plane is back online.",
      );

      return activeExecutions
        .map((execution) =>
          commands.completeExecution(execution.projectId, execution.id, {
            outcome: "failed",
            summaryMd,
            remainingWorkMd,
            failureKind: "interrupted",
            releaseClaim: true,
          }),
        )
        .filter(Boolean);
    },

    createExecution(projectId, ticketId, input) {
      const ticket = getTicketRow(database, projectId, ticketId);
      if (!ticket) {
        return null;
      }

      const role = requiredText(input.role, "role");
      const agentProfile = resolveAgentProfileForExecution(
        database,
        projectId,
        role,
        input.agentProfileId,
      );

      const runningExecution = database
        .prepare(
          `select id
           from executions
           where project_id = ? and ticket_id = ? and role = ? and status = 'running'`,
        )
        .get(projectId, ticketId, role);
      if (runningExecution) {
        throw new Error(`Execution already running for ${ticket.key} in role ${role}`);
      }

      assertProjectCanStartExecution(database, projectId, ticket.key);

      const nextIteration =
        input.iteration ||
        Number(
          database
            .prepare(
              `select coalesce(max(iteration), 0) as max_iteration
               from executions
               where ticket_id = ? and role = ?`,
            )
            .get(ticketId, role).max_iteration,
        ) +
          1;
      const timestamp = now();
      const reason = optionalText(input.reason, `${ticket.key} execution started`);
      const execution = {
        id: `execution_${randomUUID()}`,
        projectId,
        ticketId,
        agentProfileId: agentProfile.id,
        role,
        iteration: nextIteration,
        status: "running",
        outcome: null,
        summaryMd: "",
        remainingWorkMd: "",
        expectedNextEvidenceMd: "",
        failureKind: "",
        blockedKind: "",
        claimToken: "",
        claimExpiresAt: null,
        startedAt: timestamp,
        finishedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const worktrees = planExecutionWorktrees(database, projectId, ticket, execution, timestamp);
      const nextTicketState = deriveTicketStateForExecutionStart(role);
      assertAutomaticTicketTransition({
        fromState: ticket.state,
        toState: nextTicketState,
        reasonCode: "execution_started",
      });

      withTransaction(database, () => {
        database
          .prepare(
            `insert into executions (
              id, project_id, ticket_id, agent_profile_id, role, iteration, status, outcome,
              summary_md, remaining_work_md, expected_next_evidence_md, failure_kind, blocked_kind,
              claim_token, claim_expires_at, started_at, finished_at, created_at, updated_at
            ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            execution.id,
            execution.projectId,
            execution.ticketId,
            execution.agentProfileId,
            execution.role,
            execution.iteration,
            execution.status,
            execution.outcome,
            execution.summaryMd,
            execution.remainingWorkMd,
            execution.expectedNextEvidenceMd,
            execution.failureKind,
            execution.blockedKind,
            execution.claimToken,
            execution.claimExpiresAt,
            execution.startedAt,
            execution.finishedAt,
            execution.createdAt,
            execution.updatedAt,
          );

        for (const worktree of worktrees) {
          database
            .prepare(
              `insert into worktrees (
                id, project_id, repo_id, ticket_id, execution_id, path, branch_name,
                base_ref, status, is_dirty, created_at, updated_at, cleaned_at
              ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              worktree.id,
              worktree.projectId,
              worktree.repoId,
              worktree.ticketId,
              worktree.executionId,
              worktree.path,
              worktree.branchName,
              worktree.baseRef,
              worktree.status,
              worktree.isDirty ? 1 : 0,
              worktree.createdAt,
              worktree.updatedAt,
              worktree.cleanedAt,
            );
        }

        database
          .prepare(
            "update tickets set state = ?, latest_summary = ?, updated_at = ? where project_id = ? and id = ?",
          )
          .run(nextTicketState, reason, timestamp, projectId, ticketId);

        insertEvent(database, {
          projectId,
          ticketId,
          type: "execution.started",
          summary: `${ticket.key} ${role} iteration ${nextIteration} started`,
          detail: reason,
        });

        for (const worktree of worktrees) {
          insertEvent(database, {
            projectId,
            repoId: worktree.repoId,
            ticketId,
            type: "worktree.created",
            summary: `${ticket.key} worktree planned for ${worktree.repoName}`,
            detail: `${worktree.path} @ ${worktree.branchName}`,
          });
        }
      });

      return commands.getExecution(projectId, execution.id);
    },

    completeExecution(projectId, executionId, input) {
      const execution = getExecutionRow(database, projectId, executionId);
      if (!execution) {
        return null;
      }

      if (execution.finished_at) {
        return commands.getExecution(projectId, executionId);
      }

      const ticket = getTicketRow(database, projectId, execution.ticket_id);
      const policy = requiredProjectPolicy(database, projectId);
      const timestamp = now();
      const outcome = requiredText(input.outcome, "outcome");
      const summaryMd = optionalText(input.summaryMd);
      const remainingWorkMd = optionalText(input.remainingWorkMd);
      const expectedNextEvidenceMd = optionalText(input.expectedNextEvidenceMd);
      const failureKind = optionalText(input.failureKind);
      const blockedKind = optionalText(input.blockedKind);
      const releaseClaim = input.releaseClaim !== false;
      const artifacts = input.artifacts || [];
      const embeddedReview = input.review || null;
      const embeddedValidation = input.validation || null;
      const followupTickets = input.followupTickets || [];
      const nextState = deriveTicketStateForExecutionOutcome(
        ticket.state,
        outcome,
        blockedKind,
        policy,
        execution.role,
      );
      const transitionReason = deriveExecutionEventReason({ outcome, failureKind, blockedKind });
      assertAutomaticTicketTransition({
        fromState: ticket.state,
        toState: nextState,
        reasonCode: transitionReason.reasonCode || "execution_completed",
      });
      const ticketSummary =
        compactTicketSummary(
          summaryMd || remainingWorkMd,
          `${ticket.key} ${execution.role} iteration ${execution.iteration} ${outcome.replace(/_/g, " ")}`,
        );

      withTransaction(database, () => {
        database
          .prepare(
            `update executions
             set status = ?, outcome = ?, summary_md = ?, remaining_work_md = ?,
                 expected_next_evidence_md = ?, failure_kind = ?, blocked_kind = ?,
                 claim_token = ?, claim_expires_at = ?, finished_at = ?, updated_at = ?
             where project_id = ? and id = ?`,
          )
          .run(
            "completed",
            outcome,
            summaryMd,
            remainingWorkMd,
            expectedNextEvidenceMd,
            failureKind,
            blockedKind,
            releaseClaim ? "" : execution.claim_token,
            releaseClaim ? null : execution.claim_expires_at,
            timestamp,
            timestamp,
            projectId,
            executionId,
          );

        database
          .prepare("update worktrees set status = ?, updated_at = ? where project_id = ? and execution_id = ?")
          .run(deriveWorktreeStatusForOutcome(outcome), timestamp, projectId, executionId);

        database
          .prepare("update tickets set state = ?, latest_summary = ?, updated_at = ? where project_id = ? and id = ?")
          .run(nextState, ticketSummary, timestamp, projectId, execution.ticket_id);

        insertArtifacts(
          database,
          projectId,
          execution.ticket_id,
          {
            executionId,
          },
          artifacts,
          timestamp,
        );

        insertEvent(database, {
          projectId,
          ticketId: execution.ticket_id,
          type: "execution.completed",
          summary: `${ticket.key} ${execution.role} iteration ${execution.iteration} ${outcome}`,
          detail: summaryMd || remainingWorkMd || failureKind || blockedKind || "",
          ...transitionReason,
        });
      });

      const store = getStore();
      for (const followupTicket of followupTickets) {
        store.createTicket(projectId, {
          ...followupTicket,
          parentTicketId: execution.ticket_id,
          state: deriveAgentCreatedTicketState(policy, followupTicket.state),
        });
      }

      if (outcome === "completed" && isWorkerLaneRole(execution.role)) {
        startAutoRoutedLaneExecution({
          store,
          database,
          projectId,
          ticketId: execution.ticket_id,
          reason: `${ticket.key} implementation completed; Floop routed the next evidence lane.`,
        });
      }

      if (outcome === "blocked") {
        createBlockedInputRequest(store, projectId, ticket, execution, {
          summaryMd,
          remainingWorkMd,
          expectedNextEvidenceMd,
          blockedKind,
        });
      }

      if (outcome === "completed" && execution.role === "reviewer" && embeddedReview) {
        store.createReview(projectId, execution.ticket_id, {
          executionId,
          verdict: embeddedReview.verdict,
          summaryMd: embeddedReview.summaryMd,
          blockedKind: embeddedReview.blockedKind,
          artifacts: embeddedReview.artifacts || [],
          findings: embeddedReview.findings || [],
        });
      }

      if (outcome === "completed" && execution.role === "validator" && embeddedValidation) {
        store.createValidation(projectId, execution.ticket_id, {
          executionId,
          repoIds: embeddedValidation.repoIds || [],
          commandProfile: embeddedValidation.commandProfile,
          commands: embeddedValidation.commands || [],
          verdict: embeddedValidation.verdict,
          summaryMd: embeddedValidation.summaryMd,
          blockedKind: embeddedValidation.blockedKind,
          artifacts: embeddedValidation.artifacts || [],
        });
      }

      return commands.getExecution(projectId, executionId);
    },

    continueExecution(projectId, executionId, input) {
      const execution = getExecutionRow(database, projectId, executionId);
      if (!execution) {
        return null;
      }
      if (execution.status === "cancelled") {
        throw new Error("Cancelled executions cannot be continued");
      }

      const ticket = getTicketRow(database, projectId, execution.ticket_id);
      const policy = requiredProjectPolicy(database, projectId);
      const nextIteration = Number(execution.iteration) + 1;
      if (nextIteration - 1 > Number(policy.max_auto_continue_iterations)) {
        throw new Error(
          `${ticket.key} reached the continuation limit of ${policy.max_auto_continue_iterations} iterations`,
        );
      }

      if (!execution.finished_at) {
        commands.completeExecution(projectId, executionId, {
          outcome: "needs_continue",
          summaryMd: optionalText(input.reason, "Continuation requested"),
          remainingWorkMd: optionalText(input.reason),
        });
      } else if (execution.outcome !== "needs_continue" && execution.outcome !== "blocked") {
        throw new Error("Execution must be active, blocked, or marked needs_continue before continuing");
      }

      return commands.createExecution(projectId, execution.ticket_id, {
        role: execution.role,
        agentProfileId: execution.agent_profile_id,
        iteration: nextIteration,
        reason: optionalText(input.reason, "Continuation requested"),
      });
    },

    cancelExecution(projectId, executionId, input = {}) {
      const execution = getExecutionRow(database, projectId, executionId);
      if (!execution) {
        return null;
      }

      if (execution.finished_at) {
        return commands.getExecution(projectId, executionId);
      }

      const ticket = getTicketRow(database, projectId, execution.ticket_id);
      const timestamp = now();
      const reason = optionalText(input.reason, "Execution cancelled by operator");

      withTransaction(database, () => {
        database
          .prepare(
            `update executions
             set status = ?, outcome = ?, summary_md = ?, failure_kind = ?, claim_token = '', claim_expires_at = null, finished_at = ?, updated_at = ?
             where project_id = ? and id = ?`,
          )
          .run("cancelled", "failed", reason, "cancelled", timestamp, timestamp, projectId, executionId);

        database
          .prepare("update worktrees set status = ?, updated_at = ? where project_id = ? and execution_id = ?")
          .run("cancelled", timestamp, projectId, executionId);

        database
          .prepare("update tickets set latest_summary = ?, updated_at = ? where project_id = ? and id = ?")
          .run(reason, timestamp, projectId, execution.ticket_id);

        insertEvent(database, {
          projectId,
          ticketId: execution.ticket_id,
          type: "execution.completed",
          summary: `${ticket.key} ${execution.role} iteration ${execution.iteration} cancelled`,
          detail: reason,
          reasonCode: "cancelled",
          reasonSource: "execution",
        });
      });

      return commands.getExecution(projectId, executionId);
    },

    listWorktrees(projectId, filters = {}) {
      return listWorktreeRows(database, projectId, filters).map((row) => worktreeDto(mapWorktree(row)));
    },

    cleanWorktree(projectId, worktreeId, input = {}) {
      const worktree = getWorktreeRow(database, projectId, worktreeId);
      if (!worktree) {
        return null;
      }
      if (worktree.status === "active") {
        throw new Error("Cannot clean an active worktree");
      }
      if (worktree.cleaned_at) {
        return worktreeDto(mapWorktree(worktree));
      }

      const ticket = getTicketRow(database, projectId, worktree.ticket_id);
      const repo = database
        .prepare("select name from repos where project_id = ? and id = ?")
        .get(projectId, worktree.repo_id);
      const timestamp = now();
      const reason = optionalText(input.reason, "Operator cleaned the completed worktree");

      withTransaction(database, () => {
        database
          .prepare(
            `update worktrees
             set status = ?, cleaned_at = ?, updated_at = ?
             where project_id = ? and id = ?`,
          )
          .run("cleaned", timestamp, timestamp, projectId, worktreeId);

        insertEvent(database, {
          projectId,
          repoId: worktree.repo_id,
          ticketId: worktree.ticket_id,
          type: "worktree.cleaned",
          summary: `${ticket.key} worktree cleaned for ${repo.name}`,
          detail: `${reason}\n${worktree.path}`,
        });
      });

      return worktreeDto(mapWorktree(getWorktreeRow(database, projectId, worktreeId)));
    },
  };

  return commands;
}

function isWorkerLaneRole(role) {
  return role !== "reviewer" && role !== "validator";
}

function createBlockedInputRequest(store, projectId, ticket, execution, completion) {
  const existing = store
    .listAgentMessages(projectId, { intent: "request_input", status: "pending", limit: 100 })
    ?.find((message) => message.target?.executionId === execution.id);
  if (existing) {
    return existing;
  }

  const blockedKind = completion.blockedKind || "needs_human_input";
  const questionMd =
    completion.remainingWorkMd ||
    completion.expectedNextEvidenceMd ||
    completion.summaryMd ||
    `${ticket.key} is blocked and needs input before ${execution.role} can continue.`;
  const request = store.createAgentMessage(projectId, {
    actor: "floop",
    source: "execution_blocked",
    intent: "request_input",
    target: {
      ticketId: ticket.id,
      executionId: execution.id,
      role: execution.role,
    },
    summary: `${ticket.key} needs input`,
    body: questionMd,
    metadata: {
      blockedKind,
      questionMd,
      role: execution.role,
      suggestedResponders: suggestedRespondersForBlockedKind(blockedKind, execution.role),
      formSchema: {
        fields: [
          {
            id: "responseMd",
            type: "textarea",
            label: "Response",
            required: true,
            placeholder: "Give the agent the missing decision, detail, credential status, or constraint.",
          },
        ],
        submitLabel: "Submit and continue",
      },
    },
  });
  store.createAgentMessage(projectId, {
    actor: "floop",
    source: "execution_blocked",
    intent: "comment_on_ticket",
    target: {
      ticketId: ticket.id,
      executionId: execution.id,
      requestInputMessageId: request.id,
    },
    summary: `${ticket.key} blocked question`,
    body: questionMd,
    metadata: {
      requestInputMessageId: request.id,
      blockedKind,
      role: execution.role,
      hitlQuestion: true,
    },
  });
  return request;
}

function suggestedRespondersForBlockedKind(blockedKind, role) {
  if (blockedKind === "needs_policy_override") {
    return ["product_manager", "architect"];
  }
  if (blockedKind === "needs_environment_fix") {
    return ["developer", "integrator"];
  }
  if (role === "validator") {
    return ["developer", "architect"];
  }
  return ["product_manager", "architect", "developer"];
}

function boundedLimit(value, defaultLimit, maxLimit) {
  return Number.isInteger(value) && value > 0 ? Math.min(value, maxLimit) : defaultLimit;
}
