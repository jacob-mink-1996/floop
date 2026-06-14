import { artifactDto, eventDto, mergeRunDto } from "../../contracts/src/index.mjs";
import {
  mapArtifact,
  mapExecution,
  mapMergeRun,
  mapReview,
  mapValidationRun,
  mapWorktree,
} from "./sqlite-row-mappers.mjs";

export function listTicketRows(database, projectId, filters = {}) {
  const clauses = ["project_id = ?"];
  const values = [projectId];

  if (filters.states?.length) {
    clauses.push(`state in (${filters.states.map(() => "?").join(", ")})`);
    values.push(...filters.states);
  }
  if (filters.priority) {
    clauses.push("priority = ?");
    values.push(filters.priority);
  }
  if (filters.assignedRole) {
    clauses.push("assigned_role = ?");
    values.push(filters.assignedRole);
  }
  if (filters.parentTicketId) {
    clauses.push("parent_ticket_id = ?");
    values.push(filters.parentTicketId);
  }
  if (filters.search) {
    clauses.push("lower(key || ' ' || title || ' ' || brief || ' ' || latest_summary) like ?");
    values.push(`%${filters.search.toLowerCase()}%`);
  }

  return database
    .prepare(`select * from tickets where ${clauses.join(" and ")} order by created_at asc`)
    .all(...values);
}

