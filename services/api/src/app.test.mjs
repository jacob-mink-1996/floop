import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFloopServer } from "./app.mjs";
import { createStore } from "./store.mjs";

async function withServer(run, options = {}) {
  const fixtureDir = mkdtempSync(join(tmpdir(), "floop-app-test-"));
  const store = createStore({
    filename: join(fixtureDir, "floop.sqlite"),
    seedDemo: options.seedDemo ?? true,
    workspaceRoot: options.workspaceRoot || "/workspace/floop",
  });
  const server = createFloopServer({
    store,
    host: options.host || "127.0.0.1",
    authToken: options.authToken || "",
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  try {
    await run(`http://127.0.0.1:${address.port}`, store);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    store.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  }
}

test("health endpoint responds successfully", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/health`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.service, "floop-api");
  });
});

test("non-loopback API mode requires a local trust token", async () => {
  assert.throws(
    () => createFloopServer({ host: "0.0.0.0" }),
    /FLOOP_AUTH_TOKEN/,
  );

  await withServer(
    async (baseUrl) => {
      const rejected = await fetch(`${baseUrl}/api/v1/health`);
      assert.equal(rejected.status, 401);

      const accepted = await fetch(`${baseUrl}/api/v1/health`, {
        headers: { authorization: "Bearer test-token" },
      });
      assert.equal(accepted.status, 200);
    },
    { host: "0.0.0.0", authToken: "test-token" },
  );
});

test("meta endpoint exposes runtime defaults for the web app", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/meta`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.name, "Floop");
    assert.equal(body.product, true);
    assert.equal(typeof body.workspaceRoot, "string");
    assert.equal(body.workspaceRoot.length > 0, true);
  });
});

test("directory browser returns local child directories", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "floop-directory-browser-"));
  try {
    mkdirSync(join(fixtureDir, "alpha"));
    mkdirSync(join(fixtureDir, ".hidden"));

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/fs/directories?path=${encodeURIComponent(fixtureDir)}`);
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.directory.path, fixtureDir);
      assert.equal(body.directory.parentPath, tmpdir());
      assert.deepEqual(
        body.directory.entries.map((entry) => entry.name),
        ["alpha", ".hidden"],
      );
      assert.equal(body.directory.entries.find((entry) => entry.name === ".hidden").hidden, true);
    });
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("directory creation creates missing local folders", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "floop-directory-create-"));
  const workspaceDir = join(fixtureDir, "new-workspace");
  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/fs/directories`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: workspaceDir }),
      });
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.directory.path, workspaceDir);
      assert.equal(existsSync(workspaceDir), true);
    });
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("git inspect derives repository metadata from an existing clone", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "floop-git-inspect-"));
  const repoDir = join(fixtureDir, "workspace-app");
  try {
    mkdirSync(repoDir);
    execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", "https://example.test/acme/workspace-app.git"], { cwd: repoDir });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/git/inspect`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ localPath: repoDir }),
      });
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.repo.name, "workspace-app");
      assert.equal(body.repo.slug, "workspace-app");
      assert.equal(body.repo.localPath, repoDir);
      assert.equal(body.repo.remoteUrl, "https://example.test/acme/workspace-app.git");
      assert.equal(body.repo.defaultBranch.length > 0, true);
      assert.equal(body.repo.isPrimary, true);
    });
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("git detect returns null for folders that are not git checkouts", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "floop-git-detect-"));
  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/git/detect`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ localPath: fixtureDir }),
      });
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.repo, null);
    });
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("git clone creates a local checkout and returns derived metadata", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "floop-git-clone-"));
  const remoteDir = join(fixtureDir, "remote.git");
  const cloneDir = join(fixtureDir, "workspace-clone");
  try {
    execFileSync("git", ["init", "--bare", remoteDir], { stdio: "ignore" });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/git/clone`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ remoteUrl: remoteDir, destinationPath: cloneDir }),
      });
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(existsSync(join(cloneDir, ".git")), true);
      assert.equal(body.repo.name, "workspace-clone");
      assert.equal(body.repo.slug, "workspace-clone");
      assert.equal(body.repo.localPath, cloneDir);
      assert.equal(body.repo.remoteUrl, remoteDir);
      assert.equal(body.repo.isPrimary, true);
    });
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("root route serves the operator web app", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/html/);
    assert.match(html, /Floop Mission Control/);
    assert.match(html, /<div id="root"><\/div>|status-banner/);
  });
});

test("web assets are served with the correct content type", async () => {
  await withServer(async (baseUrl) => {
    const rootResponse = await fetch(baseUrl);
    const html = await rootResponse.text();
    const moduleMatch = html.match(/src="([^"]+\.js)"/);
    const assetPath = moduleMatch?.[1] || "/app.js";
    const response = await fetch(`${baseUrl}${assetPath}`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/javascript/);
    assert.equal(body.length > 0, true);
  });
});

test("head requests succeed for web assets", async () => {
  await withServer(async (baseUrl) => {
    const rootResponse = await fetch(baseUrl);
    const html = await rootResponse.text();
    const moduleMatch = html.match(/src="([^"]+\.js)"/);
    const assetPath = moduleMatch?.[1] || "/app.js";
    const response = await fetch(`${baseUrl}${assetPath}`, { method: "HEAD" });
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/javascript/);
    assert.equal(body, "");
  });
});

