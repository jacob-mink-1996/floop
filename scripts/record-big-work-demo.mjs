import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

import { createFloopServer } from "../services/api/src/app.mjs";
import { createCeremonyAutomationDriver } from "../services/api/src/ceremony-automation-driver.mjs";
import { createExecutionDriver } from "../services/api/src/execution-driver.mjs";
import { createMergeDriver } from "../services/api/src/merge-driver.mjs";
import { createStore } from "../services/api/src/store.mjs";
import { handleMcpRequest } from "./floop-mcp-server.mjs";
import {
  BIG_WORK_IDLE_DEFINITION,
  buildFailureProofMetadata,
  buildKeepRanges,
  buildTrimMetadata,
  buildTrimSuggestion,
  shouldRetainDemoFixture,
} from "./record-big-work-demo-lib.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadDotEnv();

const agentMode = selectAgentMode();
const mode = process.argv.includes("--record") ? "record" : "proof";
const openAfterRecord = process.argv.includes("--open");
const outputRoot = resolve(process.env.FLOOP_DEMO_OUTPUT_DIR || join(repoRoot, "demo-recordings"));
const fixtureRoot = mkdtempSync(join(tmpdir(), `floop-big-work-${agentMode}-${mode}-`));
const workspaceRoot = join(fixtureRoot, "workspace");
const targetRepoPath = join(fixtureRoot, "calendar-app");
const architectAgentPath = join(fixtureRoot, "calendar-architect-agent.cjs");
const plannerAgentPath = join(fixtureRoot, "calendar-planner-agent.cjs");
const developerAgentPath = join(fixtureRoot, "calendar-developer-agent.cjs");
const reviewerAgentPath = join(fixtureRoot, "calendar-reviewer-agent.cjs");
const validatorAgentPath = join(fixtureRoot, "calendar-validator-agent.cjs");
const dbPath = join(fixtureRoot, "floop.sqlite");
const recordingDir = join(outputRoot, `big-work-${agentMode}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const demoLogger = {
  info() {},
  warn(...args) {
    console.warn(...args);
  },
  error(...args) {
    console.error(...args);
  },
};

let store;
let server;
let executionDriver;
let mergeDriver;
let browser;
let context;
let appServer;
let completed = false;
let failureError = "";
let recordingStartedAt = Date.now();
const appDemoSnapshots = [];
const ceremonyShowcaseTypes = [];
const externalAgentProof = [];
let steeringCopyProof = null;
let lifecycleAutomationProof = null;
const timeline = {
  marks: [],
  idleRanges: [],
};

try {
  initializeCalendarRepo(targetRepoPath);
  if (agentMode === "fixture") {
    writeBigWorkAgents();
  }
  store = createStore({ filename: dbPath, seedDemo: false, workspaceRoot });
  server = createFloopServer({ store });
  await listen(server);
  const appUrl = `http://127.0.0.1:${server.address().port}`;
  executionDriver = createExecutionDriver({ store, pollIntervalMs: 150, maxAttempts: 1, logger: demoLogger });
  mergeDriver = createMergeDriver({ store, pollIntervalMs: 10000, logger: demoLogger });
  executionDriver.start();
  lifecycleAutomationProof = await buildLifecycleAutomationProof();

  if (mode === "record") {
    mkdirSync(recordingDir, { recursive: true });
  }

  browser = await chromium.launch({
    executablePath: "/usr/bin/chromium",
    headless: true,
    args: ["--disable-dev-shm-usage"],
  });
  context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    recordVideo:
      mode === "record"
        ? {
            dir: recordingDir,
            size: { width: 1440, height: 960 },
          }
        : undefined,
  });
  const page = await context.newPage();
  recordingStartedAt = Date.now();
  await installVisibleCursor(page);
  await runWalkthrough(page, appUrl);

  const proof = collectProof();
  assert.equal(proof.agentMode, agentMode);
  assert.equal(proof.projects.length, 1);
  assert.equal(proof.repos.length, 1);
  assert.equal(proof.ideaTickets.length, 1);
  assert.equal(proof.breakdownTickets.length, 1);
  assert.equal(proof.parentTickets.length, 1);
  assert.equal(proof.productAutopilotProof.enabled, true);
  assert.equal(proof.productAutopilotProof.ceremonyAutomationMode, "fully_automatic");
  assert.deepEqual(proof.productAutopilotProof.lifecycleAutomation.reasonCodesByType, {
    refinement: "messy_backlog_needs_refinement",
    planning: "ready_backlog_needs_planning",
    daily_triage: "blocked_or_rework_needs_triage",
    review_demo_prep: "done_work_needs_demo_prep",
    work_generation: "low_backlog_after_shipped_work_needs_generation",
    retro: "repeated_blocked_or_rework_needs_retro",
  });
  assert.deepEqual(proof.productAutopilotProof.lifecycleAutomation.triggeredTypes.sort(), [
    "daily_triage",
    "planning",
    "refinement",
    "retro",
    "review_demo_prep",
    "work_generation",
  ]);
  assert.equal(proof.featureTickets.length >= 4, true);
  assert.equal(proof.demoFeatureTickets.length >= 4, true);
  assert.equal(proof.executedFeatureTickets.length >= 1, true);
  assert.equal(proof.executedFeatureTickets.every((ticket) => ticket.state === "DONE"), true);
  assert.equal(proof.fullLoopProof.ideaToRefinement, true);
  assert.equal(proof.fullLoopProof.hitlAnswered, true);
  assert.equal(proof.fullLoopProof.refinementApplied, true);
  assert.equal(proof.fullLoopProof.reviewEvidenceComplete, true);
  assert.equal(proof.fullLoopProof.validationEvidenceComplete, true);
  assert.equal(proof.fullLoopProof.demoEvidenceComplete, true);
  assert.equal(proof.fullLoopProof.mergeEvidenceComplete, true);
  assert.equal(proof.fullLoopProof.idleCutMetadataComplete, true);
  assert.equal(proof.reviewCount >= proof.executedFeatureTickets.length, true);
  assert.equal(proof.validationCount >= proof.executedFeatureTickets.length, true);
  assert.equal(
    proof.executedFeatureTickets.every((ticket) => (proof.demoEvidenceByTicket[ticket.id] || []).length > 0),
    true,
  );
  assert.equal(proof.appDemoSnapshots.some((snapshot) => snapshot.stage === "final"), true);
  const proofedAgentConversations = proof.agentConversations.filter((conversation) => conversation.inputContext && conversation.result);
  assert.equal(proofedAgentConversations.length >= 8, true);
  if (agentMode === "codex") {
    const codexRoles = new Set(proof.roleProfiles.filter((profile) => profile.adapter === "codex").map((profile) => profile.role));
    const codexConversations = proofedAgentConversations.filter((conversation) => codexRoles.has(conversation.role));
    assert.equal(codexConversations.length >= 7, true);
    assert.equal(codexConversations.every((conversation) => conversation.prompt), true);
    assert.equal(codexRoles.size >= 3, true);
  }
  assert.equal(proof.appDemoSnapshots.some((snapshot) => snapshot.stage === "vertical"), true);
  assert.equal(proof.appDemoSnapshots.some((snapshot) => snapshot.stage === "final"), true);
  assert.deepEqual([...new Set(proof.ceremonyShowcaseTypes)].sort(), ["daily_triage", "planning", "refinement", "retro", "review_demo_prep", "work_generation"]);
  assert.equal(proof.externalAgentProof.some((entry) => entry.tool === "floop_append_agent_message"), true);
  assert.equal(proof.externalAgentProof.some((entry) => entry.tool === "floop_request_dispatch"), true);
  assert.equal(proof.externalAgentProof.some((entry) => entry.tool === "floop_attach_artifact"), true);
  assert.equal(proof.externalAgentProof.some((entry) => entry.tool === "floop_get_run_status"), true);
  assert.equal(proof.externalAgentProof.some((entry) => entry.tool === "external_agent_ingress"), true);
  assert.equal(proof.steeringCopyProof?.copiedNoteExists, true);
  assert.equal(proof.steeringCopyProof?.generatedDependencySkipped, true);
  assert.ok(proof.steeringCopyProof?.resumedFromWorktreeId, "Expected hard-steer resumed worktree lineage proof");
  assert.equal(proof.projectPolicy?.steeringWorktreePolicy, "copy_interrupted_worktree");
  assert.equal(proof.projectPolicy?.requireDemoEvidenceBeforeMerge, true);
  assert.equal(existsSync(join(targetRepoPath, "src", "server.mjs")), true);
  assert.equal(existsSync(join(targetRepoPath, "public", "index.html")), true);

  await context.close();
  context = null;
  await browser.close();
  browser = null;

  if (mode === "record") {
    const recordingDurationSeconds = Number(((Date.now() - recordingStartedAt) / 1000).toFixed(3));
    const finalizedVideo = finalizeVideo(recordingDir, proof.timeline.trimSuggestion, recordingDurationSeconds);
    writeFileSync(
      join(recordingDir, "proof.json"),
      JSON.stringify({
        appUrl,
        fixtureRoot,
        targetRepoPath,
        videoPath: finalizedVideo.videoPath,
        trimmedVideo: finalizedVideo.trimMetadata,
        ...proof,
      }, null, 2),
      "utf8",
    );
    console.log(`Recorded Floop big-work demo: ${finalizedVideo.videoPath}`);
    console.log(`Proof bundle: ${join(recordingDir, "proof.json")}`);
    if (openAfterRecord) {
      openRecording(finalizedVideo.videoPath);
    }
  } else {
    console.log("Playwright big-work proof passed");
    console.log(`Feature tickets: ${proof.featureTickets.map((ticket) => ticket.title).join(", ")}`);
    console.log(`Done tickets: ${proof.doneTickets.map((ticket) => ticket.key).join(", ")}`);
  }
  completed = true;
} catch (error) {
  failureError = error instanceof Error ? `${error.message}\n${error.stack || ""}`.trim() : String(error);
  throw error;
} finally {
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await stopAppServer();
  await mergeDriver?.stop().catch(() => {});
  await executionDriver?.stop().catch(() => {});
  await closeServer(server);
  const retainFixture = shouldRetainDemoFixture({
    completed,
    agentMode,
    keepFixture: process.env.FLOOP_DEMO_KEEP_FIXTURE === "true",
  });
  if (!completed) {
    writeFailureProof({ retainFixture, error: failureError });
  }
  store?.close();
  if (!completed && retainFixture) {
    console.error(`Codex big-work demo failed; retained fixture for inspection: ${fixtureRoot}`);
  } else if (!retainFixture) {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

async function runWalkthrough(page, appUrl) {
  await page.goto(appUrl);
  await page.getByText("No project selected").first().waitFor();
  await pause(500);

  await fillByName(page, "existingPath", targetRepoPath);
  await fillByName(page, "name", "Calendar Big Work Demo");
  await fillByName(page, "slug", "calendar-big-work");
  await fillByName(page, "defaultBaseBranch", "main");
  await fillByName(page, "description", "A greenfield calendar app decomposed into feature tickets and executed by Floop agents.");
  await clickByText(page, "Create project");
  await page.getByText("Calendar Big Work Demo").first().waitFor();
  await pause(700);

  const project = store.listProjects()[0];
  const repo = store.listRepos(project.id)[0];
  assert.ok(project && repo, "Expected project and repo");
  await updateProject(project.id, { workspaceRoot });
  await configureAgents(project.id);
  await showNewFeatureSettings(page);

  const architectureTicket = store.createTicket(project.id, {
    title: "Define calendar system architecture",
    brief: "Work with the PM goal to define backend, frontend, validation, and delivery boundaries before feature breakdown.",
    acceptanceCriteriaMd:
      "- Architecture notes describe API, UI, recurrence, reminders, and validation boundaries.\n- PM can use the notes to create feature tickets.",
    definitionOfDoneMd: "- docs/calendar-architecture.md is committed.",
    state: "READY",
    priority: "high",
    assignedRole: "architect",
    repoTargets: [
      {
        repoId: repo.id,
        baseRef: "main",
        branchName: "calendar-system-architecture",
        targetScopeMd: "Pre-planning architecture notes for the calendar application.",
      },
    ],
  });

  await refresh(page);
  await clickByText(page, "Board");
  await page.getByText(architectureTicket.title).first().waitFor();
  await pause(700);
  store.createExecution(project.id, architectureTicket.id, {
    role: "architect",
    reason: "Pre-planning conversation: define the system boundaries before PM feature breakdown.",
  });
  await waitDuringIdle("architect codex pre-planning", () =>
    waitForTicketAtOrPast(architectureTicket.title, "REVIEWING", agentWaitMs(20_000, 360_000)),
  );
  await waitDuringIdle("architect codex review", () =>
    waitForTicketAtOrPast(architectureTicket.title, "VALIDATING", agentWaitMs(20_000, 360_000)),
  );
  await waitDuringIdle("architect codex validation", () =>
    waitForTicketState(architectureTicket.title, "READY_TO_MERGE", agentWaitMs(20_000, 360_000)),
  );
  await mergeTicketNow(project.id, architectureTicket.title);
  await waitForTicketState(architectureTicket.title, "DONE", 10_000);
  await refresh(page);
  await pause(700);

  const ideaTicket = store.createTicket(project.id, {
    title: "Build a calendar application with frontend and backend",
    brief:
      "Plan and deliver a greenfield calendar app with a dependency-free Node backend, browser UI, event creation, recurring event rules, reminders, and validation coverage.",
    acceptanceCriteriaMd:
      "- Feature tickets cover a runnable vertical slice, recurring event rules, reminders, final integration, and validation.\n- The first vertical slice can run locally with a Node HTTP API and browser UI.\n- The final app exposes GET /api/events and POST /api/events, renders a Team schedule UI, provides title and startsAt form controls, and includes an Add event action.\n- Validation coverage proves API behavior, event creation, recurrence, reminders, and final integration.\n- Each validation produces demo evidence as an artifact so the feature is demonstrable before merge.\n- Floop records agent proof for decomposition, implementation, review, validation, and demo evidence.",
    definitionOfDoneMd:
      "- Child feature tickets exist with enough acceptance criteria for autonomous implementation.\n- The vertical slice is implemented, reviewed, validated with demo evidence, and merged.\n- Recurrence, reminders, and final integration tickets are implemented, reviewed, validated with demo evidence, and merged.",
    state: "READY",
    priority: "urgent",
    assignedRole: "product_manager",
    repoTargets: [
      {
        repoId: repo.id,
        baseRef: "main",
        branchName: "calendar-big-work-breakdown",
        targetScopeMd: "Break the calendar application goal into feature tickets.",
      },
    ],
  });

  await refresh(page);
  await clickByText(page, "Board");
  await page.getByText(ideaTicket.title).first().waitFor();
  await pause(1000);
  await exerciseTicketHitl(page, project.id, ideaTicket);
  await startProductAutopilotFromUi(page, ideaTicket.title);
  const breakdownTicket = await waitForProductBreakdownTicket(project.id, ideaTicket.id);
  const featureTickets = await waitDuringIdle("product manager codex feature breakdown", () =>
    waitForFeatureTickets(project.id, breakdownTicket.id, 4),
  );
  await waitForTicketRoleExecutionOutcome(
    project.id,
    breakdownTicket.id,
    "product_manager",
    ["completed", "followup_created"],
    agentWaitMs(12_000, 180_000),
  );
  await closeTicketDetail(page);
  await clickByText(page, "Cockpit");
  await page.getByText("Product Run").first().waitFor();
  await page.getByText("Fully Autonomous").first().waitFor();
  await pause(1200);
  await runBacklogRefinement(page, project.id, featureTickets);
  const demoTickets = resolveDemoFeatureTickets(featureTickets);
  await runCeremonyShowcase(page, project.id);
  await exerciseExternalAgentActions(page, project.id, repo.id, demoTickets.vertical);
  await exerciseHardSteerCopy(page, project.id, repo.id);
  await refresh(page);
  await clickByText(page, "Board");
  await page.getByText(demoTickets.vertical.title).first().waitFor();
  await page.getByText(demoTickets.recurrence.title).first().waitFor();
  await pause(1200);

  await clickByText(page, "Cockpit");
  await page.getByText("Agent Work").first().waitFor();
  await maybeOpenRunProof(page, "architect iteration 1", { fallbackToVisibleExecution: true });
  await pause(1600);
  await closeAnyOpenRunProof(page);
  await maybeOpenRunProof(page, "product_manager iteration 1", { fallbackToVisibleExecution: true });
  await pause(2200);

  await closeAnyOpenRunProof(page);
  await clickByText(page, "Board");
  for (const prerequisite of demoTickets.prerequisites) {
    await runTicketLoopFromUi(page, project.id, prerequisite, {
      summary: "Operator starts the next prerequisite slice for the visible product workflow.",
    });
  }
  await runTicketLoopFromUi(page, project.id, demoTickets.vertical, {
    summary: "Operator starts the visible calendar workflow slice.",
  });
  await waitForTicketState(demoTickets.vertical, "DONE", 45_000);
  await page.getByText("Done").first().waitFor();
  await pause(1000);
  await demoCalendarApp(page, appUrl, "vertical");

  await demoCalendarApp(page, appUrl, "final");

  await clickByText(page, "Cockpit");
  await page.getByText("Agent Work").first().waitFor();
  await maybeOpenRunProof(page, "developer iteration 1", { fallbackToVisibleExecution: true });
  await pause(2200);
  await page.locator(".agent-trace-summary").first().waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  await pause(800);
}

async function configureAgents(projectId) {
  await updateProjectPolicy(projectId, {
    requireReviewer: true,
    requireValidator: true,
    requireHumanApprovalBeforeMerge: false,
    requiredValidationCommandProfileForMerge: "ci",
    requireDemoEvidenceBeforeMerge: true,
    maxParallelExecutions: 4,
    maxParallelMerges: 2,
    maxAutoContinueIterations: 3,
    interactionMode: "autopilot",
    refinementMode: "autonomous",
    steeringWorktreePolicy: "copy_interrupted_worktree",
    agentCreatedTicketDefaultState: "READY",
  });

  const profiles =
    agentMode === "codex"
      ? codexProfiles()
      : {
          architect: commandFromEnv("architect", architectCommand()),
          product_manager: commandFromEnv("product_manager", productManagerCommand()),
          developer: commandFromEnv("developer", developerCommand()),
          reviewer: commandFromEnv("reviewer", reviewerCommand()),
          validator: commandFromEnv("validator", validatorCommand()),
          integrator: commandFromEnv("integrator", passthroughCommand("integrator")),
        };

  for (const [role, command] of Object.entries(profiles)) {
    await updateRoleProfile(projectId, role, command);
  }
}

async function showNewFeatureSettings(page) {
  await clickByText(page, "Settings");
  await page.getByText("Delivery Policy").first().waitFor();
  await clickByText(page, "Policy settings");
  const steeringSelect = page.locator('select[name="steeringWorktreePolicy"]').first();
  await steeringSelect.waitFor({ state: "visible" });
  await steeringSelect.selectOption("copy_interrupted_worktree");
  assert.equal(
    await steeringSelect.evaluate((select) =>
      Array.from(select.options).some((option) => option.value === "copy_interrupted_worktree"),
    ),
    true,
  );
  await clickByText(page, "Show profiles");
  await page.locator(".profile-matrix").first().scrollIntoViewIfNeeded();
  await page.getByText("Codex SDK bridge").first().waitFor({ state: "visible" });
  await page.getByText("Codex MCP bridge").first().waitFor({ state: "visible" });
  await clickByText(page, "Codex SDK bridge");
  await page.getByText("Bridge command is required").first().waitFor({ timeout: 2000 }).catch(() => {});
  await pause(1200);
  await clickByText(page, agentMode === "codex" ? "Codex" : "Shell");
  await pause(600);
  await clickByText(page, "Close settings");
  await page.locator(".settings-drawer").waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
}

async function runCeremonyShowcase(page, projectId) {
  const ceremonyTypes = ["refinement", "planning", "daily_triage", "review_demo_prep", "work_generation", "retro"];
  for (const type of ceremonyTypes) {
    store.createCeremonyRun(projectId, {
      type,
      createdByKind: "demo",
      createdByRef: "new-feature-recorder",
    });
    ceremonyShowcaseTypes.push(type);
    await pause(120);
  }
  await refresh(page);
  await clickByText(page, "Ceremonies");
  await page.locator(".constellation-stage").first().waitFor({ state: "visible" });
  for (const label of ["Refinement", "Planning", "Daily triage", "Review/demo prep", "Work generation", "Retro"]) {
    await clickByText(page, label);
    await pause(450);
  }
  await page.getByText("History").first().waitFor();
  await pause(1600);
}

async function buildLifecycleAutomationProof() {
  const proofStore = createStore({
    filename: ":memory:",
    seedDemo: false,
    workspaceRoot: join(fixtureRoot, "lifecycle-proof-workspace"),
  });
  try {
    const project = proofStore.createProject({
      name: "Lifecycle Proof",
      slug: "lifecycle-proof",
      workspaceRoot: join(fixtureRoot, "lifecycle-proof-workspace"),
      defaultBaseBranch: "main",
    });
    proofStore.updateProjectPolicy(project.id, {
      interactionMode: "fully_autonomous",
      ceremonyAutomation: {
        enabled: true,
        mode: "fully_automatic",
        triggers: {
          refinement: {
            enabled: true,
            onTicketCreatedStates: ["DRAFT", "PROPOSED"],
            minIntervalMinutes: 1,
            participantRoles: ["product_manager", "architect", "developer", "reviewer"],
            deciderRole: "product_manager",
            consensusPolicy: "decider_synthesizes_objections",
          },
          planning: {
            enabled: true,
            onReadyQueueChanged: true,
            onCapacityAvailable: true,
            minIntervalMinutes: 1,
            participantRoles: ["product_manager", "architect", "developer", "integrator"],
            deciderRole: "integrator",
            consensusPolicy: "decider_synthesizes_objections",
          },
          daily_triage: {
            enabled: true,
            onActiveWorkCheckIn: true,
            onBlockedOrRework: true,
            minIntervalMinutes: 1,
            participantRoles: ["product_manager", "developer", "reviewer", "validator"],
            deciderRole: "product_manager",
            consensusPolicy: "blockers_and_stale_work_win",
          },
          review_demo_prep: {
            enabled: true,
            onDoneOrMergeReady: true,
            minIntervalMinutes: 1,
            participantRoles: ["product_manager", "reviewer", "validator", "integrator"],
            deciderRole: "reviewer",
            consensusPolicy: "only_evidence_backed_done_work_is_demoable",
          },
          work_generation: {
            enabled: true,
            onSprintEndPlanning: true,
            onReadyBacklogBelow: 2,
            minIntervalMinutes: 1,
            participantRoles: ["product_manager", "architect", "developer", "reviewer"],
            deciderRole: "product_manager",
            consensusPolicy: "decider_synthesizes_objections",
          },
          retro: {
            enabled: true,
            onRepeatedBlockedOrReworkCount: 2,
            onCycleComplete: true,
            minIntervalMinutes: 1,
            participantRoles: ["product_manager", "architect", "developer", "reviewer", "validator"],
            deciderRole: "product_manager",
            consensusPolicy: "recurring_systemic_risk_wins",
          },
        },
      },
    });

    const states = [
      ["Lifecycle proof draft", "PROPOSED"],
      ["Lifecycle proof ready", "READY"],
      ["Lifecycle proof shipped", "DONE"],
      ["Lifecycle proof blocked", "BLOCKED"],
      ["Lifecycle proof rework", "REWORK"],
    ];
    for (const [title, state] of states) {
      proofStore.createTicket(project.id, {
        title,
        brief: `${title} ticket for state-driven ceremony proof.`,
        assignedRole: "developer",
        state,
      });
    }

    const driver = createCeremonyAutomationDriver({ store: proofStore, pollIntervalMs: 25, logger: demoLogger });
    const created = await driver.pollOnce();
    const runs = proofStore.listCeremonyRuns(project.id) || [];
    const lifecycleRuns = runs
      .filter((run) => run.scope?.trigger === "lifecycle")
      .map((run) => ({
        id: run.id,
        type: run.type,
        status: run.status,
        reasonCode: run.scope?.lifecycleReason?.code || "",
        reasonSummary: run.scope?.lifecycleReason?.summary || "",
        evidence: run.scope?.lifecycleReason?.evidence || {},
      }));
    return {
      projectId: project.id,
      createdCount: created.length,
      triggeredTypes: lifecycleRuns.map((run) => run.type),
      reasonCodesByType: Object.fromEntries(lifecycleRuns.map((run) => [run.type, run.reasonCode])),
      lifecycleRuns,
    };
  } finally {
    proofStore.close();
  }
}

async function exerciseExternalAgentActions(page, projectId, repoId, dispatchTicket) {
  const externalDispatchTicket = store.createTicket(projectId, {
    title: "Handle external agent dispatch proof",
    brief: "Isolated no-repo proof ticket for an external agent dispatch request in fully autonomous mode.",
    acceptanceCriteriaMd: "- External dispatch request is recorded.\n- Fully autonomous mode may auto-start the requested lane without blocking feature work.",
    definitionOfDoneMd: "- Proof is visible in the run history or agent inbox artifacts.",
    state: "READY",
    priority: "low",
    assignedRole: "integrator",
    repoTargets: [],
  });
  const ticketSuggestion = await callMcpTool("floop_append_agent_message", {
    projectId,
    actor: "openclaw",
    source: "mcp",
    intent: "suggest_ticket",
    summary: "Add MCP status badge to the calendar demo",
    body: "External agent noticed the demo should show MCP-created work in the Attention queue.",
    target: { repoId },
    metadata: { role: "developer", confidence: 0.88 },
  });
  externalAgentProof.push({ tool: "floop_append_agent_message", result: ticketSuggestion });

  const dispatchSuggestion = await callMcpTool("floop_request_dispatch", {
    projectId,
    ticketId: externalDispatchTicket.id,
    role: "integrator",
    actor: "hermes",
    summary: "Run the isolated MCP dispatch proof lane",
    body: "This demonstrates an external agent dispatch suggestion that can auto-start in fully autonomous mode without touching feature work.",
  });
  externalAgentProof.push({ tool: "floop_request_dispatch", result: dispatchSuggestion });

  const artifactSuggestion = await callMcpTool("floop_attach_artifact", {
    projectId,
    ticketId: dispatchTicket.id,
    actor: "hermes",
    kind: "demo",
    label: "MCP smoke proof",
    uri: `file://${targetRepoPath}/README.md`,
    metadata: { demoEvidence: true, source: "mcp-demo" },
  });
  externalAgentProof.push({ tool: "floop_attach_artifact", result: artifactSuggestion });

  const statusResult = await callMcpTool("floop_get_run_status", {
    projectId,
    limit: 6,
  });
  externalAgentProof.push({ tool: "floop_get_run_status", result: statusResult });

  const ingressResult = await fetchJson(`/api/v1/projects/${projectId}/external-agent-messages`, {
    method: "POST",
    body: {
      protocol: "acp",
      actor: "openclaw",
      action: "comment",
      target: { ticketId: dispatchTicket.id },
      summary: "ACP-style calendar demo note",
      body: "External ingress mapped this ACP-style comment into the native ticket conversation.",
      metadata: { proof: "mvp2_external_ingress" },
    },
  });
  assert.equal(ingressResult.message.intent, "comment_on_ticket");
  assert.equal(ingressResult.message.metadata.externalAgent, true);
  assert.equal(ingressResult.message.metadata.externalProtocol, "acp");
  externalAgentProof.push({ tool: "external_agent_ingress", result: ingressResult });

  await refresh(page);
  await clickByText(page, "Cockpit");
  await page.getByText("Attention").first().waitFor();
  const suggestionVisible = await page.getByText("Add MCP status badge to the calendar demo").first().isVisible({ timeout: 3000 }).catch(() => false);
  const dispatchVisible = await page.getByText("Run the isolated MCP dispatch proof lane").first().isVisible({ timeout: 3000 }).catch(() => false);
  if (suggestionVisible) {
    await page.getByText("Create ticket").first().waitFor();
  } else {
    assert.ok(
      store.listTickets(projectId).some((ticket) => ticket.title === "Add MCP status badge to the calendar demo"),
      "Expected fully autonomous mode to auto-create the external suggested ticket",
    );
  }
  if (dispatchVisible) {
    await page.getByText("Dispatch").first().waitFor();
  } else {
    assert.ok(
      store
        .listProjectExecutions(projectId, { limit: 100 })
        .some((execution) => execution.ticketId === externalDispatchTicket.id && execution.role === "integrator"),
      "Expected fully autonomous mode to auto-start the isolated external dispatch ticket",
    );
  }
  await pause(1800);
  if (suggestionVisible) {
    await clickByText(page, "Create ticket");
    await waitForTextGone(page, "Add MCP status badge to the calendar demo", 10_000).catch(() => {});
  }
  finishExternalDispatchProof(projectId, externalDispatchTicket.id);
  await pause(800);
}

function finishExternalDispatchProof(projectId, ticketId) {
  for (const execution of store.listProjectExecutions(projectId, { limit: 100 })) {
    if (execution.ticketId === ticketId && !execution.finishedAt) {
      store.cancelExecution(projectId, execution.id, {
        reason: "External dispatch delivery was recorded; stop synthetic follow-up lanes for the demo.",
      });
    }
  }
  const ticket = store.getTicket(projectId, ticketId);
  if (ticket && ticket.state !== "DONE") {
    store.transitionTicket(projectId, ticketId, {
      targetState: "DONE",
      reason: "External agent dispatch proof completed.",
      reasonCode: "demo_external_dispatch_proof_complete",
      reasonSource: "demo",
    });
  }
}

async function exerciseHardSteerCopy(page, projectId, repoId) {
  await executionDriver.stop();
  try {
    gitSync(["-C", targetRepoPath, "branch", "calendar-steering-copy-proof", "main"], { stdio: "ignore" });
  } catch {
    // The proof branch may exist if a retained fixture is replayed.
  }
  const ticket = store.createTicket(projectId, {
    title: "Demonstrate hard steer worktree copy policy",
    brief: "Create a short active execution, steer it through the MCP facade, and prove copied interrupted worktree context reaches the resumed execution.",
    acceptanceCriteriaMd:
      "- Hard steer records a steering comment.\n- Resumed execution records resumedFromWorktreeId and lineageId.\n- Copied worktree contains notes/steer-context.md and skips node_modules.",
    definitionOfDoneMd: "- Steering copy proof is visible in Agent Work and proof.json.",
    state: "READY",
    priority: "medium",
    assignedRole: "integrator",
    repoTargets: [
      {
        repoId,
        baseRef: "main",
        branchName: "calendar-steering-copy-proof",
        targetScopeMd: "Short proof ticket for hard-steer copy-worktree policy.",
      },
    ],
  });
  const execution = store.createExecution(projectId, ticket.id, {
    role: "integrator",
    reason: "Start a short execution so the demo can steer it.",
  });
  const sourceWorktree = execution.worktrees[0];
  mkdirSync(join(sourceWorktree.path, "notes"), { recursive: true });
  mkdirSync(join(sourceWorktree.path, "node_modules"), { recursive: true });
  writeFileSync(join(sourceWorktree.path, "notes", "steer-context.md"), "Operator steer context copied from the interrupted worktree.\n", "utf8");
  writeFileSync(join(sourceWorktree.path, "node_modules", "skip.txt"), "generated dependency noise\n", "utf8");
  store.updateExecutionHarnessSession(projectId, execution.id, {
    harnessKind: "codex_exec",
    externalThreadId: "codex-thread-recorder-steer",
    harnessCapabilities: ["queued_context", "interrupt_and_resume"],
  });

  const steerResult = await callMcpTool("floop_steer_execution", {
    projectId,
    executionId: execution.id,
    actor: "openclaw",
    source: "mcp",
    body: "Keep the copied operator note and finish the proof without touching generated dependencies.",
    mode: "hard_steer",
  });
  const resumedExecutionId = steerResult.steering?.delivery?.resumedExecutionId || steerResult.delivery?.resumedExecutionId || "";
  assert.ok(resumedExecutionId, "Expected MCP steer tool to resume the execution");
  const steeringProofDriver = createExecutionDriver({
    store,
    pollIntervalMs: 150,
    maxAttempts: 1,
    logger: demoLogger,
  });
  await waitDuringIdle("hard steer resumed execution copy proof", async () => {
    await steeringProofDriver.pollOnce();
    return waitForExecutionOutcome(projectId, resumedExecutionId, "completed", agentWaitMs(12_000, 120_000));
  });
  executionDriver.start();
  const resumed = store.getExecution(projectId, resumedExecutionId);
  const resumedWorktree = resumed.worktrees[0];
  steeringCopyProof = {
    originalExecutionId: execution.id,
    resumedExecutionId,
    resumedFromWorktreeId: resumedWorktree.resumedFromWorktreeId,
    lineageId: resumedWorktree.lineageId,
    copiedNoteExists: existsSync(join(resumedWorktree.path, "notes", "steer-context.md")),
    generatedDependencySkipped: !existsSync(join(resumedWorktree.path, "node_modules", "skip.txt")),
    delivery: steerResult.steering?.delivery || steerResult.delivery || {},
  };
  store.transitionTicket(projectId, ticket.id, {
    targetState: "DONE",
    reason: "Hard steer copy proof completed and recorded for the demo.",
    reasonCode: "demo_steering_copy_proof_complete",
    reasonSource: "demo",
  });
  for (const proofExecution of store.listProjectExecutions(projectId, { limit: 50 })) {
    if (proofExecution.ticketId === ticket.id && proofExecution.id !== execution.id && proofExecution.id !== resumedExecutionId && !proofExecution.finishedAt) {
      store.cancelExecution(projectId, proofExecution.id, {
        reason: "Synthetic steering proof ticket is complete; skip automatic follow-up lanes.",
      });
    }
  }

  await refresh(page);
  await clickByText(page, "Board");
  await clickByText(page, ticket.title);
  await page.getByText(/Execution dock/i).first().waitFor();
  await page.getByText("Steering from openclaw").first().waitFor({ timeout: 5000 }).catch(() => {});
  await pause(1400);
  await closeTicketDetail(page);
  await clickByText(page, "Cockpit");
  await openRunProof(page, "integrator iteration 2").catch(() => {});
  await pause(1400);
  await closeAnyOpenRunProof(page);
}

function selectAgentMode() {
  if (process.argv.includes("--fixture-agents")) return "fixture";
  if (process.argv.includes("--codex")) return "codex";
  const configured = String(process.env.FLOOP_BIG_WORK_AGENT_MODE || "").trim().toLowerCase();
  if (configured === "fixture" || configured === "local") return "fixture";
  return "codex";
}

function codexProfiles() {
  const promptPreamble = demoCodexPreamble();
  return {
    architect: codexProfile("architect", promptPreamble),
    product_manager: codexProfile("product_manager", promptPreamble),
    developer: codexProfile("developer", promptPreamble),
    reviewer: codexProfile("reviewer", promptPreamble),
    validator: codexProfile("validator", promptPreamble),
    integrator: passthroughCommand("integrator"),
  };
}

function codexProfile(role, promptPreamble) {
  const normalized = role.toUpperCase();
  return {
    adapter: "codex",
    model: process.env[`FLOOP_BIG_WORK_${normalized}_MODEL`] || process.env.FLOOP_BIG_WORK_CODEX_MODEL || "codex-latest",
    config: {
      executable: process.env.FLOOP_BIG_WORK_CODEX_EXECUTABLE || "codex",
      sandbox: process.env.FLOOP_BIG_WORK_CODEX_SANDBOX || "workspace-write",
      approvalPolicy: process.env.FLOOP_BIG_WORK_CODEX_APPROVAL_POLICY || "never",
      ignoreUserConfig: process.env.FLOOP_BIG_WORK_CODEX_IGNORE_USER_CONFIG !== "0",
      promptPreamble,
    },
  };
}

function demoCodexPreamble() {
  return [
    "This execution is for a recorded Floop big-work demo. Act autonomously and do not ask the operator questions unless the ticket is truly blocked.",
    "Treat the ticket brief, acceptance criteria, definition of done, and Floop lane guidance as the source of truth.",
    "Keep the generated calendar project dependency-free unless the ticket explicitly requires otherwise.",
    "Codex demo executions may run in a sandbox where socket listener creation is denied. Do not make required validation depend on server.listen, TCP ports, or Unix sockets; test domain logic and route/handler behavior directly, and leave live server/browser smoke to the Floop recorder.",
    "If git add or commit fails only because linked worktree Git metadata is read-only, do not treat the feature work as product-blocked. Return outcome \"needs_continue\" or \"blocked\" with blockedKind \"environment_git_read_only\" and describe the implemented dirty worktree so Floop can recover the commit from outside the sandbox.",
    "Never run watch modes, unbounded servers, or smoke commands that can wait indefinitely; every validation command should complete on its own.",
    "Do not launch browser automation, MCP servers, or interactive tooling unless the ticket explicitly requires that tool; prefer direct file edits and bounded tests for implementation lanes.",
    "Emit concrete progress in stdout or your final message so Floop's work log can prove that work happened.",
  ].join("\n");
}

function architectCommand() {
  return {
    adapter: "shell",
    model: "local-shell-calendar-architect",
    config: {
      command: `${quote(process.execPath)} ${quote(architectAgentPath)}`,
    },
  };
}

function productManagerCommand() {
  return {
    adapter: "shell",
    model: "local-shell-planner",
    config: {
      command: `${quote(process.execPath)} ${quote(plannerAgentPath)}`,
    },
  };
}

function developerCommand() {
  return {
    adapter: "shell",
    model: "local-shell-calendar-developer",
    config: {
      command: `${quote(process.execPath)} ${quote(developerAgentPath)}`,
    },
  };
}

function reviewerCommand() {
  return {
    adapter: "shell",
    model: "local-shell-calendar-reviewer",
    config: {
      command: `${quote(process.execPath)} ${quote(reviewerAgentPath)}`,
    },
  };
}

function validatorCommand() {
  return {
    adapter: "shell",
    model: "local-shell-calendar-validator",
    config: {
      command: `${quote(process.execPath)} ${quote(validatorAgentPath)}`,
    },
  };
}

function passthroughCommand(role) {
  return {
    adapter: "shell",
    model: `local-shell-${role}`,
    config: {
      command: nodeEvalCommand(`
        const fs = require("node:fs");
        console.log("[agent] " + process.env.FLOOP_EXECUTION_ROLE + " completed passthrough lane");
        fs.writeFileSync(process.env.FLOOP_RESULT_PATH, JSON.stringify({
          outcome: "completed",
          summaryMd: process.env.FLOOP_EXECUTION_ROLE + " lane completed."
        }));
      `),
    },
  };
}

function commandFromEnv(role, fallback) {
  const normalized = role.toUpperCase();
  const command =
    process.env[`FLOOP_BIG_WORK_${normalized}_COMMAND`] ||
    process.env[`FLOOP_DEMO_${normalized}_COMMAND`] ||
    process.env[`FLOOP_AGENT_${normalized}_COMMAND`] ||
    "";
  if (!command.trim()) return fallback;
  return {
    adapter: "shell",
    model: `env-${role}`,
    config: { command },
  };
}

async function exerciseTicketHitl(page, projectId, ticket) {
  const request = store.createAgentMessage(projectId, {
    actor: "floop",
    source: "demo_hitl",
    intent: "request_input",
    target: { ticketId: ticket.id, role: "product_manager" },
    summary: `${ticket.key} calendar scope question`,
    body: "Should the calendar demo assume a team schedule in the operator's local timezone, or should it support per-event timezone selection in the first pass?",
    metadata: {
      blockedKind: "needs_product_decision",
      questionMd:
        "Should the calendar demo assume a team schedule in the operator's local timezone, or should it support per-event timezone selection in the first pass?",
      role: "product_manager",
      suggestedResponders: ["human", "product_manager", "architect"],
      formSchema: {
        fields: [
          {
            id: "responseMd",
            type: "textarea",
            label: "Response",
            required: true,
            placeholder: "Give the scope decision the PM should use.",
          },
        ],
        submitLabel: "Submit and continue",
      },
    },
  });
  store.createAgentMessage(projectId, {
    actor: "floop",
    source: "demo_hitl",
    intent: "comment_on_ticket",
    target: { ticketId: ticket.id, requestInputMessageId: request.id },
    summary: `${ticket.key} blocked question`,
    body: request.body,
    metadata: {
      requestInputMessageId: request.id,
      blockedKind: "needs_product_decision",
      role: "product_manager",
      hitlQuestion: true,
    },
  });

  await refresh(page);
  await clickByText(page, "Board");
  await clickByText(page, ticket.title);
  await page.getByText("Waiting for answer").first().waitFor();
  await fillByName(page, "body", "Use the operator's local timezone for the first pass. Keep timezone selection as a follow-up so the demo stays focused on event creation, recurrence, reminders, and validation evidence.");
  await clickByText(page, "Reply and continue");
  await page.getByText("Response to").first().waitFor({ timeout: 10_000 }).catch(() => {});
  await pause(1200);
  await closeTicketDetail(page);
}

async function startProductAutopilotFromUi(page, title) {
  await refresh(page);
  await clickByText(page, "Board");
  await clickByText(page, title);
  await page.getByText("Product Autopilot").first().waitFor();
  await page.getByText("Start from this idea").first().waitFor();
  await page.getByText("Start Product Autopilot").first().click();
  await page.getByText(/Product run started|Start Product Autopilot|Starting Product Autopilot/).first().waitFor({ timeout: 10_000 }).catch(() => {});
  await pause(1200);
}

async function runBacklogRefinement(page, projectId, featureTickets) {
  const featureTicketIds = new Set(featureTickets.map((ticket) => ticket.id));
  for (const ticket of featureTickets) {
    store.transitionTicket(projectId, ticket.id, {
      targetState: "PROPOSED",
      reason: "Queued for backlog refinement before execution.",
      reasonCode: "demo_backlog_refinement_queue",
      reasonSource: "demo",
    });
  }
  const ceremony = store.createCeremonyRun(projectId, {
    type: "refinement",
    createdByKind: "human",
    createdByRef: "demo-operator",
    participantRoles: ["product_manager", "architect", "developer", "reviewer"],
    deciderRole: "product_manager",
    consensusPolicy: "decider_synthesizes_objections",
    scope: {
      ticketIds: Array.from(featureTicketIds),
      purpose: "Refine the PM-created calendar feature backlog before dispatch.",
    },
  });
  store.applyCeremonyRun(projectId, ceremony.id);
  for (const ticket of featureTickets) {
    store.transitionTicket(projectId, ticket.id, {
      targetState: "READY",
      reason: "Backlog refinement complete; feature is ready for agent execution.",
      reasonCode: "demo_backlog_refinement_ready",
      reasonSource: "demo",
    });
  }

  await refresh(page);
  await clickByText(page, "Cockpit");
  await page.getByText("Attention").first().waitFor();
  await pause(1600);
  await clickByText(page, "Board");
}

async function runTicketLoopFromUi(page, projectId, ticket, options = {}) {
  const title = ticketTitle(ticket);
  if ((await page.locator(".ticket-detail:visible").count()) === 0) {
    await clickByText(page, "Board");
    await clickByText(page, ticketKey(ticket));
  }
  await page.getByText("Start developer lane").first().waitFor();
  await fillByName(page, "summary", options.summary || "Operator starts the first implementation slice.");
  await clickByText(page, "Dispatch agent");
  const firstState = await waitForTicketInStates(ticket, ["WORKING", "REVIEWING", "VALIDATING", "READY_TO_MERGE", "DONE"], agentWaitMs(12_000, 90_000));
  if (firstState.state === "WORKING") {
    await revealTicketState(page, ticket, "Working");
  }
  await pause(1600);
  await waitDuringIdle(`${title} developer implementation`, () =>
    waitForTicketAtOrPast(ticket, "REVIEWING", featureLoopWaitMs()),
  );
  await tryRevealTicketState(page, ticket, "Reviewing");
  await pause(1000);
  await waitDuringIdle(`${title} independent review`, () =>
    waitForTicketAtOrPast(ticket, "VALIDATING", featureLoopWaitMs()),
  );
  await tryRevealTicketState(page, ticket, "Validating");
  await pause(1000);
  await waitDuringIdle(`${title} independent validation`, () =>
    waitForTicketState(ticket, "READY_TO_MERGE", featureLoopWaitMs()),
  );
  await revealTicketState(page, ticket, "Ready to merge");
  await pause(1000);
  await mergeTicketNow(projectId, ticket);
  await waitForTicketState(ticket, "DONE", 30_000);
  await revealTicketState(page, ticket, "Done");
  await pause(1200);
  await closeTicketDetail(page);
  await pause(500);
}

async function revealTicketState(page, ticket, label) {
  try {
    await page.getByText(label).first().waitFor({ timeout: 3500 });
    return;
  } catch {
    await closeTicketDetail(page);
    await refresh(page);
    await clickByText(page, "Board");
    await clickByText(page, ticketKey(ticket));
    await page.getByText(label).first().waitFor({ timeout: 10_000 });
  }
}

async function tryRevealTicketState(page, ticket, label) {
  try {
    await revealTicketState(page, ticket, label);
  } catch {
    await refresh(page);
    await clickByText(page, "Board");
    await clickByText(page, ticketKey(ticket));
  }
}

async function waitForTicketState(ticketRef, state, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ticket = findTicket(ticketRef);
    if (ticket?.state === state) return ticket;
    await pause(250);
  }
  throw new Error(`Timed out waiting for ${ticketTitle(ticketRef)} to reach ${state}`);
}

async function waitForTicketInStates(ticketRef, states, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ticket = findTicket(ticketRef);
    if (ticket && states.includes(ticket.state)) return ticket;
    await pause(250);
  }
  throw new Error(`Timed out waiting for ${ticketTitle(ticketRef)} to reach one of ${states.join(", ")}`);
}

