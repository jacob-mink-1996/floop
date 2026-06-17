import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArtifactFilters, parseEventFilters, parseRunFilters, parseWorktreeFilters, respondMaybe } from "./shared.mjs";

const LIVE_LOG_TAIL_BYTES = 4096;
const LIVE_EVENT_LIMIT = 20;

export function handleFeedRoute(route, url, body, store) {
  switch (route.name) {
    case "runs":
      return respondMaybe(buildRunFeed(store, route.params.projectId, parseRunFilters(url)), "observability");
    case "worktrees":
      return {
        status: 200,
        body: { worktrees: store.listWorktrees(route.params.projectId, parseWorktreeFilters(url)) },
      };
    case "worktreeClean":
      return respondMaybe(
        store.cleanWorktree(route.params.projectId, route.params.worktreeId, body || {}),
        "worktree",
      );
    case "events":
      return {
        status: 200,
        body: { events: store.listEvents(route.params.projectId, parseEventFilters(url)) },
      };
    case "artifacts":
      return {
        status: 200,
        body: { artifacts: store.listArtifacts(route.params.projectId, parseArtifactFilters(url)) },
      };
    default:
      return null;
  }
}

function buildRunFeed(store, projectId, filters = {}) {
  const project = store.getProjectSummary(projectId);
  if (!project) {
    return null;
  }

  const limit = Number.isInteger(filters.limit) && filters.limit > 0 ? Math.min(filters.limit, 100) : 20;
  const executions = store.listProjectExecutions(projectId, { limit }) || [];
  const mergeRuns = store.listMergeRuns(projectId, { limit }) || [];
  const ceremonies = store.listCeremonyRuns(projectId) || [];
  const runs = [
    ...executions.map((execution) => executionRunItem(store, project, projectId, execution)),
    ...mergeRuns.map((run) => mergeRunItem(store, projectId, run)),
    ...ceremonies.map(ceremonyRunItem),
  ]
    .sort((left, right) => Date.parse(runSortDate(right)) - Date.parse(runSortDate(left)))
    .slice(0, limit);

  return {
    generatedAt: new Date().toISOString(),
    summary: summarizeRuns(runs),
    runs,
  };
}

function executionRunItem(store, project, projectId, execution) {
  const artifacts = execution.artifacts || [];
  const workLogArtifact = findArtifact(artifacts, "Agent work log");
  const agentWork = workLogArtifact?.metadata?.agentWork || {};
  const liveAgentLog = buildLiveAgentLog(project, execution);
  const movementReason = latestTicketMovementReason(store, projectId, execution.ticketId);
  return {
    id: `execution:${execution.id}`,
    runId: execution.id,
    kind: "execution",
    status: execution.status,
    outcome: execution.outcome || "",
    label: `${execution.ticketKey || "Ticket"} ${execution.role} iteration ${execution.iteration}`,
    summary: execution.summaryMd || execution.remainingWorkMd || execution.expectedNextEvidenceMd || "Execution is waiting for worker output.",
    ticketId: execution.ticketId,
    ticketKey: execution.ticketKey || "",
    ticketTitle: execution.ticketTitle || "",
    role: execution.role,
    failureKind: execution.failureKind || execution.blockedKind || "",
    claimStatus: claimStatus(execution),
    claimExpiresAt: execution.claimExpiresAt || "",
    retryAttemptCount: retryAttemptCount(execution.summaryMd),
    workLogArtifactUri: workLogArtifact?.uri || "",
    agentTraceSummary: typeof agentWork.summary === "string" ? agentWork.summary : "",
    agentProgressSignalCount: Number.isInteger(agentWork.progressSignalCount)
      ? agentWork.progressSignalCount
      : liveAgentLog.progressSignalCount,
    agentQuestionSignalCount: Number.isInteger(agentWork.questionSignalCount)
      ? agentWork.questionSignalCount
      : liveAgentLog.questionSignalCount,
    stdoutArtifactUri: findArtifactUri(artifacts, "stdout"),
    stderrArtifactUri: findArtifactUri(artifacts, "stderr"),
    liveAgentLog,
    worktreePaths: (execution.worktrees || []).map((worktree) => worktree.path).filter(Boolean),
    movementReason,
    startedAt: execution.startedAt,
    finishedAt: execution.finishedAt || "",
    artifactCount: artifacts.length,
    worktreeCount: execution.worktrees?.length || 0,
    needsAttention: execution.status === "needs_continue" || ["failed", "blocked"].includes(execution.outcome),
  };
}

