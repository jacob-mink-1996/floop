import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const includeCodex = args.has("--codex") || args.has("--require-codex");
const requireCodex = args.has("--require-codex");

const fixtureGates = [
  {
    id: "unit-store",
    command: ["node", "--test", "services/api/src/store.test.mjs"],
    proves: "ticket lifecycle, HITL, steering, demo evidence, merge rework, and context propagation store invariants",
  },
  {
    id: "unit-execution-driver",
    command: ["node", "--test", "services/api/src/execution-driver.test.mjs"],
    proves: "execution prompting, observability, agent logs, validation/demo evidence, HITL context, and Codex adapter behavior with fakes",
  },
  {
    id: "unit-ceremony-automation",
    command: ["node", "--test", "services/api/src/ceremony-automation-driver.test.mjs"],
    proves: "state-driven refinement, planning, check-in, demo prep, work generation, and retro triggers",
  },
  {
    id: "unit-ceremony-participant",
    command: ["node", "--test", "services/api/src/ceremony-participant-driver.test.mjs"],
    proves: "ceremony participant context, proposal generation, cleanup, split, and HITL handling",
  },
  {
    id: "unit-merge-driver",
    command: ["node", "--test", "services/api/src/merge-driver.test.mjs"],
    proves: "merge queue, retry, conflict, interrupted merge recovery, and merge artifact behavior",
  },
  {
    id: "ui-smoke",
    command: ["npm", "run", "check:ui"],
    proves: "board, ticket detail, conversation/HITL forms, constellation, settings, active work, and merge repair UI surfaces",
  },
  {
    id: "proof-review-rework-loop",
    command: ["npm", "run", "proof:review-rework-loop"],
    proves: "review rework returns to developer, validator produces demo evidence, and merge completes",
  },
  {
    id: "proof-big-work-fixture",
    command: ["npm", "run", "demo:big-work:fixture"],
    proves: "greenfield calendar idea reaches evidence-backed completion with lifecycle, HITL, review, validation, demo, merge, idle-cut, external input, and UI proof manifest gates",
  },
];

const codexGates = [
  {
    id: "proof-merge-rework-codex",
    command: ["npm", "run", "proof:merge-rework:codex"],
    proves: "authenticated Codex merge conflict repair, source execution lineage, integrator fallback, and final merge",
  },
  {
    id: "proof-big-work-codex",
    command: ["npm", "run", "demo:big-work:codex"],
    proves: "authenticated Codex full-loop calendar application proof with HITL, review, validation, demo evidence, merge, and manifest gates",
  },
];

const gates = includeCodex ? [...fixtureGates, ...codexGates] : fixtureGates;

if (dryRun) {
  printPlan(gates);
  process.exit(0);
}

if (includeCodex) {
  assertCodexAvailable();
}

const startedAt = Date.now();
const results = [];

for (const gate of gates) {
  const gateStartedAt = Date.now();
  console.log(`\n[mvp2] ${gate.id}`);
  console.log(`proves: ${gate.proves}`);
  console.log(`run: ${gate.command.join(" ")}`);

  const result = spawnSync(gate.command[0], gate.command.slice(1), {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
  const durationSeconds = Number(((Date.now() - gateStartedAt) / 1000).toFixed(3));
  results.push({ id: gate.id, status: result.status, durationSeconds });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`MVP 2.0 release gate failed: ${gate.id} exited with ${result.status}`);
  }
}

console.log("\nMVP 2.0 release verification passed");
console.log(`Mode: ${includeCodex ? "fixture + authenticated Codex" : "fixture"}`);
console.log(`Duration: ${Number(((Date.now() - startedAt) / 1000).toFixed(3))}s`);
for (const result of results) {
  console.log(`- ${result.id}: ${result.durationSeconds}s`);
}
if (!includeCodex) {
  console.log("");
  console.log("Authenticated Codex gates were not run.");
  console.log("Run `npm run verify:mvp2:codex` before declaring MVP 2.0 complete on an authenticated machine.");
}

function printPlan(planGates) {
  console.log("MVP 2.0 release verification plan");
  console.log(`Mode: ${includeCodex ? "fixture + authenticated Codex" : "fixture"}`);
  for (const gate of planGates) {
    console.log(`- ${gate.id}: ${gate.command.join(" ")}`);
    console.log(`  proves: ${gate.proves}`);
  }
  if (!includeCodex) {
    console.log("");
    console.log("Codex gates omitted. Add `--codex` or run `npm run verify:mvp2:codex` for authenticated proof.");
  }
}

function assertCodexAvailable() {
  const configuredCodex = process.env.FLOOP_BIG_WORK_CODEX_EXECUTABLE ||
    process.env.FLOOP_MERGE_REWORK_CODEX_EXECUTABLE ||
    "codex";
  const version = spawnSync(configuredCodex, ["--version"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (version.error || version.status !== 0) {
    const detail = version.error?.message || `${configuredCodex} --version exited with ${version.status}`;
    const suffix = requireCodex ? "MVP 2.0 authenticated verification cannot continue." : "Run fixture mode without `--codex` for local non-auth proof.";
    throw new Error(
      [
        "Authenticated Codex gates require a usable Codex CLI.",
        `Could not run ${JSON.stringify(configuredCodex)} --version: ${detail}`,
        "Install Codex, ensure it is on PATH, and run `codex login` for this user.",
        "Override with FLOOP_BIG_WORK_CODEX_EXECUTABLE=/path/to/codex if needed.",
        suffix,
      ].join("\n"),
    );
  }
  const codexHome = process.env.CODEX_HOME || resolve(process.env.HOME || "", ".codex");
  if (!existsSync(codexHome)) {
    console.warn(`[mvp2] warning: ${codexHome} does not exist; Codex gates may fail if the CLI is not logged in.`);
  }
}
