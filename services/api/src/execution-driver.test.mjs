import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createExecutionDriver } from "./execution-driver.mjs";
import { createStore } from "./store.mjs";

test("execution driver runs configured adapter commands and persists completion evidence", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "floop-driver-"));
  const workspaceRoot = join(fixtureDir, "workspace");
  const store = createStore({
    filename: join(fixtureDir, "floop.sqlite"),
    seedDemo: true,
    workspaceRoot,
  });

  try {
    store.updateRoleProfile("project_floop", "developer", {
      adapter: "shell",
      model: "fixture",
      config: {
        command: `"${process.execPath}" -e "const fs=require('node:fs'); fs.writeFileSync(process.env.FLOOP_RESULT_PATH, JSON.stringify({ outcome: 'completed', summaryMd: 'Driver landed the ticket.' })); console.log('driver stdout ok')"`,
      },
    });

    const execution = store.createExecution("project_floop", "ticket_project_floop_2", {
      role: "developer",
      reason: "Run through the background driver.",
    });
    const driver = createExecutionDriver({ store, logger: silentLogger() });

    await driver.pollOnce();

    const completed = store.getExecution("project_floop", execution.id);
    const ticket = store.getTicket("project_floop", "ticket_project_floop_2");
    const stdoutArtifact = completed.artifacts.find((artifact) => artifact.label === "Adapter stdout");
    const workLogArtifact = completed.artifacts.find((artifact) => artifact.label === "Agent work log");

    assert.equal(completed.outcome, "completed");
    assert.equal(completed.ticketState, "REVIEWING");
    assert.equal(ticket.state, "REVIEWING");
    assert.equal(existsSync(execution.worktrees[0].path), true);
    assert.ok(stdoutArtifact);
    assert.ok(workLogArtifact);
    assert.match(readFileSync(new URL(stdoutArtifact.uri), "utf8"), /driver stdout ok/);
    assert.match(readFileSync(new URL(workLogArtifact.uri), "utf8"), /Progress signals:/);
    assert.equal(workLogArtifact.metadata.agentWork.questionSignalCount, 0);
    assert.equal(stdoutArtifact.metadata.floopDurability.storageMode, "managed_local_file");
    assert.equal(stdoutArtifact.metadata.floopDurability.cleanupPolicy, "retain_until_project_delete");
  } finally {
    store.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("execution driver can launch the codex adapter path and persist the final agent message", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "floop-codex-driver-"));
  const workspaceRoot = join(fixtureDir, "workspace");
  const fakeCodexPath = join(fixtureDir, "fake-codex.js");
  const store = createStore({
    filename: join(fixtureDir, "floop.sqlite"),
    seedDemo: true,
    workspaceRoot,
  });

  writeFileSync(
    fakeCodexPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("-a")) {
  process.stderr.write("obsolete approval flag used\\n");
  process.exit(2);
}
if (!process.argv.includes('-c') || !process.argv.includes('approval_policy="never"')) {
  process.stderr.write("missing approval policy config override\\n");
  process.exit(2);
}
if (!process.argv.includes("--ignore-user-config")) {
  process.stderr.write("missing ignore-user-config flag\\n");
  process.exit(2);
}
const modelIndex = process.argv.indexOf("-m");
if (modelIndex >= 0 && process.argv[modelIndex + 1] === "codex-latest") {
  process.stderr.write("legacy codex-latest model was passed explicitly\\n");
  process.exit(2);
}
const outputIndex = process.argv.indexOf("-o");
const outputFile = outputIndex >= 0 ? process.argv[outputIndex + 1] : "";
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});
process.stdin.on("end", () => {
  fs.writeFileSync(
    process.env.FLOOP_RESULT_PATH,
    JSON.stringify({
      outcome: "completed",
      summaryMd: prompt.includes(process.env.FLOOP_TICKET_KEY)
        ? "Codex adapter completed the ticket."
        : "Prompt missing ticket key.",
    }),
  );
  if (outputFile) {
    fs.writeFileSync(outputFile, "Final agent message from fake codex.");
  }
  process.stdout.write("fake codex stdout\\n");
});
`,
    { encoding: "utf8", mode: 0o755 },
  );

  try {
    store.updateRoleProfile("project_floop", "developer", {
      adapter: "codex",
      model: "codex-latest",
      config: {
        executable: fakeCodexPath,
        ignoreUserConfig: true,
        promptPreamble: "Focus on the Floop governed loop.",
      },
    });

    const execution = store.createExecution("project_floop", "ticket_project_floop_2", {
      role: "developer",
      reason: "Run through the codex adapter path.",
    });
    const driver = createExecutionDriver({ store, logger: silentLogger() });

    await driver.pollOnce();

    const completed = store.getExecution("project_floop", execution.id);
    const ticket = store.getTicket("project_floop", "ticket_project_floop_2");
    const finalMessageArtifact = completed.artifacts.find((artifact) => artifact.label === "Agent final message");
    const stdoutArtifact = completed.artifacts.find((artifact) => artifact.label === "Adapter stdout");
    const promptPath = join(workspaceRoot, ".floop", "executions", execution.id, "prompt.md");

    assert.equal(completed.outcome, "completed");
    assert.equal(completed.summaryMd, "Codex adapter completed the ticket.");
    assert.equal(completed.ticketState, "REVIEWING");
    assert.equal(ticket.state, "REVIEWING");
    assert.ok(finalMessageArtifact);
    assert.ok(stdoutArtifact);
    assert.match(readFileSync(new URL(finalMessageArtifact.uri), "utf8"), /Final agent message/);
    assert.match(readFileSync(new URL(stdoutArtifact.uri), "utf8"), /fake codex stdout/);
    assert.match(readFileSync(promptPath, "utf8"), /Refinement policy: user approved/);
    assert.match(readFileSync(promptPath, "utf8"), /Use bounded commands only/);
  } finally {
    store.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("execution driver fails successful adapters that omit result JSON", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "floop-codex-missing-result-"));
  const workspaceRoot = join(fixtureDir, "workspace");
  const fakeCodexPath = join(fixtureDir, "fake-missing-result-codex.js");
  const store = createStore({
    filename: join(fixtureDir, "floop.sqlite"),
    seedDemo: true,
    workspaceRoot,
  });

  writeFileSync(
    fakeCodexPath,
    `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write("finished without result json\\n");
});
`,
    { encoding: "utf8", mode: 0o755 },
  );

  try {
    store.updateProjectPolicy("project_floop", {
      interactionMode: "autonomous_with_review",
    });
    store.updateRoleProfile("project_floop", "developer", {
      adapter: "codex",
      model: "codex-latest",
      config: {
        executable: fakeCodexPath,
      },
    });

    const execution = store.createExecution("project_floop", "ticket_project_floop_2", {
      role: "developer",
      reason: "Run a malformed adapter completion.",
    });
    const driver = createExecutionDriver({ store, logger: silentLogger() });

    await driver.pollOnce();

    const completed = store.getExecution("project_floop", execution.id);
    const ticket = store.getTicket("project_floop", "ticket_project_floop_2");

    assert.equal(completed.outcome, "failed");
    assert.equal(completed.failureKind, "missing_result_json");
    assert.match(completed.summaryMd, /did not write the required result JSON/);
    assert.equal(ticket.state, "WORKING");
    assert.equal(ticket.executions.some((item) => item.role === "reviewer"), false);
  } finally {
    store.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("execution driver resolves codex follow-up repo slugs to repo ids", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "floop-codex-followup-driver-"));
  const workspaceRoot = join(fixtureDir, "workspace");
  const fakeCodexPath = join(fixtureDir, "fake-followup-codex.js");
  const store = createStore({
    filename: join(fixtureDir, "floop.sqlite"),
    seedDemo: true,
    workspaceRoot,
  });

  writeFileSync(
    fakeCodexPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
process.stdin.resume();
process.stdin.on("end", () => {
  fs.writeFileSync(
    process.env.FLOOP_RESULT_PATH,
    JSON.stringify({
      outcome: "followup_created",
      summaryMd: "Created follow-up from fake codex.",
      followupTickets: [
        {
          title: "Implement child from slug",
          brief: "Uses repoSlug instead of repoId.",
          assignedRole: "developer",
          repoTargets: [
            {
              repoSlug: "floop",
              baseRef: "main",
              branchName: "child-from-slug",
              targetScopeMd: "Child implementation."
            }
          ]
        },
        {
          title: "Implement child from string target",
          brief: "Uses a bare repo slug string.",
          assignedRole: "developer",
          repoTargets: ["floop"]
        }
      ]
    }),
  );
});
`,
    { encoding: "utf8", mode: 0o755 },
  );

  try {
    const repo = store.listRepos("project_floop")[0];
    const parent = store.createTicket("project_floop", {
      title: "Parent follow-up by slug",
      brief: "Codex should be able to refer to the repo by slug.",
      assignedRole: "product_manager",
      state: "READY",
      repoTargets: [{ repoId: repo.id, baseRef: "main", branchName: "parent-followup-by-slug" }],
    });
    store.updateRoleProfile("project_floop", "product_manager", {
      adapter: "codex",
      model: "codex-latest",
      config: {
        executable: fakeCodexPath,
      },
    });
    store.updateProjectPolicy("project_floop", {
      refinementMode: "autonomous",
      agentCreatedTicketDefaultState: "READY",
    });

    const execution = store.createExecution("project_floop", parent.id, {
      role: "product_manager",
      reason: "Create child follow-up tickets.",
    });
    const driver = createExecutionDriver({ store, logger: silentLogger() });

    await driver.pollOnce();

    const completed = store.getExecution("project_floop", execution.id);
    const childSummaries = store.listTickets("project_floop", { parentTicketId: parent.id });
    const child = store.getTicket(
      "project_floop",
      childSummaries.find((summary) => summary.title === "Implement child from slug").id,
    );
    const stringTargetChild = store.getTicket(
      "project_floop",
      childSummaries.find((summary) => summary.title === "Implement child from string target").id,
    );

    assert.equal(completed.outcome, "followup_created");
    assert.equal(child.title, "Implement child from slug");
    assert.equal(child.repoTargets.length, 1);
    assert.equal(child.repoTargets[0].repoId, repo.id);
    assert.equal(child.repoTargets[0].branchName, "child-from-slug");
    assert.equal(stringTargetChild.repoTargets.length, 1);
    assert.equal(stringTargetChild.repoTargets[0].repoId, repo.id);
    assert.equal(stringTargetChild.repoTargets[0].baseRef, parent.repoTargets[0].baseRef);
  } finally {
    store.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("execution driver tells architect lanes not to create follow-up tickets by default", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "floop-architect-codex-driver-"));
  const workspaceRoot = join(fixtureDir, "workspace");
  const fakeCodexPath = join(fixtureDir, "fake-architect-codex.js");
  const store = createStore({
    filename: join(fixtureDir, "floop.sqlite"),
    seedDemo: true,
    workspaceRoot,
  });

  writeFileSync(
    fakeCodexPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});
