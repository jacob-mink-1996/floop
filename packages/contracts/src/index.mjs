import {
  isCeremonyType,
  isDependencyType,
  isAgentMessageIntent,
  isAgentMessageStatus,
  isInteractionMode,
  isRefinementMode,
  isRoleName,
  isExecutionOutcome,
  isMergeStatus,
  isReviewFindingSeverity,
  isReviewVerdict,
  isTicketPriority,
  isTicketState,
  isValidationVerdict,
} from "../../domain/src/index.mjs";

export function eventDto(event) {
  const [family = "", action = ""] = String(event.type || "").split(".", 2);
  return {
    id: event.id,
    sequence: Number.isInteger(event.sequence) ? event.sequence : 0,
    cursor: event.cursor || buildEventCursor(event),
    projectId: event.projectId,
    repoId: event.repoId,
    repoSlug: event.repoSlug || "",
    repoName: event.repoName || "",
    ticketId: event.ticketId,
    ticketKey: event.ticketKey || "",
    ticketTitle: event.ticketTitle || "",
    type: event.type,
    family,
    action,
    lane: event.lane || deriveEventLane(family),
    summary: event.summary,
    detail: event.detail,
    reasonCode: event.reasonCode || "",
    reasonSource: event.reasonSource || "",
    createdAt: event.createdAt,
  };
}