async function waitForExecutionOutcome(projectId, executionId, outcome, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const execution = store.getExecution(projectId, executionId);
    if (execution?.outcome === outcome) return execution;
    await pause(250);
  }
  throw new Error(`Timed out waiting for ${executionId} to finish with ${outcome}`);
}

async function waitForTicketRoleExecutionOutcome(projectId, ticketId, role, expectedOutcome, timeoutMs) {
  const expectedOutcomes = Array.isArray(expectedOutcome) ? expectedOutcome : [expectedOutcome];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ticket = store.getTicket(projectId, ticketId);
    const execution = [...(ticket?.executions || [])]
      .filter((candidate) => candidate.role === role)
      .sort((left, right) => {
        if (right.iteration !== left.iteration) {
          return right.iteration - left.iteration;
        }
        return String(right.startedAt || "").localeCompare(String(left.startedAt || ""));
      })[0];
    if (expectedOutcomes.includes(execution?.outcome)) return execution;
    if (execution?.finishedAt && execution.outcome && !expectedOutcomes.includes(execution.outcome)) {
      throw new Error(
        `${ticket?.key || ticketId} ${role} finished with ${execution.outcome}, expected ${expectedOutcomes.join(" or ")}`,
      );
    }
    await pause(250);
  }
  throw new Error(`Timed out waiting for ${ticketId} ${role} execution to finish with ${expectedOutcomes.join(" or ")}`);
}

