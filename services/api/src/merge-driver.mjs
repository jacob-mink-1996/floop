import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BACKOFF_MS = 250;

export function createMergeDriver(options = {}) {
  if (!options.store) {
    throw new Error("Merge driver requires a store");
  }

  return new MergeDriver({
    store: options.store,
    pollIntervalMs: options.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS,
    leaseMs: options.leaseMs || DEFAULT_LEASE_MS,
    maxAttempts: options.maxAttempts || DEFAULT_MAX_ATTEMPTS,
    retryBackoffMs: options.retryBackoffMs || DEFAULT_RETRY_BACKOFF_MS,
    logger: options.logger || console,
  });
}

class MergeDriver {
  constructor({ store, pollIntervalMs, leaseMs, maxAttempts, retryBackoffMs, logger }) {
    this.store = store;
    this.pollIntervalMs = pollIntervalMs;
    this.leaseMs = leaseMs;
    this.maxAttempts = maxAttempts;
    this.retryBackoffMs = retryBackoffMs;
    this.logger = logger;
    this.timer = null;
    this.inFlight = new Map();
    this.claimToken = `merge-driver-${randomUUID()}`;
  }

  start() {
    if (this.timer) {
      return;
    }

    this.reconcileOnStart().catch((error) => {
      this.logger.error?.("[floop-merge-driver] startup poll failed", error);
    });

    this.timer = setInterval(() => {
      this.pollOnce().catch((error) => {
        this.logger.error?.("[floop-merge-driver] poll failed", error);
      });
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  async stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    if (this.inFlight.size > 0) {
      await Promise.allSettled(this.inFlight.values());
    }
  }

  async pollOnce() {
    const queue = this.store
      .listProjects()
      .flatMap((project) => this.store.listMergeQueue(project.id) || [])
      .filter((item) => isAutoMergeCandidate(item) && !this.inFlight.has(item.id));

    const started = queue.map((item) => {
      const promise = this.runMerge(item)
        .catch((error) => {
          this.logger.error?.("[floop-merge-driver] merge failed", error);
        })
        .finally(() => {
          this.inFlight.delete(item.id);
        });
      this.inFlight.set(item.id, promise);
      return promise;
    });

    await Promise.all(started);
  }

  async reconcileOnStart() {
    const recovered = this.store.reconcileActiveMergeRuns();
    if (recovered.length > 0) {
      this.logger.info?.(`[floop-merge-driver] reconciled ${recovered.length} interrupted merge run(s)`);
    }
    await this.pollOnce();
  }

  async runMerge(queueItem) {
    const ticket = this.store.getTicket(queueItem.projectId, queueItem.id);
    if (!ticket || ticket.state !== "READY_TO_MERGE") {
      return;
    }
    const project = this.store.getProjectSummary(queueItem.projectId);
    if (!project) {
      return;
    }

    const startedRun = this.store.startMergeRun(queueItem.projectId, queueItem.id, {
      strategy: "squash",
      approvedByKind: "system",
      approvedByRef: "floop-auto",
      summaryMd: `Floop started auto-merge for ${ticket.key}.`,
      claimToken: this.claimToken,
      leaseMs: this.leaseMs,
    });
    if (!startedRun) {
      return;
    }

    const repos = new Map((this.store.listRepos(queueItem.projectId) || []).map((repo) => [repo.id, repo]));
    const mergeRuntime = await prepareMergeRuntime(project, ticket);

    try {
      const stopLeaseHeartbeat = startLeaseHeartbeat(
        () =>
          this.store.renewMergeRunClaim(queueItem.projectId, startedRun.id, {
            claimToken: this.claimToken,
            leaseMs: this.leaseMs,
          }),
        this.leaseMs,
      );
      let mergeOutcome;
      try {
        mergeOutcome = await this.runMergeAttempts(ticket, repos, mergeRuntime);
      } finally {
        stopLeaseHeartbeat();
      }
      this.store.completeMergeRun(queueItem.projectId, startedRun.id, {
        status: mergeOutcome.status,
        summaryMd: mergeOutcome.summaryMd,
        artifacts: mergeOutcome.artifacts,
      });
    } catch (error) {
      const summaryMd = error instanceof Error ? error.message : String(error);
      const artifacts = await buildDriverFailureArtifacts(mergeRuntime, summaryMd);
      this.store.completeMergeRun(queueItem.projectId, startedRun.id, {
        status: "blocked",
        summaryMd,
        artifacts,
        failureKind: "driver_error",
      });
      throw error;
    }
  }

  async runMergeAttempts(ticket, repos, mergeRuntime) {
    let lastError = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const outcome = await mergeTicketRepos(ticket, repos, mergeRuntime);
        if (attempt > 1) {
          outcome.summaryMd = appendRetrySummary(outcome.summaryMd, attempt, "completed");
        }
        return outcome;
      } catch (error) {
        lastError = error;
        if (isRetryableMergeError(error) && attempt < this.maxAttempts) {
          await sleep(backoffForAttempt(this.retryBackoffMs, attempt));
          continue;
        }
        throw error;
      }
    }
    throw lastError || new Error("Merge driver exhausted retries");
  }
}