function buildLiveAgentLog(project, execution) {
  const empty = {
    available: false,
    stdoutTail: "",
    stderrTail: "",
    agentEventsUri: "",
    stdoutUri: "",
    stderrUri: "",
    recentEvents: [],
    progressSignalCount: 0,
    questionSignalCount: 0,
    updatedAt: "",
  };
  if (!project?.workspaceRoot || !execution?.id || execution.finishedAt) {
    return empty;
  }

  const root = resolve(project.workspaceRoot, ".floop", "artifacts", "executions", execution.id);
  const stdoutPath = resolve(root, "stdout.log");
  const stderrPath = resolve(root, "stderr.log");
  const agentEventsPath = resolve(root, "agent-events.jsonl");
  const stdoutTail = readTail(stdoutPath);
  const stderrTail = readTail(stderrPath);
  const recentEvents = readRecentJsonl(agentEventsPath, LIVE_EVENT_LIMIT);
  const signalText = [
    stdoutTail,
    stderrTail,
    ...recentEvents.map((event) => (typeof event.text === "string" ? event.text : "")),
  ].join("\n");
  const updatedAt = latestMtime([stdoutPath, stderrPath, agentEventsPath]);
  const available = Boolean(stdoutTail || stderrTail || recentEvents.length > 0);

  return {
    available,
    stdoutTail,
    stderrTail,
    agentEventsUri: existsSync(agentEventsPath) ? pathToFileURL(agentEventsPath).href : "",
    stdoutUri: existsSync(stdoutPath) ? pathToFileURL(stdoutPath).href : "",
    stderrUri: existsSync(stderrPath) ? pathToFileURL(stderrPath).href : "",
    recentEvents,
    progressSignalCount: countProgressSignals(signalText),
    questionSignalCount: countQuestionSignals(signalText),
    updatedAt,
  };
}

function readTail(filename) {
  try {
    if (!existsSync(filename)) {
      return "";
    }
    const content = readFileSync(filename);
    return content.subarray(Math.max(0, content.length - LIVE_LOG_TAIL_BYTES)).toString("utf8");
  } catch {
    return "";
  }
}

function readRecentJsonl(filename, limit) {
  const text = readTail(filename);
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-limit)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { event: "parse_error", text: line };
      }
    });
}

function latestMtime(filenames) {
  const times = filenames
    .map((filename) => {
      try {
        return existsSync(filename) ? statSync(filename).mtimeMs : 0;
      } catch {
        return 0;
      }
    })
    .filter((value) => value > 0);
  if (times.length === 0) {
    return "";
  }
  return new Date(Math.max(...times)).toISOString();
}

function countProgressSignals(text) {
  return signalLines(text).filter((line) => isProgressSignal(line)).length;
}

function countQuestionSignals(text) {
  return signalLines(text).filter((line) => /\?|blocked|needs input|need input|clarify|question/i.test(line)).length;
}

