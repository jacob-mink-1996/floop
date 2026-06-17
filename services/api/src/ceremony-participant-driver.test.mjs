import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("ceremony participant driver writes structured project lookup context", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "floop-ceremony-context-"));
  const workspaceRoot = join(fixtureDir, "workspace");
  const store = createStore({
    filename: join(fixtureDir, "floop.sqlite"),
    seedDemo: true,
    workspaceRoot,
  });
  try {
    store.updateRoleProfile("project_floop", "product_manager", {
      adapter: "shell",
      model: "fixture",
      config: {
        command: `"${process.execPath}" -e "const fs=require('node:fs'); const context=JSON.parse(fs.readFileSync(process.env.FLOOP_CONTEXT_PATH,'utf8')); if (!context.projectContext?.tickets?.backlog || !context.projectContext.repositories?.length) process.exit(4); fs.writeFileSync(process.env.FLOOP_RESULT_PATH, JSON.stringify({ outcome: 'completed', summaryMd: 'PM saw project lookup context.' }));"`,
      },
    });
    const run = store.createCeremonyRun("project_floop", {
      type: "refinement",
      participantRoles: ["product_manager"],
      deciderRole: "product_manager",
    });

    const driver = createCeremonyParticipantDriver({ store, logger: silentLogger(), maxParallel: 1 });
    await driver.pollOnce();

    const context = JSON.parse(
      readFileSync(join(workspaceRoot, ".floop", "ceremonies", run.id, "product_manager", "context.json"), "utf8"),
    );
    const completed = store.getCeremonyRun("project_floop", run.id);

    assert.equal(completed.participants[0].outcome, "completed");
    assert.equal(context.projectContext.project.id, "project_floop");
    assert.equal(context.projectContext.tickets.backlog.length > 0, true);
    assert.equal(context.projectContext.lookupHints.length > 0, true);
  } finally {
    store.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("ceremony participant recommendations produce refinement proposals", async () => {
  const store = createStore({ filename: ":memory:", seedDemo: true });
  try {
    const broad = store.createTicket("project_floop", {
      title: "Build calendar collaboration",
      brief: "A broad product item that should be split before planning.",
      assignedRole: "product_manager",
      state: "PROPOSED",
    });
    const keeper = store.createTicket("project_floop", {
      title: "Add shared calendar invites",
      brief: "Invite other users to shared calendar events.",
      assignedRole: "developer",
      state: "PROPOSED",
    });
    const duplicate = store.createTicket("project_floop", {
      title: "Implement shared calendar invitations",
      brief: "Duplicate invite work that should be combined into the clearer ticket.",
      assignedRole: "developer",
      state: "PROPOSED",
    });
    const obsolete = store.createTicket("project_floop", {
      title: "Legacy invite experiment",
      brief: "Old experiment the PM wants removed.",
      assignedRole: "developer",
      state: "DRAFT",
    });
    store.updateRoleProfile("project_floop", "product_manager", {
      adapter: "mock",
      model: "fixture",
      config: {
        result: {
          outcome: "completed",
          summaryMd: "PM cleaned up the refinement backlog.",
          payload: {
            refinementRecommendations: [
              {
                type: "combine",
                keeperTicketId: keeper.id,
                duplicateTicketId: duplicate.id,
                reason: "Both tickets describe the same invite behavior.",
              },
              {
                type: "cancel",
                ticketId: obsolete.id,
                reason: "This experiment is obsolete.",
              },
              {
                type: "split",
                sourceTicketId: broad.id,
                reason: "Calendar collaboration is too broad for one implementation lane.",
                tickets: [
                  {
                    title: "Create shared calendar invite model",
                    brief: "Add the minimum data model for shared calendar invitations.",
                    acceptanceCriteriaMd: "- Invite records can be created",
                    assignedRole: "developer",
                  },
                ],
              },
              {
                type: "question",
                ticketId: broad.id,
                questionMd: "Should shared calendar invites require account login before acceptance?",
                reason: "Auth policy changes the implementation slice.",
              },
            ],
          },
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
    const cleanup = completed.proposals.find(
      (proposal) => proposal.kind === "ticket_backlog_cleanup" && proposal.payload.source === "participant_recommendations",
    );
    const split = completed.proposals.find(
      (proposal) => proposal.kind === "ticket_create" && proposal.payload.sourceTicketId === broad.id,
    );
    const question = store
      .listAgentMessages("project_floop", { intent: "submit_ceremony_input", status: "pending" })
      .find((message) => message.target.runId === run.id && message.target.ticketId === broad.id);

    assert.ok(cleanup);
    assert.equal(cleanup.payload.actions.some((action) => action.duplicateTicketKey === duplicate.key), true);
    assert.equal(cleanup.payload.actions.some((action) => action.ticketKey === obsolete.key), true);
    assert.ok(split);
    assert.equal(split.payload.ticket.parentTicketId, broad.id);
    assert.equal(split.payload.ticket.title, "Create shared calendar invite model");
    assert.ok(question);
    assert.equal(question.metadata.refinementQuestion, true);
    assert.equal(question.metadata.ceremonyHitlQuestion, true);
    assert.match(question.body, /require account login/);

    store.respondAgentMessage("project_floop", question.id, {
      responseMd: "Require account login for MVP invite acceptance.",
      responderKind: "human",
      responderRef: "operator",
      continueExecution: false,
    });

    const applied = store.applyCeremonyRun("project_floop", run.id, { proposalIds: [cleanup.id, split.id] });
    const createdSplitTicket = store.getTicket("project_floop", applied.proposals.find((proposal) => proposal.id === split.id).appliedTicketId);

    assert.equal(store.getTicket("project_floop", duplicate.id).state, "CANCELLED");
    assert.equal(store.getTicket("project_floop", obsolete.id).state, "CANCELLED");
    assert.equal(createdSplitTicket.parentTicketId, broad.id);
    assert.equal(
      store
        .getTicket("project_floop", broad.id)
        .events.some((event) => event.type === "agent.message_attached" && event.detail.includes("Require account login")),
      true,
    );
  } finally {
    store.close();
  }
});

test("answered refinement questions can ready split child tickets in autonomous refinement", async () => {
  const store = createStore({ filename: ":memory:", seedDemo: true });
  try {
    store.updateProjectPolicy("project_floop", {
      refinementMode: "autonomous",
      agentCreatedTicketDefaultState: "READY",
    });
    const broad = store.createTicket("project_floop", {
      title: "Build shared calendar collaboration",
      brief: "Split invitations and permissions into child implementation slices.",
      assignedRole: "product_manager",
      state: "PROPOSED",
    });
    store.updateRoleProfile("project_floop", "product_manager", {
      adapter: "mock",
      model: "fixture",
      config: {
        result: {
          outcome: "completed",
          summaryMd: "PM split the broad calendar idea.",
          payload: {
            refinementRecommendations: [
              {
                type: "split",
                sourceTicketId: broad.id,
                reason: "Invites are executable once auth scope is known.",
                tickets: [
                  {
                    title: "Create shared calendar invite model",
                    brief: "Build invite acceptance using the clarified auth decision.",
                    acceptanceCriteriaMd: "- Invite acceptance follows auth scope",
                    assignedRole: "developer",
                  },
                ],
              },
              {
                type: "question",
                ticketId: broad.id,
                questionMd: "Should invite acceptance require account login?",
                reason: "Auth scope gates executable invite work.",
              },
            ],
          },
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
    const split = completed.proposals.find(
      (proposal) => proposal.kind === "ticket_create" && proposal.payload.sourceTicketId === broad.id,
    );
    const question = store
      .listAgentMessages("project_floop", { intent: "submit_ceremony_input", status: "pending" })
      .find((message) => message.target.runId === run.id && message.target.ticketId === broad.id);
    assert.ok(split);
    assert.ok(question);

    store.respondAgentMessage("project_floop", question.id, {
      responseMd: "Require account login before invite acceptance.",
      responderKind: "human",
      responderRef: "operator",
      continueExecution: false,
    });
    store.applyCeremonyRun("project_floop", run.id, { proposalIds: [split.id] });
    const child = store.listTickets("project_floop", { parentTicketId: broad.id }).find((ticket) =>
      ticket.title === "Create shared calendar invite model",
    );

    assert.ok(child);
    assert.equal(store.getTicket("project_floop", child.id).state, "READY");
  } finally {
    store.close();
  }
});

test("pending refinement questions keep split child tickets proposed", async () => {
  const store = createStore({ filename: ":memory:", seedDemo: true });
  try {
    store.updateProjectPolicy("project_floop", {
      refinementMode: "autonomous",
      agentCreatedTicketDefaultState: "READY",
    });
    const broad = store.createTicket("project_floop", {
      title: "Build guest calendar links",
      brief: "Decide auth scope before executable guest-link work starts.",
      assignedRole: "product_manager",
      state: "PROPOSED",
    });
    store.updateRoleProfile("project_floop", "product_manager", {
      adapter: "mock",
      model: "fixture",
      config: {
        result: {
          outcome: "completed",
          summaryMd: "PM split guest links but still needs auth scope.",
          payload: {
            refinementRecommendations: [
              {
                type: "split",
                sourceTicketId: broad.id,
                tickets: [
                  {
                    title: "Create guest calendar link model",
                    brief: "Build the guest link model after auth scope is answered.",
                    assignedRole: "developer",
                  },
                ],
              },
              {
                type: "question",
                ticketId: broad.id,
                questionMd: "Are guest links allowed without login?",
              },
            ],
          },
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
    const split = completed.proposals.find(
      (proposal) => proposal.kind === "ticket_create" && proposal.payload.sourceTicketId === broad.id,
    );
    assert.ok(split);

    store.applyCeremonyRun("project_floop", run.id, { proposalIds: [split.id] });
    const child = store.listTickets("project_floop", { parentTicketId: broad.id }).find((ticket) =>
      ticket.title === "Create guest calendar link model",
    );

    assert.ok(child);
    assert.equal(store.getTicket("project_floop", child.id).state, "PROPOSED");
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
