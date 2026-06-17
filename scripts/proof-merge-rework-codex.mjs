import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createExecutionDriver } from "../services/api/src/execution-driver.mjs";
import { createMergeDriver } from "../services/api/src/merge-driver.mjs";
import { createStore } from "../services/api/src/store.mjs";

const keepFixture = process.env.FLOOP_DEMO_KEEP_FIXTURE === "true";
const fixtureRoot = mkdtempSync(join(tmpdir(), "floop-merge-rework-codex-"));
const workspaceRoot = join(fixtureRoot, "workspace");
const repoRoot = join(fixtureRoot, "repo");
const proofDir = resolve(
  "demo-recordings",
  `merge-rework-codex-${new Date().toISOString().replace(/[:.]/g, "-")}`,
);
const proofPath = join(proofDir, "proof.json");
const ticketId = "ticket_project_floop_2";
const projectId = "project_floop";
const repoId = "repo_project_floop_floop";
const targetBranch = "floop-merge-conflict-proof";
const codexExecutable = process.env.FLOOP_MERGE_REWORK_CODEX_EXECUTABLE || "codex";
const codexModel = process.env.FLOOP_MERGE_REWORK_CODEX_MODEL || "codex-latest";
const codexSandbox = process.env.FLOOP_MERGE_REWORK_CODEX_SANDBOX || "workspace-write";
const codexApprovalPolicy = process.env.FLOOP_MERGE_REWORK_CODEX_APPROVAL_POLICY || "never";

assertCodexExecutableAvailable(codexExecutable);

const store = createStore({
  filename: join(fixtureRoot, "floop.sqlite"),
  seedDemo: true,
  workspaceRoot,
});

