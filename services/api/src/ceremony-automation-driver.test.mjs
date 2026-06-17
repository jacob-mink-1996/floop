import assert from "node:assert/strict";
import test from "node:test";

import { createCeremonyAutomationDriver } from "./ceremony-automation-driver.mjs";
import { createStore } from "./store.mjs";

test("ceremony automation driver ignores disabled projects", async () => {
  const store = createStore({ filename: ":memory:", seedDemo: true });
  try {
    const driver = createCeremonyAutomationDriver({ store, logger: silentLogger() });
    const created = await driver.pollOnce();

    assert.equal(created.length, 0);
    assert.equal(store.listCeremonyRuns("project_floop").length, 0);
  } finally {
    store.close();
  }
});

test("ceremony automation driver creates operator-approved runs and respects min interval", async () => {
  const store = createStore({ filename: ":memory:", seedDemo: true });
  try {
    store.createTicket("project_floop", {
      title: "Automated refinement target",
      brief: "Needs PO refinement.",
      assignedRole: "developer",
      state: "PROPOSED",
    });
    store.updateProjectPolicy("project_floop", {
      ceremonyAutomation: {
        enabled: true,
        mode: "operator_approved",
        triggers: {
          ...disabledTriggers(),
          refinement: {
            enabled: true,
            minIntervalMinutes: 60,
            participantRoles: ["product_manager", "developer"],
            deciderRole: "product_manager",
            consensusPolicy: "decider_synthesizes_objections",
          },
        },
      },
    });

    const driver = createCeremonyAutomationDriver({ store, logger: silentLogger() });
    const first = await driver.pollOnce();
    const second = await driver.pollOnce();
    const runs = store.listCeremonyRuns("project_floop");

    assert.equal(first.length, 1);
    assert.equal(second.length, 0);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].type, "refinement");
    assert.equal(runs[0].createdByKind, "system");
    assert.deepEqual(runs[0].participantRoles, ["product_manager", "developer"]);
    assert.equal(runs[0].deciderRole, "product_manager");
    assert.equal(runs[0].status, "proposed");
    assert.equal(runs[0].scope.trigger, "lifecycle");
    assert.equal(runs[0].scope.lifecycleReason.code, "messy_backlog_needs_refinement");
  } finally {
    store.close();
  }
});

test("ceremony automation driver applies proposals in fully automatic mode", async () => {
  const store = createStore({ filename: ":memory:", seedDemo: true });
  try {
    const ticket = store.createTicket("project_floop", {
      title: "Fully automatic refinement target",
      brief: "Needs details.",
      assignedRole: "developer",
      state: "PROPOSED",
    });
    store.updateProjectPolicy("project_floop", {
      ceremonyAutomation: {
        enabled: true,
        mode: "fully_automatic",
        triggers: {
          ...disabledTriggers(),
          refinement: {
            enabled: true,
            minIntervalMinutes: 1,
            participantRoles: ["product_manager", "developer"],
            deciderRole: "product_manager",
            consensusPolicy: "decider_synthesizes_objections",
          },
        },
      },
    });

    const driver = createCeremonyAutomationDriver({ store, logger: silentLogger() });
    const created = await driver.pollOnce();
    const run = store.getCeremonyRun("project_floop", created[0].id);
    const updatedTicket = store.getTicket("project_floop", ticket.id);

    assert.equal(created.length, 1);
    assert.equal(run.status, "applied");
    assert.equal(run.proposals.every((proposal) => proposal.status === "applied"), true);
    assert.match(updatedTicket.acceptanceCriteriaMd, /Scope is explicit enough/);
  } finally {
    store.close();
  }
});

test("ceremony automation driver runs agent check-ins for active work lifecycle", async () => {
  const store = createStore({ filename: ":memory:", seedDemo: true });
  try {
    store.updateProjectPolicy("project_floop", {
      ceremonyAutomation: {
        enabled: true,
        mode: "operator_approved",
        triggers: {
          ...disabledTriggers(),
          daily_triage: {
            enabled: true,
            onActiveWorkCheckIn: true,
            minIntervalMinutes: 30,
            participantRoles: ["product_manager", "developer"],
            deciderRole: "product_manager",
            consensusPolicy: "blockers_and_stale_work_win",
          },
        },
      },
    });
    store.createExecution("project_floop", "ticket_project_floop_2", {
      role: "developer",
      reason: "Start active work that should receive agent check-ins.",
    });

    const driver = createCeremonyAutomationDriver({ store, logger: silentLogger() });
    const first = await driver.pollOnce();
    const second = await driver.pollOnce();

    assert.equal(first.length, 1);
    assert.equal(first[0].type, "daily_triage");
    assert.equal(first[0].scope.triggerConfig.onActiveWorkCheckIn, true);
    assert.equal(first[0].scope.lifecycleReason.code, "active_work_needs_check_in");
    assert.equal(second.length, 0);
  } finally {
    store.close();
  }
});

