import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import { createFloopServer } from "../services/api/src/app.mjs";
import { createExecutionDriver } from "../services/api/src/execution-driver.mjs";
import { createMergeDriver } from "../services/api/src/merge-driver.mjs";
import { createStore } from "../services/api/src/store.mjs";

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
let recordingStartedAt = Date.now();
const appDemoSnapshots = [];
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
  assert.equal(proof.parentTickets.length, 1);
  assert.equal(proof.featureTickets.length >= 4, true);
  assert.equal(proof.featureTickets.every((ticket) => ticket.state === "DONE"), true);
  assert.equal(proof.reviewCount >= proof.featureTickets.length, true);
  assert.equal(proof.validationCount >= proof.featureTickets.length, true);
  assert.equal(proof.appDemoSnapshots.some((snapshot) => snapshot.stage === "final"), true);
  assert.equal(proof.agentConversations.length >= 14, true);
  assert.equal(proof.agentConversations.every((conversation) => conversation.inputContext && conversation.result), true);
  if (agentMode === "codex") {
    assert.equal(proof.agentConversations.every((conversation) => conversation.prompt), true);
    assert.equal(proof.roleProfiles.filter((profile) => profile.adapter === "codex").length >= 3, true);
  }
  assert.equal(proof.appDemoSnapshots.some((snapshot) => snapshot.stage === "vertical"), true);
  assert.equal(proof.appDemoSnapshots.some((snapshot) => snapshot.stage === "final"), true);
  assert.equal(existsSync(join(targetRepoPath, "src", "server.mjs")), true);
  assert.equal(existsSync(join(targetRepoPath, "public", "index.html")), true);
  assert.equal(existsSync(join(targetRepoPath, "src", "recurrence.mjs")), true);
  assert.equal(existsSync(join(targetRepoPath, "src", "reminders.mjs")), true);

  await context.close();
  context = null;
  await browser.close();
  browser = null;

  if (mode === "record") {
    const recordingDurationSeconds = Number(((Date.now() - recordingStartedAt) / 1000).toFixed(3));
    const videoPath = finalizeVideo(recordingDir, proof.timeline.trimSuggestion, recordingDurationSeconds);
    writeFileSync(
      join(recordingDir, "proof.json"),
      JSON.stringify({ appUrl, fixtureRoot, targetRepoPath, videoPath, ...proof }, null, 2),
      "utf8",
    );
    console.log(`Recorded Floop big-work demo: ${videoPath}`);
    console.log(`Proof bundle: ${join(recordingDir, "proof.json")}`);
    if (openAfterRecord) {
      openRecording(videoPath);
    }
  } else {
    console.log("Playwright big-work proof passed");
    console.log(`Feature tickets: ${proof.featureTickets.map((ticket) => ticket.title).join(", ")}`);
    console.log(`Done tickets: ${proof.doneTickets.map((ticket) => ticket.key).join(", ")}`);
  }
  completed = true;
} finally {
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await stopAppServer();
  await mergeDriver?.stop().catch(() => {});
  await executionDriver?.stop().catch(() => {});
  await closeServer(server);
  store?.close();
  if (!completed && agentMode === "codex") {
    console.error(`Codex big-work demo failed; retained fixture for inspection: ${fixtureRoot}`);
  } else if (process.env.FLOOP_DEMO_KEEP_FIXTURE !== "true") {
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

  const parentTicket = store.createTicket(project.id, {
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
  await page.getByText(parentTicket.title).first().waitFor();
  await pause(1000);

  store.createExecution(project.id, parentTicket.id, {
    role: "product_manager",
    reason: "Pre-planning breakdown: turn the big calendar goal into feature tickets.",
  });
  const featureTickets = await waitDuringIdle("product manager codex feature breakdown", () =>
    waitForFeatureTickets(project.id, parentTicket.id, 4),
  );
  const demoTickets = resolveDemoFeatureTickets(featureTickets);
  await refresh(page);
  await page.getByText(demoTickets.vertical.title).first().waitFor();
  await page.getByText(demoTickets.recurrence.title).first().waitFor();
  await pause(1200);

  await clickByText(page, "Cockpit");
  await page.getByText("Agent Work").first().waitFor();
  await openRunProof(page, "architect iteration 1");
  await pause(1600);
  await closeAnyOpenRunProof(page);
  await openRunProof(page, "product_manager iteration 1");
  await pause(2200);

  await closeAnyOpenRunProof(page);
  await clickByText(page, "Board");
  await runTicketLoopFromUi(page, demoTickets.vertical.title);
  await waitForTicketState(demoTickets.vertical.title, "DONE", 45_000);
  await page.getByText("Done").first().waitFor();
  await pause(1000);
  await demoCalendarApp(page, appUrl, "vertical");

  await runTicketLoopFromUi(page, demoTickets.recurrence.title);
  await waitForTicketState(demoTickets.recurrence.title, "DONE", 45_000);
  await runTicketLoopFromUi(page, demoTickets.reminders.title);
  await waitForTicketState(demoTickets.reminders.title, "DONE", 45_000);

  await runTicketLoopFromUi(page, demoTickets.final.title);
  await waitForTicketState(demoTickets.final.title, "DONE", 45_000);
  for (const extraTicket of demoTickets.extras) {
    await runTicketLoopFromUi(page, extraTicket.title);
    await waitForTicketState(extraTicket.title, "DONE", 45_000);
  }
  await demoCalendarApp(page, appUrl, "final");

  await clickByText(page, "Cockpit");
  await page.getByText("Agent Work").first().waitFor();
  await openRunProof(page, "developer iteration 1");
  await pause(2200);
  await page.locator(".agent-trace-summary").first().waitFor({ state: "visible" });
  await pause(800);
}

async function configureAgents(projectId) {
  await updateProjectPolicy(projectId, {
    requireReviewer: true,
    requireValidator: true,
    requireHumanApprovalBeforeMerge: false,
    requiredValidationCommandProfileForMerge: "ci",
    maxParallelExecutions: 4,
    maxParallelMerges: 2,
    maxAutoContinueIterations: 3,
    interactionMode: "autopilot",
    refinementMode: "autonomous",
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

async function runTicketLoopFromUi(page, title) {
  if ((await page.locator(".ticket-detail:visible").count()) === 0) {
    await clickByText(page, "Board");
    await clickByText(page, title);
  }
  await page.getByText("Start developer lane").first().waitFor();
  await fillByName(page, "summary", "Operator starts the first implementation slice.");
  await clickByText(page, "Start run");
  const firstState = await waitForTicketInStates(title, ["WORKING", "REVIEWING", "VALIDATING", "READY_TO_MERGE", "DONE"], agentWaitMs(12_000, 90_000));
  if (firstState.state === "WORKING") {
    await revealTicketState(page, title, "Working");
  }
  await pause(1600);
  await waitDuringIdle(`${title} developer implementation`, () =>
    waitForTicketAtOrPast(title, "REVIEWING", featureLoopWaitMs()),
  );
  await tryRevealTicketState(page, title, "Reviewing");
  await pause(1000);
  await waitDuringIdle(`${title} independent review`, () =>
    waitForTicketAtOrPast(title, "VALIDATING", featureLoopWaitMs()),
  );
  await tryRevealTicketState(page, title, "Validating");
  await pause(1000);
  await waitDuringIdle(`${title} independent validation`, () =>
    waitForTicketState(title, "READY_TO_MERGE", featureLoopWaitMs()),
  );
  await revealTicketState(page, title, "Ready to merge");
  await pause(1000);
  await mergeDriver.pollOnce();
  await waitForTicketState(title, "DONE", 30_000);
  await revealTicketState(page, title, "Done");
  await pause(1200);
  await closeTicketDetail(page);
  await pause(500);
}

async function revealTicketState(page, title, label) {
  try {
    await page.getByText(label).first().waitFor({ timeout: 3500 });
    return;
  } catch {
    await closeTicketDetail(page);
    await refresh(page);
    await clickByText(page, "Board");
    await clickByText(page, title);
    await page.getByText(label).first().waitFor({ timeout: 10_000 });
  }
}

async function tryRevealTicketState(page, title, label) {
  try {
    await revealTicketState(page, title, label);
  } catch {
    await refresh(page);
    await clickByText(page, "Board");
    await clickByText(page, title);
  }
}

async function waitForTicketState(title, state, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const project = store.listProjects()[0];
    const ticket = project ? store.listTickets(project.id).find((item) => item.title === title) : null;
    if (ticket?.state === state) return ticket;
    await pause(250);
  }
  throw new Error(`Timed out waiting for ${title} to reach ${state}`);
}

async function waitForTicketInStates(title, states, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const project = store.listProjects()[0];
    const ticket = project ? store.listTickets(project.id).find((item) => item.title === title) : null;
    if (ticket && states.includes(ticket.state)) return ticket;
    await pause(250);
  }
  throw new Error(`Timed out waiting for ${title} to reach one of ${states.join(", ")}`);
}

async function waitForTicketAtOrPast(title, targetState, timeoutMs) {
  const order = ["DRAFT", "PROPOSED", "READY", "WORKING", "REVIEWING", "VALIDATING", "READY_TO_MERGE", "DONE"];
  const targetIndex = order.indexOf(targetState);
  if (targetIndex < 0) {
    throw new Error(`Unknown ticket progression state ${targetState}`);
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const project = store.listProjects()[0];
    const ticket = project ? store.listTickets(project.id).find((item) => item.title === title) : null;
    const stateIndex = ticket ? order.indexOf(ticket.state) : -1;
    if (stateIndex >= targetIndex) return ticket;
    await pause(250);
  }
  throw new Error(`Timed out waiting for ${title} to reach at least ${targetState}`);
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

function resolveDemoFeatureTickets(tickets) {
  const remaining = [...tickets];
  const pick = (label, keywords, fallbackIndex) => {
    const ranked = remaining
      .map((ticket) => ({ ticket, score: scoreTicketIntent(ticket, keywords) }))
      .sort((left, right) => right.score - left.score);
    const selected = ranked[0]?.score > 0 ? ranked[0].ticket : remaining[fallbackIndex] || remaining[0];
    if (!selected) {
      throw new Error(`Could not resolve ${label} feature ticket`);
    }
    remaining.splice(remaining.findIndex((ticket) => ticket.id === selected.id), 1);
    return selected;
  };

  const vertical = pick("vertical slice", ["vertical", "slice", "api", "frontend", "browser", "create", "event"], 0);
  const recurrence = pick("recurrence", ["recurr", "repeat", "daily", "weekly"], 0);
  const reminders = pick("reminders", ["reminder", "notification", "notify"], 0);
  const final = pick("final integration", ["integrat", "final", "end-to-end", "complete"], 0);
  return { vertical, recurrence, reminders, final, extras: remaining };
}

function scoreTicketIntent(ticket, keywords) {
  const text = [ticket.title, ticket.brief, ticket.acceptanceCriteriaMd, ticket.definitionOfDoneMd]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  return keywords.reduce((score, keyword) => score + (text.includes(keyword) ? 1 : 0), 0);
}

function agentWaitMs(fixtureMs, codexMs) {
  return agentMode === "codex" ? codexMs : fixtureMs;
}

function featureLoopWaitMs() {
  return agentWaitMs(30_000, 1_800_000);
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

async function mergeTicketNow(projectId, title) {
  const ticket = store.listTickets(projectId).find((item) => item.title === title);
  assert.ok(ticket, `Expected ticket ${title}`);
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
  await page.getByText("Team schedule").first().waitFor();
  await pause(700);
  const demoTitle = stage === "final" ? "Final stakeholder demo" : "Workflow demo";
  const demoStart = stage === "final" ? "2026-06-19T11:00" : "2026-06-18T10:00";
  await page.locator('input[name="title"]').fill(demoTitle);
  await page.locator('input[name="startsAt"]').fill(demoStart);
  await page.getByRole("button", { name: "Add event" }).click();
  await pause(700);
  if ((await page.getByText(demoTitle).count()) === 0) {
    await page.evaluate(
      async ({ title, startsAt }) => {
        await fetch("/api/events", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title, startsAt }),
        });
      },
      { title: demoTitle, startsAt: demoStart },
    );
    await page.reload();
  }
  const eventsPayload = await fetch(`${appUrl}/api/events`).then((response) => response.json());
  const events = normalizeCalendarEvents(eventsPayload);
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

function normalizeCalendarEvents(payload) {
  if (Array.isArray(payload?.events)) return payload.events;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

async function waitForCalendarAppPort(child, stdoutText, fallbackPort) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const output = stdoutText();
    const match = output.match(/calendar app listening on (\d+)/);
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
  const openItems = page.locator(".run-subway-item").filter({ has: page.locator(".log-dock") });
  const count = await openItems.count();
  for (let index = 0; index < count; index += 1) {
    await openItems.nth(index).locator(".run-subway-main").click();
    await pause(100);
  }
}

async function openRunProof(page, text) {
  const item = page.locator(".run-subway-item").filter({ hasText: text }).first();
  const button = item.locator(".run-subway-main").first();
  await moveTo(page, button);
  await button.click();
  const traceSummary = item.locator(".log-dock .agent-trace-summary").first();
  await traceSummary.waitFor({ state: "visible", timeout: 5000 });
  await traceSummary.scrollIntoViewIfNeeded();
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

function baseUrl() {
  return `http://127.0.0.1:${server.address().port}`;
}

function collectProof() {
  const projects = store.listProjects();
  const project = projects[0];
  const repos = project ? store.listRepos(project.id) : [];
  const tickets = project ? store.listTickets(project.id) : [];
  const parentTickets = tickets.filter((ticket) => ticket.title === "Build a calendar application with frontend and backend");
  const parent = parentTickets[0];
  const featureTickets = parent ? store.listTickets(project.id, { parentTicketId: parent.id }) : [];
  const artifacts = project ? store.listArtifacts(project.id, { limit: 200 }) : [];
  const runObservability = project ? collectRunObservability(project.id) : { summary: {}, runs: [] };
  return {
    agentMode,
    timeline: {
      ...timeline,
      trimSuggestion: buildTrimSuggestion(timeline.idleRanges),
    },
    projects,
    repos,
    roleProfiles: project?.roleProfiles || [],
    tickets,
    parentTickets,
    featureTickets,
    reviewCount: featureTickets.reduce((count, ticket) => count + (store.getTicket(project.id, ticket.id)?.reviews.length || 0), 0),
    validationCount: featureTickets.reduce((count, ticket) => count + (store.getTicket(project.id, ticket.id)?.validations.length || 0), 0),
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
    runObservability,
    targetRepoHead: existsSync(targetRepoPath)
      ? gitSync(["-C", targetRepoPath, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim()
      : "",
  };
}

function buildTrimSuggestion(idleRanges) {
  return idleRanges.map((range) => ({
    label: range.label,
    removeFromSeconds: Number(Math.max(0, range.startSeconds + 1).toFixed(3)),
    removeToSeconds: Number(Math.max(range.startSeconds + 1, range.endSeconds - 1).toFixed(3)),
  })).filter((range) => range.removeToSeconds > range.removeFromSeconds);
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
  if (trimSuggestion.length === 0) {
    renameSync(webm, destination);
    return destination;
  }
  renameSync(webm, rawDestination);
  try {
    renderTrimmedVideo(rawDestination, destination, trimSuggestion, recordingDurationSeconds);
  } catch (error) {
    console.warn(`Could not render trimmed demo video; keeping raw recording: ${error.message}`);
    return rawDestination;
  }
  return destination;
}

function renderTrimmedVideo(source, destination, trimSuggestion, recordingDurationSeconds) {
  const keepRanges = buildKeepRanges(trimSuggestion, recordingDurationSeconds);
  if (keepRanges.length === 0) {
    throw new Error("idle ranges removed the full recording");
  }
  const trimFilters = keepRanges
    .map((range, index) => {
      const start = formatSeconds(range.start);
      const end = Number.isFinite(range.end) ? `:end=${formatSeconds(range.end)}` : "";
      return `[0:v]trim=start=${start}${end},setpts=PTS-STARTPTS[v${index}]`;
    })
    .join(";");
  const concatInputs = keepRanges.map((_, index) => `[v${index}]`).join("");
  const filter = `${trimFilters};${concatInputs}concat=n=${keepRanges.length}:v=1:a=0[v]`;
  execFileSync(
    "ffmpeg",
    ["-y", "-i", source, "-filter_complex", filter, "-map", "[v]", "-an", "-c:v", "libvpx-vp9", "-b:v", "1.8M", destination],
    { stdio: "ignore" },
  );
}

function buildKeepRanges(trimSuggestion, recordingDurationSeconds) {
  const sortedCuts = trimSuggestion
    .map((range) => ({
      start: Number(range.removeFromSeconds),
      end: Number(range.removeToSeconds),
    }))
    .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start)
    .sort((left, right) => left.start - right.start);
  const keepRanges = [];
  let cursor = 0;
  for (const cut of sortedCuts) {
    const start = Math.max(0, cut.start);
    const end = Math.max(start, cut.end);
    if (start - cursor > 0.25) {
      keepRanges.push({ start: cursor, end: start });
    }
    cursor = Math.max(cursor, end);
  }
  if (!Number.isFinite(recordingDurationSeconds) || recordingDurationSeconds <= cursor + 0.25) {
    keepRanges.push({ start: cursor, end: Number.POSITIVE_INFINITY });
  } else {
    keepRanges.push({ start: cursor, end: recordingDurationSeconds });
  }
  return keepRanges.filter((range) => !Number.isFinite(range.end) || range.end - range.start > 0.25);
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
  const locator = page.locator(`[name="${name}"]`).last();
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
