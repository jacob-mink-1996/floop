import { isTicketState } from "./index.mjs";

const automaticTransitionGraph = new Map(
  Object.entries({
    DRAFT: ["PROPOSED", "READY", "CANCELLED"],
    PROPOSED: ["READY", "CANCELLED"],
    READY: ["WORKING", "REVIEWING", "VALIDATING", "BLOCKED", "CANCELLED"],
    WORKING: ["WORKING", "REVIEWING", "VALIDATING", "READY_TO_MERGE", "REWORK", "BLOCKED", "DONE"],
    REVIEWING: ["REVIEWING", "VALIDATING", "READY_TO_MERGE", "REWORK", "BLOCKED", "DONE"],
    VALIDATING: ["VALIDATING", "READY_TO_MERGE", "REWORK", "BLOCKED", "DONE"],
    REWORK: ["WORKING", "REVIEWING", "VALIDATING", "BLOCKED", "CANCELLED"],
    BLOCKED: ["WORKING", "REVIEWING", "VALIDATING", "REWORK", "CANCELLED"],
    READY_TO_MERGE: ["VALIDATING", "DONE", "REWORK", "BLOCKED", "CANCELLED"],
    MERGING: ["DONE", "REWORK", "BLOCKED"],
    DONE: [],
    CANCELLED: [],
  }),
);

export function isLegalAutomaticTicketTransition(fromState, toState) {
  if (!isTicketState(fromState)) {
    throw new Error(`Invalid ticket state: ${fromState}`);
  }
  if (!isTicketState(toState)) {
    throw new Error(`Invalid ticket state: ${toState}`);
  }
  if (fromState === toState) {
    return true;
  }
  return automaticTransitionGraph.get(fromState)?.includes(toState) || false;
}

export function assertAutomaticTicketTransition({ fromState, toState, reasonCode }) {
  if (!requiredReasonCode(reasonCode)) {
    throw new Error("Automatic ticket transitions require a reason code");
  }
  if (!isLegalAutomaticTicketTransition(fromState, toState)) {
    throw new Error(`Illegal automatic ticket transition: ${fromState} -> ${toState}`);
  }
}

export function assertOperatorTicketOverride({ fromState, toState, reasonCode }) {
  if (!isTicketState(fromState)) {
    throw new Error(`Invalid ticket state: ${fromState}`);
  }
  if (!isTicketState(toState)) {
    throw new Error(`Invalid ticket state: ${toState}`);
  }
  if (!requiredReasonCode(reasonCode)) {
    throw new Error("Manual ticket overrides require a reason code");
  }
}

function requiredReasonCode(value) {
  return typeof value === "string" && value.trim().length > 0;
}