test("ceremony automation driver generates new work near sprint end when ready backlog is low", async () => {
  const store = createStore({ filename: ":memory:", seedDemo: true });
  try {
    store.updateProjectPolicy("project_floop", {
      ceremonyAutomation: {
        enabled: true,
        mode: "operator_approved",
        triggers: {
          ...disabledTriggers(),
          work_generation: {
            enabled: true,
            onSprintEndPlanning: true,
            onReadyBacklogBelow: 2,
            minIntervalMinutes: 30,
            participantRoles: ["product_manager", "architect", "developer"],
            deciderRole: "product_manager",
            consensusPolicy: "decider_synthesizes_objections",
          },
        },
      },
    });
    store.createTicket("project_floop", {
      title: "Sprint slice shipped",
      brief: "A completed sprint slice should trigger late-sprint work generation when backlog is low.",
      assignedRole: "developer",
      state: "DONE",
    });

    const driver = createCeremonyAutomationDriver({ store, logger: silentLogger() });
    const created = await driver.pollOnce();

    assert.equal(created.length, 1);
    assert.equal(created[0].type, "work_generation");
    assert.equal(created[0].scope.triggerConfig.onSprintEndPlanning, true);
    assert.equal(created[0].scope.lifecycleReason.code, "low_backlog_after_shipped_work_needs_generation");
  } finally {
    store.close();
  }
});

test("ceremony automation driver explains planning demo prep and retro lifecycle triggers", async () => {
  const store = createStore({ filename: ":memory:", seedDemo: true });
  try {
    store.updateProjectPolicy("project_floop", {
      ceremonyAutomation: {
        enabled: true,
        mode: "operator_approved",
        triggers: {
          ...disabledTriggers(),
          planning: {
            enabled: true,
            onReadyQueueChanged: true,
            onCapacityAvailable: true,
            minIntervalMinutes: 30,
            participantRoles: ["product_manager", "developer"],
            deciderRole: "product_manager",
            consensusPolicy: "decider_synthesizes_objections",
          },
          review_demo_prep: {
            enabled: true,
            minIntervalMinutes: 30,
            participantRoles: ["product_manager", "reviewer"],
            deciderRole: "reviewer",
            consensusPolicy: "only_evidence_backed_done_work_is_demoable",
          },
          retro: {
            enabled: true,
            onRepeatedBlockedOrReworkCount: 2,
            minIntervalMinutes: 30,
            participantRoles: ["product_manager", "developer"],
            deciderRole: "product_manager",
            consensusPolicy: "recurring_systemic_risk_wins",
          },
        },
      },
    });
    store.createTicket("project_floop", {
      title: "Ready lifecycle slice",
      brief: "Ready work should trigger planning.",
      assignedRole: "developer",
      state: "READY",
    });
    store.createTicket("project_floop", {
      title: "Demo lifecycle slice",
      brief: "Done work should trigger demo prep.",
      assignedRole: "developer",
      state: "DONE",
    });
    store.createTicket("project_floop", {
      title: "Blocked lifecycle slice",
      brief: "Blocked work should contribute to retro.",
      assignedRole: "developer",
      state: "BLOCKED",
    });
    store.createTicket("project_floop", {
      title: "Rework lifecycle slice",
      brief: "Rework should contribute to retro.",
      assignedRole: "developer",
      state: "REWORK",
    });

    const driver = createCeremonyAutomationDriver({ store, logger: silentLogger() });
    const created = await driver.pollOnce();
    const byType = new Map(created.map((run) => [run.type, run]));

    assert.equal(byType.get("planning")?.scope.lifecycleReason.code, "ready_backlog_needs_planning");
    assert.equal(byType.get("review_demo_prep")?.scope.lifecycleReason.code, "done_work_needs_demo_prep");
    assert.equal(byType.get("retro")?.scope.lifecycleReason.code, "repeated_blocked_or_rework_needs_retro");
  } finally {
    store.close();
  }
});

function silentLogger() {
  return {
    error() {},
    info() {},
    warn() {},
  };
}

function disabledTriggers() {
  return {
    refinement: { enabled: false },
    planning: { enabled: false },
    daily_triage: { enabled: false },
    review_demo_prep: { enabled: false },
    work_generation: { enabled: false },
    retro: { enabled: false },
  };
}