function buildEventCursor(event) {
  if (!event?.createdAt) {
    return event?.id || "";
  }
  const sequence = Number.isInteger(event.sequence) ? event.sequence : 0;
  return `${event.createdAt}:${sequence}`;
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

export function ticketDependencyDto(dependency) {
  return {
    id: dependency.id,
    projectId: dependency.projectId,
    blockedTicketId: dependency.blockedTicketId,
    blockingTicketId: dependency.blockingTicketId,
    blockingTicketKey: dependency.blockingTicketKey,
    blockingTicketTitle: dependency.blockingTicketTitle,
    blockingTicketState: dependency.blockingTicketState,
    dependencyType: dependency.dependencyType,
    createdAt: dependency.createdAt,
  };
}

export function executionDto(execution) {
  return {
    id: execution.id,
    projectId: execution.projectId,
    ticketId: execution.ticketId,
    ticketKey: execution.ticketKey || "",
    ticketTitle: execution.ticketTitle || "",
    ticketState: execution.ticketState || "",
    agentProfileId: execution.agentProfileId,
    role: execution.role,
    iteration: execution.iteration,
    status: execution.status,
    outcome: execution.outcome,
    summaryMd: execution.summaryMd,
    remainingWorkMd: execution.remainingWorkMd,
    expectedNextEvidenceMd: execution.expectedNextEvidenceMd,
    failureKind: execution.failureKind,
    blockedKind: execution.blockedKind,
    claimed: Boolean(execution.claimToken),
    claimExpiresAt: execution.claimExpiresAt || "",
    startedAt: execution.startedAt,
    finishedAt: execution.finishedAt,
    artifacts: (execution.artifacts || []).map(artifactDto),
    worktrees: (execution.worktrees || []).map(worktreeDto),
  };
}

export function artifactDto(artifact) {
  return {
    id: artifact.id,
    projectId: artifact.projectId,
    ticketId: artifact.ticketId,
    ticketKey: artifact.ticketKey || "",
    ticketTitle: artifact.ticketTitle || "",
    executionId: artifact.executionId || "",
    reviewId: artifact.reviewId || "",
    validationRunId: artifact.validationRunId || "",
    mergeRunId: artifact.mergeRunId || "",
    kind: artifact.kind,
    label: artifact.label,
    uri: artifact.uri,
    metadata: { ...(artifact.metadata || {}) },
    createdAt: artifact.createdAt,
  };
}

export function worktreeDto(worktree) {
  return {
    id: worktree.id,
    projectId: worktree.projectId,
    repoId: worktree.repoId,
    ticketId: worktree.ticketId,
    executionId: worktree.executionId,
    repoSlug: worktree.repoSlug,
    repoName: worktree.repoName,
    executionRole: worktree.executionRole,
    executionIteration: worktree.executionIteration,
    path: worktree.path,
    branchName: worktree.branchName,
    baseRef: worktree.baseRef,
    status: worktree.status,
    isDirty: worktree.isDirty,
    createdAt: worktree.createdAt,
    updatedAt: worktree.updatedAt,
    cleanedAt: worktree.cleanedAt,
  };
}

export function reviewDto(review) {
  return {
    id: review.id,
    projectId: review.projectId,
    ticketId: review.ticketId,
    executionId: review.executionId,
    reviewerProfileId: review.reviewerProfileId,
    verdict: review.verdict,
    summaryMd: review.summaryMd,
    findingsCount: review.findingsCount,
    createdAt: review.createdAt,
    artifacts: (review.artifacts || []).map(artifactDto),
    findings: (review.findings || []).map((finding) => ({ ...finding })),
  };
}

export function mergeRunDto(mergeRun) {
  return {
    id: mergeRun.id,
    projectId: mergeRun.projectId,
    ticketId: mergeRun.ticketId,
    status: mergeRun.status,
    strategy: mergeRun.strategy,
    approvedByKind: mergeRun.approvedByKind,
    approvedByRef: mergeRun.approvedByRef,
    summaryMd: mergeRun.summaryMd,
    failureKind: mergeRun.failureKind || "",
    claimed: Boolean(mergeRun.claimToken),
    claimExpiresAt: mergeRun.claimExpiresAt || "",
    startedAt: mergeRun.startedAt,
    finishedAt: mergeRun.finishedAt,
    artifacts: (mergeRun.artifacts || []).map(artifactDto),
  };
}

export function validationRunDto(validation) {
  return {
    id: validation.id,
    projectId: validation.projectId,
    ticketId: validation.ticketId,
    repoId: validation.repoId,
    repoSlug: validation.repoSlug,
    repoName: validation.repoName,
    executionId: validation.executionId,
    status: validation.status,
    verdict: validation.verdict,
    commandProfile: validation.commandProfile,
    commands: [...(validation.commands || [])],
    summaryMd: validation.summaryMd,
    startedAt: validation.startedAt,
    finishedAt: validation.finishedAt,
    artifacts: (validation.artifacts || []).map(artifactDto),
  };
}

export function ceremonyProposalDto(proposal) {
  return {
    id: proposal.id,
    projectId: proposal.projectId,
    runId: proposal.runId,
    kind: proposal.kind,
    status: proposal.status,
    summary: proposal.summary,
    ticketId: proposal.ticketId || "",
    ticketKey: proposal.ticketKey || "",
    ticketTitle: proposal.ticketTitle || "",
    payload: { ...(proposal.payload || {}) },
    appliedTicketId: proposal.appliedTicketId || "",
    appliedAt: proposal.appliedAt || "",
    createdAt: proposal.createdAt,
  };
}

export function ceremonyParticipantDto(participant) {
  return {
    id: participant.id,
    projectId: participant.projectId,
    runId: participant.runId,
    role: participant.role,
    status: participant.status,
    outcome: participant.outcome || "",
    summaryMd: participant.summaryMd || "",
    questionsMd: participant.questionsMd || "",
    riskMd: participant.riskMd || "",
    payload: { ...(participant.payload || {}) },
    startedAt: participant.startedAt || "",
    finishedAt: participant.finishedAt || "",
    createdAt: participant.createdAt,
    updatedAt: participant.updatedAt,
  };
}

export function ceremonyRunDto(run, proposals = [], participants = []) {
  const scope = { ...(run.scope || {}) };
  return {
    id: run.id,
    projectId: run.projectId,
    type: run.type,
    status: run.status,
    scope,
    participantRoles: Array.isArray(scope.participantRoles) ? scope.participantRoles : [],
    deciderRole: typeof scope.deciderRole === "string" ? scope.deciderRole : "",
    consensusPolicy: typeof scope.consensusPolicy === "string" ? scope.consensusPolicy : "",
    inputSnapshot: { ...(run.inputSnapshot || {}) },
    summaryMd: run.summaryMd,
    questionsMd: run.questionsMd,
    riskMd: run.riskMd,
    createdByKind: run.createdByKind,
    createdByRef: run.createdByRef,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt || "",
    appliedAt: run.appliedAt || "",
    proposals: proposals.map(ceremonyProposalDto),
    participants: participants.map(ceremonyParticipantDto),
  };
}

export function agentMessageDto(message) {
  return {
    id: message.id,
    projectId: message.projectId,
    actor: message.actor,
    source: message.source,
    intent: message.intent,
    target: { ...(message.target || {}) },
    summary: message.summary,
    body: message.body || "",
    metadata: { ...(message.metadata || {}) },
    status: message.status,
    promotedKind: message.promotedKind || "",
    promotedRef: message.promotedRef || "",
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    dismissedAt: message.dismissedAt || "",
  };
}

export function boardTicketDto(ticket) {
  return {
    id: ticket.id,
    key: ticket.key,
    title: ticket.title,
    state: ticket.state,
    priority: ticket.priority,
    assignedRole: ticket.assignedRole,
    latestSummary: ticket.latestSummary,
    latestReviewVerdict: ticket.latestReviewVerdict || "",
    latestValidationVerdict: ticket.latestValidationVerdict || "",
    updatedAt: ticket.updatedAt,
  };
}

export function mergeQueueItemDto(ticket, mergeStatus) {
  return {
    id: ticket.id,
    projectId: ticket.projectId,
    key: ticket.key,
    title: ticket.title,
    state: ticket.state,
    priority: ticket.priority,
    assignedRole: ticket.assignedRole,
    latestSummary: ticket.latestSummary,
    updatedAt: ticket.updatedAt,
    mergeStatus: mergeStatus ? { ...mergeStatus } : null,
  };
}

export function ticketSummaryDto(ticket, options = {}) {
  return {
    id: ticket.id,
    projectId: ticket.projectId,
    parentTicketId: ticket.parentTicketId,
    key: ticket.key,
    title: ticket.title,
    brief: ticket.brief,
    state: ticket.state,
    priority: ticket.priority,
    assignedRole: ticket.assignedRole,
    latestSummary: ticket.latestSummary,
    latestReviewVerdict: options.latestReviewVerdict || "",
    latestValidationVerdict: options.latestValidationVerdict || "",
    repoCount: (options.repoTargets || []).length,
    dependencyCount: options.dependencyCount || 0,
    eventCount: options.eventCount || 0,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
  };
}

export function repoDto(repo) {
  return {
    id: repo.id,
    projectId: repo.projectId,
    slug: repo.slug,
    name: repo.name,
    localPath: repo.localPath,
    remoteUrl: repo.remoteUrl,
    defaultBranch: repo.defaultBranch,
    isPrimary: repo.isPrimary,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
  };
}

export function boardDto(projectId, tickets) {
  const lanes = {};
  for (const ticket of tickets) {
    if (!lanes[ticket.state]) {
      lanes[ticket.state] = {
        count: 0,
        tickets: [],
      };
    }
    lanes[ticket.state].count += 1;
    lanes[ticket.state].tickets.push(boardTicketDto(ticket));
  }

  return {
    projectId,
    lanes,
    totalTickets: tickets.length,
  };
}

export function ticketDetailDto(ticket, options = {}) {
  return {
    acceptanceCriteriaMd: ticket.acceptanceCriteriaMd,
    definitionOfDoneMd: ticket.definitionOfDoneMd,
    ...ticketSummaryDto(ticket, options),
    executions: (options.executions || []).map(executionDto),
    reviews: (options.reviews || []).map(reviewDto),
    validations: (options.validations || []).map(validationRunDto),
    dependencies: (options.dependencies || []).map(ticketDependencyDto),
    worktrees: (options.worktrees || []).map(worktreeDto),
    artifacts: (options.artifacts || []).map(artifactDto),
    mergeStatus: options.mergeStatus ? { ...options.mergeStatus } : null,
    repoTargets: (options.repoTargets || []).map((target) => ({
      id: target.id,
      repoId: target.repoId,
      repoSlug: target.repoSlug,
      repoName: target.repoName,
      repoLocalPath: target.repoLocalPath,
      repoDefaultBranch: target.repoDefaultBranch,
      baseRef: target.baseRef,
      branchName: target.branchName,
      targetScopeMd: target.targetScopeMd,
    })),
    events: (options.events || []).map(eventDto),
  };
}

export const ticketDto = ticketDetailDto;

export function projectSummaryDto(project, repoCount, ticketCount, board) {
  return {
    id: project.id,
    slug: project.slug,
    name: project.name,
    description: project.description,
    workspaceRoot: project.workspaceRoot,
    defaultBaseBranch: project.defaultBaseBranch,
    policy: { ...project.policy },
    roleProfiles: project.roleProfiles.map((profile) => ({ ...profile })),
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    repoCount,
    ticketCount,
    board: { ...board },
  };
}

export function projectBoardDto(project, columns, metadata = {}) {
  return {
    projectId: project.id,
    projectSlug: project.slug,
    projectName: project.name,
    totalTickets: metadata.totalTickets || 0,
    generatedAt: metadata.generatedAt || null,
    columns: columns.map((column) => ({
      state: column.state,
      count: column.tickets.length,
      tickets: column.tickets.map((ticket) => ({ ...ticket })),
    })),
  };
}

export function parseCreateProjectInput(body) {
  assertObject(body);
  return {
    name: requiredString(body, "name"),
    slug: requiredString(body, "slug"),
    workspaceRoot: requiredString(body, "workspaceRoot"),
    description: optionalString(body, "description"),
    defaultBaseBranch: optionalString(body, "defaultBaseBranch"),
  };
}

export function parseUpdateProjectInput(body) {
  assertObject(body);
  return compactObject({
    name: optionalPatchedString(body, "name", { required: true }),
    description: optionalPatchedString(body, "description"),
    workspaceRoot: optionalPatchedString(body, "workspaceRoot", { required: true }),
    defaultBaseBranch: optionalPatchedString(body, "defaultBaseBranch", { required: true }),
  });
}

export function parseUpdateProjectPolicyInput(body) {
  assertObject(body);
  const parsed = compactObject({
    requireReviewer: optionalBoolean(body, "requireReviewer"),
    requireValidator: optionalBoolean(body, "requireValidator"),
    requireHumanApprovalBeforeMerge: optionalBoolean(body, "requireHumanApprovalBeforeMerge"),
    requireDemoEvidenceBeforeMerge: optionalBoolean(body, "requireDemoEvidenceBeforeMerge"),
    requiredValidationCommandProfileForMerge: optionalPatchedString(body, "requiredValidationCommandProfileForMerge"),
  });

  if (hasOwn(body, "refinementMode")) {
    const refinementMode = requiredString(body, "refinementMode");
    if (!isRefinementMode(refinementMode)) {
      throw new Error(`Invalid refinement mode: ${refinementMode}`);
    }
    parsed.refinementMode = refinementMode;
  }

  if (hasOwn(body, "interactionMode")) {
    const interactionMode = requiredString(body, "interactionMode");
    if (!isInteractionMode(interactionMode)) {
      throw new Error(`Invalid interaction mode: ${interactionMode}`);
    }
    parsed.interactionMode = interactionMode;
  }

  if (hasOwn(body, "maxParallelExecutions")) {
    parsed.maxParallelExecutions = requiredPositiveInteger(body, "maxParallelExecutions");
  }

  if (hasOwn(body, "maxParallelMerges")) {
    parsed.maxParallelMerges = requiredPositiveInteger(body, "maxParallelMerges");
  }

  if (hasOwn(body, "maxAutoContinueIterations")) {
    parsed.maxAutoContinueIterations = requiredPositiveInteger(body, "maxAutoContinueIterations");
  }

  if (hasOwn(body, "agentCreatedTicketDefaultState")) {
    const agentCreatedTicketDefaultState = requiredString(body, "agentCreatedTicketDefaultState");
    if (!isTicketState(agentCreatedTicketDefaultState)) {
      throw new Error(`Invalid ticket state: ${agentCreatedTicketDefaultState}`);
    }
    parsed.agentCreatedTicketDefaultState = agentCreatedTicketDefaultState;
  }

  if (hasOwn(body, "ceremonyAutomation")) {
    parsed.ceremonyAutomation = parseCeremonyAutomation(body.ceremonyAutomation);
  }

  return parsed;
}

export function parseCreateAgentMessageInput(body) {
  assertObject(body);
  const intent = requiredString(body, "intent");
  if (!isAgentMessageIntent(intent)) {
    throw new Error(`Invalid agent message intent: ${intent}`);
  }

  return {
    actor: requiredString(body, "actor"),
    source: requiredString(body, "source"),
    intent,
    target: hasOwn(body, "target") ? optionalObject(body, "target") : {},
    summary: requiredString(body, "summary"),
    body: optionalString(body, "body"),
    metadata: hasOwn(body, "metadata") ? optionalObject(body, "metadata") : {},
  };
}

export function parseUpdateAgentMessageInput(body) {
  assertObject(body);
  const status = requiredString(body, "status");
  if (!isAgentMessageStatus(status)) {
    throw new Error(`Invalid agent message status: ${status}`);
  }
  return compactObject({
    status,
    promotedKind: optionalPatchedString(body, "promotedKind"),
    promotedRef: optionalPatchedString(body, "promotedRef"),
  });
}

export function parseRespondAgentMessageInput(body) {
  assertObject(body);
  return compactObject({
    responseMd: requiredString(body, "responseMd"),
    responderKind: optionalPatchedString(body, "responderKind"),
    responderRef: optionalPatchedString(body, "responderRef"),
    continueExecution: hasOwn(body, "continueExecution") ? optionalBoolean(body, "continueExecution") : true,
  });
}

export function parseUpdateRoleProfileInput(body) {
  assertObject(body);
  const parsed = compactObject({
    adapter: optionalPatchedString(body, "adapter", { required: true }),
    model: optionalPatchedString(body, "model", { required: true }),
  });

  if (hasOwn(body, "config")) {
    parsed.config = optionalObject(body, "config");
  }

  return parsed;
}

export function parseCreateRepoInput(body) {
  assertObject(body);
  return compactObject({
    name: requiredString(body, "name"),
    slug: requiredString(body, "slug"),
    localPath: requiredString(body, "localPath"),
    remoteUrl: optionalString(body, "remoteUrl"),
    defaultBranch: optionalString(body, "defaultBranch"),
    isPrimary: optionalBoolean(body, "isPrimary"),
  });
}

export function parseUpdateRepoInput(body) {
  assertObject(body);
  return compactObject({
    name: optionalPatchedString(body, "name", { required: true }),
    localPath: optionalPatchedString(body, "localPath", { required: true }),
    remoteUrl: optionalPatchedString(body, "remoteUrl"),
    defaultBranch: optionalPatchedString(body, "defaultBranch", { required: true }),
    isPrimary: optionalBoolean(body, "isPrimary"),
  });
}

export function parseCreateTicketInput(body) {
  assertObject(body);
  const state = optionalString(body, "state", "PROPOSED");
  if (state && !isTicketState(state)) {
    throw new Error(`Invalid ticket state: ${state}`);
  }

  const priority = optionalString(body, "priority", "medium");
  if (priority && !isTicketPriority(priority)) {
    throw new Error(`Invalid ticket priority: ${priority}`);
  }

  const assignedRole = optionalString(body, "assignedRole", "developer");
  if (assignedRole && !isRoleName(assignedRole)) {
    throw new Error(`Invalid assigned role: ${assignedRole}`);
  }

  return compactObject({
    title: requiredString(body, "title"),
    brief: requiredString(body, "brief"),
    acceptanceCriteriaMd: optionalString(body, "acceptanceCriteriaMd"),
    definitionOfDoneMd: optionalString(body, "definitionOfDoneMd"),
    latestSummary: optionalString(body, "latestSummary"),
    parentTicketId: optionalString(body, "parentTicketId"),
    state,
    priority,
    assignedRole,
    repoTargets: parseRepoTargets(body.repoTargets),
  });
}

export function parseUpdateTicketInput(body) {
  assertObject(body);
  const parsed = compactObject({
    title: optionalPatchedString(body, "title", { required: true }),
    brief: optionalPatchedString(body, "brief", { required: true }),
    acceptanceCriteriaMd: optionalPatchedString(body, "acceptanceCriteriaMd"),
    definitionOfDoneMd: optionalPatchedString(body, "definitionOfDoneMd"),
    latestSummary: optionalPatchedString(body, "latestSummary"),
  });

  if (hasOwn(body, "parentTicketId")) {
    parsed.parentTicketId = optionalNullablePatchedString(body, "parentTicketId");
  }

  if (hasOwn(body, "priority")) {
    const priority = requiredString(body, "priority");
    if (!isTicketPriority(priority)) {
      throw new Error(`Invalid ticket priority: ${priority}`);
    }
    parsed.priority = priority;
  }

  if (hasOwn(body, "assignedRole")) {
    const assignedRole = requiredString(body, "assignedRole");
    if (!isRoleName(assignedRole)) {
      throw new Error(`Invalid assigned role: ${assignedRole}`);
    }
    parsed.assignedRole = assignedRole;
  }

  if (hasOwn(body, "repoTargets")) {
    parsed.repoTargets = parseRepoTargets(body.repoTargets);
  }

  return parsed;
}

export function parseTicketTransitionInput(body) {
  assertObject(body);
  const targetState = requiredString(body, "targetState");
  if (!isTicketState(targetState)) {
    throw new Error(`Invalid ticket state: ${targetState}`);
  }

  return compactObject({
    targetState,
    reason: optionalString(body, "reason"),
    reasonCode: requiredString(body, "reasonCode"),
  });
}

export function parseAddDependencyInput(body) {
  assertObject(body);
  const dependencyType = optionalString(body, "dependencyType", "finish_to_start");
  if (dependencyType && !isDependencyType(dependencyType)) {
    throw new Error(`Invalid dependency type: ${dependencyType}`);
  }

  return {
    blockingTicketId: requiredString(body, "blockingTicketId"),
    dependencyType,
  };
}

export function parseCreateExecutionInput(body) {
  assertObject(body);

  const role = requiredString(body, "role");
  if (!isRoleName(role)) {
    throw new Error(`Invalid assigned role: ${role}`);
  }

  const parsed = compactObject({
    role,
    agentProfileId: optionalString(body, "agentProfileId"),
    reason: optionalString(body, "reason"),
  });

  if (hasOwn(body, "iteration")) {
    if (!Number.isInteger(body.iteration) || body.iteration <= 0) {
      throw new Error("Field iteration must be a positive integer");
    }
    parsed.iteration = body.iteration;
  }

  return parsed;
}

export function parseContinueExecutionInput(body) {
  assertObject(body);
  return {
    reason: requiredString(body, "reason"),
  };
}

export function parseCompleteExecutionInput(body) {
  assertObject(body);

  const outcome = requiredString(body, "outcome");
  if (!isExecutionOutcome(outcome)) {
    throw new Error(`Invalid execution outcome: ${outcome}`);
  }

  return compactObject({
    outcome,
    summaryMd: optionalOptionalString(body, "summaryMd"),
    remainingWorkMd: optionalOptionalString(body, "remainingWorkMd"),
    expectedNextEvidenceMd: optionalOptionalString(body, "expectedNextEvidenceMd"),
    failureKind: optionalOptionalString(body, "failureKind"),
    blockedKind: optionalOptionalString(body, "blockedKind"),
    artifacts: parseArtifacts(body.artifacts),
    review: parseEmbeddedReviewResult(body.review),
    validation: parseEmbeddedValidationResult(body.validation),
    followupTickets: parseFollowupTickets(body.followupTickets),
  });
}

export function parseCreateReviewInput(body) {
  assertObject(body);

  const verdict = requiredString(body, "verdict");
  if (!isReviewVerdict(verdict)) {
    throw new Error(`Invalid review verdict: ${verdict}`);
  }

  return compactObject({
    executionId: requiredString(body, "executionId"),
    reviewerProfileId: optionalOptionalString(body, "reviewerProfileId"),
    verdict,
    summaryMd: optionalOptionalString(body, "summaryMd"),
    blockedKind: optionalOptionalString(body, "blockedKind"),
    artifacts: parseArtifacts(body.artifacts),
    findings: parseReviewFindings(body.findings),
  });
}

export function parseCreateValidationInput(body) {
  assertObject(body);

  const verdict = requiredString(body, "verdict");
  if (!isValidationVerdict(verdict)) {
    throw new Error(`Invalid validation verdict: ${verdict}`);
  }

  return compactObject({
    executionId: optionalOptionalString(body, "executionId"),
    commandProfile: optionalOptionalString(body, "commandProfile"),
    verdict,
    summaryMd: optionalOptionalString(body, "summaryMd"),
    blockedKind: optionalOptionalString(body, "blockedKind"),
    artifacts: parseArtifacts(body.artifacts),
    commands: parseCommands(body.commands),
    repoIds: parseRepoIds(body.repoIds),
  });
}

export function parseMergeTicketInput(body) {
  assertObject(body);

  const parsed = compactObject({
    strategy: requiredString(body, "strategy"),
    approvedByKind: optionalOptionalString(body, "approvedByKind"),
    approvedByRef: optionalOptionalString(body, "approvedByRef"),
    summaryMd: optionalOptionalString(body, "summaryMd"),
    artifacts: parseArtifacts(body.artifacts),
  });

  if (hasOwn(body, "status")) {
    const status = requiredString(body, "status");
    if (!isMergeStatus(status)) {
      throw new Error(`Invalid merge status: ${status}`);
    }
    parsed.status = status;
  }

  if (Boolean(parsed.approvedByKind) !== Boolean(parsed.approvedByRef)) {
    throw new Error("approvedByKind and approvedByRef must be provided together");
  }

  return parsed;
}

export function parseCreateCeremonyRunInput(body) {
  assertObject(body);
  const type = requiredString(body, "type");
  if (!isCeremonyType(type)) {
    throw new Error(`Invalid ceremony type: ${type}`);
  }
  const participantRoles = parseCeremonyParticipantRoles(body.participantRoles);
  const deciderRole = optionalString(body, "deciderRole", "");
  if (deciderRole && !isRoleName(deciderRole)) {
    throw new Error(`Invalid ceremony decider role: ${deciderRole}`);
  }

  return compactObject({
    type,
    scope: hasOwn(body, "scope") ? optionalObject(body, "scope") : {},
    participantRoles,
    deciderRole,
    consensusPolicy: optionalString(body, "consensusPolicy", ""),
    createdByKind: optionalString(body, "createdByKind", "human"),
    createdByRef: optionalString(body, "createdByRef", "operator"),
  });
}

export function parseApplyCeremonyRunInput(body) {
  assertObject(body || {});
  const proposalIds = body?.proposalIds;
  if (proposalIds === undefined) {
    return { proposalIds: [] };
  }
  if (!Array.isArray(proposalIds)) {
    throw new Error("Field proposalIds must be an array");
  }
  return {
    proposalIds: proposalIds.map((proposalId, index) => {
      if (typeof proposalId !== "string" || !proposalId.trim()) {
        throw new Error(`Field proposalIds[${index}] must be a non-empty string`);
      }
      return proposalId.trim();
    }),
  };
}

function parseRepoTargets(value) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("Field repoTargets must be an array");
  }

  return value.map((target, index) => {
    assertObject(target, `repoTargets[${index}]`);
    return compactObject({
      repoId: requiredFieldString(target, "repoId", `repoTargets[${index}].repoId`),
      baseRef: optionalString(target, "baseRef"),
      branchName: optionalString(target, "branchName"),
      targetScopeMd: optionalString(target, "targetScopeMd"),
    });
  });
}