function signalLines(text) {
  return String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function isProgressSignal(line) {
  return /\b(progress|working|implemented|created|updated|validated|reviewed|tested|passed|completed|wrote|added|fixed)\b/i.test(line);
}

function mergeRunItem(store, projectId, run) {
  const ticket = run.ticketId ? store.getTicket(projectId, run.ticketId) : null;
  const artifacts = run.artifacts || [];
  const movementReason = run.ticketId ? latestTicketMovementReason(store, projectId, run.ticketId) : null;
  return {
    id: `merge:${run.id}`,
    runId: run.id,
    kind: "merge",
    status: run.status,
    outcome: run.status,
    label: `${ticket?.key || "Ticket"} merge`,
    summary: run.summaryMd || "Merge run is waiting for worker output.",
    ticketId: run.ticketId,
    ticketKey: ticket?.key || "",
    ticketTitle: ticket?.title || "",
    role: "integrator",
    failureKind: run.failureKind || "",
    claimStatus: claimStatus(run),
    claimExpiresAt: run.claimExpiresAt || "",
    retryAttemptCount: retryAttemptCount(run.summaryMd),
    stdoutArtifactUri: findArtifactUri(artifacts, "stdout"),
    stderrArtifactUri: findArtifactUri(artifacts, "stderr"),
    worktreePaths: [],
    movementReason,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt || "",
    artifactCount: artifacts.length,
    worktreeCount: 0,
    needsAttention: ["blocked", "failed"].includes(run.status),
  };
}

function ceremonyRunItem(run) {
  const pendingProposals = run.proposals.filter((proposal) => proposal.status === "pending").length;
  const failedParticipants = run.participants.filter((participant) => ["failed", "blocked"].includes(participant.outcome)).length;
  return {
    id: `ceremony:${run.id}`,
    runId: run.id,
    kind: "ceremony",
    status: run.status,
    outcome: run.status,
    label: `${run.type} ceremony`,
    summary: run.summaryMd || "Ceremony has no summary yet.",
    ticketId: "",
    ticketKey: "",
    ticketTitle: "",
    role: run.deciderRole || "",
    failureKind: failedParticipants ? "participant_attention" : "",
    claimStatus: "not_applicable",
    claimExpiresAt: "",
    retryAttemptCount: 1,
    stdoutArtifactUri: "",
    stderrArtifactUri: "",
    worktreePaths: [],
    movementReason: null,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt || "",
    artifactCount: 0,
    worktreeCount: 0,
    needsAttention: pendingProposals > 0 || failedParticipants > 0,
    pendingProposalCount: pendingProposals,
    participantCount: run.participants.length,
  };
}

function summarizeRuns(runs) {
  return {
    total: runs.length,
    running: runs.filter((run) => run.status === "running").length,
    needsAttention: runs.filter((run) => run.needsAttention).length,
    failed: runs.filter((run) => ["failed", "blocked"].includes(run.outcome) || ["failed", "blocked"].includes(run.status)).length,
  };
}

function runSortDate(run) {
  return run.finishedAt || run.startedAt || "";
}

function claimStatus(run) {
  if (!run.claimed) {
    return "unclaimed";
  }
  if (!run.claimExpiresAt) {
    return "claimed";
  }
  const expiresAt = Date.parse(run.claimExpiresAt);
  if (Number.isFinite(expiresAt) && expiresAt < Date.now()) {
    return "expired";
  }
  return "claimed";
}

function retryAttemptCount(summary = "") {
  const match = String(summary || "").match(/Floop (?:completed|exhausted) after (\d+) attempt\(s\)/);
  const parsed = Number.parseInt(match?.[1] || match?.[2] || "1", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

function findArtifactUri(artifacts, stream) {
  const artifact = findArtifact(artifacts, stream);
  return artifact?.uri || "";
}

function findArtifact(artifacts, label) {
  const normalized = String(label || "").toLowerCase();
  return artifacts.find((item) => item.label?.toLowerCase().includes(normalized));
}

function latestTicketMovementReason(store, projectId, ticketId) {
  if (!ticketId) {
    return null;
  }
  const events = store.listEvents(projectId, { ticketId, order: "desc", limit: 12 }) || [];
  const event = events.find((candidate) => candidate.type === "ticket.transitioned") || events[0];
  if (!event) {
    return null;
  }
  return {
    eventId: event.id,
    type: event.type,
    summary: event.summary,
    detail: event.detail,
    reasonCode: event.reasonCode || "",
    reasonSource: event.reasonSource || "",
    createdAt: event.createdAt,
  };
}
