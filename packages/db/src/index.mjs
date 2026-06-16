import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import { defaultCeremonyAutomation } from "../../config/src/index.mjs";
import {
  assertAutomaticTicketTransition,
  assertOperatorTicketOverride,
  isRefinementMode,
} from "../../domain/src/index.mjs";
import { normalizeArtifactForStorage, projectArtifactRoot } from "./artifact-durability.mjs";
import { sqliteSchema, migrateSchema } from "./sqlite-schema.mjs";
import {
  mapAgentMessage,
  mapArtifact,
  mapExecution,
  mapMergeRun,
  mapReview,
  mapValidationRun,
  mapWorktree,
} from "./sqlite-row-mappers.mjs";
import {
  getCountMap,
  getArtifactsByExecutionId,
  getArtifactsByMergeRunId,
  getArtifactsByReviewId,
  getArtifactsByTicketId,
  getArtifactsByValidationRunId,
  buildBoardSummary,
  buildMergePolicyBlocks,
  buildMergeStatus,
  getDependenciesByBlockedTicketId,
  getExecutionsByTicketId,
  getLatestMergeRunRow,
  getLatestReviewRow,
  getLatestReviewVerdictsByTicketId,
  getLatestValidationRunRow,
  getLatestValidationVerdictsByTicketId,
  getRepoTargetsByTicketId,
  getReviewFindingsByReviewId,
  getReviewsByTicketId,
  getValidationRunsByTicketId,
  getWorktreesByExecutionId,
  getWorktreesByTicketId,
  groupWorktreesByExecutionId,
  listProjectArtifacts,
  listProjectEvents,
  listTicketRows,
  listWorktreeRows,
  mapTicketStateToBoardState,
} from "./sqlite-read-models.mjs";
import { seedDemoProject } from "./sqlite-seed.mjs";
import { createEvidenceCommands } from "./sqlite-evidence-commands.mjs";
import { createExecutionCommands } from "./sqlite-execution-commands.mjs";
import { createMergeCommands } from "./sqlite-merge-commands.mjs";
import { createCeremonyCommands } from "./sqlite-ceremony-commands.mjs";
import { createProjectCommands } from "./sqlite-project-commands.mjs";
import { createRepoCommands } from "./sqlite-repo-commands.mjs";
import { createAgentMessageCommands } from "./sqlite-agent-message-commands.mjs";
import { defaultDatabasePath, openSqliteDatabase, withTransaction } from "./sqlite-runtime.mjs";
import { createTicketCommands } from "./sqlite-ticket-commands.mjs";

export { defaultDatabasePath } from "./sqlite-runtime.mjs";

export function createSqliteStore(options = {}) {
  const filename = options.filename || defaultDatabasePath();
  const database = openSqliteDatabase({
    filename,
    schema: sqliteSchema,
    migrate: migrateSchema,
  });

  if (options.seedDemo !== false && countProjects(database) === 0) {
    seedDemoProject(database, options.workspaceRoot || process.cwd(), {
      insertEvent,
      insertProjectPolicy,
      insertRoleProfiles,
      now,
    });
  }

  let store;

  const projectCommands = createProjectCommands({
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
    getCountMap,
    getLatestReviewVerdictsByTicketId,
    getLatestValidationVerdictsByTicketId,
    getRepoTargetsByTicketId,
    listTicketRows,
    mapTicketStateToBoardState,
  });

  const repoCommands = createRepoCommands({
    database,
    getProjectRow,
    insertEvent,
    withTransaction,
    now,
    requiredText,
    optionalText,
    normalizeFilesystemPath,
    slugify,
    applyTextPatch,
    applyBooleanPatch,
    mapRepo,
  });

  const agentMessageCommands = createAgentMessageCommands({
    database,
    getStore: () => store,
    getProjectRow,
    insertArtifacts,
    insertEvent,
    mapAgentMessage,
    now,
    optionalText,
    requiredText,
    withTransaction,
  });

  const ticketCommands = createTicketCommands({
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
  });

  const executionCommands = createExecutionCommands({
    database,
    assertProjectCanStartExecution,
    deriveAgentCreatedTicketState,
    deriveExecutionEventReason,
    deriveTicketStateForExecutionOutcome,
    deriveTicketStateForExecutionStart,
    deriveWorktreeStatusForOutcome,
    getExecutionRow,
    getStore: () => store,
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
  });

  const evidenceCommands = createEvidenceCommands({
    database,
    getExecutionRow,
    getTicketRow,
    insertArtifacts,
    insertEvent,
    withTransaction,
    now,
    requiredText,
    optionalText,
    requiredProjectPolicy,
    resolveAgentProfileForExecution,
    deriveTicketStateForReviewVerdict,
    deriveTicketStateForValidationVerdict,
    deriveReviewEventReason,
    deriveValidationEventReason,
    normalizeValidationRepoIds,
    buildMergePolicyBlocks,
    getLatestReviewRow,
    getRepoTargetsByTicketId,
    getReviewsByTicketId,
    getValidationRunsByTicketId,
    listProjectArtifacts,
    startAutoRoutedLaneExecution,
    getStore: () => store,
    assertAutomaticTicketTransition,
  });

  const mergeCommands = createMergeCommands({
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
  });

  const ceremonyCommands = createCeremonyCommands({
    database,
    getCountMap,
    getProjectPolicyRow,
    getProjectRow,
    getRepoTargetsByTicketId,
    getStore: () => store,
    insertEvent,
    listTicketRows,
    mapProjectPolicy,
    mapRepo,
    mapTicket,
    now,
    optionalText,
    requiredText,
    withTransaction,
  });

  store = {
    close() {
      database.close();
    },

    ...projectCommands,

    ...mergeCommands,

    ...ceremonyCommands,

    ...repoCommands,

    ...agentMessageCommands,

    ...ticketCommands,

    ...executionCommands,

    ...evidenceCommands,

    listEvents(projectId, filters = {}) {
      return listProjectEvents(database, projectId, filters);
    },

  };
  return store;
}

