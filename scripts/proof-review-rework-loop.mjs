import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createExecutionDriver } from "../services/api/src/execution-driver.mjs";
import { createMergeDriver } from "../services/api/src/merge-driver.mjs";
import { createStore } from "../services/api/src/store.mjs";

const fixtureRoot = mkdtempSync(join(tmpdir(), "floop-review-rework-proof-"));
const workspaceRoot = join(fixtureRoot, "workspace");
const repoPath = join(fixtureRoot, "review-rework-product");
const proofDir = resolve(process.env.FLOOP_PROOF_OUTPUT_DIR || join(process.cwd(), "demo-recordings", "proof-review-rework-loop"));
const proofPath = join(proofDir, "proof.json");
const reviewSummary = "Review requested rework: add an empty state before validation.";
const findingDetails = "The dashboard must show a calm empty state when no events exist.";

let store;

try {
  mkdirSync(proofDir, { recursive: true });
  seedGitRepo(repoPath);
  store = createStore({
    filename: join(fixtureRoot, "floop.sqlite"),
    seedDemo: false,
    workspaceRoot,
  });
  const project = seedProject();
  const ticket = store.listTickets(project.id)[0];
  const executionDriver = createExecutionDriver({ store, logger: silentLogger() });
  const mergeDriver = createMergeDriver({ store, logger: silentLogger(), retryBackoffMs: 1 });

  const firstDeveloper = store.createExecution(project.id, ticket.id, {
    role: "developer",
    reason: "Start the review rework proof loop.",
  });
  await executionDriver.pollOnce();
  const afterFirstDeveloper = store.getTicket(project.id, ticket.id);
  assert.equal(store.getExecution(project.id, firstDeveloper.id).outcome, "completed");
  assert.equal(afterFirstDeveloper.state, "REVIEWING");

  const firstReviewer = afterFirstDeveloper.executions.find((execution) => execution.role === "reviewer");
  assert.ok(firstReviewer);
  await executionDriver.pollOnce();
  const afterReworkReview = store.getTicket(project.id, ticket.id);
  const reworkDeveloper = afterReworkReview.executions.find(
    (execution) => execution.role === "developer" && execution.id !== firstDeveloper.id,
  );
  assert.equal(store.getExecution(project.id, firstReviewer.id).outcome, "completed");
  assert.equal(afterReworkReview.state, "WORKING");
  assert.equal(afterReworkReview.reviews[0].verdict, "rework");
  assert.ok(reworkDeveloper);

  await executionDriver.pollOnce();
  const afterReworkDeveloper = store.getTicket(project.id, ticket.id);
  const secondReviewer = afterReworkDeveloper.executions.find(
    (execution) => execution.role === "reviewer" && execution.id !== firstReviewer.id,
  );
  assert.equal(store.getExecution(project.id, reworkDeveloper.id).outcome, "completed");
  assert.equal(afterReworkDeveloper.state, "REVIEWING");
  assert.ok(secondReviewer);

  await executionDriver.pollOnce();
  const afterPassedReview = store.getTicket(project.id, ticket.id);
  const validator = afterPassedReview.executions.find((execution) => execution.role === "validator");
  assert.equal(store.getExecution(project.id, secondReviewer.id).outcome, "completed");
  assert.equal(afterPassedReview.reviews.some((review) => review.verdict === "passed"), true);
  assert.equal(afterPassedReview.state, "VALIDATING");
  assert.ok(validator);

  await executionDriver.pollOnce();
  const afterValidation = store.getTicket(project.id, ticket.id);
  assert.equal(store.getExecution(project.id, validator.id).outcome, "completed");
  assert.equal(afterValidation.validations.at(-1).verdict, "passed");
  assert.equal(
    afterValidation.validations.at(-1).artifacts.some((artifact) => artifact.kind === "demo" || artifact.metadata?.demoEvidence === true),
    true,
  );
  assert.equal(afterValidation.state, "READY_TO_MERGE");

  await mergeDriver.pollOnce();
  const finalTicket = store.getTicket(project.id, ticket.id);
  assert.equal(finalTicket.state, "DONE");
  assert.equal(finalTicket.mergeStatus.latestRun.status, "completed");
  assert.match(readFileSync(join(repoPath, "dashboard.md"), "utf8"), /empty state/i);

  const proof = collectProof(project.id, ticket.id, {
    firstDeveloperId: firstDeveloper.id,
    firstReviewerId: firstReviewer.id,
    reworkDeveloperId: reworkDeveloper.id,
    secondReviewerId: secondReviewer.id,
    validatorId: validator.id,
  });
  assert.equal(proof.reworkLoop.reviewRequestedRework, true);
  assert.equal(proof.reworkLoop.developerSawReviewEvidence, true);
  assert.equal(proof.reworkLoop.reviewPassedAfterRework, true);
  assert.equal(proof.reworkLoop.validationDemoEvidence, true);
  assert.equal(proof.reworkLoop.mergedDone, true);

  writeFileSync(proofPath, `${JSON.stringify(proof, null, 2)}\n`, "utf8");
  console.log(`Review rework proof passed: ${proofPath}`);
} finally {
  store?.close();
  if (process.env.FLOOP_PROOF_KEEP_FIXTURE !== "true") {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function seedGitRepo(path) {
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "-b", "main", path], { stdio: "ignore" });
  execFileSync("git", ["-C", path, "config", "user.name", "Floop Proof"], { stdio: "ignore" });
  execFileSync("git", ["-C", path, "config", "user.email", "floop-proof@example.invalid"], { stdio: "ignore" });
  writeFileSync(join(path, "README.md"), "# Review Rework Product\n", "utf8");
  execFileSync("git", ["-C", path, "add", "README.md"], { stdio: "ignore" });
  execFileSync("git", ["-C", path, "commit", "-m", "Seed review rework product"], { stdio: "ignore" });
}