test("project creation bootstraps a blank Floop workspace", async () => {
  await withServer(
    async (baseUrl) => {
      const projectsResponse = await fetch(`${baseUrl}/api/v1/projects`);
      const projectsBody = await projectsResponse.json();
      assert.equal(projectsResponse.status, 200);
      assert.deepEqual(projectsBody.projects, []);

      const createResponse = await fetch(`${baseUrl}/api/v1/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Client Zero",
          slug: "client-zero",
          workspaceRoot: "/workspace/client-zero",
          description: "Fresh project space for first-run setup.",
          defaultBaseBranch: "trunk",
        }),
      });
      const createBody = await createResponse.json();

      assert.equal(createResponse.status, 201);
      assert.equal(createBody.project.id, "project_client_zero");
      assert.equal(createBody.project.ticketCount, 0);
      assert.equal(createBody.project.defaultBaseBranch, "trunk");

      const boardResponse = await fetch(`${baseUrl}/api/v1/projects/${createBody.project.id}/board`);
      const boardBody = await boardResponse.json();
      assert.equal(boardResponse.status, 200);
      assert.equal(boardBody.board.projectName, "Client Zero");
      assert.equal(boardBody.board.totalTickets, 0);

      const repoResponse = await fetch(`${baseUrl}/api/v1/projects/${createBody.project.id}/repos`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "client-zero-app",
          slug: "client-zero-app",
          localPath: "/workspace/client-zero/app",
          defaultBranch: "trunk",
          isPrimary: true,
        }),
      });
      const repoBody = await repoResponse.json();
      assert.equal(repoResponse.status, 201);

      const ticketResponse = await fetch(`${baseUrl}/api/v1/projects/${createBody.project.id}/tickets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Stand up first backlog ticket",
          brief: "Prove the newly created project can accept work immediately.",
          state: "READY",
          assignedRole: "developer",
          repoTargets: [{ repoId: repoBody.repo.id, baseRef: "trunk" }],
        }),
      });
      const ticketBody = await ticketResponse.json();
      assert.equal(ticketResponse.status, 201);
      assert.equal(ticketBody.ticket.key, "FLOOP-1");
      assert.equal(ticketBody.ticket.repoTargets[0].repoId, repoBody.repo.id);
    },
    { seedDemo: false, workspaceRoot: "/workspace/blank-floop" },
  );
});

test("project deletion removes the project from API listings", async () => {
  await withServer(async (baseUrl) => {
    const deleteResponse = await fetch(`${baseUrl}/api/v1/projects/project_floop`, {
      method: "DELETE",
    });
    const deleteBody = await deleteResponse.json();
    assert.equal(deleteResponse.status, 200);
    assert.equal(deleteBody.project.id, "project_floop");

    const projectsResponse = await fetch(`${baseUrl}/api/v1/projects`);
    const projectsBody = await projectsResponse.json();
    assert.equal(projectsResponse.status, 200);
    assert.deepEqual(projectsBody.projects, []);

    const boardResponse = await fetch(`${baseUrl}/api/v1/projects/project_floop/board`);
    assert.equal(boardResponse.status, 404);

    const secondDeleteResponse = await fetch(`${baseUrl}/api/v1/projects/project_floop`, {
      method: "DELETE",
    });
    assert.equal(secondDeleteResponse.status, 404);
  });
});

test("board endpoint returns grouped lanes", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/projects/project_floop/board`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.board.projectId, "project_floop");
    assert.equal(findColumn(body.board.columns, "WORKING").count, 1);
    assert.equal(findColumn(body.board.columns, "READY").count, 1);
  });
});

test("project metadata can be patched through the API", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/projects/project_floop`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Floop Mission Control",
        description: "Operational cockpit for governed delivery.",
        workspaceRoot: "/workspace/floop-prod",
        defaultBaseBranch: "trunk",
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.project.name, "Floop Mission Control");
    assert.equal(body.project.description, "Operational cockpit for governed delivery.");
    assert.equal(body.project.workspaceRoot, "/workspace/floop-prod");
    assert.equal(body.project.defaultBaseBranch, "trunk");
  });
});