function appendRetrySummary(summaryMd, attempts, outcome) {
  const label = outcome === "exhausted" ? "exhausted" : "completed";
  return `${summaryMd || "Merge finished."}\n\nFloop ${label} after ${attempts} attempt(s).`;
}

function isAutoMergeCandidate(item) {
  const latestStatus = item?.mergeStatus?.latestRun?.status || "";
  return Boolean(
    item &&
      item.mergeStatus?.canMerge &&
      !item.mergeStatus?.requiresHumanApproval &&
      latestStatus !== "running" &&
      latestStatus !== "completed",
  );
}

async function mergeTicketRepos(ticket, repos, runtime) {
  const artifacts = [];
  const repoTargets = ticket.repoTargets || [];
  if (repoTargets.length === 0) {
    throw new Error(`Ticket ${ticket.key} has no repo targets for merge.`);
  }

  for (const target of repoTargets) {
    const repo = repos.get(target.repoId);
    if (!repo?.localPath) {
      throw new Error(`Repo target ${target.repoId} for ${ticket.key} has no local path.`);
    }

    const sourceWorktree = selectSourceWorktree(ticket, target.repoId);
    if (!sourceWorktree) {
      throw new Error(`Ticket ${ticket.key} has no developer worktree for repo ${target.repoId}.`);
    }

    const repoRuntime = await prepareRepoMergeRuntime(runtime, target.repoSlug);
    const baseRef = target.baseRef || repo.defaultBranch;
    const strategy = "squash";
    const mergeResult = await materializeMergeCandidate({
      ticket,
      repo,
      sourceWorktree,
      baseRef,
      strategy,
      runtime: repoRuntime,
    });
    artifacts.push(...mergeResult.artifacts);

    if (mergeResult.status !== "completed") {
      return {
        strategy,
        status: mergeResult.status,
        summaryMd:
          mergeResult.status === "blocked"
            ? `${ticket.key} merge blocked in ${repo.slug}.`
            : `${ticket.key} merge needs rework in ${repo.slug}.`,
        artifacts,
      };
    }
  }

  return {
    strategy: "squash",
    status: "completed",
    summaryMd: `Floop auto-merged ${ticket.key} after validation completed.`,
    artifacts,
  };
}

function selectSourceWorktree(ticket, repoId) {
  return [...(ticket.worktrees || [])]
    .filter(
      (worktree) =>
        worktree.repoId === repoId &&
        ["developer", "integrator"].includes(worktree.executionRole) &&
        worktree.status !== "failed" &&
        worktree.status !== "cleaned",
    )
    .sort((left, right) => {
      if (right.executionIteration !== left.executionIteration) {
        return right.executionIteration - left.executionIteration;
      }
      return String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""));
    })[0];
}