export function listWorktreeRows(database, projectId, filters = {}) {
  const clauses = ["w.project_id = ?"];
  const values = [projectId];

  if (filters.ticketId) {
    clauses.push("w.ticket_id = ?");
    values.push(filters.ticketId);
  }
  if (filters.executionId) {
    clauses.push("w.execution_id = ?");
    values.push(filters.executionId);
  }
  if (filters.status) {
    clauses.push("w.status = ?");
    values.push(filters.status);
  }

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
       where ${clauses.join(" and ")}
       order by w.updated_at desc, e.iteration desc, r.slug asc`,
    )
    .all(...values);
}

export function getRepoTargetsByTicketId(database, ticketIds) {
  const byTicketId = new Map();
  for (const ticketId of ticketIds) {
    byTicketId.set(ticketId, []);
  }
  if (ticketIds.length === 0) {
    return byTicketId;
  }

  const placeholders = ticketIds.map(() => "?").join(", ");
  const rows = database
    .prepare(
      `select
        trt.id,
        trt.ticket_id,
        trt.repo_id,
        trt.base_ref,
        trt.branch_name,
        trt.target_scope_md,
        r.slug as repo_slug,
        r.name as repo_name,
        r.local_path as repo_local_path,
        r.default_branch as repo_default_branch
      from ticket_repo_targets trt
      join repos r on r.id = trt.repo_id
      where trt.ticket_id in (${placeholders})
      order by trt.created_at asc`,
    )
    .all(...ticketIds);

  for (const row of rows) {
    const targets = byTicketId.get(row.ticket_id) || [];
    targets.push({
      id: row.id,
      repoId: row.repo_id,
      repoSlug: row.repo_slug,
      repoName: row.repo_name,
      repoLocalPath: row.repo_local_path,
      repoDefaultBranch: row.repo_default_branch,
      baseRef: row.base_ref,
      branchName: row.branch_name,
      targetScopeMd: row.target_scope_md,
    });
    byTicketId.set(row.ticket_id, targets);
  }

  return byTicketId;
}

export function getDependenciesByBlockedTicketId(database, projectId, blockedTicketIds) {
  const byBlockedTicketId = new Map();
  for (const blockedTicketId of blockedTicketIds) {
    byBlockedTicketId.set(blockedTicketId, []);
  }
  if (blockedTicketIds.length === 0) {
    return byBlockedTicketId;
  }

  const placeholders = blockedTicketIds.map(() => "?").join(", ");
  const rows = database
    .prepare(
      `select
        td.id,
        td.project_id,
        td.blocked_ticket_id,
        td.blocking_ticket_id,
        td.dependency_type,
        td.created_at,
        bt.key as blocking_ticket_key,
        bt.title as blocking_ticket_title,
        bt.state as blocking_ticket_state
      from ticket_dependencies td
      join tickets bt on bt.id = td.blocking_ticket_id
      where td.project_id = ? and td.blocked_ticket_id in (${placeholders})
      order by td.created_at asc`,
    )
    .all(projectId, ...blockedTicketIds);

  for (const row of rows) {
    const dependencies = byBlockedTicketId.get(row.blocked_ticket_id) || [];
    dependencies.push({
      id: row.id,
      projectId: row.project_id,
      blockedTicketId: row.blocked_ticket_id,
      blockingTicketId: row.blocking_ticket_id,
      blockingTicketKey: row.blocking_ticket_key,
      blockingTicketTitle: row.blocking_ticket_title,
      blockingTicketState: row.blocking_ticket_state,
      dependencyType: row.dependency_type,
      createdAt: row.created_at,
    });
    byBlockedTicketId.set(row.blocked_ticket_id, dependencies);
  }

  return byBlockedTicketId;
}

export function getLatestReviewVerdictsByTicketId(database, projectId, ticketIds) {
  const byTicketId = new Map();
  for (const ticketId of ticketIds) {
    byTicketId.set(ticketId, "");
  }
  if (ticketIds.length === 0) {
    return byTicketId;
  }

  const placeholders = ticketIds.map(() => "?").join(", ");
  const rows = database
    .prepare(
      `select ticket_id, verdict, created_at
       from reviews
       where project_id = ? and ticket_id in (${placeholders})
       order by created_at desc`,
    )
    .all(projectId, ...ticketIds);

  for (const row of rows) {
    if (!byTicketId.get(row.ticket_id)) {
      byTicketId.set(row.ticket_id, row.verdict);
    }
  }

  return byTicketId;
}

export function getLatestValidationVerdictsByTicketId(database, projectId, ticketIds) {
  const byTicketId = new Map();
  for (const ticketId of ticketIds) {
    byTicketId.set(ticketId, "");
  }
  if (ticketIds.length === 0) {
    return byTicketId;
  }

  const placeholders = ticketIds.map(() => "?").join(", ");
  const rows = database
    .prepare(
      `select ticket_id, verdict, finished_at
       from validation_runs
       where project_id = ? and ticket_id in (${placeholders})
       order by finished_at desc`,
    )
    .all(projectId, ...ticketIds);

  for (const row of rows) {
    if (!byTicketId.get(row.ticket_id)) {
      byTicketId.set(row.ticket_id, row.verdict);
    }
  }

  return byTicketId;
}

export function getLatestReviewRow(database, projectId, ticketId) {
  return database
    .prepare(
      `select id, verdict, summary_md, blocked_kind, created_at
       from reviews
       where project_id = ? and ticket_id = ?
       order by created_at desc
       limit 1`,
    )
    .get(projectId, ticketId);
}

export function getLatestValidationRunRow(database, projectId, ticketId) {
  return database
    .prepare(
      `select id, verdict, command_profile, summary_md, blocked_kind, finished_at
       from validation_runs
       where project_id = ? and ticket_id = ?
       order by finished_at desc
       limit 1`,
    )
    .get(projectId, ticketId);
}

export function getCountMap(database, sql, params) {
  return new Map(database.prepare(sql).all(...params).map((row) => [row.ticketId, Number(row.count)]));
}

export function getExecutionsByTicketId(database, projectId, ticketIds) {
  const byTicketId = new Map();
  for (const ticketId of ticketIds) {
    byTicketId.set(ticketId, []);
  }
  if (ticketIds.length === 0) {
    return byTicketId;
  }

  const placeholders = ticketIds.map(() => "?").join(", ");
  const rows = database
    .prepare(
      `select *
       from executions
       where project_id = ? and ticket_id in (${placeholders})
       order by started_at desc, iteration desc`,
    )
    .all(projectId, ...ticketIds);

  for (const row of rows) {
    const executions = byTicketId.get(row.ticket_id) || [];
    executions.push(mapExecution(row));
    byTicketId.set(row.ticket_id, executions);
  }

  return byTicketId;
}

export function getWorktreesByTicketId(database, projectId, ticketIds) {
  const byTicketId = new Map();
  for (const ticketId of ticketIds) {
    byTicketId.set(ticketId, []);
  }
  if (ticketIds.length === 0) {
    return byTicketId;
  }

  const placeholders = ticketIds.map(() => "?").join(", ");
  const rows = database
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
      where w.project_id = ? and w.ticket_id in (${placeholders})
      order by w.created_at desc, e.iteration desc`,
    )
    .all(projectId, ...ticketIds);

  for (const row of rows) {
    const worktrees = byTicketId.get(row.ticket_id) || [];
    worktrees.push(mapWorktree(row));
    byTicketId.set(row.ticket_id, worktrees);
  }

  return byTicketId;
}