process.stdin.on("end", () => {
  fs.writeFileSync(process.env.FLOOP_RESULT_PATH, JSON.stringify({
    outcome: "completed",
    summaryMd: prompt.includes("Do not create follow-up tickets") ? "Architect guidance present." : "Architect guidance missing."
  }));
});
`,
    { encoding: "utf8", mode: 0o755 },
  );

  try {
    store.updateRoleProfile("project_floop", "architect", {
      adapter: "codex",
      model: "codex-latest",
      config: {
        executable: fakeCodexPath,
      },
    });

    const execution = store.createExecution("project_floop", "ticket_project_floop_2", {
      role: "architect",
      reason: "Prepare architecture guidance.",
    });
    const driver = createExecutionDriver({ store, logger: silentLogger() });

    await driver.pollOnce();

    const completed = store.getExecution("project_floop", execution.id);
    const promptPath = join(workspaceRoot, ".floop", "executions", execution.id, "prompt.md");

    assert.equal(completed.outcome, "completed");
    assert.match(completed.summaryMd, /Architect guidance present/);
    assert.match(readFileSync(promptPath, "utf8"), /Do not create follow-up tickets/);
    assert.match(readFileSync(promptPath, "utf8"), /unless the ticket explicitly asks/);
  } finally {
    store.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("execution driver can persist embedded review evidence from the codex reviewer lane", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "floop-reviewer-codex-driver-"));
  const workspaceRoot = join(fixtureDir, "workspace");
  const fakeCodexPath = join(fixtureDir, "fake-reviewer-codex.js");
  const store = createStore({
    filename: join(fixtureDir, "floop.sqlite"),
    seedDemo: true,
    workspaceRoot,
  });

  writeFileSync(
    fakeCodexPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const outputIndex = process.argv.indexOf("-o");
const outputFile = outputIndex >= 0 ? process.argv[outputIndex + 1] : "";
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});
process.stdin.on("end", () => {
  fs.writeFileSync(
    process.env.FLOOP_RESULT_PATH,
    JSON.stringify({
      outcome: "completed",
      summaryMd: "Reviewer execution completed.",
      review: {
        verdict: "passed",
        summaryMd: "No blocking issues found.",
        findings: [],
        artifacts: [{ kind: "report", label: "Reviewer notes", uri: "file:///tmp/reviewer-notes.md" }]
      }
    }),
  );
  if (outputFile) {
    fs.writeFileSync(outputFile, "Reviewer final message from fake codex.");
  }
  process.stdout.write(prompt.includes("review.verdict") ? "review contract present\\n" : "review contract missing\\n");
});
`,
    { encoding: "utf8", mode: 0o755 },
  );

  try {
    store.updateProjectPolicy("project_floop", {
      interactionMode: "autonomous_with_review",
    });
    store.updateRoleProfile("project_floop", "reviewer", {
      adapter: "codex",
      model: "codex-latest",
      config: {
        executable: fakeCodexPath,
      },
    });

    const implementation = store.createExecution("project_floop", "ticket_project_floop_2", {
      role: "developer",
      reason: "Finish implementation before reviewer lane.",
    });
    store.completeExecution("project_floop", implementation.id, {
      outcome: "completed",
      summaryMd: "Implementation completed for reviewer test.",
    });

    const reviewerExecution = store
      .getTicket("project_floop", "ticket_project_floop_2")
      .executions.find((execution) => execution.role === "reviewer");
    assert.ok(reviewerExecution);

    const driver = createExecutionDriver({ store, logger: silentLogger() });
    await driver.pollOnce();

    const ticket = store.getTicket("project_floop", "ticket_project_floop_2");
    const completed = store.getExecution("project_floop", reviewerExecution.id);
    const stdoutArtifact = completed.artifacts.find((artifact) => artifact.label === "Adapter stdout");
    const promptPath = join(workspaceRoot, ".floop", "executions", reviewerExecution.id, "prompt.md");

    assert.equal(completed.outcome, "completed");
    assert.equal(ticket.reviews.length, 1);
    assert.equal(ticket.reviews[0].verdict, "passed");
    assert.equal(ticket.reviews[0].artifacts[0].label, "Reviewer notes");
    assert.match(readFileSync(new URL(stdoutArtifact.uri), "utf8"), /review contract present/);
    assert.match(readFileSync(promptPath, "utf8"), /Review plan, Evidence inspected, Findings, and Decision/);
    assert.match(readFileSync(promptPath, "utf8"), /review\.verdict: one of passed, rework, blocked/);
  } finally {
    store.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("execution driver can persist embedded validation evidence from the validator lane", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "floop-validator-driver-"));
  const workspaceRoot = join(fixtureDir, "workspace");
  const fakeCodexPath = join(fixtureDir, "fake-validator-codex.js");
  const store = createStore({
    filename: join(fixtureDir, "floop.sqlite"),
    seedDemo: true,
    workspaceRoot,
  });

  writeFileSync(
    fakeCodexPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});