function seedProject() {
  const project = store.createProject({
    name: "Review Rework Proof",
    slug: "review-rework-proof",
    workspaceRoot,
    defaultBaseBranch: "main",
    description: "Focused proof that review rework redispatches the developer and continues through validation and merge.",
  });
  const repo = store.createRepo(project.id, {
    name: "review-rework-product",
    slug: "review-rework-product",
    localPath: repoPath,
    defaultBranch: "main",
    isPrimary: true,
  });
  store.updateProjectPolicy(project.id, {
    interactionMode: "autonomous_with_review",
    requireReviewer: true,
    requireValidator: true,
    requireHumanApprovalBeforeMerge: false,
    requireDemoEvidenceBeforeMerge: true,
    requiredValidationCommandProfileForMerge: "ci",
    maxParallelExecutions: 2,
  });
  const agents = writeAgents();
  store.updateRoleProfile(project.id, "developer", {
    adapter: "shell",
    model: "proof-review-rework-developer",
    config: { command: `"${process.execPath}" "${agents.developer}"` },
  });
  store.updateRoleProfile(project.id, "reviewer", {
    adapter: "shell",
    model: "proof-review-rework-reviewer",
    config: { command: `"${process.execPath}" "${agents.reviewer}"` },
  });
  store.updateRoleProfile(project.id, "validator", {
    adapter: "shell",
    model: "proof-review-rework-validator",
    config: { command: `"${process.execPath}" "${agents.validator}"` },
  });
  store.createTicket(project.id, {
    title: "Build dashboard empty state",
    brief: "Add dashboard copy that handles an empty calendar state before events exist.",
    acceptanceCriteriaMd: "- Dashboard file exists\n- Empty-state copy is present\n- Review rework evidence is preserved",
    definitionOfDoneMd: "- Review passes after rework\n- Validation records demo evidence\n- Merge completes",
    assignedRole: "developer",
    state: "READY",
    repoTargets: [
      {
        repoId: repo.id,
        baseRef: "main",
        branchName: "dashboard-empty-state",
        targetScopeMd: "Dashboard empty-state proof.",
      },
    ],
  });
  return project;
}

