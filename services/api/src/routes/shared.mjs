import { isTicketState } from "../../../../packages/domain/src/index.mjs";

export class RequestError extends Error {
  constructor(status, message, reasonCode = "") {
    super(message);
    this.status = status;
    this.reasonCode = reasonCode;
  }
}

export function respondMaybe(value, key) {
  if (!value) {
    return { status: 404, body: { error: "not_found" } };
  }
  return { status: 200, body: { [key]: value } };
}

export function respondCreated(value, key) {
  if (!value) {
    return { status: 404, body: { error: "not_found" } };
  }
  return { status: 201, body: { [key]: value } };
}

export function parseTicketFilters(url) {
  const filters = {};
  const statesParam = url.searchParams.get("state");
  if (statesParam) {
    const states = statesParam
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    for (const state of states) {
      if (!isTicketState(state)) {
        throw new RequestError(400, `Invalid ticket state filter: ${state}`);
      }
    }
    filters.states = states;
  }

  const priority = url.searchParams.get("priority");
  if (priority) {
    filters.priority = priority.trim();
  }

  const assignedRole = url.searchParams.get("assignedRole");
  if (assignedRole) {
    filters.assignedRole = assignedRole.trim();
  }

  const search = url.searchParams.get("search");
  if (search) {
    filters.search = search.trim();
  }

  const parentTicketId = url.searchParams.get("parentTicketId");
  if (parentTicketId) {
    filters.parentTicketId = parentTicketId.trim();
  }

  return filters;
}

export function parseWorktreeFilters(url) {
  const filters = {};

  const ticketId = url.searchParams.get("ticketId");
  if (ticketId) {
    filters.ticketId = ticketId.trim();
  }

  const executionId = url.searchParams.get("executionId");
  if (executionId) {
    filters.executionId = executionId.trim();
  }

  const status = url.searchParams.get("status");
  if (status) {
    filters.status = status.trim();
  }

  return filters;
}

export function parseEventFilters(url) {
  const filters = {};

  const ticketId = url.searchParams.get("ticketId");
  if (ticketId) {
    filters.ticketId = ticketId.trim();
  }

  const repoId = url.searchParams.get("repoId");
  if (repoId) {
    filters.repoId = repoId.trim();
  }

  const type = url.searchParams.get("type");
  if (type) {
    filters.type = type.trim();
  }

  const order = url.searchParams.get("order");
  if (order) {
    if (order !== "asc" && order !== "desc") {
      throw new RequestError(400, `Invalid event order filter: ${order}`);
    }
    filters.order = order;
  }

  const limit = url.searchParams.get("limit");
  if (limit) {
    const parsedLimit = Number.parseInt(limit, 10);
    if (!Number.isInteger(parsedLimit) || parsedLimit <= 0) {
      throw new RequestError(400, `Invalid event limit filter: ${limit}`);
    }
    filters.limit = parsedLimit;
  }

  return filters;
}

export function parseArtifactFilters(url) {
  const filters = {};

  for (const key of ["ticketId", "executionId", "reviewId", "validationRunId", "mergeRunId", "kind"]) {
    const value = url.searchParams.get(key);
    if (value) {
      filters[key] = value.trim();
    }
  }

  const limit = url.searchParams.get("limit");
  if (limit) {
    const parsedLimit = Number.parseInt(limit, 10);
    if (!Number.isInteger(parsedLimit) || parsedLimit <= 0) {
      throw new RequestError(400, `Invalid artifact limit filter: ${limit}`);
    }
    filters.limit = parsedLimit;
  }

  return filters;
}

export function parseRunFilters(url) {
  const filters = {};
  const limit = url.searchParams.get("limit");
  if (limit) {
    const parsedLimit = Number.parseInt(limit, 10);
    if (!Number.isInteger(parsedLimit) || parsedLimit <= 0) {
      throw new RequestError(400, `Invalid run limit filter: ${limit}`);
    }
    filters.limit = parsedLimit;
  }
  return filters;
}

export function currentMergeReasonCode(mergeStatus) {
  if (!mergeStatus) {
    return "merge_conflict";
  }
  if (mergeStatus.blockingReasons?.length) {
    return mergeStatus.blockingReasons[0].code;
  }
  if (mergeStatus.approval?.required && !mergeStatus.approval?.satisfied) {
    return "human_approval_required";
  }
  if (mergeStatus.readiness) {
    return `merge_${mergeStatus.readiness}`;
  }
  return "merge_conflict";
}

export function inferErrorStatus(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("UNIQUE constraint failed")) {
    return 409;
  }
  if (message.includes("FOREIGN KEY constraint failed")) {
    return 400;
  }
  if (
    message.startsWith("Missing project policy for ") ||
    message.startsWith("Missing required field:") ||
    message.startsWith("Invalid ticket state") ||
    message.startsWith("Invalid ticket state filter:") ||
    message.startsWith("Invalid ticket priority:") ||
    message.startsWith("Invalid assigned role:") ||
    message.startsWith("Invalid execution outcome:") ||
    message.startsWith("Invalid review verdict:") ||
    message.startsWith("Invalid validation verdict:") ||
    message.startsWith("Invalid merge status:") ||
    message.startsWith("Invalid review finding severity:") ||
    message.startsWith("Invalid dependency type:") ||
    message.startsWith("Invalid interaction mode:") ||
    message.startsWith("Invalid agent message intent:") ||
    message.startsWith("Invalid external agent action:") ||
    message.startsWith("Invalid agent message status:") ||
    message === "Only input requests can be responded to" ||
    message === "Input request is no longer pending" ||
    message.startsWith("Unknown repo target:") ||
    message.startsWith("Duplicate repo target:") ||
    message.startsWith("Unknown execution for ticket ") ||
    message.startsWith("Unknown validation repo target:") ||
    message.startsWith("Duplicate validation repo target:") ||
    message.startsWith("Validation repo target is not attached to ") ||
    message.startsWith("No repo targets configured for validation on ") ||
    message.startsWith("Unknown parent ticket:") ||
    message.startsWith("Parent cycle detected for ticket ") ||
    message.startsWith("Dependency cycle detected for ticket ") ||
    message.startsWith("Field ") ||
    message.startsWith("Unknown agent profile:") ||
    message.startsWith("Agent profile ") ||
    message.startsWith("No agent profile configured for role:") ||
    message.startsWith("approvedByKind and approvedByRef must be provided together") ||
    message.startsWith("Invalid artifact limit filter:") ||
    message.startsWith("Cancelled executions cannot be continued") ||
    message.startsWith("Execution must be active or marked needs_continue before continuing") ||
    message === "A ticket cannot depend on itself" ||
    message === "A ticket cannot parent itself"
  ) {
    return 400;
  }
  if (
    message.startsWith("Execution already running for ") ||
    message.startsWith("Project execution limit reached for ") ||
    message.startsWith("Project merge limit reached for ") ||
    message.includes(" reached the continuation limit of ") ||
    message === "Cannot clean an active worktree" ||
    message.startsWith("Execution execution_") ||
    message.includes(" must be finished before review") ||
    message.includes(" must complete successfully before review") ||
    message.includes(" must be finished before validation") ||
    message.includes(" must complete successfully before validation") ||
    message.includes(" is not ready for review") ||
    message.includes(" is not ready for validation") ||
    message.includes(" is not ready for merge") ||
    message.includes(" requires human approval before merge") ||
    message.includes("Latest review must pass before merge") ||
    message.includes("Latest validation must pass before merge") ||
    message.includes("Latest validation must use ")
  ) {
    return 409;
  }
  return 500;
}