function parseFollowupTickets(value) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("Field followupTickets must be an array");
  }

  return value.map((ticket, index) => {
    assertObject(ticket, `followupTickets[${index}]`);
    const state = optionalNestedString(ticket, "state");
    if (state && !isTicketState(state)) {
      throw new Error(`Invalid ticket state: ${state}`);
    }

    const priority = optionalNestedString(ticket, "priority");
    if (priority && !isTicketPriority(priority)) {
      throw new Error(`Invalid ticket priority: ${priority}`);
    }

    const assignedRole = optionalNestedString(ticket, "assignedRole");
    if (assignedRole && !isRoleName(assignedRole)) {
      throw new Error(`Invalid assigned role: ${assignedRole}`);
    }

    return compactObject({
      title: requiredFieldString(ticket, "title", `followupTickets[${index}].title`),
      brief: requiredFieldString(ticket, "brief", `followupTickets[${index}].brief`),
      acceptanceCriteriaMd: optionalNestedString(ticket, "acceptanceCriteriaMd"),
      definitionOfDoneMd: optionalNestedString(ticket, "definitionOfDoneMd"),
      latestSummary: optionalNestedString(ticket, "latestSummary"),
      state,
      priority,
      assignedRole,
      repoTargets: parseRepoTargets(ticket.repoTargets),
    });
  });
}

