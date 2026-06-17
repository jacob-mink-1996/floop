import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import { createFloopServer } from "../services/api/src/app.mjs";
import { createCeremonyAutomationDriver } from "../services/api/src/ceremony-automation-driver.mjs";
import { createCeremonyParticipantDriver } from "../services/api/src/ceremony-participant-driver.mjs";
import { createExecutionDriver } from "../services/api/src/execution-driver.mjs";
import { createStore } from "../services/api/src/store.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = resolve(process.env.FLOOP_DEMO_OUTPUT_DIR || join(repoRoot, "demo-recordings"));
const mode = process.argv.includes("--record") ? "record" : "proof";
const openAfterRecord = process.argv.includes("--open");
const fixtureRoot = mkdtempSync(join(tmpdir(), `floop-refinement-demo-${mode}-`));
const workspaceRoot = join(fixtureRoot, "workspace");
const repoPath = join(fixtureRoot, "calendar-product");
const recordingDir = join(outputRoot, `refinement-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const refinementAnswer = "Require account login for MVP invite acceptance. Guest links can be a later ticket.";

let store;
let server;
let browser;
let context;

try {
  mkdirSync(repoPath, { recursive: true });
  store = createStore({ filename: join(fixtureRoot, "floop.sqlite"), seedDemo: false, workspaceRoot });
  const project = seedProject();

  server = createFloopServer({ store });
  await listen(server);
  const appUrl = `http://127.0.0.1:${server.address().port}`;

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
  await runWalkthrough(page, appUrl, project.id);

  const proof = collectProof(project.id);
  assert.equal(proof.lifecycleReasonCode, "messy_backlog_needs_refinement");
  assert.equal(proof.agentCleanupProposal, true);
  assert.equal(proof.answeredRefinementQuestions >= 1, true);
  assert.equal(proof.firstChildExecutionSawRefinementAnswer, true);
  assert.equal(proof.splitProposalApplied, true);
  assert.equal(proof.duplicateCancelled, true);
  assert.equal(proof.obsoleteCancelled, true);
  assert.equal(proof.createdSplitTickets >= 1, true);

  await context.close();
  context = null;
  await browser.close();
  browser = null;

  if (mode === "record") {
    const videoPath = finalizeVideo(recordingDir);
    const proofPath = join(recordingDir, "proof.json");
    writeFileSync(
      proofPath,
      JSON.stringify({ appUrl, fixtureRoot, videoPath, proof }, null, 2),
      "utf8",
    );
    console.log(`Recorded Floop refinement demo: ${videoPath}`);
    console.log(`Proof bundle: ${proofPath}`);
    if (openAfterRecord) {
      openRecording(videoPath);
    }
  } else {
    console.log("Playwright refinement proof passed");
    console.log(JSON.stringify(proof, null, 2));
  }
} finally {
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await closeServer(server);
  store?.close();
  if (process.env.FLOOP_DEMO_KEEP_FIXTURE !== "true") {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function seedProject() {
  const project = store.createProject({
    name: "Calendar Backlog Refinement",
    slug: "calendar-refinement",
    workspaceRoot,
    description: "Focused proof for lifecycle refinement, cleanup, split, and actionable question HITL.",
    defaultBaseBranch: "main",
  });
  store.createRepo(project.id, {
    name: "calendar-product",
    slug: "calendar-product",
    localPath: repoPath,
    defaultBranch: "main",
    isPrimary: true,
  });
  store.updateProjectPolicy(project.id, {
    interactionMode: "autopilot",
    refinementMode: "autonomous",
    agentCreatedTicketDefaultState: "READY",
    ceremonyAutomation: {
      enabled: true,
      mode: "operator_approved",
      triggers: {
        refinement: {
          enabled: true,
          minIntervalMinutes: 1,
          participantRoles: ["product_manager", "architect"],
          deciderRole: "product_manager",
          consensusPolicy: "decider_synthesizes_objections",
        },
        planning: { enabled: false },
        daily_triage: { enabled: false },
        review_demo_prep: { enabled: false },
        work_generation: { enabled: false },
        retro: { enabled: false },
      },
    },
  });

  const broad = store.createTicket(project.id, {
    title: "Build calendar collaboration",
    brief: "Large idea covering shared calendars, invitations, permissions, and notification behavior.",
    assignedRole: "product_manager",
    priority: "high",
    state: "PROPOSED",
    repoTargets: [{ repoId: store.listRepos(project.id)[0].id, baseRef: "main", targetScopeMd: "calendar collaboration surface" }],
  });
  const keeper = store.createTicket(project.id, {
    title: "Add shared calendar invites",
    brief: "Invite other users to shared calendar events with a minimal invite model.",
    assignedRole: "developer",
    state: "PROPOSED",
  });
  const duplicate = store.createTicket(project.id, {
    title: "Implement shared calendar invitations",
    brief: "Duplicate invite behavior that should be folded into the clearer invite ticket.",
    assignedRole: "developer",
    state: "PROPOSED",
  });
  const obsolete = store.createTicket(project.id, {
    title: "Obsolete invitation spike",
    brief: "Legacy spike no longer needed after the product direction changed.",
    assignedRole: "developer",
    state: "DRAFT",
  });
  store.createTicket(project.id, {
    title: "Clarify calendar permission model",
    brief: "Capture the product decision for whether invite acceptance requires account login.",
    assignedRole: "product_manager",
    state: "PROPOSED",
  });

  for (const role of ["product_manager", "architect"]) {
    store.updateRoleProfile(project.id, role, {
      adapter: "mock",
      model: "fixture-refinement",
      config: {
        result: {
          outcome: "completed",
          summaryMd: `${role} used projectContext to clean the backlog.`,
          questionsMd: role === "product_manager" ? "Should shared invite acceptance require account login?" : "",
          riskMd: role === "architect" ? "Permissions and invitations should be split before implementation." : "",
          payload: {
            refinementRecommendations: role === "product_manager"
              ? [
                  {
                    type: "combine",
                    keeperTicketId: keeper.id,
                    duplicateTicketId: duplicate.id,
                    reason: "Both tickets describe the same invite behavior.",
                  },
                  {
                    type: "cancel",
                    ticketId: obsolete.id,
                    reason: "This spike is obsolete and would create duplicate work.",
                  },
                  {
                    type: "split",
                    sourceTicketId: broad.id,
                    reason: "Calendar collaboration is too broad for one implementation lane.",
                    tickets: [
                      {
                        title: "Create shared calendar invite model",
                        brief: "Add the minimum data model and acceptance criteria for shared calendar invites.",
                        acceptanceCriteriaMd: "- Invite records can be created\n- Invite status is tracked",
                        assignedRole: "developer",
                      },
                    ],
                  },
                  {
                    type: "question",
                    ticketId: broad.id,
                    questionMd: "Should shared invite acceptance require account login?",
                    reason: "Auth policy changes the implementation slice.",
                  },
                ]
              : [
                  {
                    type: "split",
                    sourceTicketId: broad.id,
                    reason: "Permissions should be isolated from invite delivery.",
                    tickets: [
                      {
                        title: "Define shared calendar permission rules",
                        brief: "Document owner, editor, and viewer permissions for shared calendars.",
                        acceptanceCriteriaMd: "- Roles are defined\n- Permission edge cases are captured",
                        assignedRole: "architect",
                      },
                    ],
                  },
                ],
          },
        },
      },
    });
  }
  const developerAgentPath = join(fixtureRoot, "developer-refinement-handoff-agent.js");
  writeFileSync(
    developerAgentPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const context = JSON.parse(fs.readFileSync(process.env.FLOOP_CONTEXT_PATH, "utf8"));
const parentText = JSON.stringify(context.relatedTickets?.parent || {});
if (!parentText.includes(${JSON.stringify(refinementAnswer)})) {
  fs.writeFileSync(
    process.env.FLOOP_RESULT_PATH,
    JSON.stringify({
      outcome: "blocked",
      summaryMd: "Developer could not see the answered refinement question.",
      remainingWorkMd: "Carry refinement HITL answers into child execution context.",
      blockedKind: "needs_human_input"
    }),
  );
  process.exit(0);
}
fs.writeFileSync(
  process.env.FLOOP_RESULT_PATH,
  JSON.stringify({
    outcome: "completed",
    summaryMd: "Implemented invite model after reading the parent refinement answer."
  }),
);
`,
    { encoding: "utf8", mode: 0o755 },
  );
  store.updateRoleProfile(project.id, "developer", {
    adapter: "shell",
    model: "fixture-refinement-handoff",
    config: {
      command: `"${process.execPath}" "${developerAgentPath}"`,
    },
  });

  return project;
}

async function runWalkthrough(page, appUrl, projectId) {
  await page.goto(appUrl);
  await page.getByText("Calendar Backlog Refinement").first().waitFor();
  await clickByText(page, "Calendar Backlog Refinement");
  await clickByText(page, "Board");
  await page.getByText("Build calendar collaboration").first().waitFor();
  await pause(900);

  await clickByText(page, "Ceremonies");
  await page.getByText("Refinement").first().waitFor();
  await pause(700);

  const automationDriver = createCeremonyAutomationDriver({ store, logger: silentLogger() });
  const [run] = await automationDriver.pollOnce();
  assert.equal(run.type, "refinement");
  await refresh(page);
  await page.getByText("Why this ran").first().waitFor();
  await pause(1200);

  const participantDriver = createCeremonyParticipantDriver({ store, pollIntervalMs: 50, maxParallel: 4, logger: silentLogger() });
  await participantDriver.pollOnce();
  const synthesized = collectProof(projectId);
  assert.equal(synthesized.agentCleanupProposal, true);
  await refresh(page);
  await page.locator(".ceremony-review").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await pause(400);
  await page.getByText("Agent-assisted cleanup").first().waitFor();
  await page.getByText("Keep").first().waitFor();
  await page.getByText("Split into ticket").first().waitFor();
  assert.equal(synthesized.pendingRefinementQuestions >= 1, true);
  await pause(1200);

  await clickByText(page, "Board");
  await page.getByText("Build calendar collaboration").first().waitFor();
  await clickByText(page, "Build calendar collaboration");
  await page.getByText("Waiting for answer").first().waitFor();
  await page.getByText("Should shared invite acceptance require account login?").first().waitFor();
  await page.getByLabel("Answer").fill(refinementAnswer);
  await pause(700);
  await clickByText(page, "Reply and continue");
  await page.getByText("Require account login for MVP invite acceptance").first().waitFor();
  await pause(1200);
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "detached", timeout: 10_000 });

  await clickByText(page, "Ceremonies");
  await clickByText(page, "Apply pending");
  await page.getByText("applied").first().waitFor({ timeout: 10_000 });
  await pause(900);
  await clickByText(page, "Board");
  await refresh(page);
  await page.getByText("Create shared calendar invite model").first().waitFor();
  await page.getByText("Define shared calendar permission rules").first().waitFor();
  await page.getByText("Done").first().waitFor();
  await pause(900);

  const childTicket = store
    .listTickets(projectId)
    .find((ticket) => ticket.title === "Create shared calendar invite model");
  assert.ok(childTicket);
  const dispatched = await automationDriver.pollOnce();
  assert.equal(dispatched.dispatched.length >= 1, true);
  await refresh(page);
  await page.getByText("Working").first().waitFor();
  await pause(900);
  const executionDriver = createExecutionDriver({ store, logger: silentLogger() });
  await executionDriver.pollOnce();
  const completedChildExecution = store
    .getTicket(projectId, childTicket.id)
    .executions.find((execution) => execution.role === "developer" && execution.outcome === "completed");
  assert.ok(completedChildExecution);
  assert.match(completedChildExecution.summaryMd, /parent refinement answer/);
  await refresh(page);
  await page.getByText("Create shared calendar invite model").first().waitFor();
  assert.equal(store.getTicket(projectId, childTicket.id).state, "REVIEWING");
  await pause(1500);

  const proof = collectProof(projectId);
  assert.equal(proof.createdSplitTickets >= 1, true);
  assert.equal(proof.firstChildExecutionSawRefinementAnswer, true);
}

function collectProof(projectId) {
  const runs = store.listCeremonyRuns(projectId);
  const refinement = runs.find((run) => run.type === "refinement");
  const tickets = store.listTickets(projectId);
  const firstChild = tickets.find((ticket) => ticket.title === "Create shared calendar invite model");
  const firstChildDetail = firstChild ? store.getTicket(projectId, firstChild.id) : null;
  return {
    ceremonyRunId: refinement?.id || "",
    lifecycleReasonCode: refinement?.scope?.lifecycleReason?.code || "",
    proposalKinds: refinement?.proposals.map((proposal) => proposal.kind) || [],
    agentCleanupProposal: Boolean(refinement?.proposals.some((proposal) => proposal.kind === "ticket_backlog_cleanup" && proposal.payload.source === "participant_recommendations")),
    pendingRefinementQuestions: store
      .listAgentMessages(projectId, { intent: "submit_ceremony_input", status: "pending", limit: 100 })
      .filter((message) => message.metadata?.refinementQuestion === true).length,
    answeredRefinementQuestions: store
      .listAgentMessages(projectId, { intent: "comment_on_ticket", status: "attached", limit: 100 })
      .filter((message) => message.metadata?.ceremonyResponse === true && message.metadata?.unblockResponse === true).length,
    firstChildExecutionSawRefinementAnswer: Boolean(
      firstChildDetail?.executions?.some(
        (execution) =>
          execution.role === "developer" &&
          execution.outcome === "completed" &&
          execution.summaryMd?.includes("parent refinement answer"),
      ),
    ),
    splitProposalApplied: Boolean(refinement?.proposals.some((proposal) => proposal.kind === "ticket_create" && proposal.status === "applied")),
    duplicateCancelled: tickets.some((ticket) => ticket.title === "Implement shared calendar invitations" && ticket.state === "CANCELLED"),
    obsoleteCancelled: tickets.some((ticket) => ticket.title === "Obsolete invitation spike" && ticket.state === "CANCELLED"),
    createdSplitTickets: tickets.filter((ticket) => ["Create shared calendar invite model", "Define shared calendar permission rules"].includes(ticket.title)).length,
  };
}

async function clickByText(page, text) {
  const roleButton = page.getByRole("button", { name: text, exact: true }).and(page.locator(":visible"));
  const locator = (await roleButton.count()) > 0 ? roleButton.last() : page.getByText(text, { exact: true }).last();
  await moveTo(page, locator);
  await locator.click();
  await pause(250);
}

async function refresh(page) {
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

function finalizeVideo(dir) {
  const video = readdirSync(dir).find((entry) => entry.endsWith(".webm"));
  if (!video) {
    throw new Error(`No Playwright video found in ${dir}`);
  }
  const source = join(dir, video);
  const target = join(dir, "floop-refinement-demo.webm");
  renameSync(source, target);
  return target;
}

function openRecording(videoPath) {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", videoPath] : [videoPath];
  const child = spawn(opener, args, { detached: true, stdio: "ignore" });
  child.unref();
}

function listen(httpServer) {
  return new Promise((resolvePromise) => httpServer.listen(0, "127.0.0.1", resolvePromise));
}

function closeServer(httpServer) {
  return new Promise((resolvePromise) => {
    if (!httpServer) {
      resolvePromise();
      return;
    }
    httpServer.close(() => resolvePromise());
  });
}

function pause(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function silentLogger() {
  return {
    error() {},
    info() {},
    warn() {},
  };
}