test("project policy and role profiles can be patched through the API", async () => {
  await withServer(async (baseUrl) => {
    const updatePolicyResponse = await fetch(`${baseUrl}/api/v1/projects/project_floop/policy`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requireReviewer: false,
        requireValidator: false,
        requireHumanApprovalBeforeMerge: false,
        requireDemoEvidenceBeforeMerge: false,
        requiredValidationCommandProfileForMerge: "ci",
        maxParallelExecutions: 6,
        maxParallelMerges: 2,
        maxAutoContinueIterations: 9,
        interactionMode: "operator_approved",
        agentCreatedTicketDefaultState: "READY",
        ceremonyAutomation: {
          enabled: true,
          mode: "operator_approved",
          triggers: {
            daily_triage: {
              enabled: true,
              minIntervalMinutes: 120,
              participantRoles: ["product_manager", "developer", "reviewer"],
              deciderRole: "product_manager",
            },
          },
        },
      }),
    });
    const updatePolicyBody = await updatePolicyResponse.json();

    const updateProfileResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/agent-profiles/developer`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          adapter: "codex-cli",
          model: "codex-max",
          config: { reasoning: "high" },
        }),
      },
    );
    const updateProfileBody = await updateProfileResponse.json();

    const profilesResponse = await fetch(`${baseUrl}/api/v1/projects/project_floop/agent-profiles`);
    const profilesBody = await profilesResponse.json();

    const projectResponse = await fetch(`${baseUrl}/api/v1/projects/project_floop`);
    const projectBody = await projectResponse.json();

    assert.equal(updatePolicyResponse.status, 200);
    assert.equal(updatePolicyBody.policy.maxParallelExecutions, 6);
    assert.equal(updatePolicyBody.policy.maxParallelMerges, 2);
    assert.equal(updatePolicyBody.policy.interactionMode, "operator_approved");
    assert.equal(updatePolicyBody.policy.requireReviewer, false);
    assert.equal(updatePolicyBody.policy.requireDemoEvidenceBeforeMerge, false);
    assert.equal(updatePolicyBody.policy.requiredValidationCommandProfileForMerge, "ci");
    assert.equal(updatePolicyBody.policy.ceremonyAutomation.enabled, true);
    assert.equal(updatePolicyBody.policy.ceremonyAutomation.triggers.daily_triage.minIntervalMinutes, 120);
    assert.equal(updateProfileResponse.status, 200);
    assert.equal(updateProfileBody.profile.role, "developer");
    assert.equal(updateProfileBody.profile.adapter, "codex-cli");
    assert.deepEqual(updateProfileBody.profile.config, { reasoning: "high" });
    assert.equal(profilesResponse.status, 200);
    assert.equal(profilesBody.profiles.find((profile) => profile.role === "developer").model, "codex-max");
    assert.equal(projectResponse.status, 200);
    assert.equal(projectBody.project.policy.maxAutoContinueIterations, 9);
    assert.equal(projectBody.project.policy.maxParallelMerges, 2);
    assert.equal(projectBody.project.policy.interactionMode, "operator_approved");
    assert.equal(projectBody.project.policy.requiredValidationCommandProfileForMerge, "ci");
    assert.equal(
      projectBody.project.roleProfiles.find((profile) => profile.role === "developer").adapter,
      "codex-cli",
    );
  });
});

test("ceremony endpoints create proposal runs and apply approved proposals", async () => {
  await withServer(async (baseUrl) => {
    const createTicketResponse = await fetch(`${baseUrl}/api/v1/projects/project_floop/tickets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "API ceremony refinement target",
        brief: "Needs a better plan.",
        state: "PROPOSED",
        priority: "medium",
        assignedRole: "developer",
      }),
    });
    const createTicketBody = await createTicketResponse.json();

    const runResponse = await fetch(`${baseUrl}/api/v1/projects/project_floop/ceremonies`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "refinement",
        participantRoles: ["product_manager", "developer", "developer", "reviewer"],
        deciderRole: "product_manager",
        consensusPolicy: "decider_synthesizes_objections",
      }),
    });
    const runBody = await runResponse.json();
    const proposal = runBody.ceremony.proposals.find(
      (item) => item.kind === "ticket_batch_patch" && item.payload.patches.some((patch) => patch.ticketId === createTicketBody.ticket.id),
    );

    const listResponse = await fetch(`${baseUrl}/api/v1/projects/project_floop/ceremonies`);
    const listBody = await listResponse.json();

    const applyResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/ceremonies/${runBody.ceremony.id}/apply`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ proposalIds: [proposal.id] }),
      },
    );
    const applyBody = await applyResponse.json();

    const ticketResponse = await fetch(`${baseUrl}/api/v1/projects/project_floop/tickets/${createTicketBody.ticket.id}`);
    const ticketBody = await ticketResponse.json();

    assert.equal(createTicketResponse.status, 201);
    assert.equal(runResponse.status, 201);
    assert.equal(runBody.ceremony.type, "refinement");
    assert.deepEqual(runBody.ceremony.participantRoles, ["product_manager", "developer", "reviewer"]);
    assert.equal(runBody.ceremony.deciderRole, "product_manager");
    assert.equal(runBody.ceremony.consensusPolicy, "decider_synthesizes_objections");
    assert.ok(proposal);
    assert.equal(listResponse.status, 200);
    assert.equal(listBody.ceremonies[0].id, runBody.ceremony.id);
    assert.equal(applyResponse.status, 200);
    assert.equal(applyBody.ceremony.proposals.find((item) => item.id === proposal.id).status, "applied");
    assert.match(ticketBody.ticket.acceptanceCriteriaMd, /Scope is explicit/);
  });
});

test("product autopilot starts from an idea ticket with lifecycle ceremony triggers", async () => {
  await withServer(async (baseUrl, store) => {
    const createTicketResponse = await fetch(`${baseUrl}/api/v1/projects/project_floop/tickets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Build a team calendar product",
        brief: "A greenfield product idea for shared calendars, event creation, and team availability.",
        state: "READY",
        priority: "high",
        assignedRole: "product_manager",
      }),
    });
    const createTicketBody = await createTicketResponse.json();

    const autopilotResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/tickets/${createTicketBody.ticket.id}/product-autopilot`,
      { method: "POST" },
    );
    const autopilotBody = await autopilotResponse.json();
    const breakdown = store
      .listTickets("project_floop", { parentTicketId: createTicketBody.ticket.id })
      .find((ticket) => /Break down/.test(ticket.title));

    assert.equal(createTicketResponse.status, 201);
    assert.equal(autopilotResponse.status, 200);
    assert.equal(autopilotBody.autopilot.policy.interactionMode, "fully_autonomous");
    assert.equal(autopilotBody.autopilot.policy.refinementMode, "autonomous");
    assert.equal(autopilotBody.autopilot.policy.requireReviewer, true);
    assert.equal(autopilotBody.autopilot.policy.requireValidator, true);
    assert.equal(autopilotBody.autopilot.policy.requireDemoEvidenceBeforeMerge, true);
    assert.equal(autopilotBody.autopilot.policy.ceremonyAutomation.enabled, true);
    assert.equal(autopilotBody.autopilot.policy.ceremonyAutomation.mode, "fully_automatic");
    assert.equal(autopilotBody.autopilot.policy.ceremonyAutomation.triggers.refinement.minIntervalMinutes, 10);
    assert.equal(autopilotBody.autopilot.policy.ceremonyAutomation.triggers.planning.minIntervalMinutes, 15);
    assert.equal(autopilotBody.autopilot.policy.ceremonyAutomation.triggers.daily_triage.minIntervalMinutes, 30);
    assert.equal(autopilotBody.autopilot.policy.ceremonyAutomation.triggers.review_demo_prep.minIntervalMinutes, 30);
    assert.equal(autopilotBody.autopilot.policy.ceremonyAutomation.triggers.work_generation.minIntervalMinutes, 60);
    assert.equal(autopilotBody.autopilot.policy.ceremonyAutomation.triggers.retro.minIntervalMinutes, 180);
    assert.equal(autopilotBody.autopilot.ceremony.type, "work_generation");
    assert.equal(autopilotBody.autopilot.breakdownTicket.id, breakdown.id);
    assert.equal(autopilotBody.autopilot.breakdownTicket.parentTicketId, createTicketBody.ticket.id);
    assert.equal(autopilotBody.autopilot.breakdownTicket.assignedRole, "product_manager");
    assert.equal(autopilotBody.autopilot.breakdownTicket.state, "WORKING");
    assert.equal(autopilotBody.autopilot.execution.role, "product_manager");
    assert.equal(autopilotBody.autopilot.execution.status, "running");
  });
});

test("run observability endpoint combines execution and ceremony runs", async () => {
  await withServer(async (baseUrl, store) => {
    const executionResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/tickets/ticket_project_floop_2/executions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          role: "developer",
          reason: "Expose execution in run observability.",
        }),
      },
    );
    const executionBody = await executionResponse.json();
    assert.equal(executionResponse.status, 201);
    store.claimExecution("project_floop", executionBody.execution.id, {
      claimToken: "test-worker",
      leaseMs: 60_000,
    });

    const ceremonyResponse = await fetch(`${baseUrl}/api/v1/projects/project_floop/ceremonies`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "daily_triage" }),
    });
    assert.equal(ceremonyResponse.status, 201);

    const runsResponse = await fetch(`${baseUrl}/api/v1/projects/project_floop/runs?limit=10`);
    const runsBody = await runsResponse.json();
    const executionRun = runsBody.observability.runs.find((run) => run.id === `execution:${executionBody.execution.id}`);

    assert.equal(runsResponse.status, 200);
    assert.equal(runsBody.observability.summary.total >= 2, true);
    assert.equal(Boolean(executionRun), true);
    assert.equal(executionRun.claimStatus, "claimed");
    assert.equal(executionRun.retryAttemptCount, 1);
    assert.equal(executionRun.worktreePaths.length > 0, true);
    assert.equal(Boolean(executionRun.movementReason.summary), true);
    assert.equal(runsBody.observability.runs.some((run) => run.kind === "ceremony" && run.needsAttention), true);
  });
});

test("run observability endpoint surfaces live agent logs for active executions", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "floop-live-agent-log-"));
  const workspaceRoot = join(fixtureDir, "workspace");
  try {
    await withServer(
      async (baseUrl, store) => {
        const executionResponse = await fetch(
          `${baseUrl}/api/v1/projects/project_floop/tickets/ticket_project_floop_2/executions`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              role: "developer",
              reason: "Expose live agent logs in run observability.",
            }),
          },
        );
        const executionBody = await executionResponse.json();
        assert.equal(executionResponse.status, 201);
        store.claimExecution("project_floop", executionBody.execution.id, {
          claimToken: "test-worker",
          leaseMs: 60_000,
        });

        const logRoot = join(workspaceRoot, ".floop", "artifacts", "executions", executionBody.execution.id);
        mkdirSync(logRoot, { recursive: true });
        writeFileSync(join(logRoot, "stdout.log"), "progress: implemented calendar route\n", "utf8");
        writeFileSync(join(logRoot, "stderr.log"), "question: should we validate recurrence?\n", "utf8");
        writeFileSync(
          join(logRoot, "agent-events.jsonl"),
          [
            JSON.stringify({ event: "process.output", stream: "stdout", text: "working on API smoke" }),
            JSON.stringify({ event: "process.output", stream: "stderr", text: "needs input for timezone?" }),
          ].join("\n") + "\n",
          "utf8",
        );

        const runsResponse = await fetch(`${baseUrl}/api/v1/projects/project_floop/runs?limit=10`);
        const runsBody = await runsResponse.json();
        const executionRun = runsBody.observability.runs.find((run) => run.id === `execution:${executionBody.execution.id}`);

        assert.equal(runsResponse.status, 200);
        assert.ok(executionRun);
        assert.equal(executionRun.status, "running");
        assert.equal(executionRun.liveAgentLog.available, true);
        assert.match(executionRun.liveAgentLog.stdoutTail, /implemented calendar route/);
        assert.match(executionRun.liveAgentLog.stderrTail, /validate recurrence/);
        assert.equal(executionRun.liveAgentLog.recentEvents.length, 2);
        assert.equal(executionRun.agentProgressSignalCount > 0, true);
        assert.equal(executionRun.agentQuestionSignalCount > 0, true);
        assert.match(executionRun.liveAgentLog.stdoutUri, /^file:/);
        assert.match(executionRun.liveAgentLog.agentEventsUri, /^file:/);
      },
      { workspaceRoot },
    );
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("blocked execution input requests can be answered through the API", async () => {
  await withServer(async (baseUrl) => {
    const executionResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/tickets/ticket_project_floop_2/executions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          role: "developer",
          reason: "Start work that needs an operator decision.",
        }),
      },
    );
    const executionBody = await executionResponse.json();
    assert.equal(executionResponse.status, 201);

    const completeResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/executions/${executionBody.execution.id}/complete`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          outcome: "blocked",
          summaryMd: "Need a product decision.",
          remainingWorkMd: "Choose whether reminders are in-app only or browser notifications.",
          blockedKind: "needs_human_input",
        }),
      },
    );
    assert.equal(completeResponse.status, 200);

    const requestsResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/agent-messages?intent=request_input&status=pending`,
    );
    const requestsBody = await requestsResponse.json();
    const request = requestsBody.messages.find(
      (message) => message.target.executionId === executionBody.execution.id,
    );

    assert.equal(requestsResponse.status, 200);
    assert.ok(request);
    assert.equal(request.target.ticketId, "ticket_project_floop_2");
    assert.equal(request.metadata.blockedKind, "needs_human_input");
    assert.equal(
      request.metadata.questionMd,
      "Choose whether reminders are in-app only or browser notifications.",
    );
    assert.equal(request.body, request.metadata.questionMd);

    const response = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/agent-messages/${request.id}/respond`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          responseMd: "Use in-app reminders first; browser notifications are out of scope.",
          responderKind: "human",
          responderRef: "jacob",
          continueExecution: true,
        }),
      },
    );
    const responseBody = await response.json();
    assert.equal(response.status, 200);
    assert.equal(responseBody.message.status, "accepted");
    assert.equal(responseBody.message.promotedKind, "execution");

    const ticketResponse = await fetch(`${baseUrl}/api/v1/projects/project_floop/tickets/ticket_project_floop_2`);
    const ticketBody = await ticketResponse.json();
    const continuedExecution = ticketBody.ticket.executions.find(
      (execution) => execution.role === "developer" && execution.iteration === 2,
    );

    assert.equal(ticketResponse.status, 200);
    assert.equal(ticketBody.ticket.state, "WORKING");
    assert.ok(continuedExecution);
    assert.equal(continuedExecution.status, "running");
  });
});