async function prepareMergeRuntime(project, ticket) {
  const mergeRoot = resolve(
    project.workspaceRoot || process.cwd(),
    ".floop",
    "artifacts",
    "merges",
    ticket.key.toLowerCase(),
  );
  await mkdir(mergeRoot, { recursive: true });
  return {
    mergeRoot,
  };
}

async function prepareRepoMergeRuntime(runtime, repoSlug) {
  const repoRoot = join(runtime.mergeRoot, repoSlug);
  const mergeWorktreePath = join(repoRoot, "candidate");
  const stdoutPath = join(repoRoot, "merge.stdout.log");
  const stderrPath = join(repoRoot, "merge.stderr.log");
  const summaryPath = join(repoRoot, "merge-summary.json");
  await mkdir(repoRoot, { recursive: true });
  return {
    repoRoot,
    mergeWorktreePath,
    stdoutPath,
    stderrPath,
    summaryPath,
  };
}

async function materializeMergeCandidate({ ticket, repo, sourceWorktree, baseRef, strategy, runtime }) {
  if (!(await isGitRepository(repo.localPath))) {
    throw new Error(`Repo ${repo.slug} is not a git repository: ${repo.localPath}`);
  }

  const targetReadiness = await inspectTargetWorktreeReadiness(repo, baseRef);
  if (!targetReadiness.ready) {
    await writeFile(runtime.stdoutPath, targetReadiness.stdout || "", "utf8");
    await writeFile(runtime.stderrPath, targetReadiness.stderr || "", "utf8");
    await writeFile(
      runtime.summaryPath,
      JSON.stringify(
        {
          repoId: repo.id,
          repoSlug: repo.slug,
          strategy,
          baseRef,
          sourceBranch: sourceWorktree.branchName,
          status: "blocked",
          reason: targetReadiness.reason,
          detail: targetReadiness.detail,
        },
        null,
        2,
      ),
      "utf8",
    );
    return {
      status: "blocked",
      artifacts: [
        {
          kind: "report",
          label: `${repo.slug} merge blocked`,
          uri: pathToFileURL(runtime.summaryPath).href,
        },
        {
          kind: "log",
          label: `${repo.slug} merge stdout`,
          uri: pathToFileURL(runtime.stdoutPath).href,
        },
        {
          kind: "log",
          label: `${repo.slug} merge stderr`,
          uri: pathToFileURL(runtime.stderrPath).href,
        },
      ],
    };
  }

  if (await fileExists(runtime.mergeWorktreePath)) {
    await rm(runtime.mergeWorktreePath, { recursive: true, force: true });
  }

  const mergeBranch = `${ticket.key.toLowerCase()}-merge-candidate`.slice(0, 63);
  const addWorktree = await runProcess(
    "git",
    ["-C", repo.localPath, "worktree", "add", "--detach", runtime.mergeWorktreePath, baseRef],
    {
      cwd: repo.localPath,
      env: process.env,
    },
  );
  if (addWorktree.exitCode !== 0) {
    throw new Error(`Failed to create merge worktree for ${repo.slug}: ${addWorktree.stderr || addWorktree.stdout}`.trim());
  }

  try {
    const checkout = await runProcess("git", ["-C", runtime.mergeWorktreePath, "switch", "-C", mergeBranch], {
      cwd: runtime.mergeWorktreePath,
      env: process.env,
    });
    if (checkout.exitCode !== 0) {
      throw new Error(`Failed to create merge branch for ${repo.slug}: ${checkout.stderr || checkout.stdout}`.trim());
    }

    const mergeArgs =
      strategy === "squash"
        ? ["-C", runtime.mergeWorktreePath, "merge", "--squash", sourceWorktree.branchName]
        : ["-C", runtime.mergeWorktreePath, "merge", "--no-ff", "--no-edit", sourceWorktree.branchName];
    const merge = await runProcess("git", mergeArgs, {
      cwd: runtime.mergeWorktreePath,
      env: process.env,
    });
    await writeFile(runtime.stdoutPath, merge.stdout || "", "utf8");
    await writeFile(runtime.stderrPath, merge.stderr || "", "utf8");
    if (merge.exitCode !== 0) {
      if (isRetryableGitFailure(merge)) {
        throw createRetryableError(`Temporary git merge failure for ${repo.slug}: ${merge.stderr || merge.stdout}`.trim());
      }
      const detail = await buildConflictSummary(runtime.mergeWorktreePath);
      await writeFile(
        runtime.summaryPath,
        JSON.stringify(
          {
            repoId: repo.id,
            repoSlug: repo.slug,
            strategy,
            baseRef,
            sourceBranch: sourceWorktree.branchName,
            status: "rework",
            detail,
          },
          null,
          2,
        ),
        "utf8",
      );
      return {
        status: "rework",
        artifacts: [
          {
            kind: "log",
            label: `${repo.slug} merge stdout`,
            uri: pathToFileURL(runtime.stdoutPath).href,
          },
          {
            kind: "log",
            label: `${repo.slug} merge stderr`,
            uri: pathToFileURL(runtime.stderrPath).href,
          },
          {
            kind: "report",
            label: `${repo.slug} merge conflict summary`,
            uri: pathToFileURL(runtime.summaryPath).href,
          },
        ],
      };
    }

    const stagedChanges = await runProcess("git", ["-C", runtime.mergeWorktreePath, "diff", "--cached", "--quiet"], {
      cwd: runtime.mergeWorktreePath,
      env: process.env,
    });
    if (stagedChanges.exitCode === 0) {
      const commitSha = (await runProcess("git", ["-C", runtime.mergeWorktreePath, "rev-parse", "HEAD"], {
        cwd: runtime.mergeWorktreePath,
        env: process.env,
      })).stdout.trim();
      await writeFile(runtime.stdoutPath, merge.stdout || "", "utf8");
      await writeFile(runtime.stderrPath, merge.stderr || "", "utf8");
      await writeFile(
        runtime.summaryPath,
        JSON.stringify(
          {
            repoId: repo.id,
            repoSlug: repo.slug,
            strategy,
            baseRef,
            sourceBranch: sourceWorktree.branchName,
            commitSha,
            changedFiles: [],
            publishedRef: baseRef,
            alreadyApplied: true,
            mergeWorktreePath: runtime.mergeWorktreePath,
          },
          null,
          2,
        ),
        "utf8",
      );
      return {
        status: "completed",
        artifacts: [
          {
            kind: "record",
            label: `${repo.slug} merge candidate`,
            uri: pathToFileURL(runtime.summaryPath).href,
            metadata: {
              repoId: repo.id,
              baseRef,
              sourceBranch: sourceWorktree.branchName,
              commitSha,
              publishedRef: baseRef,
              alreadyApplied: true,
            },
          },
          {
            kind: "log",
            label: `${repo.slug} merge stdout`,
            uri: pathToFileURL(runtime.stdoutPath).href,
          },
          {
            kind: "log",
            label: `${repo.slug} merge stderr`,
            uri: pathToFileURL(runtime.stderrPath).href,
          },
        ],
      };
    }
    if (stagedChanges.exitCode !== 1) {
      throw new Error(`Failed to inspect staged merge changes for ${repo.slug}: ${stagedChanges.stderr || stagedChanges.stdout}`.trim());
    }

    const commit = await runProcess(
      "git",
      ["-C", runtime.mergeWorktreePath, "commit", "-m", `${ticket.key}: ${ticket.title}`],
      {
        cwd: runtime.mergeWorktreePath,
        env: process.env,
      },
    );
    await writeFile(runtime.stdoutPath, `${merge.stdout || ""}${commit.stdout || ""}`, "utf8");
    await writeFile(runtime.stderrPath, `${merge.stderr || ""}${commit.stderr || ""}`, "utf8");
    if (commit.exitCode !== 0) {
      if (isRetryableGitFailure(commit)) {
        throw createRetryableError(`Temporary git commit failure for ${repo.slug}: ${commit.stderr || commit.stdout}`.trim());
      }
      throw new Error(`Failed to commit merge candidate for ${repo.slug}: ${commit.stderr || commit.stdout}`.trim());
    }

    const commitSha = (await runProcess("git", ["-C", runtime.mergeWorktreePath, "rev-parse", "HEAD"], {
      cwd: runtime.mergeWorktreePath,
      env: process.env,
    })).stdout.trim();
    const changedFiles = (
      await runProcess("git", ["-C", runtime.mergeWorktreePath, "diff", "--name-only", `${baseRef}..HEAD`], {
        cwd: runtime.mergeWorktreePath,
        env: process.env,
      })
    ).stdout
      .trim()
      .split("\n")
      .filter(Boolean);
    const publish = await runProcess("git", ["-C", repo.localPath, "merge", "--ff-only", commitSha], {
      cwd: repo.localPath,
      env: process.env,
    });
    await writeFile(runtime.stdoutPath, `${merge.stdout || ""}${commit.stdout || ""}${publish.stdout || ""}`, "utf8");
    await writeFile(runtime.stderrPath, `${merge.stderr || ""}${commit.stderr || ""}${publish.stderr || ""}`, "utf8");
    if (publish.exitCode !== 0) {
      if (isRetryableGitFailure(publish)) {
        throw createRetryableError(`Temporary git publish failure for ${repo.slug}: ${publish.stderr || publish.stdout}`.trim());
      }
      const detail = publish.stderr || publish.stdout || `Could not fast-forward ${baseRef} to ${commitSha}.`;
      await writeFile(
        runtime.summaryPath,
        JSON.stringify(
          {
            repoId: repo.id,
            repoSlug: repo.slug,
            strategy,
            baseRef,
            sourceBranch: sourceWorktree.branchName,
            commitSha,
            changedFiles,
            status: "blocked",
            reason: "publish_failed",
            detail,
          },
          null,
          2,
        ),
        "utf8",
      );
      return {
        status: "blocked",
        artifacts: [
          {
            kind: "report",
            label: `${repo.slug} merge publish blocked`,
            uri: pathToFileURL(runtime.summaryPath).href,
          },
          {
            kind: "log",
            label: `${repo.slug} merge stdout`,
            uri: pathToFileURL(runtime.stdoutPath).href,
          },
          {
            kind: "log",
            label: `${repo.slug} merge stderr`,
            uri: pathToFileURL(runtime.stderrPath).href,
          },
        ],
      };
    }

    await writeFile(
      runtime.summaryPath,
      JSON.stringify(
        {
          repoId: repo.id,
          repoSlug: repo.slug,
          strategy,
          baseRef,
          sourceBranch: sourceWorktree.branchName,
          commitSha,
          changedFiles,
          publishedRef: baseRef,
          mergeWorktreePath: runtime.mergeWorktreePath,
        },
        null,
        2,
      ),
      "utf8",
    );

    return {
      status: "completed",
      artifacts: [
        {
          kind: "record",
          label: `${repo.slug} merge candidate`,
          uri: pathToFileURL(runtime.summaryPath).href,
          metadata: {
            repoId: repo.id,
            baseRef,
            sourceBranch: sourceWorktree.branchName,
            commitSha,
            publishedRef: baseRef,
          },
        },
        {
          kind: "log",
          label: `${repo.slug} merge stdout`,
          uri: pathToFileURL(runtime.stdoutPath).href,
        },
        {
          kind: "log",
          label: `${repo.slug} merge stderr`,
          uri: pathToFileURL(runtime.stderrPath).href,
        },
      ],
    };
  } finally {
    await runProcess("git", ["-C", repo.localPath, "worktree", "remove", "--force", runtime.mergeWorktreePath], {
      cwd: repo.localPath,
      env: process.env,
    });
  }
}