function countProjects(database) {
  return Number(database.prepare("select count(*) as count from projects").get().count);
}

function getProjectRow(database, projectId) {
  return database.prepare("select * from projects where id = ?").get(projectId);
}

function getTicketRow(database, projectId, ticketId) {
  return database.prepare("select * from tickets where project_id = ? and id = ?").get(projectId, ticketId);
}

function getExecutionRow(database, projectId, executionId) {
  return database
    .prepare("select * from executions where project_id = ? and id = ?")
    .get(projectId, executionId);
}

function getWorktreeRow(database, projectId, worktreeId) {
  return database
    .prepare(
      `select
        w.*,
        r.slug as repo_slug,
        r.name as repo_name,
        e.role as execution_role,
        e.iteration as execution_iteration
       from worktrees w
       join repos r on r.id = w.repo_id
       join executions e on e.id = w.execution_id
       where w.project_id = ? and w.id = ?`,
    )
    .get(projectId, worktreeId);
}

function requiredProjectPolicy(database, projectId) {
  const policy = getProjectPolicyRow(database, projectId);
  if (!policy) {
    throw new Error(`Missing project policy for ${projectId}`);
  }
  return policy;
}

function assertProjectCanStartExecution(database, projectId, ticketKey) {
  const policy = requiredProjectPolicy(database, projectId);
  const runningCount = Number(
    database
      .prepare(
        `select count(*) as count
         from executions
         where project_id = ? and status = 'running'`,
      )
      .get(projectId).count,
  );

  if (runningCount >= Number(policy.max_parallel_executions)) {
    throw new Error(
      `Project execution limit reached for ${ticketKey}: ${policy.max_parallel_executions} active runs allowed`,
    );
  }
}

function assertProjectCanStartMerge(database, projectId, ticketKey) {
  const policy = requiredProjectPolicy(database, projectId);
  const runningCount = Number(
    database
      .prepare(
        `select count(*) as count
         from merge_runs
         where project_id = ? and status = 'running' and finished_at is null`,
      )
      .get(projectId).count,
  );

  if (runningCount >= Number(policy.max_parallel_merges)) {
    throw new Error(
      `Project merge limit reached for ${ticketKey}: ${policy.max_parallel_merges} active merges allowed`,
    );
  }
}

function startAutoRoutedLaneExecution({ store, database, projectId, ticketId, reason }) {
  const ticket = getTicketRow(database, projectId, ticketId);
  if (!ticket) {
    return null;
  }

  const policy = requiredProjectPolicy(database, projectId);

  let nextRole = null;
  if (ticket.state === "REVIEWING") {
    nextRole = "reviewer";
  } else if (ticket.state === "VALIDATING") {
    nextRole = "validator";
  } else if (ticket.state === "REWORK") {
    nextRole = resolveReworkExecutionRole(database, projectId, ticket);
  } else {
    return null;
  }

  const interactionMode = policy.interaction_mode || policy.interactionMode || "manual";
  if (interactionMode === "manual") {
    return null;
  }

  if (interactionMode === "operator_approved") {
    const existingSuggestion = database
      .prepare(
        `select id
         from agent_messages
         where project_id = ?
           and status = 'pending'
           and intent = 'suggest_dispatch'
           and json_extract(target_json, '$.ticketId') = ?
           and json_extract(metadata_json, '$.role') = ?
         order by created_at desc
         limit 1`,
      )
      .get(projectId, ticketId, nextRole);
    if (!existingSuggestion) {
      store.createAgentMessage(projectId, {
        actor: "floop",
        source: "interaction_policy",
        intent: "suggest_dispatch",
        target: { ticketId },
        summary: `Dispatch ${nextRole} lane for ${ticket.key}`,
        body: reason || `${ticket.key} is ready for ${nextRole} work.`,
        metadata: {
          role: nextRole,
          interactionMode,
          reasonCode: "routine_lane_ready",
        },
      });
    }
    return null;
  }

  const runningExecution = database
    .prepare(
      `select id
       from executions
       where project_id = ? and ticket_id = ? and role = ? and status = 'running'`,
    )
    .get(projectId, ticketId, nextRole);
  if (runningExecution) {
    return store.getExecution(projectId, runningExecution.id);
  }

  try {
    return store.createExecution(projectId, ticketId, {
      role: nextRole,
      reason,
    });
  } catch {
    return null;
  }
}