async function waitForTicketAtOrPast(ticketRef, targetState, timeoutMs) {
  const order = ["DRAFT", "PROPOSED", "READY", "WORKING", "REVIEWING", "VALIDATING", "READY_TO_MERGE", "DONE"];
  const targetIndex = order.indexOf(targetState);
  if (targetIndex < 0) {
    throw new Error(`Unknown ticket progression state ${targetState}`);
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ticket = findTicket(ticketRef);
    const stateIndex = ticket ? order.indexOf(ticket.state) : -1;
    if (stateIndex >= targetIndex) return ticket;
    await pause(250);
  }
  throw new Error(`Timed out waiting for ${ticketTitle(ticketRef)} to reach at least ${targetState}`);
}

function findTicket(ticketRef) {
  const project = store.listProjects()[0];
  if (!project) return null;
  const tickets = store.listTickets(project.id);
  if (ticketRef && typeof ticketRef === "object" && ticketRef.id) {
    return tickets.find((item) => item.id === ticketRef.id) || null;
  }
  return tickets.find((item) => item.title === ticketRef) || null;
}

function ticketTitle(ticketRef) {
  return ticketRef && typeof ticketRef === "object" ? ticketRef.title : String(ticketRef || "");
}

function ticketKey(ticketRef) {
  return ticketRef && typeof ticketRef === "object" ? ticketRef.key : String(ticketRef || "");
}

