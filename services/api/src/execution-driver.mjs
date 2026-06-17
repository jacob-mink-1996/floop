import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, appendFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { buildProjectLookupContext } from "./project-context.mjs";

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BACKOFF_MS = 250;
const DEFAULT_RESULT_EXIT_GRACE_MS = 1000;

export function createExecutionDriver(options = {}) {
  if (!options.store) {
    throw new Error("Execution driver requires a store");
  }

  return new ExecutionDriver({
    store: options.store,
    pollIntervalMs: options.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS,
    leaseMs: options.leaseMs || DEFAULT_LEASE_MS,
    maxAttempts: options.maxAttempts || DEFAULT_MAX_ATTEMPTS,
    retryBackoffMs: options.retryBackoffMs || DEFAULT_RETRY_BACKOFF_MS,
    resultExitGraceMs:
      Number.isFinite(options.resultExitGraceMs) && options.resultExitGraceMs >= 0
        ? options.resultExitGraceMs
        : DEFAULT_RESULT_EXIT_GRACE_MS,
    logger: options.logger || console,
  });
}

class ExecutionDriver {
  constructor({ store, pollIntervalMs, leaseMs, maxAttempts, retryBackoffMs, resultExitGraceMs, logger }) {
    this.store = store;
    this.pollIntervalMs = pollIntervalMs;
    this.leaseMs = leaseMs;
    this.maxAttempts = maxAttempts;
    this.retryBackoffMs = retryBackoffMs;
    this.resultExitGraceMs = resultExitGraceMs;
    this.logger = logger;
    this.timer = null;
    this.inFlight = new Map();
    this.claimToken = `execution-driver-${randomUUID()}`;
  }