function parseEmbeddedReviewResult(value) {
  if (value === undefined) {
    return undefined;
  }
  assertObject(value, "review");

  const verdict = requiredFieldString(value, "verdict", "review.verdict");
  if (!isReviewVerdict(verdict)) {
    throw new Error(`Invalid review verdict: ${verdict}`);
  }

  return compactObject({
    verdict,
    summaryMd: optionalNestedString(value, "summaryMd"),
    blockedKind: optionalNestedString(value, "blockedKind"),
    artifacts: value.artifacts === undefined ? undefined : parseArtifacts(value.artifacts),
    findings: value.findings === undefined ? undefined : parseEmbeddedReviewFindings(value.findings),
  });
}

function parseEmbeddedValidationResult(value) {
  if (value === undefined) {
    return undefined;
  }
  assertObject(value, "validation");

  const verdict = requiredFieldString(value, "verdict", "validation.verdict");
  if (!isValidationVerdict(verdict)) {
    throw new Error(`Invalid validation verdict: ${verdict}`);
  }

  return compactObject({
    verdict,
    summaryMd: optionalNestedString(value, "summaryMd"),
    blockedKind: optionalNestedString(value, "blockedKind"),
    artifacts: value.artifacts === undefined ? undefined : parseArtifacts(value.artifacts),
    commands: value.commands === undefined ? undefined : parseCommands(value.commands),
    repoIds: value.repoIds === undefined ? undefined : parseRepoIds(value.repoIds),
    commandProfile: optionalNestedString(value, "commandProfile"),
  });
}