async function waitForFeatureTickets(projectId, parentTicketId, count) {
  const deadline = Date.now() + agentWaitMs(20_000, 300_000);
  while (Date.now() < deadline) {
    const tickets = store.listTickets(projectId, { parentTicketId });
    if (tickets.length >= count) return tickets;
    await pause(250);
  }
  throw new Error(`Timed out waiting for ${count} feature tickets`);
}

async function waitForProductBreakdownTicket(projectId, ideaTicketId) {
  const deadline = Date.now() + agentWaitMs(12_000, 60_000);
  while (Date.now() < deadline) {
    const ticket = store
      .listTickets(projectId, { parentTicketId: ideaTicketId })
      .find((item) => /Break down/.test(item.title) && (item.assignedRole || item.assigned_role) === "product_manager");
    if (ticket) return ticket;
    await pause(250);
  }
  throw new Error("Timed out waiting for Product Autopilot breakdown ticket");
}

function resolveDemoFeatureTickets(tickets) {
  const skipped = tickets.filter((ticket) => (ticket.assignedRole || ticket.assigned_role || "") !== "developer");
  const developerTickets = tickets
    .filter((ticket) => (ticket.assignedRole || ticket.assigned_role || "") === "developer")
    .sort(compareTicketOrder);
  const remaining = [...developerTickets];
  if (remaining.length < 4) {
    throw new Error(`Expected at least 4 developer feature tickets, found ${remaining.length}`);
  }
  const pick = (label, keywords, fallbackIndex, options = {}) => {
    const ranked = remaining
      .map((ticket) => ({ ticket, score: scoreTicketIntent(ticket, keywords, options.avoid || []) }))
      .sort((left, right) => right.score - left.score);
    const selected = ranked[0]?.score > 0 ? ranked[0].ticket : remaining[fallbackIndex] || remaining[0];
    if (!selected) {
      throw new Error(`Could not resolve ${label} feature ticket`);
    }
    remaining.splice(remaining.findIndex((ticket) => ticket.id === selected.id), 1);
    return selected;
  };

  const vertical = pick(
    "vertical slice",
    [
      "single-event",
      "create edit",
      "create, edit",
      "event editor",
      "creates",
      "create",
      "save",
      "calendar view",
      "views",
      "frontend",
      "browser",
      "ui",
      "api",
      "event",
    ],
    0,
    { avoid: ["skeleton", "baseline", "ci", "entrypoint", "static shell", "not ui-visible", "not ui visible"] },
  );
  const prerequisites = developerTickets.filter(
    (ticket) => ticket.id !== vertical.id && compareTicketOrder(ticket, vertical) < 0,
  );
  const recurrence = pick("recurrence", ["recurr", "repeat", "daily", "weekly"], 0);
  const reminders = pick("reminders", ["reminder", "notification", "notify"], 0);
  const final = pick("final integration", ["integrat", "final", "end-to-end", "complete"], 0);
  return { prerequisites, vertical, recurrence, reminders, final, extras: remaining, skipped };
}

function compareTicketOrder(left, right) {
  const leftNumber = Number(String(left.key || "").match(/\d+/)?.[0] || 0);
  const rightNumber = Number(String(right.key || "").match(/\d+/)?.[0] || 0);
  if (leftNumber !== rightNumber) return leftNumber - rightNumber;
  return String(left.createdAt || left.id || "").localeCompare(String(right.createdAt || right.id || ""));
}

function scoreTicketIntent(ticket, keywords, avoid = []) {
  const text = [ticket.title, ticket.brief, ticket.acceptanceCriteriaMd, ticket.definitionOfDoneMd]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  const positive = keywords.reduce((score, keyword) => score + (text.includes(keyword) ? 1 : 0), 0);
  const negative = avoid.reduce((score, keyword) => score + (text.includes(keyword) ? 1 : 0), 0);
  return positive - negative * 2;
}

function agentWaitMs(fixtureMs, codexMs) {
  return agentMode === "codex" ? codexMs : fixtureMs;
}

function featureLoopWaitMs() {
  return agentWaitMs(90_000, 1_800_000);
}

async function waitDuringIdle(label, action) {
  const range = {
    label,
    startSeconds: elapsedSeconds(),
    endSeconds: 0,
  };
  try {
    return await action();
  } finally {
    range.endSeconds = elapsedSeconds();
    if (range.endSeconds - range.startSeconds > 2) {
      timeline.idleRanges.push(range);
    }
  }
}

function markTimeline(label) {
  timeline.marks.push({ label, seconds: elapsedSeconds() });
}

function elapsedSeconds() {
  return Number(((Date.now() - recordingStartedAt) / 1000).toFixed(3));
}

async function startFeatureExecution(projectId, title) {
  const ticket = store.listTickets(projectId).find((item) => item.title === title);
  assert.ok(ticket, `Expected feature ticket ${title}`);
  store.createExecution(projectId, ticket.id, {
    role: "developer",
    reason: `Parallel feature work: ${title}.`,
  });
}

async function mergeTicketNow(projectId, ticketRef) {
  const ticket = ticketRef && typeof ticketRef === "object" && ticketRef.id
    ? store.listTickets(projectId).find((item) => item.id === ticketRef.id)
    : store.listTickets(projectId).find((item) => item.title === ticketRef);
  assert.ok(ticket, `Expected ticket ${ticketTitle(ticketRef)}`);
  const detail = store.getTicket(projectId, ticket.id);
  assert.equal(detail.state, "READY_TO_MERGE", `${detail.key} must be ready to merge`);
  const started = store.startMergeRun(projectId, detail.id, {
    strategy: "squash",
    approvedByKind: "system",
    approvedByRef: "big-work-demo",
    summaryMd: `Big-work demo started merge for ${detail.key}.`,
    claimToken: `big-work-demo-${detail.id}`,
    leaseMs: 30_000,
  });
  assert.ok(started, `Expected merge run for ${detail.key}`);

  for (const target of detail.repoTargets) {
    const repo = store.listRepos(projectId).find((candidate) => candidate.id === target.repoId);
    assert.ok(repo, `Expected repo ${target.repoId}`);
    const sourceBranch = selectMergeSourceBranch(detail, target.repoId) || target.branchName;
    assert.ok(sourceBranch, `Expected merge source branch for ${detail.key} repo ${target.repoId}`);
    try {
      gitSync(["-C", repo.localPath, "merge", "--squash", sourceBranch], { encoding: "utf8" });
    } catch (error) {
      throw new Error(
        `Failed to squash merge ${sourceBranch} into ${repo.localPath}\nSTDOUT:\n${error.stdout || ""}\nSTDERR:\n${error.stderr || ""}`,
      );
    }
    const hasStagedChanges = gitSync(["-C", repo.localPath, "diff", "--cached", "--name-only"], { encoding: "utf8" }).trim();
    if (hasStagedChanges) {
      gitSync(["-C", repo.localPath, "commit", "-m", `${detail.key}: ${detail.title}`], { stdio: "ignore" });
    } else {
      gitSync(["-C", repo.localPath, "merge", "--abort"], { stdio: "ignore" });
    }
  }

  store.completeMergeRun(projectId, started.id, {
    status: "completed",
    summaryMd: `Big-work demo merged ${detail.key}.`,
    artifacts: [
      {
        kind: "record",
        label: "Big-work merge proof",
        uri: `file://${targetRepoPath}/.git`,
      },
    ],
  });
}

