export function mapArtifact(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    ticketId: row.ticket_id,
    ticketKey: row.ticket_key,
    ticketTitle: row.ticket_title,
    executionId: row.execution_id,
    reviewId: row.review_id,
    validationRunId: row.validation_run_id,
    mergeRunId: row.merge_run_id,
    kind: row.kind,
    label: row.label,
    uri: row.uri,
    metadata: JSON.parse(row.metadata_json),
    createdAt: row.created_at,
  };
}

export function mapAgentMessage(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    actor: row.actor,
    source: row.source,
    intent: row.intent,
    target: JSON.parse(row.target_json || "{}"),
    summary: row.summary,
    body: row.body || "",
    metadata: JSON.parse(row.metadata_json || "{}"),
    status: row.status,
    promotedKind: row.promoted_kind || "",
    promotedRef: row.promoted_ref || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    dismissedAt: row.dismissed_at || "",
  };
}

export function mapExecution(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    ticketId: row.ticket_id,
    agentProfileId: row.agent_profile_id,
    role: row.role,
    iteration: Number(row.iteration),
    status: row.status,
    outcome: row.outcome,
    summaryMd: row.summary_md,
    remainingWorkMd: row.remaining_work_md,
    expectedNextEvidenceMd: row.expected_next_evidence_md,
    failureKind: row.failure_kind,
    blockedKind: row.blocked_kind,
    claimToken: row.claim_token || "",
    claimExpiresAt: row.claim_expires_at || "",
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export function mapReview(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    ticketId: row.ticket_id,
    executionId: row.execution_id,
    reviewerProfileId: row.reviewer_profile_id,
    verdict: row.verdict,
    summaryMd: row.summary_md,
    findingsCount: Number(row.findings_count),
    blockedKind: row.blocked_kind,
    createdAt: row.created_at,
  };
}

export function mapValidationRun(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    ticketId: row.ticket_id,
    repoId: row.repo_id,
    repoSlug: row.repo_slug,
    repoName: row.repo_name,
    executionId: row.execution_id,
    status: row.status,
    verdict: row.verdict,
    commandProfile: row.command_profile,
    commands: JSON.parse(row.commands_json),
    summaryMd: row.summary_md,
    blockedKind: row.blocked_kind,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export function mapMergeRun(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    ticketId: row.ticket_id,
    status: row.status,
    strategy: row.strategy,
    approvedByKind: row.approved_by_kind,
    approvedByRef: row.approved_by_ref,
    summaryMd: row.summary_md,
    failureKind: row.failure_kind || "",
    claimToken: row.claim_token || "",
    claimExpiresAt: row.claim_expires_at || "",
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export function mapWorktree(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    repoId: row.repo_id,
    ticketId: row.ticket_id,
    executionId: row.execution_id,
    repoSlug: row.repo_slug,
    repoName: row.repo_name,
    executionRole: row.execution_role,
    executionIteration: Number(row.execution_iteration),
    path: row.path,
    branchName: row.branch_name,
    baseRef: row.base_ref,
    status: row.status,
    isDirty: Boolean(row.is_dirty),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    cleanedAt: row.cleaned_at,
  };
}