function writeAgents() {
  const developer = join(fixtureRoot, "developer-agent.cjs");
  const reviewer = join(fixtureRoot, "reviewer-agent.cjs");
  const validator = join(fixtureRoot, "validator-agent.cjs");
  writeFileSync(
    developer,
    `const fs = require("node:fs");
const path = require("node:path");
const iteration = Number(process.env.FLOOP_EXECUTION_ITERATION || "1");
const context = JSON.parse(fs.readFileSync(process.env.FLOOP_CONTEXT_PATH, "utf8"));
const text = JSON.stringify(context.ticket || {});
if (iteration > 1 && (!text.includes(${JSON.stringify(reviewSummary)}) || !text.includes(${JSON.stringify(findingDetails)}))) {
  fs.writeFileSync(process.env.FLOOP_RESULT_PATH, JSON.stringify({
    outcome: "blocked",
    summaryMd: "Developer rework context missed reviewer evidence.",
    remainingWorkMd: "Review evidence must be present before rework.",
    blockedKind: "needs_environment_fix"
  }));
  process.exit(0);
}
const worktree = process.env.FLOOP_WORKTREE_PATH;
const body = iteration > 1
  ? "# Dashboard\\n\\nEmpty state: no events yet. Add your first event to start planning.\\n"
  : "# Dashboard\\n\\nCalendar dashboard shell.\\n";
fs.writeFileSync(path.join(worktree, "dashboard.md"), body, "utf8");
fs.writeFileSync(process.env.FLOOP_RESULT_PATH, JSON.stringify({
  outcome: "blocked",
  blockedKind: "environment_git_read_only",
  summaryMd: iteration > 1
    ? "Developer resolved reviewer rework after reading review evidence, but Git metadata was read-only in the sandbox."
    : "Developer implemented the initial dashboard shell, but Git metadata was read-only in the sandbox.",
  remainingWorkMd: "Floop should recover the dirty worktree commit outside the adapter sandbox."
}));
`,
    { encoding: "utf8", mode: 0o755 },
  );
  writeFileSync(
    reviewer,
    `const fs = require("node:fs");
const context = JSON.parse(fs.readFileSync(process.env.FLOOP_CONTEXT_PATH, "utf8"));
const reviewCount = (context.ticket.reviews || []).length;
if (reviewCount === 0) {
  fs.writeFileSync(process.env.FLOOP_RESULT_PATH + ".review.md", ${JSON.stringify(`${reviewSummary}\n${findingDetails}\n`)});
  fs.writeFileSync(process.env.FLOOP_RESULT_PATH, JSON.stringify({
    outcome: "completed",
    summaryMd: "Reviewer requested empty-state rework.",
    review: {
      verdict: "rework",
      summaryMd: ${JSON.stringify(reviewSummary)},
      findings: [{
        severity: "high",
        category: "behavior",
        title: "Missing empty state",
        detailsMd: ${JSON.stringify(findingDetails)}
      }],
      artifacts: [{ kind: "report", label: "Review rework notes", uri: "file://" + process.env.FLOOP_RESULT_PATH + ".review.md" }]
    }
  }));
} else {
  fs.writeFileSync(process.env.FLOOP_RESULT_PATH, JSON.stringify({
    outcome: "completed",
    summaryMd: "Reviewer passed the dashboard after rework.",
    review: {
      verdict: "passed",
      summaryMd: "Empty-state rework is present and ready for validation.",
      findings: []
    }
  }));
}
`,
    { encoding: "utf8", mode: 0o755 },
  );
  writeFileSync(
    validator,
    `const fs = require("node:fs");
const path = require("node:path");
const worktree = process.env.FLOOP_WORKTREE_PATH;
const dashboard = fs.readFileSync(path.join(worktree, "dashboard.md"), "utf8");
if (!/empty state/i.test(dashboard)) {
  fs.writeFileSync(process.env.FLOOP_RESULT_PATH, JSON.stringify({
    outcome: "completed",
    summaryMd: "Validator found missing empty-state behavior.",
    validation: {
      verdict: "failed",
      commandProfile: "ci",
      commands: ["inspect dashboard.md"],
      summaryMd: "Empty-state behavior is still missing.",
      artifacts: [{ kind: "log", label: "Validation failure", uri: "file://" + process.env.FLOOP_RESULT_PATH + ".validation.log" }]
    }
  }));
  process.exit(0);
}
fs.writeFileSync(process.env.FLOOP_RESULT_PATH + ".validation.log", "dashboard.md contains empty-state copy\\n");
fs.writeFileSync(process.env.FLOOP_RESULT_PATH + ".demo.md", "Demo evidence: dashboard.md shows a no-events empty state before calendar events exist.\\n");
fs.writeFileSync(process.env.FLOOP_RESULT_PATH, JSON.stringify({
  outcome: "completed",
  summaryMd: "Validator passed the reworked dashboard and produced demo evidence.",
  validation: {
    verdict: "passed",
    commandProfile: "ci",
    commands: ["inspect dashboard.md"],
    summaryMd: "Validation plan: inspect dashboard.md for the empty-state behavior. Checks run: inspect dashboard.md. Why sufficient: this proof targets review rework propagation and visible demo evidence. Result: passed.",
    artifacts: [
      { kind: "log", label: "Dashboard validation", uri: "file://" + process.env.FLOOP_RESULT_PATH + ".validation.log" },
      { kind: "demo", label: "Dashboard empty-state demo evidence", uri: "file://" + process.env.FLOOP_RESULT_PATH + ".demo.md", metadata: { demoEvidence: true } }
    ]
  }
}));
`,
    { encoding: "utf8", mode: 0o755 },
  );
  return { developer, reviewer, validator };
}