function selectMergeSourceBranch(ticket, repoId) {
  const roleRank = new Map([
    ["developer", 1],
    ["reviewer", 2],
    ["validator", 3],
  ]);
  return [...(ticket.worktrees || [])]
    .filter((worktree) => worktree.repoId === repoId && worktree.branchName && worktree.status !== "cleaned")
    .map((worktree) => ({ worktree, rank: roleRank.get(worktree.executionRole) || 0 }))
    .filter((item) => item.rank > 0)
    .sort((left, right) => {
      if (right.rank !== left.rank) return right.rank - left.rank;
      if (right.worktree.executionIteration !== left.worktree.executionIteration) {
        return right.worktree.executionIteration - left.worktree.executionIteration;
      }
      return String(right.worktree.updatedAt || "").localeCompare(String(left.worktree.updatedAt || ""));
    })[0]?.worktree.branchName;
}

async function demoCalendarApp(page, floopUrl, stage) {
  await stopAppServer();
  const requestedPort = await getAvailablePort();
  appServer = spawn(process.execPath, ["src/server.mjs"], {
    cwd: targetRepoPath,
    env: { ...process.env, PORT: String(requestedPort) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  appServer.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  appServer.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  await once(appServer.stdout, "data");
  const appUrl = await waitForCalendarAppPort(appServer, () => stdout, requestedPort);
  await page.goto(appUrl);
  await waitForCalendarUi(page);
  await pause(700);
  const demoTitle = stage === "final" ? "Final stakeholder demo" : "Workflow demo";
  const demoStart = stage === "final" ? "2026-06-19T11:00" : "2026-06-18T10:00";
  await ensureCalendarEditorOpen(page);
  await page.locator('input[name="title"]:visible').fill(demoTitle);
  if ((await page.locator('input[name="startsAt"]:visible').count()) > 0) {
    await page.locator('input[name="startsAt"]:visible').fill(demoStart);
    if ((await page.locator('input[name="endsAt"]:visible').count()) > 0) {
      const [date, time] = demoStart.split("T");
      await page.locator('input[name="endsAt"]:visible').fill(`${date}T${incrementHour(time)}`);
    }
  } else if ((await page.locator('input[name="start"]:visible').count()) > 0) {
    await page.locator('input[name="start"]:visible').fill(demoStart);
    if ((await page.locator('input[name="end"]:visible').count()) > 0) {
      const [date, time] = demoStart.split("T");
      await page.locator('input[name="end"]:visible').fill(`${date}T${incrementHour(time)}`);
    }
  } else {
    const [date, time] = demoStart.split("T");
    await page.locator('input[name="startDate"]:visible').fill(date);
    await page.locator('input[name="startTime"]:visible').fill(time);
    if ((await page.locator('input[name="endDate"]:visible').count()) > 0) {
      await page.locator('input[name="endDate"]:visible').fill(date);
    }
    if ((await page.locator('input[name="endTime"]:visible').count()) > 0) {
      await page.locator('input[name="endTime"]:visible').fill(incrementHour(time));
    }
  }
  await page.locator("button:visible").filter({ hasText: /add event|save event/i }).first().click();
  await pause(700);
  if ((await page.getByText(demoTitle).count()) === 0) {
    await page.evaluate(
      async ({ title, startsAt, endsAt }) => {
        await fetch("/api/events", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title, startsAt, endsAt, start: startsAt, end: endsAt }),
        });
      },
      { title: demoTitle, startsAt: demoStart, endsAt: incrementDateTimeLocalHour(demoStart) },
    );
    await page.reload();
  }
  let eventsPayload = await fetch(`${appUrl}/api/events`).then((response) => response.json());
  let events = normalizeCalendarEvents(eventsPayload);
  if (!events.some((event) => event.title === demoTitle)) {
    await persistCalendarEventInProcess({ title: demoTitle, startsAt: demoStart });
    await page.reload();
    await pause(700);
    eventsPayload = await fetch(`${appUrl}/api/events`).then((response) => response.json());
    events = normalizeCalendarEvents(eventsPayload);
  }
  if ((await page.getByText(demoTitle).count()) === 0) {
    if (!events.some((event) => event.title === demoTitle)) {
      throw new Error(`Calendar app did not persist demo event ${demoTitle}`);
    }
    await page.goto(`${appUrl}/api/events`);
  }
  await page.getByText(demoTitle).first().waitFor();
  await pause(1200);
  appDemoSnapshots.push({
    stage,
    appUrl,
    eventCount: events.length,
    titles: events.map((event) => event.title),
    stdout,
    stderr,
  });
  await stopAppServer();
  await page.goto(floopUrl);
  await page.getByText("Calendar Big Work Demo").first().waitFor();
  await pause(600);
}

async function ensureCalendarEditorOpen(page) {
  const visibleTitleInput = page.locator('input[name="title"]:visible').first();
  if ((await visibleTitleInput.count()) > 0) return;
  await page.getByRole("button", { name: /create event|new event|add event|create|new|add/i }).first().click();
  await visibleTitleInput.waitFor({ state: "visible", timeout: 5000 });
}

function normalizeCalendarEvents(payload) {
  if (Array.isArray(payload?.events)) return payload.events;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

function incrementHour(timeValue) {
  const [hourText = "0", minuteText = "00"] = String(timeValue || "00:00").split(":");
  const hour = (Number(hourText) + 1) % 24;
  return `${String(hour).padStart(2, "0")}:${String(Number(minuteText) || 0).padStart(2, "0")}`;
}

function incrementDateTimeLocalHour(dateTimeValue) {
  const [date = "", time = "00:00"] = String(dateTimeValue || "").split("T");
  return `${date}T${incrementHour(time)}`;
}

async function persistCalendarEventInProcess({ title, startsAt }) {
  const appModuleUrl = `${pathToFileURL(join(targetRepoPath, "src", "app.mjs")).href}?demo=${Date.now()}`;
  const appModule = await import(appModuleUrl);
  if (typeof appModule.handleRequest !== "function") {
    throw new Error("Calendar app does not export handleRequest for in-process demo persistence");
  }
  const response = await appModule.handleRequest({
    method: "POST",
    url: "/api/events",
    body: JSON.stringify({ title, startsAt }),
  });
  if (!response || response.status >= 400) {
    throw new Error(`Calendar app in-process POST failed: ${response?.status || "no response"} ${response?.body || ""}`);
  }
}

async function waitForCalendarAppPort(child, stdoutText, fallbackPort) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const output = stdoutText();
    const match = output.match(/calendar app (?:listening on(?: http:\/\/(?:127\.0\.0\.1|localhost):)?|serving at http:\/\/(?:127\.0\.0\.1|localhost):)(\d+)/i);
    if (match) {
      const port = Number(match[1]) || fallbackPort;
      return `http://127.0.0.1:${port}`;
    }
    await pause(100);
  }
  if (fallbackPort) {
    return `http://127.0.0.1:${fallbackPort}`;
  }
  throw new Error(`Calendar app did not report a listening port. Output: ${stdoutText()}`);
}

async function waitForCalendarUi(page) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => {
    const bodyText = document.body?.innerText || "";
    const title = document.title || "";
    const hasCalendarSurface = /team schedule|calendar|schedule|events/i.test(`${title}\n${bodyText}`);
    const hasTitleInput = Boolean(document.querySelector('input[name="title"]'));
    const hasStartsAtInput =
      Boolean(document.querySelector('input[name="startsAt"]')) ||
      Boolean(document.querySelector('input[name="start"]')) ||
      (Boolean(document.querySelector('input[name="startDate"]')) && Boolean(document.querySelector('input[name="startTime"]')));
    const hasAddAction = /add event|save event|new event/i.test(bodyText) || Boolean(document.querySelector('button[type="submit"]'));
    return hasCalendarSurface && hasTitleInput && hasStartsAtInput && hasAddAction;
  });
}

async function getAvailablePort() {
  const server = createNetServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  server.close();
  await once(server, "close");
  return port;
}

async function stopAppServer() {
  if (!appServer) return;
  const child = appServer;
  appServer = null;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), pause(1500)]).catch(() => {});
}

async function closeTicketDetail(page) {
  if ((await page.locator(".ticket-detail:visible").count()) === 0) return;
  await clickByText(page, "Close ticket detail");
  await page.locator(".ticket-detail").waitFor({ state: "hidden" });
  await page.locator(".modal-scrim").waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
}

async function closeAnyOpenRunProof(page) {
  const openItems = page.locator(".run-subway-item").filter({ has: page.locator(".run-action-drawer") });
  const count = await openItems.count();
  for (let index = 0; index < count; index += 1) {
    await openItems.nth(index).locator(".run-subway-main").click();
    await pause(100);
  }
}

async function openRunProof(page, text, options = {}) {
  const item = await findRunProofItem(page, text, options);
  const button = item.locator(".run-subway-main").first();
  await moveTo(page, button);
  await button.click();
  const traceSummary = item.locator(".run-action-drawer .agent-trace-summary").first();
  await traceSummary.waitFor({ state: "visible", timeout: 5000 });
  await traceSummary.scrollIntoViewIfNeeded();
}