async function buildConflictSummary(worktreePath) {
  const status = await runProcess("git", ["-C", worktreePath, "status", "--short"], {
    cwd: worktreePath,
    env: process.env,
  });
  return status.stdout.trim() || status.stderr.trim() || "Merge conflict encountered.";
}

async function inspectTargetWorktreeReadiness(repo, baseRef) {
  const branch = await runProcess("git", ["-C", repo.localPath, "symbolic-ref", "--short", "HEAD"], {
    cwd: repo.localPath,
    env: process.env,
  });
  if (branch.exitCode !== 0) {
    return {
      ready: false,
      reason: "detached_target_worktree",
      detail: branch.stderr || branch.stdout || `Repo ${repo.slug} target worktree is detached.`,
      stdout: branch.stdout,
      stderr: branch.stderr,
    };
  }

  const currentBranch = branch.stdout.trim();
  if (currentBranch !== baseRef) {
    return {
      ready: false,
      reason: "wrong_target_branch",
      detail: `Repo ${repo.slug} is on ${currentBranch}; expected ${baseRef}.`,
      stdout: branch.stdout,
      stderr: branch.stderr,
    };
  }

  const status = await runProcess("git", ["-C", repo.localPath, "status", "--porcelain"], {
    cwd: repo.localPath,
    env: process.env,
  });
  if (status.exitCode !== 0) {
    return {
      ready: false,
      reason: "target_status_failed",
      detail: status.stderr || status.stdout || `Could not inspect ${repo.slug} target worktree status.`,
      stdout: status.stdout,
      stderr: status.stderr,
    };
  }

  const dirty = status.stdout.trim();
  if (dirty) {
    return {
      ready: false,
      reason: "dirty_target_worktree",
      detail: `Repo ${repo.slug} has uncommitted changes on ${baseRef}:\n${dirty}`,
      stdout: status.stdout,
      stderr: status.stderr,
    };
  }

  return { ready: true, reason: "", detail: "", stdout: "", stderr: "" };
}