test("agent message response API rejects ordinary comments and stale HITL answers", async () => {
  await withServer(async (baseUrl) => {
    const commentResponse = await fetch(`${baseUrl}/api/v1/projects/project_floop/agent-messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actor: "architect",
        source: "agent",
        intent: "comment_on_ticket",
        target: { ticketId: "ticket_project_floop_2" },
        summary: "A useful ticket note",
        body: "This is context, not a blocked request response.",
      }),
    });
    const commentBody = await commentResponse.json();
    assert.equal(commentResponse.status, 201);

    const badResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/agent-messages/${commentBody.message.id}/respond`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          responseMd: "Continue with this.",
          responderKind: "human",
          responderRef: "jacob",
        }),
      },
    );
    const badBody = await badResponse.json();
    assert.equal(badResponse.status, 400);
    assert.equal(badBody.message, "Only input requests can be responded to");

    const executionResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/tickets/ticket_project_floop_2/executions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          role: "developer",
          reason: "Start work that needs one HITL answer.",
        }),
      },
    );
    const executionBody = await executionResponse.json();
    assert.equal(executionResponse.status, 201);

    const completeResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/executions/${executionBody.execution.id}/complete`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          outcome: "blocked",
          summaryMd: "Need one answer.",
          remainingWorkMd: "Pick the default calendar view.",
          blockedKind: "needs_human_input",
        }),
      },
    );
    assert.equal(completeResponse.status, 200);

    const requestsResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/agent-messages?intent=request_input&status=pending`,
    );
    const requestsBody = await requestsResponse.json();
    const request = requestsBody.messages.find(
      (message) => message.target.executionId === executionBody.execution.id,
    );
    assert.ok(request);

    const firstAnswerResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/agent-messages/${request.id}/respond`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          responseMd: "Month view.",
          responderKind: "human",
          responderRef: "jacob",
          continueExecution: false,
        }),
      },
    );
    assert.equal(firstAnswerResponse.status, 200);

    const staleAnswerResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/agent-messages/${request.id}/respond`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          responseMd: "Week view.",
          responderKind: "human",
          responderRef: "jacob",
        }),
      },
    );
    const staleAnswerBody = await staleAnswerResponse.json();
    assert.equal(staleAnswerResponse.status, 400);
    assert.equal(staleAnswerBody.message, "Input request is no longer pending");
  });
});

