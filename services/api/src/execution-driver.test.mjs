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
if (!process.argv.includes("--json")) {
  process.stderr.write("missing json event flag\\n");
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
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "codex-thread-fixture" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "fake codex stdout" } }) + "\\n");
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
    assert.equal(completed.harnessKind, "codex_exec");
    assert.equal(completed.externalThreadId, "codex-thread-fixture");
    assert.deepEqual(completed.harnessCapabilities, ["queued_context", "interrupt_and_resume"]);
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

test("execution driver blocks clearly when codex requires authentication", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "floop-codex-auth-required-"));
  const workspaceRoot = join(fixtureDir, "workspace");
  const fakeCodexPath = join(fixtureDir, "fake-auth-required-codex.js");
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
  process.stderr.write("Codex is not logged in. Please run codex login.\\n");
  process.exit(1);
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
      reason: "Run a codex adapter without local auth.",
    });
    const driver = createExecutionDriver({ store, logger: silentLogger() });

    await driver.pollOnce();

    const completed = store.getExecution("project_floop", execution.id);
    const ticket = store.getTicket("project_floop", "ticket_project_floop_2");
    const request = store
      .listAgentMessages("project_floop", { intent: "request_input", status: "pending" })
      .find((message) => message.target.executionId === execution.id);
    const stderrArtifact = completed.artifacts.find((artifact) => artifact.label === "Adapter stderr");

    assert.equal(completed.outcome, "blocked");
    assert.equal(completed.blockedKind, "codex_auth_required");
    assert.match(completed.summaryMd, /requires authentication/);
    assert.match(completed.remainingWorkMd, /codex login/i);
    assert.equal(ticket.state, "BLOCKED");
    assert.ok(request);
    assert.equal(request.metadata.blockedKind, "codex_auth_required");
    assert.ok(stderrArtifact);
    assert.match(readFileSync(new URL(stderrArtifact.uri), "utf8"), /not logged in/i);
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
    assert.match(readFileSync(promptPath, "utf8"), /blockedKind "needs_human_input"/);
    assert.match(readFileSync(promptPath, "utf8"), /Fully autonomous mode still allows this/);
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