function parseArtifacts(value) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("Field artifacts must be an array");
  }

  return value.map((artifact, index) => {
    assertObject(artifact, `artifacts[${index}]`);
    const parsed = compactObject({
      kind: requiredFieldString(artifact, "kind", `artifacts[${index}].kind`),
      label: requiredFieldString(artifact, "label", `artifacts[${index}].label`),
      uri: requiredFieldString(artifact, "uri", `artifacts[${index}].uri`),
    });

    if (hasOwn(artifact, "metadata")) {
      parsed.metadata = optionalObject(artifact, "metadata");
    }

    return parsed;
  });
}

function parseReviewFindings(value) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("Field findings must be an array");
  }

  return value.map((finding, index) => {
    assertObject(finding, `findings[${index}]`);
    const severity = requiredFieldString(finding, "severity", `findings[${index}].severity`);
    if (!isReviewFindingSeverity(severity)) {
      throw new Error(`Invalid review finding severity: ${severity}`);
    }

    const parsed = compactObject({
      severity,
      category: requiredFieldString(finding, "category", `findings[${index}].category`),
      title: requiredFieldString(finding, "title", `findings[${index}].title`),
      filePath: optionalString(finding, "filePath"),
      detailsMd: optionalString(finding, "detailsMd"),
    });

    if (hasOwn(finding, "lineNumber")) {
      if (!Number.isInteger(finding.lineNumber) || finding.lineNumber <= 0) {
        throw new Error(`Field findings[${index}].lineNumber must be a positive integer`);
      }
      parsed.lineNumber = finding.lineNumber;
    }

    return parsed;
  });
}