try {
  mkdirSync(proofDir, { recursive: true });
  seedRepo();
  configureProject();

  const executionDriver = createExecutionDriver({
    store,
    logger: prefixedLogger("[execution-driver]"),
    pollIntervalMs: 10000,
  });
  const mergeDriver = createMergeDriver({
    store,
    logger: prefixedLogger("[merge-driver]"),
    pollIntervalMs: 10000,
    retryBackoffMs: 1,
  });

  store.updateRoleProfile(projectId, "developer", {
    adapter: "shell",
    model: "fixture-conflict-implementation",
    config: {
      command: initialDeveloperCommand(),
    },
  });

  const initialExecution = store.createExecution(projectId, ticketId, {
    role: "developer",
    reason: "Create the implementation branch that will conflict with trunk.",
  });
  await executionDriver.pollOnce();

  const mergeReady = store.getTicket(projectId, ticketId);
  assert.equal(mergeReady.state, "READY_TO_MERGE");
  assert.equal(mergeReady.executions.find((execution) => execution.id === initialExecution.id)?.outcome, "completed");

  writeFileSync(join(repoRoot, "conflict.txt"), "trunk change\n", "utf8");
  git(["-C", repoRoot, "add", "conflict.txt"]);
  git(["-C", repoRoot, "commit", "-m", "Create trunk-side conflict"]);

  for (const repairRole of ["developer", "integrator"]) {
    store.updateRoleProfile(projectId, repairRole, {
      adapter: "codex",
      model: codexModel,
      config: {
        executable: codexExecutable,
        sandbox: codexSandbox,
        approvalPolicy: codexApprovalPolicy,
        promptPreamble: [
          "This is a focused Floop merge-conflict rework proof.",
          "The previous developer branch changed conflict.txt to include `developer change`.",
          "The target branch main independently changed conflict.txt to include `trunk change`.",
          "A merge attempt should have produced merge rework before this lane starts.",
          "Resolve the rework by integrating main into the current branch, preserving both lines in conflict.txt.",
          "After resolution, conflict.txt must contain both `developer change` and `trunk change`.",
          "Run bounded verification commands such as git status and direct file inspection.",
          "Commit the resolved branch before writing the required result JSON.",
        ].join("\n"),
      },
    });
  }

  await mergeDriver.pollOnce();
  const reworkTicket = store.getTicket(projectId, ticketId);
  const reworkRun = reworkTicket.mergeStatus.latestRun;
  assert.equal(reworkTicket.state, "WORKING");
  assert.equal(reworkRun.status, "rework");
  const reworkExecution = reworkTicket.executions.find(
    (execution) =>
      !["reviewer", "validator"].includes(execution.role) &&
      execution.status === "running" &&
      execution.resumedFromExecutionId === initialExecution.id,
  );
  assert.ok(reworkExecution);
  assert.ok(["developer", "integrator"].includes(reworkExecution.role));

  await executionDriver.pollOnce();
  const afterCodex = store.getTicket(projectId, ticketId);
  const completedReworkExecution = afterCodex.executions.find((execution) => execution.id === reworkExecution.id);
  assertCodexReworkCompleted(completedReworkExecution);
  assert.equal(completedReworkExecution.status, "completed");
  assert.equal(completedReworkExecution.outcome, "completed");
  assert.equal(afterCodex.state, "READY_TO_MERGE");

  await mergeDriver.pollOnce();
  const finalTicket = store.getTicket(projectId, ticketId);
  const finalText = readFileSync(join(repoRoot, "conflict.txt"), "utf8");
  assert.equal(finalTicket.state, "DONE");
  assert.equal(finalTicket.mergeStatus.latestRun.status, "completed");
  assert.match(finalText, /developer change/);
  assert.match(finalText, /trunk change/);

  const proof = collectProof({
    initialExecutionId: initialExecution.id,
    reworkExecutionId: reworkExecution.id,
    finalText,
  });
  writeFileSync(proofPath, JSON.stringify(proof, null, 2), "utf8");
  writeFileSync(
    join(proofDir, "README.md"),
    [
      "# Merge Rework Codex Proof",
      "",
      "Focused proof that a merge conflict routes to source-session repair or integrator fallback in fully autonomous mode.",
      `- Repair role: ${reworkExecution.role}`,
      "",
      `- Fixture: ${fixtureRoot}`,
      `- Proof: ${proofPath}`,
      `- Final repo head: ${proof.targetRepoHead}`,
      `- Final conflict.txt: ${JSON.stringify(finalText.trim())}`,
      "",
    ].join("\n"),
    "utf8",
  );

  console.log(`Merge rework Codex proof passed: ${proofPath}`);
  console.log(`Fixture: ${fixtureRoot}`);
} finally {
  store.close();
  if (!keepFixture) {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function seedRepo() {
  mkdirSync(repoRoot, { recursive: true });
  git(["init", "-b", "main", repoRoot]);
  git(["-C", repoRoot, "config", "user.name", "Floop Proof"]);
  git(["-C", repoRoot, "config", "user.email", "floop@example.com"]);
  writeFileSync(join(repoRoot, "README.md"), "# Merge Rework Proof\n", "utf8");
  writeFileSync(join(repoRoot, "conflict.txt"), "base\n", "utf8");
  git(["-C", repoRoot, "add", "README.md", "conflict.txt"]);
  git(["-C", repoRoot, "commit", "-m", "Seed merge rework proof repo"]);
}

function configureProject() {
  store.updateRepo(projectId, repoId, {
    name: "merge-rework-proof",
    slug: "merge-rework-proof",
    localPath: repoRoot,
    remoteUrl: "",
    defaultBranch: "main",
    isPrimary: true,
  });
  store.updateProjectPolicy(projectId, {
    requireReviewer: false,
    requireValidator: false,
    requireHumanApprovalBeforeMerge: false,
    interactionMode: "fully_autonomous",
    maxParallelExecutions: 2,
    maxParallelMerges: 2,
  });
  store.updateTicket(projectId, ticketId, {
    title: "Resolve merge conflict through developer rework",
    brief:
      "Prove Floop routes a merge conflict back to the developer lane and the developer resolves the conflict before merge retry.",
    acceptanceCriteriaMd: [
      "- Initial implementation changes conflict.txt to include `developer change`.",
      "- Main changes conflict.txt to include `trunk change` before merge.",
      "- Merge conflict produces merge rework and starts a second developer execution automatically.",
      "- Rework branch resolves the conflict so conflict.txt contains both lines.",
      "- Retry merge succeeds.",
    ].join("\n"),
    definitionOfDoneMd:
      "Ticket is done when merge rework is detected, a Codex developer rework lane completes, and the retry merge lands both conflict lines on main.",
    repoTargets: [
      {
        repoId,
        baseRef: "main",
        branchName: targetBranch,
        targetScopeMd: "Resolve conflict.txt merge rework while preserving developer and trunk changes.",
      },
    ],
  });
}

function initialDeveloperCommand() {
  const script = [
    "const fs = require('node:fs');",
    "const { spawnSync } = require('node:child_process');",
    "const path = require('node:path');",
    "function git(args) { const result = spawnSync('git', args, { encoding: 'utf8' }); if (result.error && result.status !== 0) throw result.error; if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'git failed').trim()); }",
    "const worktree = process.env.FLOOP_WORKTREE_PATH;",
    "const filename = path.join(worktree, 'conflict.txt');",
    "fs.writeFileSync(filename, 'developer change\\n');",
    "git(['-C', worktree, 'add', 'conflict.txt']);",
    "git(['-C', worktree, 'commit', '-m', 'Implement developer-side conflict change']);",
    "fs.writeFileSync(process.env.FLOOP_RESULT_PATH, JSON.stringify({ outcome: 'completed', summaryMd: 'Initial developer branch changed conflict.txt and committed the branch.' }));",
  ].join(" ");
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

function collectProof({ initialExecutionId, reworkExecutionId, finalText }) {
  const project = store.getProjectSummary(projectId);
  const ticket = store.getTicket(projectId, ticketId);
  const mergeRuns = store.listMergeRuns(projectId, { limit: 20 });
  const executions = store.listProjectExecutions(projectId, { limit: 20 });
  const artifacts = store.listArtifacts(projectId, { limit: 100 });
  const conversations = executions.map((execution) => {
    const executionRoot = join(workspaceRoot, ".floop", "executions", execution.id);
    const artifactRoot = join(workspaceRoot, ".floop", "artifacts", "executions", execution.id);
    return {
      executionId: execution.id,
      ticketKey: execution.ticketKey,
      role: execution.role,
      iteration: execution.iteration,
      status: execution.status,
      outcome: execution.outcome,
      prompt: readOptional(join(executionRoot, "prompt.md")),
      result: readOptional(join(executionRoot, "result.json")),
      stdout: readOptional(join(artifactRoot, "stdout.log")),
      stderr: readOptional(join(artifactRoot, "stderr.log")),
      workLog: readOptional(join(artifactRoot, "agent-work-log.md")),
      agentEvents: readOptional(join(artifactRoot, "agent-events.jsonl")),
    };
  });
  const initialExecution = executions.find((execution) => execution.id === initialExecutionId);
  const reworkExecution = executions.find((execution) => execution.id === reworkExecutionId);
  return {
    kind: "merge_rework_codex_proof",
    createdAt: new Date().toISOString(),
    fixtureRoot,
    workspaceRoot,
    repoRoot,
    project,
    ticket,
    initialExecutionId,
    reworkExecutionId,
    mergeReworkRouting: {
      sourceExecutionId: initialExecutionId,
      repairExecutionId: reworkExecutionId,
      repairResumedFromExecutionId: reworkExecution?.resumedFromExecutionId || "",
      sourceHarnessKind: initialExecution?.harnessKind || "",
      repairHarnessKind: reworkExecution?.harnessKind || "",
      repairExternalThreadId: reworkExecution?.externalThreadId || "",
      nativeSessionResumed:
        reworkExecution?.steeringMetadata?.resumeStrategy === "interrupt_and_resume" &&
        Boolean(reworkExecution?.externalThreadId),
      repairResumeReasonCode: reworkExecution?.steeringMetadata?.resumeReasonCode || "",
      repairWorktreeLineage: reworkExecution?.worktrees?.map((worktree) => ({
        repoId: worktree.repoId,
        branchName: worktree.branchName,
        resumedFromWorktreeId: worktree.resumedFromWorktreeId,
        lineageId: worktree.lineageId,
      })) || [],
    },
    mergeRuns,
    executions,
    artifacts,
    conversations,
    finalText,
    targetRepoHead: git(["-C", repoRoot, "rev-parse", "--short", "HEAD"]).trim(),
    targetRepoLog: git(["-C", repoRoot, "log", "--oneline", "--decorate", "--all", "--max-count=20"]).trim(),
  };
}

function readOptional(filename) {
  try {
    return readFileSync(filename, "utf8");
  } catch {
    return "";
  }
}

function assertCodexExecutableAvailable(executable) {
  const result = spawnSync(executable, ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (result.error) {
    throw new Error(
      [
        "Codex merge rework proof requires an authenticated Codex CLI on this system.",
        `Could not execute ${JSON.stringify(executable)}: ${result.error.message}`,
        "Install Codex, ensure it is on PATH, and run `codex login` before retrying.",
        "Override with FLOOP_MERGE_REWORK_CODEX_EXECUTABLE=/path/to/codex if needed.",
      ].join("\n"),
    );
  }
  if (result.status !== 0) {
    throw new Error(
      [
        "Codex merge rework proof requires a usable Codex CLI.",
        `${executable} --version exited with ${result.status}.`,
        tailText(`STDOUT:\n${result.stdout || ""}\nSTDERR:\n${result.stderr || ""}`),
        "Install Codex, ensure it is on PATH, and run `codex login` before retrying.",
      ].join("\n"),
    );
  }
}

function assertCodexReworkCompleted(execution) {
  if (!execution) {
    assert.fail("Expected a Codex merge repair execution to exist after merge conflict routing.");
  }
  if (execution.blockedKind === "codex_auth_required") {
    throw new Error(
      [
        "Codex merge rework proof reached the authenticated Codex lane, but Codex is not logged in.",
        "Run `codex login` for the user executing this proof, then rerun `npm run proof:merge-rework:codex`.",
        execution.remainingWorkMd ? `Codex output: ${execution.remainingWorkMd}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
}

function git(args) {
  return run("git", args);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
    encoding: "utf8",
  });
  if (result.error && result.status !== 0) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with ${result.status}\nSTDOUT:\n${result.stdout || ""}\nSTDERR:\n${result.stderr || ""}`,
    );
  }
  return result.stdout || "";
}

function tailText(value, maxLength = 1200) {
  const text = String(value || "").trim();
  return text.length > maxLength ? text.slice(-maxLength) : text;
}

function prefixedLogger(prefix) {
  return {
    info(message, ...args) {
      console.log(prefix, message, ...args);
    },
    warn(message, ...args) {
      console.warn(prefix, message, ...args);
    },
    error(message, ...args) {
      console.error(prefix, message, ...args);
    },
  };
}