function resolveReworkExecutionRole(database, projectId, ticket) {
  const latestWorkingExecution = database
    .prepare(
      `select role
       from executions
       where project_id = ?
         and ticket_id = ?
         and role not in ('reviewer', 'validator')
       order by coalesce(finished_at, started_at) desc, started_at desc, iteration desc
       limit 1`,
    )
    .get(projectId, ticket.id);
  return latestWorkingExecution?.role || ticket.assigned_role || "developer";
}

function mapProject(database, row) {
  const policy = getProjectPolicyRow(database, row.id);
  const roleProfiles = database
    .prepare("select role, adapter, model, config_json from agent_profiles where project_id = ? order by role asc")
    .all(row.id);

      return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    workspaceRoot: row.workspace_root,
    defaultBaseBranch: row.default_base_branch,
    policy: mapProjectPolicy(policy),
    roleProfiles: roleProfiles.map(mapRoleProfile),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapProjectPolicy(row) {
  return {
    requireReviewer: Boolean(row.require_reviewer),
    requireValidator: Boolean(row.require_validator),
    requireHumanApprovalBeforeMerge: Boolean(row.require_human_approval_before_merge),
    requireDemoEvidenceBeforeMerge: row.require_demo_evidence_before_merge === undefined
      ? true
      : Boolean(row.require_demo_evidence_before_merge),
    requiredValidationCommandProfileForMerge: row.required_validation_command_profile_for_merge || "",
    maxParallelExecutions: Number(row.max_parallel_executions),
    maxParallelMerges: Number(row.max_parallel_merges),
    maxAutoContinueIterations: Number(row.max_auto_continue_iterations),
    interactionMode: row.interaction_mode || "manual",
    refinementMode: row.refinement_mode || "user_approved",
    agentCreatedTicketDefaultState: row.agent_created_ticket_default_state,
    ceremonyAutomation: mergeCeremonyAutomation(parseJsonObject(row.ceremony_automation_json, {})),
  };
}

function mergeCeremonyAutomation(value = {}) {
  const defaults = defaultCeremonyAutomation();
  const triggers = value.triggers && typeof value.triggers === "object" && !Array.isArray(value.triggers)
    ? value.triggers
    : {};
  return {
    ...defaults,
    ...value,
    triggers: Object.fromEntries(
      Object.entries(defaults.triggers).map(([type, trigger]) => [
        type,
        {
          ...trigger,
          ...(triggers[type] || {}),
        },
      ]),
    ),
  };
}

function mapRoleProfile(row) {
  return {
    role: row.role,
    adapter: row.adapter,
    model: row.model,
    config: JSON.parse(row.config_json),
  };
}

function resolveAgentProfileForExecution(database, projectId, role, agentProfileId) {
  if (agentProfileId) {
    const profile = database
      .prepare("select id, role from agent_profiles where project_id = ? and id = ?")
      .get(projectId, agentProfileId);
    if (!profile) {
      throw new Error(`Unknown agent profile: ${agentProfileId}`);
    }
    if (profile.role !== role) {
      throw new Error(`Agent profile ${agentProfileId} does not match role ${role}`);
    }
    return profile;
  }

  const profile = database
    .prepare("select id, role from agent_profiles where project_id = ? and role = ?")
    .get(projectId, role);
  if (!profile) {
    throw new Error(`No agent profile configured for role: ${role}`);
  }
  return profile;
}

function mapRepo(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    slug: row.slug,
    name: row.name,
    localPath: row.local_path,
    remoteUrl: row.remote_url,
    defaultBranch: row.default_branch,
    isPrimary: Boolean(row.is_primary),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTicket(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    parentTicketId: row.parent_ticket_id,
    key: row.key,
    title: row.title,
    brief: row.brief,
    state: row.state,
    priority: row.priority,
    acceptanceCriteriaMd: row.acceptance_criteria_md,
    definitionOfDoneMd: row.definition_of_done_md,
    assignedRole: row.assigned_role,
    latestSummary: row.latest_summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseJsonObject(value, fallback) {
  try {
    const parsed = JSON.parse(value || "");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function deriveExecutionEventReason({ outcome, failureKind, blockedKind }) {
  if (outcome === "blocked") {
    return {
      reasonCode: blockedKind || "execution_blocked",
      reasonSource: blockedKind ? "policy" : "execution",
    };
  }
  if (outcome === "failed") {
    return {
      reasonCode: failureKind || blockedKind || "execution_failed",
      reasonSource: failureKind ? "execution" : blockedKind ? "policy" : "execution",
    };
  }
  if (outcome === "needs_continue") {
    return {
      reasonCode: "needs_continue",
      reasonSource: "execution",
    };
  }
  return {
    reasonCode: "",
    reasonSource: "",
  };
}

function deriveReviewEventReason(review) {
  if (review.verdict === "blocked") {
    return {
      reasonCode: review.blockedKind || "review_blocked",
      reasonSource: review.blockedKind ? "policy" : "review",
    };
  }
  if (review.verdict === "rework") {
    return {
      reasonCode: "review_rework",
      reasonSource: "review",
    };
  }
  return {
    reasonCode: "",
    reasonSource: "",
  };
}

function deriveValidationEventReason({ verdict, blockedKind, mergePolicyBlock }) {
  if (mergePolicyBlock?.code) {
    return {
      reasonCode: mergePolicyBlock.code,
      reasonSource: mergePolicyBlock.source || "validation",
    };
  }
  if (verdict === "blocked") {
    return {
      reasonCode: blockedKind || "validation_blocked",
      reasonSource: blockedKind ? "policy" : "validation",
    };
  }
  if (verdict === "failed") {
    return {
      reasonCode: "validation_failed",
      reasonSource: "validation",
    };
  }
  return {
    reasonCode: "",
    reasonSource: "",
  };
}

function deriveMergeEventReason(status, failureKind = "") {
  if (status === "blocked") {
    return {
      reasonCode: failureKind || "merge_blocked",
      reasonSource: failureKind ? "merge" : "merge",
    };
  }
  if (status === "rework") {
    return {
      reasonCode: "merge_rework",
      reasonSource: "merge",
    };
  }
  return {
    reasonCode: "",
    reasonSource: "",
  };
}

function deriveTicketStateForExecutionOutcome(currentState, outcome, blockedKind, policy, role) {
  if (role === "reviewer") {
    if (outcome === "completed" || outcome === "needs_continue") return "REVIEWING";
    if (outcome === "blocked") return "BLOCKED";
    if (outcome === "failed" && blockedKind) return "BLOCKED";
    if (outcome === "followup_created") return "DONE";
    return "REVIEWING";
  }
  if (role === "validator") {
    if (outcome === "completed" || outcome === "needs_continue") return "VALIDATING";
    if (outcome === "blocked") return "BLOCKED";
    if (outcome === "failed" && blockedKind) return "BLOCKED";
    if (outcome === "followup_created") return "DONE";
    return "VALIDATING";
  }
  if (outcome === "completed") {
    const requireReviewer = readPolicyBoolean(policy, "requireReviewer", "require_reviewer");
    const requireValidator = readPolicyBoolean(policy, "requireValidator", "require_validator");
    if (requireReviewer) {
      return "REVIEWING";
    }
    if (requireValidator) {
      return "VALIDATING";
    }
    return "READY_TO_MERGE";
  }
  if (outcome === "needs_continue") return "WORKING";
  if (outcome === "blocked") return "BLOCKED";
  if (outcome === "failed" && blockedKind) return "BLOCKED";
  if (outcome === "followup_created") return "DONE";
  return "WORKING";
}

function deriveAgentCreatedTicketState(policy, requestedState) {
  const defaultState = requestedState || policy.agentCreatedTicketDefaultState || policy.agent_created_ticket_default_state;
  if ((policy.refinementMode || policy.refinement_mode) === "autonomous") {
    return defaultState;
  }
  return defaultState === "DRAFT" ? "DRAFT" : "PROPOSED";
}

function deriveTicketStateForExecutionStart(role) {
  if (role === "reviewer") return "REVIEWING";
  if (role === "validator") return "VALIDATING";
  return "WORKING";
}

function deriveTicketStateForReviewVerdict(policy, verdict) {
  const requireValidator = readPolicyBoolean(policy, "requireValidator", "require_validator");
  if (verdict === "passed") {
    return requireValidator ? "VALIDATING" : "READY_TO_MERGE";
  }
  if (verdict === "blocked") {
    return "BLOCKED";
  }
  return "REWORK";
}

function deriveTicketStateForValidationVerdict(_policy, verdict) {
  if (verdict === "passed") {
    return "READY_TO_MERGE";
  }
  if (verdict === "blocked") {
    return "BLOCKED";
  }
  return "REWORK";
}

function deriveTicketStateForMergeStatus(status) {
  if (status === "completed") {
    return "DONE";
  }
  if (status === "blocked") {
    return "BLOCKED";
  }
  if (status === "rework") {
    return "REWORK";
  }
  throw new Error(`Invalid merge status: ${status}`);
}

function describeMergePolicyBlock(policy, latestReview, latestValidation) {
  return buildMergePolicyBlocks(policy, latestReview, latestValidation)[0]?.message || "";
}

function deriveWorktreeStatusForOutcome(outcome) {
  if (outcome === "completed") return "ready_for_review";
  if (outcome === "needs_continue") return "needs_continue";
  if (outcome === "blocked") return "blocked";
  if (outcome === "followup_created") return "handoff";
  return "failed";
}

function planExecutionWorktrees(database, projectId, ticket, execution, timestamp) {
  const project = getProjectRow(database, projectId);
  const repoTargets = getRepoTargetsByTicketId(database, [ticket.id]).get(ticket.id) || [];
  const worktreeLeaf =
    execution.role === "developer" ? `iter-${execution.iteration}` : `${execution.role}-iter-${execution.iteration}`;

  return repoTargets.map((target) => {
    const plannedBranch = planExecutionBranchName(ticket, target, execution);
    return {
      id: `worktree_${randomUUID()}`,
      projectId,
      repoId: target.repoId,
      ticketId: ticket.id,
      executionId: execution.id,
      repoName: target.repoName,
      path: resolve(
        project.workspace_root,
        ".floop",
        "worktrees",
        ticket.key.toLowerCase(),
        target.repoSlug,
        worktreeLeaf,
      ),
      branchName: plannedBranch.branchName,
      baseRef: plannedBranch.baseRef,
      status: "active",
      isDirty: false,
      createdAt: timestamp,
      updatedAt: timestamp,
      cleanedAt: null,
    };
  });
}

function planExecutionBranchName(ticket, target, execution) {
  const ticketBranch = target.branchName || defaultWorktreeBranchName(ticket, execution.role, 1);
  if (execution.role === "reviewer" || execution.role === "validator" || Number(execution.iteration) > 1) {
    return {
      branchName: `${ticketBranch}-${execution.role}-iter-${execution.iteration}`.slice(0, 63),
      baseRef: ticketBranch,
    };
  }
  return {
    branchName: ticketBranch,
    baseRef: target.baseRef,
  };
}

function defaultWorktreeBranchName(ticket, role = "developer", iteration = 1) {
  const base = `${ticket.key.toLowerCase()}-${slugify(ticket.title).replaceAll("_", "-")}`;
  if (role === "developer") {
    return base.slice(0, 63);
  }
  return `${base}-${role}-iter-${iteration}`.slice(0, 63);
}

function normalizeRepoTargets(database, projectId, repoTargets) {
  const reposById = new Map(
    database
      .prepare("select id, default_branch from repos where project_id = ?")
      .all(projectId)
      .map((row) => [row.id, row]),
  );
  const seenRepoIds = new Set();

  return repoTargets.map((target, index) => {
    const repoId = requiredText(target.repoId, `repoTargets[${index}].repoId`);
    if (seenRepoIds.has(repoId)) {
      throw new Error(`Duplicate repo target: ${repoId}`);
    }

    const repo = reposById.get(repoId);
    if (!repo) {
      throw new Error(`Unknown repo target: ${repoId}`);
    }

    seenRepoIds.add(repoId);
    return {
      repoId,
      baseRef: optionalText(target.baseRef, repo.default_branch),
      branchName: optionalText(target.branchName),
      targetScopeMd: optionalText(target.targetScopeMd),
    };
  });
}

function normalizeValidationRepoIds(database, projectId, ticket, repoTargets, repoIds) {
  const targetedRepoIds = new Set(repoTargets.map((target) => target.repoId));
  const candidateRepoIds = repoIds.length > 0 ? repoIds : [...targetedRepoIds];
  if (candidateRepoIds.length === 0) {
    throw new Error(`No repo targets configured for validation on ${ticket.key}`);
  }

  const seenRepoIds = new Set();
  return candidateRepoIds.map((repoId) => {
    const normalizedRepoId = requiredText(repoId, "repoId");
    if (seenRepoIds.has(normalizedRepoId)) {
      throw new Error(`Duplicate validation repo target: ${normalizedRepoId}`);
    }
    seenRepoIds.add(normalizedRepoId);

    const repo = database
      .prepare("select id from repos where project_id = ? and id = ?")
      .get(projectId, normalizedRepoId);
    if (!repo) {
      throw new Error(`Unknown validation repo target: ${normalizedRepoId}`);
    }
    if (targetedRepoIds.size > 0 && !targetedRepoIds.has(normalizedRepoId)) {
      throw new Error(`Validation repo target is not attached to ${ticket.key}: ${normalizedRepoId}`);
    }
    return normalizedRepoId;
  });
}

function readPolicyBoolean(policy, mappedKey, rawKey) {
  if (Object.prototype.hasOwnProperty.call(policy, mappedKey)) {
    return Boolean(policy[mappedKey]);
  }
  return Boolean(policy[rawKey]);
}

function applyParentTicketPatch(database, updates, changedFields, projectId, ticketId, input, existing) {
  if (!hasOwn(input, "parentTicketId")) {
    return;
  }

  const parentTicketId = input.parentTicketId ?? null;
  if (parentTicketId === ticketId) {
    throw new Error("A ticket cannot parent itself");
  }

  if (parentTicketId) {
    const parentTicket = database
      .prepare("select id from tickets where project_id = ? and id = ?")
      .get(projectId, parentTicketId);
    if (!parentTicket) {
      throw new Error(`Unknown parent ticket: ${parentTicketId}`);
    }
    assertNoParentCycle(database, projectId, ticketId, parentTicketId);
  }

  if ((existing.parent_ticket_id || null) === parentTicketId) {
    return;
  }

  updates.parent_ticket_id = parentTicketId;
  changedFields.push("parentTicketId");
}

function assertNoParentCycle(database, projectId, ticketId, parentTicketId) {
  let currentTicketId = parentTicketId;
  while (currentTicketId) {
    if (currentTicketId === ticketId) {
      throw new Error(`Parent cycle detected for ticket ${ticketId}`);
    }

    currentTicketId = (
      database
        .prepare("select parent_ticket_id from tickets where project_id = ? and id = ?")
        .get(projectId, currentTicketId) || {}
    ).parent_ticket_id;
  }
}

function assertNoDependencyCycle(database, projectId, blockedTicketId, blockingTicketId) {
  const pendingTicketIds = [blockingTicketId];
  const seenTicketIds = new Set();

  while (pendingTicketIds.length > 0) {
    const currentTicketId = pendingTicketIds.pop();
    if (!currentTicketId || seenTicketIds.has(currentTicketId)) {
      continue;
    }

    if (currentTicketId === blockedTicketId) {
      throw new Error(`Dependency cycle detected for ticket ${blockedTicketId}`);
    }

    seenTicketIds.add(currentTicketId);
    const blockingTicketIds = database
      .prepare(
        `select blocking_ticket_id
         from ticket_dependencies
         where project_id = ? and blocked_ticket_id = ?`,
      )
      .all(projectId, currentTicketId)
      .map((row) => row.blocking_ticket_id);
    pendingTicketIds.push(...blockingTicketIds);
  }
}

function listTicketRepoTargetRows(database, ticketId) {
  return database
    .prepare(
      `select id, repo_id, base_ref, branch_name, target_scope_md
       from ticket_repo_targets
       where ticket_id = ?
       order by repo_id asc`,
    )
    .all(ticketId)
    .map((row) => ({
      id: row.id,
      repoId: row.repo_id,
      baseRef: row.base_ref,
      branchName: row.branch_name,
      targetScopeMd: row.target_scope_md,
    }));
}

function repoTargetsEqual(currentTargets, nextTargets) {
  if (currentTargets.length !== nextTargets.length) {
    return false;
  }

  const currentByRepoId = new Map(currentTargets.map((target) => [target.repoId, target]));
  for (const nextTarget of nextTargets) {
    const currentTarget = currentByRepoId.get(nextTarget.repoId);
    if (!currentTarget) {
      return false;
    }

    if (
      currentTarget.baseRef !== nextTarget.baseRef ||
      currentTarget.branchName !== nextTarget.branchName ||
      currentTarget.targetScopeMd !== nextTarget.targetScopeMd
    ) {
      return false;
    }
  }

  return true;
}

function syncTicketRepoTargets(database, ticketId, repoTargets, timestamp) {
  const existingTargets = listTicketRepoTargetRows(database, ticketId);
  const existingByRepoId = new Map(existingTargets.map((target) => [target.repoId, target]));
  const nextByRepoId = new Map(repoTargets.map((target) => [target.repoId, target]));

  for (const existingTarget of existingTargets) {
    if (!nextByRepoId.has(existingTarget.repoId)) {
      database.prepare("delete from ticket_repo_targets where ticket_id = ? and repo_id = ?").run(ticketId, existingTarget.repoId);
    }
  }

  for (const target of repoTargets) {
    const existingTarget = existingByRepoId.get(target.repoId);
    if (!existingTarget) {
      insertTicketRepoTarget(database, ticketId, target, timestamp);
      continue;
    }

    if (
      existingTarget.baseRef === target.baseRef &&
      existingTarget.branchName === target.branchName &&
      existingTarget.targetScopeMd === target.targetScopeMd
    ) {
      continue;
    }

    database
      .prepare(
        `update ticket_repo_targets
         set base_ref = ?, branch_name = ?, target_scope_md = ?, updated_at = ?
         where ticket_id = ? and repo_id = ?`,
      )
      .run(target.baseRef, target.branchName, target.targetScopeMd, timestamp, ticketId, target.repoId);
  }
}

function insertTicketRepoTarget(database, ticketId, target, timestamp) {
  database
    .prepare(
      `insert into ticket_repo_targets (
        id, ticket_id, repo_id, base_ref, branch_name, target_scope_md, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `ticket_target_${slugify(ticketId)}_${slugify(target.repoId)}`,
      ticketId,
      target.repoId,
      target.baseRef,
      target.branchName,
      target.targetScopeMd,
      timestamp,
      timestamp,
    );
}

function insertArtifacts(database, projectId, ticketId, scope, artifacts, timestamp) {
  const project = getProjectRow(database, projectId);
  const artifactRoot = projectArtifactRoot(project?.workspace_root || process.cwd());
  for (const artifact of artifacts) {
    const storedArtifact = normalizeArtifactForStorage(
      {
        kind: requiredText(artifact.kind, "artifact.kind"),
        label: requiredText(artifact.label, "artifact.label"),
        uri: requiredText(artifact.uri, "artifact.uri"),
        metadata: artifact.metadata || {},
      },
      { artifactRoot },
    );
    database
      .prepare(
        `insert into artifacts (
          id, project_id, ticket_id, execution_id, review_id, validation_run_id, merge_run_id,
          kind, label, uri, metadata_json, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `artifact_${randomUUID()}`,
        projectId,
        ticketId,
        scope.executionId || null,
        scope.reviewId || null,
        scope.validationRunId || null,
        scope.mergeRunId || null,
        storedArtifact.kind,
        storedArtifact.label,
        storedArtifact.uri,
        JSON.stringify(storedArtifact.metadata),
        timestamp,
      );
  }
}

function insertProjectPolicy(database, projectId, policy, timestamp) {
  database
    .prepare(
      `insert into project_policies (
        id, project_id, require_reviewer, require_validator,
        require_human_approval_before_merge, require_demo_evidence_before_merge,
        required_validation_command_profile_for_merge,
        max_parallel_executions, max_parallel_merges, max_auto_continue_iterations,
        interaction_mode, refinement_mode, agent_created_ticket_default_state, ceremony_automation_json,
        created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `policy_${slugify(projectId)}`,
      projectId,
      policy.requireReviewer ? 1 : 0,
      policy.requireValidator ? 1 : 0,
      policy.requireHumanApprovalBeforeMerge ? 1 : 0,
      policy.requireDemoEvidenceBeforeMerge === false ? 0 : 1,
      policy.requiredValidationCommandProfileForMerge || "",
      policy.maxParallelExecutions,
      policy.maxParallelMerges ?? 1,
      policy.maxAutoContinueIterations,
      policy.interactionMode || "manual",
      policy.refinementMode || "user_approved",
      policy.agentCreatedTicketDefaultState,
      JSON.stringify(policy.ceremonyAutomation || defaultCeremonyAutomation()),
      timestamp,
      timestamp,
    );
}

function insertRoleProfiles(database, projectId, roleProfiles, timestamp) {
  for (const profile of roleProfiles) {
    database
      .prepare(
        `insert into agent_profiles (
          id, project_id, role, adapter, model, config_json, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `profile_${slugify(projectId)}_${slugify(profile.role)}`,
        projectId,
        profile.role,
        profile.adapter,
        profile.model,
        JSON.stringify(profile.config || {}),
        timestamp,
        timestamp,
      );
  }
}

function insertEvent(database, input) {
  database
    .prepare(
      `insert into events (
        id, project_id, repo_id, ticket_id, type, summary, detail, reason_code, reason_source, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `event_${randomUUID()}`,
      input.projectId,
      input.repoId || null,
      input.ticketId || null,
      input.type,
      input.summary,
      input.detail || "",
      input.reasonCode || "",
      input.reasonSource || "",
      now(),
    );
}

function now() {
  return new Date().toISOString();
}

function addMs(timestamp, milliseconds) {
  return new Date(new Date(timestamp).getTime() + milliseconds).toISOString();
}

function isExpiredIso(timestamp, referenceTimestamp = now()) {
  if (!timestamp) {
    return true;
  }
  return new Date(timestamp).getTime() <= new Date(referenceTimestamp).getTime();
}

function requiredText(value, fieldName) {
  const text = optionalText(value);
  if (!text) {
    throw new Error(`Missing required field: ${fieldName}`);
  }
  return text;
}

function optionalText(value, fallback = "") {
  if (typeof value !== "string") {
    return fallback;
  }
  return value.trim() || fallback;
}

function normalizeFilesystemPath(value) {
  const text = requiredText(value, "path");
  if (text === "~") {
    return homedir();
  }
  if (text.startsWith("~/")) {
    return resolve(homedir(), text.slice(2));
  }
  return text;
}

function deleteWorktreePath(worktreePath) {
  const resolvedPath = resolve(worktreePath);
  assertDeletableWorktreePath(resolvedPath);
  rmSync(resolvedPath, { recursive: true, force: true });
}

function assertDeletableWorktreePath(worktreePath) {
  const resolvedPath = resolve(worktreePath);
  const marker = `${sep}.floop${sep}worktrees${sep}`;
  if (!resolvedPath.includes(marker)) {
    throw new Error(`Refusing to delete non-Floop worktree path: ${worktreePath}`);
  }
}

function applyTicketTextPatch(updates, changedFields, input, existing, field, options = {}) {
  applyTextPatch(updates, changedFields, input, existing, field, options);
}

function applyTextPatch(updates, changedFields, input, existing, field, options = {}) {
  if (!hasOwn(input, field)) {
    return;
  }

  const rawValue = input[field];
  if (typeof rawValue !== "string") {
    throw new Error(`Field ${field} must be a string`);
  }

  const textValue = options.required ? requiredText(rawValue, field) : rawValue.trim();
  const value = options.transform ? options.transform(textValue) : textValue;
  const column = options.column || camelToSnake(field);
  if (existing[column] === value) {
    return;
  }

  updates[column] = value;
  changedFields.push(field);
}

function applyBooleanPatch(updates, changedFields, input, existing, field, options = {}) {
  if (!hasOwn(input, field)) {
    return;
  }

  if (typeof input[field] !== "boolean") {
    throw new Error(`Field ${field} must be a boolean`);
  }

  const column = options.column || camelToSnake(field);
  const value = input[field] ? 1 : 0;
  if (Number(existing[column]) === value) {
    return;
  }

  updates[column] = value;
  changedFields.push(field);
}

function applyPositiveIntegerPatch(updates, changedFields, input, existing, field, options = {}) {
  if (!hasOwn(input, field)) {
    return;
  }

  if (!Number.isInteger(input[field]) || input[field] <= 0) {
    throw new Error(`Field ${field} must be a positive integer`);
  }

  const column = options.column || camelToSnake(field);
  if (Number(existing[column]) === input[field]) {
    return;
  }

  updates[column] = input[field];
  changedFields.push(field);
}

function applyJsonObjectPatch(updates, changedFields, input, existing, field, options = {}) {
  if (!hasOwn(input, field)) {
    return;
  }

  const value = input[field];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Field ${field} must be a JSON object`);
  }

  const column = options.column || camelToSnake(field);
  const serialized = JSON.stringify(value);
  if ((existing[column] || "{}") === serialized) {
    return;
  }

  updates[column] = serialized;
  changedFields.push(field);
}

function applyRefinementModePatch(updates, changedFields, input, existing) {
  if (!hasOwn(input, "refinementMode")) {
    return;
  }

  const refinementMode = requiredText(input.refinementMode, "refinementMode");
  if (!isRefinementMode(refinementMode)) {
    throw new Error(`Invalid refinement mode: ${refinementMode}`);
  }

  if (existing.refinement_mode === refinementMode) {
    return;
  }

  updates.refinement_mode = refinementMode;
  changedFields.push("refinementMode");
}

function camelToSnake(value) {
  return value.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
}

function hasOwn(value, key) {
  return Boolean(value) && Object.prototype.hasOwnProperty.call(value, key);
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function getProjectPolicyRow(database, projectId) {
  return database.prepare("select * from project_policies where project_id = ?").get(projectId);
}

function touchProjectUpdatedAt(database, projectId, timestamp) {
  database.prepare("update projects set updated_at = ? where id = ?").run(timestamp, projectId);
}