function collectProof(projectId, ticketId, ids) {
  const ticket = store.getTicket(projectId, ticketId);
  const reworkDeveloper = store.getExecution(projectId, ids.reworkDeveloperId);
  const reworkContext = JSON.parse(
    readFileSync(join(workspaceRoot, ".floop", "executions", ids.reworkDeveloperId, "context.json"), "utf8"),
  );
  const evidenceText = JSON.stringify(reworkContext.ticket || {});
  return {
    project: store.getProjectSummary(projectId),
    ticket: {
      key: ticket.key,
      title: ticket.title,
      state: ticket.state,
      latestSummary: ticket.latestSummary,
    },
    executions: ticket.executions.map((execution) => ({
      id: execution.id,
      role: execution.role,
      iteration: execution.iteration,
      status: execution.status,
      outcome: execution.outcome,
      summaryMd: execution.summaryMd,
    })),
    reviews: ticket.reviews.map((review) => ({
      verdict: review.verdict,
      summaryMd: review.summaryMd,
      findings: review.findings,
    })),
    validations: ticket.validations.map((validation) => ({
      verdict: validation.verdict,
      commandProfile: validation.commandProfile,
      commands: validation.commands,
      artifacts: validation.artifacts.map((artifact) => ({
        kind: artifact.kind,
        label: artifact.label,
        uri: artifact.uri,
        demoEvidence: artifact.kind === "demo" || artifact.metadata?.demoEvidence === true,
      })),
    })),
    merge: {
      status: ticket.mergeStatus.latestRun?.status || "",
      summaryMd: ticket.mergeStatus.latestRun?.summaryMd || "",
      artifacts: ticket.mergeStatus.latestRun?.artifacts || [],
    },
    reworkLoop: {
      firstDeveloperId: ids.firstDeveloperId,
      firstReviewerId: ids.firstReviewerId,
      reworkDeveloperId: ids.reworkDeveloperId,
      secondReviewerId: ids.secondReviewerId,
      validatorId: ids.validatorId,
      reviewRequestedRework: ticket.reviews.some((review) => review.verdict === "rework"),
      developerSawReviewEvidence: reworkDeveloper.outcome === "completed" &&
        evidenceText.includes(reviewSummary) &&
        evidenceText.includes(findingDetails),
      reviewPassedAfterRework: ticket.reviews.some((review) => review.verdict === "passed"),
      validationDemoEvidence: ticket.validations.some((validation) =>
        validation.artifacts.some((artifact) => artifact.kind === "demo" || artifact.metadata?.demoEvidence === true),
      ),
      mergedDone: ticket.state === "DONE" && ticket.mergeStatus.latestRun?.status === "completed",
    },
    targetRepoHead: safeGit(["-C", repoPath, "rev-parse", "--short", "HEAD"]),
  };
}

function safeGit(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim();
  } catch (error) {
    return String(error?.stdout || "").trim();
  }
}

function silentLogger() {
  return {
    error() {},
    warn() {},
    info() {},
  };
}
