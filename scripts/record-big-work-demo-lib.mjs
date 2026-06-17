export const BIG_WORK_IDLE_DEFINITION =
  "Idle is any time without an obvious ticket transition or screen work; background agent work is trimmed unless a visible state change is happening.";

const IDLE_CUT_BUFFER_SECONDS = 0.25;
const IDLE_CUT_MERGE_GAP_SECONDS = 1.5;
const MIN_IDLE_CUT_SECONDS = 0.5;
const INTRO_KEEP_SECONDS = 12;
const FINAL_KEEP_SECONDS = 8;
const TRANSITION_PRE_SECONDS = 1;
const TRANSITION_START_POST_SECONDS = 1.25;
const TRANSITION_END_PRE_SECONDS = 1;
const TRANSITION_END_POST_SECONDS = 1.25;

export function buildTrimSuggestion(idleRanges, recordingDurationSeconds = 0) {
  const keepRanges = buildVisibleTransitionKeepRanges(idleRanges, recordingDurationSeconds);
  const cuts = [];
  let cursor = 0;
  for (const range of keepRanges) {
    if (range.start - cursor >= MIN_IDLE_CUT_SECONDS) {
      cuts.push({
        labels: ["strict idle: no visible ticket transition or screen work"],
        removeFromSeconds: Number(cursor.toFixed(3)),
        removeToSeconds: Number(range.start.toFixed(3)),
      });
    }
    cursor = Math.max(cursor, range.end);
  }
  if (Number.isFinite(recordingDurationSeconds) && recordingDurationSeconds - cursor >= MIN_IDLE_CUT_SECONDS) {
    cuts.push({
      labels: ["strict idle: no visible ticket transition or screen work"],
      removeFromSeconds: Number(cursor.toFixed(3)),
      removeToSeconds: Number(recordingDurationSeconds.toFixed(3)),
    });
  }

  return mergeTrimCuts(cuts).map((range) => ({
    label: range.labels.join(" + "),
    removeFromSeconds: Number(range.removeFromSeconds.toFixed(3)),
    removeToSeconds: Number(range.removeToSeconds.toFixed(3)),
  }));
}

export function buildVisibleTransitionKeepRanges(idleRanges, recordingDurationSeconds = 0) {
  const boundedDuration = Number.isFinite(recordingDurationSeconds) && recordingDurationSeconds > 0
    ? recordingDurationSeconds
    : Number.POSITIVE_INFINITY;
  const keepRanges = [];
  const push = (start, end) => {
    const bounded = {
      start: Number(Math.max(0, start).toFixed(3)),
      end: Number(Math.min(boundedDuration, end).toFixed(3)),
    };
    if (bounded.end - bounded.start >= MIN_IDLE_CUT_SECONDS) {
      keepRanges.push(bounded);
    }
  };

  push(0, INTRO_KEEP_SECONDS);
  for (const range of idleRanges) {
    push(range.startSeconds - TRANSITION_PRE_SECONDS, range.startSeconds + TRANSITION_START_POST_SECONDS);
    push(range.endSeconds - TRANSITION_END_PRE_SECONDS, range.endSeconds + TRANSITION_END_POST_SECONDS);
  }
  if (Number.isFinite(boundedDuration)) {
    push(boundedDuration - FINAL_KEEP_SECONDS, boundedDuration);
  }

  return mergeKeepRanges(keepRanges);
}

export function buildKeepRanges(trimSuggestion, recordingDurationSeconds) {
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
    if (start - cursor > IDLE_CUT_BUFFER_SECONDS) {
      keepRanges.push({ start: cursor, end: start });
    }
    cursor = Math.max(cursor, end);
  }
  if (!Number.isFinite(recordingDurationSeconds) || recordingDurationSeconds <= cursor + IDLE_CUT_BUFFER_SECONDS) {
    keepRanges.push({ start: cursor, end: Number.POSITIVE_INFINITY });
  } else {
    keepRanges.push({ start: cursor, end: recordingDurationSeconds });
  }
  return keepRanges.filter((range) => !Number.isFinite(range.end) || range.end - range.start > IDLE_CUT_BUFFER_SECONDS);
}

export function buildTrimMetadata({ recordingDurationSeconds, idleRanges = [], trimSuggestion = [] }) {
  const keepRanges = buildKeepRanges(trimSuggestion, recordingDurationSeconds);
  const finiteKeepSeconds = keepRanges
    .filter((range) => Number.isFinite(range.end))
    .reduce((total, range) => total + range.end - range.start, 0);
  const trimmedDurationSeconds = Number.isFinite(recordingDurationSeconds)
    ? Number(finiteKeepSeconds.toFixed(3))
    : 0;

  return {
    rawDurationSeconds: Number(Number(recordingDurationSeconds || 0).toFixed(3)),
    trimmedDurationSeconds,
    cutSeconds: Number(Math.max(0, Number(recordingDurationSeconds || 0) - trimmedDurationSeconds).toFixed(3)),
    idleDefinition: BIG_WORK_IDLE_DEFINITION,
    idleRanges,
    trimSuggestion,
    keepRanges: keepRanges.map((range) => ({
      start: Number(range.start.toFixed(3)),
      end: Number.isFinite(range.end) ? Number(range.end.toFixed(3)) : null,
    })),
  };
}

export function shouldRetainDemoFixture({ completed, agentMode, keepFixture }) {
  return keepFixture === true || (!completed && agentMode === "codex");
}

export function buildFailureProofMetadata({
  agentMode,
  mode,
  fixtureRoot,
  targetRepoPath,
  error = "",
  partialProof = null,
}) {
  return {
    status: "failed",
    agentMode,
    mode,
    fixtureRoot,
    targetRepoPath,
    error: String(error || ""),
    retainedFixture: shouldRetainDemoFixture({ completed: false, agentMode, keepFixture: false }),
    partialProof,
  };
}

function mergeKeepRanges(keepRanges) {
  const merged = [];
  for (const range of keepRanges.sort((left, right) => left.start - right.start)) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + IDLE_CUT_BUFFER_SECONDS) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function mergeTrimCuts(cuts) {
  const sorted = cuts
    .filter((range) => range.removeToSeconds - range.removeFromSeconds >= MIN_IDLE_CUT_SECONDS)
    .sort((left, right) => left.removeFromSeconds - right.removeFromSeconds);
  const merged = [];
  for (const cut of sorted) {
    const previous = merged.at(-1);
    if (previous && cut.removeFromSeconds - previous.removeToSeconds <= IDLE_CUT_MERGE_GAP_SECONDS) {
      previous.removeToSeconds = Math.max(previous.removeToSeconds, cut.removeToSeconds);
      previous.labels.push(...cut.labels);
    } else {
      merged.push({ ...cut });
    }
  }
  return merged;
}