test("execution steering API records comments and resumes native harness sessions when available", async () => {
  await withServer(async (baseUrl, store) => {
    const executionResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/tickets/ticket_project_floop_2/executions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          role: "developer",
          reason: "Start execution before steering.",
        }),
      },
    );
    const executionBody = await executionResponse.json();
    assert.equal(executionResponse.status, 201);
    store.updateExecutionHarnessSession("project_floop", executionBody.execution.id, {
      harnessKind: "codex_exec",
      externalThreadId: "codex-thread-api",
      harnessCapabilities: ["queued_context", "interrupt_and_resume"],
    });

    const steerResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/executions/${executionBody.execution.id}/steer`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          body: "Use SQLite first and avoid Redis.",
          mode: "hard_steer",
          actor: "jacob",
          source: "human",
        }),
      },
    );
    const steerBody = await steerResponse.json();
    const original = store.getExecution("project_floop", executionBody.execution.id);

    assert.equal(steerResponse.status, 200);
    assert.equal(steerBody.steering.delivery.status, "resumed");
    assert.equal(original.outcome, "needs_continue");
    assert.equal(steerBody.steering.execution.externalThreadId, "codex-thread-api");
    assert.equal(steerBody.steering.execution.resumedFromExecutionId, executionBody.execution.id);
    assert.equal(steerBody.steering.message.metadata.deliveryStatus, "resumed");

    const secondSteerResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/executions/${executionBody.execution.id}/steer`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          body: "Second note should replace the first pending resume context.",
          mode: "hard_steer",
          actor: "jacob",
          source: "human",
        }),
      },
    );
    const secondSteerBody = await secondSteerResponse.json();

    assert.equal(secondSteerResponse.status, 200);
    assert.equal(secondSteerBody.steering.delivery.interruptedExecutionId, steerBody.steering.delivery.resumedExecutionId);
    assert.equal(secondSteerBody.steering.execution.resumedFromExecutionId, steerBody.steering.delivery.resumedExecutionId);
    assert.equal(secondSteerBody.steering.message.target.requestedExecutionId, executionBody.execution.id);
  });
});

test("API surfaces merge-policy blocks when validation profile does not satisfy policy", async () => {
  await withServer(async (baseUrl) => {
    await fetch(`${baseUrl}/api/v1/projects/project_floop/policy`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requireReviewer: false,
        requireValidator: true,
        requireHumanApprovalBeforeMerge: false,
        requiredValidationCommandProfileForMerge: "ci",
        interactionMode: "autonomous_with_review",
      }),
    });

    const executionResponse = await fetch(`${baseUrl}/api/v1/projects/project_floop/tickets/ticket_project_floop_2/executions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        role: "developer",
        reason: "Prepare merge policy validation mismatch.",
      }),
    });
    const executionBody = await executionResponse.json();

    await fetch(`${baseUrl}/api/v1/projects/project_floop/executions/${executionBody.execution.id}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        outcome: "completed",
        summaryMd: "Implementation completed for merge mismatch test.",
      }),
    });

    const ticketAfterImplementation = await fetch(`${baseUrl}/api/v1/projects/project_floop/tickets/ticket_project_floop_2`);
    const ticketAfterImplementationBody = await ticketAfterImplementation.json();
    const validatorExecution = ticketAfterImplementationBody.ticket.executions.find(
      (item) => item.role === "validator",
    );

    await fetch(`${baseUrl}/api/v1/projects/project_floop/executions/${validatorExecution.id}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        outcome: "completed",
        summaryMd: "Validation completed with the wrong profile.",
        validation: {
          verdict: "passed",
          commandProfile: "smoke",
          commands: ["npm test"],
          repoIds: ["repo_project_floop_floop"],
          summaryMd: "Validation passed but under the wrong profile.",
        },
      }),
    });

    const mergeStatusResponse = await fetch(`${baseUrl}/api/v1/projects/project_floop/tickets/ticket_project_floop_2/merge`);
    const mergeStatusBody = await mergeStatusResponse.json();
    assert.equal(mergeStatusResponse.status, 200);
    assert.equal(mergeStatusBody.merge.canMerge, false);
    assert.equal(mergeStatusBody.merge.readiness, "waiting");
    assert.equal(mergeStatusBody.merge.blockingReasons[0].code, "validation_profile_required");
    assert.match(mergeStatusBody.merge.statusSummary, /Latest validation must use ci profile before merge/);

    const mergeResponse = await fetch(`${baseUrl}/api/v1/projects/project_floop/tickets/ticket_project_floop_2/merge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        strategy: "squash",
      }),
    });
    const mergeBody = await mergeResponse.json();
    assert.equal(mergeResponse.status, 409);
    assert.equal(mergeBody.reasonCode, "validation_profile_required");
    assert.equal(mergeBody.merge.blockingReasons[0].code, "validation_profile_required");
    assert.match(mergeBody.message, /Latest validation must use ci profile before merge/);
  });
});