function parseEmbeddedReviewFindings(value) {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error("Field findings must be an array");
  }

  return value.map((finding, index) => {
    assertObject(finding, `findings[${index}]`);
    const severity = requiredFieldString(finding, "severity", `findings[${index}].severity`);
    if (!isReviewFindingSeverity(severity)) {
      throw new Error(`Invalid review finding severity: ${severity}`);
    }

    return compactObject({
      severity,
      category: requiredFieldString(finding, "category", `findings[${index}].category`),
      title: requiredFieldString(finding, "title", `findings[${index}].title`),
      filePath: optionalNestedString(finding, "filePath"),
      detailsMd: optionalNestedString(finding, "detailsMd"),
      lineNumber: hasOwn(finding, "lineNumber")
        ? requiredPositiveNestedInteger(finding.lineNumber, `findings[${index}].lineNumber`)
        : undefined,
    });
  });
}

function parseCommands(value) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("Field commands must be an array");
  }

  return value.map((command, index) => {
    if (typeof command !== "string" || !command.trim()) {
      throw new Error(`Field commands[${index}] must be a non-empty string`);
    }
    return command.trim();
  });
}

function parseRepoIds(value) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("Field repoIds must be an array");
  }

  return value.map((repoId, index) => {
    if (typeof repoId !== "string" || !repoId.trim()) {
      throw new Error(`Field repoIds[${index}] must be a non-empty string`);
    }
    return repoId.trim();
  });
}

