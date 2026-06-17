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
    for (const project of this.store.listProjects()) {
      const policy = project.policy;
      const automation = policy?.ceremonyAutomation;
      if (!automation?.enabled) {
        continue;
      }

      for (const [type, trigger] of Object.entries(automation.triggers || {})) {
        if (!trigger?.enabled || !shouldRunCeremony(this.store, project, type, trigger)) {
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
            trigger: "automation",
            triggerConfig: trigger,
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
    }
    return created;
  }
}

function shouldRunCeremony(store, project, type, trigger) {
  const board = store.getProjectBoard(project.id);
  if (!board) {
    return false;
  }
  const tickets = board.columns.flatMap((column) => column.tickets);

  switch (type) {
    case "refinement":
      return tickets.some((ticket) => ["DRAFT", "PROPOSED"].includes(ticket.state));
    case "planning":
      return Boolean(trigger.onReadyQueueChanged || trigger.onCapacityAvailable)
        && tickets.some((ticket) => ticket.state === "READY" || ticket.state === "PROPOSED");
    case "daily_triage":
      return (
        (Boolean(trigger.onActiveWorkCheckIn) &&
          tickets.some((ticket) => ["WORKING", "REVIEWING", "VALIDATING"].includes(ticket.state))) ||
        tickets.some((ticket) => ticket.state === "BLOCKED" || ticket.state === "REWORK") ||
        tickets.some((ticket) => isStaleActiveTicket(ticket, Number(trigger.onStaleActiveWorkHours || 24)))
      );
    case "review_demo_prep":
      return tickets.some((ticket) => ticket.state === "READY_TO_MERGE" || ticket.state === "DONE");
    case "retro":
      return (
        tickets.filter((ticket) => ticket.state === "BLOCKED" || ticket.state === "REWORK").length >=
        Number(trigger.onRepeatedBlockedOrReworkCount || 3)
      );
    default:
      return false;
  }
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