async function buildDriverFailureArtifacts(runtime, summaryMd) {
  const failurePath = join(runtime.mergeRoot, "driver-failure.md");
  await writeFile(failurePath, summaryMd, "utf8");
  return [
    {
      kind: "report",
      label: "Merge driver failure",
      uri: pathToFileURL(failurePath).href,
    },
  ];
}

async function fileExists(filename) {
  try {
    await access(filename);
    return true;
  } catch {
    return false;
  }
}

async function isGitRepository(path) {
  if (!path) {
    return false;
  }
  if (!(await fileExists(path))) {
    return false;
  }

  const probe = await runProcess("git", ["-C", path, "rev-parse", "--is-inside-work-tree"], {
    cwd: process.cwd(),
    env: process.env,
  });
  return probe.exitCode === 0 && probe.stdout.trim() === "true";
}

function runProcess(command, args, { cwd, env, shell = false, stdin = "" }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell,
      stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    if (stdin) {
      child.stdin?.end(stdin);
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      resolvePromise({
        exitCode: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

function createRetryableError(message) {
  const error = new Error(message);
  error.retryable = true;
  return error;
}

function isRetryableGitFailure(result) {
  const output = `${result.stderr || ""}\n${result.stdout || ""}`;
  return /TRANSIENT:|temporary|timed out|EAI_AGAIN|ETIMEDOUT|ECONNRESET|EMFILE|ENFILE|EBUSY/i.test(output);
}

function isRetryableMergeError(error) {
  if (!error) {
    return false;
  }
  if (error.retryable === true) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /temporary|timed out|EAI_AGAIN|ETIMEDOUT|ECONNRESET|EMFILE|ENFILE|EBUSY/i.test(message);
}

function backoffForAttempt(baseMs, attempt) {
  return baseMs * 2 ** Math.max(0, attempt - 1);
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function startLeaseHeartbeat(renew, leaseMs) {
  const intervalMs = Math.max(10, Math.floor(leaseMs / 2));
  const timer = setInterval(() => {
    Promise.resolve(renew()).catch(() => {});
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