test("review and validation endpoints persist evidence and advance ticket state", async () => {
  await withServer(async (baseUrl) => {
    const executionResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/tickets/ticket_project_floop_2/executions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          role: "developer",
          reason: "Complete the contract implementation lane.",
        }),
      },
    );
    const executionBody = await executionResponse.json();
    assert.equal(executionResponse.status, 201);

    const completeResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/executions/${executionBody.execution.id}/complete`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          outcome: "completed",
          summaryMd: "Implementation is ready for reviewer evidence.",
          artifacts: [
            {
              kind: "patch",
              label: "Implementation diff",
              uri: "file:///workspace/floop/.floop/artifacts/floop-2.patch",
            },
          ],
        }),
      },
    );
    assert.equal(completeResponse.status, 200);

    const reviewResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/tickets/ticket_project_floop_2/reviews`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          executionId: executionBody.execution.id,
          verdict: "rework",
          summaryMd: "Reviewer found a routing issue.",
          artifacts: [
            {
              kind: "report",
              label: "Reviewer notes",
              uri: "file:///workspace/floop/.floop/artifacts/floop-2-review.md",
            },
          ],
          findings: [
            {
              severity: "high",
              category: "correctness",
              filePath: "services/api/src/app.mjs",
              lineNumber: 120,
              title: "Missing route guard",
              detailsMd: "The handler should reject invalid transitions.",
            },
          ],
        }),
      },
    );
    const reviewBody = await reviewResponse.json();
    assert.equal(reviewResponse.status, 201);
    assert.equal(reviewBody.review.findingsCount, 1);
    assert.equal(reviewBody.review.findings[0].severity, "high");
    assert.equal(reviewBody.review.artifacts[0].label, "Reviewer notes");

    const reviewListResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/tickets/ticket_project_floop_2/reviews`,
    );
    const reviewListBody = await reviewListResponse.json();
    assert.equal(reviewListResponse.status, 200);
    assert.equal(reviewListBody.reviews.length, 1);

    const ticketAfterReviewResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/tickets/ticket_project_floop_2`,
    );
    const ticketAfterReviewBody = await ticketAfterReviewResponse.json();
    assert.equal(ticketAfterReviewBody.ticket.state, "REWORK");
    assert.equal(ticketAfterReviewBody.ticket.reviews.length, 1);

    await fetch(`${baseUrl}/api/v1/projects/project_floop/tickets/ticket_project_floop_2/transition`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targetState: "VALIDATING",
        reason: "Rework landed and validation can begin.",
        reasonCode: "operator_validation_ready",
      }),
    });

    const validationResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/tickets/ticket_project_floop_2/validations`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          executionId: executionBody.execution.id,
          repoIds: ["repo_project_floop_floop"],
          commandProfile: "ci",
          commands: ["npm test"],
          verdict: "passed",
          summaryMd: "Validation checks passed.",
          artifacts: [
            {
              kind: "log",
              label: "Validation output",
              uri: "file:///workspace/floop/.floop/artifacts/floop-2-validation.log",
            },
          ],
        }),
      },
    );
    const validationBody = await validationResponse.json();
    assert.equal(validationResponse.status, 201);
    assert.equal(validationBody.validations.length, 1);
    assert.equal(validationBody.validations[0].verdict, "passed");
    assert.equal(validationBody.validations[0].artifacts[0].kind, "log");

    const validationListResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/tickets/ticket_project_floop_2/validations`,
    );
    const validationListBody = await validationListResponse.json();
    assert.equal(validationListResponse.status, 200);
    assert.equal(validationListBody.validations.length, 1);

    const ticketAfterValidationResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/tickets/ticket_project_floop_2`,
    );
    const ticketAfterValidationBody = await ticketAfterValidationResponse.json();
    assert.equal(ticketAfterValidationBody.ticket.state, "READY_TO_MERGE");
    assert.equal(ticketAfterValidationBody.ticket.validations.length, 1);
    assert.equal(
      ticketAfterValidationBody.ticket.executions.find((execution) => execution.id === executionBody.execution.id)
        .artifacts[0].label,
      "Implementation diff",
    );
    assert.equal(ticketAfterValidationBody.ticket.artifacts.length, 3);
  });
});

test("review and validation endpoints reject out-of-order evidence", async () => {
  await withServer(async (baseUrl) => {
    const executionResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/tickets/ticket_project_floop_2/executions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          role: "developer",
          reason: "Start implementation before evidence is ready.",
        }),
      },
    );
    const executionBody = await executionResponse.json();
    assert.equal(executionResponse.status, 201);

    const earlyReviewResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/tickets/ticket_project_floop_2/reviews`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          executionId: executionBody.execution.id,
          verdict: "passed",
        }),
      },
    );
    const earlyReviewBody = await earlyReviewResponse.json();
    assert.equal(earlyReviewResponse.status, 409);
    assert.equal(earlyReviewBody.reasonCode, "review_execution_not_finished");
    assert.match(earlyReviewBody.message, /must be finished before review/);

    await fetch(`${baseUrl}/api/v1/projects/project_floop/executions/${executionBody.execution.id}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        outcome: "completed",
        summaryMd: "Implementation is done and waiting on review.",
      }),
    });

    const earlyValidationResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/tickets/ticket_project_floop_2/validations`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          executionId: executionBody.execution.id,
          repoIds: ["repo_project_floop_floop"],
          verdict: "passed",
        }),
      },
    );
    const earlyValidationBody = await earlyValidationResponse.json();
    assert.equal(earlyValidationResponse.status, 409);
    assert.equal(earlyValidationBody.reasonCode, "ticket_not_ready_for_validation");
    assert.match(earlyValidationBody.message, /not ready for validation/);
  });
});