function parseCeremonyParticipantRoles(value) {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error("Field participantRoles must be an array");
  }

  const roles = [];
  for (const [index, role] of value.entries()) {
    if (typeof role !== "string" || !role.trim()) {
      throw new Error(`Field participantRoles[${index}] must be a non-empty string`);
    }
    const normalized = role.trim();
    if (!isRoleName(normalized)) {
      throw new Error(`Invalid ceremony participant role: ${normalized}`);
    }
    if (!roles.includes(normalized)) {
      roles.push(normalized);
    }
  }
  return roles;
}

function parseCeremonyAutomation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Field ceremonyAutomation must be a JSON object");
  }

  const parsed = { ...value };
  if (hasOwn(parsed, "enabled") && typeof parsed.enabled !== "boolean") {
    throw new Error("Field ceremonyAutomation.enabled must be a boolean");
  }
  if (hasOwn(parsed, "mode") && typeof parsed.mode !== "string") {
    throw new Error("Field ceremonyAutomation.mode must be a string");
  }
  if (hasOwn(parsed, "triggers")) {
    if (!parsed.triggers || typeof parsed.triggers !== "object" || Array.isArray(parsed.triggers)) {
      throw new Error("Field ceremonyAutomation.triggers must be a JSON object");
    }
    for (const [ceremonyType, trigger] of Object.entries(parsed.triggers)) {
      if (!isCeremonyType(ceremonyType)) {
        throw new Error(`Invalid ceremony automation trigger: ${ceremonyType}`);
      }
      if (!trigger || typeof trigger !== "object" || Array.isArray(trigger)) {
        throw new Error(`Field ceremonyAutomation.triggers.${ceremonyType} must be a JSON object`);
      }
      if (hasOwn(trigger, "participantRoles")) {
        parseCeremonyParticipantRoles(trigger.participantRoles);
      }
      if (hasOwn(trigger, "deciderRole")) {
        if (typeof trigger.deciderRole !== "string" || !isRoleName(trigger.deciderRole)) {
          throw new Error(`Invalid ceremony automation decider role: ${trigger.deciderRole}`);
        }
      }
      if (hasOwn(trigger, "enabled") && typeof trigger.enabled !== "boolean") {
        throw new Error(`Field ceremonyAutomation.triggers.${ceremonyType}.enabled must be a boolean`);
      }
      if (hasOwn(trigger, "minIntervalMinutes")) {
        requiredPositiveNestedInteger(trigger.minIntervalMinutes, `ceremonyAutomation.triggers.${ceremonyType}.minIntervalMinutes`);
      }
    }
  }
  return parsed;
}

