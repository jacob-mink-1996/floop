import { randomUUID } from "node:crypto";
import { ticketDetailDto, ticketSummaryDto } from "../../contracts/src/index.mjs";
import { isTicketState } from "../../domain/src/index.mjs";

export function createTicketCommands({
  database,
  getTicketRow,
  getProjectRow,
  insertEvent,
  withTransaction,
  now,
  requiredText,
  optionalText,
  slugify,
  mapTicket,
  mapWorktree,
  applyTicketTextPatch,
  applyParentTicketPatch,
  assertDeletableWorktreePath,
  assertNoDependencyCycle,
  buildMergeStatus,
  getArtifactsByExecutionId,
  getArtifactsByTicketId,
  getCountMap,
  getDependenciesByBlockedTicketId,
  getExecutionsByTicketId,
  getLatestReviewVerdictsByTicketId,
  getLatestValidationVerdictsByTicketId,
  getRepoTargetsByTicketId,
  getReviewsByTicketId,
  getValidationRunsByTicketId,
  getWorktreesByTicketId,
  groupWorktreesByExecutionId,
  listProjectEvents,
  listTicketRows,
  listWorktreeRows,
  listTicketRepoTargetRows,
  normalizeRepoTargets,
  insertTicketRepoTarget,
  repoTargetsEqual,
  syncTicketRepoTargets,
  deleteWorktreePath,
  assertAutomaticTicketTransition,
  assertOperatorTicketOverride,
}) {
  const commands = {
    listTickets(projectId, filters = {}) {
      const tickets = listTicketRows(database, projectId, filters);
      const ticketIds = tickets.map((ticket) => ticket.id);
      const repoTargetsByTicketId = getRepoTargetsByTicketId(database, ticketIds);
      const executionsByTicketId = getExecutionsByTicketId(database, projectId, ticketIds);
      const latestReviewVerdictsByTicketId = getLatestReviewVerdictsByTicketId(database, projectId, ticketIds);
      const latestValidationVerdictsByTicketId = getLatestValidationVerdictsByTicketId(
        database,
        projectId,
        ticketIds,
      );
      const eventCountsByTicketId = getCountMap(
        database,
        `select ticket_id as ticketId, count(*) as count
         from events
         where project_id = ? and ticket_id is not null
         group by ticket_id`,
        [projectId],
      );
      const dependencyCountsByTicketId = getCountMap(
        database,
        `select blocked_ticket_id as ticketId, count(*) as count
         from ticket_dependencies
         where project_id = ?
         group by blocked_ticket_id`,
        [projectId],
      );

      return tickets.map((ticket) =>
        {
          const activeExecutions = (executionsByTicketId.get(ticket.id) || []).filter(
            (execution) => execution.status === "running",
          );
          const activeExecution = activeExecutions[0];
          return ticketSummaryDto(mapTicket(ticket), {
            repoTargets: repoTargetsByTicketId.get(ticket.id) || [],
            latestReviewVerdict: latestReviewVerdictsByTicketId.get(ticket.id) || "",
            latestValidationVerdict: latestValidationVerdictsByTicketId.get(ticket.id) || "",
            activeExecutionCount: activeExecutions.length,
            activeExecutionRole: activeExecution?.role || "",
            activeExecutionClaimed: Boolean(activeExecution?.claimToken),
            eventCount: eventCountsByTicketId.get(ticket.id) || 0,
            dependencyCount: dependencyCountsByTicketId.get(ticket.id) || 0,
          });
        }
      );
    },

    createTicket(projectId, input) {
      if (!getProjectRow(database, projectId)) {
        return null;
      }

      const timestamp = now();
      const state = optionalText(input.state, "PROPOSED");
      if (!isTicketState(state)) {
        throw new Error(`Invalid ticket state: ${state}`);
      }

      const nextIndex =
        Number(
          database
            .prepare(
              "select coalesce(max(cast(substr(key, instr(key, '-') + 1) as integer)), 0) as max_key_index from tickets where project_id = ?",
            )
            .get(projectId).max_key_index,
        ) + 1;
      const key = `FLOOP-${nextIndex}`;
      const ticketId = `ticket_${slugify(projectId)}_${nextIndex}`;
      const ticket = {
        id: ticketId,
        projectId,
        key,
        title: requiredText(input.title, "title"),
        brief: requiredText(input.brief, "brief"),
        state,
        priority: optionalText(input.priority, "medium"),
        acceptanceCriteriaMd: optionalText(input.acceptanceCriteriaMd),
        definitionOfDoneMd: optionalText(input.definitionOfDoneMd),
        assignedRole: optionalText(input.assignedRole, "developer"),
        latestSummary: optionalText(input.latestSummary, "Ticket created"),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const repoTargets = normalizeRepoTargets(database, projectId, input.repoTargets || []);

      withTransaction(database, () => {
        database
          .prepare(
            `insert into tickets (
              id, project_id, parent_ticket_id, key, title, brief, acceptance_criteria_md,
              definition_of_done_md, state, priority, assigned_role, latest_summary, created_at, updated_at
            ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            ticket.id,
            ticket.projectId,
            input.parentTicketId || null,
            ticket.key,
            ticket.title,
            ticket.brief,
            ticket.acceptanceCriteriaMd,
            ticket.definitionOfDoneMd,
            ticket.state,
            ticket.priority,
            ticket.assignedRole,
            ticket.latestSummary,
            ticket.createdAt,
            ticket.updatedAt,
          );

        for (const target of repoTargets) {
          insertTicketRepoTarget(database, ticket.id, target, timestamp);
        }

        insertEvent(database, {
          projectId,
          ticketId: ticket.id,
          type: "ticket.created",
          summary: `${ticket.key} created`,
        });
      });

      return commands.getTicket(projectId, ticket.id);
    },

    getTicket(projectId, ticketId) {
      const ticket = database
        .prepare("select * from tickets where project_id = ? and id = ?")
        .get(projectId, ticketId);
      if (!ticket) {
        return null;
      }

      const repoTargets = getRepoTargetsByTicketId(database, [ticket.id]).get(ticket.id) || [];
      const dependencies = getDependenciesByBlockedTicketId(database, projectId, [ticket.id]).get(ticket.id) || [];
      const executions = getExecutionsByTicketId(database, projectId, [ticket.id]).get(ticket.id) || [];
      const reviews = getReviewsByTicketId(database, projectId, [ticket.id]).get(ticket.id) || [];
      const validations = getValidationRunsByTicketId(database, projectId, [ticket.id]).get(ticket.id) || [];
      const worktrees = getWorktreesByTicketId(database, projectId, [ticket.id]).get(ticket.id) || [];
      const worktreesByExecutionId = groupWorktreesByExecutionId(worktrees);
      const executionArtifactsByExecutionId = getArtifactsByExecutionId(
        database,
        projectId,
        executions.map((execution) => execution.id),
      );
      const mergeStatus = buildMergeStatus(database, mapTicket(ticket), worktrees);
      const events = listProjectEvents(database, projectId, { ticketId });
      const artifacts = getArtifactsByTicketId(database, projectId, [ticket.id]).get(ticket.id) || [];
      const dependencyCount = Number(
        database
          .prepare("select count(*) as count from ticket_dependencies where project_id = ? and blocked_ticket_id = ?")
          .get(projectId, ticketId).count,
      );

      return ticketDetailDto(mapTicket(ticket), {
        dependencies,
        executions: executions.map((execution) => ({
          ...execution,
          artifacts: executionArtifactsByExecutionId.get(execution.id) || [],
          worktrees: worktreesByExecutionId.get(execution.id) || [],
        })),
        reviews,
        validations,
        repoTargets,
        worktrees,
        artifacts,
        mergeStatus,
        dependencyCount,
        eventCount: events.length,
        events,
      });
    },

    updateTicket(projectId, ticketId, input) {
      const existing = database
        .prepare("select * from tickets where project_id = ? and id = ?")
        .get(projectId, ticketId);
      if (!existing) {
        return null;
      }

      const updates = {};
      const changedFields = [];
      applyTicketTextPatch(updates, changedFields, input, existing, "title", { required: true });
      applyTicketTextPatch(updates, changedFields, input, existing, "brief", { required: true });
      applyTicketTextPatch(updates, changedFields, input, existing, "acceptanceCriteriaMd", {
        column: "acceptance_criteria_md",
      });
      applyTicketTextPatch(updates, changedFields, input, existing, "definitionOfDoneMd", {
        column: "definition_of_done_md",
      });
      applyTicketTextPatch(updates, changedFields, input, existing, "priority", { required: true });
      applyTicketTextPatch(updates, changedFields, input, existing, "assignedRole", {
        column: "assigned_role",
        required: true,
      });
      applyTicketTextPatch(updates, changedFields, input, existing, "latestSummary", {
        column: "latest_summary",
      });
      applyParentTicketPatch(database, updates, changedFields, projectId, ticketId, input, existing);
      const nextRepoTargets =
        input.repoTargets === undefined ? null : normalizeRepoTargets(database, projectId, input.repoTargets);
      const repoTargetsChanged =
        nextRepoTargets !== null &&
        !repoTargetsEqual(listTicketRepoTargetRows(database, ticketId), nextRepoTargets);
      if (repoTargetsChanged) {
        changedFields.push("repoTargets");
      }

      if (changedFields.length === 0) {
        return commands.getTicket(projectId, ticketId);
      }

      const timestamp = now();
      withTransaction(database, () => {
        const clauses = [];
        const values = [];
        for (const [column, value] of Object.entries(updates)) {
          clauses.push(`${column} = ?`);
          values.push(value);
        }

        if (clauses.length > 0 || repoTargetsChanged) {
          clauses.push("updated_at = ?");
          values.push(timestamp, projectId, ticketId);

          database
            .prepare(`update tickets set ${clauses.join(", ")} where project_id = ? and id = ?`)
            .run(...values);
        }

        if (repoTargetsChanged) {
          syncTicketRepoTargets(database, ticketId, nextRepoTargets, timestamp);
        }

        insertEvent(database, {
          projectId,
          ticketId,
          type: "ticket.updated",
          summary: `${existing.key} updated`,
          detail: `Updated ${changedFields.join(", ")}`,
        });
      });

      return commands.getTicket(projectId, ticketId);
    },

    addDependency(projectId, blockedTicketId, input) {
      const blockedTicket = database
        .prepare("select id, key from tickets where project_id = ? and id = ?")
        .get(projectId, blockedTicketId);
      if (!blockedTicket) {
        return null;
      }

      const blockingTicketId = requiredText(input.blockingTicketId, "blockingTicketId");
      if (blockingTicketId === blockedTicketId) {
        throw new Error("A ticket cannot depend on itself");
      }

      const blockingTicket = database
        .prepare("select id, key from tickets where project_id = ? and id = ?")
        .get(projectId, blockingTicketId);
      if (!blockingTicket) {
        return null;
      }
      assertNoDependencyCycle(database, projectId, blockedTicketId, blockingTicketId);

      const dependencyType = optionalText(input.dependencyType, "finish_to_start");
      const existingDependency = database
        .prepare(
          `select id
           from ticket_dependencies
           where project_id = ? and blocked_ticket_id = ? and blocking_ticket_id = ? and dependency_type = ?`,
        )
        .get(projectId, blockedTicketId, blockingTicketId, dependencyType);
      if (existingDependency) {
        return commands.getTicket(projectId, blockedTicketId);
      }

      const timestamp = now();
      const dependency = {
        id: `dependency_${randomUUID()}`,
        projectId,
        blockedTicketId,
        blockingTicketId,
        dependencyType,
        createdAt: timestamp,
      };

      withTransaction(database, () => {
        database
          .prepare(
            `insert into ticket_dependencies (
              id, project_id, blocking_ticket_id, blocked_ticket_id, dependency_type, created_at
            ) values (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            dependency.id,
            dependency.projectId,
            dependency.blockingTicketId,
            dependency.blockedTicketId,
            dependency.dependencyType,
            dependency.createdAt,
          );

        insertEvent(database, {
          projectId,
          ticketId: blockedTicketId,
          type: "dependency.added",
          summary: `${blockedTicket.key} blocked by ${blockingTicket.key}`,
          detail: dependency.dependencyType,
        });
      });

      return commands.getTicket(projectId, blockedTicketId);
    },

    removeDependency(projectId, blockedTicketId, dependencyId) {
      const blockedTicket = database
        .prepare("select id, key from tickets where project_id = ? and id = ?")
        .get(projectId, blockedTicketId);
      if (!blockedTicket) {
        return null;
      }

      const dependency = database
        .prepare(
          `select td.id, td.blocked_ticket_id, td.blocking_ticket_id, td.dependency_type, bt.key as blocking_ticket_key
           from ticket_dependencies td
           join tickets bt on bt.id = td.blocking_ticket_id
           where td.project_id = ? and td.blocked_ticket_id = ? and td.id = ?`,
        )
        .get(projectId, blockedTicketId, dependencyId);
      if (!dependency) {
        return null;
      }

      withTransaction(database, () => {
        database.prepare("delete from ticket_dependencies where project_id = ? and id = ?").run(projectId, dependencyId);

        insertEvent(database, {
          projectId,
          ticketId: blockedTicketId,
          type: "dependency.removed",
          summary: `${blockedTicket.key} unblocked from ${dependency.blocking_ticket_key}`,
          detail: dependency.dependency_type,
        });
      });

      return commands.getTicket(projectId, blockedTicketId);
    },

    transitionTicket(projectId, ticketId, input) {
      const nextState = requiredText(input.targetState, "targetState");
      if (!isTicketState(nextState)) {
        throw new Error(`Invalid ticket state: ${nextState}`);
      }

      const existing = database
        .prepare("select key, state from tickets where project_id = ? and id = ?")
        .get(projectId, ticketId);
      if (!existing) {
        return null;
      }

      const timestamp = now();
      const detail = optionalText(input.reason, `Transitioned to ${nextState}`);
      const reasonCode = requiredText(input.reasonCode, "reasonCode");
      const reasonSource = optionalText(input.reasonSource, "operator");
      const mode = optionalText(input.mode, "operator_override");
      if (mode === "automatic") {
        assertAutomaticTicketTransition({
          fromState: existing.state,
          toState: nextState,
          reasonCode,
        });
      } else {
        assertOperatorTicketOverride({
          fromState: existing.state,
          toState: nextState,
          reasonCode,
        });
      }
      withTransaction(database, () => {
        database
          .prepare("update tickets set state = ?, latest_summary = ?, updated_at = ? where project_id = ? and id = ?")
          .run(nextState, detail, timestamp, projectId, ticketId);

        insertEvent(database, {
          projectId,
          ticketId,
          type: "ticket.transitioned",
          summary: `${existing.key} -> ${nextState}`,
          detail,
          reasonCode,
          reasonSource,
        });
      });

      return commands.getTicket(projectId, ticketId);
    },

    restartTicket(projectId, ticketId, input = {}) {
      const ticket = getTicketRow(database, projectId, ticketId);
      if (!ticket) {
        return null;
      }

      const timestamp = now();
      const reason = optionalText(input.reason, `Restart requested for ${ticket.key}`);
      const targetState = optionalText(input.targetState, "READY");
      if (!isTicketState(targetState)) {
        throw new Error(`Invalid ticket state: ${targetState}`);
      }
      assertOperatorTicketOverride({
        fromState: ticket.state,
        toState: targetState,
        reasonCode: "ticket_restarted",
      });

      const runningExecutions = database
        .prepare("select * from executions where project_id = ? and ticket_id = ? and status = 'running'")
        .all(projectId, ticketId);
      const worktrees = listWorktreeRows(database, projectId, { ticketId }).map(mapWorktree);
      const worktreesToDelete = worktrees.filter((worktree) => worktree.status !== "cleaned");
      for (const worktree of worktreesToDelete) {
        assertDeletableWorktreePath(worktree.path);
      }

      withTransaction(database, () => {
        for (const execution of runningExecutions) {
          database
            .prepare(
              `update executions
               set status = ?, outcome = ?, summary_md = ?, failure_kind = ?, claim_token = '', claim_expires_at = null, finished_at = ?, updated_at = ?
               where project_id = ? and id = ?`,
            )
            .run("cancelled", "failed", reason, "restart_cancelled", timestamp, timestamp, projectId, execution.id);

          insertEvent(database, {
            projectId,
            ticketId,
            type: "execution.completed",
            summary: `${ticket.key} ${execution.role} iteration ${execution.iteration} cancelled for restart`,
            detail: reason,
            reasonCode: "restart_cancelled",
            reasonSource: "execution",
          });
        }

        for (const worktree of worktreesToDelete) {
          database
            .prepare(
              `update worktrees
               set status = ?, cleaned_at = ?, updated_at = ?
               where project_id = ? and id = ?`,
            )
            .run("cleaned", timestamp, timestamp, projectId, worktree.id);

          insertEvent(database, {
            projectId,
            repoId: worktree.repoId,
            ticketId,
            type: "worktree.cleaned",
            summary: `${ticket.key} worktree deleted for ${worktree.repoName}`,
            detail: `${reason}\n${worktree.path}`,
            reasonCode: "restart_deleted",
            reasonSource: "worktree",
          });
        }

        database
          .prepare(
            `update agent_messages
             set status = 'dismissed', dismissed_at = ?, updated_at = ?
             where project_id = ?
               and intent = 'request_input'
               and status = 'pending'
               and json_extract(target_json, '$.ticketId') = ?`,
          )
          .run(timestamp, timestamp, projectId, ticketId);

        database
          .prepare(
            `update tickets
             set state = ?, latest_summary = ?, updated_at = ?
             where project_id = ? and id = ?`,
          )
          .run(targetState, reason, timestamp, projectId, ticketId);

        insertEvent(database, {
          projectId,
          ticketId,
          type: "ticket.updated",
          summary: `${ticket.key} restarted`,
          detail: reason,
          reasonCode: "ticket_restarted",
          reasonSource: "operator",
        });
      });

      for (const worktree of worktreesToDelete) {
        deleteWorktreePath(worktree.path);
      }

      return commands.getTicket(projectId, ticketId);
    },
  };

  return commands;
}
