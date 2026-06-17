import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import { createFloopServer } from "../services/api/src/app.mjs";
import { createCeremonyParticipantDriver } from "../services/api/src/ceremony-participant-driver.mjs";
import { createExecutionDriver } from "../services/api/src/execution-driver.mjs";
import { createMergeDriver } from "../services/api/src/merge-driver.mjs";
import { createStore } from "../services/api/src/store.mjs";
import {
  BIG_WORK_IDLE_DEFINITION,
  buildKeepRanges,
  buildTrimMetadata,
  buildTrimSuggestion,
} from "./record-big-work-demo-lib.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadDotEnv();
const mode = process.argv.includes("--record") ? "record" : "proof";
const openAfterRecord = process.argv.includes("--open");
const outputRoot = resolve(process.env.FLOOP_DEMO_OUTPUT_DIR || join(repoRoot, "demo-recordings"));
const fixtureRoot = mkdtempSync(join(tmpdir(), `floop-usage-demo-${mode}-`));
const workspaceRoot = join(fixtureRoot, "workspace");
const targetRepoPath = join(fixtureRoot, "demo-product");
const dbPath = join(fixtureRoot, "floop.sqlite");
const recordingDir = join(outputRoot, new Date().toISOString().replace(/[:.]/g, "-"));
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
let ceremonyParticipantDriver;
let browser;
let context;
let recordingStartedAt = Date.now();
const timeline = {
  marks: [],
  idleRanges: [],
};