  start() {
    if (this.timer) {
      return;
    }

    this.reconcileOnStart().catch((error) => {
      this.logger.error?.("[floop-driver] startup reconciliation failed", error);
    });

    this.timer = setInterval(() => {
      this.pollOnce().catch((error) => {
        this.logger.error?.("[floop-driver] poll failed", error);
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
      for (const entry of this.inFlight.values()) {
        try {
          this.store.cancelExecution(entry.projectId, entry.executionId, {
            reason: "Execution cancelled because the Floop worker stopped.",
          });
        } catch {
          // Best-effort shutdown; cancellation may already have been recorded.
        }
        entry.cancel("Execution cancelled because the Floop worker stopped.");
      }
      await Promise.allSettled([...this.inFlight.values()].map((entry) => entry.promise));
    }
  }

  cancelExecution(projectId, executionId, reason = "Execution cancelled by operator") {
    const entry = this.inFlight.get(executionId);
    if (!entry || entry.projectId !== projectId) {
      return false;
    }
    entry.cancel(reason);
    return true;
  }

  async pollOnce() {
    const executions = this.store.listActiveExecutions();
    const runnable = executions.filter((execution) => !this.inFlight.has(execution.id));
    const started = runnable.map((execution) => {
      const controller = new AbortController();
      const promise = this.runExecution(execution, controller)
        .catch((error) => {
          this.logger.error?.("[floop-driver] execution failed", error);
        })
        .finally(() => {
          this.inFlight.delete(execution.id);
        });
      this.inFlight.set(execution.id, {
        projectId: execution.projectId,
        executionId: execution.id,
        promise,
        cancel: (reason) => abortController(controller, reason),
      });
      return promise;
    });

    await Promise.all(started);
  }

  async reconcileOnStart() {
    const recovered = this.store.reconcileActiveExecutions({
      summaryMd: "Floop recovered after restart before this lane reported a final result.",
      remainingWorkMd: "Retry or continue this lane now that the control plane is back online.",
    });
    if (recovered.length > 0) {
      this.logger.info?.(`[floop-driver] reconciled ${recovered.length} interrupted execution(s)`);
    }
    await this.pollOnce();
  }

  async runExecution(execution, controller) {
    const claimedExecution = this.store.claimExecution(execution.projectId, execution.id, {
      claimToken: this.claimToken,
      leaseMs: this.leaseMs,
    });
    if (!claimedExecution) {
      return;
    }

    const freshExecution = this.store.getExecution(execution.projectId, execution.id);
    if (!freshExecution || freshExecution.finishedAt) {
      return;
    }

    const project = this.store.getProjectSummary(freshExecution.projectId);
    const ticket = this.store.getTicket(freshExecution.projectId, freshExecution.ticketId);
    if (!project || !ticket) {
      return;
    }

    const profile = project.roleProfiles.find((candidate) => candidate.role === freshExecution.role);
    const adapterRun = selectAdapterRun(profile, freshExecution);
    if (!adapterRun) {
      return;
    }

    try {
      const stopLeaseHeartbeat = startLeaseHeartbeat(() =>
        this.store.claimExecution(execution.projectId, execution.id, {
          claimToken: this.claimToken,
          leaseMs: this.leaseMs,
        }),
      this.leaseMs);
      try {
        const stopCancellationWatcher = startCancellationWatcher(() => {
          const latest = this.store.getExecution(execution.projectId, execution.id);
          if (latest?.finishedAt || latest?.status === "cancelled") {
            abortController(controller, `${freshExecution.ticketKey} execution was cancelled.`);
          }
        }, 500);
        try {
          await this.runExecutionAttempts({
            execution: freshExecution,
            ticket,
            project,
            adapterRun,
            signal: controller.signal,
          });
        } finally {
          stopCancellationWatcher();
        }
      } finally {
        stopLeaseHeartbeat();
      }
    } catch (error) {
      const failureSummary = error instanceof Error ? error.message : String(error);
      const latestExecution = this.store.getExecution(execution.projectId, execution.id);
      if (latestExecution && !latestExecution.finishedAt) {
        this.store.completeExecution(execution.projectId, execution.id, {
          outcome: "failed",
          summaryMd: `Execution driver failed before adapter completion.\n\n${failureSummary}`,
          failureKind: "driver_error",
        });
      }
      throw error;
    } finally {
      const latestExecution = this.store.getExecution(execution.projectId, execution.id);
      if (latestExecution && !latestExecution.finishedAt) {
        this.store.releaseExecutionClaim(execution.projectId, execution.id, {
          claimToken: this.claimToken,
        });
      }
    }
  }

  async runExecutionAttempts({ execution, ticket, project, adapterRun, signal }) {
    let lastCompletion = null;
    let lastError = null;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        await materializeWorktrees(ticket, execution);
        const runtime = await prepareRuntimeArtifacts(project, ticket, execution, this.store);
        const result = await executeAdapterRun(adapterRun, {
          store: this.store,
          project,
          ticket,
          execution,
          runtime,
          cwd: execution.worktrees[0]?.path || project.workspaceRoot,
          env: buildExecutionEnv(project, ticket, execution, runtime),
          signal,
          resultExitGraceMs: this.resultExitGraceMs,
        });
        const completion = await buildCompletionPayload(result, runtime, execution, ticket);
        lastCompletion = completion;

        if (completion.outcome === "failed" && isRetryableExecutionFailure(completion.failureKind) && attempt < this.maxAttempts) {
          await sleep(backoffForAttempt(this.retryBackoffMs, attempt));
          continue;
        }

        if (
          completion.outcome === "failed" &&
          isRetryableExecutionFailure(completion.failureKind) &&
          attempt === this.maxAttempts
        ) {
          completion.summaryMd = appendRetrySummary(completion.summaryMd, this.maxAttempts, "exhausted");
          completion.failureKind = "driver_retries_exhausted";
        } else if (attempt > 1) {
          completion.summaryMd = appendRetrySummary(completion.summaryMd, attempt, "completed");
        }

        const latestExecution = this.store.getExecution(execution.projectId, execution.id);
        if (!latestExecution || latestExecution.finishedAt) {
          return;
        }
        this.store.completeExecution(execution.projectId, execution.id, completion);
        return;
      } catch (error) {
        lastError = error;
        if (isRetryableExecutionError(error) && attempt < this.maxAttempts) {
          await sleep(backoffForAttempt(this.retryBackoffMs, attempt));
          continue;
        }
        throw error;
      }
    }

    if (lastCompletion) {
      this.store.completeExecution(execution.projectId, execution.id, lastCompletion);
      return;
    }

    throw lastError || new Error("Execution driver exhausted retries");
  }
}

function isRetryableExecutionFailure(failureKind) {
  return failureKind === "transient" || failureKind === "temporary" || failureKind === "driver_error";
}

function appendRetrySummary(summaryMd, attempts, outcome) {
  const label = outcome === "exhausted" ? "exhausted" : "completed";
  return `${summaryMd || "Execution finished."}\n\nFloop ${label} after ${attempts} attempt(s).`;
}

function isRetryableExecutionError(error) {
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

function abortController(controller, reason) {
  if (!controller.signal.aborted) {
    controller.abort(new Error(reason));
  }
}

function startCancellationWatcher(check, intervalMs) {
  const timer = setInterval(() => {
    try {
      check();
    } catch {
      // Cancellation polling is best effort; the main execution path owns failures.
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

function startLeaseHeartbeat(renew, leaseMs) {
  const intervalMs = Math.max(10, Math.floor(leaseMs / 2));
  const timer = setInterval(() => {
    Promise.resolve(renew()).catch(() => {});
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

function selectAdapterRun(profile, execution) {
  if (!profile) {
    return null;
  }

  if (profile.adapter === "codex") {
    return {
      kind: "codex",
      executable: typeof profile.config?.executable === "string" && profile.config.executable.trim()
        ? profile.config.executable.trim()
        : "codex",
      model: profile.model,
      sandbox: typeof profile.config?.sandbox === "string" && profile.config.sandbox.trim()
        ? profile.config.sandbox.trim()
        : "workspace-write",
      approvalPolicy:
        typeof profile.config?.approvalPolicy === "string" && profile.config.approvalPolicy.trim()
          ? profile.config.approvalPolicy.trim()
          : "never",
      ignoreUserConfig: Boolean(profile.config?.ignoreUserConfig),
      promptPreamble:
        typeof profile.config?.promptPreamble === "string" ? profile.config.promptPreamble.trim() : "",
    };
  }

  if (profile.adapter === "codex_sdk" || profile.adapter === "codex_mcp") {
    const command = typeof profile.config?.command === "string" ? profile.config.command.trim() : "";
    if (!command) {
      return null;
    }
    return {
      kind: profile.adapter,
      command,
      model: profile.model,
      promptPreamble:
        typeof profile.config?.promptPreamble === "string" ? profile.config.promptPreamble.trim() : "",
    };
  }

  if (typeof profile.config?.command === "string" && profile.config.command.trim()) {
    return {
      kind: "shell",
      command: profile.config.command.trim(),
    };
  }

  if (profile.adapter === "mock") {
    return {
      kind: "mock",
      result: normalizeCompletionResult(profile.config?.result, execution),
    };
  }

  return null;
}

async function materializeWorktrees(ticket, execution) {
  const repoTargetsByRepoId = new Map(ticket.repoTargets.map((target) => [target.repoId, target]));
  const worktreesById = new Map((ticket.worktrees || []).map((worktree) => [worktree.id, worktree]));
  for (const worktree of execution.worktrees) {
    const target = repoTargetsByRepoId.get(worktree.repoId);
    if (!target) {
      continue;
    }

    await ensureWorktreeMaterialized(target, worktree);
    if (execution.steeringMetadata?.worktreePolicy === "copy_interrupted_worktree" && worktree.resumedFromWorktreeId) {
      const sourceWorktree = worktreesById.get(worktree.resumedFromWorktreeId);
      if (sourceWorktree?.path && sourceWorktree.path !== worktree.path && await fileExists(sourceWorktree.path)) {
        await copyInterruptedWorktree(sourceWorktree.path, worktree.path);
      }
    }
    await writeFile(
      join(worktree.path, ".floop-worktree.json"),
      JSON.stringify(
        {
          projectId: execution.projectId,
          ticketId: execution.ticketId,
          executionId: execution.id,
          repoId: worktree.repoId,
          repoSlug: worktree.repoSlug,
          repoLocalPath: target.repoLocalPath,
          baseRef: worktree.baseRef,
          branchName: worktree.branchName,
        },
        null,
        2,
      ),
      "utf8",
    );
  }
}

async function copyInterruptedWorktree(sourcePath, destinationPath) {
  await cp(sourcePath, destinationPath, {
    recursive: true,
    force: true,
    errorOnExist: false,
    filter: (source) => shouldCopyInterruptedWorktreePath(sourcePath, source),
  });
}

function shouldCopyInterruptedWorktreePath(sourceRoot, sourcePath) {
  const rel = relative(sourceRoot, sourcePath);
  if (!rel) {
    return true;
  }
  if (rel.startsWith("..")) {
    return false;
  }
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  const skippedNames = new Set([
    ".git",
    ".floop",
    ".floop-worktree.json",
    "node_modules",
    ".next",
    "dist",
    "build",
    "coverage",
    ".cache",
    ".turbo",
    ".vite",
  ]);
  return !parts.some((part) => skippedNames.has(part));
}

async function ensureWorktreeMaterialized(target, worktree) {
  if (await canReuseMaterializedWorktree(target, worktree)) {
    return;
  }

  if (await fileExists(worktree.path)) {
    await rm(worktree.path, { recursive: true, force: true });
  }

  if (await isGitRepository(target.repoLocalPath)) {
    await mkdir(dirname(worktree.path), { recursive: true });

    const materialized = await runProcess(
      "git",
      [
        "-C",
        target.repoLocalPath,
        "worktree",
        "add",
        "-B",
        worktree.branchName,
        worktree.path,
        worktree.baseRef,
      ],
      {
        cwd: target.repoLocalPath,
        env: process.env,
      },
    );
    if (materialized.exitCode !== 0) {
      throw new Error(
        `Failed to materialize git worktree for ${target.repoSlug}: ${materialized.stderr || materialized.stdout}`.trim(),
      );
    }
    return;
  }

  await mkdir(worktree.path, { recursive: true });
}

async function canReuseMaterializedWorktree(target, worktree) {
  if (!(await fileExists(join(worktree.path, ".git")))) {
    return false;
  }

  const metadataPath = join(worktree.path, ".floop-worktree.json");
  let metadata = null;
  try {
    metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  } catch {
    return false;
  }

  return (
    metadata &&
    metadata.repoLocalPath === target.repoLocalPath &&
    metadata.repoId === worktree.repoId &&
    metadata.branchName === worktree.branchName &&
    metadata.baseRef === worktree.baseRef
  );
}

async function prepareRuntimeArtifacts(project, ticket, execution, store) {
  const executionRoot = resolve(project.workspaceRoot, ".floop", "executions", execution.id);
  const artifactRoot = resolve(project.workspaceRoot, ".floop", "artifacts", "executions", execution.id);
  const contextPath = join(executionRoot, "context.json");
  const resultPath = join(executionRoot, "result.json");
  const promptPath = join(executionRoot, "prompt.md");
  const finalMessagePath = join(artifactRoot, "agent-final-message.md");
  const workLogPath = join(artifactRoot, "agent-work-log.md");
  const stdoutPath = join(artifactRoot, "stdout.log");
  const stderrPath = join(artifactRoot, "stderr.log");
  const agentEventsPath = join(artifactRoot, "agent-events.jsonl");

  await mkdir(dirname(contextPath), { recursive: true });
  await mkdir(dirname(stdoutPath), { recursive: true });
  await writeFile(
    contextPath,
    JSON.stringify(
      {
        project,
        projectContext: buildProjectLookupContext(store, project, { ticket }),
        ticket,
        relatedTickets: buildRelatedTicketContext(store, project.id, ticket),
        execution,
      },
      null,
      2,
    ),
    "utf8",
  );

  return {
    contextPath,
    resultPath,
    promptPath,
    finalMessagePath,
    workLogPath,
    stdoutPath,
    stderrPath,
    agentEventsPath,
  };
}

function buildRelatedTicketContext(store, projectId, ticket) {
  if (!store || !projectId || !ticket) {
    return { parent: null, children: [] };
  }
  const parent = ticket.parentTicketId
    ? summarizeRelatedTicket(store.getTicket(projectId, ticket.parentTicketId))
    : null;
  const children = store
    .listTickets(projectId, { parentTicketId: ticket.id })
    .map((child) => summarizeRelatedTicket(store.getTicket(projectId, child.id)))
    .filter(Boolean);
  return { parent, children };
}

function summarizeRelatedTicket(ticket) {
  if (!ticket) {
    return null;
  }
  return {
    id: ticket.id,
    key: ticket.key,
    title: ticket.title,
    state: ticket.state,
    priority: ticket.priority,
    assignedRole: ticket.assignedRole,
    latestSummary: ticket.latestSummary,
    acceptanceCriteriaMd: ticket.acceptanceCriteriaMd,
    definitionOfDoneMd: ticket.definitionOfDoneMd,
    events: ticket.events,
    reviews: ticket.reviews,
    validations: ticket.validations,
    artifacts: ticket.artifacts,
  };
}

function buildExecutionEnv(project, ticket, execution, runtime) {
  return {
    ...process.env,
    FLOOP_PROJECT_ID: project.id,
    FLOOP_PROJECT_SLUG: project.slug,
    FLOOP_PROJECT_ROOT: project.workspaceRoot,
    FLOOP_TICKET_ID: ticket.id,
    FLOOP_TICKET_KEY: ticket.key,
    FLOOP_TICKET_TITLE: ticket.title,
    FLOOP_EXECUTION_ID: execution.id,
    FLOOP_EXECUTION_ROLE: execution.role,
    FLOOP_EXECUTION_ITERATION: String(execution.iteration),
    FLOOP_WORKTREE_PATH: execution.worktrees[0]?.path || "",
    FLOOP_CONTEXT_PATH: runtime.contextPath,
    FLOOP_RESULT_PATH: runtime.resultPath,
  };
}

async function executeAdapterRun(adapterRun, options) {
  if (adapterRun.kind === "mock") {
    await writeJsonlEvent(options.runtime.agentEventsPath, {
      event: "adapter.completed",
      adapter: "mock",
      exitCode: 0,
    });
    return {
      exitCode: 0,
      stdout: "mock adapter completed",
      stderr: "",
      result: adapterRun.result,
    };
  }

  if (adapterRun.kind === "codex") {
    const prompt = buildCodexPrompt(options.project, options.ticket, options.execution, adapterRun, options.runtime);
    await writeFile(options.runtime.promptPath, prompt, "utf8");

    return runProcess(adapterRun.executable, buildCodexArgs(adapterRun, options), {
      cwd: options.cwd,
      env: options.env,
      stdin: prompt,
      stdoutPath: options.runtime.stdoutPath,
      stderrPath: options.runtime.stderrPath,
      jsonlPath: options.runtime.agentEventsPath,
      resultPath: options.runtime.resultPath,
      resultExitGraceMs: options.resultExitGraceMs,
      signal: options.signal,
      metadata: buildProcessMetadata(adapterRun, options),
      onStdoutText: createCodexStdoutObserver(options),
    });
  }

  if (adapterRun.kind === "codex_sdk" || adapterRun.kind === "codex_mcp") {
    const prompt = buildCodexPrompt(options.project, options.ticket, options.execution, adapterRun, options.runtime);
    await writeFile(options.runtime.promptPath, prompt, "utf8");
    return runHarnessBridgeCommand(adapterRun, options, prompt);
  }

  return runShellCommand(adapterRun.command, options);
}

function runHarnessBridgeCommand(adapterRun, { cwd, env, runtime, signal, resultExitGraceMs }, prompt) {
  return runProcess(adapterRun.command, [], {
    cwd,
    env: {
      ...env,
      FLOOP_HARNESS_KIND: adapterRun.kind,
      FLOOP_HARNESS_MODEL: adapterRun.model || "",
    },
    shell: true,
    stdin: prompt,
    stdoutPath: runtime.stdoutPath,
    stderrPath: runtime.stderrPath,
    jsonlPath: runtime.agentEventsPath,
    resultPath: runtime.resultPath,
    resultExitGraceMs,
    signal,
    metadata: { adapter: adapterRun.kind, command: adapterRun.command },
  });
}

function runShellCommand(command, { cwd, env, runtime, signal, resultExitGraceMs }) {
  return runProcess(command, [], {
    cwd,
    env,
    shell: true,
    stdoutPath: runtime.stdoutPath,
    stderrPath: runtime.stderrPath,
    jsonlPath: runtime.agentEventsPath,
    resultPath: runtime.resultPath,
    resultExitGraceMs,
    signal,
    metadata: { adapter: "shell", command },
  });
}

function runProcess(
  command,
  args,
  {
    cwd,
    env,
    shell = false,
    stdin = "",
    stdoutPath = "",
    stderrPath = "",
    jsonlPath = "",
    resultPath = "",
    resultExitGraceMs = DEFAULT_RESULT_EXIT_GRACE_MS,
    signal,
    metadata = {},
    onStdoutText = null,
  },
) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell,
      stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    let stdout = "";
    let stderr = "";
    let cancelled = false;
    let cancelReason = "";
    let killTimer = null;
    let resultExitTimer = null;
    let resultFileCompleted = false;
    let stdoutWrite = stdoutPath ? writeFile(stdoutPath, "", "utf8") : Promise.resolve();
    let stderrWrite = stderrPath ? writeFile(stderrPath, "", "utf8") : Promise.resolve();
    let jsonlWrite = jsonlPath ? writeFile(jsonlPath, "", "utf8") : Promise.resolve();
    const record = (event) => {
      if (!jsonlPath) return;
      jsonlWrite = jsonlWrite.then(() => appendJsonlEvent(jsonlPath, event));
    };

    record({
      event: "process.started",
      pid: child.pid || null,
      cwd,
      shell,
      command,
      args,
      ...metadata,
    });

    if (stdin) {
      child.stdin?.end(stdin);
    }

    if (resultPath) {
      resultExitTimer = startResultExitWatcher({
        resultPath,
        graceMs: resultExitGraceMs,
        onDetected: () => {
          if (resultFileCompleted) {
            return;
          }
          resultFileCompleted = true;
          record({ event: "process.result_detected", resultPath, graceMs: resultExitGraceMs, pid: child.pid || null });
          if (child.exitCode === null && !child.killed) {
            record({ event: "process.result_exit_requested", resultPath, pid: child.pid || null });
            killChildProcessTree(child, "SIGTERM");
            killTimer = setTimeout(() => {
              record({ event: "process.kill_requested", reason: "result_file_completed", pid: child.pid || null });
              killChildProcessTree(child, "SIGKILL");
            }, 3000);
            killTimer.unref?.();
          }
        },
      });
    }

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (stdoutPath) stdoutWrite = stdoutWrite.then(() => appendFile(stdoutPath, text, "utf8"));
      record({ event: "process.output", stream: "stdout", bytes: chunk.length, text });
      onStdoutText?.(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (stderrPath) stderrWrite = stderrWrite.then(() => appendFile(stderrPath, text, "utf8"));
      record({ event: "process.output", stream: "stderr", bytes: chunk.length, text });
    });

    const cancel = () => {
      cancelled = true;
      cancelReason = signal?.reason instanceof Error ? signal.reason.message : String(signal?.reason || "cancelled");
      record({ event: "process.cancel_requested", reason: cancelReason, pid: child.pid || null });
      killChildProcessTree(child, "SIGTERM");
      killTimer = setTimeout(() => {
        record({ event: "process.kill_requested", reason: cancelReason, pid: child.pid || null });
        killChildProcessTree(child, "SIGKILL");
      }, 3000);
      killTimer.unref?.();
    };

    if (signal?.aborted) {
      cancel();
    } else {
      signal?.addEventListener("abort", cancel, { once: true });
    }

    child.on("error", (error) => {
      record({ event: "process.error", message: error.message });
      rejectPromise(error);
    });
    child.on("close", (code) => {
      if (killTimer) clearTimeout(killTimer);
      if (resultExitTimer) resultExitTimer();
      signal?.removeEventListener("abort", cancel);
      record({
        event: "process.closed",
        exitCode: code ?? 1,
        cancelled,
        cancelReason,
        resultFileCompleted,
      });
      Promise.all([stdoutWrite, stderrWrite, jsonlWrite])
        .then(() => {
          resolvePromise({
            exitCode: resultFileCompleted ? 0 : cancelled && code === null ? 130 : code ?? 1,
            stdout,
            stderr,
            cancelled: resultFileCompleted ? false : cancelled,
            cancelReason: resultFileCompleted ? "" : cancelReason,
            resultFileCompleted,
          });
        })
        .catch(rejectPromise);
    });
  });
}

function buildProcessMetadata(adapterRun, options) {
  return {
    adapter: adapterRun.kind,
    role: options.execution.role,
    ticketKey: options.execution.ticketKey,
    executionId: options.execution.id,
  };
}

function killChildProcessTree(child, signal) {
  if (!child.pid || child.killed) {
    return;
  }
  try {
    if (process.platform !== "win32") {
      process.kill(-child.pid, signal);
      return;
    }
  } catch {
    // Fall back to killing the direct child below.
  }
  try {
    child.kill(signal);
  } catch {
    // Process may already be gone.
  }
}

function startResultExitWatcher({ resultPath, graceMs, onDetected }) {
  let detected = false;
  let graceTimer = null;
  const pollTimer = setInterval(async () => {
    if (detected) {
      return;
    }
    try {
      const result = await readResultFile(resultPath);
      if (!result || typeof result !== "object" || Array.isArray(result)) {
        return;
      }
      detected = true;
      clearInterval(pollTimer);
      graceTimer = setTimeout(onDetected, Math.max(0, graceMs));
      graceTimer.unref?.();
    } catch {
      // The agent may still be writing result.json; wait for a parseable file.
    }
  }, 100);
  pollTimer.unref?.();
  return () => {
    clearInterval(pollTimer);
    if (graceTimer) {
      clearTimeout(graceTimer);
    }
  };
}

async function writeJsonlEvent(filename, event) {
  await mkdir(dirname(filename), { recursive: true });
  await writeFile(filename, `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`, "utf8");
}

function appendJsonlEvent(filename, event) {
  return appendFile(filename, `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`, "utf8");
}

async function buildCompletionPayload(result, runtime, execution, ticket) {
  await writeFile(runtime.stdoutPath, result.stdout || "", "utf8");
  await writeFile(runtime.stderrPath, result.stderr || "", "utf8");

  const explicitResult = result.result || (await readResultFile(runtime.resultPath));
  const missingResult = !explicitResult || typeof explicitResult !== "object" || Array.isArray(explicitResult);
  const normalized = await recoverGitMetadataBlockedCompletion(
    normalizeCompletionArtifacts(normalizeCompletionResult(explicitResult, execution, ticket), execution),
    execution,
  );
  const finalMessage = await readOptionalFile(runtime.finalMessagePath);
  const workLog = buildAgentWorkLog({
    execution,
    exitCode: result.exitCode,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    finalMessage,
    normalized,
  });
  await writeFile(runtime.workLogPath, workLog.markdown, "utf8");
  const artifacts = [
    {
      kind: "report",
      label: "Agent work log",
      uri: pathToFileURL(runtime.workLogPath).href,
      metadata: {
        agentWork: workLog.metadata,
      },
    },
    {
      kind: "log",
      label: "Adapter stdout",
      uri: pathToFileURL(runtime.stdoutPath).href,
    },
    {
      kind: "log",
      label: "Adapter stderr",
      uri: pathToFileURL(runtime.stderrPath).href,
    },
    {
      kind: "log",
      label: "Adapter events JSONL",
      uri: pathToFileURL(runtime.agentEventsPath).href,
      metadata: {
        format: "jsonl",
        harness: "floop-execution-driver",
      },
    },
    ...(normalized.artifacts || []),
  ];

  if (finalMessage) {
    artifacts.push({
      kind: "report",
      label: "Agent final message",
      uri: pathToFileURL(runtime.finalMessagePath).href,
    });
  }

  if (result.cancelled) {
    return {
      outcome: "failed",
      summaryMd: result.cancelReason || "Adapter process was cancelled before it reported a final result.",
      remainingWorkMd: normalized.remainingWorkMd || "",
      expectedNextEvidenceMd: normalized.expectedNextEvidenceMd || "",
      failureKind: "cancelled",
      blockedKind: normalized.blockedKind || "",
      artifacts,
      followupTickets: normalized.followupTickets,
    };
  }

  if (isAuthRequiredAdapterFailure(result)) {
    const authDetail = tailText([result.stderr || "", result.stdout || ""].join("\n")).trim();
    return {
      outcome: "blocked",
      summaryMd: "Adapter requires authentication before it can run.",
      remainingWorkMd: authDetail || "Authenticate the configured agent CLI, then continue this execution.",
      expectedNextEvidenceMd: "The same agent lane completes after authentication is restored.",
      failureKind: "",
      blockedKind: "codex_auth_required",
      artifacts,
      followupTickets: normalized.followupTickets,
    };
  }

  if (result.exitCode !== 0 || missingResult) {
    return {
      outcome: "failed",
      summaryMd:
        missingResult
          ? `Adapter command exited with code ${result.exitCode}, but did not write the required result JSON.`
          : normalized.summaryMd ||
            `Adapter command exited with code ${result.exitCode}.${result.stderr ? `\n\n${result.stderr.trim()}` : ""}`,
      remainingWorkMd: normalized.remainingWorkMd || "",
      expectedNextEvidenceMd: normalized.expectedNextEvidenceMd || "",
      failureKind: missingResult ? "missing_result_json" : normalized.failureKind || "adapter_command_failed",
      blockedKind: normalized.blockedKind || "",
      artifacts,
      followupTickets: normalized.followupTickets,
    };
  }

  return {
    outcome: normalized.outcome,
    summaryMd: normalized.summaryMd,
    remainingWorkMd: normalized.remainingWorkMd,
    expectedNextEvidenceMd: normalized.expectedNextEvidenceMd,
    failureKind: normalized.failureKind,
    blockedKind: normalized.blockedKind,
    artifacts,
    review: normalized.review,
    validation: normalized.validation,
    followupTickets: normalized.followupTickets,
  };
}

function isAuthRequiredAdapterFailure(result) {
  if (!result || result.exitCode === 0) {
    return false;
  }
  const text = `${result.stderr || ""}\n${result.stdout || ""}`.toLowerCase();
  return (
    text.includes("not logged in") ||
    text.includes("not authenticated") ||
    text.includes("authentication required") ||
    text.includes("login required") ||
    text.includes("please log in") ||
    text.includes("codex login")
  );
}

async function readResultFile(filename) {
  try {
    const file = await readFile(filename, "utf8");
    if (!file.trim()) {
      return null;
    }
    return JSON.parse(file);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function readOptionalFile(filename) {
  try {
    return await readFile(filename, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

function buildAgentWorkLog({ execution, exitCode, stdout, stderr, finalMessage, normalized }) {
  const signals = classifyAgentWorkSignals({ stdout, stderr, finalMessage });
  const summary = summarizeAgentWorkSignals(signals, normalized, exitCode);
  const markdown = [
    `# Agent work log`,
    ``,
    `Execution: ${execution.ticketKey || execution.ticketId} ${execution.role} iteration ${execution.iteration}`,
    `Outcome: ${normalized.outcome || "unknown"}`,
    `Exit code: ${exitCode}`,
    `Summary: ${normalized.summaryMd || "No result summary recorded."}`,
    ``,
    `## Signal summary`,
    ``,
    `- Progress signals: ${signals.progress.length}`,
    `- Question signals: ${signals.questions.length}`,
    `- Stderr lines: ${signals.stderrLines.length}`,
    `- Final message present: ${finalMessage.trim() ? "yes" : "no"}`,
    ``,
    `## Progress signals`,
    ``,
    ...formatSignalLines(signals.progress),
    ``,
    `## Question signals`,
    ``,
    ...formatSignalLines(signals.questions),
    ``,
    `## Stdout tail`,
    ``,
    "```",
    tailText(stdout),
    "```",
    ``,
    `## Stderr tail`,
    ``,
    "```",
    tailText(stderr),
    "```",
    ``,
    `## Final message tail`,
    ``,
    "```",
    tailText(finalMessage),
    "```",
    ``,
  ].join("\n");

  return {
    markdown,
    metadata: {
      summary,
      progressSignalCount: signals.progress.length,
      questionSignalCount: signals.questions.length,
      stderrLineCount: signals.stderrLines.length,
      finalMessagePresent: Boolean(finalMessage.trim()),
      hasQuestionSignals: signals.questions.length > 0,
    },
  };
}

function classifyAgentWorkSignals({ stdout, stderr, finalMessage }) {
  const lines = [
    ...tagLines(stdout, "stdout"),
    ...tagLines(stderr, "stderr"),
    ...tagLines(finalMessage, "final"),
  ];
  const progress = lines.filter((line) => isProgressSignal(line.text)).slice(-12);
  const questions = lines.filter((line) => isQuestionSignal(line.text)).slice(-12);
  return {
    progress,
    questions,
    stderrLines: tagLines(stderr, "stderr"),
  };
}

function tagLines(text, source) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((text) => ({ source, text }));
}

function isProgressSignal(line) {
  return /\b(inspect(?:ed|ing)?|read|created|wrote|changed|updated|committed|verified|validated|reviewed|passed|completed|artifact|worktree|git|result)\b/i.test(line);
}

function isQuestionSignal(line) {
  if (/\b(no blocking questions|no questions|without questions?)\b/i.test(line)) {
    return false;
  }
  return /\?\s*$|\b(clarify|question|need input|need more information|please provide|cannot proceed|waiting for|blocked by missing)\b/i.test(line);
}

function summarizeAgentWorkSignals(signals, normalized, exitCode) {
  if (signals.questions.length > 0 && signals.progress.length === 0) {
    return "Question-like output without clear progress signals.";
  }
  if (signals.questions.length > 0) {
    return "Progress recorded, with question-like output to inspect.";
  }
  if (signals.progress.length > 0) {
    return "Progress recorded without question-like output.";
  }
  if (exitCode !== 0 || normalized.outcome === "failed") {
    return "No progress signals; inspect failure output.";
  }
  return "No explicit progress signals found in agent output.";
}

function formatSignalLines(lines) {
  if (lines.length === 0) {
    return ["- None detected."];
  }
  return lines.map((line) => `- ${line.source}: ${line.text}`);
}

function tailText(text, maxLines = 24, maxChars = 4000) {
  const value = String(text || "").trim();
  if (!value) {
    return "(empty)";
  }
  const lines = value.split(/\r?\n/).slice(-maxLines).join("\n");
  return lines.length > maxChars ? lines.slice(lines.length - maxChars) : lines;
}

function normalizeCompletionResult(result, execution = null, ticket = null) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return {
      outcome: "completed",
      summaryMd: execution
        ? `${execution.ticketKey} ${execution.role} iteration ${execution.iteration} completed.`
        : "Execution completed through the background adapter driver.",
      remainingWorkMd: "",
      expectedNextEvidenceMd: "",
      failureKind: "",
      blockedKind: "",
      artifacts: [],
      review: undefined,
      validation: undefined,
      followupTickets: [],
    };
  }

  return {
    outcome: typeof result.outcome === "string" ? result.outcome : "completed",
    summaryMd:
      typeof result.summaryMd === "string"
        ? result.summaryMd
        : execution
          ? `${execution.ticketKey} ${execution.role} iteration ${execution.iteration} completed.`
          : "Execution completed through the background adapter driver.",
    remainingWorkMd: typeof result.remainingWorkMd === "string" ? result.remainingWorkMd : "",
    expectedNextEvidenceMd:
      typeof result.expectedNextEvidenceMd === "string" ? result.expectedNextEvidenceMd : "",
    failureKind: typeof result.failureKind === "string" ? result.failureKind : "",
    blockedKind: typeof result.blockedKind === "string" ? result.blockedKind : "",
    artifacts: normalizeArtifacts(result.artifacts),
    review: normalizeEmbeddedReviewResult(result.review),
    validation: normalizeEmbeddedValidationResult(result.validation),
    followupTickets: normalizeFollowupTickets(result.followupTickets, ticket),
  };
}

function normalizeFollowupTickets(value, parentTicket = null) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((ticket) => ticket && typeof ticket === "object" && !Array.isArray(ticket))
    .map((ticket) => ({
      title: typeof ticket.title === "string" ? ticket.title : "",
      brief: typeof ticket.brief === "string" ? ticket.brief : "",
      acceptanceCriteriaMd:
        typeof ticket.acceptanceCriteriaMd === "string" ? ticket.acceptanceCriteriaMd : "",
      definitionOfDoneMd:
        typeof ticket.definitionOfDoneMd === "string" ? ticket.definitionOfDoneMd : "",
      latestSummary: typeof ticket.latestSummary === "string" ? ticket.latestSummary : "",
      state: typeof ticket.state === "string" ? ticket.state : "",
      priority: typeof ticket.priority === "string" ? ticket.priority : "",
      assignedRole: typeof ticket.assignedRole === "string" ? ticket.assignedRole : "",
      repoTargets: normalizeRepoTargets(ticket.repoTargets, parentTicket?.repoTargets || []),
    }))
    .filter((ticket) => ticket.title && ticket.brief);
}

function normalizeRepoTargets(value, referenceTargets = []) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((target) => (typeof target === "string" ? { repoSlug: target } : target))
    .filter((target) => target && typeof target === "object" && !Array.isArray(target))
    .map((target) => {
      const reference = resolveReferenceRepoTarget(target, referenceTargets);
      return {
        repoId: typeof target.repoId === "string" && target.repoId ? target.repoId : reference?.repoId || "",
        baseRef: typeof target.baseRef === "string" && target.baseRef ? target.baseRef : reference?.baseRef || "",
        branchName: typeof target.branchName === "string" ? target.branchName : "",
        targetScopeMd: typeof target.targetScopeMd === "string" ? target.targetScopeMd : "",
      };
    })
    .filter((target) => target.repoId);
}

function resolveReferenceRepoTarget(target, referenceTargets) {
  const references = Array.isArray(referenceTargets) ? referenceTargets : [];
  const identifier = [target.repoId, target.repoSlug, target.repoName, target.name, target.slug]
    .find((value) => typeof value === "string" && value.trim())
    ?.trim();
  if (!identifier && references.length === 1) {
    return references[0];
  }
  if (!identifier) {
    return null;
  }
  return (
    references.find(
      (reference) =>
        reference.repoId === identifier ||
        reference.repoSlug === identifier ||
        reference.repoName === identifier,
    ) || null
  );
}

function normalizeEmbeddedReviewResult(review) {
  if (!review || typeof review !== "object" || Array.isArray(review)) {
    return undefined;
  }

  const verdict = typeof review.verdict === "string" ? review.verdict : "";
  if (!verdict) {
    return undefined;
  }

  const normalized = {
    verdict,
  };

  if (typeof review.summaryMd === "string") {
    normalized.summaryMd = review.summaryMd;
  }
  if (typeof review.blockedKind === "string") {
    normalized.blockedKind = review.blockedKind;
  }

  const artifacts = normalizeArtifacts(review.artifacts);
  if (artifacts.length > 0) {
    normalized.artifacts = artifacts;
  }

  const findings = normalizeReviewFindings(review.findings);
  if (findings) {
    normalized.findings = findings;
  }

  return normalized;
}

function normalizeEmbeddedValidationResult(validation) {
  if (!validation || typeof validation !== "object" || Array.isArray(validation)) {
    return undefined;
  }

  const verdict = typeof validation.verdict === "string" ? validation.verdict : "";
  if (!verdict) {
    return undefined;
  }

  const normalized = {
    verdict,
  };

  if (typeof validation.summaryMd === "string") {
    normalized.summaryMd = validation.summaryMd;
  }
  if (typeof validation.blockedKind === "string") {
    normalized.blockedKind = validation.blockedKind;
  }
  if (typeof validation.commandProfile === "string") {
    normalized.commandProfile = validation.commandProfile;
  }

  const artifacts = normalizeArtifacts(validation.artifacts);
  if (artifacts.length > 0) {
    normalized.artifacts = artifacts;
  }

  const commands = normalizeStringList(validation.commands);
  if (commands) {
    normalized.commands = commands;
  }

  const repoIds = normalizeStringList(validation.repoIds);
  if (repoIds) {
    normalized.repoIds = repoIds;
  }

  return normalized;
}

function normalizeReviewFindings(findings) {
  if (!Array.isArray(findings)) {
    return undefined;
  }

  return findings
    .filter((finding) => finding && typeof finding === "object" && !Array.isArray(finding))
    .map((finding) => {
      const normalized = {
        severity: typeof finding.severity === "string" ? finding.severity : "",
        category: typeof finding.category === "string" ? finding.category : "",
        title: typeof finding.title === "string" ? finding.title : "",
      };
      if (typeof finding.filePath === "string") {
        normalized.filePath = finding.filePath;
      }
      if (typeof finding.lineNumber === "number" && Number.isInteger(finding.lineNumber) && finding.lineNumber > 0) {
        normalized.lineNumber = finding.lineNumber;
      }
      if (typeof finding.detailsMd === "string") {
        normalized.detailsMd = finding.detailsMd;
      }
      return normalized;
    })
    .filter((finding) => finding.severity && finding.category && finding.title);
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.filter((entry) => typeof entry === "string" && entry.trim());
}

function normalizeArtifacts(value) {
  return Array.isArray(value)
    ? value.filter(isArtifactLike).map((artifact) => ({
        kind: artifact.kind,
        label: artifact.label,
        uri: artifact.uri,
        metadata: artifact.metadata && typeof artifact.metadata === "object" ? artifact.metadata : undefined,
      }))
    : [];
}

function normalizeCompletionArtifacts(completion, execution) {
  return {
    ...completion,
    artifacts: normalizeArtifactUris(completion.artifacts, execution),
    review: completion.review
      ? {
          ...completion.review,
          artifacts: normalizeArtifactUris(completion.review.artifacts, execution),
        }
      : completion.review,
    validation: completion.validation
      ? {
          ...completion.validation,
          artifacts: normalizeArtifactUris(completion.validation.artifacts, execution),
        }
      : completion.validation,
  };
}

async function recoverGitMetadataBlockedCompletion(completion, execution) {
  if (!isRecoverableGitMetadataCompletion(completion)) {
    return completion;
  }

  const recoveredCommits = [];
  for (const worktree of execution.worktrees || []) {
    const status = await runProcess("git", ["-C", worktree.path, "status", "--porcelain=v1"], {
      cwd: worktree.path,
      env: process.env,
    });
    if (status.exitCode !== 0 || !hasCommittableStatus(status.stdout)) {
      continue;
    }

    const add = await runProcess(
      "git",
      ["-C", worktree.path, "add", "-A", "--", ".", ":(exclude).floop-worktree.json"],
      {
        cwd: worktree.path,
        env: process.env,
      },
    );
    if (add.exitCode !== 0) {
      continue;
    }

    const staged = await runProcess("git", ["-C", worktree.path, "diff", "--cached", "--name-only"], {
      cwd: worktree.path,
      env: process.env,
    });
    if (staged.exitCode !== 0 || !staged.stdout.trim()) {
      continue;
    }

    const commitMessage = `${execution.ticketKey || execution.ticketId}: ${execution.ticketTitle || "Agent work"}`;
    const commit = await runProcess("git", ["-C", worktree.path, "commit", "-m", commitMessage], {
      cwd: worktree.path,
      env: process.env,
    });
    if (commit.exitCode === 0) {
      const sha = await runProcess("git", ["-C", worktree.path, "rev-parse", "--short", "HEAD"], {
        cwd: worktree.path,
        env: process.env,
      });
      recoveredCommits.push(`${worktree.repoSlug || worktree.repoId}: ${sha.stdout.trim()}`);
    }
  }

  if (recoveredCommits.length === 0) {
    return completion;
  }

  return {
    ...completion,
    outcome: "completed",
    blockedKind: "",
    remainingWorkMd: "",
    expectedNextEvidenceMd: completion.expectedNextEvidenceMd || "Recovered by Floop committing the dirty worktree after adapter completion.",
    summaryMd: `${completion.summaryMd || "Agent completed work but could not commit from its sandbox."}\n\nFloop recovered the sandbox Git metadata limitation by committing the dirty worktree after adapter completion:\n${recoveredCommits.map((item) => `- ${item}`).join("\n")}`,
  };
}

function isGitMetadataReadOnlyBlockedKind(value) {
  return [
    "environment_git_read_only",
    "environment-git-read-only",
    "git_metadata_read_only",
    "git-metadata-readonly",
    "git_metadata_readonly",
    "git-metadata-read-only",
    "filesystem_read_only_git_metadata",
    "filesystem-read-only-git-metadata",
  ].includes(String(value || "").trim().toLowerCase());
}

function isRecoverableGitMetadataCompletion(completion) {
  if (completion.outcome === "blocked" && isGitMetadataReadOnlyBlockedKind(completion.blockedKind)) {
    return true;
  }

  if (completion.outcome !== "needs_continue") {
    return false;
  }

  const text = [
    completion.summaryMd,
    completion.remainingWorkMd,
    completion.expectedNextEvidenceMd,
  ].join("\n").toLowerCase();
  return (
    (text.includes("git metadata") || text.includes("worktree metadata") || text.includes("index.lock")) &&
    (text.includes("read-only") || text.includes("read only") || text.includes("mounted read-only"))
  );
}

function hasCommittableStatus(statusText) {
  return String(statusText || "")
    .split(/\r?\n/)
    .some((line) => line.trim() && !line.endsWith(".floop-worktree.json"));
}

function normalizeArtifactUris(artifacts, execution) {
  return (artifacts || []).map((artifact) => ({
    ...artifact,
    uri: normalizeArtifactUri(artifact.uri, execution),
  }));
}

function normalizeArtifactUri(uri, execution) {
  const value = String(uri || "").trim();
  if (!value) {
    return value;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    return value;
  }
  const basePath = execution?.worktrees?.[0]?.path || process.cwd();
  return pathToFileURL(resolve(basePath, value)).href;
}

function isArtifactLike(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof value.kind === "string" &&
      typeof value.label === "string" &&
      typeof value.uri === "string",
  );
}

function buildCodexArgs(adapterRun, { project, ticket, execution, runtime }) {
  const args = [
    "exec",
    "--json",
  ];

  const steeringThreadId =
    execution.steeringMetadata?.resumeStrategy === "interrupt_and_resume" && execution.externalThreadId
      ? execution.externalThreadId
      : "";
  if (steeringThreadId) {
    args.push("resume", steeringThreadId);
  }

  args.push(
    "-C",
    execution.worktrees[0]?.path || project.workspaceRoot,
    "--add-dir",
    project.workspaceRoot,
    "--skip-git-repo-check",
    "-s",
    adapterRun.sandbox,
    "-c",
    `approval_policy=${JSON.stringify(adapterRun.approvalPolicy)}`,
  );

  if (adapterRun.ignoreUserConfig) {
    args.push("--ignore-user-config");
  }

  for (const target of ticket.repoTargets || []) {
    if (target.repoLocalPath) {
      args.push("--add-dir", target.repoLocalPath);
      args.push("--add-dir", join(target.repoLocalPath, ".git"));
    }
  }

  args.push("-o", runtime.finalMessagePath);

  if (shouldPassCodexModel(adapterRun.model)) {
    args.push("-m", adapterRun.model);
  }

  args.push("-");

  return args;
}

function shouldPassCodexModel(model) {
  return Boolean(model && model !== "default" && model !== "codex-latest");
}

function buildCodexPrompt(project, ticket, execution, adapterRun, runtime) {
  const scopes = ticket.repoTargets
    .map((target) => `- ${target.repoSlug}: ${target.targetScopeMd || "no explicit scope"}`)
    .join("\n");
  const worktrees = execution.worktrees
    .map((worktree) => `- ${worktree.repoSlug}: ${worktree.path} (${worktree.branchName} from ${worktree.baseRef})`)
    .join("\n");

  const preamble = adapterRun.promptPreamble ? `${adapterRun.promptPreamble}\n\n` : "";
  const resultContract = buildCodexResultContract(execution.role, runtime.resultPath);
  const roleGuidance = buildCodexRoleGuidance(execution.role, project.policy || {});
  const refinementPolicy = describeRefinementMode(project.policy?.refinementMode);
  const requiredValidationCommandProfile =
    project.policy?.requiredValidationCommandProfileForMerge || "none";
  const steeringPreamble = buildSteeringPreamble(execution);
  return `${preamble}${steeringPreamble}You are the ${execution.role} lane for Floop ticket ${ticket.key}.

Operate inside the provided worktree and make the required code changes directly.

Project: ${project.name}
Refinement policy: ${refinementPolicy}
Required validation command profile before merge: ${requiredValidationCommandProfile}
Ticket: ${ticket.key} - ${ticket.title}
Brief: ${ticket.brief}
Acceptance criteria:
${ticket.acceptanceCriteriaMd || "None recorded."}

Definition of done:
${ticket.definitionOfDoneMd || "None recorded."}

Repo targets:
${scopes || "- none"}

Planned worktrees:
${worktrees || "- none"}

Execution context JSON: ${runtime.contextPath}
Required result JSON output path: ${runtime.resultPath}

Lane guidance:
${roleGuidance}

Before finishing:
1. Inspect the execution context file.
2. Complete the ${execution.role} lane work in the worktree.
3. Use bounded commands only. Do not leave local servers, test watchers, or smoke checks running indefinitely; wrap server checks with timeouts or use in-process tests that close listeners.
4. If you changed repository files, run git status, stage the intended files, and commit the work on the current branch.
5. Summarize what you changed, verified, and what remains.
6. Write a JSON object to ${runtime.resultPath} with:
${resultContract}

If you lack a decision, product detail, credential, policy call, or environmental fact needed to proceed, ask for it explicitly by returning outcome "blocked" with blockedKind "needs_human_input". Fully autonomous mode still allows this: Floop will surface the question on the ticket and can continue the lane after a human or agent response.

If you are blocked or incomplete, say so explicitly in the JSON outcome fields instead of pretending success.`;
}

function buildSteeringPreamble(execution) {
  const metadata = execution.steeringMetadata || {};
  if (metadata.resumeStrategy !== "interrupt_and_resume" || !metadata.steeringBody) {
    return "";
  }
  return [
    "Floop interrupted the previous active run so this same native agent session could be steered.",
    `Steering note from ${metadata.steeringActor || "operator"}:`,
    metadata.steeringBody,
    "",
    "Before changing files, inspect the current worktree state and adapt the previous plan to this steering note.",
    "",
  ].join("\n");
}

function createCodexStdoutObserver(options) {
  let buffer = "";
  return (text) => {
    buffer += text;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      const event = parseJsonLine(line);
      if (!event) {
        continue;
      }
      if (event.type === "thread.started" && typeof event.thread_id === "string" && event.thread_id) {
        options.store?.updateExecutionHarnessSession?.(options.execution.projectId, options.execution.id, {
          harnessKind: "codex_exec",
          externalThreadId: event.thread_id,
          harnessCapabilities: ["queued_context", "interrupt_and_resume"],
        });
      }
    }
  };
}

function parseJsonLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function buildCodexRoleGuidance(role, policy = {}) {
  if (role === "architect") {
    return [
      "- Define the smallest useful technical plan, boundaries, risks, and validation approach for the ticket.",
      "- Prefer durable project artifacts such as docs or diagrams when they help the next lane act.",
      "- Put suggested follow-up work in the plan or summary. Do not create follow-up tickets or use outcome \"followup_created\" unless the ticket explicitly asks the architect lane to create tickets.",
      "- Do not implement production code unless the ticket explicitly asks the architect lane to do so.",
    ].join("\n");
  }

  if (role === "product_manager") {
    return [
      "- Turn broad goals into executable tickets when the work is too large or underspecified for one implementation lane.",
      "- Prefer thin vertical slices that can be implemented, reviewed, validated, and merged independently.",
      "- For each follow-up ticket, include assignedRole, priority, brief, acceptanceCriteriaMd, definitionOfDoneMd, and repoTargets when repo work is needed.",
      "- Each implementation follow-up should name the expected validation approach and the demo evidence that will prove the product behavior works.",
      "- If the ticket is a product breakdown or Product Autopilot planning ticket, produce followupTickets for the first shippable product surface before marking the lane complete.",
      "- Ask for human input only when a product decision materially changes scope, user experience, data model, or launch criteria; otherwise make a conservative product call and keep the run moving.",
      "- Do not implement code in this lane unless the ticket explicitly asks for product-owned artifacts.",
    ].join("\n");
  }

  if (role === "developer") {
    return [
      "- Implement the ticket against its brief, acceptance criteria, definition of done, and repo targets.",
      "- Keep the change scoped to the ticket while leaving the repo runnable and coherent.",
      "- Add or update focused tests when the ticket changes behavior.",
      "- Run the strongest relevant local checks you can reasonably run before committing.",
      "- Do not launch browser automation, MCP servers, or interactive tooling unless the ticket explicitly requires that tool; prefer direct file edits and bounded tests.",
      "- Emit concrete progress in stdout or the final message so Floop can show proof that work happened.",
    ].join("\n");
  }

  if (role === "reviewer") {
    return [
      "- Review independently against the ticket brief, acceptance criteria, definition of done, and the actual repo diff.",
      "- Inspect implementation, tests, and relevant runtime behavior rather than relying only on the developer summary.",
      "- In review.summaryMd, include short sections for Review plan, Evidence inspected, Findings, and Decision.",
      "- Use review.verdict \"passed\" only when there are no blocking implementation, scope, or test issues.",
      "- Put concrete issues in review.findings with severity, category, title, and filePath or lineNumber when available.",
    ].join("\n");
  }

  if (role === "validator") {
    const requiredProfile = policy.requiredValidationCommandProfileForMerge || "";
    const requiredDemoEvidence = Boolean(policy.requireDemoEvidenceBeforeMerge);
    return [
      "- Validate independently; do not just trust the implementation or review summary.",
      "- Choose the validation strategy from the ticket brief, acceptance criteria, definition of done, repo state, and available scripts.",
      "- Prefer the strongest local checks that fit the ticket. For code tickets this often includes the project test command, but targeted smoke checks, browser/API checks, or direct artifact inspection may be stronger for the acceptance criteria.",
      "- For docs, planning, architecture, or other non-code tickets, validate the required deliverables directly instead of forcing an unrelated test suite.",
      "- In validation.summaryMd, include short sections for Validation plan, Checks run, Why sufficient, and Result.",
      requiredDemoEvidence
        ? "- This project requires demo evidence before merge. Include at least one validation artifact marked with kind \"demo\" or metadata.demoEvidence true, even for documentation, planning, or architecture tickets. For non-UI work, use demo notes, an inspection transcript, or another concise proof artifact."
        : "- Include demo evidence as a validation artifact whenever the ticket changes product behavior or user-visible workflow. Demo evidence can be a screenshot, recording, demo notes, API transcript, or another artifact marked with kind \"demo\" or metadata.demoEvidence true.",
      "- If the feature is not demoable or the evidence shows missing work, set validation.verdict to \"failed\" and explain the rework needed so Floop can route the previous working lane again.",
      requiredProfile
        ? `- When validation passes, set validation.commandProfile to "${requiredProfile}" because this project requires that profile before merge.`
        : "- Set validation.commandProfile to a short label for the validation strategy you actually used.",
      "- Set validation.verdict \"passed\" only when the selected checks pass, include validation.commands for commands actually run, and include validation.repoIds for validated repo targets.",
    ].join("\n");
  }

  return [
    "- Complete the lane work requested by the ticket and execution role.",
    "- Keep the result scoped, observable, and explicit about any remaining work or blockers.",
  ].join("\n");
}

function buildCodexResultContract(role, resultPath) {
  const shared = [
    `   - outcome: one of completed, needs_continue, blocked, followup_created, failed`,
    `   - summaryMd: markdown summary`,
    `   - remainingWorkMd: markdown string`,
    `   - expectedNextEvidenceMd: markdown string`,
    `   - failureKind: optional short string`,
    `   - blockedKind: optional short string`,
    `   - artifacts: optional array of { kind, label, uri, metadata } for execution-level evidence`,
    `   - followupTickets: optional array of child tickets { title, brief, acceptanceCriteriaMd?, definitionOfDoneMd?, state?, priority?, assignedRole?, repoTargets? }`,
  ];

  if (role === "reviewer") {
    return `${shared.join("\n")}
   - review: required on successful review completions, shaped as:
     { verdict, summaryMd?, blockedKind?, artifacts?, findings? }
   - review.verdict: one of passed, rework, blocked
   - review.artifacts: optional array of { kind, label, uri, metadata } for durable review evidence
   - review.findings: optional array of
     { severity, category, title, filePath?, lineNumber?, detailsMd? }

The JSON file at ${resultPath} should include the top-level execution outcome plus the nested review result.`;
  }

  if (role === "validator") {
    return `${shared.join("\n")}
   - validation: required on successful validation completions, shaped as:
     { verdict, summaryMd?, blockedKind?, commandProfile?, commands?, repoIds?, artifacts? }
   - validation.verdict: one of passed, failed, blocked
   - validation.commands: optional array of commands you ran
   - validation.repoIds: optional array of repo ids you validated
   - validation.artifacts: optional array of { kind, label, uri, metadata } for durable validation evidence
   - validation.artifacts should include demo evidence before merge when project policy requires demo evidence or when the ticket changes product behavior; mark it with kind "demo" or metadata.demoEvidence true

The JSON file at ${resultPath} should include the top-level execution outcome plus the nested validation result.`;
  }

  return shared.join("\n");
}

function describeRefinementMode(refinementMode = "user_approved") {
  if (refinementMode === "autonomous") {
    return "autonomous; agent-created follow-up tickets may be READY when the lane has enough evidence.";
  }
  if (refinementMode === "user_participant") {
    return "user participant; create follow-up tickets as PROPOSED refinement items for user collaboration before READY.";
  }
  if (refinementMode === "user_only") {
    return "user only; create follow-up tickets as PROPOSED or DRAFT and do not mark them READY.";
  }
  return "user approved; create follow-up tickets as PROPOSED unless a user later approves them for READY.";
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
