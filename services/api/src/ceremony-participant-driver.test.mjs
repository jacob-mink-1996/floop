import assert from "node:assert/strict";
import test from "node:test";

import { createCeremonyParticipantDriver } from "./ceremony-participant-driver.mjs";
import { createStore } from "./store.mjs";

test("ceremony participant driver runs participant fan-out and synthesizes consensus", async () => {
  const store = createStore({ filename: ":memory:", seedDemo: true });
  try {
    for (const role of ["product_manager", "developer"]) {
      store.updateRoleProfile("project_floop", role, {
        adapter: "mock",
        model: "fixture",
        config: {
          result: {
            outcome: "completed",
            summaryMd: `${role} ceremony advice`,
            questionsMd: `${role} question`,
            riskMd: `${role} risk`,
            payload: { role },
          },
        },
      });
    }
    const run = store.createCeremonyRun("project_floop", {
      type: "refinement",
      participantRoles: ["product_manager", "developer"],
      deciderRole: "product_manager",
      consensusPolicy: "decider_synthesizes_objections",
    });

    const driver = createCeremonyParticipantDriver({ store, logger: silentLogger(), maxParallel: 2 });
    await driver.pollOnce();

    const completed = store.getCeremonyRun("project_floop", run.id);
    const synthesis = completed.proposals.find((proposal) => proposal.summary.startsWith("Agent consensus:"));

    assert.equal(completed.participants.length, 2);
    assert.equal(completed.participants.every((participant) => participant.status === "completed"), true);
    assert.equal(completed.participants.find((participant) => participant.role === "developer").summaryMd, "developer ceremony advice");
    assert.ok(synthesis);
    assert.match(synthesis.payload.participantSummary, /product_manager ceremony advice/);
    assert.match(completed.summaryMd, /Agent consensus/);
  } finally {
    store.close();
  }
});

test("ceremony participant HITL stays scoped to the ceremony run", async () => {
  const store = createStore({ filename: ":memory:", seedDemo: true });
  try {
    store.updateProjectPolicy("project_floop", {
      interactionMode: "manual",
    });
    store.updateRoleProfile("project_floop", "product_manager", {
      adapter: "mock",
      model: "fixture",
      config: {
        result: {
          outcome: "blocked",
          summaryMd: "Need product input before refinement can continue.",
          questionsMd: "Should refinement prioritize calendar sharing or reminders?",
          riskMd: "The ceremony cannot produce useful child tickets without this choice.",
        },
      },
    });

    const run = store.createCeremonyRun("project_floop", {
      type: "refinement",
      participantRoles: ["product_manager"],
      deciderRole: "product_manager",
    });

    const driver = createCeremonyParticipantDriver({ store, logger: silentLogger(), maxParallel: 1 });
    await driver.pollOnce();

    const completed = store.getCeremonyRun("project_floop", run.id);
    const ceremonyQuestion = store
      .listAgentMessages("project_floop", { intent: "submit_ceremony_input", status: "pending" })
      .find((message) => message.target.runId === run.id);
    const ticketInputRequests = store.listAgentMessages("project_floop", {
      intent: "request_input",
      status: "pending",
    });

    assert.equal(completed.participants[0].outcome, "blocked");
    assert.ok(ceremonyQuestion);
    assert.equal(ceremonyQuestion.target.participantId, completed.participants[0].id);
    assert.equal(ceremonyQuestion.metadata.ceremonyHitlQuestion, true);
    assert.match(ceremonyQuestion.body, /calendar sharing or reminders/);
    assert.equal(ticketInputRequests.length, 0);
    assert.equal(
      store
        .getTicket("project_floop", "ticket_project_floop_2")
        .executions.some((execution) => execution.reason?.includes("calendar sharing")),
      false,
    );
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