test("repo metadata can be patched through the API", async () => {
  await withServer(async (baseUrl) => {
    const createResponse = await fetch(`${baseUrl}/api/v1/projects/project_floop/repos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "floop-docs",
        slug: "floop-docs",
        localPath: "/workspace/floop/docs",
        defaultBranch: "main",
      }),
    });
    const created = await createResponse.json();

    const response = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/repos/${created.repo.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "floop-docs-site",
          localPath: "/workspace/floop/site",
          remoteUrl: "https://example.com/floop-docs.git",
          defaultBranch: "develop",
          isPrimary: true,
        }),
      },
    );
    const body = await response.json();

    assert.equal(createResponse.status, 201);
    assert.equal(response.status, 200);
    assert.equal(body.repo.name, "floop-docs-site");
    assert.equal(body.repo.localPath, "/workspace/floop/site");
    assert.equal(body.repo.remoteUrl, "https://example.com/floop-docs.git");
    assert.equal(body.repo.defaultBranch, "develop");
    assert.equal(body.repo.isPrimary, true);

    const reposResponse = await fetch(`${baseUrl}/api/v1/projects/project_floop/repos`);
    const reposBody = await reposResponse.json();
    assert.equal(reposBody.repos.filter((repo) => repo.isPrimary).length, 1);
    assert.equal(
      reposBody.repos.find((repo) => repo.id === "repo_project_floop_floop").isPrimary,
      false,
    );
  });
});

test("contract-backed payload validation returns client errors", async () => {
  await withServer(async (baseUrl) => {
    const invalidRepoResponse = await fetch(`${baseUrl}/api/v1/projects/project_floop/repos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "floop-docs",
        slug: "floop-docs",
        localPath: "/workspace/floop/docs",
        isPrimary: "yes",
      }),
    });
    const invalidRepoBody = await invalidRepoResponse.json();

    const invalidTicketResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/tickets/ticket_project_floop_2`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ priority: "critical" }),
      },
    );
    const invalidTicketBody = await invalidTicketResponse.json();

    assert.equal(invalidRepoResponse.status, 400);
    assert.match(invalidRepoBody.message, /isPrimary must be a boolean/);
    assert.equal(invalidTicketResponse.status, 400);
    assert.match(invalidTicketBody.message, /Invalid ticket priority/);
  });
});

test("ticket creation and transition flow works end-to-end", async () => {
  await withServer(async (baseUrl) => {
    const createdResponse = await fetch(`${baseUrl}/api/v1/projects/project_floop/tickets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Add integration tests",
        brief: "Create API integration coverage.",
        state: "READY",
        assignedRole: "developer",
        repoTargets: [{ repoId: "repo_project_floop_floop", baseRef: "main" }],
      }),
    });
    const createdBody = await createdResponse.json();

    const transitionedResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/tickets/${createdBody.ticket.id}/transition`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          targetState: "WORKING",
          reason: "Developer lane started.",
          reasonCode: "operator_started_work",
        }),
      },
    );
    const transitionedBody = await transitionedResponse.json();

    assert.equal(createdResponse.status, 201);
    assert.equal(transitionedResponse.status, 200);
    assert.equal(transitionedBody.ticket.state, "WORKING");
    assert.equal(transitionedBody.ticket.events.at(-1).type, "ticket.transitioned");
  });
});

test("ticket detail can be patched through the API", async () => {
  await withServer(async (baseUrl) => {
    const repoResponse = await fetch(`${baseUrl}/api/v1/projects/project_floop/repos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "floop-docs",
        slug: "floop-docs",
        localPath: "/workspace/floop/docs",
        defaultBranch: "trunk",
      }),
    });
    const repoBody = await repoResponse.json();

    const response = await fetch(`${baseUrl}/api/v1/projects/project_floop/tickets/ticket_project_floop_2`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Define operator transport contracts",
        parentTicketId: "ticket_project_floop_1",
        latestSummary: "Updated from mission control",
        acceptanceCriteriaMd: "- edit ticket detail\n- persist changes",
        repoTargets: [
          {
            repoId: repoBody.repo.id,
            targetScopeMd: "Docs and operator workflow notes",
          },
        ],
      }),
    });
    const body = await response.json();

    assert.equal(repoResponse.status, 201);
    assert.equal(response.status, 200);
    assert.equal(body.ticket.title, "Define operator transport contracts");
    assert.equal(body.ticket.parentTicketId, "ticket_project_floop_1");
    assert.equal(body.ticket.latestSummary, "Updated from mission control");
    assert.match(body.ticket.acceptanceCriteriaMd, /persist changes/);
    assert.equal(body.ticket.repoTargets.length, 1);
    assert.equal(body.ticket.repoTargets[0].repoId, repoBody.repo.id);
    assert.equal(body.ticket.repoTargets[0].baseRef, "trunk");
    assert.match(body.ticket.repoTargets[0].targetScopeMd, /Docs and operator workflow notes/);
    assert.equal(body.ticket.events.at(-1).type, "ticket.updated");
  });
});

test("ticket restart cancels active execution and deletes worktree through the API", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "floop-app-restart-workspace-"));
  try {
    await withServer(async (baseUrl) => {
      const executionResponse = await fetch(
        `${baseUrl}/api/v1/projects/project_floop/tickets/ticket_project_floop_1/executions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            role: "developer",
            reason: "Start a run that restart will cancel.",
          }),
        },
      );
      const executionBody = await executionResponse.json();
      const worktreePath = executionBody.execution.worktrees[0].path;
      mkdirSync(worktreePath, { recursive: true });

      const restartResponse = await fetch(
        `${baseUrl}/api/v1/projects/project_floop/tickets/ticket_project_floop_1/restart`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason: "Restart from API test." }),
        },
      );
      const restartBody = await restartResponse.json();

      assert.equal(executionResponse.status, 201);
      assert.equal(restartResponse.status, 200);
      assert.equal(restartBody.ticket.state, "READY");
      assert.equal(restartBody.ticket.executions[0].status, "cancelled");
      assert.equal(restartBody.ticket.worktrees[0].status, "cleaned");
      assert.equal(existsSync(worktreePath), false);
    }, { workspaceRoot });
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("ticket patch rejects repo targets outside the project", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/projects/project_floop/tickets/ticket_project_floop_2`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repoTargets: [{ repoId: "repo_does_not_exist" }],
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.match(body.message, /Unknown repo target/);
  });
});