function optionalNestedString(source, field) {
  if (!hasOwn(source, field)) {
    return undefined;
  }
  if (typeof source[field] !== "string") {
    throw new Error(`Field ${field} must be a string`);
  }
  const value = source[field].trim();
  return value || undefined;
}

function requiredPositiveNestedInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Field ${label} must be a positive integer`);
  }
  return value;
}

function assertObject(value, label = "Request body") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
}

function requiredString(source, field) {
  return requiredFieldString(source, field, field);
}

function requiredFieldString(source, key, label) {
  if (typeof source[key] !== "string") {
    throw new Error(`Missing required field: ${label}`);
  }
  const value = source[key].trim();
  if (!value) {
    throw new Error(`Missing required field: ${label}`);
  }
  return value;
}

function optionalString(source, field, fallback = "") {
  if (!hasOwn(source, field)) {
    return fallback;
  }
  if (typeof source[field] !== "string") {
    throw new Error(`Field ${field} must be a string`);
  }
  return source[field].trim();
}

function optionalPatchedString(source, field, options = {}) {
  if (!hasOwn(source, field)) {
    return undefined;
  }
  if (options.required) {
    return requiredString(source, field);
  }
  return optionalString(source, field);
}

function optionalNullablePatchedString(source, field) {
  if (!hasOwn(source, field)) {
    return undefined;
  }
  if (source[field] === null) {
    return null;
  }
  if (typeof source[field] !== "string") {
    throw new Error(`Field ${field} must be a string or null`);
  }
  const value = source[field].trim();
  return value || null;
}

function optionalBoolean(source, field) {
  if (!hasOwn(source, field)) {
    return undefined;
  }
  if (typeof source[field] !== "boolean") {
    throw new Error(`Field ${field} must be a boolean`);
  }
  return source[field];
}

function optionalOptionalString(source, field) {
  if (!hasOwn(source, field)) {
    return undefined;
  }
  return optionalString(source, field);
}

function optionalObject(source, field) {
  if (!hasOwn(source, field)) {
    return undefined;
  }
  const value = source[field];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Field ${field} must be a JSON object`);
  }
  return value;
}

function requiredPositiveInteger(source, field) {
  if (!Number.isInteger(source[field]) || source[field] <= 0) {
    throw new Error(`Field ${field} must be a positive integer`);
  }
  return source[field];
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function hasOwn(value, key) {
  return Boolean(value) && Object.prototype.hasOwnProperty.call(value, key);
}
