import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createExecutionDriver } from "./execution-driver.mjs";
import { createMergeDriver } from "./merge-driver.mjs";
import { createStore } from "./store.mjs";

test("merge driver auto-merges merge-ready tickets without human approval", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "floop-merge-driver-"));
  const workspaceRoot = join(fixtureDir, "workspace");
  const repoRoot = join(fixtureDir, "repo");
  const store = createStore({
    filename: join(fixtureDir, "floop.sqlite"),
    seedDemo: true,
    workspaceRoot,
  });

  try {
    execFileSync("git", ["init", "-b", "main", repoRoot]);
    execFileSync("git", ["-C", repoRoot, "config", "user.name", "Floop Test"]);
    execFileSync("git", ["-C", repoRoot, "config", "user.email", "floop@example.com"]);
    writeFileSync(join(repoRoot, "README.md"), "# Floop Repo\n", "utf8");
    execFileSync("git", ["-C", repoRoot, "add", "README.md"]);
    execFileSync("git", ["-C", repoRoot, "commit", "-m", "seed repo"]);

    store.updateRepo("project_floop", "repo_project_floop_floop", {
      name: "floop",
      localPath: repoRoot,
      remoteUrl: "",
      defaultBranch: "main",
      isPrimary: true,
    });
    store.updateProjectPolicy("project_floop", {
      requireReviewer: false,
      requireValidator: false,
      requireHumanApprovalBeforeMerge: false,
      maxParallelMerges: 2,
    });
    store.updateRoleProfile("project_floop", "developer", {
      adapter: "shell",
      model: "fixture",
      config: {
        command: `"${process.execPath}" -e "const fs=require('node:fs'); const {execFileSync}=require('node:child_process'); const path=require('node:path'); const worktree=process.env.FLOOP_WORKTREE_PATH; const filename=path.join(worktree, 'feature.txt'); fs.writeFileSync(filename, 'merge me\\n'); execFileSync('git', ['-C', worktree, 'add', 'feature.txt']); execFileSync('git', ['-C', worktree, 'commit', '-m', 'Implement feature']); fs.writeFileSync(process.env.FLOOP_RESULT_PATH, JSON.stringify({ outcome: 'completed', summaryMd: 'Implementation completed and committed.' }));"`,
      },
    });

    const execution = store.createExecution("project_floop", "ticket_project_floop_2", {
      role: "developer",
      reason: "Prepare merge-ready implementation.",
    });

    const executionDriver = createExecutionDriver({ store, logger: silentLogger() });
    await executionDriver.pollOnce();

    const readyTicket = store.getTicket("project_floop", "ticket_project_floop_2");
    assert.equal(readyTicket.state, "READY_TO_MERGE");

    const mergeDriver = createMergeDriver({ store, logger: silentLogger() });
    await mergeDriver.pollOnce();

    const mergedTicket = store.getTicket("project_floop", "ticket_project_floop_2");
    const mergeArtifact = mergedTicket.mergeStatus.latestRun.artifacts.find((artifact) =>
      artifact.label.includes("merge candidate"),
    );

    assert.equal(mergedTicket.state, "DONE");
    assert.equal(mergedTicket.mergeStatus.latestRun.status, "completed");
    assert.equal(mergedTicket.mergeStatus.latestRun.approvedByRef, "floop-auto");
    assert.ok(mergeArtifact);

    const mergeSummary = JSON.parse(readFileSync(new URL(mergeArtifact.uri), "utf8"));
    assert.equal(mergeSummary.repoSlug, "floop");
    assert.equal(mergeSummary.baseRef, "main");
    assert.equal(mergeSummary.sourceBranch, execution.worktrees[0].branchName);
    assert.equal(mergeSummary.publishedRef, "main");
    assert.deepEqual(mergeSummary.changedFiles, ["feature.txt"]);
    assert.equal(readFileSync(join(repoRoot, "feature.txt"), "utf8"), "merge me\n");
  } finally {
    store.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("merge driver prefers completed integrator repair worktrees over stale implementation branches", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "floop-merge-driver-integrator-source-"));
  const workspaceRoot = join(fixtureDir, "workspace");
  const repoRoot = join(fixtureDir, "repo");
  const store = createStore({
    filename: join(fixtureDir, "floop.sqlite"),
    seedDemo: true,
    workspaceRoot,
  });

  try {
    execFileSync("git", ["init", "-b", "main", repoRoot]);
    execFileSync("git", ["-C", repoRoot, "config", "user.name", "Floop Test"]);
    execFileSync("git", ["-C", repoRoot, "config", "user.email", "floop@example.com"]);
    writeFileSync(join(repoRoot, "README.md"), "# Floop Repo\n", "utf8");
    execFileSync("git", ["-C", repoRoot, "add", "README.md"]);
    execFileSync("git", ["-C", repoRoot, "commit", "-m", "seed repo"]);

    store.updateRepo("project_floop", "repo_project_floop_floop", {
      name: "floop",
      localPath: repoRoot,
      remoteUrl: "",
      defaultBranch: "main",
      isPrimary: true,
    });
    store.updateProjectPolicy("project_floop", {
      requireReviewer: false,
      requireValidator: false,
      requireHumanApprovalBeforeMerge: false,
      interactionMode: "fully_autonomous",
      maxParallelMerges: 2,
    });
    store.updateRoleProfile("project_floop", "developer", {
      adapter: "shell",
      model: "fixture",
      config: {
        command: `"${process.execPath}" -e "const fs=require('node:fs'); const {execFileSync}=require('node:child_process'); const path=require('node:path'); const worktree=process.env.FLOOP_WORKTREE_PATH; fs.writeFileSync(path.join(worktree, 'feature.txt'), 'developer\\n'); execFileSync('git', ['-C', worktree, 'add', 'feature.txt']); execFileSync('git', ['-C', worktree, 'commit', '-m', 'Implement feature']); fs.writeFileSync(process.env.FLOOP_RESULT_PATH, JSON.stringify({ outcome: 'completed', summaryMd: 'Implementation completed.' }));"`,
      },
    });
    store.updateRoleProfile("project_floop", "integrator", {
      adapter: "shell",
      model: "fixture",
      config: {
        command: `"${process.execPath}" -e "const fs=require('node:fs'); const {execFileSync}=require('node:child_process'); const path=require('node:path'); const worktree=process.env.FLOOP_WORKTREE_PATH; fs.writeFileSync(path.join(worktree, 'repair.txt'), 'integrator repair\\n'); execFileSync('git', ['-C', worktree, 'add', 'repair.txt']); execFileSync('git', ['-C', worktree, 'commit', '-m', 'Repair integration branch']); fs.writeFileSync(process.env.FLOOP_RESULT_PATH, JSON.stringify({ outcome: 'completed', summaryMd: 'Integrator repair completed.' }));"`,
      },
    });

    const developer = store.createExecution("project_floop", "ticket_project_floop_2", {
      role: "developer",
      reason: "Prepare stale implementation branch.",
    });
    const executionDriver = createExecutionDriver({ store, logger: silentLogger() });
    await executionDriver.pollOnce();
    store.updateExecutionHarnessSession("project_floop", developer.id, {
      harnessKind: "shell",
      externalThreadId: "shell-thread-merge-repair",
      harnessCapabilities: ["queued_context"],
    });
    assert.equal(store.getTicket("project_floop", "ticket_project_floop_2").state, "READY_TO_MERGE");

    const reworkMerge = store.startMergeRun("project_floop", "ticket_project_floop_2", {
      strategy: "squash",
      approvedByKind: "system",
      approvedByRef: "floop-auto",
      claimToken: "merge-worker",
    });
    store.completeMergeRun("project_floop", reworkMerge.id, {
      status: "rework",
      summaryMd: "Merge conflict needs integrator repair.",
    });
    const integrator = store
      .getTicket("project_floop", "ticket_project_floop_2")
      .executions.find((execution) => execution.role === "integrator" && execution.status === "running");
    assert.ok(integrator);
    await executionDriver.pollOnce();
    assert.equal(store.getTicket("project_floop", "ticket_project_floop_2").state, "READY_TO_MERGE");

    const mergeDriver = createMergeDriver({ store, logger: silentLogger() });
    await mergeDriver.pollOnce();

    const mergedTicket = store.getTicket("project_floop", "ticket_project_floop_2");
    const mergeArtifact = mergedTicket.mergeStatus.latestRun.artifacts.find((artifact) =>
      artifact.label.includes("merge candidate"),
    );
    const mergeSummary = JSON.parse(readFileSync(new URL(mergeArtifact.uri), "utf8"));

    assert.equal(mergedTicket.state, "DONE");
    assert.equal(mergeSummary.sourceBranch, integrator.worktrees[0].branchName);
    assert.notEqual(mergeSummary.sourceBranch, developer.worktrees[0].branchName);
    assert.equal(readFileSync(join(repoRoot, "feature.txt"), "utf8"), "developer\n");
    assert.equal(readFileSync(join(repoRoot, "repair.txt"), "utf8"), "integrator repair\n");
  } finally {
    store.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("merge driver blocks when the target repo worktree is dirty", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "floop-merge-driver-dirty-target-"));
  const workspaceRoot = join(fixtureDir, "workspace");
  const repoRoot = join(fixtureDir, "repo");
  const store = createStore({
    filename: join(fixtureDir, "floop.sqlite"),
    seedDemo: true,
    workspaceRoot,
  });

  try {
    execFileSync("git", ["init", "-b", "main", repoRoot]);
    execFileSync("git", ["-C", repoRoot, "config", "user.name", "Floop Test"]);
    execFileSync("git", ["-C", repoRoot, "config", "user.email", "floop@example.com"]);
    writeFileSync(join(repoRoot, "README.md"), "# Floop Repo\n", "utf8");
    execFileSync("git", ["-C", repoRoot, "add", "README.md"]);
    execFileSync("git", ["-C", repoRoot, "commit", "-m", "seed repo"]);

    store.updateRepo("project_floop", "repo_project_floop_floop", {
      name: "floop",
      localPath: repoRoot,
      remoteUrl: "",
      defaultBranch: "main",
      isPrimary: true,
    });
    store.updateProjectPolicy("project_floop", {
      requireReviewer: false,
      requireValidator: false,
      requireHumanApprovalBeforeMerge: false,
      maxParallelMerges: 2,
    });
    store.updateRoleProfile("project_floop", "developer", {
      adapter: "shell",
      model: "fixture",
      config: {
        command: `"${process.execPath}" -e "const fs=require('node:fs'); const {execFileSync}=require('node:child_process'); const path=require('node:path'); const worktree=process.env.FLOOP_WORKTREE_PATH; const filename=path.join(worktree, 'feature.txt'); fs.writeFileSync(filename, 'merge me\\n'); execFileSync('git', ['-C', worktree, 'add', 'feature.txt']); execFileSync('git', ['-C', worktree, 'commit', '-m', 'Implement feature']); fs.writeFileSync(process.env.FLOOP_RESULT_PATH, JSON.stringify({ outcome: 'completed', summaryMd: 'Implementation completed and committed.' }));"`,
      },
    });

    const execution = store.createExecution("project_floop", "ticket_project_floop_2", {
      role: "developer",
      reason: "Prepare merge-ready implementation.",
    });

    const executionDriver = createExecutionDriver({ store, logger: silentLogger() });
    await executionDriver.pollOnce();
    writeFileSync(join(repoRoot, "dirty.txt"), "uncommitted local work\n", "utf8");

    const mergeDriver = createMergeDriver({ store, logger: silentLogger() });
    await mergeDriver.pollOnce();

    const blockedTicket = store.getTicket("project_floop", "ticket_project_floop_2");
    const blockedArtifact = blockedTicket.mergeStatus.latestRun.artifacts.find((artifact) =>
      artifact.label.includes("merge blocked"),
    );

    assert.equal(blockedTicket.state, "BLOCKED");
    assert.equal(blockedTicket.mergeStatus.latestRun.status, "blocked");
    assert.ok(blockedArtifact);
    assert.match(readFileSync(new URL(blockedArtifact.uri), "utf8"), /dirty_target_worktree/);
    assert.throws(() => readFileSync(join(repoRoot, "feature.txt"), "utf8"), /ENOENT/);
    assert.equal(execution.worktrees[0].branchName.includes("floop-2"), true);
  } finally {
    store.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("merge driver retries blocked runs and records already-applied source branches", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "floop-merge-driver-already-applied-"));
  const workspaceRoot = join(fixtureDir, "workspace");
  const repoRoot = join(fixtureDir, "repo");
  const store = createStore({
    filename: join(fixtureDir, "floop.sqlite"),
    seedDemo: true,
    workspaceRoot,
  });

  try {
    execFileSync("git", ["init", "-b", "main", repoRoot]);
    execFileSync("git", ["-C", repoRoot, "config", "user.name", "Floop Test"]);
    execFileSync("git", ["-C", repoRoot, "config", "user.email", "floop@example.com"]);
    writeFileSync(join(repoRoot, "README.md"), "# Floop Repo\n", "utf8");
    execFileSync("git", ["-C", repoRoot, "add", "README.md"]);
    execFileSync("git", ["-C", repoRoot, "commit", "-m", "seed repo"]);

    store.updateRepo("project_floop", "repo_project_floop_floop", {
      name: "floop",
      localPath: repoRoot,
      remoteUrl: "",
      defaultBranch: "main",
      isPrimary: true,
    });
    store.updateProjectPolicy("project_floop", {
      requireReviewer: false,
      requireValidator: false,
      requireHumanApprovalBeforeMerge: false,
      maxParallelMerges: 2,
    });
    store.updateRoleProfile("project_floop", "developer", {
      adapter: "shell",
      model: "fixture",
      config: {
        command: `"${process.execPath}" -e "const fs=require('node:fs'); const {execFileSync}=require('node:child_process'); const path=require('node:path'); const worktree=process.env.FLOOP_WORKTREE_PATH; const filename=path.join(worktree, 'feature.txt'); fs.writeFileSync(filename, 'merge me\\n'); execFileSync('git', ['-C', worktree, 'add', 'feature.txt']); execFileSync('git', ['-C', worktree, 'commit', '-m', 'Implement feature']); fs.writeFileSync(process.env.FLOOP_RESULT_PATH, JSON.stringify({ outcome: 'completed', summaryMd: 'Implementation completed and committed.' }));"`,
      },
    });

    const execution = store.createExecution("project_floop", "ticket_project_floop_2", {
      role: "developer",
      reason: "Prepare merge-ready implementation.",
    });
    const executionDriver = createExecutionDriver({ store, logger: silentLogger() });
    await executionDriver.pollOnce();

    const interrupted = store.startMergeRun("project_floop", "ticket_project_floop_2", {
      strategy: "squash",
      approvedByKind: "system",
      approvedByRef: "floop-auto",
      claimToken: "merge-worker",
    });
    store.completeMergeRun("project_floop", interrupted.id, {
      status: "blocked",
      summaryMd: "Interrupted after publishing the target ref.",
      failureKind: "interrupted",
    });
    execFileSync("git", ["-C", repoRoot, "merge", "--squash", execution.worktrees[0].branchName]);
    execFileSync("git", ["-C", repoRoot, "commit", "-m", "FLOOP-2: already published"]);
    store.transitionTicket("project_floop", "ticket_project_floop_2", {
      targetState: "READY_TO_MERGE",
      reason: "Retry interrupted merge after confirming target ref was published.",
      reasonCode: "operator_merge_retry",
    });

    const mergeDriver = createMergeDriver({ store, logger: silentLogger() });
    await mergeDriver.pollOnce();

    const mergedTicket = store.getTicket("project_floop", "ticket_project_floop_2");
    const mergeArtifact = mergedTicket.mergeStatus.latestRun.artifacts.find((artifact) =>
      artifact.label.includes("merge candidate"),
    );
    const mergeSummary = JSON.parse(readFileSync(new URL(mergeArtifact.uri), "utf8"));

    assert.equal(mergedTicket.state, "DONE");
    assert.equal(mergedTicket.mergeStatus.latestRun.status, "completed");
    assert.equal(mergeSummary.alreadyApplied, true);
    assert.deepEqual(mergeSummary.changedFiles, []);
    assert.equal(readFileSync(join(repoRoot, "feature.txt"), "utf8"), "merge me\n");
  } finally {
    store.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("merge driver reconciles interrupted active merge runs on startup", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "floop-merge-driver-reconcile-"));
  const workspaceRoot = join(fixtureDir, "workspace");
  const store = createStore({
    filename: join(fixtureDir, "floop.sqlite"),
    seedDemo: true,
    workspaceRoot,
  });

  try {
    store.updateProjectPolicy("project_floop", {
      requireReviewer: false,
      requireValidator: false,
      requireHumanApprovalBeforeMerge: false,
      maxParallelMerges: 2,
    });
    const execution = store.createExecution("project_floop", "ticket_project_floop_2", {
      role: "developer",
      reason: "Prepare a merge-ready ticket for recovery test.",
    });
    store.completeExecution("project_floop", execution.id, {
      outcome: "completed",
      summaryMd: "Implementation completed for merge recovery.",
    });
    store.startMergeRun("project_floop", "ticket_project_floop_2", {
      strategy: "squash",
      approvedByKind: "system",
      approvedByRef: "floop-auto",
      claimToken: "merge-worker",
    });

    const driver = createMergeDriver({ store, logger: silentLogger() });
    await driver.reconcileOnStart();

    const mergeStatus = store.getMergeStatus("project_floop", "ticket_project_floop_2");
    const ticket = store.getTicket("project_floop", "ticket_project_floop_2");
    assert.equal(mergeStatus.latestRun.status, "blocked");
    assert.equal(ticket.events.at(-1).reasonCode, "interrupted");
  } finally {
    store.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("merge driver retries transient git failures before succeeding", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "floop-merge-driver-retry-"));
  const workspaceRoot = join(fixtureDir, "workspace");
  const repoRoot = join(fixtureDir, "repo");
  const counterPath = join(fixtureDir, "git-merge-attempts.txt");
  const wrapperDir = join(fixtureDir, "bin");
  const wrapperPath = join(wrapperDir, "git");
  const store = createStore({
    filename: join(fixtureDir, "floop.sqlite"),
    seedDemo: true,
    workspaceRoot,
  });

  try {
    execFileSync("mkdir", ["-p", wrapperDir]);
    writeFileSync(counterPath, "0", "utf8");
    writeFileSync(
      wrapperPath,
      `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const args = process.argv.slice(2);
const realGit = process.env.FLOOP_REAL_GIT;
const counterPath = process.env.FLOOP_GIT_RETRY_COUNTER;
if (args.includes("merge") && args.includes("--squash")) {
  const attempts = Number(fs.readFileSync(counterPath, "utf8")) + 1;
  fs.writeFileSync(counterPath, String(attempts));
  if (attempts === 1) {
    process.stderr.write("TRANSIENT: temporary git merge failure\\n");
    process.exit(1);
  }
}
const result = spawnSync(realGit, args, { stdio: "inherit", env: process.env });
process.exit(result.status ?? 1);
`,
      { encoding: "utf8", mode: 0o755 },
    );

    execFileSync("git", ["init", "-b", "main", repoRoot]);
    execFileSync("git", ["-C", repoRoot, "config", "user.name", "Floop Test"]);
    execFileSync("git", ["-C", repoRoot, "config", "user.email", "floop@example.com"]);
    writeFileSync(join(repoRoot, "README.md"), "# Floop Repo\n", "utf8");
    execFileSync("git", ["-C", repoRoot, "add", "README.md"]);
    execFileSync("git", ["-C", repoRoot, "commit", "-m", "seed repo"]);

    store.updateRepo("project_floop", "repo_project_floop_floop", {
      name: "floop",
      localPath: repoRoot,
      remoteUrl: "",
      defaultBranch: "main",
      isPrimary: true,
    });
    store.updateProjectPolicy("project_floop", {
      requireReviewer: false,
      requireValidator: false,
      requireHumanApprovalBeforeMerge: false,
      maxParallelMerges: 2,
    });
    store.updateRoleProfile("project_floop", "developer", {
      adapter: "shell",
      model: "fixture",
      config: {
        command: `"${process.execPath}" -e "const fs=require('node:fs'); const {execFileSync}=require('node:child_process'); const path=require('node:path'); const worktree=process.env.FLOOP_WORKTREE_PATH; const filename=path.join(worktree, 'feature.txt'); fs.writeFileSync(filename, 'merge me\\n'); execFileSync('git', ['-C', worktree, 'add', 'feature.txt']); execFileSync('git', ['-C', worktree, 'commit', '-m', 'Implement feature']); fs.writeFileSync(process.env.FLOOP_RESULT_PATH, JSON.stringify({ outcome: 'completed', summaryMd: 'Implementation completed and committed.' }));"`,
      },
    });

    const execution = store.createExecution("project_floop", "ticket_project_floop_2", {
      role: "developer",
      reason: "Prepare merge-ready implementation.",
    });

    const executionDriver = createExecutionDriver({ store, logger: silentLogger() });
    await executionDriver.pollOnce();

    const originalPath = process.env.PATH || "";
    process.env.FLOOP_REAL_GIT = execFileSync("bash", ["-lc", "command -v git"], { encoding: "utf8" }).trim();
    process.env.FLOOP_GIT_RETRY_COUNTER = counterPath;
    process.env.PATH = `${wrapperDir}:${originalPath}`;

    try {
      const mergeDriver = createMergeDriver({ store, logger: silentLogger(), retryBackoffMs: 1 });
      await mergeDriver.pollOnce();
    } finally {
      process.env.PATH = originalPath;
      delete process.env.FLOOP_REAL_GIT;
      delete process.env.FLOOP_GIT_RETRY_COUNTER;
    }

    const mergedTicket = store.getTicket("project_floop", "ticket_project_floop_2");
    assert.equal(mergedTicket.state, "DONE");
    assert.equal(readFileSync(counterPath, "utf8"), "2");
    assert.equal(mergedTicket.mergeStatus.latestRun.status, "completed");
    assert.equal(mergedTicket.mergeStatus.latestRun.approvedByRef, "floop-auto");
    assert.equal(execution.worktrees[0].branchName.includes("floop-2"), true);
  } finally {
    store.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("merge driver renews claims while a long-running merge is still active", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "floop-merge-driver-renew-"));
  const workspaceRoot = join(fixtureDir, "workspace");
  const repoRoot = join(fixtureDir, "repo");
  const wrapperDir = join(fixtureDir, "bin");
  const wrapperPath = join(wrapperDir, "git");
  const store = createStore({
    filename: join(fixtureDir, "floop.sqlite"),
    seedDemo: true,
    workspaceRoot,
  });

  try {
    execFileSync("mkdir", ["-p", wrapperDir]);
    writeFileSync(
      wrapperPath,
      `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const realGit = process.env.FLOOP_REAL_GIT;
if (args.includes("merge") && args.includes("--squash")) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);
}
const result = spawnSync(realGit, args, { stdio: "inherit", env: process.env });
process.exit(result.status ?? 1);
`,
      { encoding: "utf8", mode: 0o755 },
    );

    execFileSync("git", ["init", "-b", "main", repoRoot]);
    execFileSync("git", ["-C", repoRoot, "config", "user.name", "Floop Test"]);
    execFileSync("git", ["-C", repoRoot, "config", "user.email", "floop@example.com"]);
    writeFileSync(join(repoRoot, "README.md"), "# Floop Repo\n", "utf8");
    execFileSync("git", ["-C", repoRoot, "add", "README.md"]);
    execFileSync("git", ["-C", repoRoot, "commit", "-m", "seed repo"]);

    store.updateRepo("project_floop", "repo_project_floop_floop", {
      name: "floop",
      localPath: repoRoot,
      remoteUrl: "",
      defaultBranch: "main",
      isPrimary: true,
    });
    store.updateProjectPolicy("project_floop", {
      requireReviewer: false,
      requireValidator: false,
      requireHumanApprovalBeforeMerge: false,
      maxParallelMerges: 2,
    });
    store.updateRoleProfile("project_floop", "developer", {
      adapter: "shell",
      model: "fixture",
      config: {
        command: `"${process.execPath}" -e "const fs=require('node:fs'); const {execFileSync}=require('node:child_process'); const path=require('node:path'); const worktree=process.env.FLOOP_WORKTREE_PATH; const filename=path.join(worktree, 'feature.txt'); fs.writeFileSync(filename, 'merge me\\n'); execFileSync('git', ['-C', worktree, 'add', 'feature.txt']); execFileSync('git', ['-C', worktree, 'commit', '-m', 'Implement feature']); fs.writeFileSync(process.env.FLOOP_RESULT_PATH, JSON.stringify({ outcome: 'completed', summaryMd: 'Implementation completed and committed.' }));"`,
      },
    });

    const execution = store.createExecution("project_floop", "ticket_project_floop_2", {
      role: "developer",
      reason: "Prepare merge-ready implementation.",
    });
    const executionDriver = createExecutionDriver({ store, logger: silentLogger() });
    await executionDriver.pollOnce();

    const originalPath = process.env.PATH || "";
    process.env.FLOOP_REAL_GIT = execFileSync("bash", ["-lc", "command -v git"], { encoding: "utf8" }).trim();
    process.env.PATH = `${wrapperDir}:${originalPath}`;

    try {
      const mergeDriver = createMergeDriver({ store, logger: silentLogger(), leaseMs: 40, retryBackoffMs: 1 });
      const pollPromise = mergeDriver.pollOnce();
      await new Promise((resolve) => setTimeout(resolve, 70));

      const competingStart = store.startMergeRun("project_floop", "ticket_project_floop_2", {
        strategy: "squash",
        approvedByKind: "system",
        approvedByRef: "floop-auto",
        claimToken: "merge-worker-b",
      });

      await pollPromise;

      assert.equal(competingStart, null);
      assert.equal(store.getTicket("project_floop", "ticket_project_floop_2").state, "DONE");
      assert.equal(execution.worktrees[0].branchName.includes("floop-2"), true);
    } finally {
      process.env.PATH = originalPath;
      delete process.env.FLOOP_REAL_GIT;
    }
  } finally {
    store.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

function silentLogger() {
  return {
    error() {},
  };
}