try {
  initializeTargetRepo(targetRepoPath);
  store = createStore({ filename: dbPath, seedDemo: false, workspaceRoot });
  server = createFloopServer({ store });
  await listen(server);
  const appUrl = `http://127.0.0.1:${server.address().port}`;
  executionDriver = createExecutionDriver({ store, pollIntervalMs: 150, logger: demoLogger });
  mergeDriver = createMergeDriver({ store, pollIntervalMs: 10000, logger: demoLogger });
  ceremonyParticipantDriver = createCeremonyParticipantDriver({
    store,
    pollIntervalMs: 150,
    maxParallel: 6,
    logger: demoLogger,
  });
  executionDriver.start();
  ceremonyParticipantDriver.start();

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
  await installVisibleCursor(page);
  await runWalkthrough(page, appUrl);

  const proof = collectProof();
  assert.equal(proof.projects.length, 1);
  assert.equal(proof.repos.length, 1);
  assert.equal(proof.doneTickets.length >= 1, true);
  assert.equal(proof.followupTickets.length >= 1, true);
  assert.equal(proof.ceremonyRuns.length >= 2, true);
  assert.equal(proof.artifacts.length >= 3, true);
  assert.equal(proof.artifacts.some((artifact) => artifact.kind === "demo" || artifact.metadata?.demoEvidence === true), true);
  assert.equal(proof.runObservability.summary.executions >= 1, true);
  assert.equal(proof.runObservability.summary.ceremonies >= 2, true);
  assert.equal(proof.timeline.idleDefinition, BIG_WORK_IDLE_DEFINITION);
  assert.equal(proof.timeline.marks.length >= 8, true);
  assert.equal(proof.timeline.idleRanges.length >= 1, true);
  assert.equal(proof.timeline.trimSuggestion.length >= 1, true);

  await context.close();
  context = null;
  await browser.close();
  browser = null;

  if (mode === "record") {
    const recordingDurationSeconds = elapsedSeconds();
    const finalizedVideo = finalizeVideo(recordingDir, proof.timeline.trimSuggestion, recordingDurationSeconds);
    writeFileSync(
      join(recordingDir, "proof.json"),
      JSON.stringify(
        {
          appUrl,
          fixtureRoot,
          targetRepoPath,
          videoPath: finalizedVideo.videoPath,
          trimmedVideo: finalizedVideo.trimMetadata,
          ...proof,
        },
        null,
        2,
      ),
      "utf8",
    );
    console.log(`Recorded Floop usage demo: ${finalizedVideo.videoPath}`);
    console.log(`Proof bundle: ${join(recordingDir, "proof.json")}`);
    if (openAfterRecord) {
      openRecording(finalizedVideo.videoPath);
    }
  } else {
    console.log("Playwright usage proof passed");
    console.log(`Project: ${proof.projects[0].name}`);
    console.log(`Done tickets: ${proof.doneTickets.map((ticket) => ticket.key).join(", ")}`);
    console.log(`Ceremonies: ${proof.ceremonyRuns.map((run) => run.type).join(", ")}`);
  }
} finally {
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await ceremonyParticipantDriver?.stop().catch(() => {});
  await mergeDriver?.stop().catch(() => {});
  await executionDriver?.stop().catch(() => {});
  await closeServer(server);
  store?.close();
  if (process.env.FLOOP_DEMO_KEEP_FIXTURE !== "true") {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

async function runWalkthrough(page, appUrl) {
  await page.goto(appUrl);
  markTimeline("opened onboarding");
  await page.getByText("No project selected").first().waitFor();
  await pause(500);

  await fillByName(page, "existingPath", targetRepoPath);
  await fillByName(page, "name", "Floop Usage Demo");
  await fillByName(page, "slug", "floop-usage-demo");
  await fillByName(page, "defaultBaseBranch", "main");
  await fillByName(page, "description", "A recorded local agent loop for the Floop demo reel.");
  await clickByText(page, "Create project");
  await page.getByText("Floop Usage Demo").first().waitFor();
  markTimeline("created project");
  await pause(700);

  const project = store.listProjects()[0];
  assert.ok(project, "Expected created project");
  await updateProject(project.id, { workspaceRoot });
  await configureAgents(project.id);

  await clickByText(page, "Settings");
  await page.getByText("Repositories").first().waitFor();
  await page.getByText("demo-product").first().waitFor();
  await clickByText(page, "Show profiles");
  await page.getByText("Agent Profiles").first().waitFor();
  markTimeline("verified agent profiles");
  await pause(1000);
  await clickByText(page, "Close settings");
  await page.locator(".settings-drawer").waitFor({ state: "hidden" });
  await pause(500);

  await createTicketFromUi(page, {
    title: "Build the demo dashboard",
    brief: "Add a visible dashboard marker so Floop can prove the local repo changed.",
  });
  await runTicketLoopFromUi(page, "Build the demo dashboard");
  await waitDuringIdle("confirm completed demo dashboard ticket", () => waitForTicketState("Build the demo dashboard", "DONE", 45_000));
  await page.getByText("Done").first().waitFor();
  markTimeline("dashboard ticket done");
  await pause(1000);

  await clickByText(page, "New Ticket");
  await fillByName(page, "title", "Investigate flaky validation");
  await fillByName(page, "brief", "Capture a blocked work item for the decision queue.");
  await clickByText(page, "Create ticket");
  await page.getByText("Investigate flaky validation").first().waitFor();
  await blockTicket("Investigate flaky validation");
  await closeTicketDetail(page);
  await refresh(page);
  await page.getByText("Blocked").first().waitFor();
  await page.getByText("Investigate flaky validation").first().waitFor();
  markTimeline("blocked ticket visible");
  await pause(700);

  await clickByText(page, "Ceremonies");
  await page.getByText("Refinement").first().waitFor();
  await clickByText(page, "Run fan-out");
  await waitDuringIdle("refinement ceremony participants complete", () => waitForCeremonyParticipants());
  await refresh(page);
  await page.getByText("Agent consensus").first().waitFor({ timeout: 20_000 });
  markTimeline("refinement consensus visible");
  await pause(1000);

  await clickByText(page, "Daily triage");
  await clickByText(page, "Run fan-out");
  await waitDuringIdle("daily triage ceremony starts", () => waitForCeremonyCount(2));
  await waitDuringIdle("daily triage participants complete", () => waitForCeremonyParticipants());
  await refresh(page);
  markTimeline("daily triage complete");
  await pause(1000);

  await clickByText(page, "Cockpit");
  await page.getByText("Agent Work").first().waitFor();
  await page.getByText("Attention").first().waitFor();
  await page.getByText("Ceremony proposals").first().waitFor();
  await page.getByText("Blocked").first().waitFor();
  await openDeveloperRunProof(page);
  markTimeline("developer run proof visible");
  await pause(2200);
  await clickFirstDecisionApply(page);
  await waitDuringIdle("operator-applied ceremony proposal persists", () => waitForAppliedCeremony());
  await refresh(page);
  markTimeline("ceremony proposal applied");
  await pause(900);

  await page.getByText("Activity").first().waitFor();
  await page.getByText("Artifacts").first().waitFor();
  markTimeline("activity and artifacts visible");
  await pause(1000);
}

async function createTicketFromUi(page, { title, brief }) {
  await clickByText(page, "New Ticket");
  await fillByName(page, "title", title);
  await fillByName(page, "brief", brief);
  await clickByText(page, "Create ticket");
  await page.getByText(title).first().waitFor();
  markTimeline(`created ticket: ${title}`);
  await pause(700);
}

async function runTicketLoopFromUi(page, title) {
  if ((await page.locator(".ticket-detail:visible").count()) === 0) {
    await clickByText(page, "Board");
    await clickByText(page, title);
  }
  await page.getByText("Start developer lane").first().waitFor();
  await fillByName(page, "summary", "Operator starts the real developer agent.");
  await clickByText(page, "Dispatch agent");
  await waitDuringIdle(`${title} dispatch reaches working`, () => waitForTicketState(title, "WORKING", 12_000));
  await revealTicketState(page, title, "Working");
  markTimeline(`${title} working`);
  await pause(1800);
  await waitDuringIdle(`${title} developer finishes`, () => waitForTicketState(title, "REVIEWING", 30_000));
  await revealTicketState(page, title, "Reviewing");
  markTimeline(`${title} reviewing`);
  await pause(1800);
  await waitDuringIdle(`${title} reviewer finishes`, () => waitForTicketState(title, "VALIDATING", 30_000));
  await revealTicketState(page, title, "Validating");
  markTimeline(`${title} validating`);
  await pause(1800);
  await waitDuringIdle(`${title} validator finishes`, () => waitForTicketState(title, "READY_TO_MERGE", 30_000));
  await revealTicketState(page, title, "Ready to merge");
  markTimeline(`${title} ready to merge`);
  await pause(1400);
  await waitDuringIdle(`${title} merge lands`, () => mergeDriver.pollOnce());
  await waitDuringIdle(`${title} merge state reaches done`, () => waitForTicketState(title, "DONE", 30_000));
  await revealTicketState(page, title, "Done");
  markTimeline(`${title} done`);
  await pause(1400);
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

async function closeTicketDetail(page) {
  if ((await page.locator(".ticket-detail:visible").count()) === 0) return;
  await clickByText(page, "Close ticket detail");
  await page.locator(".ticket-detail").waitFor({ state: "hidden" });
}

async function configureAgents(projectId) {
  await updateProjectPolicy(projectId, {
    requireReviewer: true,
    requireValidator: true,
    requireHumanApprovalBeforeMerge: false,
    requiredValidationCommandProfileForMerge: "ci",
    maxParallelExecutions: 6,
    maxParallelMerges: 2,
    maxAutoContinueIterations: 4,
    interactionMode: "autopilot",
    refinementMode: "autonomous",
    agentCreatedTicketDefaultState: "PROPOSED",
  });

  const profiles = {
    developer: commandFromEnv("developer", developerCommand()),
    reviewer: commandFromEnv("reviewer", reviewerCommand()),
    validator: commandFromEnv("validator", validatorCommand()),
    product_manager: commandFromEnv("product_manager", ceremonyCommand("product manager")),
    architect: commandFromEnv("architect", ceremonyCommand("architect")),
    integrator: commandFromEnv("integrator", ceremonyCommand("integrator")),
  };

  for (const [role, command] of Object.entries(profiles)) {
    await updateRoleProfile(projectId, role, command);
  }
}

function commandFromEnv(role, fallback) {
  const normalized = role.toUpperCase();
  const command =
    process.env[`FLOOP_DEMO_${normalized}_COMMAND`] ||
    process.env[`FLOOP_AGENT_${normalized}_COMMAND`] ||
    process.env.FLOOP_DEMO_AGENT_COMMAND ||
    "";
  if (!command.trim()) return fallback;
  return {
    adapter: "shell",
    model: `env-${role}`,
    config: { command },
  };
}

function developerCommand() {
  return {
    adapter: "shell",
    model: "local-shell-agent",
    config: {
      command: nodeEvalCommand(`
        const fs = require("node:fs");
        const path = require("node:path");
        const { execFileSync } = require("node:child_process");
        if (process.env.FLOOP_CEREMONY_ROLE) {
          const role = process.env.FLOOP_CEREMONY_ROLE;
          const type = process.env.FLOOP_CEREMONY_TYPE;
          fs.writeFileSync(process.env.FLOOP_RESULT_PATH, JSON.stringify({
            outcome: "completed",
            summaryMd: role + " contributed to " + type + " with implementation context.",
            questionsMd: "No blocking questions from " + role + ".",
            riskMd: "Implementation scope looks bounded.",
            payload: { participant: role, ceremonyType: type, note: "developer" }
          }));
        } else {
        const worktree = process.env.FLOOP_WORKTREE_PATH;
        const ticketKey = process.env.FLOOP_TICKET_KEY.toLowerCase();
        console.log("[agent] inspect context " + process.env.FLOOP_CONTEXT_PATH);
        console.log("[agent] enter worktree " + worktree);
        fs.mkdirSync(path.join(worktree, "demo"), { recursive: true });
        console.log("[agent] create implementation artifact demo/" + ticketKey + ".md");
        fs.writeFileSync(path.join(worktree, "demo", ticketKey + ".md"), "# " + process.env.FLOOP_TICKET_TITLE + "\\n\\nImplemented by the local developer agent.\\n\\nProof timestamp: " + new Date().toISOString() + "\\n");
        fs.writeFileSync(process.env.FLOOP_RESULT_PATH + ".developer.log", "developer agent entered worktree " + worktree + "\\ncreated demo/" + ticketKey + ".md\\n");
        console.log("[agent] stage changed files");
        execFileSync("git", ["-C", worktree, "add", "-A"]);
        console.log("[agent] commit implementation");
        execFileSync("git", ["-C", worktree, "commit", "-m", "Implement " + process.env.FLOOP_TICKET_KEY]);
        console.log("[agent] verify durable evidence paths");
        sleep(3200);
        console.log("[agent] write result JSON " + process.env.FLOOP_RESULT_PATH);
        fs.writeFileSync(process.env.FLOOP_RESULT_PATH, JSON.stringify({
          outcome: "completed",
          summaryMd: "Developer agent changed the local repo and committed evidence.",
          artifacts: [
            { kind: "report", label: "Developer implementation note", uri: "file://" + path.join(worktree, "demo", ticketKey + ".md") },
            { kind: "log", label: "Developer work log", uri: "file://" + process.env.FLOOP_RESULT_PATH + ".developer.log" }
          ],
          followupTickets: [{
            title: "Document " + process.env.FLOOP_TICKET_KEY + " operator notes",
            brief: "Follow-up ticket created by the developer agent during the demo.",
            acceptanceCriteriaMd: "- Notes explain the agent change\\n- Evidence is linked from Floop",
            definitionOfDoneMd: "- Documentation is reviewed",
            priority: "medium",
            state: "PROPOSED",
            assignedRole: "product_manager",
            repoTargets: []
          }]
        }));
        }
      `),
    },
  };
}

function reviewerCommand() {
  return {
    adapter: "shell",
    model: "local-shell-reviewer",
    config: {
      command: nodeEvalCommand(`
        const fs = require("node:fs");
        if (process.env.FLOOP_CEREMONY_ROLE) {
          const role = process.env.FLOOP_CEREMONY_ROLE;
          const type = process.env.FLOOP_CEREMONY_TYPE;
          fs.writeFileSync(process.env.FLOOP_RESULT_PATH, JSON.stringify({
            outcome: "completed",
            summaryMd: role + " contributed to " + type + " with review context.",
            questionsMd: "No blocking questions from " + role + ".",
            riskMd: "Review risk is low for the demo change.",
            payload: { participant: role, ceremonyType: type, note: "reviewer" }
          }));
        } else {
        console.log("[agent] inspect developer execution evidence");
        sleep(2600);
        console.log("[agent] review changed artifacts");
        fs.writeFileSync(process.env.FLOOP_RESULT_PATH + ".review.md", "reviewer inspected execution artifacts at " + new Date().toISOString() + "\\nreview passed\\n");
        console.log("[agent] write passed review result");
        fs.writeFileSync(process.env.FLOOP_RESULT_PATH, JSON.stringify({
          outcome: "completed",
          summaryMd: "Reviewer agent inspected the developer evidence.",
          review: {
            verdict: "passed",
            summaryMd: "Reviewer agent approved the committed local change.",
            findings: [],
            artifacts: [{ kind: "report", label: "Reviewer approval", uri: "file://" + process.env.FLOOP_RESULT_PATH + ".review.md" }]
          }
        }));
        }
      `),
    },
  };
}

function validatorCommand() {
  return {
    adapter: "shell",
    model: "local-shell-validator",
    config: {
      command: nodeEvalCommand(`
        const fs = require("node:fs");
        if (process.env.FLOOP_CEREMONY_ROLE) {
          const role = process.env.FLOOP_CEREMONY_ROLE;
          const type = process.env.FLOOP_CEREMONY_TYPE;
          fs.writeFileSync(process.env.FLOOP_RESULT_PATH, JSON.stringify({
            outcome: "completed",
            summaryMd: role + " contributed to " + type + " with validation context.",
            questionsMd: "No blocking questions from " + role + ".",
            riskMd: "Validation path is clear.",
            payload: { participant: role, ceremonyType: type, note: "validator" }
          }));
        } else {
        console.log("[agent] inspect reviewer-approved change");
        sleep(2600);
        console.log("[agent] run local validation check");
        fs.writeFileSync(process.env.FLOOP_RESULT_PATH + ".validation.log", "validator ran local evidence check at " + new Date().toISOString() + "\\nlocal validation passed\\n");
        fs.writeFileSync(process.env.FLOOP_RESULT_PATH + ".demo.md", "# Usage demo evidence\\n\\nValidator confirmed the demo dashboard artifact exists and can be reviewed from Floop.\\n");
        console.log("[agent] write passed validation result");
        fs.writeFileSync(process.env.FLOOP_RESULT_PATH, JSON.stringify({
          outcome: "completed",
          summaryMd: "Validator agent ran the local evidence check.",
          validation: {
            verdict: "passed",
            summaryMd: "Validator agent accepted the reviewer-approved change.",
            commandProfile: "ci",
            commands: ["local demo validation"],
            artifacts: [
              { kind: "log", label: "Validator output", uri: "file://" + process.env.FLOOP_RESULT_PATH + ".validation.log" },
              { kind: "demo", label: "Usage demo evidence", uri: "file://" + process.env.FLOOP_RESULT_PATH + ".demo.md", metadata: { demoEvidence: true } }
            ]
          }
        }));
        }
      `),
    },
  };
}

function ceremonyCommand(label) {
  return {
    adapter: "shell",
    model: "local-shell-ceremony",
    config: {
      command: nodeEvalCommand(`
        const fs = require("node:fs");
        const role = process.env.FLOOP_CEREMONY_ROLE;
        const type = process.env.FLOOP_CEREMONY_TYPE;
        sleep(2200);
        fs.writeFileSync(process.env.FLOOP_RESULT_PATH, JSON.stringify({
          outcome: "completed",
          summaryMd: role + " contributed to " + type + " as a real local shell participant.",
          questionsMd: "No blocking questions from " + role + ".",
          riskMd: "Keep operator approval visible before mutation.",
          payload: { participant: role, ceremonyType: type, note: ${JSON.stringify(label)} }
        }));
      `),
    },
  };
}

function nodeEvalCommand(source) {
  const sleepHelper = "function sleep(ms){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);}";
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`${sleepHelper} ${source}`.trim().replace(/\s+/g, " "))}`;
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

function blockTicket(title) {
  const project = store.listProjects()[0];
  const ticket = project ? store.listTickets(project.id).find((item) => item.title === title) : null;
  assert.ok(project && ticket, `Expected ticket ${title} to exist`);
  store.transitionTicket(project.id, ticket.id, {
    targetState: "BLOCKED",
    reason: "Demo creates a blocked item for the decision queue.",
    reasonCode: "demo_blocked_work",
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

async function waitForTicketState(title, state, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tickets = store.listTickets(store.listProjects()[0].id);
    const ticket = tickets.find((item) => item.title === title);
    if (ticket?.state === state) return ticket;
    await pause(250);
  }
  throw new Error(`Timed out waiting for ${title} to reach ${state}\n\n${describeTicket(title)}`);
}

function describeTicket(title) {
  const project = store.listProjects()[0];
  if (!project) return "No project exists.";
  const ticket = store.listTickets(project.id).find((item) => item.title === title);
  if (!ticket) return `No ticket found with title ${JSON.stringify(title)}.`;
  const executions = store.listExecutions(project.id, ticket.id) || [];
  const reviews = store.listReviews(project.id, ticket.id) || [];
  const validations = store.listValidations(project.id, ticket.id) || [];
  const events = store.listEvents(project.id, { limit: 10 }) || [];
  return JSON.stringify(
    {
      ticket: {
        key: ticket.key,
        state: ticket.state,
        assignedRole: ticket.assignedRole,
        repoTargets: ticket.repoTargets,
        mergeStatus: ticket.mergeStatus,
      },
      executions: executions.map((execution) => ({
        id: execution.id,
        role: execution.role,
        status: execution.status,
        outcome: execution.outcome,
        summaryMd: execution.summaryMd,
        failureKind: execution.failureKind,
        worktrees: execution.worktrees,
      })),
      reviews,
      validations,
      events: events.map((event) => ({
        type: event.type,
        ticketKey: event.ticketKey,
        summary: event.summary,
        createdAt: event.createdAt,
      })),
    },
    null,
    2,
  );
}

async function waitForCeremonyCount(count) {
  const projectId = store.listProjects()[0].id;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (store.listCeremonyRuns(projectId).length >= count) return;
    await pause(250);
  }
  throw new Error(`Timed out waiting for ${count} ceremonies`);
}

async function waitForCeremonyParticipants() {
  const projectId = store.listProjects()[0].id;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const runs = store.listCeremonyRuns(projectId);
    if (runs[0]?.participants.length > 0 && runs[0].participants.every((participant) => participant.status === "completed")) {
      return;
    }
    await pause(250);
  }
  throw new Error("Timed out waiting for ceremony participants");
}

async function waitForAppliedCeremony() {
  const projectId = store.listProjects()[0].id;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (store.listCeremonyRuns(projectId).some((run) => run.status === "applied" || run.status === "partially_applied")) {
      return;
    }
    await pause(250);
  }
  throw new Error("Timed out waiting for applied ceremony");
}

function collectProof() {
  const projects = store.listProjects();
  const project = projects[0];
  const repos = project ? store.listRepos(project.id) : [];
  const tickets = project ? store.listTickets(project.id) : [];
  const ceremonyRuns = project ? store.listCeremonyRuns(project.id) : [];
  const artifacts = project ? store.listArtifacts(project.id, { limit: 100 }) : [];
  const runObservability = project ? collectRunObservability(project.id) : emptyRunObservability();
  return {
    projects,
    repos,
    tickets,
    doneTickets: tickets.filter((ticket) => ticket.state === "DONE"),
    followupTickets: tickets.filter((ticket) => ticket.title.startsWith("Document ")),
    ceremonyRuns,
    artifacts,
    runObservability,
    timeline: {
      ...timeline,
      idleDefinition: BIG_WORK_IDLE_DEFINITION,
      trimSuggestion: buildTrimSuggestion(timeline.idleRanges, elapsedSeconds()),
    },
    targetRepoHead: existsSync(targetRepoPath)
      ? execFileSync("git", ["-C", targetRepoPath, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim()
      : "",
  };
}

function collectRunObservability(projectId) {
  const executions = store.listProjectExecutions(projectId, { limit: 50 }) || [];
  const mergeRuns = store.listMergeRuns(projectId, { limit: 50 }) || [];
  const ceremonyRuns = store.listCeremonyRuns(projectId) || [];
  return {
    summary: {
      executions: executions.length,
      mergeRuns: mergeRuns.length,
      ceremonies: ceremonyRuns.length,
      attention: [
        ...executions.filter((execution) => execution.status === "needs_continue" || ["failed", "blocked"].includes(execution.outcome)),
        ...mergeRuns.filter((run) => ["failed", "blocked"].includes(run.status)),
        ...ceremonyRuns.filter((run) => run.proposals.some((proposal) => proposal.status === "pending")),
      ].length,
    },
    runs: [
      ...executions.map((execution) => ({ kind: "execution", id: execution.id, status: execution.status, outcome: execution.outcome })),
      ...mergeRuns.map((run) => ({ kind: "merge", id: run.id, status: run.status, outcome: run.status })),
      ...ceremonyRuns.map((run) => ({ kind: "ceremony", id: run.id, status: run.status, outcome: run.status })),
    ],
  };
}

function emptyRunObservability() {
  return {
    summary: { executions: 0, mergeRuns: 0, ceremonies: 0, attention: 0 },
    runs: [],
  };
}

async function fillByName(page, name, value) {
  const locator = page.locator(`[name="${name}"]:visible`).last();
  await moveTo(page, locator);
  await locator.fill(value);
  await pause(180);
}

async function selectByName(page, name, value) {
  const locator = page.locator(`[name="${name}"]:visible`).last();
  await moveTo(page, locator);
  await locator.selectOption(value);
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

async function clickFirstDecisionApply(page) {
  const locator = page.locator(".decision-item").filter({ hasText: "Ceremony proposals" }).getByRole("button", { name: "Apply" }).first();
  await moveTo(page, locator);
  await locator.click();
  await pause(700);
}

async function openDeveloperRunProof(page) {
  const developerRun = page.locator(".run-subway-item").filter({ hasText: "developer iteration 1" }).locator(".run-subway-main").first();
  await moveTo(page, developerRun);
  await developerRun.click();
  const traceSummary = page.locator(".run-subway-item").filter({ hasText: "developer iteration 1" }).locator(".agent-trace-summary").first();
  await traceSummary.waitFor({ state: "visible", timeout: 5000 });
  await traceSummary.scrollIntoViewIfNeeded();
}

async function refresh(page) {
  await clickByText(page, "Refresh");
  await pause(500);
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
    if (range.endSeconds - range.startSeconds > 0.5) {
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

function finalizeVideo(dir, trimSuggestion = [], recordingDurationSeconds = 0) {
  const video = readdirSync(dir).find((entry) => entry.endsWith(".webm"));
  if (!video) {
    throw new Error(`No Playwright video found in ${dir}`);
  }
  const source = join(dir, video);
  const target = join(dir, "floop-usage-demo.webm");
  const rawTarget = join(dir, "floop-usage-demo.raw.webm");
  const trimMetadata = buildTrimMetadata({
    recordingDurationSeconds,
    idleRanges: timeline.idleRanges,
    trimSuggestion,
  });
  writeFileSync(join(dir, "trim-ranges.json"), `${JSON.stringify(trimMetadata, null, 2)}\n`, "utf8");
  if (trimSuggestion.length === 0) {
    renameSync(source, target);
    copyFileSync(target, resolve(outputRoot, "floop-usage-demo-latest.webm"));
    return { videoPath: target, trimMetadata };
  }
  renameSync(source, rawTarget);
  try {
    renderTrimmedVideo(rawTarget, target, trimSuggestion, recordingDurationSeconds);
  } catch (error) {
    console.warn(`Could not render trimmed usage demo; keeping raw recording: ${error.message}`);
    copyFileSync(rawTarget, resolve(outputRoot, "floop-usage-demo-latest.webm"));
    return { videoPath: rawTarget, trimMetadata: { ...trimMetadata, trimmedDurationSeconds: recordingDurationSeconds, cutSeconds: 0 } };
  }
  copyFileSync(target, resolve(outputRoot, "floop-usage-demo-latest.webm"));
  return { videoPath: target, trimMetadata };
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

function openRecording(videoPath) {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", videoPath] : [videoPath];
  try {
    const child = spawn(opener, args, {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", (error) => {
      console.warn(`Could not open recording automatically: ${error.message}`);
      console.log(`Recording ready: ${videoPath}`);
    });
    child.unref();
    console.log(`Opened recording: ${videoPath}`);
  } catch (error) {
    console.log(`Recording ready: ${videoPath}`);
    console.warn(`Could not open recording automatically: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function loadDotEnv() {
  const envPath = resolve(repoRoot, ".env");
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    if (process.env[key] !== undefined) continue;
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function initializeTargetRepo(repoPath) {
  mkdirSync(workspaceRoot, { recursive: true });
  mkdirSync(repoPath, { recursive: true });
  execFileSync("git", ["init", "-b", "main", repoPath]);
  execFileSync("git", ["-C", repoPath, "config", "user.name", "Floop Demo Agent"]);
  execFileSync("git", ["-C", repoPath, "config", "user.email", "floop-demo@example.com"]);
  writeFileSync(join(repoPath, "README.md"), "# Demo Product\n", "utf8");
  execFileSync("git", ["-C", repoPath, "add", "README.md"]);
  execFileSync("git", ["-C", repoPath, "commit", "-m", "Seed demo product"]);
}

async function listen(httpServer) {
  httpServer.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
}

async function closeServer(httpServer) {
  if (!httpServer?.listening) return;
  await new Promise((resolve) => httpServer.close(resolve));
}

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