test("ticket patch rejects invalid parent ticket changes", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/projects/project_floop/tickets/ticket_project_floop_2`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        parentTicketId: "ticket_project_floop_2",
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.match(body.message, /A ticket cannot parent itself/);
  });
});

test("dependency endpoints project ticket blockers and removal", async () => {
  await withServer(async (baseUrl) => {
    const addedResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/tickets/ticket_project_floop_2/dependencies`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          blockingTicketId: "ticket_project_floop_1",
          dependencyType: "finish_to_start",
        }),
      },
    );
    const addedBody = await addedResponse.json();

    assert.equal(addedResponse.status, 200);
    assert.equal(addedBody.ticket.dependencies.length, 1);
    assert.equal(addedBody.ticket.dependencies[0].blockingTicketTitle, "Stand up real API service skeleton");

    const removedResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/tickets/ticket_project_floop_2/dependencies/${addedBody.ticket.dependencies[0].id}`,
      {
        method: "DELETE",
      },
    );
    const removedBody = await removedResponse.json();

    assert.equal(removedResponse.status, 200);
    assert.equal(removedBody.ticket.dependencies.length, 0);
    assert.equal(removedBody.ticket.events.at(-1).type, "dependency.removed");
  });
});

test("dependency endpoint rejects missing blocker tickets with not found", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/tickets/ticket_project_floop_2/dependencies`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          blockingTicketId: "ticket_does_not_exist",
          dependencyType: "finish_to_start",
        }),
      },
    );
    const body = await response.json();

    assert.equal(response.status, 404);
    assert.equal(body.error, "not_found");
  });
});

test("API exposes a live SSE event stream for project activity", async () => {
  await withServer(async (baseUrl) => {
    const abortController = new AbortController();
    try {
      const response = await fetch(`${baseUrl}/api/v1/projects/project_floop/events/stream?limit=10`, {
        signal: abortController.signal,
      });

      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type"), /text\/event-stream/);

      const reader = response.body.getReader();
      const initialChunk = await readStreamChunk(reader);
      assert.match(initialChunk, /event: snapshot/);
      const initialSnapshot = parseFirstSsePayload(initialChunk);
      assert.equal(initialSnapshot.events[0].family.length > 0, true);
      assert.equal(initialSnapshot.events[0].lane.length > 0, true);
      assert.match(initialSnapshot.events[0].cursor, /:/);
      assert.equal(typeof initialSnapshot.events[0].reasonCode, "string");

      await fetch(`${baseUrl}/api/v1/projects/project_floop/tickets/ticket_project_floop_2/transition`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          targetState: "WORKING",
          reason: "Drive a live event for the stream.",
          reasonCode: "operator_started_work",
        }),
      });

      const nextChunk = await readStreamUntil(reader, /ticket\.transitioned|WORKING/);
      assert.match(nextChunk, /event: event/);
      assert.match(nextChunk, /ticket\.transitioned/);
      const nextEvent = parseLastSsePayload(nextChunk);
      assert.equal(nextEvent.family, "ticket");
      assert.equal(nextEvent.action, "transitioned");
      assert.equal(nextEvent.lane, "ticket");
      assert.equal(typeof nextEvent.reasonCode, "string");
    } finally {
      abortController.abort();
    }
  });
});

test("API streams HITL request answer and continuation lifecycle events", async () => {
  await withServer(async (baseUrl) => {
    const abortController = new AbortController();
    try {
      const response = await fetch(`${baseUrl}/api/v1/projects/project_floop/events/stream?limit=100`, {
        signal: abortController.signal,
      });
      assert.equal(response.status, 200);
      const reader = response.body.getReader();
      await readStreamChunk(reader);

      const executionResponse = await fetch(
        `${baseUrl}/api/v1/projects/project_floop/tickets/ticket_project_floop_2/executions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            role: "developer",
            reason: "Start work that will ask HITL in the event stream.",
          }),
        },
      );
      const executionBody = await executionResponse.json();
      assert.equal(executionResponse.status, 201);

      const completeResponse = await fetch(
        `${baseUrl}/api/v1/projects/project_floop/executions/${executionBody.execution.id}/complete`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            outcome: "blocked",
            summaryMd: "Need streamed user input.",
            remainingWorkMd: "Pick the streamed HITL behavior.",
            blockedKind: "needs_human_input",
          }),
        },
      );
      assert.equal(completeResponse.status, 200);

      const requestChunk = await readStreamUntil(reader, /agent\.message_received/, 5000);
      assert.match(requestChunk, /needs input|request input|agent\.message_received/);

      const requestsResponse = await fetch(
        `${baseUrl}/api/v1/projects/project_floop/agent-messages?intent=request_input&status=pending`,
      );
      const requestsBody = await requestsResponse.json();
      const request = requestsBody.messages.find(
        (message) => message.target.executionId === executionBody.execution.id,
      );
      assert.ok(request);

      const answerResponse = await fetch(
        `${baseUrl}/api/v1/projects/project_floop/agent-messages/${request.id}/respond`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            responseMd: "Use the streamed behavior.",
            responderKind: "human",
            responderRef: "jacob",
          }),
        },
      );
      assert.equal(answerResponse.status, 200);

      const answerChunk = await readStreamUntil(
        reader,
        /execution\.started[\s\S]*agent\.message_(attached|accepted)|agent\.message_(attached|accepted)[\s\S]*execution\.started/,
        5000,
      );
      assert.match(answerChunk, /Response to FLOOP-2 needs input|agent\.message_(attached|accepted)/);
      assert.match(answerChunk, /execution\.started/);
    } finally {
      abortController.abort();
    }
  });
});

function findColumn(columns, state) {
  return columns.find((column) => column.state === state);
}

async function readStreamChunk(reader, timeoutMs = 3000) {
  let timeout;
  const timedOut = new Promise((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`Timed out waiting for stream chunk after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  const { value, done } = await Promise.race([reader.read(), timedOut]).finally(() => {
    clearTimeout(timeout);
  });
  assert.equal(done, false);
  return new TextDecoder().decode(value);
}

async function readStreamUntil(reader, pattern, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let text = "";
  while (Date.now() < deadline) {
    text += await readStreamChunk(reader, Math.max(1, deadline - Date.now()));
    if (pattern.test(text)) {
      return text;
    }
  }
  throw new Error(`Timed out waiting for stream pattern: ${pattern}`);
}

function parseFirstSsePayload(text) {
  const match = text.match(/data: (.+)/);
  assert.ok(match);
  return JSON.parse(match[1]);
}

function parseLastSsePayload(text) {
  const matches = [...text.matchAll(/data: (.+)/g)];
  assert.ok(matches.length > 0);
  return JSON.parse(matches.at(-1)[1]);
}