process.stdin.on("end", () => {
  fs.writeFileSync(
    process.env.FLOOP_RESULT_PATH,
    JSON.stringify({
      outcome: "completed",
      summaryMd: "Validator execution completed.",
      validation: {
        verdict: "passed",
        summaryMd: "Validation plan: run the project test command. Checks run: npm test. Why sufficient: covers the ticket behavior. Result: passed.",
        commandProfile: "ci",
        commands: ["npm test"],
        repoIds: ["repo_project_floop_floop"],
        artifacts: [{ kind: "log", label: "Validation output", uri: "file:///tmp/validation-output.log" }]
      }
    }),
  );
  process.stdout.write(prompt.includes("Validation plan") ? "validation guidance present\\n" : "validation guidance missing\\n");
});
`,
    { encoding: "utf8", mode: 0o755 },
  );

  try {
    store.updateProjectPolicy("project_floop", {
      requireReviewer: false,
      requireValidator: true,
      requireDemoEvidenceBeforeMerge: true,
      requiredValidationCommandProfileForMerge: "ci",
      interactionMode: "autonomous_with_review",
    });
    store.updateRoleProfile("project_floop", "validator", {
      adapter: "codex",
      model: "codex-latest",
      config: {
        executable: fakeCodexPath,
      },
    });

    const implementation = store.createExecution("project_floop", "ticket_project_floop_2", {
      role: "developer",
      reason: "Finish implementation before validator lane.",
    });
    store.completeExecution("project_floop", implementation.id, {
      outcome: "completed",
      summaryMd: "Implementation completed for validator test.",
    });

    const validatorExecution = store
      .getTicket("project_floop", "ticket_project_floop_2")
      .executions.find((execution) => execution.role === "validator");
    assert.ok(validatorExecution);

    const driver = createExecutionDriver({ store, logger: silentLogger() });
    await driver.pollOnce();

    const ticket = store.getTicket("project_floop", "ticket_project_floop_2");
    const completed = store.getExecution("project_floop", validatorExecution.id);
    const stdoutArtifact = completed.artifacts.find((artifact) => artifact.label === "Adapter stdout");
    const promptPath = join(workspaceRoot, ".floop", "executions", validatorExecution.id, "prompt.md");

    assert.equal(completed.outcome, "completed");
    assert.equal(ticket.validations.length, 1);
    assert.equal(ticket.validations[0].verdict, "passed");
    assert.deepEqual(ticket.validations[0].commands, ["npm test"]);
    assert.equal(ticket.validations[0].artifacts[0].label, "Validation output");
    assert.equal(ticket.state, "READY_TO_MERGE");
    assert.match(readFileSync(new URL(stdoutArtifact.uri), "utf8"), /validation guidance present/);
    assert.match(readFileSync(promptPath, "utf8"), /Choose the validation strategy from the ticket brief/);
    assert.match(readFileSync(promptPath, "utf8"), /Validation plan, Checks run, Why sufficient, and Result/);
    assert.match(readFileSync(promptPath, "utf8"), /This project requires demo evidence before merge/);
    assert.match(readFileSync(promptPath, "utf8"), /metadata\.demoEvidence true/);
    assert.match(readFileSync(promptPath, "utf8"), /set validation\.commandProfile to "ci"/);
  } finally {
    store.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("execution driver recovers hyphenated git metadata read-only blocked completions", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "floop-git-metadata-recovery-"));
  const workspaceRoot = join(fixtureDir, "workspace");
  const repoRoot = join(fixtureDir, "repo");
  const fakeCodexPath = join(fixtureDir, "fake-blocked-codex.js");
  const store = createStore({
    filename: join(fixtureDir, "floop.sqlite"),
    seedDemo: true,
    workspaceRoot,
  });

  writeFileSync(
    fakeCodexPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync("RECOVERED.md", "# Recovered work\\n", "utf8");
process.stdin.resume();
process.stdin.on("end", () => {
  fs.writeFileSync(process.env.FLOOP_RESULT_PATH, JSON.stringify({
    outcome: "blocked",
    blockedKind: "git-metadata-readonly",
    summaryMd: "Work is present but the agent could not write git metadata."
  }));
});
`,
    { encoding: "utf8", mode: 0o755 },
  );

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
    });
    store.updateRoleProfile("project_floop", "developer", {
      adapter: "codex",
      model: "codex-latest",
      config: {
        executable: fakeCodexPath,
      },
    });

    const execution = store.createExecution("project_floop", "ticket_project_floop_2", {
      role: "developer",
      reason: "Recover git metadata blocked work.",
    });
    const driver = createExecutionDriver({ store, logger: silentLogger() });

    await driver.pollOnce();

    const completed = store.getExecution("project_floop", execution.id);
    const ticket = store.getTicket("project_floop", "ticket_project_floop_2");
    assert.equal(completed.outcome, "completed");
    assert.equal(completed.blockedKind, "");
    assert.equal(ticket.state, "READY_TO_MERGE");
    assert.match(completed.summaryMd, /Floop recovered/);
  } finally {
    store.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("execution driver recovers passed validator evidence from git metadata needs-continue completions", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "floop-validator-git-metadata-recovery-"));
  const workspaceRoot = join(fixtureDir, "workspace");
  const repoRoot = join(fixtureDir, "repo");
  const fakeCodexPath = join(fixtureDir, "fake-validator-needs-continue-codex.js");
  const store = createStore({
    filename: join(fixtureDir, "floop.sqlite"),
    seedDemo: true,
    workspaceRoot,
  });

  writeFileSync(
    fakeCodexPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.mkdirSync("artifacts", { recursive: true });
fs.writeFileSync("artifacts/validator-validation.json", JSON.stringify({ demoEvidence: true }) + "\\n", "utf8");
process.stdin.resume();
process.stdin.on("end", () => {
  fs.writeFileSync(process.env.FLOOP_RESULT_PATH, JSON.stringify({
    outcome: "needs_continue",
    summaryMd: "Validation passed, but the lane could not create the requested Git commit because the linked worktree Git metadata is mounted read-only while creating index.lock.",
    remainingWorkMd: "Commit artifacts/validator-validation.json from an environment with writable Git metadata.",
    expectedNextEvidenceMd: "A Git commit containing the validator evidence artifact.",
    validation: {
      verdict: "passed",
      summaryMd: "Validation passed; only the Git metadata commit step was blocked.",
      commandProfile: "ci",
      commands: ["npm test"],
      repoIds: ["repo_project_floop_floop"],
      artifacts: [{
        kind: "demo",
        label: "Validator demo evidence",
        uri: "artifacts/validator-validation.json",
        metadata: { demoEvidence: true, commandProfile: "ci" }
      }]
    }
  }));
});
`,
    { encoding: "utf8", mode: 0o755 },
  );

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
    store.updateTicket("project_floop", "ticket_project_floop_2", {
      repoTargets: [{ repoId: "repo_project_floop_floop", baseRef: "main", branchName: "main" }],
    });
    store.updateProjectPolicy("project_floop", {
      requireReviewer: false,
      requireValidator: true,
      requireDemoEvidenceBeforeMerge: true,
      requiredValidationCommandProfileForMerge: "ci",
    });
    store.updateRoleProfile("project_floop", "validator", {
      adapter: "codex",
      model: "codex-latest",
      config: {
        executable: fakeCodexPath,
      },
    });

    const implementation = store.createExecution("project_floop", "ticket_project_floop_2", {
      role: "developer",
      reason: "Finish implementation before validator recovery.",
    });
    store.completeExecution("project_floop", implementation.id, {
      outcome: "completed",
      summaryMd: "Implementation completed before validation.",
    });
    const validatorExecution = store.createExecution("project_floop", "ticket_project_floop_2", {
      role: "validator",
      reason: "Recover passed validation evidence after Git metadata lock failure.",
    });

    const driver = createExecutionDriver({ store, logger: silentLogger() });
    await driver.pollOnce();

    const completed = store.getExecution("project_floop", validatorExecution.id);
    const ticket = store.getTicket("project_floop", "ticket_project_floop_2");
    assert.equal(completed.outcome, "completed");
    assert.equal(ticket.validations.length, 1);
    assert.equal(ticket.validations[0].verdict, "passed");
    assert.equal(ticket.state, "READY_TO_MERGE");
    assert.match(completed.summaryMd, /Floop recovered/);
    assert.match(execFileSync("git", ["-C", repoRoot, "log", "--oneline", "--all"], { encoding: "utf8" }), /FLOOP-2/);
  } finally {
    store.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("execution driver materializes a real git worktree when the target repo exists", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "floop-git-worktree-"));
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
    store.updateRoleProfile("project_floop", "developer", {
      adapter: "shell",
      model: "fixture",
      config: {
        command: `"${process.execPath}" -e "const fs=require('node:fs'); fs.writeFileSync(process.env.FLOOP_RESULT_PATH, JSON.stringify({ outcome: 'completed', summaryMd: 'Git-backed worktree executed.' }));"`,
      },
    });

    const execution = store.createExecution("project_floop", "ticket_project_floop_2", {
      role: "developer",
      reason: "Verify git-backed worktree materialization.",
    });
    const driver = createExecutionDriver({ store, logger: silentLogger() });

    await driver.pollOnce();

    assert.equal(existsSync(join(execution.worktrees[0].path, "README.md")), true);
    assert.equal(existsSync(join(execution.worktrees[0].path, ".git")), true);
  } finally {
    store.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("execution driver rematerializes stale git worktrees when branch metadata no longer matches", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "floop-git-worktree-refresh-"));
  const workspaceRoot = join(fixtureDir, "workspace");
  const repoRoot = join(fixtureDir, "repo");
  const staleRepoRoot = join(fixtureDir, "stale-repo");
  const store = createStore({
    filename: join(fixtureDir, "floop.sqlite"),
    seedDemo: true,
    workspaceRoot,
  });

  try {
    execFileSync("git", ["init", "-b", "main", repoRoot]);
    execFileSync("git", ["-C", repoRoot, "config", "user.name", "Floop Test"]);
    execFileSync("git", ["-C", repoRoot, "config", "user.email", "floop@example.com"]);
    writeFileSync(join(repoRoot, "README.md"), "# Fresh Repo\n", "utf8");
    execFileSync("git", ["-C", repoRoot, "add", "README.md"]);
    execFileSync("git", ["-C", repoRoot, "commit", "-m", "seed repo"]);

    execFileSync("git", ["init", "-b", "main", staleRepoRoot]);
    execFileSync("git", ["-C", staleRepoRoot, "config", "user.name", "Floop Test"]);
    execFileSync("git", ["-C", staleRepoRoot, "config", "user.email", "floop@example.com"]);
    writeFileSync(join(staleRepoRoot, "stale.txt"), "stale\n", "utf8");
    execFileSync("git", ["-C", staleRepoRoot, "add", "stale.txt"]);
    execFileSync("git", ["-C", staleRepoRoot, "commit", "-m", "seed stale repo"]);

    store.updateRepo("project_floop", "repo_project_floop_floop", {
      name: "floop",
      localPath: repoRoot,
      remoteUrl: "",
      defaultBranch: "main",
      isPrimary: true,
    });
    store.updateRoleProfile("project_floop", "developer", {
      adapter: "shell",
      model: "fixture",
      config: {
        command: `"${process.execPath}" -e "const fs=require('node:fs'); fs.writeFileSync(process.env.FLOOP_RESULT_PATH, JSON.stringify({ outcome: 'completed', summaryMd: 'Git-backed worktree refreshed.' }));"`,
      },
    });

    const execution = store.createExecution("project_floop", "ticket_project_floop_2", {
      role: "developer",
      reason: "Verify stale worktree rematerialization.",
    });
    const staleWorktreePath = execution.worktrees[0].path;
    execFileSync("git", ["-C", staleRepoRoot, "worktree", "add", "-B", "stale-branch", staleWorktreePath, "main"]);
    writeFileSync(
      join(staleWorktreePath, ".floop-worktree.json"),
      JSON.stringify({
        projectId: "project_floop",
        ticketId: "ticket_project_floop_2",
        executionId: execution.id,
        repoId: "repo_project_floop_floop",
        repoSlug: "floop",
        repoLocalPath: staleRepoRoot,
        baseRef: "main",
        branchName: "stale-branch",
      }),
      "utf8",
    );

    const driver = createExecutionDriver({ store, logger: silentLogger() });
    await driver.pollOnce();

    const worktreeMetadata = JSON.parse(readFileSync(join(staleWorktreePath, ".floop-worktree.json"), "utf8"));
    const currentBranch = execFileSync("git", ["-C", staleWorktreePath, "branch", "--show-current"], {
      encoding: "utf8",
    }).trim();

    assert.equal(worktreeMetadata.repoLocalPath, repoRoot);
    assert.equal(worktreeMetadata.branchName, execution.worktrees[0].branchName);
    assert.equal(currentBranch, execution.worktrees[0].branchName);
    assert.equal(existsSync(join(staleWorktreePath, "README.md")), true);
    assert.equal(existsSync(join(staleWorktreePath, "stale.txt")), false);
  } finally {
    store.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("execution driver reconciles interrupted active executions on startup", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "floop-driver-reconcile-"));
  const workspaceRoot = join(fixtureDir, "workspace");
  const store = createStore({
    filename: join(fixtureDir, "floop.sqlite"),
    seedDemo: true,
    workspaceRoot,
  });

  try {
    const execution = store.createExecution("project_floop", "ticket_project_floop_2", {
      role: "developer",
      reason: "Run before a simulated restart.",
    });
    const driver = createExecutionDriver({ store, logger: silentLogger() });

    await driver.reconcileOnStart();

    const recovered = store.getExecution("project_floop", execution.id);
    assert.equal(recovered.outcome, "failed");
    assert.equal(recovered.failureKind, "interrupted");
    assert.match(recovered.summaryMd, /recovered after restart/i);
  } finally {
    store.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("execution driver claim discipline prevents duplicate worker execution", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "floop-driver-claims-"));
  const workspaceRoot = join(fixtureDir, "workspace");
  const claimCounterPath = join(fixtureDir, "claim-counter.txt");
  const store = createStore({
    filename: join(fixtureDir, "floop.sqlite"),
    seedDemo: true,
    workspaceRoot,
  });

  try {
    writeFileSync(claimCounterPath, "0", "utf8");
    store.updateRoleProfile("project_floop", "developer", {
      adapter: "shell",
      model: "fixture",
      config: {
        command: `"${process.execPath}" -e "const fs=require('node:fs'); const count=Number(fs.readFileSync('${claimCounterPath}','utf8')); fs.writeFileSync('${claimCounterPath}', String(count + 1)); fs.writeFileSync(process.env.FLOOP_RESULT_PATH, JSON.stringify({ outcome: 'completed', summaryMd: 'Claim-safe completion.' }));"`,
      },
    });

    store.createExecution("project_floop", "ticket_project_floop_2", {
      role: "developer",
      reason: "Prove duplicate workers cannot both run.",
    });

    const driverA = createExecutionDriver({ store, logger: silentLogger() });
    const driverB = createExecutionDriver({ store, logger: silentLogger() });

    await Promise.all([driverA.pollOnce(), driverB.pollOnce()]);

    assert.equal(readFileSync(claimCounterPath, "utf8"), "1");
  } finally {
    store.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("execution driver retries transient adapter failures before succeeding", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "floop-driver-retry-"));
  const workspaceRoot = join(fixtureDir, "workspace");
  const attemptPath = join(fixtureDir, "attempts.txt");
  const store = createStore({
    filename: join(fixtureDir, "floop.sqlite"),
    seedDemo: true,
    workspaceRoot,
  });

  try {
    writeFileSync(attemptPath, "0", "utf8");
    store.updateRoleProfile("project_floop", "developer", {
      adapter: "shell",
      model: "fixture",
      config: {
        command: `"${process.execPath}" -e "const fs=require('node:fs'); const attemptsPath='${attemptPath}'; const attempts=Number(fs.readFileSync(attemptsPath,'utf8')) + 1; fs.writeFileSync(attemptsPath, String(attempts)); if (attempts < 2) { fs.writeFileSync(process.env.FLOOP_RESULT_PATH, JSON.stringify({ outcome: 'failed', summaryMd: 'Temporary adapter failure.', failureKind: 'transient' })); process.exit(1); } fs.writeFileSync(process.env.FLOOP_RESULT_PATH, JSON.stringify({ outcome: 'completed', summaryMd: 'Succeeded after retry.' }));"`,
      },
    });

    const execution = store.createExecution("project_floop", "ticket_project_floop_2", {
      role: "developer",
      reason: "Retry a transient adapter failure.",
    });
    const driver = createExecutionDriver({ store, logger: silentLogger(), retryBackoffMs: 1 });

    await driver.pollOnce();

    const completed = store.getExecution("project_floop", execution.id);
    assert.equal(completed.outcome, "completed");
    assert.match(completed.summaryMd, /Succeeded after retry\./);
    assert.match(completed.summaryMd, /Floop completed after 2 attempt\(s\)\./);
    assert.equal(readFileSync(attemptPath, "utf8"), "2");
  } finally {
    store.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("execution driver renews claims while a long-running execution is still active", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "floop-driver-renew-"));
  const workspaceRoot = join(fixtureDir, "workspace");
  const store = createStore({
    filename: join(fixtureDir, "floop.sqlite"),
    seedDemo: true,
    workspaceRoot,
  });

  try {
    store.updateRoleProfile("project_floop", "developer", {
      adapter: "shell",
      model: "fixture",
      config: {
        command: `"${process.execPath}" -e "setTimeout(() => { const fs=require('node:fs'); fs.writeFileSync(process.env.FLOOP_RESULT_PATH, JSON.stringify({ outcome: 'completed', summaryMd: 'Long-running execution completed.' })); }, 120)"`,
      },
    });

    const execution = store.createExecution("project_floop", "ticket_project_floop_2", {
      role: "developer",
      reason: "Keep renewing this lease while work is in flight.",
    });
    const driver = createExecutionDriver({ store, logger: silentLogger(), leaseMs: 40 });

    const pollPromise = driver.pollOnce();
    await new Promise((resolve) => setTimeout(resolve, 70));

    const competingClaim = store.claimExecution("project_floop", execution.id, {
      claimToken: "worker-b",
      leaseMs: 40,
    });

    await pollPromise;

    assert.equal(competingClaim, null);
    assert.equal(store.getExecution("project_floop", execution.id).outcome, "completed");
  } finally {
    store.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("execution driver terminates adapter processes when execution is cancelled", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "floop-driver-cancel-process-"));
  const workspaceRoot = join(fixtureDir, "workspace");
  const startedPath = join(fixtureDir, "adapter-started.txt");
  const stoppedPath = join(fixtureDir, "adapter-stopped.txt");
  const fakeAdapterPath = join(fixtureDir, "fake-long-adapter.js");
  const store = createStore({
    filename: join(fixtureDir, "floop.sqlite"),
    seedDemo: true,
    workspaceRoot,
  });

  writeFileSync(
    fakeAdapterPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(startedPath)}, String(process.pid));
process.on("SIGTERM", () => {
  fs.writeFileSync(${JSON.stringify(stoppedPath)}, "stopped");
  process.exit(0);
});
setInterval(() => {}, 1000);
`,
    { encoding: "utf8", mode: 0o755 },
  );

  try {
    store.updateRoleProfile("project_floop", "developer", {
      adapter: "shell",
      model: "fixture",
      config: {
        command: `"${process.execPath}" "${fakeAdapterPath}"`,
      },
    });

    const execution = store.createExecution("project_floop", "ticket_project_floop_2", {
      role: "developer",
      reason: "Start a cancellable adapter.",
    });
    const driver = createExecutionDriver({ store, logger: silentLogger(), leaseMs: 40 });

    const pollPromise = driver.pollOnce();
    await waitForFile(startedPath);
    store.cancelExecution("project_floop", execution.id, {
      reason: "Operator cancelled the active adapter.",
    });
    await pollPromise;

    const cancelled = store.getExecution("project_floop", execution.id);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.failureKind, "cancelled");
    assert.equal(readFileSync(stoppedPath, "utf8"), "stopped");
  } finally {
    store.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("execution driver completes when adapter writes result JSON and keeps running", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "floop-driver-result-hang-"));
  const workspaceRoot = join(fixtureDir, "workspace");
  const stoppedPath = join(fixtureDir, "adapter-stopped.txt");
  const fakeAdapterPath = join(fixtureDir, "fake-result-hang-adapter.js");
  const store = createStore({
    filename: join(fixtureDir, "floop.sqlite"),
    seedDemo: true,
    workspaceRoot,
  });

  writeFileSync(
    fakeAdapterPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.FLOOP_RESULT_PATH, JSON.stringify({
  outcome: "completed",
  summaryMd: "Adapter wrote a valid result before hanging."
}));
process.on("SIGTERM", () => {
  fs.writeFileSync(${JSON.stringify(stoppedPath)}, "stopped");
  process.exit(0);
});
setInterval(() => {}, 1000);
`,
    { encoding: "utf8", mode: 0o755 },
  );

  try {
    store.updateRoleProfile("project_floop", "developer", {
      adapter: "shell",
      model: "fixture",
      config: {
        command: `"${process.execPath}" "${fakeAdapterPath}"`,
      },
    });

    const execution = store.createExecution("project_floop", "ticket_project_floop_2", {
      role: "developer",
      reason: "Complete after result JSON appears.",
    });
    const driver = createExecutionDriver({
      store,
      logger: silentLogger(),
      resultExitGraceMs: 10,
    });

    await driver.pollOnce();

    const completed = store.getExecution("project_floop", execution.id);
    const eventsArtifact = completed.artifacts.find((artifact) => artifact.label === "Adapter events JSONL");
    const events = readFileSync(new URL(eventsArtifact.uri), "utf8");

    assert.equal(completed.outcome, "completed");
    assert.equal(completed.summaryMd, "Adapter wrote a valid result before hanging.");
    assert.equal(readFileSync(stoppedPath, "utf8"), "stopped");
    assert.match(events, /process\.result_detected/);
    assert.match(events, /"resultFileCompleted":true/);
  } finally {
    store.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

async function waitForFile(filename, timeoutMs = 2000) {
  const startedAt = Date.now();
  while (!existsSync(filename)) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for ${filename}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function silentLogger() {
  return {
    error() {},
    info() {},
  };
}
