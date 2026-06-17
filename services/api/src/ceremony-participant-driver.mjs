import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { buildProjectLookupContext } from "./project-context.mjs";

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_MAX_PARALLEL = 4;

export function createCeremonyParticipantDriver(options = {}) {
  if (!options.store) {
    throw new Error("Ceremony participant driver requires a store");
  }

  return new CeremonyParticipantDriver({
    store: options.store,
    pollIntervalMs: options.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS,
    maxParallel: options.maxParallel || DEFAULT_MAX_PARALLEL,
    logger: options.logger || console,
  });
}

class CeremonyParticipantDriver {
  constructor({ store, pollIntervalMs, maxParallel, logger }) {
    this.store = store;
    this.pollIntervalMs = pollIntervalMs;
    this.maxParallel = maxParallel;
    this.logger = logger;
    this.timer = null;
    this.inFlight = new Map();
  }

  start() {
    if (this.timer) {
      return;
    }

    this.pollOnce().catch((error) => {
      this.logger.error?.("[floop-ceremony-participants] startup poll failed", error);
    });

    this.timer = setInterval(() => {
      this.pollOnce().catch((error) => {
        this.logger.error?.("[floop-ceremony-participants] poll failed", error);
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
    const openSlots = Math.max(0, this.maxParallel - this.inFlight.size);
    if (openSlots === 0) {
      return [];
    }
    const pending = this.store
      .listPendingCeremonyParticipants()
      .filter((participant) => !this.inFlight.has(participant.id))
      .slice(0, openSlots);

    const started = pending.map((participant) => {
      const promise = this.runParticipant(participant)
        .catch((error) => {
          this.logger.error?.("[floop-ceremony-participants] participant failed", error);
        })
        .finally(() => {
          this.inFlight.delete(participant.id);
        });
      this.inFlight.set(participant.id, promise);
      return promise;
    });

    await Promise.all(started);
    return pending;
  }

  async runParticipant(participant) {
    const started = this.store.startCeremonyParticipant(participant.projectId, participant.id);
    if (!started || started.status !== "running") {
      return;
    }

    const project = this.store.getProjectSummary(started.projectId);
    const run = this.store.getCeremonyRun(started.projectId, started.runId);
    if (!project || !run) {
      return;
    }

    const profile = project.roleProfiles.find((candidate) => candidate.role === started.role);
    const adapter = selectAdapter(profile);
    if (!adapter) {
      this.store.completeCeremonyParticipant(started.projectId, started.id, {
        outcome: "failed",
        summaryMd: `No runnable adapter profile configured for ${started.role}.`,
        riskMd: "Ceremony participant could not run.",
      });
      return;
    }

    const runtime = await prepareRuntime(this.store, project, run, started);
    const result = await runAdapter(adapter, {
      project,
      run,
      participant: started,
      runtime,
    });
    const completion = await buildCompletion(result, runtime, started);
    this.store.completeCeremonyParticipant(started.projectId, started.id, completion);
  }
}

function selectAdapter(profile) {
  if (!profile) {
    return null;
  }
  if (profile.adapter === "mock") {
    return {
      kind: "mock",
      result: profile.config?.result || {},
    };
  }
  if (typeof profile.config?.command === "string" && profile.config.command.trim()) {
    return {
      kind: "shell",
      command: profile.config.command.trim(),
    };
  }
  if (profile.adapter === "codex") {
    return {
      kind: "codex",
      executable: typeof profile.config?.executable === "string" && profile.config.executable.trim()
        ? profile.config.executable.trim()
        : "codex",
      sandbox: typeof profile.config?.sandbox === "string" && profile.config.sandbox.trim()
        ? profile.config.sandbox.trim()
        : "workspace-write",
      approvalPolicy:
        typeof profile.config?.approvalPolicy === "string" && profile.config.approvalPolicy.trim()
          ? profile.config.approvalPolicy.trim()
          : "never",
      model: profile.model,
      promptPreamble: typeof profile.config?.promptPreamble === "string" ? profile.config.promptPreamble.trim() : "",
    };
  }
  return null;
}

async function prepareRuntime(store, project, run, participant) {
  const root = resolve(project.workspaceRoot, ".floop", "ceremonies", run.id, participant.role);
  const contextPath = join(root, "context.json");
  const resultPath = join(root, "result.json");
  const promptPath = join(root, "prompt.md");
  const finalMessagePath = join(root, "agent-final-message.md");
  await mkdir(dirname(contextPath), { recursive: true });
  await writeFile(
    contextPath,
    JSON.stringify(
      {
        project,
        projectContext: buildProjectLookupContext(store, project),
        ceremony: run,
        participant,
      },
      null,
      2,
    ),
    "utf8",
  );
  return { root, contextPath, resultPath, promptPath, finalMessagePath };
}

async function runAdapter(adapter, options) {
  if (adapter.kind === "mock") {
    return { exitCode: 0, stdout: "mock ceremony participant completed", stderr: "", result: adapter.result };
  }
  if (adapter.kind === "shell") {
    return runProcess(adapter.command, [], {
      cwd: options.project.workspaceRoot,
      shell: true,
      env: buildEnv(options),
    });
  }

  const prompt = buildPrompt(options.project, options.run, options.participant, adapter, options.runtime);
  await writeFile(options.runtime.promptPath, prompt, "utf8");
  return runProcess(adapter.executable, buildCodexArgs(adapter, options), {
    cwd: options.project.workspaceRoot,
    env: buildEnv(options),
    stdin: prompt,
  });
}

function buildEnv({ project, run, participant, runtime }) {
  return {
    ...process.env,
    FLOOP_PROJECT_ID: project.id,
    FLOOP_CEREMONY_ID: run.id,
    FLOOP_CEREMONY_TYPE: run.type,
    FLOOP_CEREMONY_ROLE: participant.role,
    FLOOP_CONTEXT_PATH: runtime.contextPath,
    FLOOP_RESULT_PATH: runtime.resultPath,
  };
}

function buildCodexArgs(adapter, { project, runtime }) {
  const args = [
    "exec",
    "-C",
    project.workspaceRoot,
    "--add-dir",
    project.workspaceRoot,
    "--skip-git-repo-check",
    "-s",
    adapter.sandbox,
    "-c",
    `approval_policy=${JSON.stringify(adapter.approvalPolicy)}`,
    "-o",
    runtime.finalMessagePath,
  ];
  if (adapter.model && adapter.model !== "default" && adapter.model !== "codex-latest") {
    args.push("-m", adapter.model);
  }
  args.push("-");
  return args;
}

function buildPrompt(project, run, participant, adapter, runtime) {
  const preamble = adapter.promptPreamble ? `${adapter.promptPreamble}\n\n` : "";
  return `${preamble}You are the ${participant.role} participant in a Floop ${run.type} ceremony.

This is a ceremony contribution, not implementation work. Do not modify application files.

Project: ${project.name}
Ceremony: ${run.type}
Decider: ${run.deciderRole || "operator"}
Consensus policy: ${run.consensusPolicy || "decider_synthesizes_objections"}

Inspect the ceremony context JSON at ${runtime.contextPath}.
Write a JSON result to ${runtime.resultPath} with:
- outcome: completed, blocked, or failed
- summaryMd: concise role-specific ceremony advice
- questionsMd: open questions for the PO/decider
- riskMd: risks, objections, or readiness concerns
- payload: optional structured role findings
  - For refinement ceremonies, payload.refinementRecommendations may include:
    - { type: "combine", keeperTicketId, duplicateTicketId, reason }
    - { type: "cancel", ticketId, reason }
    - { type: "split", sourceTicketId, tickets: [{ title, brief, acceptanceCriteriaMd?, definitionOfDoneMd?, priority?, assignedRole?, repoTargets? }], reason }
    - { type: "question", ticketId?, questionMd, reason? }

Be explicit about disagreement or missing information.`;
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
      resolvePromise({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

async function buildCompletion(result, runtime, participant) {
  const fileResult = result.result || (await readResult(runtime.resultPath));
  const normalized = normalizeResult(fileResult, participant);
  if (result.exitCode !== 0) {
    return {
      ...normalized,
      outcome: "failed",
      summaryMd: normalized.summaryMd || `Ceremony participant adapter exited with code ${result.exitCode}.`,
      riskMd: `${normalized.riskMd || ""}${result.stderr ? `\n${result.stderr.trim()}` : ""}`.trim(),
    };
  }
  return normalized;
}

async function readResult(filename) {
  try {
    const text = await readFile(filename, "utf8");
    return text.trim() ? JSON.parse(text) : null;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function normalizeResult(value, participant) {
  const result = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    outcome: typeof result.outcome === "string" ? result.outcome : "completed",
    summaryMd:
      typeof result.summaryMd === "string"
        ? result.summaryMd
        : `${participant.role} completed ceremony participation.`,
    questionsMd: typeof result.questionsMd === "string" ? result.questionsMd : "",
    riskMd: typeof result.riskMd === "string" ? result.riskMd : "",
    payload: result.payload && typeof result.payload === "object" && !Array.isArray(result.payload) ? result.payload : {},
  };
}