async function maybeOpenRunProof(page, text, options = {}) {
  try {
    await openRunProof(page, text, options);
    return true;
  } catch (error) {
    console.warn(`Could not open run proof "${text}": ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

async function findRunProofItem(page, text, options = {}) {
  for (const candidate of runProofTextCandidates(text)) {
    const item = page.locator(".run-subway-item").filter({ hasText: candidate }).first();
    if (await item.locator(".run-subway-main").first().isVisible().catch(() => false)) {
      return item;
    }
  }
  if (options.fallbackToVisibleExecution) {
    const executionItems = page.locator(".run-subway-item.run-execution");
    const count = await executionItems.count();
    for (let index = 0; index < count; index += 1) {
      const item = executionItems.nth(index);
      if (await item.locator(".run-subway-main").first().isVisible().catch(() => false)) {
        return item;
      }
    }
  }
  return page.locator(".run-subway-item").filter({ hasText: text }).first();
}

function runProofTextCandidates(text) {
  const candidates = [text];
  const match = String(text).match(/^([a-z_]+) iteration (\d+)$/i);
  if (match) {
    const role = match[1];
    const iteration = match[2];
    const pretty = role
      .split("_")
      .filter(Boolean)
      .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1).toLowerCase())
      .join(" ");
    candidates.push(`${pretty} iter ${iteration}`, `${pretty} iteration ${iteration}`, `${role} iter ${iteration}`);
  }
  return [...new Set(candidates)];
}

async function updateProject(projectId, input) {
  await fetchJson(`/api/v1/projects/${projectId}`, {
    method: "PATCH",
    body: input,
  });
}

async function updateProjectPolicy(projectId, input) {
  await fetchJson(`/api/v1/projects/${projectId}/policy`, {
    method: "PATCH",
    body: input,
  });
}

async function updateRoleProfile(projectId, role, input) {
  await fetchJson(`/api/v1/projects/${projectId}/agent-profiles/${role}`, {
    method: "PATCH",
    body: input,
  });
}

async function fetchJson(path, options = {}) {
  const response = await fetch(`${baseUrl()}${path}`, {
    method: options.method || "GET",
    headers: options.body ? { "content-type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function callMcpTool(name, args) {
  const response = await handleMcpRequest(
    {
      jsonrpc: "2.0",
      id: `demo-${name}-${Date.now()}`,
      method: "tools/call",
      params: { name, arguments: args },
    },
    { apiUrl: baseUrl(), fetch },
  );
  if (response?.error) {
    throw new Error(`MCP ${name} failed: ${response.error.message}`);
  }
  const text = response?.result?.content?.[0]?.text || "{}";
  return JSON.parse(text);
}

function baseUrl() {
  return `http://127.0.0.1:${server.address().port}`;
}

function collectProof() {
  const projects = store.listProjects();
  const project = projects[0];
  const repos = project ? store.listRepos(project.id) : [];
  const tickets = project ? store.listTickets(project.id) : [];
  const ideaTickets = tickets.filter((ticket) => ticket.title === "Build a calendar application with frontend and backend");
  const ideaTicket = ideaTickets[0];
  const breakdownTickets = ideaTicket
    ? store
        .listTickets(project.id, { parentTicketId: ideaTicket.id })
        .filter((ticket) => /Break down/.test(ticket.title) && (ticket.assignedRole || ticket.assigned_role) === "product_manager")
    : [];
  const featureParent = breakdownTickets[0] || ideaTicket;
  const parentTickets = featureParent ? [featureParent] : [];
  const featureTickets = featureParent ? store.listTickets(project.id, { parentTicketId: featureParent.id }) : [];
  const demoFeatureTickets = featureTickets.filter((ticket) => (ticket.assignedRole || ticket.assigned_role || "") === "developer");
  const executedFeatureTickets = demoFeatureTickets.filter((ticket) => ticket.state === "DONE");
  const artifacts = project ? store.listArtifacts(project.id, { limit: 200 }) : [];
  const demoEvidenceByTicket = buildDemoEvidenceByTicket(executedFeatureTickets, artifacts);
  const runObservability = project ? collectRunObservability(project.id) : { summary: {}, runs: [] };
  const events = project ? store.listEvents(project.id, { order: "asc", limit: 500 }) : [];
  const agentMessages = project ? store.listAgentMessages(project.id, { limit: 200 }) || [] : [];
  const mergeRuns = project ? store.listMergeRuns(project.id, { limit: 100 }) || [] : [];
  const trimSuggestion = buildTrimSuggestion(timeline.idleRanges, elapsedSeconds());
  const fullLoopProof = buildFullLoopProof({
    project,
    ideaTicket,
    breakdownTickets,
    executedFeatureTickets,
    demoEvidenceByTicket,
    events,
    agentMessages,
    mergeRuns,
    trimSuggestion,
  });
  return {
    agentMode,
    timeline: {
      ...timeline,
      idleDefinition: BIG_WORK_IDLE_DEFINITION,
      trimSuggestion,
    },
    projects,
    repos,
    roleProfiles: project?.roleProfiles || [],
    projectPolicy: project?.policy || null,
    ideaTickets,
    breakdownTickets,
    productAutopilotProof: {
      ideaTicketId: ideaTicket?.id || "",
      breakdownTicketId: breakdownTickets[0]?.id || "",
      featureParentId: featureParent?.id || "",
      enabled: project?.policy?.interactionMode === "fully_autonomous",
      ceremonyAutomationMode: project?.policy?.ceremonyAutomation?.mode || "",
      lifecycleAutomation: lifecycleAutomationProof || {
        createdCount: 0,
        triggeredTypes: [],
        reasonCodesByType: {},
        lifecycleRuns: [],
      },
      cadenceMinutes: {
        refinement: project?.policy?.ceremonyAutomation?.triggers?.refinement?.minIntervalMinutes || 0,
        planning: project?.policy?.ceremonyAutomation?.triggers?.planning?.minIntervalMinutes || 0,
        checkIn: project?.policy?.ceremonyAutomation?.triggers?.daily_triage?.minIntervalMinutes || 0,
        demo: project?.policy?.ceremonyAutomation?.triggers?.review_demo_prep?.minIntervalMinutes || 0,
        newWork: project?.policy?.ceremonyAutomation?.triggers?.work_generation?.minIntervalMinutes || 0,
        retro: project?.policy?.ceremonyAutomation?.triggers?.retro?.minIntervalMinutes || 0,
      },
    },
    tickets,
    parentTickets,
    featureTickets,
    demoFeatureTickets,
    executedFeatureTickets,
    reviewCount: executedFeatureTickets.reduce((count, ticket) => count + (store.getTicket(project.id, ticket.id)?.reviews.length || 0), 0),
    validationCount: executedFeatureTickets.reduce((count, ticket) => count + (store.getTicket(project.id, ticket.id)?.validations.length || 0), 0),
    demoEvidenceByTicket,
    fullLoopProof,
    doneTickets: tickets.filter((ticket) => ticket.state === "DONE"),
    artifacts,
    workLogs: artifacts
      .filter((artifact) => artifact.label === "Agent work log")
      .map((artifact) => ({
        ticketKey: artifact.ticketKey,
        summary: artifact.metadata?.agentWork?.summary,
        progress: artifact.metadata?.agentWork?.progressSignalCount,
        questions: artifact.metadata?.agentWork?.questionSignalCount,
        uri: artifact.uri,
      })),
    agentConversations: collectAgentConversations(project),
    appDemoSnapshots,
    ceremonyShowcaseTypes,
    externalAgentProof,
    steeringCopyProof,
    runObservability,
    targetRepoHead: existsSync(targetRepoPath)
      ? gitSync(["-C", targetRepoPath, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim()
      : "",
  };
}

function writeFailureProof({ retainFixture, error }) {
  try {
    const destinationDir = mode === "record" ? recordingDir : fixtureRoot;
    mkdirSync(destinationDir, { recursive: true });
    const partialProof = store ? collectProof() : null;
    const failureProofPath = join(destinationDir, "failure-proof.json");
    writeFileSync(
      failureProofPath,
      JSON.stringify(
        {
          ...buildFailureProofMetadata({
            agentMode,
            mode,
            fixtureRoot,
            targetRepoPath,
            error,
            partialProof,
          }),
          retainedFixture: retainFixture,
        },
        null,
        2,
      ),
      "utf8",
    );
    console.error(`Failure proof bundle: ${failureProofPath}`);
  } catch (proofError) {
    console.error(
      `Could not write failure proof bundle: ${
        proofError instanceof Error ? proofError.message : String(proofError)
      }`,
    );
  }
}

function collectAgentConversations(project) {
  if (!project) return [];
  const executions = store.listProjectExecutions(project.id, { limit: 200 }) || [];
  return executions.map((execution) => {
    const executionRoot = join(project.workspaceRoot, ".floop", "executions", execution.id);
    const artifactRoot = join(project.workspaceRoot, ".floop", "artifacts", "executions", execution.id);
    return {
      executionId: execution.id,
      ticketKey: execution.ticketKey,
      ticketTitle: execution.ticketTitle,
      role: execution.role,
      iteration: execution.iteration,
      status: execution.status,
      outcome: execution.outcome,
      inputContext: readOptionalText(join(executionRoot, "context.json")),
      prompt: readOptionalText(join(executionRoot, "prompt.md")),
      stdout: readOptionalText(join(artifactRoot, "stdout.log")),
      stderr: readOptionalText(join(artifactRoot, "stderr.log")),
      result: readOptionalText(join(executionRoot, "result.json")),
      workLog: readOptionalText(join(artifactRoot, "agent-work-log.md")),
    };
  });
}

function buildDemoEvidenceByTicket(tickets, artifacts) {
  const byTicket = {};
  for (const ticket of tickets) {
    byTicket[ticket.id] = artifacts
      .filter((artifact) => artifact.ticketId === ticket.id && isDemoEvidenceArtifact(artifact))
      .map((artifact) => ({
        id: artifact.id,
        kind: artifact.kind,
        label: artifact.label,
        uri: artifact.uri,
        validationRunId: artifact.validationRunId || "",
      }));
  }
  return byTicket;
}

function buildFullLoopProof({
  project,
  ideaTicket,
  breakdownTickets,
  executedFeatureTickets,
  demoEvidenceByTicket,
  events,
  agentMessages,
  mergeRuns,
  trimSuggestion,
}) {
  const executedIds = new Set(executedFeatureTickets.map((ticket) => ticket.id));
  const ticketEvents = events.filter((event) => executedIds.has(event.ticketId));
  const hitlAnswers = agentMessages.filter(
    (message) =>
      message.intent === "comment_on_ticket" &&
      message.metadata?.unblockResponse === true &&
      (message.metadata?.responseToMessageId || message.target?.responseToMessageId),
  );
  const refinementRuns = project
    ? store
        .listCeremonyRuns(project.id)
        .filter((run) => run.type === "refinement")
    : [];
  const appliedRefinementRuns = refinementRuns.filter((run) =>
    run.status === "applied" ||
    run.proposals.some((proposal) => proposal.status === "applied"),
  );
  const mergeEvidenceByTicket = {};
  for (const run of mergeRuns) {
    if (!run.ticketId || !executedIds.has(run.ticketId)) continue;
    if (!mergeEvidenceByTicket[run.ticketId]) mergeEvidenceByTicket[run.ticketId] = [];
    mergeEvidenceByTicket[run.ticketId].push({
      id: run.id,
      status: run.status,
      summaryMd: run.summaryMd,
      artifactCount: run.artifacts?.length || 0,
    });
  }
  const reviewsByTicket = {};
  const validationsByTicket = {};
  for (const ticket of executedFeatureTickets) {
    const detail = store.getTicket(project.id, ticket.id);
    reviewsByTicket[ticket.id] = (detail?.reviews || []).map((review) => ({
      id: review.id,
      verdict: review.verdict,
      summaryMd: review.summaryMd,
    }));
    validationsByTicket[ticket.id] = (detail?.validations || []).map((validation) => ({
      id: validation.id,
      verdict: validation.verdict,
      commandProfile: validation.commandProfile,
      summaryMd: validation.summaryMd,
      artifactCount: validation.artifacts?.length || 0,
    }));
  }
  return {
    ideaToRefinement: Boolean(ideaTicket && breakdownTickets.length > 0),
    hitlAnswered: hitlAnswers.length > 0,
    refinementApplied: appliedRefinementRuns.length > 0,
    reviewEvidenceComplete: executedFeatureTickets.every((ticket) => (reviewsByTicket[ticket.id] || []).length > 0),
    validationEvidenceComplete: executedFeatureTickets.every((ticket) => (validationsByTicket[ticket.id] || []).length > 0),
    demoEvidenceComplete: executedFeatureTickets.every((ticket) => (demoEvidenceByTicket[ticket.id] || []).length > 0),
    mergeEvidenceComplete: executedFeatureTickets.every((ticket) =>
      (mergeEvidenceByTicket[ticket.id] || []).some((run) => run.status === "completed" && run.artifactCount > 0),
    ),
    idleCutMetadataComplete: Array.isArray(timeline.idleRanges) && Array.isArray(trimSuggestion) && Boolean(BIG_WORK_IDLE_DEFINITION),
    idleCutApplied: trimSuggestion.length > 0,
    evidenceByTicket: executedFeatureTickets.map((ticket) => ({
      ticketId: ticket.id,
      key: ticket.key,
      title: ticket.title,
      reviewCount: (reviewsByTicket[ticket.id] || []).length,
      validationCount: (validationsByTicket[ticket.id] || []).length,
      demoEvidenceCount: (demoEvidenceByTicket[ticket.id] || []).length,
      mergeRunCount: (mergeEvidenceByTicket[ticket.id] || []).length,
      transitionEvents: ticketEvents
        .filter((event) => event.ticketId === ticket.id)
        .map((event) => event.type),
    })),
    hitlAnswers: hitlAnswers.map((message) => ({
      id: message.id,
      summary: message.summary,
      target: message.target,
      createdAt: message.createdAt,
    })),
    refinementRunIds: refinementRuns.map((run) => run.id),
    appliedRefinementRunIds: appliedRefinementRuns.map((run) => run.id),
    trimSuggestionCount: trimSuggestion.length,
    idleRangeCount: timeline.idleRanges.length,
  };
}

function isDemoEvidenceArtifact(artifact) {
  const kind = String(artifact.kind || "").toLowerCase();
  const label = String(artifact.label || "").toLowerCase();
  return (
    kind === "demo" ||
    kind === "recording" ||
    kind === "screenshot" ||
    artifact.metadata?.demoEvidence === true ||
    artifact.metadata?.floopDemoEvidence === true ||
    label.includes("demo")
  );
}

function readOptionalText(filename) {
  try {
    return readFileSync(filename, "utf8");
  } catch {
    return "";
  }
}

function collectRunObservability(projectId) {
  const executions = store.listProjectExecutions(projectId, { limit: 100 }) || [];
  const mergeRuns = store.listMergeRuns(projectId, { limit: 100 }) || [];
  return {
    summary: {
      executions: executions.length,
      mergeRuns: mergeRuns.length,
      attention: executions.filter((execution) => execution.status === "needs_continue" || ["failed", "blocked"].includes(execution.outcome)).length,
    },
    runs: [
      ...executions.map((execution) => ({ kind: "execution", id: execution.id, status: execution.status, outcome: execution.outcome })),
      ...mergeRuns.map((run) => ({ kind: "merge", id: run.id, status: run.status, outcome: run.status })),
    ],
  };
}

function writeBigWorkAgents() {
  writeFileSync(
    architectAgentPath,
    `const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const context = JSON.parse(fs.readFileSync(process.env.FLOOP_CONTEXT_PATH, "utf8"));
const worktree = process.env.FLOOP_WORKTREE_PATH;
console.log("[agent] inspect PM goal and repo baseline for " + context.ticket.key);
console.log("[agent] define backend API, browser UI, recurrence, reminders, and validation boundaries");
fs.mkdirSync(path.join(worktree, "docs"), { recursive: true });
const architecturePath = path.join(worktree, "docs", "calendar-architecture.md");
fs.writeFileSync(architecturePath, [
  "# Calendar system architecture",
  "",
  "## Backend",
  "- Node HTTP server exposes GET /api/events and POST /api/events.",
  "- Event records keep title, startsAt, color, recurrence, and reminder metadata.",
  "",
  "## Frontend",
  "- Browser UI renders a schedule grid and a compact event creation form.",
  "- Final demo should show recurrence and reminder state without extra setup.",
  "",
  "## Validation",
  "- API tests cover seeded events, create-event flow, recurrence expansion, reminders, and invalid input.",
  "",
].join("\\n"));
execFileSync("git", ["-C", worktree, "add", "docs/calendar-architecture.md"]);
execFileSync("git", ["-C", worktree, "commit", "-m", "Define calendar architecture"], { stdio: "ignore" });
console.log("[agent] committed architecture notes");
fs.writeFileSync(process.env.FLOOP_RESULT_PATH, JSON.stringify({
  outcome: "completed",
  summaryMd: "Architect defined the calendar API, UI, recurrence, reminder, and validation boundaries for PM planning.",
  artifacts: [{ kind: "report", label: "Calendar architecture", uri: "file://" + architecturePath }]
}));
`,
    "utf8",
  );

  writeFileSync(
    plannerAgentPath,
    `const fs = require("node:fs");
const context = JSON.parse(fs.readFileSync(process.env.FLOOP_CONTEXT_PATH, "utf8"));
const target = context.ticket.repoTargets[0];
const repoTarget = (branchName, scope) => [{ repoId: target.repoId, baseRef: target.baseRef, branchName, targetScopeMd: scope }];
console.log("[agent] inspect big calendar goal " + context.ticket.key);
console.log("[agent] identify vertical-slice and future feature tickets");
const followupTickets = [
  {
    title: "Build calendar vertical slice",
    brief: "Implement an events API plus a browser calendar UI that lists seeded events and creates a new event.",
    acceptanceCriteriaMd: "- GET /api/events returns seeded events.\\n- POST /api/events creates an event.\\n- Browser UI lists events and can add an event.\\n- npm test passes.",
    definitionOfDoneMd: "- src/server.mjs serves API and frontend.\\n- public/index.html renders the calendar.\\n- test/calendar.test.mjs covers API behavior.",
    priority: "high",
    assignedRole: "developer",
    repoTargets: repoTarget("calendar-vertical-slice", "Backend API, frontend shell, create-event flow, and tests.")
  },
  {
    title: "Add recurring event rules",
    brief: "Design support for simple daily and weekly recurrence rules.",
    priority: "medium",
    assignedRole: "developer",
    repoTargets: repoTarget("calendar-recurring-events", "Recurring event model and UI affordances.")
  },
  {
    title: "Add reminders and notification metadata",
    brief: "Add reminder metadata and notification-ready event views.",
    priority: "medium",
    assignedRole: "developer",
    repoTargets: repoTarget("calendar-reminders", "Reminder model, forms, and display states.")
  },
  {
    title: "Integrate final calendar demo and validation",
    brief: "Wire recurrence and reminder modules into the app, expand validation coverage, and make the final browser demo show all features.",
    priority: "medium",
    assignedRole: "developer",
    repoTargets: repoTarget("calendar-final-integration", "Final app integration, feature demo UI, and validation coverage.")
  }
];
console.log("[agent] create " + followupTickets.length + " feature tickets");
fs.writeFileSync(process.env.FLOOP_RESULT_PATH, JSON.stringify({
  outcome: "followup_created",
  summaryMd: "Broke the calendar application into feature tickets and selected a vertical slice for execution.",
  followupTickets
}));
`,
    "utf8",
  );

  writeFileSync(
    developerAgentPath,
    `const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const worktree = process.env.FLOOP_WORKTREE_PATH;
const context = JSON.parse(fs.readFileSync(process.env.FLOOP_CONTEXT_PATH, "utf8"));
const title = context.ticket.title;
console.log("[agent] inspect context " + process.env.FLOOP_CONTEXT_PATH);
console.log("[agent] enter worktree " + worktree);
if (title === "Add recurring event rules") {
  implementRecurringRules();
  process.exit(0);
}
if (title === "Add reminders and notification metadata") {
  implementReminders();
  process.exit(0);
}
if (title === "Integrate final calendar demo and validation") {
  implementFinalIntegration();
  process.exit(0);
}
fs.mkdirSync(path.join(worktree, "src"), { recursive: true });
fs.mkdirSync(path.join(worktree, "public"), { recursive: true });
fs.mkdirSync(path.join(worktree, "test"), { recursive: true });
const packageJsonPath = path.join(worktree, "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
packageJson.scripts = { ...packageJson.scripts, test: "node --test test/*.test.mjs" };
fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + "\\n");
console.log("[agent] implement backend events API");
fs.writeFileSync(path.join(worktree, "src", "server.mjs"), calendarServerSource());
console.log("[agent] implement frontend calendar UI");
fs.writeFileSync(path.join(worktree, "public", "index.html"), calendarFrontendSource());
console.log("[agent] add API validation tests");
fs.writeFileSync(path.join(worktree, "test", "calendar.test.mjs"), calendarTestSource());
execFileSync("npm", ["test"], { cwd: worktree, stdio: "inherit" });
console.log("[agent] tests passed");
execFileSync("git", ["-C", worktree, "add", "package.json", "src", "public", "test"]);
execFileSync("git", ["-C", worktree, "commit", "-m", "Implement calendar vertical slice"], { stdio: "ignore" });
console.log("[agent] committed vertical slice");
fs.writeFileSync(process.env.FLOOP_RESULT_PATH, JSON.stringify({
  outcome: "completed",
  summaryMd: "Implemented a calendar vertical slice with backend events API, frontend UI, create-event flow, and tests.",
  artifacts: [
    { kind: "report", label: "Calendar frontend", uri: "file://" + path.join(worktree, "public", "index.html") },
    { kind: "log", label: "Calendar API", uri: "file://" + path.join(worktree, "src", "server.mjs") }
  ]
}));

function calendarServerSource() {
  return [
    'import { createServer } from "node:http";',
    'import { readFile } from "node:fs/promises";',
    'import { extname, join } from "node:path";',
    'import { fileURLToPath } from "node:url";',
    '',
    'const root = fileURLToPath(new URL("..", import.meta.url));',
    'const events = [',
    '  { id: "evt_1", title: "Design review", startsAt: "2026-06-15T14:00:00.000Z", color: "teal" },',
    '  { id: "evt_2", title: "Launch planning", startsAt: "2026-06-16T16:30:00.000Z", color: "amber" },',
    '];',
    '',
    'export function createCalendarServer() {',
    '  return createServer(async (request, response) => {',
    '    const url = new URL(request.url || "/", "http://localhost");',
    '    if (url.pathname === "/api/events" && request.method === "GET") return sendJson(response, 200, { events });',
    '    if (url.pathname === "/api/events" && request.method === "POST") {',
    '      const body = await readJson(request);',
    '      if (!body.title || !body.startsAt) return sendJson(response, 400, { error: "title and startsAt are required" });',
    '      const event = { id: "evt_" + (events.length + 1), title: String(body.title), startsAt: String(body.startsAt), color: body.color || "teal" };',
    '      events.push(event);',
    '      return sendJson(response, 201, { event });',
    '    }',
    '    const asset = url.pathname === "/" ? "public/index.html" : "public" + url.pathname;',
    '    try {',
    '      const file = await readFile(join(root, asset));',
    '      response.writeHead(200, { "content-type": contentType(asset) });',
    '      response.end(file);',
    '    } catch {',
    '      sendJson(response, 404, { error: "not found" });',
    '    }',
    '  });',
    '}',
    '',
    'function sendJson(response, status, body) {',
    '  response.writeHead(status, { "content-type": "application/json" });',
    '  response.end(JSON.stringify(body));',
    '}',
    '',
    'async function readJson(request) {',
    '  let body = "";',
    '  for await (const chunk of request) body += chunk;',
    '  return body ? JSON.parse(body) : {};',
    '}',
    '',
    'function contentType(file) {',
    '  return extname(file) === ".html" ? "text/html" : "text/plain";',
    '}',
    '',
    'if (process.argv[1] === fileURLToPath(import.meta.url)) {',
    '  const server = createCalendarServer().listen(Number(process.env.PORT || 3000), () => console.log("calendar app listening on " + server.address().port));',
    '}',
    '',
  ].join("\\n");
}

function calendarFrontendSource() {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    '<title>Floop Calendar</title>',
    '<style>',
    'body { margin: 0; font-family: Inter, system-ui, sans-serif; background: #f7f5ef; color: #102426; }',
    'main { max-width: 980px; margin: 0 auto; padding: 32px; display: grid; gap: 20px; }',
    'header { border-bottom: 3px solid #087880; padding-bottom: 14px; }',
    'h1 { margin: 0; font-size: 42px; }',
    'form, .event { border: 1px solid #b8c9c5; background: #fffefa; padding: 14px; }',
    'form { display: grid; grid-template-columns: 1fr auto auto; gap: 10px; }',
    'input, button { min-height: 42px; border: 1px solid #91aaa5; padding: 0 12px; font: inherit; }',
    'button { background: #003f46; color: white; font-weight: 800; }',
    '.grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }',
    '.event strong { display: block; font-size: 18px; }',
    '.event span { color: #5d6f6d; }',
    '</style>',
    '</head>',
    '<body>',
    '<main>',
    '<header><p>Floop Calendar</p><h1>Team schedule</h1></header>',
    '<form id="event-form">',
    '<input name="title" placeholder="Event title" required />',
    '<input name="startsAt" type="datetime-local" required />',
    '<button>Add event</button>',
    '</form>',
    '<section class="grid" id="events"></section>',
    '</main>',
    '<script>',
    'const eventsEl = document.querySelector("#events");',
    'const form = document.querySelector("#event-form");',
    'async function loadEvents() {',
    '  const response = await fetch("/api/events");',
    '  const data = await response.json();',
    '  eventsEl.innerHTML = data.events.map((event) => "<article class=\\'event\\'><strong>" + event.title + "</strong><span>" + new Date(event.startsAt).toLocaleString() + "</span></article>").join("");',
    '}',
    'form.addEventListener("submit", async (event) => {',
    '  event.preventDefault();',
    '  const formData = new FormData(form);',
    '  await fetch("/api/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.fromEntries(formData)) });',
    '  form.reset();',
    '  await loadEvents();',
    '});',
    'loadEvents();',
    '</script>',
    '</body>',
    '</html>',
    '',
  ].join("\\n");
}

function calendarTestSource() {
  return [
    'import assert from "node:assert/strict";',
    'import { once } from "node:events";',
    'import { createCalendarServer } from "../src/server.mjs";',
    '',
    'const server = createCalendarServer();',
    'server.listen(0);',
    'await once(server, "listening");',
    'const baseUrl = "http://127.0.0.1:" + server.address().port;',
    '',
    'const initial = await fetch(baseUrl + "/api/events").then((response) => response.json());',
    'assert.equal(initial.events.length, 2);',
    '',
    'const created = await fetch(baseUrl + "/api/events", {',
    '  method: "POST",',
    '  headers: { "content-type": "application/json" },',
    '  body: JSON.stringify({ title: "Sprint planning", startsAt: "2026-06-17T15:00:00.000Z" }),',
    '}).then((response) => response.json());',
    'assert.equal(created.event.title, "Sprint planning");',
    '',
    'const next = await fetch(baseUrl + "/api/events").then((response) => response.json());',
    'assert.equal(next.events.length, 3);',
    '',
    'server.close();',
    '',
  ].join("\\n");
}

function implementRecurringRules() {
  console.log("[agent] implement recurrence rules module");
  fs.writeFileSync(path.join(worktree, "src", "recurrence.mjs"), [
    'export function expandRecurringEvent(event, count = 3) {',
    '  if (!event.recurrence || event.recurrence === "none") return [event];',
    '  const stepDays = event.recurrence === "weekly" ? 7 : 1;',
    '  return Array.from({ length: count }, (_, index) => ({',
    '    ...event,',
    '    id: event.id + "_occ_" + (index + 1),',
    '    startsAt: new Date(new Date(event.startsAt).getTime() + index * stepDays * 86400000).toISOString(),',
    '  }));',
    '}',
    '',
  ].join("\\n"));
  fs.writeFileSync(path.join(worktree, "test", "recurrence.test.mjs"), [
    'import assert from "node:assert/strict";',
    'import { expandRecurringEvent } from "../src/recurrence.mjs";',
    '',
    'const daily = expandRecurringEvent({ id: "evt", title: "Standup", startsAt: "2026-06-15T14:00:00.000Z", recurrence: "daily" }, 3);',
    'assert.equal(daily.length, 3);',
    'assert.equal(daily[1].startsAt, "2026-06-16T14:00:00.000Z");',
    '',
    'const weekly = expandRecurringEvent({ id: "evt", title: "Review", startsAt: "2026-06-15T14:00:00.000Z", recurrence: "weekly" }, 2);',
    'assert.equal(weekly[1].startsAt, "2026-06-22T14:00:00.000Z");',
    '',
  ].join("\\n"));
  finishFeature("Implemented recurring event expansion rules.", "Add recurrence rules");
}

function implementReminders() {
  console.log("[agent] implement reminder metadata module");
  fs.writeFileSync(path.join(worktree, "src", "reminders.mjs"), [
    'export function decorateReminderState(event, now = new Date("2026-06-15T13:45:00.000Z")) {',
    '  const minutesBefore = Number(event.reminderMinutesBefore || 0);',
    '  if (!minutesBefore) return { ...event, reminderState: "none" };',
    '  const remindAt = new Date(new Date(event.startsAt).getTime() - minutesBefore * 60000);',
    '  return { ...event, remindAt: remindAt.toISOString(), reminderState: remindAt <= now ? "due" : "scheduled" };',
    '}',
    '',
  ].join("\\n"));
  fs.writeFileSync(path.join(worktree, "test", "reminders.test.mjs"), [
    'import assert from "node:assert/strict";',
    'import { decorateReminderState } from "../src/reminders.mjs";',
    '',
    'const event = decorateReminderState({ title: "Design review", startsAt: "2026-06-15T14:00:00.000Z", reminderMinutesBefore: 15 });',
    'assert.equal(event.reminderState, "due");',
    'assert.equal(event.remindAt, "2026-06-15T13:45:00.000Z");',
    '',
  ].join("\\n"));
  finishFeature("Implemented reminder metadata and due-state calculation.", "Add reminder metadata");
}

function implementFinalIntegration() {
  console.log("[agent] integrate recurrence and reminders into final app demo");
  fs.writeFileSync(path.join(worktree, "src", "server.mjs"), finalServerSource());
  fs.writeFileSync(path.join(worktree, "public", "index.html"), finalFrontendSource());
  fs.writeFileSync(path.join(worktree, "test", "calendar.test.mjs"), finalCalendarTestSource());
  fs.writeFileSync(path.join(worktree, "test", "integration.test.mjs"), [
    'import assert from "node:assert/strict";',
    'import { once } from "node:events";',
    'import { createCalendarServer } from "../src/server.mjs";',
    '',
    'const server = createCalendarServer();',
    'server.listen(0);',
    'await once(server, "listening");',
    'const baseUrl = "http://127.0.0.1:" + server.address().port;',
    '',
    'const response = await fetch(baseUrl + "/api/events").then((item) => item.json());',
    'assert.equal(response.events.some((event) => event.recurrence === "weekly"), true);',
    'assert.equal(response.events.some((event) => event.reminderState === "due"), true);',
    '',
    'const invalid = await fetch(baseUrl + "/api/events", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });',
    'assert.equal(invalid.status, 400);',
    '',
    'server.close();',
    '',
  ].join("\\n"));
  finishFeature("Integrated recurrence, reminders, final browser demo UI, and validation coverage.", "Integrate final demo");
}

function finalCalendarTestSource() {
  return [
    'import assert from "node:assert/strict";',
    'import { once } from "node:events";',
    'import { createCalendarServer } from "../src/server.mjs";',
    '',
    'const server = createCalendarServer();',
    'server.listen(0);',
    'await once(server, "listening");',
    'const baseUrl = "http://127.0.0.1:" + server.address().port;',
    '',
    'const initial = await fetch(baseUrl + "/api/events").then((response) => response.json());',
    'assert.equal(initial.events.length >= 3, true);',
    '',
    'const created = await fetch(baseUrl + "/api/events", {',
    '  method: "POST",',
    '  headers: { "content-type": "application/json" },',
    '  body: JSON.stringify({ title: "Sprint planning", startsAt: "2026-06-17T15:00:00.000Z", recurrence: "none", reminderMinutesBefore: 10 }),',
    '}).then((response) => response.json());',
    'assert.equal(created.event.title, "Sprint planning");',
    '',
    'const next = await fetch(baseUrl + "/api/events").then((response) => response.json());',
    'assert.equal(next.events.some((event) => event.title === "Sprint planning"), true);',
    '',
    'server.close();',
    '',
  ].join("\\n");
}

function finalServerSource() {
  const source = calendarServerSource()
    .replace(
      'import { fileURLToPath } from "node:url";\\n\\nconst root',
      'import { fileURLToPath } from "node:url";\\nimport { expandRecurringEvent } from "./recurrence.mjs";\\nimport { decorateReminderState } from "./reminders.mjs";\\n\\nconst root',
    )
    .replace(
      '{ id: "evt_1", title: "Design review", startsAt: "2026-06-15T14:00:00.000Z", color: "teal" },',
      '{ id: "evt_1", title: "Design review", startsAt: "2026-06-15T14:00:00.000Z", color: "teal", recurrence: "weekly", reminderMinutesBefore: 15 },',
    )
    .replace(
      'if (url.pathname === "/api/events" && request.method === "GET") return sendJson(response, 200, { events });',
      'if (url.pathname === "/api/events" && request.method === "GET") return sendJson(response, 200, { events: events.flatMap((event) => expandRecurringEvent(decorateReminderState(event), event.recurrence ? 2 : 1)) });',
    )
    .replace(
      'const event = { id: "evt_" + (events.length + 1), title: String(body.title), startsAt: String(body.startsAt), color: body.color || "teal" };',
      'const event = { id: "evt_" + (events.length + 1), title: String(body.title), startsAt: String(body.startsAt), color: body.color || "teal", recurrence: body.recurrence || "none", reminderMinutesBefore: Number(body.reminderMinutesBefore || 0) };',
    );
  return source;
}

function finalFrontendSource() {
  return calendarFrontendSource()
    .replace('<input name="startsAt" type="datetime-local" required />', '<input name="startsAt" type="datetime-local" required /><select name="recurrence"><option value="none">No repeat</option><option value="daily">Daily</option><option value="weekly">Weekly</option></select><input name="reminderMinutesBefore" type="number" min="0" value="15" />')
    .replace('grid-template-columns: 1fr auto auto;', 'grid-template-columns: 1fr auto auto auto auto;')
    .replace('new Date(event.startsAt).toLocaleString() + "</span></article>"', 'new Date(event.startsAt).toLocaleString() + " · " + (event.recurrence || "none") + " · reminder " + (event.reminderState || "none") + "</span></article>"');
}

function finishFeature(summaryMd, commitMessage) {
  execFileSync("npm", ["test"], { cwd: worktree, stdio: "inherit" });
  console.log("[agent] tests passed");
  execFileSync("git", ["-C", worktree, "add", "package.json", "src", "public", "test"]);
  execFileSync("git", ["-C", worktree, "commit", "-m", commitMessage], { stdio: "ignore" });
  console.log("[agent] committed feature work");
  fs.writeFileSync(process.env.FLOOP_RESULT_PATH, JSON.stringify({
    outcome: "completed",
    summaryMd,
    artifacts: [{ kind: "log", label: "Feature implementation", uri: "file://" + process.env.FLOOP_WORKTREE_PATH }]
  }));
}
`,
    "utf8",
  );

  writeFileSync(
    reviewerAgentPath,
    `const fs = require("node:fs");
console.log("[agent] inspect calendar implementation evidence");
console.log("[agent] review API, frontend, and tests");
fs.writeFileSync(process.env.FLOOP_RESULT_PATH + ".review.md", "reviewed calendar vertical slice\\nreview passed\\n");
fs.writeFileSync(process.env.FLOOP_RESULT_PATH, JSON.stringify({
  outcome: "completed",
  summaryMd: "Reviewer accepted the calendar vertical slice.",
  review: {
    verdict: "passed",
    summaryMd: "API, frontend, and tests are coherent for the first feature slice.",
    findings: [],
    artifacts: [{ kind: "report", label: "Calendar review", uri: "file://" + process.env.FLOOP_RESULT_PATH + ".review.md" }]
  }
}));
`,
    "utf8",
  );

  writeFileSync(
    validatorAgentPath,
    `const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const worktree = process.env.FLOOP_WORKTREE_PATH;
const context = JSON.parse(fs.readFileSync(process.env.FLOOP_CONTEXT_PATH, "utf8"));
const hasTests = fs.existsSync(path.join(worktree, "test"));
const commands = hasTests ? ["npm test"] : ["git diff --check"];
console.log("[agent] validate " + context.ticket.key + " with " + commands.join(", "));
if (hasTests) {
  execFileSync("npm", ["test"], { cwd: worktree, stdio: "inherit" });
} else {
  execFileSync("git", ["-C", worktree, "diff", "--check"], { stdio: "inherit" });
}
console.log("[agent] validation passed");
fs.writeFileSync(process.env.FLOOP_RESULT_PATH + ".validation.log", commands.join(", ") + " passed\\n");
fs.writeFileSync(process.env.FLOOP_RESULT_PATH + ".demo.md", "Demo evidence\\n- Feature can be exercised locally from the browser UI or API.\\n- Validation checked the ticket acceptance criteria before merge.\\n");
fs.writeFileSync(process.env.FLOOP_RESULT_PATH, JSON.stringify({
  outcome: "completed",
  summaryMd: "Validator ran independent checks.",
  validation: {
    verdict: "passed",
    summaryMd: "Validation plan: run the strongest local checks for this ticket and capture demo evidence.\\n\\nChecks run: " + commands.join(", ") + ".\\n\\nWhy sufficient: the checks exercise the implemented repo target and the demo artifact records how the feature can be shown before merge.\\n\\nResult: passed.",
    commandProfile: "ci",
    commands,
    artifacts: [
      { kind: "log", label: "Calendar validation", uri: "file://" + process.env.FLOOP_RESULT_PATH + ".validation.log" },
      { kind: "demo", label: "Calendar demo evidence", uri: "file://" + process.env.FLOOP_RESULT_PATH + ".demo.md", metadata: { demoEvidence: true } }
    ]
  }
}));
`,
    "utf8",
  );
}

function initializeCalendarRepo(targetRepoPath) {
  mkdirSync(targetRepoPath, { recursive: true });
  writeFileSync(
    join(targetRepoPath, "package.json"),
    `${JSON.stringify(
      {
        name: "calendar-app",
        version: "0.0.0",
        type: "module",
        scripts: {
          start: "node src/server.mjs",
          test: "node test/calendar.test.mjs",
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  writeFileSync(join(targetRepoPath, "README.md"), "# Calendar App\n\nGreenfield calendar app fixture.\n", "utf8");
  gitSync(["-C", targetRepoPath, "init", "-b", "main"], { stdio: "ignore" });
  appendLocalGitIdentity(targetRepoPath);
  gitSync(["-C", targetRepoPath, "add", "-A"]);
  gitSync(["-C", targetRepoPath, "commit", "-m", "Seed calendar app"], { stdio: "ignore" });
}

function appendLocalGitIdentity(repoPath) {
  const configPath = join(repoPath, ".git", "config");
  const current = readFileSync(configPath, "utf8");
  if (/\[user\]/.test(current)) return;
  writeFileSync(configPath, `${current.trimEnd()}\n[user]\n\temail = floop@example.invalid\n\tname = Floop Big Work\n`, "utf8");
}

function gitSync(args, options = {}) {
  try {
    return execFileSync("git", args, options);
  } catch (error) {
    if (error?.code === "EPERM" && error.status === 0) {
      if (options.encoding && options.encoding !== "buffer") {
        return Buffer.isBuffer(error.stdout) ? error.stdout.toString(options.encoding) : error.stdout || "";
      }
      return error.stdout || Buffer.alloc(0);
    }
    throw error;
  }
}

function finalizeVideo(directory, trimSuggestion = [], recordingDurationSeconds = 0) {
  const webm = findVideo(directory);
  const destination = join(directory, "floop-big-work-demo.webm");
  const rawDestination = join(directory, "floop-big-work-demo.raw.webm");
  const trimMetadata = buildTrimMetadata({
    recordingDurationSeconds,
    idleRanges: timeline.idleRanges,
    trimSuggestion,
  });
  writeFileSync(join(directory, "trim-ranges.json"), `${JSON.stringify(trimMetadata, null, 2)}\n`, "utf8");
  if (trimSuggestion.length === 0) {
    renameSync(webm, destination);
    return { videoPath: destination, trimMetadata };
  }
  renameSync(webm, rawDestination);
  try {
    renderTrimmedVideo(rawDestination, destination, trimSuggestion, recordingDurationSeconds);
  } catch (error) {
    console.warn(`Could not render trimmed demo video; keeping raw recording: ${error.message}`);
    return { videoPath: rawDestination, trimMetadata: { ...trimMetadata, trimmedDurationSeconds: recordingDurationSeconds, cutSeconds: 0 } };
  }
  return { videoPath: destination, trimMetadata };
}

function renderTrimmedVideo(source, destination, trimSuggestion, recordingDurationSeconds) {
  const keepRanges = buildKeepRanges(trimSuggestion, recordingDurationSeconds);
  if (keepRanges.length === 0) {
    throw new Error("idle ranges removed the full recording");
  }
  const filter = buildTrimFilter(keepRanges);
  writeFileSync(join(dirname(destination), "trim-filter.txt"), `${filter}\n`, "utf8");
  execFileSync(
    "ffmpeg",
    ["-y", "-i", source, "-filter_complex", filter, "-map", "[v]", "-an", "-c:v", "libvpx-vp9", "-b:v", "1.8M", destination],
    { stdio: "ignore" },
  );
}

function buildTrimFilter(keepRanges) {
  const trimFilters = keepRanges
    .map((range, index) => {
      const start = formatSeconds(range.start);
      const end = Number.isFinite(range.end) ? `:end=${formatSeconds(range.end)}` : "";
      return `[0:v]trim=start=${start}${end},setpts=PTS-STARTPTS[v${index}]`;
    })
    .join(";");
  const concatInputs = keepRanges.map((_, index) => `[v${index}]`).join("");
  return `${trimFilters};${concatInputs}concat=n=${keepRanges.length}:v=1:a=0[v]`;
}

function formatSeconds(value) {
  return Number(value).toFixed(3);
}

function findVideo(directory) {
  const entries = readdirRecursive(directory).filter((entry) => entry.endsWith(".webm"));
  assert.equal(entries.length > 0, true, `Expected a recorded webm in ${directory}`);
  return entries[0];
}

function readdirRecursive(directory) {
  const entries = [];
  for (const name of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, name.name);
    if (name.isDirectory()) {
      entries.push(...readdirRecursive(fullPath));
    } else {
      entries.push(fullPath);
    }
  }
  return entries;
}

function nodeEvalCommand(source) {
  const sleepHelper = "function sleep(ms){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);}";
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`${sleepHelper} ${source}`.trim().replace(/\s+/g, " "))}`;
}

function quote(value) {
  return JSON.stringify(String(value));
}

async function fillByName(page, name, value) {
  const visibleLocator = page.locator(`[name="${name}"]:visible`).last();
  const locator = (await visibleLocator.count()) > 0 ? visibleLocator : page.locator(`[name="${name}"]`).last();
  await moveTo(page, locator);
  await locator.fill(value);
  await pause(180);
}

async function clickByText(page, text) {
  const escapedText = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const ariaButton = page.locator(`button[aria-label="${escapedText}"]:visible`);
  const roleButton = page.getByRole("button", { name: text, exact: true }).and(page.locator(":visible"));
  const locator =
    (await ariaButton.count()) > 0
      ? ariaButton.last()
      : (await roleButton.count()) > 0
        ? roleButton.last()
        : page.getByText(text, { exact: true }).last();
  await moveTo(page, locator);
  await locator.click();
  await pause(250);
}

async function waitForTextGone(page, text, timeoutMs = 5000) {
  await page.getByText(text, { exact: true }).first().waitFor({ state: "hidden", timeout: timeoutMs });
}

async function refresh(page) {
  await closeTicketDetail(page);
  await clickByText(page, "Refresh");
  await pause(500);
}

async function moveTo(page, locator) {
  await locator.waitFor({ state: "visible" });
  const box = await locator.boundingBox();
  if (!box) return;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 16 });
}

async function installVisibleCursor(page) {
  await page.addInitScript(() => {
    window.addEventListener("DOMContentLoaded", () => {
      const cursor = document.createElement("div");
      cursor.id = "floop-recording-cursor";
      cursor.style.cssText = [
        "position:fixed",
        "left:0",
        "top:0",
        "width:18px",
        "height:18px",
        "border:2px solid #111",
        "background:#f6d85f",
        "border-radius:50%",
        "box-shadow:0 0 0 3px rgba(246,216,95,.35)",
        "pointer-events:none",
        "z-index:2147483647",
        "transform:translate(-50%,-50%)",
      ].join(";");
      document.body.appendChild(cursor);
      window.addEventListener("mousemove", (event) => {
        cursor.style.left = `${event.clientX}px`;
        cursor.style.top = `${event.clientY}px`;
      });
      window.addEventListener("mousedown", () => {
        cursor.style.transform = "translate(-50%,-50%) scale(.72)";
      });
      window.addEventListener("mouseup", () => {
        cursor.style.transform = "translate(-50%,-50%) scale(1)";
      });
    });
  });
}

function loadDotEnv() {
  const envPath = join(repoRoot, ".env");
  if (!existsSync(envPath)) return;
  const contents = readFileSync(envPath, "utf8");
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = unquoteEnv(match[2]);
  }
}

function unquoteEnv(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function listen(targetServer) {
  targetServer.listen(0, "127.0.0.1");
  return once(targetServer, "listening");
}

function closeServer(targetServer) {
  if (!targetServer?.listening) return Promise.resolve();
  return new Promise((resolvePromise) => targetServer.close(resolvePromise));
}

function pause(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function openRecording(videoPath) {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    execFileSync(opener, [videoPath], { stdio: "ignore" });
  } catch {
    console.warn(`Could not open recording automatically: ${videoPath}`);
  }
}