export function getWorktreesByExecutionId(database, projectId, executionIds) {
  const byExecutionId = new Map();
  for (const executionId of executionIds) {
    byExecutionId.set(executionId, []);
  }
  if (executionIds.length === 0) {
    return byExecutionId;
  }

  const placeholders = executionIds.map(() => "?").join(", ");
  const rows = database
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
      where w.project_id = ? and w.execution_id in (${placeholders})
      order by w.created_at asc, r.slug asc`,
    )
    .all(projectId, ...executionIds);

  for (const row of rows) {
    const worktrees = byExecutionId.get(row.execution_id) || [];
    worktrees.push(mapWorktree(row));
    byExecutionId.set(row.execution_id, worktrees);
  }

  return byExecutionId;
}

export function getArtifactsByTicketId(database, projectId, ticketIds) {
  const byTicketId = new Map();
  for (const ticketId of ticketIds) {
    byTicketId.set(ticketId, []);
  }
  if (ticketIds.length === 0) {
    return byTicketId;
  }

  const placeholders = ticketIds.map(() => "?").join(", ");
  const rows = database
    .prepare(
      `select *
       from artifacts
       where project_id = ? and ticket_id in (${placeholders})
       order by created_at desc`,
    )
    .all(projectId, ...ticketIds);

  for (const row of rows) {
    const artifacts = byTicketId.get(row.ticket_id) || [];
    artifacts.push(mapArtifact(row));
    byTicketId.set(row.ticket_id, artifacts);
  }

  return byTicketId;
}

export function getArtifactsByExecutionId(database, projectId, executionIds) {
  const byExecutionId = new Map();
  for (const executionId of executionIds) {
    byExecutionId.set(executionId, []);
  }
  if (executionIds.length === 0) {
    return byExecutionId;
  }

  const placeholders = executionIds.map(() => "?").join(", ");
  const rows = database
    .prepare(
      `select *
       from artifacts
       where project_id = ? and execution_id in (${placeholders})
       order by created_at asc`,
    )
    .all(projectId, ...executionIds);

  for (const row of rows) {
    const artifacts = byExecutionId.get(row.execution_id) || [];
    artifacts.push(mapArtifact(row));
    byExecutionId.set(row.execution_id, artifacts);
  }

  return byExecutionId;
}

export function getArtifactsByReviewId(database, reviewIds) {
  const byReviewId = new Map();
  for (const reviewId of reviewIds) {
    byReviewId.set(reviewId, []);
  }
  if (reviewIds.length === 0) {
    return byReviewId;
  }

  const placeholders = reviewIds.map(() => "?").join(", ");
  const rows = database
    .prepare(
      `select *
       from artifacts
       where review_id in (${placeholders})
       order by created_at asc`,
    )
    .all(...reviewIds);

  for (const row of rows) {
    const artifacts = byReviewId.get(row.review_id) || [];
    artifacts.push(mapArtifact(row));
    byReviewId.set(row.review_id, artifacts);
  }

  return byReviewId;
}

export function getArtifactsByValidationRunId(database, validationRunIds) {
  const byValidationRunId = new Map();
  for (const validationRunId of validationRunIds) {
    byValidationRunId.set(validationRunId, []);
  }
  if (validationRunIds.length === 0) {
    return byValidationRunId;
  }

  const placeholders = validationRunIds.map(() => "?").join(", ");
  const rows = database
    .prepare(
      `select *
       from artifacts
       where validation_run_id in (${placeholders})
       order by created_at asc`,
    )
    .all(...validationRunIds);

  for (const row of rows) {
    const artifacts = byValidationRunId.get(row.validation_run_id) || [];
    artifacts.push(mapArtifact(row));
    byValidationRunId.set(row.validation_run_id, artifacts);
  }

  return byValidationRunId;
}

export function getArtifactsByMergeRunId(database, mergeRunIds) {
  const byMergeRunId = new Map();
  for (const mergeRunId of mergeRunIds) {
    byMergeRunId.set(mergeRunId, []);
  }
  if (mergeRunIds.length === 0) {
    return byMergeRunId;
  }

  const placeholders = mergeRunIds.map(() => "?").join(", ");
  const rows = database
    .prepare(
      `select *
       from artifacts
       where merge_run_id in (${placeholders})
       order by created_at asc`,
    )
    .all(...mergeRunIds);

  for (const row of rows) {
    const artifacts = byMergeRunId.get(row.merge_run_id) || [];
    artifacts.push(mapArtifact(row));
    byMergeRunId.set(row.merge_run_id, artifacts);
  }

  return byMergeRunId;
}

export function getReviewsByTicketId(database, projectId, ticketIds) {
  const byTicketId = new Map();
  for (const ticketId of ticketIds) {
    byTicketId.set(ticketId, []);
  }
  if (ticketIds.length === 0) {
    return byTicketId;
  }

  const placeholders = ticketIds.map(() => "?").join(", ");
  const reviewRows = database
    .prepare(
      `select *
       from reviews
       where project_id = ? and ticket_id in (${placeholders})
       order by created_at desc`,
    )
    .all(projectId, ...ticketIds);

  const reviewIds = reviewRows.map((row) => row.id);
  const findingsByReviewId = getReviewFindingsByReviewId(database, reviewIds);
  const artifactsByReviewId = getArtifactsByReviewId(database, reviewIds);

  for (const row of reviewRows) {
    const reviews = byTicketId.get(row.ticket_id) || [];
    reviews.push({
      ...mapReview(row),
      artifacts: artifactsByReviewId.get(row.id) || [],
      findings: findingsByReviewId.get(row.id) || [],
    });
    byTicketId.set(row.ticket_id, reviews);
  }

  return byTicketId;
}

export function getReviewFindingsByReviewId(database, reviewIds) {
  const byReviewId = new Map();
  for (const reviewId of reviewIds) {
    byReviewId.set(reviewId, []);
  }
  if (reviewIds.length === 0) {
    return byReviewId;
  }

  const placeholders = reviewIds.map(() => "?").join(", ");
  const rows = database
    .prepare(
      `select *
       from review_findings
       where review_id in (${placeholders})
       order by created_at asc`,
    )
    .all(...reviewIds);

  for (const row of rows) {
    const findings = byReviewId.get(row.review_id) || [];
    findings.push({
      id: row.id,
      severity: row.severity,
      category: row.category,
      filePath: row.file_path,
      lineNumber: row.line_number ? Number(row.line_number) : null,
      title: row.title,
      detailsMd: row.details_md,
      createdAt: row.created_at,
    });
    byReviewId.set(row.review_id, findings);
  }

  return byReviewId;
}

export function getValidationRunsByTicketId(database, projectId, ticketIds) {
  const byTicketId = new Map();
  for (const ticketId of ticketIds) {
    byTicketId.set(ticketId, []);
  }
  if (ticketIds.length === 0) {
    return byTicketId;
  }

  const placeholders = ticketIds.map(() => "?").join(", ");
  const rows = database
    .prepare(
      `select
        vr.*,
        r.slug as repo_slug,
        r.name as repo_name
       from validation_runs vr
       join repos r on r.id = vr.repo_id
       where vr.project_id = ? and vr.ticket_id in (${placeholders})
       order by vr.started_at desc, r.slug asc`,
    )
    .all(projectId, ...ticketIds);

  const validationIds = rows.map((row) => row.id);
  const artifactsByValidationRunId = getArtifactsByValidationRunId(database, validationIds);

  for (const row of rows) {
    const validations = byTicketId.get(row.ticket_id) || [];
    validations.push({
      ...mapValidationRun(row),
      artifacts: artifactsByValidationRunId.get(row.id) || [],
    });
    byTicketId.set(row.ticket_id, validations);
  }

  return byTicketId;
}

export function getLatestMergeRunRow(database, projectId, ticketId) {
  return database
    .prepare(
      `select *
       from merge_runs
       where project_id = ? and ticket_id = ?
       order by started_at desc
       limit 1`,
    )
    .get(projectId, ticketId);
}

export function groupWorktreesByExecutionId(worktrees) {
  const byExecutionId = new Map();
  for (const worktree of worktrees) {
    const items = byExecutionId.get(worktree.executionId) || [];
    items.push(worktree);
    byExecutionId.set(worktree.executionId, items);
  }
  return byExecutionId;
}

export function buildBoardSummary(tickets) {
  const summary = {};
  for (const ticket of tickets) {
    const boardState = mapTicketStateToBoardState(ticket.state);
    summary[boardState] = (summary[boardState] || 0) + 1;
  }
  return summary;
}

export function buildMergeStatus(database, ticket, worktrees = []) {
  const policy = requiredProjectPolicy(database, ticket.projectId);
  const latestRun = getLatestMergeRunRow(database, ticket.projectId, ticket.id);
  const latestReview = getLatestReviewRow(database, ticket.projectId, ticket.id);
  const latestValidation = getLatestValidationRunRow(database, ticket.projectId, ticket.id);
  const latestRunArtifacts =
    latestRun ? getArtifactsByMergeRunId(database, [latestRun.id]).get(latestRun.id) || [] : [];
  const requiresHumanApproval =
    policy.interaction_mode === "fully_autonomous"
      ? false
      : readPolicyBoolean(
          policy,
          "requireHumanApprovalBeforeMerge",
          "require_human_approval_before_merge",
        );
  const mergePolicyBlocks = buildMergePolicyBlocks(policy, latestReview, latestValidation);
  const mergePolicyBlock = mergePolicyBlocks[0]?.message || "";
  const mergeable = ticket.state === "READY_TO_MERGE" && !mergePolicyBlock;
  const uncleanedWorktreeCount = worktrees.filter((worktree) => worktree.status !== "cleaned").length;
  const approval = {
    required: requiresHumanApproval,
    satisfied: !requiresHumanApproval,
    approvedByKind: latestRun?.approved_by_kind || "",
    approvedByRef: latestRun?.approved_by_ref || "",
  };

  if (approval.required && approval.approvedByKind && approval.approvedByRef) {
    approval.satisfied = true;
  }

  if (latestRun?.status === "completed" || ticket.state === "DONE") {
    return {
      projectId: ticket.projectId,
      ticketId: ticket.id,
      ticketKey: ticket.key,
      ticketTitle: ticket.title,
      ticketState: ticket.state,
      requiresHumanApproval,
      approval,
      canMerge: false,
      readiness: "closed",
      statusSummary: "Merge recorded and ticket closed.",
      blockingReasons: [],
      uncleanedWorktreeCount,
      latestRun: latestRun ? mergeRunDto({ ...mapMergeRun(latestRun), artifacts: latestRunArtifacts }) : null,
    };
  }

  if (latestRun?.status === "running" && !latestRun?.finished_at) {
    return {
      projectId: ticket.projectId,
      ticketId: ticket.id,
      ticketKey: ticket.key,
      ticketTitle: ticket.title,
      ticketState: ticket.state,
      requiresHumanApproval,
      approval,
      canMerge: false,
      readiness: "running",
      statusSummary: "Merge run in progress.",
      blockingReasons: [],
      uncleanedWorktreeCount,
      latestRun: latestRun ? mergeRunDto({ ...mapMergeRun(latestRun), artifacts: latestRunArtifacts }) : null,
    };
  }

  if (latestRun?.status === "blocked") {
    return {
      projectId: ticket.projectId,
      ticketId: ticket.id,
      ticketKey: ticket.key,
      ticketTitle: ticket.title,
      ticketState: ticket.state,
      requiresHumanApproval,
      approval,
      canMerge: mergeable,
      readiness: "blocked",
      statusSummary: latestRun.summary_md || "Latest merge attempt is blocked.",
      blockingReasons: [],
      uncleanedWorktreeCount,
      latestRun: mergeRunDto({ ...mapMergeRun(latestRun), artifacts: latestRunArtifacts }),
    };
  }

  if (latestRun?.status === "rework") {
    return {
      projectId: ticket.projectId,
      ticketId: ticket.id,
      ticketKey: ticket.key,
      ticketTitle: ticket.title,
      ticketState: ticket.state,
      requiresHumanApproval,
      approval,
      canMerge: mergeable,
      readiness: "rework",
      statusSummary: latestRun.summary_md || "Latest merge attempt requires rework.",
      blockingReasons: [],
      uncleanedWorktreeCount,
      latestRun: mergeRunDto({ ...mapMergeRun(latestRun), artifacts: latestRunArtifacts }),
    };
  }

  const blockingReasons = [];
  if (ticket.state !== "READY_TO_MERGE") {
    blockingReasons.push({
      code: "ticket_not_ready",
      source: "ticket",
      message: "Ticket must reach READY_TO_MERGE before merge can start.",
    });
  }
  blockingReasons.push(...mergePolicyBlocks);

  return {
    projectId: ticket.projectId,
    ticketId: ticket.id,
    ticketKey: ticket.key,
    ticketTitle: ticket.title,
    ticketState: ticket.state,
    requiresHumanApproval,
    approval,
    canMerge: mergeable,
    readiness: mergeable ? (requiresHumanApproval ? "approval_required" : "ready") : "waiting",
    statusSummary: mergeable
      ? requiresHumanApproval
        ? "Ready to merge after operator approval is recorded."
        : "Ready to merge."
      : mergePolicyBlock || "Ticket must reach READY_TO_MERGE before merge can start.",
    blockingReasons,
    uncleanedWorktreeCount,
    latestRun: latestRun ? mergeRunDto({ ...mapMergeRun(latestRun), artifacts: latestRunArtifacts }) : null,
  };
}

export function mapTicketStateToBoardState(ticketState) {
  if (ticketState === "DRAFT") return "PROPOSED";
  if (ticketState === "MERGING") return "READY_TO_MERGE";
  if (ticketState === "CANCELLED") return "DONE";
  return ticketState;
}

export function buildMergePolicyBlocks(policy, latestReview, latestValidation) {
  const requireReviewer = readPolicyBoolean(policy, "requireReviewer", "require_reviewer");
  const requireValidator = readPolicyBoolean(policy, "requireValidator", "require_validator");
  const requiredValidationCommandProfile = optionalPolicyText(
    policy.requiredValidationCommandProfileForMerge || policy.required_validation_command_profile_for_merge,
  );
  const blocks = [];

  if (requireReviewer && latestReview?.verdict !== "passed") {
    blocks.push({
      code: "review_required",
      source: "review",
      message: "Latest review must pass before merge",
    });
  }
  if (requireValidator && latestValidation?.verdict !== "passed") {
    blocks.push({
      code: "validation_required",
      source: "validation",
      message: "Latest validation must pass before merge",
    });
  }
  if (requiredValidationCommandProfile && latestValidation?.command_profile !== requiredValidationCommandProfile) {
    blocks.push({
      code: "validation_profile_required",
      source: "validation",
      message: `Latest validation must use ${requiredValidationCommandProfile} profile before merge`,
      requiredCommandProfile: requiredValidationCommandProfile,
      actualCommandProfile: latestValidation?.command_profile || "",
    });
  }

  return blocks;
}

function requiredProjectPolicy(database, projectId) {
  const policy = database.prepare("select * from project_policies where project_id = ?").get(projectId);
  if (!policy) {
    throw new Error(`Missing project policy for ${projectId}`);
  }
  return policy;
}

function readPolicyBoolean(policy, mappedKey, rawKey) {
  if (Object.prototype.hasOwnProperty.call(policy, mappedKey)) {
    return Boolean(policy[mappedKey]);
  }
  return Boolean(policy[rawKey]);
}

function optionalPolicyText(value, fallback = "") {
  if (typeof value !== "string") {
    return fallback;
  }
  return value.trim() || fallback;
}

export function listProjectEvents(database, projectId, filters = {}) {
  const clauses = ["e.project_id = ?"];
  const params = [projectId];

  if (filters.ticketId) {
    clauses.push("e.ticket_id = ?");
    params.push(filters.ticketId);
  }

  if (filters.repoId) {
    clauses.push("e.repo_id = ?");
    params.push(filters.repoId);
  }

  if (filters.type) {
    clauses.push("e.type = ?");
    params.push(filters.type);
  }

  const order = filters.order === "desc" ? "desc" : "asc";
  const limit = Number.isInteger(filters.limit) && filters.limit > 0 ? ` limit ${filters.limit}` : "";

  return database
    .prepare(
      `select
         e.*,
         e.rowid as event_sequence,
         r.slug as repo_slug,
         r.name as repo_name,
         t.key as ticket_key,
         t.title as ticket_title
       from events e
       left join repos r on r.project_id = e.project_id and r.id = e.repo_id
       left join tickets t on t.project_id = e.project_id and t.id = e.ticket_id
       where ${clauses.join(" and ")}
       order by e.created_at ${order}, e.rowid ${order}${limit}`,
    )
    .all(...params)
    .map((row) => eventDto(mapEvent(row)));
}

export function listProjectArtifacts(database, projectId, filters = {}) {
  const clauses = ["a.project_id = ?"];
  const params = [projectId];

  for (const [field, column] of [
    ["ticketId", "a.ticket_id"],
    ["executionId", "a.execution_id"],
    ["reviewId", "a.review_id"],
    ["validationRunId", "a.validation_run_id"],
    ["mergeRunId", "a.merge_run_id"],
    ["kind", "a.kind"],
  ]) {
    if (filters[field]) {
      clauses.push(`${column} = ?`);
      params.push(filters[field]);
    }
  }

  const limit = Number.isInteger(filters.limit) && filters.limit > 0 ? ` limit ${filters.limit}` : "";

  return database
    .prepare(
      `select
         a.*,
         t.key as ticket_key,
         t.title as ticket_title
       from artifacts a
       left join tickets t on t.project_id = a.project_id and t.id = a.ticket_id
       where ${clauses.join(" and ")}
       order by a.created_at desc, a.rowid desc${limit}`,
    )
    .all(...params)
    .map((row) => artifactDto(mapArtifact(row)));
}

function mapEvent(row) {
  const family = String(row.type || "").split(".", 1)[0] || "";
  return {
    id: row.id,
    sequence: Number(row.event_sequence || 0),
    cursor: row.created_at ? `${row.created_at}:${Number(row.event_sequence || 0)}` : row.id,
    projectId: row.project_id,
    repoId: row.repo_id,
    repoSlug: row.repo_slug,
    repoName: row.repo_name,
    ticketId: row.ticket_id,
    ticketKey: row.ticket_key,
    ticketTitle: row.ticket_title,
    type: row.type,
    lane: deriveEventLane(family),
    summary: row.summary,
    detail: row.detail,
    reasonCode: row.reason_code || "",
    reasonSource: row.reason_source || "",
    createdAt: row.created_at,
  };
}

function deriveEventLane(family) {
  switch (family) {
    case "execution":
      return "execution";
    case "review":
      return "review";
    case "validation":
      return "validation";
    case "merge":
      return "merge";
    case "worktree":
      return "worktree";
    case "ticket":
      return "ticket";
    case "dependency":
      return "dependency";
    case "repo":
      return "repo";
    case "project":
      return "project";
    case "agent":
      return "agent";
    default:
      return "system";
  }
}
