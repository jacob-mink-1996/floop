import assert from "node:assert/strict";
import test from "node:test";

import {
  BIG_WORK_IDLE_DEFINITION,
  buildFailureProofMetadata,
  buildKeepRanges,
  buildTrimMetadata,
  buildTrimSuggestion,
  shouldRetainDemoFixture,
} from "./record-big-work-demo-lib.mjs";

test("big-work recorder trim metadata audits strict idle cuts and kept transition windows", () => {
  const idleRanges = [
    {
      label: "FLOOP-1 developer active work",
      startSeconds: 40,
      endSeconds: 100,
    },
    {
      label: "FLOOP-1 reviewer active work",
      startSeconds: 120,
      endSeconds: 160,
    },
  ];
  const trimSuggestion = buildTrimSuggestion(idleRanges, 220);
  const metadata = buildTrimMetadata({
    recordingDurationSeconds: 220,
    idleRanges,
    trimSuggestion,
  });
  const keepRanges = buildKeepRanges(trimSuggestion, 220);

  assert.equal(metadata.rawDurationSeconds, 220);
  assert.equal(metadata.idleDefinition, BIG_WORK_IDLE_DEFINITION);
  assert.equal(metadata.idleRanges.length, 2);
  assert.equal(metadata.trimSuggestion.length > 0, true);
  assert.equal(metadata.keepRanges.length, keepRanges.length);
  assert.equal(metadata.trimmedDurationSeconds < metadata.rawDurationSeconds, true);
  assert.equal(metadata.cutSeconds, Number((metadata.rawDurationSeconds - metadata.trimmedDurationSeconds).toFixed(3)));
  assert.equal(
    metadata.trimSuggestion.every((range) =>
      range.label.includes("strict idle") &&
      range.removeToSeconds > range.removeFromSeconds
    ),
    true,
  );
  assert.equal(metadata.keepRanges[0].start, 0);
  assert.equal(metadata.keepRanges.at(-1).end, 220);
});

test("big-work recorder retains failed codex fixtures and describes failure proof", () => {
  assert.equal(shouldRetainDemoFixture({ completed: false, agentMode: "codex", keepFixture: false }), true);
  assert.equal(shouldRetainDemoFixture({ completed: true, agentMode: "codex", keepFixture: false }), false);
  assert.equal(shouldRetainDemoFixture({ completed: false, agentMode: "fixture", keepFixture: false }), false);
  assert.equal(shouldRetainDemoFixture({ completed: true, agentMode: "fixture", keepFixture: true }), true);

  const metadata = buildFailureProofMetadata({
    agentMode: "codex",
    mode: "record",
    fixtureRoot: "/tmp/floop-fixture",
    targetRepoPath: "/tmp/floop-fixture/calendar-app",
    error: "adapter failed",
    partialProof: { agentConversations: [{ executionId: "execution_1" }] },
  });

  assert.equal(metadata.status, "failed");
  assert.equal(metadata.retainedFixture, true);
  assert.equal(metadata.fixtureRoot, "/tmp/floop-fixture");
  assert.equal(metadata.targetRepoPath, "/tmp/floop-fixture/calendar-app");
  assert.equal(metadata.error, "adapter failed");
  assert.equal(metadata.partialProof.agentConversations[0].executionId, "execution_1");
});
