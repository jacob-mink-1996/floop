export const ticketStates = [
  "DRAFT",
  "PROPOSED",
  "READY",
  "WORKING",
  "REVIEWING",
  "VALIDATING",
  "REWORK",
  "BLOCKED",
  "READY_TO_MERGE",
  "MERGING",
  "DONE",
  "CANCELLED",
];

export const boardStates = [
  "PROPOSED",
  "READY",
  "WORKING",
  "REVIEWING",
  "VALIDATING",
  "REWORK",
  "BLOCKED",
  "READY_TO_MERGE",
  "DONE",
];

export const executionOutcomes = [
  "completed",
  "needs_continue",
  "blocked",
  "followup_created",
  "failed",
];

export const reviewVerdicts = ["passed", "rework", "blocked"];

export const validationVerdicts = ["passed", "failed", "blocked"];

export const reviewFindingSeverities = ["low", "medium", "high"];

export const mergeStatuses = ["completed", "blocked", "rework"];

export const roleNames = [
  "product_manager",
  "architect",
  "developer",
  "reviewer",
  "validator",
  "integrator",
];

export const ticketPriorities = ["low", "medium", "high", "urgent"];

export const dependencyTypes = ["finish_to_start"];

export const refinementModes = ["autonomous", "user_approved", "user_participant", "user_only"];

export const ceremonyTypes = ["refinement", "planning", "daily_triage", "review_demo_prep", "retro"];

export const interactionModes = [
  "manual",
  "operator_approved",
  "autonomous_with_review",
  "autopilot",
];

export const agentMessageIntents = [
  "suggest_ticket",
  "comment_on_ticket",
  "suggest_dispatch",
  "submit_ceremony_input",
  "raise_risk",
  "submit_artifact",
  "request_status",
];

export const agentMessageStatuses = [
  "pending",
  "accepted",
  "dismissed",
  "converted",
  "attached",
];

export const blockerKinds = [
  "needs_human_input",
  "needs_dependency",
  "needs_environment_fix",
  "needs_policy_override",
];

export const eventTypes = [
  "project.created",
  "project.updated",
  "repo.created",
  "repo.updated",
  "ticket.created",
  "ticket.updated",
  "ticket.transitioned",
  "dependency.added",
  "dependency.removed",
  "execution.started",
  "execution.completed",
  "review.completed",
  "validation.completed",
  "worktree.created",
  "worktree.cleaned",
  "merge.started",
  "merge.completed",
  "ceremony.started",
  "ceremony.proposed",
  "ceremony.applied",
  "ceremony.rejected",
  "agent.message_received",
  "agent.message_accepted",
  "agent.message_dismissed",
  "agent.message_converted",
  "agent.message_attached",
];

export function isTicketState(value) {
  return ticketStates.includes(value);
}

export function isExecutionOutcome(value) {
  return executionOutcomes.includes(value);
}

export function isReviewVerdict(value) {
  return reviewVerdicts.includes(value);
}

export function isValidationVerdict(value) {
  return validationVerdicts.includes(value);
}

export function isReviewFindingSeverity(value) {
  return reviewFindingSeverities.includes(value);
}

export function isMergeStatus(value) {
  return mergeStatuses.includes(value);
}

export function isRoleName(value) {
  return roleNames.includes(value);
}

export function isTicketPriority(value) {
  return ticketPriorities.includes(value);
}

export function isDependencyType(value) {
  return dependencyTypes.includes(value);
}

export function isRefinementMode(value) {
  return refinementModes.includes(value);
}

export function isCeremonyType(value) {
  return ceremonyTypes.includes(value);
}

export function isInteractionMode(value) {
  return interactionModes.includes(value);
}

export function isAgentMessageIntent(value) {
  return agentMessageIntents.includes(value);
}

export function isAgentMessageStatus(value) {
  return agentMessageStatuses.includes(value);
}

export {
  assertAutomaticTicketTransition,
  assertOperatorTicketOverride,
  isLegalAutomaticTicketTransition,
} from "./ticket-transition-policy.mjs";
