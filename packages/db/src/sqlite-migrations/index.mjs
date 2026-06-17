import { migration as projectPolicyControls } from "./001_project_policy_controls.mjs";
import { migration as ceremonyParticipants } from "./002_ceremony_participants.mjs";
import { migration as eventReasons } from "./003_event_reasons.mjs";
import { migration as executionClaims } from "./004_execution_claims.mjs";
import { migration as mergeRunClaimsAndFinishedAt } from "./005_merge_run_claims_and_finished_at.mjs";
import { migration as artifactMergeRunFk } from "./006_artifact_merge_run_fk.mjs";
import { migration as agentMessagesAndInteractionMode } from "./007_agent_messages_and_interaction_mode.mjs";
import { migration as demoEvidencePolicy } from "./008_demo_evidence_policy.mjs";
import { migration as executionHarnessSessions } from "./009_execution_harness_sessions.mjs";
import { migration as steeringWorktreePolicy } from "./010_steering_worktree_policy.mjs";

export const sqliteMigrations = [
  projectPolicyControls,
  ceremonyParticipants,
  eventReasons,
  executionClaims,
  mergeRunClaimsAndFinishedAt,
  artifactMergeRunFk,
  agentMessagesAndInteractionMode,
  demoEvidencePolicy,
  executionHarnessSessions,
  steeringWorktreePolicy,
];

for (let index = 0; index < sqliteMigrations.length; index += 1) {
  const expectedVersion = index + 1;
  const migration = sqliteMigrations[index];
  if (migration.version !== expectedVersion) {
    throw new Error(`SQLite migration order mismatch: expected ${expectedVersion}, got ${migration.version}`);
  }
}

export const latestSqliteMigrationVersion = sqliteMigrations.at(-1)?.version || 0;
