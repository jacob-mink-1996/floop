import { defaultProjectPolicy, defaultRoleProfiles } from "../../config/src/index.mjs";
import { projectBoardDto, projectSummaryDto, ticketSummaryDto } from "../../contracts/src/index.mjs";
import { boardStates, isRoleName } from "../../domain/src/index.mjs";

export function createProjectCommands({
  database,
  getProjectRow,
  getProjectPolicyRow,
  insertProjectPolicy,
  insertRoleProfiles,
  insertEvent,
  touchProjectUpdatedAt,
  withTransaction,
  now,
  requiredText,
  optionalText,
  normalizeFilesystemPath,
  slugify,
  applyTextPatch,
  applyBooleanPatch,
  applyPositiveIntegerPatch,
  applyRefinementModePatch,
  applyJsonObjectPatch,
  hasOwn,
  mapProject,
  mapProjectPolicy,
  mapRoleProfile,
  mapTicket,
  buildBoardSummary,
  buildMergeStatus,
  getArtifactsByTicketId,
  getArtifactsByValidationRunId,
  getCountMap,
  getExecutionsByTicketId,
  getLatestValidationRunRow,
  getLatestReviewVerdictsByTicketId,
  getLatestValidationVerdictsByTicketId,
  getRepoTargetsByTicketId,
  getWorktreesByTicketId,
  hasDemoEvidence,
  listTicketRows,
  mapTicketStateToBoardState,
}) {
  const commands = {
    listProjects() {
      return database
        .prepare("select id from projects order by created_at asc")
        .all()
        .map((row) => commands.getProjectSummary(row.id))
        .filter(Boolean);
    },

    createProject(input) {
      const timestamp = now();
      const slug = requiredText(input.slug, "slug");
      const name = requiredText(input.name, "name");
      const workspaceRoot = normalizeFilesystemPath(requiredText(input.workspaceRoot, "workspaceRoot"));
      const id = `project_${slugify(slug)}`;
      const policy = defaultProjectPolicy();
      const roleProfiles = defaultRoleProfiles();

      withTransaction(database, () => {
        database
          .prepare(
            `insert into projects (
              id, slug, name, description, workspace_root, default_base_branch, created_at, updated_at
            ) values (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            slug,
            name,
            optionalText(input.description),
            workspaceRoot,
            optionalText(input.defaultBaseBranch, "main"),
            timestamp,
            timestamp,
          );

        insertProjectPolicy(database, id, policy, timestamp);
        insertRoleProfiles(database, id, roleProfiles, timestamp);
        insertEvent(database, {
          projectId: id,
          type: "project.created",
          summary: `Project ${name} created`,
        });
      });

      return commands.getProjectSummary(id);
    },

    updateProject(projectId, input) {
      const existing = getProjectRow(database, projectId);
      if (!existing) {
        return null;
      }

      const updates = {};
      const changedFields = [];
      applyTextPatch(updates, changedFields, input, existing, "name", { required: true });
      applyTextPatch(updates, changedFields, input, existing, "description");
      applyTextPatch(updates, changedFields, input, existing, "workspaceRoot", {
        column: "workspace_root",
        required: true,
        transform: normalizeFilesystemPath,
      });
      applyTextPatch(updates, changedFields, input, existing, "defaultBaseBranch", {
        column: "default_base_branch",
        required: true,
      });

      if (changedFields.length === 0) {
        return commands.getProjectSummary(projectId);
      }

      const timestamp = now();
      withTransaction(database, () => {
        const clauses = [];
        const values = [];
        for (const [column, value] of Object.entries(updates)) {
          clauses.push(`${column} = ?`);
          values.push(value);
        }

        clauses.push("updated_at = ?");
        values.push(timestamp, projectId);

        database.prepare(`update projects set ${clauses.join(", ")} where id = ?`).run(...values);

        insertEvent(database, {
          projectId,
          type: "project.updated",
          summary: `${existing.name} settings updated`,
          detail: `Updated ${changedFields.join(", ")}`,
        });
      });

      return commands.getProjectSummary(projectId);
    },

    deleteProject(projectId) {
      const existing = commands.getProjectSummary(projectId);
      if (!existing) {
        return null;
      }

      withTransaction(database, () => {
        database.prepare("delete from projects where id = ?").run(projectId);
      });

      return existing;
    },

    getProjectPolicy(projectId) {
      if (!getProjectRow(database, projectId)) {
        return null;
      }

      const policy = getProjectPolicyRow(database, projectId);
      return policy ? mapProjectPolicy(policy) : null;
    },

    updateProjectPolicy(projectId, input) {
      const project = getProjectRow(database, projectId);
      if (!project) {
        return null;
      }

      const existing = getProjectPolicyRow(database, projectId);
      if (!existing) {
        return null;
      }

      const updates = {};
      const changedFields = [];
      applyBooleanPatch(updates, changedFields, input, existing, "requireReviewer", {
        column: "require_reviewer",
      });
      applyBooleanPatch(updates, changedFields, input, existing, "requireValidator", {
        column: "require_validator",
      });
      applyBooleanPatch(updates, changedFields, input, existing, "requireHumanApprovalBeforeMerge", {
        column: "require_human_approval_before_merge",
      });
      applyBooleanPatch(updates, changedFields, input, existing, "requireDemoEvidenceBeforeMerge", {
        column: "require_demo_evidence_before_merge",
      });
      applyTextPatch(updates, changedFields, input, existing, "requiredValidationCommandProfileForMerge", {
        column: "required_validation_command_profile_for_merge",
      });
      applyPositiveIntegerPatch(updates, changedFields, input, existing, "maxParallelExecutions", {
        column: "max_parallel_executions",
      });
      applyPositiveIntegerPatch(updates, changedFields, input, existing, "maxParallelMerges", {
        column: "max_parallel_merges",
      });
      applyPositiveIntegerPatch(updates, changedFields, input, existing, "maxAutoContinueIterations", {
        column: "max_auto_continue_iterations",
      });
      applyTextPatch(updates, changedFields, input, existing, "interactionMode", {
        column: "interaction_mode",
        required: true,
      });
      applyRefinementModePatch(updates, changedFields, input, existing);
      applyTextPatch(updates, changedFields, input, existing, "steeringWorktreePolicy", {
        column: "steering_worktree_policy",
        required: true,
      });
      applyTextPatch(updates, changedFields, input, existing, "agentCreatedTicketDefaultState", {
        column: "agent_created_ticket_default_state",
        required: true,
      });
      applyJsonObjectPatch(updates, changedFields, input, existing, "ceremonyAutomation", {
        column: "ceremony_automation_json",
      });

      if (changedFields.length === 0) {
        return mapProjectPolicy(existing);
      }

      const timestamp = now();
      withTransaction(database, () => {
        const clauses = [];
        const values = [];
        for (const [column, value] of Object.entries(updates)) {
          clauses.push(`${column} = ?`);
          values.push(value);
        }

        clauses.push("updated_at = ?");
        values.push(timestamp, projectId);

        database.prepare(`update project_policies set ${clauses.join(", ")} where project_id = ?`).run(...values);
        touchProjectUpdatedAt(database, projectId, timestamp);

        insertEvent(database, {
          projectId,
          type: "project.updated",
          summary: `${project.name} policy updated`,
          detail: `Updated policy fields: ${changedFields.join(", ")}`,
        });
      });

      return commands.getProjectPolicy(projectId);
    },

    listRoleProfiles(projectId) {
      if (!getProjectRow(database, projectId)) {
        return null;
      }

      return database
        .prepare("select role, adapter, model, config_json from agent_profiles where project_id = ? order by role asc")
        .all(projectId)
        .map(mapRoleProfile);
    },

    updateRoleProfile(projectId, role, input) {
      if (!isRoleName(role)) {
        throw new Error(`Invalid assigned role: ${role}`);
      }

      const project = getProjectRow(database, projectId);
      if (!project) {
        return null;
      }

      const existing = database
        .prepare("select * from agent_profiles where project_id = ? and role = ?")
        .get(projectId, role);
      if (!existing) {
        return null;
      }

      const updates = {};
      const changedFields = [];
      applyTextPatch(updates, changedFields, input, existing, "adapter", { required: true });
      applyTextPatch(updates, changedFields, input, existing, "model", { required: true });

      if (hasOwn(input, "config")) {
        const configJson = JSON.stringify(input.config || {});
        if (existing.config_json !== configJson) {
          updates.config_json = configJson;
          changedFields.push("config");
        }
      }

      if (changedFields.length === 0) {
        return mapRoleProfile(existing);
      }

      const timestamp = now();
      withTransaction(database, () => {
        const clauses = [];
        const values = [];
        for (const [column, value] of Object.entries(updates)) {
          clauses.push(`${column} = ?`);
          values.push(value);
        }

        clauses.push("updated_at = ?");
        values.push(timestamp, projectId, role);

        database
          .prepare(`update agent_profiles set ${clauses.join(", ")} where project_id = ? and role = ?`)
          .run(...values);
        touchProjectUpdatedAt(database, projectId, timestamp);

        insertEvent(database, {
          projectId,
          type: "project.updated",
          summary: `${project.name} ${role} profile updated`,
          detail: `Updated role profile fields: ${changedFields.join(", ")}`,
        });
      });

      return mapRoleProfile(
        database
          .prepare("select role, adapter, model, config_json from agent_profiles where project_id = ? and role = ?")
          .get(projectId, role),
      );
    },

    getProjectSummary(projectId) {
      const project = getProjectRow(database, projectId);
      if (!project) {
        return null;
      }

      const tickets = listTicketRows(database, projectId);
      const repoCount = Number(
        database.prepare("select count(*) as count from repos where project_id = ?").get(projectId).count,
      );

      return projectSummaryDto(
        mapProject(database, project),
        repoCount,
        tickets.length,
        buildBoardSummary(tickets),
      );
    },

    getProjectBoard(projectId, filters = {}) {
      const project = getProjectRow(database, projectId);
      if (!project) {
        return null;
      }

      const ticketRows = listTicketRows(database, projectId, filters);
      const ticketIds = ticketRows.map((ticket) => ticket.id);
      const repoTargetsByTicketId = getRepoTargetsByTicketId(database, ticketIds);
      const executionsByTicketId = getExecutionsByTicketId(database, projectId, ticketIds);
      const worktreesByTicketId = getWorktreesByTicketId(database, projectId, ticketIds);
      const latestReviewVerdictsByTicketId = getLatestReviewVerdictsByTicketId(database, projectId, ticketIds);
      const latestValidationVerdictsByTicketId = getLatestValidationVerdictsByTicketId(
        database,
        projectId,
        ticketIds,
      );
      const pendingMessageCountsByTicketId = getPendingAgentMessageCountsByTicketId(database, projectId, ticketIds);
      const eventCountsByTicketId = getCountMap(
        database,
        "select ticket_id as ticketId, count(*) as count from events where project_id = ? and ticket_id is not null group by ticket_id",
        [projectId],
      );
      const dependencyCountsByTicketId = getCountMap(
        database,
        "select blocked_ticket_id as ticketId, count(*) as count from ticket_dependencies where project_id = ? group by blocked_ticket_id",
        [projectId],
      );

      const columns = boardStates.map((state) => ({
        state,
        tickets: [],
      }));
      const columnsByState = new Map(columns.map((column) => [column.state, column]));

      for (const ticket of ticketRows) {
        const mappedTicket = mapTicket(ticket);
        const activeExecutions = (executionsByTicketId.get(ticket.id) || []).filter(
          (execution) => execution.status === "running",
        );
        const activeExecution = activeExecutions[0];
        const latestValidation = getLatestValidationRunRow(database, projectId, ticket.id);
        const latestValidationArtifacts = latestValidation
          ? getArtifactsByValidationRunId(database, [latestValidation.id]).get(latestValidation.id) || []
          : [];
        const ticketArtifacts = getArtifactsByTicketId(database, projectId, [ticket.id]).get(ticket.id) || [];
        const latestValidationHasDemoEvidence = hasDemoEvidence(
          latestValidation ? { ...latestValidation, artifacts: [...latestValidationArtifacts, ...ticketArtifacts] } : null,
        );
        const mergeStatus = buildMergeStatus(database, mappedTicket, worktreesByTicketId.get(ticket.id) || []);
        const summary = ticketSummaryDto(mappedTicket, {
          repoTargets: repoTargetsByTicketId.get(ticket.id) || [],
          latestReviewVerdict: latestReviewVerdictsByTicketId.get(ticket.id) || "",
          latestValidationVerdict: latestValidationVerdictsByTicketId.get(ticket.id) || "",
          activeExecutionCount: activeExecutions.length,
          activeExecutionRole: activeExecution?.role || "",
          activeExecutionClaimed: Boolean(activeExecution?.claimToken),
          pendingAgentMessageCount: pendingMessageCountsByTicketId.get(ticket.id) || 0,
          latestValidationHasDemoEvidence,
          mergeReadiness: mergeStatus.readiness,
          mergeStatusSummary: mergeStatus.statusSummary,
          mergeBlockingReasonCode: mergeStatus.blockingReasons?.[0]?.code || "",
          eventCount: eventCountsByTicketId.get(ticket.id) || 0,
          dependencyCount: dependencyCountsByTicketId.get(ticket.id) || 0,
        });
        const column = columnsByState.get(mapTicketStateToBoardState(ticket.state));
        column.tickets.push(summary);
      }

      for (const column of columns) {
        column.tickets.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      }

      return projectBoardDto(mapProject(database, project), columns, {
        totalTickets: ticketRows.length,
        generatedAt: now(),
      });
    },
  };

  return commands;
}

function getPendingAgentMessageCountsByTicketId(database, projectId, ticketIds) {
  const byTicketId = new Map(ticketIds.map((ticketId) => [ticketId, 0]));
  if (ticketIds.length === 0) {
    return byTicketId;
  }

  const pendingMessages = database
    .prepare(
      `select target_json
       from agent_messages
       where project_id = ? and status = 'pending'`,
    )
    .all(projectId);
  const ticketIdSet = new Set(ticketIds);

  for (const message of pendingMessages) {
    let target;
    try {
      target = JSON.parse(message.target_json || "{}");
    } catch {
      continue;
    }
    if (ticketIdSet.has(target.ticketId)) {
      byTicketId.set(target.ticketId, (byTicketId.get(target.ticketId) || 0) + 1);
    }
  }

  return byTicketId;
}