test("execution driver includes prior HITL clarifications in later validator context", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "floop-hitl-validator-context-"));
  const workspaceRoot = join(fixtureDir, "workspace");
  const validatorAgentPath = join(fixtureDir, "validator-context-agent.js");
  const clarification = "Recurring events must support weekday-only repetition in the MVP.";
  const store = createStore({
    filename: join(fixtureDir, "floop.sqlite"),
    seedDemo: true,
    workspaceRoot,
  });

  writeFileSync(
    validatorAgentPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const context = JSON.parse(fs.readFileSync(process.env.FLOOP_CONTEXT_PATH, "utf8"));
const text = JSON.stringify(context.ticket.events || []);
if (!text.includes(${JSON.stringify(clarification)})) {
  fs.writeFileSync(
    process.env.FLOOP_RESULT_PATH,
    JSON.stringify({
      outcome: "blocked",
      summaryMd: "Validator could not see the prior HITL clarification.",
      remainingWorkMd: "Pass ticket comments and unblock answers into later lane context.",
      blockedKind: "needs_human_input"
    }),
  );
  process.exit(0);
}
fs.writeFileSync(
  process.env.FLOOP_RESULT_PATH,
  JSON.stringify({
    outcome: "completed",
    summaryMd: "Validator saw the prior HITL clarification.",
    validation: {
      verdict: "passed",
      summaryMd: "Validation used the clarified weekday-only recurrence scope.",
      commandProfile: "context-fixture",
      commands: [{ command: "inspect context", status: "passed", outputMd: "HITL clarification was present." }]
    }
  }),
);
`,
    { encoding: "utf8", mode: 0o755 },
  );

  try {
    store.updateProjectPolicy("project_floop", {
      interactionMode: "autonomous_with_review",
    });
    store.updateRoleProfile("project_floop", "validator", {
      adapter: "shell",
      model: "fixture",
      config: {
        command: `"${process.execPath}" "${validatorAgentPath}"`,
      },
    });

    const firstDeveloper = store.createExecution("project_floop", "ticket_project_floop_2", {
      role: "developer",
      reason: "Start implementation and ask for scope.",
    });
    store.completeExecution("project_floop", firstDeveloper.id, {
      outcome: "blocked",
      summaryMd: "Need recurrence scope.",
      remainingWorkMd: "Should recurrence include weekday-only repetition?",
      blockedKind: "needs_human_input",
    });

    const request = store
      .listAgentMessages("project_floop", { intent: "request_input", status: "pending" })
      .find((message) => message.target.executionId === firstDeveloper.id);
    const answer = store.respondAgentMessage("project_floop", request.id, {
      responseMd: clarification,
      responderKind: "human",
      responderRef: "jacob",
    });
    const continuedDeveloper = store.getExecution("project_floop", answer.promotedRef);
    store.completeExecution("project_floop", continuedDeveloper.id, {
      outcome: "completed",
      summaryMd: "Implemented recurrence using the HITL clarification.",
    });

    const reviewerExecution = store
      .getTicket("project_floop", "ticket_project_floop_2")
      .executions.find((execution) => execution.role === "reviewer");
    store.completeExecution("project_floop", reviewerExecution.id, {
      outcome: "completed",
      summaryMd: "Reviewer accepted clarified recurrence scope.",
      review: {
        verdict: "passed",
        summaryMd: "Review passed with the weekday-only recurrence clarification.",
      },
    });

    const validatorExecution = store
      .getTicket("project_floop", "ticket_project_floop_2")
      .executions.find((execution) => execution.role === "validator");
    const driver = createExecutionDriver({ store, logger: silentLogger() });
    await driver.pollOnce();

    const completed = store.getExecution("project_floop", validatorExecution.id);
    const validation = store.getTicket("project_floop", "ticket_project_floop_2").validations.at(-1);
    const context = JSON.parse(
      readFileSync(join(workspaceRoot, ".floop", "executions", validatorExecution.id, "context.json"), "utf8"),
    );

    assert.equal(completed.outcome, "completed");
    assert.equal(validation.verdict, "passed");
    assert.match(JSON.stringify(context.ticket.events), new RegExp(clarification));
  } finally {
    store.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("execution driver includes developer HITL clarifications in reviewer context", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "floop-hitl-reviewer-context-"));
  const workspaceRoot = join(fixtureDir, "workspace");
  const reviewerAgentPath = join(fixtureDir, "reviewer-context-agent.js");
  const question = "Should recurrence include weekday-only repetition?";
  const clarification = "Recurring events must support weekday-only repetition in the MVP.";
  const store = createStore({
    filename: join(fixtureDir, "floop.sqlite"),
    seedDemo: true,
    workspaceRoot,
  });

  writeFileSync(
    reviewerAgentPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const context = JSON.parse(fs.readFileSync(process.env.FLOOP_CONTEXT_PATH, "utf8"));
const text = JSON.stringify(context.ticket.events || []);
if (!text.includes(${JSON.stringify(question)}) || !text.includes(${JSON.stringify(clarification)})) {
  fs.writeFileSync(
    process.env.FLOOP_RESULT_PATH,
    JSON.stringify({
      outcome: "blocked",
      summaryMd: "Reviewer could not see the developer HITL question and answer.",
      remainingWorkMd: "Pass developer HITL history into reviewer context.",
      blockedKind: "needs_human_input"
    }),
  );
  process.exit(0);
}
fs.writeFileSync(
  process.env.FLOOP_RESULT_PATH,
  JSON.stringify({
    outcome: "completed",
    summaryMd: "Reviewer saw the developer HITL clarification.",
    review: {
      verdict: "passed",
      summaryMd: "Review used the clarified weekday-only recurrence scope."
    }
  }),
);
`,
    { encoding: "utf8", mode: 0o755 },
  );

  try {
    store.updateProjectPolicy("project_floop", {
      interactionMode: "autonomous_with_review",
    });
    store.updateRoleProfile("project_floop", "reviewer", {
      adapter: "shell",
      model: "fixture",
      config: {
        command: `"${process.execPath}" "${reviewerAgentPath}"`,
      },
    });

    const firstDeveloper = store.createExecution("project_floop", "ticket_project_floop_2", {
      role: "developer",
      reason: "Start implementation and ask for recurrence scope.",
    });
    store.completeExecution("project_floop", firstDeveloper.id, {
      outcome: "blocked",
      summaryMd: "Need recurrence scope.",
      remainingWorkMd: question,
      blockedKind: "needs_human_input",
    });

    const request = store
      .listAgentMessages("project_floop", { intent: "request_input", status: "pending" })
      .find((message) => message.target.executionId === firstDeveloper.id);
    const answer = store.respondAgentMessage("project_floop", request.id, {
      responseMd: clarification,
      responderKind: "human",
      responderRef: "jacob",
    });
    const continuedDeveloper = store.getExecution("project_floop", answer.promotedRef);
    store.completeExecution("project_floop", continuedDeveloper.id, {
      outcome: "completed",
      summaryMd: "Implemented recurrence using the HITL clarification.",
    });

    const reviewerExecution = store
      .getTicket("project_floop", "ticket_project_floop_2")
      .executions.find((execution) => execution.role === "reviewer");
    const driver = createExecutionDriver({ store, logger: silentLogger() });
    await driver.pollOnce();

    const completed = store.getExecution("project_floop", reviewerExecution.id);
    const review = store.getTicket("project_floop", "ticket_project_floop_2").reviews.at(-1);
    const context = JSON.parse(
      readFileSync(join(workspaceRoot, ".floop", "executions", reviewerExecution.id, "context.json"), "utf8"),
    );

    assert.equal(completed.outcome, "completed");
    assert.equal(review.verdict, "passed");
    assert.match(JSON.stringify(context.ticket.events), new RegExp(question.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(JSON.stringify(context.ticket.events), new RegExp(clarification));
  } finally {
    store.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("execution driver includes ordinary ticket comments in later context without redispatch", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "floop-ordinary-comment-context-"));
  const workspaceRoot = join(fixtureDir, "workspace");
  const reviewerAgentPath = join(fixtureDir, "reviewer-comment-context-agent.js");
  const ordinaryComment = "Operator note: keep the calendar import behind the beta flag.";
  const store = createStore({
    filename: join(fixtureDir, "floop.sqlite"),
    seedDemo: true,
    workspaceRoot,
  });

  writeFileSync(
    reviewerAgentPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const context = JSON.parse(fs.readFileSync(process.env.FLOOP_CONTEXT_PATH, "utf8"));
const text = JSON.stringify(context.ticket.events || []);
if (!text.includes(${JSON.stringify(ordinaryComment)})) {
  fs.writeFileSync(
    process.env.FLOOP_RESULT_PATH,
    JSON.stringify({
      outcome: "blocked",
      summaryMd: "Reviewer could not see the ordinary ticket comment.",
      remainingWorkMd: "Pass attached ticket comments into later agent context.",
      blockedKind: "needs_human_input"
    }),
  );
  process.exit(0);
}
fs.writeFileSync(
  process.env.FLOOP_RESULT_PATH,
  JSON.stringify({
    outcome: "completed",
    summaryMd: "Reviewer saw the ordinary ticket comment.",
    review: {
      verdict: "passed",
      summaryMd: "Review included ordinary ticket context."
    }
  }),
);
`,
    { encoding: "utf8", mode: 0o755 },
  );

  try {
    store.updateProjectPolicy("project_floop", {
      interactionMode: "autonomous_with_review",
    });
    store.updateRoleProfile("project_floop", "reviewer", {
      adapter: "shell",
      model: "fixture",
      config: {
        command: `"${process.execPath}" "${reviewerAgentPath}"`,
      },
    });

    const comment = store.createAgentMessage("project_floop", {
      actor: "jacob",
      source: "human",
      intent: "comment_on_ticket",
      target: { ticketId: "ticket_project_floop_2" },
      summary: "Beta flag note",
      body: ordinaryComment,
    });
    store.updateAgentMessage("project_floop", comment.id, {
      status: "attached",
      promotedKind: "ticket_event",
      promotedRef: "ticket_project_floop_2",
      reasonSource: "human",
    });
    assert.equal(
      store.getTicket("project_floop", "ticket_project_floop_2").executions.length,
      0,
    );

    const developerExecution = store.createExecution("project_floop", "ticket_project_floop_2", {
      role: "developer",
      reason: "Implement after ordinary ticket comment.",
    });
    store.completeExecution("project_floop", developerExecution.id, {
      outcome: "completed",
      summaryMd: "Implemented with beta flag context.",
    });

    const reviewerExecution = store
      .getTicket("project_floop", "ticket_project_floop_2")
      .executions.find((execution) => execution.role === "reviewer");
    const driver = createExecutionDriver({ store, logger: silentLogger() });
    await driver.pollOnce();

    const completed = store.getExecution("project_floop", reviewerExecution.id);
    const context = JSON.parse(
      readFileSync(join(workspaceRoot, ".floop", "executions", reviewerExecution.id, "context.json"), "utf8"),
    );

    assert.equal(completed.outcome, "completed");
    assert.equal(JSON.stringify(context.ticket.events).includes(ordinaryComment), true);
  } finally {
    store.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("execution driver redacts credential-like HITL answers from later agent context", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "floop-hitl-sensitive-context-"));
  const workspaceRoot = join(fixtureDir, "workspace");
  const reviewerAgentPath = join(fixtureDir, "reviewer-sensitive-context-agent.js");
  const secretAnswer = "api_key=sk-floopsecretcalendarworkflowtoken1234567890";
  const store = createStore({
    filename: join(fixtureDir, "floop.sqlite"),
    seedDemo: true,
    workspaceRoot,
  });

  writeFileSync(
    reviewerAgentPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const context = JSON.parse(fs.readFileSync(process.env.FLOOP_CONTEXT_PATH, "utf8"));
const text = JSON.stringify(context.ticket || {});
if (text.includes(${JSON.stringify(secretAnswer)}) || !text.includes("[sensitive response redacted]")) {
  fs.writeFileSync(
    process.env.FLOOP_RESULT_PATH,
    JSON.stringify({
      outcome: "blocked",
      summaryMd: "Reviewer context leaked a sensitive HITL answer or missed the redacted marker.",
      remainingWorkMd: "Redact credential-like HITL answers before adding them to ticket context.",
      blockedKind: "needs_environment_fix"
    }),
  );
  process.exit(0);
}
fs.writeFileSync(
  process.env.FLOOP_RESULT_PATH,
  JSON.stringify({
    outcome: "completed",
    summaryMd: "Reviewer saw a redacted sensitive HITL answer.",
    review: {
      verdict: "passed",
      summaryMd: "Review context preserved the secret boundary."
    }
  }),
);
`,
    { encoding: "utf8", mode: 0o755 },
  );

  try {
    store.updateProjectPolicy("project_floop", {
      interactionMode: "autonomous_with_review",
    });
    store.updateRoleProfile("project_floop", "reviewer", {
      adapter: "shell",
      model: "fixture",
      config: {
        command: `"${process.execPath}" "${reviewerAgentPath}"`,
      },
    });

    const firstDeveloper = store.createExecution("project_floop", "ticket_project_floop_2", {
      role: "developer",
      reason: "Start implementation and ask for a test credential.",
    });
    store.completeExecution("project_floop", firstDeveloper.id, {
      outcome: "blocked",
      summaryMd: "Need a test credential status.",
      remainingWorkMd: "Provide the test API key status for the calendar sync smoke.",
      blockedKind: "needs_human_input",
    });

    const request = store
      .listAgentMessages("project_floop", { intent: "request_input", status: "pending" })
      .find((message) => message.target.executionId === firstDeveloper.id);
    const answer = store.respondAgentMessage("project_floop", request.id, {
      responseMd: secretAnswer,
      responderKind: "human",
      responderRef: "jacob",
    });
    const rawAnswerMessage = store
      .listAgentMessages("project_floop", { intent: "comment_on_ticket", status: "attached", limit: 100 })
      .find((message) => message.metadata.responseToMessageId === request.id);
    const continuedDeveloper = store.getExecution("project_floop", answer.promotedRef);
    store.completeExecution("project_floop", continuedDeveloper.id, {
      outcome: "completed",
      summaryMd: "Implemented credential-aware smoke setup without recording the key.",
    });

    const reviewerExecution = store
      .getTicket("project_floop", "ticket_project_floop_2")
      .executions.find((execution) => execution.role === "reviewer");
    const driver = createExecutionDriver({ store, logger: silentLogger() });
    await driver.pollOnce();

    const completed = store.getExecution("project_floop", reviewerExecution.id);
    const context = JSON.parse(
      readFileSync(join(workspaceRoot, ".floop", "executions", reviewerExecution.id, "context.json"), "utf8"),
    );
    const contextText = JSON.stringify(context.ticket || {});

    assert.equal(rawAnswerMessage.body, secretAnswer);
    assert.equal(completed.outcome, "completed");
    assert.equal(contextText.includes(secretAnswer), false);
    assert.equal(contextText.includes("[sensitive response redacted]"), true);
  } finally {
    store.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("execution driver includes reviewer HITL clarifications in validator context", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "floop-reviewer-hitl-validator-context-"));
  const workspaceRoot = join(fixtureDir, "workspace");
  const validatorAgentPath = join(fixtureDir, "validator-reviewer-context-agent.js");
  const question = "Should validation include keyboard navigation smoke coverage?";
  const clarification = "Validation must include keyboard navigation smoke coverage for MVP flows.";
  const store = createStore({
    filename: join(fixtureDir, "floop.sqlite"),
    seedDemo: true,
    workspaceRoot,
  });

  writeFileSync(
    validatorAgentPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const context = JSON.parse(fs.readFileSync(process.env.FLOOP_CONTEXT_PATH, "utf8"));
const text = JSON.stringify(context.ticket.events || []);
if (!text.includes(${JSON.stringify(question)}) || !text.includes(${JSON.stringify(clarification)})) {
  fs.writeFileSync(
    process.env.FLOOP_RESULT_PATH,
    JSON.stringify({
      outcome: "blocked",
      summaryMd: "Validator could not see the reviewer HITL question and answer.",
      remainingWorkMd: "Pass reviewer HITL history into validator context.",
      blockedKind: "needs_human_input"
    }),
  );
  process.exit(0);
}
fs.writeFileSync(
  process.env.FLOOP_RESULT_PATH,
  JSON.stringify({
    outcome: "completed",
    summaryMd: "Validator saw the reviewer HITL clarification.",
    validation: {
      verdict: "passed",
      summaryMd: "Validation used the clarified keyboard smoke coverage scope.",
      commandProfile: "context-fixture",
      commands: [{ command: "inspect context", status: "passed", outputMd: "Reviewer HITL clarification was present." }]
    }
  }),
);
`,
    { encoding: "utf8", mode: 0o755 },
  );

  try {
    store.updateProjectPolicy("project_floop", {
      interactionMode: "autonomous_with_review",
    });
    store.updateRoleProfile("project_floop", "validator", {
      adapter: "shell",
      model: "fixture",
      config: {
        command: `"${process.execPath}" "${validatorAgentPath}"`,
      },
    });

    const implementation = store.createExecution("project_floop", "ticket_project_floop_2", {
      role: "developer",
      reason: "Finish implementation before reviewer HITL.",
    });
    store.completeExecution("project_floop", implementation.id, {
      outcome: "completed",
      summaryMd: "Implementation ready for review.",
    });
    const reviewerExecution = store
      .getTicket("project_floop", "ticket_project_floop_2")
      .executions.find((execution) => execution.role === "reviewer");
    store.completeExecution("project_floop", reviewerExecution.id, {
      outcome: "blocked",
      summaryMd: "Reviewer needs validation scope.",
      remainingWorkMd: question,
      blockedKind: "needs_human_input",
    });

    const request = store
      .listAgentMessages("project_floop", { intent: "request_input", status: "pending" })
      .find((message) => message.target.executionId === reviewerExecution.id);
    const answer = store.respondAgentMessage("project_floop", request.id, {
      responseMd: clarification,
      responderKind: "human",
      responderRef: "jacob",
    });
    const continuedReviewer = store.getExecution("project_floop", answer.promotedRef);
    store.completeExecution("project_floop", continuedReviewer.id, {
      outcome: "completed",
      summaryMd: "Reviewer accepted the clarified validation scope.",
      review: {
        verdict: "passed",
        summaryMd: "Review passed with keyboard validation scope.",
      },
    });

    const validatorExecution = store
      .getTicket("project_floop", "ticket_project_floop_2")
      .executions.find((execution) => execution.role === "validator");
    const driver = createExecutionDriver({ store, logger: silentLogger() });
    await driver.pollOnce();

    const completed = store.getExecution("project_floop", validatorExecution.id);
    const validation = store.getTicket("project_floop", "ticket_project_floop_2").validations.at(-1);
    const context = JSON.parse(
      readFileSync(join(workspaceRoot, ".floop", "executions", validatorExecution.id, "context.json"), "utf8"),
    );

    assert.equal(completed.outcome, "completed");
    assert.equal(validation.verdict, "passed");
    assert.match(JSON.stringify(context.ticket.events), new RegExp(question.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(JSON.stringify(context.ticket.events), new RegExp(clarification));
  } finally {
    store.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("execution driver scopes HITL context to the current ticket", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "floop-hitl-context-scope-"));
  const workspaceRoot = join(fixtureDir, "workspace");
  const reviewerAgentPath = join(fixtureDir, "reviewer-scope-agent.js");
  const foreignClarification = "Alpha ticket must integrate with payroll exports.";
  const currentClarification = "Beta ticket only needs local calendar export.";
  const store = createStore({
    filename: join(fixtureDir, "floop.sqlite"),
    seedDemo: true,
    workspaceRoot,
  });

  writeFileSync(
    reviewerAgentPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const context = JSON.parse(fs.readFileSync(process.env.FLOOP_CONTEXT_PATH, "utf8"));
const text = JSON.stringify(context.ticket.events || []);
if (text.includes(${JSON.stringify(foreignClarification)}) || !text.includes(${JSON.stringify(currentClarification)})) {
  fs.writeFileSync(
    process.env.FLOOP_RESULT_PATH,
    JSON.stringify({
      outcome: "blocked",
      summaryMd: "Reviewer saw leaked HITL context or missed current ticket context.",
      remainingWorkMd: "Scope ticket events to the current ticket.",
      blockedKind: "needs_human_input"
    }),
  );
  process.exit(0);
}
fs.writeFileSync(
  process.env.FLOOP_RESULT_PATH,
  JSON.stringify({
    outcome: "completed",
    summaryMd: "Reviewer context was scoped to the current ticket.",
    review: {
      verdict: "passed",
      summaryMd: "Review saw only the current ticket clarification."
    }
  }),
);
`,
    { encoding: "utf8", mode: 0o755 },
  );

  try {
    store.updateProjectPolicy("project_floop", {
      interactionMode: "autonomous_with_review",
    });
    store.updateRoleProfile("project_floop", "reviewer", {
      adapter: "shell",
      model: "fixture",
      config: {
        command: `"${process.execPath}" "${reviewerAgentPath}"`,
      },
    });

    const betaTicket = store.createTicket("project_floop", {
      title: "Implement beta calendar export",
      brief: "Build scoped beta export behavior.",
      state: "READY",
      assignedRole: "developer",
    });

    const alphaExecution = store.createExecution("project_floop", "ticket_project_floop_2", {
      role: "developer",
      reason: "Ask for alpha scope.",
    });
    store.completeExecution("project_floop", alphaExecution.id, {
      outcome: "blocked",
      summaryMd: "Need alpha export scope.",
      remainingWorkMd: "Should alpha include payroll exports?",
      blockedKind: "needs_human_input",
    });
    const alphaRequest = store
      .listAgentMessages("project_floop", { intent: "request_input", status: "pending" })
      .find((message) => message.target.executionId === alphaExecution.id);
    store.respondAgentMessage("project_floop", alphaRequest.id, {
      responseMd: foreignClarification,
      responderKind: "human",
      responderRef: "jacob",
      continueExecution: false,
    });

    const betaExecution = store.createExecution("project_floop", betaTicket.id, {
      role: "developer",
      reason: "Ask for beta scope.",
    });
    store.completeExecution("project_floop", betaExecution.id, {
      outcome: "blocked",
      summaryMd: "Need beta export scope.",
      remainingWorkMd: "Should beta include local calendar export?",
      blockedKind: "needs_human_input",
    });
    const betaRequest = store
      .listAgentMessages("project_floop", { intent: "request_input", status: "pending" })
      .find((message) => message.target.executionId === betaExecution.id);
    const betaAnswer = store.respondAgentMessage("project_floop", betaRequest.id, {
      responseMd: currentClarification,
      responderKind: "human",
      responderRef: "jacob",
    });
    const continuedBeta = store.getExecution("project_floop", betaAnswer.promotedRef);
    store.completeExecution("project_floop", continuedBeta.id, {
      outcome: "completed",
      summaryMd: "Implemented beta export from scoped HITL context.",
    });

    const reviewerExecution = store
      .getTicket("project_floop", betaTicket.id)
      .executions.find((execution) => execution.role === "reviewer");
    const driver = createExecutionDriver({ store, logger: silentLogger() });
    await driver.pollOnce();

    const completed = store.getExecution("project_floop", reviewerExecution.id);
    const context = JSON.parse(
      readFileSync(join(workspaceRoot, ".floop", "executions", reviewerExecution.id, "context.json"), "utf8"),
    );
    const contextText = JSON.stringify(context.ticket.events);

    assert.equal(completed.outcome, "completed");
    assert.equal(contextText.includes(currentClarification), true);
    assert.equal(contextText.includes(foreignClarification), false);
  } finally {
    store.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("execution driver includes parent HITL context for child ticket executions", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "floop-parent-hitl-child-context-"));
  const workspaceRoot = join(fixtureDir, "workspace");
  const childAgentPath = join(fixtureDir, "child-parent-context-agent.js");
  const parentClarification = "Child features must use the public holiday calendar as the default source.";
  const store = createStore({
    filename: join(fixtureDir, "floop.sqlite"),
    seedDemo: true,
    workspaceRoot,
  });

  writeFileSync(
    childAgentPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const context = JSON.parse(fs.readFileSync(process.env.FLOOP_CONTEXT_PATH, "utf8"));
const text = JSON.stringify(context.relatedTickets?.parent || {});
if (!text.includes(${JSON.stringify(parentClarification)})) {
  fs.writeFileSync(
    process.env.FLOOP_RESULT_PATH,
    JSON.stringify({
      outcome: "blocked",
      summaryMd: "Child execution could not see parent planning clarification.",
      remainingWorkMd: "Include parent ticket HITL context for child tickets.",
      blockedKind: "needs_human_input"
    }),
  );
  process.exit(0);
}
fs.writeFileSync(
  process.env.FLOOP_RESULT_PATH,
  JSON.stringify({
    outcome: "completed",
    summaryMd: "Child execution saw parent HITL context."
  }),
);
`,
    { encoding: "utf8", mode: 0o755 },
  );

  try {
    store.updateProjectPolicy("project_floop", {
      interactionMode: "autonomous_with_review",
      refinementMode: "autonomous",
      requireReviewer: false,
      requireValidator: false,
    });
    store.updateRoleProfile("project_floop", "developer", {
      adapter: "shell",
      model: "fixture",
      config: {
        command: `"${process.execPath}" "${childAgentPath}"`,
      },
    });

    const parent = store.createTicket("project_floop", {
      title: "Plan calendar product slices",
      brief: "Create feature tickets for the calendar app.",
      state: "READY",
      assignedRole: "architect",
    });
    const planning = store.createExecution("project_floop", parent.id, {
      role: "architect",
      reason: "Plan child features and ask one product question.",
    });
    store.completeExecution("project_floop", planning.id, {
      outcome: "blocked",
      summaryMd: "Need default source.",
      remainingWorkMd: "What calendar source should child features assume by default?",
      blockedKind: "needs_human_input",
    });
    const request = store
      .listAgentMessages("project_floop", { intent: "request_input", status: "pending" })
      .find((message) => message.target.executionId === planning.id);
    const answer = store.respondAgentMessage("project_floop", request.id, {
      responseMd: parentClarification,
      responderKind: "human",
      responderRef: "jacob",
      continueExecution: false,
    });
    assert.equal(answer.status, "attached");

    const child = store.createTicket("project_floop", {
      title: "Build holiday-aware event creation",
      brief: "Use planning context to implement event creation.",
      parentTicketId: parent.id,
      state: "READY",
      assignedRole: "developer",
    });
    const childExecution = store.createExecution("project_floop", child.id, {
      role: "developer",
      reason: "Implement child feature with parent context.",
    });
    const driver = createExecutionDriver({ store, logger: silentLogger() });
    await driver.pollOnce();

    const completed = store.getExecution("project_floop", childExecution.id);
    const context = JSON.parse(
      readFileSync(join(workspaceRoot, ".floop", "executions", childExecution.id, "context.json"), "utf8"),
    );
    const parentContextText = JSON.stringify(context.relatedTickets.parent || {});

    assert.equal(completed.outcome, "completed");
    assert.equal(context.relatedTickets.parent.id, parent.id);
    assert.equal(parentContextText.includes(parentClarification), true);
    assert.equal(JSON.stringify(context.ticket.events).includes(parentClarification), false);
  } finally {
    store.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("execution driver rolls child HITL context up to parent executions", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "floop-child-hitl-parent-context-"));
  const workspaceRoot = join(fixtureDir, "workspace");
  const parentAgentPath = join(fixtureDir, "parent-child-context-agent.js");
  const childClarification = "The availability grid must support drag selection before parent approval.";
  const store = createStore({
    filename: join(fixtureDir, "floop.sqlite"),
    seedDemo: true,
    workspaceRoot,
  });

  writeFileSync(
    parentAgentPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const context = JSON.parse(fs.readFileSync(process.env.FLOOP_CONTEXT_PATH, "utf8"));
const text = JSON.stringify(context.relatedTickets?.children || []);
if (!text.includes(${JSON.stringify(childClarification)})) {
  fs.writeFileSync(
    process.env.FLOOP_RESULT_PATH,
    JSON.stringify({
      outcome: "blocked",
      summaryMd: "Parent execution could not see child HITL clarification.",
      remainingWorkMd: "Roll child ticket HITL context into parent execution context.",
      blockedKind: "needs_human_input"
    }),
  );
  process.exit(0);
}
fs.writeFileSync(
  process.env.FLOOP_RESULT_PATH,
  JSON.stringify({
    outcome: "completed",
    summaryMd: "Parent execution saw child HITL context.",
    review: {
      verdict: "passed",
      summaryMd: "Parent review considered child clarification."
    }
  }),
);
`,
    { encoding: "utf8", mode: 0o755 },
  );

  try {
    store.updateProjectPolicy("project_floop", {
      interactionMode: "autonomous_with_review",
      requireReviewer: false,
      requireValidator: false,
    });
    store.updateRoleProfile("project_floop", "reviewer", {
      adapter: "shell",
      model: "fixture",
      config: {
        command: `"${process.execPath}" "${parentAgentPath}"`,
      },
    });

    const parent = store.createTicket("project_floop", {
      title: "Review calendar feature set",
      brief: "Approve child feature direction before merge.",
      state: "READY",
      assignedRole: "reviewer",
    });
    const child = store.createTicket("project_floop", {
      title: "Build availability grid",
      brief: "Implement the availability selection workflow.",
      parentTicketId: parent.id,
      state: "READY",
      assignedRole: "developer",
    });
    const childExecution = store.createExecution("project_floop", child.id, {
      role: "developer",
      reason: "Ask for availability interaction scope.",
    });
    store.completeExecution("project_floop", childExecution.id, {
      outcome: "blocked",
      summaryMd: "Need grid interaction scope.",
      remainingWorkMd: "Should the availability grid support drag selection?",
      blockedKind: "needs_human_input",
    });
    const request = store
      .listAgentMessages("project_floop", { intent: "request_input", status: "pending" })
      .find((message) => message.target.executionId === childExecution.id);
    const answer = store.respondAgentMessage("project_floop", request.id, {
      responseMd: childClarification,
      responderKind: "human",
      responderRef: "jacob",
    });
    const continuedChild = store.getExecution("project_floop", answer.promotedRef);
    store.completeExecution("project_floop", continuedChild.id, {
      outcome: "completed",
      summaryMd: "Implemented child feature using the clarification.",
    });

    const parentExecution = store.createExecution("project_floop", parent.id, {
      role: "reviewer",
      reason: "Review parent scope using child context.",
    });
    const driver = createExecutionDriver({ store, logger: silentLogger() });
    await driver.pollOnce();

    const completed = store.getExecution("project_floop", parentExecution.id);
    const context = JSON.parse(
      readFileSync(join(workspaceRoot, ".floop", "executions", parentExecution.id, "context.json"), "utf8"),
    );
    const childContextText = JSON.stringify(context.relatedTickets.children || []);

    assert.equal(completed.outcome, "completed");
    assert.equal(context.relatedTickets.children.some((item) => item.id === child.id), true);
    assert.equal(childContextText.includes(childClarification), true);
    assert.equal(JSON.stringify(context.ticket.events).includes(childClarification), false);
  } finally {
    store.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("execution driver keeps multiple HITL questions ordered and lane scoped", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "floop-ordered-hitl-context-"));
  const workspaceRoot = join(fixtureDir, "workspace");
  const validatorAgentPath = join(fixtureDir, "validator-ordered-hitl-agent.js");
  const developerQuestion = "Should import support CSV timezone columns?";
  const developerAnswer = "CSV imports must support timezone columns.";
  const reviewerQuestion = "Should validation include malformed timezone rows?";
  const reviewerAnswer = "Validation must include malformed timezone rows.";
  const store = createStore({
    filename: join(fixtureDir, "floop.sqlite"),
    seedDemo: true,
    workspaceRoot,
  });

  writeFileSync(
    validatorAgentPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const context = JSON.parse(fs.readFileSync(process.env.FLOOP_CONTEXT_PATH, "utf8"));
const text = JSON.stringify(context.ticket.events || []);
const values = [
  ${JSON.stringify(developerQuestion)},
  ${JSON.stringify(developerAnswer)},
  ${JSON.stringify(reviewerQuestion)},
  ${JSON.stringify(reviewerAnswer)}
];
const positions = values.map((value) => text.indexOf(value));
const ordered = positions.every((position) => position >= 0) && positions.every((position, index) => index === 0 || positions[index - 1] < position);
if (!ordered) {
  fs.writeFileSync(
    process.env.FLOOP_RESULT_PATH,
    JSON.stringify({
      outcome: "blocked",
      summaryMd: "Validator could not see ordered HITL question and answer history.",
      remainingWorkMd: "Keep multiple HITL interactions ordered and scoped in ticket context.",
      blockedKind: "needs_human_input"
    }),
  );
  process.exit(0);
}
fs.writeFileSync(
  process.env.FLOOP_RESULT_PATH,
  JSON.stringify({
    outcome: "completed",
    summaryMd: "Validator saw ordered HITL history.",
    validation: {
      verdict: "passed",
      summaryMd: "Validation used ordered HITL context.",
      commandProfile: "context-fixture",
      commands: [{ command: "inspect ordered HITL context", status: "passed", outputMd: "HITL ordering was preserved." }]
    }
  }),
);
`,
    { encoding: "utf8", mode: 0o755 },
  );

  try {
    store.updateProjectPolicy("project_floop", {
      interactionMode: "autonomous_with_review",
    });
    store.updateRoleProfile("project_floop", "validator", {
      adapter: "shell",
      model: "fixture",
      config: {
        command: `"${process.execPath}" "${validatorAgentPath}"`,
      },
    });

    const developer = store.createExecution("project_floop", "ticket_project_floop_2", {
      role: "developer",
      reason: "Ask the first HITL question.",
    });
    store.completeExecution("project_floop", developer.id, {
      outcome: "blocked",
      summaryMd: "Need import scope.",
      remainingWorkMd: developerQuestion,
      blockedKind: "needs_human_input",
    });
    const developerRequest = store
      .listAgentMessages("project_floop", { intent: "request_input", status: "pending" })
      .find((message) => message.target.executionId === developer.id);
    const developerResponse = store.respondAgentMessage("project_floop", developerRequest.id, {
      responseMd: developerAnswer,
      responderKind: "human",
      responderRef: "jacob",
    });
    assert.equal(developerResponse.promotedRef.startsWith("execution_"), true);
    const continuedDeveloper = store.getExecution("project_floop", developerResponse.promotedRef);
    store.completeExecution("project_floop", continuedDeveloper.id, {
      outcome: "completed",
      summaryMd: "Implemented CSV timezone import.",
    });

    const reviewer = store
      .getTicket("project_floop", "ticket_project_floop_2")
      .executions.find((execution) => execution.role === "reviewer");
    store.completeExecution("project_floop", reviewer.id, {
      outcome: "blocked",
      summaryMd: "Need validation scope.",
      remainingWorkMd: reviewerQuestion,
      blockedKind: "needs_human_input",
    });
    const reviewerRequest = store
      .listAgentMessages("project_floop", { intent: "request_input", status: "pending" })
      .find((message) => message.target.executionId === reviewer.id);
    const reviewerResponse = store.respondAgentMessage("project_floop", reviewerRequest.id, {
      responseMd: reviewerAnswer,
      responderKind: "human",
      responderRef: "jacob",
    });
    assert.equal(reviewerResponse.promotedRef.startsWith("execution_"), true);
    const continuedReviewer = store.getExecution("project_floop", reviewerResponse.promotedRef);
    store.completeExecution("project_floop", continuedReviewer.id, {
      outcome: "completed",
      summaryMd: "Review passed with malformed timezone validation scope.",
      review: {
        verdict: "passed",
        summaryMd: "Review used ordered HITL context.",
      },
    });

    const validator = store
      .getTicket("project_floop", "ticket_project_floop_2")
      .executions.find((execution) => execution.role === "validator");
    const driver = createExecutionDriver({ store, logger: silentLogger() });
    await driver.pollOnce();

    const completed = store.getExecution("project_floop", validator.id);
    const context = JSON.parse(
      readFileSync(join(workspaceRoot, ".floop", "executions", validator.id, "context.json"), "utf8"),
    );
    const eventText = JSON.stringify(context.ticket.events || []);

    assert.equal(completed.outcome, "completed");
    assert.equal(eventText.indexOf(developerQuestion) < eventText.indexOf(developerAnswer), true);
    assert.equal(eventText.indexOf(developerAnswer) < eventText.indexOf(reviewerQuestion), true);
    assert.equal(eventText.indexOf(reviewerQuestion) < eventText.indexOf(reviewerAnswer), true);
    assert.equal(developerResponse.promotedRef, continuedDeveloper.id);
    assert.equal(reviewerResponse.promotedRef, continuedReviewer.id);
    assert.notEqual(developerResponse.promotedRef, reviewerResponse.promotedRef);
  } finally {
    store.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("execution driver includes HITL review validation and merge evidence in rework context", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "floop-merge-rework-context-"));
  const workspaceRoot = join(fixtureDir, "workspace");
  const developerAgentPath = join(fixtureDir, "developer-rework-context-agent.js");
  const clarification = "Conflict resolution must preserve weekday-only recurrence behavior.";
  const reviewSummary = "Reviewer confirmed recurrence behavior must be preserved during merge rework.";
  const validationSummary = "Validation passed recurrence checks before merge rework.";
  const mergeSummary = "Merge conflicted on recurrence rules; preserve validated behavior.";
  const store = createStore({
    filename: join(fixtureDir, "floop.sqlite"),
    seedDemo: true,
    workspaceRoot,
  });

  writeFileSync(
    developerAgentPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const context = JSON.parse(fs.readFileSync(process.env.FLOOP_CONTEXT_PATH, "utf8"));
const text = JSON.stringify(context.ticket || {});
const required = [
  ${JSON.stringify(clarification)},
  ${JSON.stringify(reviewSummary)},
  ${JSON.stringify(validationSummary)},
  ${JSON.stringify(mergeSummary)}
];
const missing = required.filter((item) => !text.includes(item));
if (missing.length > 0) {
  fs.writeFileSync(
    process.env.FLOOP_RESULT_PATH,
    JSON.stringify({
      outcome: "blocked",
      summaryMd: "Rework agent context is missing prior workflow evidence.",
      remainingWorkMd: "Missing context: " + missing.join(", "),
      blockedKind: "needs_human_input"
    }),
  );
  process.exit(0);
}
fs.writeFileSync(
  process.env.FLOOP_RESULT_PATH,
  JSON.stringify({
    outcome: "completed",
    summaryMd: "Rework context included HITL, review, validation, and merge evidence."
  }),
);
`,
    { encoding: "utf8", mode: 0o755 },
  );

  try {
    store.updateProjectPolicy("project_floop", {
      interactionMode: "fully_autonomous",
      requireReviewer: true,
      requireValidator: true,
      requireHumanApprovalBeforeMerge: false,
      requireDemoEvidenceBeforeMerge: false,
    });
    store.updateRoleProfile("project_floop", "developer", {
      adapter: "shell",
      model: "fixture",
      config: {
        command: `"${process.execPath}" "${developerAgentPath}"`,
      },
    });

    const firstDeveloper = store.createExecution("project_floop", "ticket_project_floop_2", {
      role: "developer",
      reason: "Start implementation before merge rework.",
    });
    store.completeExecution("project_floop", firstDeveloper.id, {
      outcome: "blocked",
      summaryMd: "Need recurrence conflict policy.",
      remainingWorkMd: "What behavior must be preserved if merge conflicts on recurrence code?",
      blockedKind: "needs_human_input",
    });
    const request = store
      .listAgentMessages("project_floop", { intent: "request_input", status: "pending" })
      .find((message) => message.target.executionId === firstDeveloper.id);
    const answer = store.respondAgentMessage("project_floop", request.id, {
      responseMd: clarification,
      responderKind: "human",
      responderRef: "jacob",
    });
    const continuedDeveloper = store.getExecution("project_floop", answer.promotedRef);
    store.completeExecution("project_floop", continuedDeveloper.id, {
      outcome: "completed",
      summaryMd: "Implementation completed with recurrence behavior preserved.",
    });

    store.createReview("project_floop", "ticket_project_floop_2", {
      executionId: continuedDeveloper.id,
      verdict: "passed",
      summaryMd: reviewSummary,
      findings: [{
        severity: "low",
        category: "merge_rework",
        title: "Preserve recurrence behavior",
        detailsMd: "Preserve recurrence behavior during merge conflict resolution.",
      }],
    });
    store.createValidation("project_floop", "ticket_project_floop_2", {
      executionId: continuedDeveloper.id,
      repoIds: ["repo_project_floop_floop"],
      verdict: "passed",
      summaryMd: validationSummary,
      commandProfile: "context-fixture",
      commands: [{ command: "npm test recurrence", status: "passed", outputMd: "Recurrence checks passed." }],
    });
    assert.equal(store.getTicket("project_floop", "ticket_project_floop_2").state, "READY_TO_MERGE");

    const mergeRun = store.startMergeRun("project_floop", "ticket_project_floop_2", {
      strategy: "squash",
      approvedByKind: "system",
      approvedByRef: "floop-auto",
      claimToken: "merge-worker",
    });
    store.completeMergeRun("project_floop", mergeRun.id, {
      status: "rework",
      summaryMd: mergeSummary,
      artifacts: [{ kind: "report", label: "merge conflict summary", uri: "file:///tmp/merge-conflict.json" }],
    });

    const reworkExecution = store
      .getTicket("project_floop", "ticket_project_floop_2")
      .executions.find((execution) => execution.role === "developer" && execution.status === "running");
    const driver = createExecutionDriver({ store, logger: silentLogger() });
    await driver.pollOnce();

    const completed = store.getExecution("project_floop", reworkExecution.id);
    const context = JSON.parse(
      readFileSync(join(workspaceRoot, ".floop", "executions", reworkExecution.id, "context.json"), "utf8"),
    );
    const contextText = JSON.stringify(context.ticket);

    assert.equal(completed.outcome, "completed");
    assert.equal(contextText.includes(clarification), true);
    assert.equal(contextText.includes(reviewSummary), true);
    assert.equal(contextText.includes(validationSummary), true);
    assert.equal(contextText.includes(mergeSummary), true);
  } finally {
    store.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("execution driver includes validator HITL clarification in merge rework context", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "floop-validator-hitl-merge-context-"));
  const workspaceRoot = join(fixtureDir, "workspace");
  const developerAgentPath = join(fixtureDir, "developer-validator-hitl-rework-agent.js");
  const validatorQuestion = "Should merge rework preserve the offline validation fallback?";
  const validatorClarification = "Merge rework must preserve the offline validation fallback path.";
  const validationSummary = "Validation passed after confirming offline fallback scope.";
  const mergeSummary = "Merge conflicted in validation fallback wiring.";
  const store = createStore({
    filename: join(fixtureDir, "floop.sqlite"),
    seedDemo: true,
    workspaceRoot,
  });

  writeFileSync(
    developerAgentPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const context = JSON.parse(fs.readFileSync(process.env.FLOOP_CONTEXT_PATH, "utf8"));
const text = JSON.stringify(context.ticket || {});
const required = [
  ${JSON.stringify(validatorQuestion)},
  ${JSON.stringify(validatorClarification)},
  ${JSON.stringify(validationSummary)},
  ${JSON.stringify(mergeSummary)}
];
const missing = required.filter((value) => !text.includes(value));
if (missing.length > 0) {
  fs.writeFileSync(
    process.env.FLOOP_RESULT_PATH,
    JSON.stringify({
      outcome: "blocked",
      summaryMd: "Merge rework context missed validator HITL or merge evidence.",
      remainingWorkMd: "Missing context: " + missing.join(", "),
      blockedKind: "needs_human_input"
    }),
  );
  process.exit(0);
}
fs.writeFileSync(
  process.env.FLOOP_RESULT_PATH,
  JSON.stringify({
    outcome: "completed",
    summaryMd: "Merge rework preserved validator HITL scope."
  }),
);
`,
    { encoding: "utf8", mode: 0o755 },
  );

  try {
    store.updateProjectPolicy("project_floop", {
      interactionMode: "fully_autonomous",
      requireReviewer: false,
      requireValidator: true,
      requireHumanApprovalBeforeMerge: false,
      requireDemoEvidenceBeforeMerge: false,
    });
    store.updateRoleProfile("project_floop", "developer", {
      adapter: "shell",
      model: "fixture",
      config: {
        command: `"${process.execPath}" "${developerAgentPath}"`,
      },
    });

    const implementation = store.createExecution("project_floop", "ticket_project_floop_2", {
      role: "developer",
      reason: "Implement before validator HITL and merge rework.",
    });
    store.completeExecution("project_floop", implementation.id, {
      outcome: "completed",
      summaryMd: "Implementation is ready for validator HITL.",
    });

    const validator = store
      .getTicket("project_floop", "ticket_project_floop_2")
      .executions.find((execution) => execution.role === "validator");
    store.completeExecution("project_floop", validator.id, {
      outcome: "blocked",
      summaryMd: "Need fallback validation scope.",
      remainingWorkMd: validatorQuestion,
      blockedKind: "needs_human_input",
    });
    const request = store
      .listAgentMessages("project_floop", { intent: "request_input", status: "pending" })
      .find((message) => message.target.executionId === validator.id);
    const answer = store.respondAgentMessage("project_floop", request.id, {
      responseMd: validatorClarification,
      responderKind: "human",
      responderRef: "jacob",
    });
    const continuedValidator = store.getExecution("project_floop", answer.promotedRef);
    store.completeExecution("project_floop", continuedValidator.id, {
      outcome: "completed",
      summaryMd: validationSummary,
      validation: {
        verdict: "passed",
        summaryMd: validationSummary,
        commandProfile: "context-fixture",
        commands: [{ command: "validate fallback", status: "passed", outputMd: validationSummary }],
      },
    });

    const mergeRun = store.startMergeRun("project_floop", "ticket_project_floop_2", {
      strategy: "squash",
      approvedByKind: "system",
      approvedByRef: "floop-auto",
      claimToken: "merge-worker",
    });
    store.completeMergeRun("project_floop", mergeRun.id, {
      status: "rework",
      summaryMd: mergeSummary,
      artifacts: [{ kind: "report", label: "merge conflict summary", uri: "file:///tmp/merge-conflict.json" }],
    });

    const reworkExecution = store
      .getTicket("project_floop", "ticket_project_floop_2")
      .executions.find((execution) => execution.role === "developer" && execution.iteration === 2);
    const driver = createExecutionDriver({ store, logger: silentLogger() });
    await driver.pollOnce();

    const completed = store.getExecution("project_floop", reworkExecution.id);
    const context = JSON.parse(
      readFileSync(join(workspaceRoot, ".floop", "executions", reworkExecution.id, "context.json"), "utf8"),
    );
    const contextText = JSON.stringify(context.ticket || {});

    assert.equal(completed.outcome, "completed");
    assert.equal(contextText.includes(validatorQuestion), true);
    assert.equal(contextText.includes(validatorClarification), true);
    assert.equal(contextText.includes(validationSummary), true);
    assert.equal(contextText.includes(mergeSummary), true);
  } finally {
    store.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("execution driver includes applied ceremony decisions in ticket context", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "floop-ceremony-ticket-context-"));
  const workspaceRoot = join(fixtureDir, "workspace");
  const developerAgentPath = join(fixtureDir, "developer-ceremony-context-agent.js");
  const store = createStore({
    filename: join(fixtureDir, "floop.sqlite"),
    seedDemo: true,
    workspaceRoot,
  });

  writeFileSync(
    developerAgentPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const context = JSON.parse(fs.readFileSync(process.env.FLOOP_CONTEXT_PATH, "utf8"));
const ticket = context.ticket || {};
const text = JSON.stringify(ticket);
if (!text.includes("Blocking decisions are captured before work starts") || !text.includes("Review and validation evidence attached")) {
  fs.writeFileSync(
    process.env.FLOOP_RESULT_PATH,
    JSON.stringify({
      outcome: "blocked",
      summaryMd: "Developer could not see the applied ceremony decision.",
      remainingWorkMd: "Pass applied ceremony ticket decisions into execution context.",
      blockedKind: "needs_human_input"
    }),
  );
  process.exit(0);
}
fs.writeFileSync(
  process.env.FLOOP_RESULT_PATH,
  JSON.stringify({
    outcome: "completed",
    summaryMd: "Developer saw the applied ceremony decision."
  }),
);
`,
    { encoding: "utf8", mode: 0o755 },
  );

  try {
    store.updateProjectPolicy("project_floop", {
      requireReviewer: false,
      requireValidator: false,
    });
    store.updateRoleProfile("project_floop", "developer", {
      adapter: "shell",
      model: "fixture",
      config: {
        command: `"${process.execPath}" "${developerAgentPath}"`,
      },
    });
    const draft = store.createTicket("project_floop", {
      title: "Ceremony scoped implementation",
      brief: "Needs details.",
      assignedRole: "developer",
      state: "PROPOSED",
    });
    const run = store.createCeremonyRun("project_floop", {
      type: "refinement",
      createdByKind: "human",
      createdByRef: "test",
    });
    const proposal = run.proposals.find((item) => item.ticketId === draft.id && item.kind === "ticket_patch");
    store.applyCeremonyRun("project_floop", run.id, {
      proposalIds: [proposal.id],
    });
    store.transitionTicket("project_floop", draft.id, {
      targetState: "READY",
      reason: "Ceremony-refined ticket is ready for execution.",
      reasonCode: "operator_ready_after_ceremony",
    });

    const execution = store.createExecution("project_floop", draft.id, {
      role: "developer",
      reason: "Execute after refinement ceremony.",
    });
    const driver = createExecutionDriver({ store, logger: silentLogger() });
    await driver.pollOnce();

    const completed = store.getExecution("project_floop", execution.id);
    const context = JSON.parse(
      readFileSync(join(workspaceRoot, ".floop", "executions", execution.id, "context.json"), "utf8"),
    );

    assert.equal(completed.outcome, "completed");
    assert.match(context.ticket.acceptanceCriteriaMd, /Blocking decisions are captured/);
    assert.match(context.ticket.definitionOfDoneMd, /Review and validation evidence attached/);
  } finally {
    store.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("execution driver recovers filesystem git metadata read-only blocked completions", async () => {
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
    blockedKind: "filesystem_read_only_git_metadata",
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

test("execution driver resumes Codex exec sessions with steering prompts", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "floop-codex-steer-"));
  const workspaceRoot = join(fixtureDir, "workspace");
  const fakeCodexPath = join(fixtureDir, "fake-codex-resume.js");
  const argsPath = join(fixtureDir, "codex-args.json");
  const promptPath = join(fixtureDir, "codex-prompt.txt");
  const store = createStore({
    filename: join(fixtureDir, "floop.sqlite"),
    seedDemo: true,
    workspaceRoot,
  });

  writeFileSync(
    fakeCodexPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(promptPath)}, prompt);
  fs.writeFileSync(
    process.env.FLOOP_RESULT_PATH,
    JSON.stringify({ outcome: "completed", summaryMd: "Resumed Codex execution completed." }),
  );
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "codex-thread-steer" }) + "\\n");
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
      },
    });
    const execution = store.createExecution("project_floop", "ticket_project_floop_2", {
      role: "developer",
      reason: "Start work before steering.",
    });
    store.updateExecutionHarnessSession("project_floop", execution.id, {
      harnessKind: "codex_exec",
      externalThreadId: "codex-thread-steer",
      harnessCapabilities: ["queued_context", "interrupt_and_resume"],
    });
    const steered = store.steerExecution("project_floop", execution.id, {
      body: "Use SQLite and avoid Redis.",
      mode: "hard_steer",
      actor: "jacob",
      source: "human",
    });
    const driver = createExecutionDriver({ store, logger: silentLogger() });

    await driver.pollOnce();

    const args = JSON.parse(readFileSync(argsPath, "utf8"));
    const prompt = readFileSync(promptPath, "utf8");
    const completed = store.getExecution("project_floop", steered.delivery.resumedExecutionId);

    assert.deepEqual(args.slice(0, 4), ["exec", "--json", "resume", "codex-thread-steer"]);
    assert.match(prompt, /same native agent session could be steered/);
    assert.match(prompt, /Use SQLite and avoid Redis/);
    assert.equal(completed.outcome, "completed");
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
