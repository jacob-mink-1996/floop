const DEFAULT_POLL_INTERVAL_MS = 30_000;

export function createCeremonyAutomationDriver(options = {}) {
  if (!options.store) {
    throw new Error("Ceremony automation driver requires a store");
  }

  return new CeremonyAutomationDriver({
    store: options.store,
    pollIntervalMs: options.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS,
    logger: options.logger || console,
  });
}

class CeremonyAutomationDriver {
  constructor({ store, pollIntervalMs, logger }) {
    this.store = store;
    this.pollIntervalMs = pollIntervalMs;
    this.logger = logger;
    this.timer = null;
  }

  start() {
    if (this.timer) {
      return;
    }

    this.pollOnce().catch((error) => {
      this.logger.error?.("[floop-ceremony-driver] startup poll failed", error);
    });

    this.timer = setInterval(() => {
      this.pollOnce().catch((error) => {
        this.logger.error?.("[floop-ceremony-driver] poll failed", error);
      });
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  async stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async pollOnce() {
    const created = [];
    const dispatched = [];
    for (const project of this.store.listProjects()) {
      const policy = project.policy;
      const automation = policy?.ceremonyAutomation;
      if (!automation?.enabled) {
        continue;
      }

      for (const [type, trigger] of Object.entries(automation.triggers || {})) {
        if (!trigger?.enabled) {
          continue;
        }
        const lifecycleReason = evaluateCeremonyLifecycle(this.store, project, type, trigger);
        if (!lifecycleReason) {
          continue;
        }
        if (!hasMinIntervalElapsed(this.store, project.id, type, trigger.minIntervalMinutes || 30)) {
          continue;
        }

        const run = this.store.createCeremonyRun(project.id, {
          type,
          participantRoles: trigger.participantRoles,
          deciderRole: trigger.deciderRole,
          consensusPolicy: trigger.consensusPolicy,
          scope: {
            trigger: "lifecycle",
            triggerConfig: trigger,
            lifecycleReason,
            automationMode: automation.mode || "operator_approved",
          },
          createdByKind: "system",
          createdByRef: "ceremony-automation",
        });
        if (!run) {
          continue;
        }

        created.push(run);
        if (automation.mode === "fully_automatic") {
          this.store.applyCeremonyRun(project.id, run.id);
        }
      }
      dispatched.push(...dispatchReadyRefinementChildren(this.store, project));
    }
    Object.defineProperty(created, "dispatched", {
      value: dispatched,
      enumerable: false,
    });
    return created;
  }
}

function dispatchReadyRefinementChildren(store, project) {
  const policy = project.policy || {};
  if (policy.interactionMode !== "autopilot" && policy.interactionMode !== "fully_autonomous") {
    return [];
  }
  const board = store.getProjectBoard(project.id);
  if (!board) {
    return [];
  }
  const dispatched = [];
  const tickets = board.columns.flatMap((column) => column.tickets);
  for (const ticket of tickets) {
    if (!isReadyRefinementChild(store, project.id, ticket)) {
      continue;
    }
    try {
      const execution = store.createExecution(project.id, ticket.id, {
        role: ticket.assignedRole || "developer",
        reason: "Autonomous refinement child is ready after answered parent HITL.",
      });
      if (execution) {
        dispatched.push(execution);
      }
    } catch {
      // Concurrency and role policy gates are allowed to hold ready work for a later poll.
    }
  }
  return dispatched;
}

function isReadyRefinementChild(store, projectId, ticket) {
  if (!ticket || ticket.state !== "READY" || !ticket.parentTicketId) {
    return false;
  }
  if (ticket.activeExecutionCount > 0 || !ticket.assignedRole) {
    return false;
  }
  const detail = store.getTicket(projectId, ticket.id);
  if (!detail || detail.executions.some((execution) => execution.status === "running")) {
    return false;
  }
  const parent = store.getTicket(projectId, ticket.parentTicketId);
  if (!parent) {
    return false;
  }
  const pendingParentQuestion = store
    .listAgentMessages(projectId, { intent: "submit_ceremony_input", status: "pending", limit: 100 })
    .some((message) => message.target?.ticketId === parent.id && message.metadata?.refinementQuestion === true);
  if (pendingParentQuestion) {
    return false;
  }
  const answeredParentQuestion = store
    .listAgentMessages(projectId, { intent: "comment_on_ticket", status: "attached", limit: 100 })
    .some((message) =>
      message.target?.ticketId === parent.id &&
      message.metadata?.ceremonyResponse === true &&
      message.metadata?.unblockResponse === true,
    );
  return answeredParentQuestion;
}

export function evaluateCeremonyLifecycle(store, project, type, trigger = {}) {
  const board = store.getProjectBoard(project.id);
  if (!board) {
    return null;
  }
  const tickets = board.columns.flatMap((column) => column.tickets);
  const counts = countTicketsByState(tickets);
  const active = tickets.filter((ticket) => ["WORKING", "REVIEWING", "VALIDATING"].includes(ticket.state));
  const blockedOrRework = tickets.filter((ticket) => ticket.state === "BLOCKED" || ticket.state === "REWORK");
  const staleActive = active.filter((ticket) => isStaleActiveTicket(ticket, Number(trigger.onStaleActiveWorkHours || 24)));
  const doneOrMergeReady = tickets.filter((ticket) => ticket.state === "READY_TO_MERGE" || ticket.state === "DONE");
  const readyBacklog = tickets.filter((ticket) => ["READY", "PROPOSED"].includes(ticket.state));
  const draftOrProposed = tickets.filter((ticket) => ["DRAFT", "PROPOSED"].includes(ticket.state));

  switch (type) {
    case "refinement":
      return draftOrProposed.length > 0
        ? lifecycleReason("messy_backlog_needs_refinement", `${draftOrProposed.length} draft/proposed ticket(s) need refinement before planning.`, {
            draft: counts.DRAFT || 0,
            proposed: counts.PROPOSED || 0,
          })
        : null;
    case "planning":
      return Boolean(trigger.onReadyQueueChanged || trigger.onCapacityAvailable) && readyBacklog.length > 0
        ? lifecycleReason("ready_backlog_needs_planning", `${readyBacklog.length} ready/proposed ticket(s) can be planned against available capacity.`, {
            ready: counts.READY || 0,
            proposed: counts.PROPOSED || 0,
            maxParallelExecutions: project.policy?.maxParallelExecutions || 1,
          })
        : null;
    case "daily_triage":
      if (blockedOrRework.length > 0) {
        return lifecycleReason("blocked_or_rework_needs_triage", `${blockedOrRework.length} blocked/rework ticket(s) need an unblock decision.`, {
          blocked: counts.BLOCKED || 0,
          rework: counts.REWORK || 0,
        });
      }
      if (staleActive.length > 0) {
        return lifecycleReason("stale_active_work_needs_check_in", `${staleActive.length} active ticket(s) have gone stale.`, {
          staleActive: staleActive.length,
          staleHours: Number(trigger.onStaleActiveWorkHours || 24),
        });
      }
      return Boolean(trigger.onActiveWorkCheckIn) && active.length > 0
        ? lifecycleReason("active_work_needs_check_in", `${active.length} active ticket(s) are in flight and need a check-in.`, {
            working: counts.WORKING || 0,
            reviewing: counts.REVIEWING || 0,
            validating: counts.VALIDATING || 0,
          })
        : null;
    case "review_demo_prep":
      return doneOrMergeReady.length > 0
        ? lifecycleReason("done_work_needs_demo_prep", `${doneOrMergeReady.length} done/merge-ready ticket(s) need demo preparation.`, {
            readyToMerge: counts.READY_TO_MERGE || 0,
            done: counts.DONE || 0,
          })
        : null;
    case "work_generation": {
      const threshold = Number(trigger.onReadyBacklogBelow ?? 2);
      return Boolean(trigger.onSprintEndPlanning) && readyBacklog.length <= threshold && doneOrMergeReady.length > 0
        ? lifecycleReason("low_backlog_after_shipped_work_needs_generation", `Ready backlog is ${readyBacklog.length}, at or below ${threshold}, after shipped work.`, {
            readyBacklog: readyBacklog.length,
            threshold,
            doneOrMergeReady: doneOrMergeReady.length,
          })
        : null;
    }
    case "retro":
      return blockedOrRework.length >= Number(trigger.onRepeatedBlockedOrReworkCount || 3)
        ? lifecycleReason("repeated_blocked_or_rework_needs_retro", `${blockedOrRework.length} blocked/rework ticket(s) indicate a systemic loop.`, {
            blocked: counts.BLOCKED || 0,
            rework: counts.REWORK || 0,
            threshold: Number(trigger.onRepeatedBlockedOrReworkCount || 3),
          })
        : null;
    default:
      return null;
  }
}

function countTicketsByState(tickets) {
  const counts = {};
  for (const ticket of tickets) {
    counts[ticket.state] = (counts[ticket.state] || 0) + 1;
  }
  return counts;
}

function lifecycleReason(code, summary, evidence = {}) {
  return {
    code,
    summary,
    evidence,
  };
}

function isStaleActiveTicket(ticket, staleHours) {
  if (!["WORKING", "REVIEWING", "VALIDATING"].includes(ticket.state)) {
    return false;
  }
  const updatedAt = Date.parse(ticket.updatedAt || "");
  if (!Number.isFinite(updatedAt)) {
    return false;
  }
  return Date.now() - updatedAt >= Math.max(1, staleHours) * 60 * 60 * 1000;
}

function hasMinIntervalElapsed(store, projectId, type, minIntervalMinutes) {
  const latest = (store.listCeremonyRuns(projectId) || []).find((run) => run.type === type);
  if (!latest) {
    return true;
  }
  const lastStartedAt = Date.parse(latest.startedAt || latest.createdAt || "");
  if (!Number.isFinite(lastStartedAt)) {
    return true;
  }
  return Date.now() - lastStartedAt >= Math.max(1, minIntervalMinutes) * 60 * 1000;
}
