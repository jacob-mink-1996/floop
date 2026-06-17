import type { BoardColumn, BoardTicket, TicketState } from "./types";

export const stateLabels: Record<string, string> = {
  DRAFT: "Draft",
  PROPOSED: "Proposed",
  READY: "Ready",
  WORKING: "Working",
  REVIEWING: "Reviewing",
  VALIDATING: "Validating",
  REWORK: "Rework",
  BLOCKED: "Blocked",
  READY_TO_MERGE: "Ready to merge",
  MERGING: "Merging",
  DONE: "Done",
  CANCELLED: "Cancelled",
};

export const roles = ["developer", "reviewer", "validator", "architect", "integrator", "product_manager"];
export const priorities = ["low", "medium", "high", "urgent"];
export const ticketStates = [
  "PROPOSED",
  "READY",
  "WORKING",
  "REVIEWING",
  "VALIDATING",
  "REWORK",
  "BLOCKED",
  "READY_TO_MERGE",
  "DONE",
] as const;

export const boardGroups = [
  { id: "backlog", label: "Backlog", states: ["PROPOSED", "READY"] },
  { id: "working", label: "Working", states: ["WORKING", "REWORK", "BLOCKED"] },
  { id: "evidence", label: "Evidence", states: ["REVIEWING", "VALIDATING"] },
  { id: "merge", label: "Merge", states: ["READY_TO_MERGE", "MERGING"] },
  { id: "done", label: "Done", states: ["DONE"] },
] as const;

export function groupBoardColumns(columns: BoardColumn[]) {
  const ticketsByState = new Map<TicketState, BoardTicket[]>();
  for (const column of columns) {
    ticketsByState.set(column.state, column.tickets);
  }

  return boardGroups.map((group) => {
    const tickets = group.states.flatMap((state) => ticketsByState.get(state as TicketState) || []);
    return {
      ...group,
      tickets,
      count: tickets.length,
    };
  });
}

export function prettyState(state: string): string {
  if (stateLabels[state]) return stateLabels[state];
  return state
    .toLowerCase()
    .replace(/[._-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function prettyRole(role: string): string {
  return role.replace(/_/g, " ");
}

export function formatDate(value: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function nextActionForTicket(ticket: BoardTicket | null): { label: string; detail: string } {
  if (!ticket) {
    return { label: "Select a ticket", detail: "Inspect evidence and decide the next operator action." };
  }

  switch (ticket.state) {
    case "READY":
      return { label: "Start developer lane", detail: "The ticket is ready for execution." };
    case "WORKING":
      return { label: "Execution in progress", detail: "Use the execution dock to watch, steer, or stop work." };
    case "REVIEWING":
      return { label: "Record review", detail: "Reviewer evidence is the next gate." };
    case "VALIDATING":
      return { label: "Record validation", detail: "Validation evidence is the next gate." };
    case "READY_TO_MERGE":
      return { label: "Approve or merge", detail: "Merge policy is satisfied or waiting on approval." };
    case "REWORK":
      return { label: "Route rework", detail: "Findings should drive another implementation pass." };
    case "BLOCKED":
      return { label: "Resolve blocker", detail: "The ticket needs a dependency, decision, or environment fix." };
    case "DONE":
      return { label: "Complete", detail: "The governed loop has finished for this ticket." };
    default:
      return { label: "Refine ticket", detail: "Clarify scope and move it toward ready work." };
  }
}
