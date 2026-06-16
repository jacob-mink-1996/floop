import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";

import { createStore } from "./store.mjs";

test("store exposes seeded project summary", () => {
  const store = createStore({ filename: ":memory:", seedDemo: true });
  const projects = store.listProjects();

  assert.equal(projects.length, 1);
  assert.equal(projects[0].slug, "floop");
  assert.equal(projects[0].board.WORKING, 1);
  store.close();
});

test("store updates project metadata and records a project event", () => {
  const store = createStore({ filename: ":memory:", seedDemo: true });

  const updated = store.updateProject("project_floop", {
    name: "Floop Mission Control",
    description: "Operator surface for governed autonomous delivery.",
    workspaceRoot: "/workspace/floop-real",
    defaultBaseBranch: "trunk",
  });

  assert.equal(updated.name, "Floop Mission Control");
  assert.equal(updated.description, "Operator surface for governed autonomous delivery.");
  assert.equal(updated.workspaceRoot, "/workspace/floop-real");
  assert.equal(updated.defaultBaseBranch, "trunk");
  assert.equal(store.listEvents("project_floop").at(-1).type, "project.updated");
  store.close();
});

test("store expands home-relative project and repo paths before persistence", () => {
  const store = createStore({ filename: ":memory:", seedDemo: false });
  const project = store.createProject({
    name: "Home Paths",
    slug: "home-paths",
    workspaceRoot: "~/src/floop",
  });
  const repo = store.createRepo(project.id, {
    name: "Home Repo",
    slug: "home-repo",
    localPath: "~/src/floop",
  });
  const updatedProject = store.updateProject(project.id, {
    workspaceRoot: "~/src/floop-updated",
  });
  const updatedRepo = store.updateRepo(project.id, repo.id, {
    localPath: "~/src/floop-updated",
  });

  assert.equal(project.workspaceRoot, join(homedir(), "src/floop"));
  assert.equal(repo.localPath, join(homedir(), "src/floop"));
  assert.equal(updatedProject.workspaceRoot, join(homedir(), "src/floop-updated"));
  assert.equal(updatedRepo.localPath, join(homedir(), "src/floop-updated"));
  store.close();
});

test("store deletes projects and releases their slug", () => {
  const store = createStore({ filename: ":memory:", seedDemo: true });

  const deleted = store.deleteProject("project_floop");
  const recreated = store.createProject({
    name: "Floop Fresh",
    slug: "floop",
    workspaceRoot: "/workspace/floop-fresh",
    defaultBaseBranch: "main",
  });

  assert.equal(deleted.id, "project_floop");
  assert.equal(store.getProjectSummary("project_floop")?.name, "Floop Fresh");
  assert.equal(store.getProjectBoard("project_missing"), null);
  assert.equal(store.listProjects().length, 1);
  assert.equal(recreated.id, "project_floop");
  assert.equal(recreated.ticketCount, 0);
  assert.equal(recreated.repoCount, 0);
  store.close();
});

test("store updates project policy and role profiles", () => {
  const store = createStore({ filename: ":memory:", seedDemo: true });

  const updatedPolicy = store.updateProjectPolicy("project_floop", {
    requireReviewer: false,
    requireValidator: false,
    requireHumanApprovalBeforeMerge: false,
    requireDemoEvidenceBeforeMerge: false,
    maxParallelExecutions: 5,
    maxParallelMerges: 2,
    maxAutoContinueIterations: 8,
    interactionMode: "autonomous_with_review",
    refinementMode: "user_participant",
    agentCreatedTicketDefaultState: "READY",
    ceremonyAutomation: {
      enabled: true,
      mode: "fully_automatic",
      triggers: {
        refinement: {
          enabled: true,
          minIntervalMinutes: 15,
          participantRoles: ["product_manager", "developer"],
          deciderRole: "product_manager",
          consensusPolicy: "decider_synthesizes_objections",
        },
      },
    },
  });
  const updatedRoleProfile = store.updateRoleProfile("project_floop", "developer", {
    adapter: "codex-cli",
    model: "codex-max",
    config: { reasoning: "high", sandbox: "workspace-write" },
  });

  assert.equal(updatedPolicy.requireReviewer, false);
  assert.equal(updatedPolicy.requireValidator, false);
  assert.equal(updatedPolicy.requireHumanApprovalBeforeMerge, false);
  assert.equal(updatedPolicy.requireDemoEvidenceBeforeMerge, false);
  assert.equal(updatedPolicy.requiredValidationCommandProfileForMerge, "");
  assert.equal(updatedPolicy.maxParallelExecutions, 5);
  assert.equal(updatedPolicy.maxParallelMerges, 2);
  assert.equal(updatedPolicy.maxAutoContinueIterations, 8);
  assert.equal(updatedPolicy.interactionMode, "autonomous_with_review");
  assert.equal(updatedPolicy.refinementMode, "user_participant");
  assert.equal(updatedPolicy.agentCreatedTicketDefaultState, "READY");
  assert.equal(updatedPolicy.ceremonyAutomation.enabled, true);
  assert.equal(updatedPolicy.ceremonyAutomation.mode, "fully_automatic");
  assert.equal(updatedPolicy.ceremonyAutomation.triggers.refinement.minIntervalMinutes, 15);

  assert.equal(updatedRoleProfile.role, "developer");
  assert.equal(updatedRoleProfile.adapter, "codex-cli");
  assert.equal(updatedRoleProfile.model, "codex-max");
  assert.deepEqual(updatedRoleProfile.config, {
    reasoning: "high",
    sandbox: "workspace-write",
  });

  const project = store.getProjectSummary("project_floop");
  assert.equal(project.policy.maxParallelExecutions, 5);
  assert.equal(project.policy.maxParallelMerges, 2);
  assert.equal(project.policy.interactionMode, "autonomous_with_review");
  assert.equal(project.policy.refinementMode, "user_participant");
  assert.equal(project.policy.agentCreatedTicketDefaultState, "READY");
  assert.equal(project.policy.ceremonyAutomation.triggers.refinement.deciderRole, "product_manager");
  assert.equal(project.roleProfiles.find((profile) => profile.role === "developer").adapter, "codex-cli");
  assert.equal(store.listEvents("project_floop").at(-1).summary, "Floop developer profile updated");

  store.close();
});

test("store transitions tickets and records events", () => {
  const store = createStore({ filename: ":memory:", seedDemo: true });
  const created = store.createTicket("project_floop", {
    title: "Build board aggregates",
    brief: "Add richer board read models.",
    assignedRole: "developer",
    state: "READY",
  });

  const transitioned = store.transitionTicket("project_floop", created.id, {
    targetState: "WORKING",
    reason: "Developer picked it up.",
    reasonCode: "operator_started_work",
  });

  assert.equal(transitioned.state, "WORKING");
  assert.equal(transitioned.events.at(-1).type, "ticket.transitioned");
  assert.equal(transitioned.events.at(-1).family, "ticket");
  assert.equal(transitioned.events.at(-1).action, "transitioned");
  assert.equal(transitioned.events.at(-1).lane, "ticket");
  assert.equal(transitioned.events.at(-1).reasonCode, "operator_started_work");
  assert.equal(transitioned.events.at(-1).reasonSource, "operator");
  assert.match(transitioned.events.at(-1).cursor, /:/);
  store.close();
});

test("store requires reason codes for manual ticket overrides", () => {
  const store = createStore({ filename: ":memory:", seedDemo: true });
  const created = store.createTicket("project_floop", {
    title: "Override reason audit",
    brief: "Require a reason code for operator state changes.",
    assignedRole: "developer",
    state: "READY",
  });

  assert.throws(
    () =>
      store.transitionTicket("project_floop", created.id, {
        targetState: "WORKING",
        reason: "Missing structured reason code.",
      }),
    /reasonCode/,
  );
  store.close();
});

test("store rejects illegal automatic ticket transitions", () => {
  const store = createStore({ filename: ":memory:", seedDemo: true });
  const created = store.createTicket("project_floop", {
    title: "Illegal automatic transition",
    brief: "Automatic transitions must follow the workflow graph.",
    assignedRole: "developer",
    state: "DONE",
  });

  assert.throws(
    () =>
      store.transitionTicket("project_floop", created.id, {
        targetState: "WORKING",
        reason: "A worker cannot reopen done work automatically.",
        reasonCode: "execution_started",
        mode: "automatic",
      }),
    /Illegal automatic ticket transition/,
  );
  store.close();
});

test("store creates ceremony proposals and applies approved ticket patches", () => {
  const store = createStore({ filename: ":memory:", seedDemo: true });
  const draft = store.createTicket("project_floop", {
    title: "Thin refinement candidate",
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

  assert.ok(proposal);
  assert.equal(run.status, "proposed");
  assert.deepEqual(run.participantRoles, ["product_manager", "architect", "developer", "reviewer"]);
  assert.equal(run.deciderRole, "product_manager");
  assert.equal(run.consensusPolicy, "decider_synthesizes_objections");
  assert.equal(run.participants.length, 4);
  assert.equal(run.participants.every((participant) => participant.status === "pending"), true);
  assert.equal(proposal.status, "pending");

  const applied = store.applyCeremonyRun("project_floop", run.id, {
    proposalIds: [proposal.id],
  });
  const updated = store.getTicket("project_floop", draft.id);

  assert.equal(applied.proposals.find((item) => item.id === proposal.id).status, "applied");
  assert.match(updated.acceptanceCriteriaMd, /Scope is explicit/);
  assert.equal(store.listEvents("project_floop").at(-1).type, "ceremony.applied");
  store.close();
});

test("store can reconcile interrupted active executions after restart", () => {
  const store = createStore({ filename: ":memory:", seedDemo: true });
  const execution = store.createExecution("project_floop", "ticket_project_floop_2", {
    role: "developer",
    reason: "Start work before a restart.",
  });

  const recovered = store.reconcileActiveExecutions();
  const recoveredExecution = store.getExecution("project_floop", execution.id);
  const ticket = store.getTicket("project_floop", "ticket_project_floop_2");

  assert.equal(recovered.length, 1);
  assert.equal(recoveredExecution.outcome, "failed");
  assert.equal(recoveredExecution.failureKind, "interrupted");
  assert.match(recoveredExecution.summaryMd, /recovered after restart/i);
  assert.equal(ticket.state, "WORKING");
  assert.match(ticket.events.at(-1).summary, /failed/);
  assert.equal(ticket.events.at(-1).reasonCode, "interrupted");
  assert.equal(ticket.events.at(-1).reasonSource, "execution");
  store.close();
});

test("store execution claims prevent duplicate workers until the lease expires", () => {
  const store = createStore({ filename: ":memory:", seedDemo: true });
  const execution = store.createExecution("project_floop", "ticket_project_floop_2", {
    role: "developer",
    reason: "Claim this execution.",
  });

  const firstClaim = store.claimExecution("project_floop", execution.id, {
    claimToken: "worker-a",
    claimedAt: "2026-06-10T13:00:00.000Z",
    leaseMs: 10_000,
  });
  const secondClaim = store.claimExecution("project_floop", execution.id, {
    claimToken: "worker-b",
    claimedAt: "2026-06-10T13:00:05.000Z",
    leaseMs: 10_000,
  });
  const expiredClaim = store.claimExecution("project_floop", execution.id, {
    claimToken: "worker-b",
    claimedAt: "2026-06-10T13:00:11.000Z",
    leaseMs: 10_000,
  });

  assert.ok(firstClaim);
  assert.equal(secondClaim, null);
  assert.ok(expiredClaim);
  store.close();
});

test("store can reconcile interrupted active merge runs after restart", () => {
  const store = createStore({ filename: ":memory:", seedDemo: true });
  store.updateProjectPolicy("project_floop", {
    requireReviewer: false,
    requireValidator: false,
    requireHumanApprovalBeforeMerge: false,
  });
  const execution = store.createExecution("project_floop", "ticket_project_floop_2", {
    role: "developer",
    reason: "Get a merge-ready ticket before restart recovery.",
  });
  store.completeExecution("project_floop", execution.id, {
    outcome: "completed",
    summaryMd: "Merge-ready implementation completed.",
  });
  const started = store.startMergeRun("project_floop", "ticket_project_floop_2", {
    strategy: "squash",
    approvedByKind: "system",
    approvedByRef: "floop-auto",
    claimToken: "merge-worker",
    startedAt: "2026-06-10T13:00:00.000Z",
    leaseMs: 10_000,
  });

  const recovered = store.reconcileActiveMergeRuns();
  const mergeStatus = store.getMergeStatus("project_floop", "ticket_project_floop_2");
  const ticket = store.getTicket("project_floop", "ticket_project_floop_2");

  assert.ok(started);
  assert.equal(recovered.length, 1);
  assert.equal(mergeStatus.latestRun.status, "blocked");
  assert.equal(ticket.state, "BLOCKED");
  assert.equal(ticket.events.at(-1).reasonCode, "interrupted");
  store.close();
});

test("store enforces project merge concurrency limits", () => {
  const store = createStore({ filename: ":memory:", seedDemo: true });
  store.updateProjectPolicy("project_floop", {
    requireReviewer: false,
    requireValidator: false,
    requireHumanApprovalBeforeMerge: false,
    maxParallelMerges: 1,
  });

  const execution = store.createExecution("project_floop", "ticket_project_floop_2", {
    role: "developer",
    reason: "Prepare merge-ready implementation.",
  });
  store.completeExecution("project_floop", execution.id, {
    outcome: "completed",
    summaryMd: "Merge-ready implementation completed.",
  });

  store.startMergeRun("project_floop", "ticket_project_floop_2", {
    strategy: "squash",
    approvedByKind: "system",
    approvedByRef: "floop-auto",
    claimToken: "merge-worker-a",
  });

  const another = store.createTicket("project_floop", {
    title: "Second merge-ready ticket",
    brief: "Exercise merge concurrency guardrails.",
    assignedRole: "developer",
    state: "READY_TO_MERGE",
  });

  assert.throws(
    () =>
      store.startMergeRun("project_floop", another.id, {
        strategy: "squash",
        approvedByKind: "system",
        approvedByRef: "floop-auto",
        claimToken: "merge-worker-b",
      }),
    /Project merge limit reached for/,
  );

  store.close();
});

test("store filters tickets by parent ticket id", () => {
  const store = createStore({ filename: ":memory:", seedDemo: true });
  const parent = store.createTicket("project_floop", {
    title: "Split board work",
    brief: "Create child tasks for board slices.",
    assignedRole: "architect",
    state: "READY",
  });

  store.createTicket("project_floop", {
    title: "Build ticket filters",
    brief: "Add parent-linked child ticket.",
    assignedRole: "developer",
    state: "READY",
    parentTicketId: parent.id,
  });

  const children = store.listTickets("project_floop", { parentTicketId: parent.id });
  assert.equal(children.length, 1);
  assert.equal(children[0].parentTicketId, parent.id);
  store.close();
});

test("store rejects cyclic parent and dependency graphs", () => {
  const store = createStore({ filename: ":memory:", seedDemo: true });
  const parent = store.createTicket("project_floop", {
    title: "Planning parent",
    brief: "Top-level planning ticket.",
    assignedRole: "architect",
    state: "READY",
  });
  const child = store.createTicket("project_floop", {
    title: "Planning child",
    brief: "Child planning ticket.",
    assignedRole: "developer",
    state: "READY",
    parentTicketId: parent.id,
  });

  assert.throws(
    () =>
      store.updateTicket("project_floop", parent.id, {
        parentTicketId: child.id,
      }),
    new RegExp(`Parent cycle detected for ticket ${parent.id}`),
  );

  store.addDependency("project_floop", child.id, {
    blockingTicketId: parent.id,
    dependencyType: "finish_to_start",
  });
  assert.throws(
    () =>
      store.addDependency("project_floop", parent.id, {
        blockingTicketId: child.id,
        dependencyType: "finish_to_start",
      }),
    new RegExp(`Dependency cycle detected for ticket ${parent.id}`),
  );

  store.close();
});

test("store updates editable ticket fields and records an update event", () => {
  const store = createStore({ filename: ":memory:", seedDemo: true });
  const docsRepo = store.createRepo("project_floop", {
    slug: "floop-docs",
    name: "floop-docs",
    localPath: "/workspace/floop/docs",
    defaultBranch: "trunk",
    isPrimary: false,
  });

  const updated = store.updateTicket("project_floop", "ticket_project_floop_2", {
    title: "Define operator-facing transport contracts",
    brief: "Codify real project, repo, ticket, and event DTOs.",
    parentTicketId: "ticket_project_floop_1",
    priority: "urgent",
    assignedRole: "developer",
    latestSummary: "Contracts expanded for the board UI",
    acceptanceCriteriaMd: "- update persists\n- event recorded",
    definitionOfDoneMd: "- API returns updated detail",
    repoTargets: [
      {
        repoId: docsRepo.id,
        branchName: "floop-2-docs-contracts",
        targetScopeMd: "Docs plus API contract notes",
      },
    ],
  });

  assert.equal(updated.title, "Define operator-facing transport contracts");
  assert.equal(updated.parentTicketId, "ticket_project_floop_1");
  assert.equal(updated.priority, "urgent");
  assert.equal(updated.assignedRole, "developer");
  assert.match(updated.acceptanceCriteriaMd, /event recorded/);
  assert.equal(updated.repoTargets.length, 1);
  assert.equal(updated.repoTargets[0].repoId, docsRepo.id);
  assert.equal(updated.repoTargets[0].baseRef, "trunk");
  assert.equal(updated.repoTargets[0].branchName, "floop-2-docs-contracts");
  assert.equal(updated.events.at(-1).type, "ticket.updated");
  assert.match(updated.events.at(-1).detail, /latestSummary/);
  assert.match(updated.events.at(-1).detail, /repoTargets/);
  store.close();
});

test("store rejects duplicate or unknown repo targets during ticket updates", () => {
  const store = createStore({ filename: ":memory:", seedDemo: true });

  assert.throws(
    () =>
      store.updateTicket("project_floop", "ticket_project_floop_2", {
        repoTargets: [
          { repoId: "repo_project_floop_floop" },
          { repoId: "repo_project_floop_floop", branchName: "duplicate-target" },
        ],
      }),
    /Duplicate repo target/,
  );

  assert.throws(
    () =>
      store.updateTicket("project_floop", "ticket_project_floop_2", {
        repoTargets: [{ repoId: "repo_missing" }],
      }),
    /Unknown repo target/,
  );
  assert.throws(
    () =>
      store.updateTicket("project_floop", "ticket_project_floop_2", {
        parentTicketId: "ticket_project_floop_2",
      }),
    /A ticket cannot parent itself/,
  );
  store.close();
});

test("store adds and removes ticket dependencies with projected detail", () => {
  const store = createStore({ filename: ":memory:", seedDemo: true });

  const added = store.addDependency("project_floop", "ticket_project_floop_2", {
    blockingTicketId: "ticket_project_floop_1",
    dependencyType: "finish_to_start",
  });

  assert.equal(added.dependencies.length, 1);
  assert.equal(added.dependencies[0].blockingTicketKey, "FLOOP-1");
  assert.equal(added.dependencyCount, 1);
  assert.equal(added.events.at(-1).type, "dependency.added");

  const removed = store.removeDependency(
    "project_floop",
    "ticket_project_floop_2",
    added.dependencies[0].id,
  );

  assert.equal(removed.dependencies.length, 0);
  assert.equal(removed.dependencyCount, 0);
  assert.equal(removed.events.at(-1).type, "dependency.removed");
  store.close();
});

test("store updates repo metadata and keeps a single primary repo", () => {
  const store = createStore({ filename: ":memory:", seedDemo: true });

  const created = store.createRepo("project_floop", {
    slug: "floop-docs",
    name: "floop-docs",
    localPath: "/workspace/floop/docs",
    defaultBranch: "main",
    isPrimary: false,
  });

  const updated = store.updateRepo("project_floop", created.id, {
    name: "floop-docs-site",
    localPath: "/workspace/floop/site",
    remoteUrl: "https://example.com/floop-docs.git",
    defaultBranch: "develop",
    isPrimary: true,
  });

  assert.equal(updated.name, "floop-docs-site");
  assert.equal(updated.localPath, "/workspace/floop/site");
  assert.equal(updated.remoteUrl, "https://example.com/floop-docs.git");
  assert.equal(updated.defaultBranch, "develop");
  assert.equal(updated.isPrimary, true);

  const repos = store.listRepos("project_floop");
  assert.equal(repos.filter((repo) => repo.isPrimary).length, 1);
  assert.equal(repos.find((repo) => repo.id === "repo_project_floop_floop").isPrimary, false);
  assert.equal(store.listEvents("project_floop").at(-1).type, "repo.updated");
  store.close();
});

test("store persists execution history and routes ticket state from outcomes", () => {
  const store = createStore({ filename: ":memory:", seedDemo: true });
  store.updateProjectPolicy("project_floop", {
    interactionMode: "autonomous_with_review",
  });

  const started = store.createExecution("project_floop", "ticket_project_floop_2", {
    role: "developer",
    reason: "Start implementation on the contract surface.",
  });

  assert.equal(started.iteration, 1);
  assert.equal(started.status, "running");
  assert.equal(started.agentProfileId, "profile_project_floop_developer");
  assert.equal(started.worktrees.length, 1);
  assert.equal(started.worktrees[0].repoSlug, "floop");
  assert.match(started.worktrees[0].path, /\/\.floop\/worktrees\/floop-2\/floop\/iter-1$/);
  assert.equal(started.worktrees[0].status, "active");
  const listedActiveTicket = store
    .listTickets("project_floop")
    .find((ticket) => ticket.id === "ticket_project_floop_2");
  assert.equal(listedActiveTicket.activeExecutionCount, 1);
  assert.equal(listedActiveTicket.activeExecutionRole, "developer");

  const completed = store.completeExecution("project_floop", started.id, {
    outcome: "completed",
    summaryMd: "Execution landed the shared contract changes.",
  });

  assert.equal(completed.status, "completed");
  assert.equal(completed.outcome, "completed");
  assert.equal(completed.worktrees[0].status, "ready_for_review");

  const ticketAfterComplete = store.getTicket("project_floop", "ticket_project_floop_2");
  assert.equal(ticketAfterComplete.state, "REVIEWING");
  assert.equal(ticketAfterComplete.executions.length, 2);
  assert.equal(ticketAfterComplete.executions.some((execution) => execution.id === started.id), true);
  assert.equal(
    ticketAfterComplete.executions.find((execution) => execution.id === started.id).worktrees[0].status,
    "ready_for_review",
  );
  assert.equal(ticketAfterComplete.worktrees.length, 2);
  assert.equal(ticketAfterComplete.worktrees.some((worktree) => worktree.executionId === started.id), true);
  assert.equal(ticketAfterComplete.events.some((event) => event.type === "worktree.created"), true);

  const listedWorktrees = store.listWorktrees("project_floop", {
    ticketId: "ticket_project_floop_2",
    status: "ready_for_review",
  });
  assert.equal(listedWorktrees.length, 1);
  assert.equal(listedWorktrees[0].executionId, started.id);

  const cleaned = store.cleanWorktree("project_floop", started.worktrees[0].id, {
    reason: "Operator cleaned the completed contract worktree.",
  });
  assert.equal(cleaned.status, "cleaned");
  assert.ok(cleaned.cleanedAt);
  assert.equal(store.listEvents("project_floop").at(-1).type, "worktree.cleaned");

  const continuedSeed = store.createExecution("project_floop", "ticket_project_floop_1", {
    role: "developer",
    agentProfileId: "profile_project_floop_developer",
    reason: "Resume the API skeleton execution.",
  });
  const continued = store.continueExecution("project_floop", continuedSeed.id, {
    reason: "Carry the remaining work into a bounded continuation.",
  });

  assert.equal(continued.iteration, 2);
  assert.equal(continued.status, "running");
  assert.equal(continued.worktrees[0].status, "active");
  assert.match(continued.worktrees[0].path, /\/\.floop\/worktrees\/floop-1\/floop\/iter-2$/);

  const priorIteration = store
    .listExecutions("project_floop", "ticket_project_floop_1")
    .find((execution) => execution.id === continuedSeed.id);
  assert.equal(priorIteration.outcome, "needs_continue");

  const priorIterationDetail = store.getExecution("project_floop", continuedSeed.id);
  assert.equal(priorIterationDetail.worktrees[0].status, "needs_continue");

  assert.throws(
    () => store.cleanWorktree("project_floop", continued.worktrees[0].id),
    /Cannot clean an active worktree/,
  );

  const cancelled = store.cancelExecution("project_floop", continued.id, {
    reason: "Operator cancelled the stale continuation.",
  });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.failureKind, "cancelled");
  assert.equal(cancelled.worktrees[0].status, "cancelled");
  assert.equal(store.listEvents("project_floop").at(-1).type, "execution.completed");

  store.close();
});

test("store completes follow-up parent tickets and gates child readiness by refinement mode", () => {
  const store = createStore({ filename: ":memory:", seedDemo: true });
  store.updateProjectPolicy("project_floop", {
    refinementMode: "user_approved",
    agentCreatedTicketDefaultState: "READY",
  });

  const started = store.createExecution("project_floop", "ticket_project_floop_1", {
    role: "architect",
    reason: "Refine the Floop project into follow-up tickets.",
  });
  store.completeExecution("project_floop", started.id, {
    outcome: "followup_created",
    summaryMd: "Created implementation follow-ups.",
    followupTickets: [
      {
        title: "Implement refinement exit controls",
        brief: "Expose and enforce refinement exit policy.",
        state: "READY",
        assignedRole: "developer",
      },
    ],
  });

  const parent = store.getTicket("project_floop", "ticket_project_floop_1");
  const child = store.listTickets("project_floop", { parentTicketId: parent.id }).at(-1);

  assert.equal(parent.state, "DONE");
  assert.equal(started.worktrees[0].status, "active");
  assert.equal(store.getExecution("project_floop", started.id).worktrees[0].status, "handoff");
  assert.equal(child.state, "PROPOSED");

  store.updateProjectPolicy("project_floop", {
    refinementMode: "autonomous",
    agentCreatedTicketDefaultState: "READY",
  });
  const autonomousParent = store.createTicket("project_floop", {
    title: "Autonomous refinement parent",
    brief: "Creates ready child tickets automatically.",
    assignedRole: "architect",
    state: "READY",
  });
  const autonomousExecution = store.createExecution("project_floop", autonomousParent.id, {
    role: "architect",
    reason: "Autonomous refinement.",
  });
  store.completeExecution("project_floop", autonomousExecution.id, {
    outcome: "followup_created",
    summaryMd: "Created an autonomous follow-up.",
    followupTickets: [
      {
        title: "Ready autonomous child",
        brief: "This child can execute without user approval.",
        assignedRole: "developer",
      },
    ],
  });

  const autonomousTicket = store.getTicket("project_floop", autonomousParent.id);
  assert.equal(autonomousTicket.state, "DONE");
  assert.equal(store.listTickets("project_floop", { parentTicketId: autonomousParent.id }).at(-1).state, "READY");

  store.close();
});

test("store persists review and validation evidence and advances the ticket loop", () => {
  const store = createStore({ filename: ":memory:", seedDemo: true });

  const started = store.createExecution("project_floop", "ticket_project_floop_2", {
    role: "developer",
    reason: "Complete the contract implementation lane.",
  });
  store.completeExecution("project_floop", started.id, {
    outcome: "completed",
    summaryMd: "Implementation is ready for reviewer evidence.",
  });

  const review = store.createReview("project_floop", "ticket_project_floop_2", {
    executionId: started.id,
    verdict: "passed",
    summaryMd: "Reviewer found no blocking issues.",
  });
  assert.equal(review.verdict, "passed");
  assert.equal(review.findingsCount, 0);

  const ticketAfterReview = store.getTicket("project_floop", "ticket_project_floop_2");
  assert.equal(ticketAfterReview.state, "VALIDATING");
  assert.equal(ticketAfterReview.reviews.length, 1);
  assert.equal(ticketAfterReview.events.some((event) => event.type === "review.completed"), true);

  const validations = store.createValidation("project_floop", "ticket_project_floop_2", {
    executionId: started.id,
    repoIds: ["floop"],
    commandProfile: "ci",
    commands: ["npm test", "npm run lint"],
    verdict: "passed",
    summaryMd: "Validation passed for the targeted repo.",
  });
  assert.equal(validations.length, 1);
  assert.equal(validations[0].repoId, "repo_project_floop_floop");
  assert.equal(validations[0].repoSlug, "floop");
  assert.deepEqual(validations[0].commands, ["npm test", "npm run lint"]);

  const ticketAfterValidation = store.getTicket("project_floop", "ticket_project_floop_2");
  assert.equal(ticketAfterValidation.state, "READY_TO_MERGE");
  assert.equal(ticketAfterValidation.validations.length, 1);
  assert.equal(ticketAfterValidation.events.at(-1).type, "validation.completed");

  const listedTicket = store
    .listTickets("project_floop", { states: ["READY_TO_MERGE"] })
    .find((ticket) => ticket.id === "ticket_project_floop_2");
  assert.equal(listedTicket.latestReviewVerdict, "passed");
  assert.equal(listedTicket.latestValidationVerdict, "passed");

  const boardTicket = store
    .getProjectBoard("project_floop")
    .columns.find((column) => column.state === "READY_TO_MERGE")
    .tickets.find((ticket) => ticket.id === "ticket_project_floop_2");
  assert.equal(boardTicket.latestReviewVerdict, "passed");
  assert.equal(boardTicket.latestValidationVerdict, "passed");

  store.close();
});

test("store auto-routes next execution lanes after implementation and review completion", () => {
  const store = createStore({ filename: ":memory:", seedDemo: true });
  store.updateProjectPolicy("project_floop", {
    interactionMode: "autonomous_with_review",
  });

  const implementation = store.createExecution("project_floop", "ticket_project_floop_2", {
    role: "developer",
    reason: "Finish implementation and let Floop route review.",
  });
  store.completeExecution("project_floop", implementation.id, {
    outcome: "completed",
    summaryMd: "Implementation finished for autonomous review routing.",
  });

  const ticketAfterImplementation = store.getTicket("project_floop", "ticket_project_floop_2");
  assert.equal(ticketAfterImplementation.state, "REVIEWING");
  assert.equal(ticketAfterImplementation.executions.some((execution) => execution.role === "reviewer"), true);
  assert.equal(
    ticketAfterImplementation.executions.find((execution) => execution.role === "reviewer").status,
    "running",
  );

  const review = store.createReview("project_floop", "ticket_project_floop_2", {
    executionId: implementation.id,
    verdict: "passed",
    summaryMd: "Reviewer approved the implementation.",
  });
  assert.equal(review.verdict, "passed");

  const ticketAfterReview = store.getTicket("project_floop", "ticket_project_floop_2");
  assert.equal(ticketAfterReview.state, "VALIDATING");
  assert.equal(ticketAfterReview.executions.some((execution) => execution.role === "validator"), true);
  assert.equal(
    ticketAfterReview.executions.find((execution) => execution.role === "validator").status,
    "running",
  );

  store.close();
});

test("store auto-routes evidence lanes after non-developer worker completion", () => {
  const store = createStore({ filename: ":memory:", seedDemo: true });
  store.updateProjectPolicy("project_floop", {
    interactionMode: "autonomous_with_review",
  });

  const architecture = store.createExecution("project_floop", "ticket_project_floop_2", {
    role: "architect",
    reason: "Finish architecture and let Floop route review.",
  });
  store.completeExecution("project_floop", architecture.id, {
    outcome: "completed",
    summaryMd: "Architecture notes are ready for independent review.",
  });

  const ticketAfterArchitecture = store.getTicket("project_floop", "ticket_project_floop_2");
  assert.equal(ticketAfterArchitecture.state, "REVIEWING");
  const reviewerExecution = ticketAfterArchitecture.executions.find((execution) => execution.role === "reviewer");
  assert.ok(reviewerExecution);
  assert.match(reviewerExecution.worktrees[0].branchName, /reviewer-iter-1$/);
  assert.equal(reviewerExecution.worktrees[0].baseRef, architecture.worktrees[0].branchName);

  store.close();
});

test("store preserves evidence lane suffixes for long implementation branch names", () => {
  const store = createStore({ filename: ":memory:", seedDemo: true });
  const repo = store.listRepos("project_floop")[0];
  const longBranchName = "floop-3-calendar-vertical-slice-node-api-and-team-schedule-ui";
  assert.equal(longBranchName.length, 61);
  store.updateProjectPolicy("project_floop", {
    interactionMode: "autonomous_with_review",
  });

  const ticket = store.createTicket("project_floop", {
    title: "Calendar vertical slice: Node API and Team schedule UI",
    brief: "Exercise long branch review routing.",
    state: "READY",
    repoTargets: [
      {
        repoId: repo.id,
        baseRef: "main",
        branchName: longBranchName,
        targetScopeMd: "Long branch implementation.",
      },
    ],
  });

  const developer = store.createExecution("project_floop", ticket.id, {
    role: "developer",
    reason: "Complete long branch implementation.",
  });
  store.completeExecution("project_floop", developer.id, {
    outcome: "completed",
    summaryMd: "Implementation branch is ready.",
  });

  const updated = store.getTicket("project_floop", ticket.id);
  const reviewer = updated.executions.find((execution) => execution.role === "reviewer");

  assert.ok(reviewer);
  assert.equal(reviewer.worktrees[0].baseRef, longBranchName);
  assert.match(reviewer.worktrees[0].branchName, /-reviewer-iter-1$/);
  assert.notEqual(reviewer.worktrees[0].branchName, `${longBranchName}-r`.slice(0, 63));

  store.close();
});

test("store bases reviewer lanes on generated implementation branches when ticket target has no branch", () => {
  const store = createStore({ filename: ":memory:", seedDemo: true });
  const repo = store.listRepos("project_floop")[0];
  store.updateProjectPolicy("project_floop", {
    interactionMode: "autonomous_with_review",
  });

  const ticket = store.createTicket("project_floop", {
    title: "Build calendar vertical slice",
    brief: "Generated child ticket without an explicit branch.",
    state: "READY",
    repoTargets: [
      {
        repoId: repo.id,
        baseRef: "main",
        targetScopeMd: "Generated implementation ticket.",
      },
    ],
  });

  const developer = store.createExecution("project_floop", ticket.id, {
    role: "developer",
    reason: "Complete generated child implementation.",
  });
  store.completeExecution("project_floop", developer.id, {
    outcome: "completed",
    summaryMd: "Generated implementation branch is ready.",
  });

  const updated = store.getTicket("project_floop", ticket.id);
  const reviewer = updated.executions.find((execution) => execution.role === "reviewer");

  assert.ok(reviewer);
  assert.equal(reviewer.worktrees[0].baseRef, developer.worktrees[0].branchName);
  assert.match(reviewer.worktrees[0].branchName, /-reviewer-iter-1$/);
  assert.notEqual(reviewer.worktrees[0].baseRef, reviewer.worktrees[0].branchName);

  store.close();
});

test("store gates routine evidence lane dispatch by interaction mode", () => {
  const store = createStore({ filename: ":memory:", seedDemo: true });

  const manualExecution = store.createExecution("project_floop", "ticket_project_floop_2", {
    role: "developer",
    reason: "Manual mode should not auto-dispatch review.",
  });
  store.completeExecution("project_floop", manualExecution.id, {
    outcome: "completed",
    summaryMd: "Implementation finished under manual mode.",
  });
  const manualTicket = store.getTicket("project_floop", "ticket_project_floop_2");
  assert.equal(manualTicket.state, "REVIEWING");
  assert.equal(manualTicket.executions.some((execution) => execution.role === "reviewer"), false);
  assert.equal(store.listAgentMessages("project_floop", { intent: "suggest_dispatch" }).length, 0);

  const approvedTicket = store.createTicket("project_floop", {
    title: "Operator approved dispatch policy",
    brief: "Prove routine dispatch becomes an inbox suggestion.",
    state: "READY",
    priority: "medium",
    assignedRole: "developer",
  });
  store.updateProjectPolicy("project_floop", {
    interactionMode: "operator_approved",
  });
  const approvedExecution = store.createExecution("project_floop", approvedTicket.id, {
    role: "developer",
    reason: "Operator-approved mode should suggest review.",
  });
  store.completeExecution("project_floop", approvedExecution.id, {
    outcome: "completed",
    summaryMd: "Implementation finished under operator-approved mode.",
  });
  const approvedAfterComplete = store.getTicket("project_floop", approvedTicket.id);
  assert.equal(approvedAfterComplete.state, "REVIEWING");
  assert.equal(approvedAfterComplete.executions.some((execution) => execution.role === "reviewer"), false);
  const dispatchSuggestion = store
    .listAgentMessages("project_floop", { intent: "suggest_dispatch" })
    .find((message) => message.target.ticketId === approvedTicket.id);
  assert.ok(dispatchSuggestion);
  assert.equal(dispatchSuggestion.metadata.role, "reviewer");

  const autonomousTicket = store.createTicket("project_floop", {
    title: "Autonomous dispatch policy",
    brief: "Prove routine dispatch starts the next lane.",
    state: "READY",
    priority: "medium",
    assignedRole: "developer",
  });
  store.updateProjectPolicy("project_floop", {
    interactionMode: "autonomous_with_review",
  });
  const autonomousExecution = store.createExecution("project_floop", autonomousTicket.id, {
    role: "developer",
    reason: "Autonomous mode should start review.",
  });
  store.completeExecution("project_floop", autonomousExecution.id, {
    outcome: "completed",
    summaryMd: "Implementation finished under autonomous mode.",
  });
  const autonomousAfterComplete = store.getTicket("project_floop", autonomousTicket.id);
  assert.equal(autonomousAfterComplete.state, "REVIEWING");
  assert.equal(autonomousAfterComplete.executions.some((execution) => execution.role === "reviewer"), true);

  store.close();
});

test("store auto-promotes low-risk agent inbox messages in autopilot mode", () => {
  const store = createStore({ filename: ":memory:", seedDemo: true });
  store.updateProjectPolicy("project_floop", { interactionMode: "autopilot" });

  const comment = store.createAgentMessage("project_floop", {
    actor: "hermes",
    source: "webhook",
    intent: "comment_on_ticket",
    target: { ticketId: "ticket_project_floop_2" },
    summary: "External note",
    body: "Hermes saw a reusable transport-contract warning.",
  });
  assert.equal(comment.status, "attached");
  assert.equal(comment.promotedKind, "ticket_event");
  assert.equal(
    store
      .getTicket("project_floop", "ticket_project_floop_2")
      .events.some((event) => event.type === "agent.message_attached" && event.detail.includes("transport-contract warning")),
    true,
  );

  const artifact = store.createAgentMessage("project_floop", {
    actor: "openclaw",
    source: "webhook",
    intent: "submit_artifact",
    target: { ticketId: "ticket_project_floop_2" },
    summary: "External trace",
    metadata: {
      artifact: {
        kind: "record",
        label: "Autonomous trace",
        uri: "https://example.com/floop/autonomous-trace",
      },
    },
  });
  assert.equal(artifact.status, "accepted");
  assert.equal(artifact.promotedKind, "artifact");
  assert.equal(
    store
      .listArtifacts("project_floop", { ticketId: "ticket_project_floop_2", kind: "record" })
      .some((item) => item.label === "Autonomous trace"),
    true,
  );

  const ceremony = store.createCeremonyRun("project_floop", { type: "daily_triage" });
  const ceremonyInput = store.createAgentMessage("project_floop", {
    actor: "hermes",
    source: "webhook",
    intent: "submit_ceremony_input",
    target: { runId: ceremony.id },
    summary: "External triage input",
    body: "Hermes recommends prioritizing transport-contract warnings.",
  });
  assert.equal(ceremonyInput.status, "accepted");
  assert.equal(ceremonyInput.promotedKind, "ceremony_proposal");
  assert.equal(
    store
      .getCeremonyRun("project_floop", ceremony.id)
      .proposals.some((proposal) => proposal.id === ceremonyInput.promotedRef && proposal.payload.agentMessageId === ceremonyInput.id),
    true,
  );

  const suggestion = store.createAgentMessage("project_floop", {
    actor: "openclaw",
    source: "webhook",
    intent: "suggest_ticket",
    target: { repoId: "repo_project_floop_floop" },
    summary: "Add a new follow-up",
  });
  const risk = store.createAgentMessage("project_floop", {
    actor: "hermes",
    source: "webhook",
    intent: "raise_risk",
    target: { ticketId: "ticket_project_floop_2" },
    summary: "Risk needs operator attention",
  });
  assert.equal(suggestion.status, "pending");
  assert.equal(risk.status, "pending");

  store.close();
});

test("store acts on broad agent inbox messages in fully autonomous mode", () => {
  const store = createStore({ filename: ":memory:", seedDemo: true });
  store.updateProjectPolicy("project_floop", {
    interactionMode: "fully_autonomous",
    maxParallelExecutions: 10,
  });

  const suggestion = store.createAgentMessage("project_floop", {
    actor: "openclaw",
    source: "webhook",
    intent: "suggest_ticket",
    target: { repoId: "repo_project_floop_floop" },
    summary: "Add autonomous fixture coverage",
    body: "OpenClaw found missing fixture coverage.",
    metadata: { role: "developer" },
  });
  assert.equal(suggestion.status, "converted");
  assert.equal(suggestion.promotedKind, "ticket");
  const createdTicket = store.getTicket("project_floop", suggestion.promotedRef);
  assert.equal(createdTicket.state, "WORKING");
  assert.equal(createdTicket.priority, "medium");
  assert.equal(createdTicket.executions.some((execution) => execution.role === "developer" && execution.status === "running"), true);

  const risk = store.createAgentMessage("project_floop", {
    actor: "hermes",
    source: "webhook",
    intent: "raise_risk",
    target: { repoId: "repo_project_floop_floop" },
    summary: "Transport risk needs mitigation",
    body: "Hermes found a likely transport regression.",
  });
  assert.equal(risk.status, "converted");
  assert.equal(risk.promotedKind, "ticket");
  const riskTicket = store.getTicket("project_floop", risk.promotedRef);
  assert.equal(riskTicket.priority, "urgent");
  assert.equal(riskTicket.state, "WORKING");

  const dispatch = store.createAgentMessage("project_floop", {
    actor: "hermes",
    source: "webhook",
    intent: "suggest_dispatch",
    target: { ticketId: "ticket_project_floop_2" },
    summary: "Run architect lane",
    metadata: { role: "architect" },
  });
  assert.equal(dispatch.status, "attached");
  assert.equal(dispatch.promotedKind, "execution");
  assert.equal(
    store
      .getTicket("project_floop", "ticket_project_floop_2")
      .executions.some((execution) => execution.id === dispatch.promotedRef && execution.role === "architect"),
    true,
  );

  store.close();
});

test("store creates and answers ticket unblock requests from blocked executions", () => {
  const store = createStore({ filename: ":memory:", seedDemo: true });
  store.updateProjectPolicy("project_floop", {
    interactionMode: "autonomous_with_review",
  });

  const execution = store.createExecution("project_floop", "ticket_project_floop_2", {
    role: "developer",
    reason: "Start work that needs input.",
  });
  store.completeExecution("project_floop", execution.id, {
    outcome: "blocked",
    summaryMd: "Need a product decision.",
    remainingWorkMd: "Choose whether reminders are in-app only or browser notifications.",
    blockedKind: "needs_human_input",
  });

  const request = store
    .listAgentMessages("project_floop", { intent: "request_input", status: "pending" })
    .find((message) => message.target.executionId === execution.id);
  assert.ok(request);
  assert.equal(request.target.ticketId, "ticket_project_floop_2");
  assert.equal(request.metadata.blockedKind, "needs_human_input");
  assert.equal(
    request.metadata.questionMd,
    "Choose whether reminders are in-app only or browser notifications.",
  );
  assert.equal(request.body, request.metadata.questionMd);
  assert.equal(store.getTicket("project_floop", "ticket_project_floop_2").state, "BLOCKED");

  const questionComment = store
    .listAgentMessages("project_floop", { intent: "comment_on_ticket" })
    .find((message) => message.metadata.requestInputMessageId === request.id);
  assert.ok(questionComment);
  assert.equal(questionComment.status, "pending");
  assert.equal(questionComment.body, request.metadata.questionMd);
  assert.equal(questionComment.metadata.hitlQuestion, true);

  const answered = store.respondAgentMessage("project_floop", request.id, {
    responseMd: "Use in-app reminders first; browser notifications are out of scope.",
    responderKind: "human",
    responderRef: "jacob",
    continueExecution: true,
  });
  const ticket = store.getTicket("project_floop", "ticket_project_floop_2");
  const continuedExecution = ticket.executions.find((item) => item.role === "developer" && item.iteration === 2);

  assert.equal(answered.status, "accepted");
  assert.equal(answered.promotedKind, "execution");
  assert.ok(continuedExecution);
  assert.equal(continuedExecution.status, "running");
  assert.equal(ticket.state, "WORKING");
  assert.equal(
    store
      .listAgentMessages("project_floop", { intent: "comment_on_ticket", status: "attached" })
      .some((message) => message.metadata.responseToMessageId === request.id),
    true,
  );

  store.close();
});

test("store surfaces blocked questions as attached ticket comments in fully autonomous mode", () => {
  const store = createStore({ filename: ":memory:", seedDemo: true });
  store.updateProjectPolicy("project_floop", {
    interactionMode: "fully_autonomous",
  });

  const execution = store.createExecution("project_floop", "ticket_project_floop_2", {
    role: "architect",
    reason: "Define the system with room for questions.",
  });
  store.completeExecution("project_floop", execution.id, {
    outcome: "blocked",
    summaryMd: "Need a product decision.",
    remainingWorkMd: "Should the calendar support shared team availability or only personal events?",
    blockedKind: "needs_human_input",
  });

  const request = store
    .listAgentMessages("project_floop", { intent: "request_input", status: "pending" })
    .find((message) => message.target.executionId === execution.id);
  const questionComment = store
    .listAgentMessages("project_floop", { intent: "comment_on_ticket", status: "attached" })
    .find((message) => message.metadata.requestInputMessageId === request?.id);

  assert.ok(request);
  assert.ok(questionComment);
  assert.equal(questionComment.promotedKind, "ticket_event");
  assert.equal(questionComment.body, request.metadata.questionMd);
  assert.equal(questionComment.metadata.hitlQuestion, true);

  store.close();
});

test("store does not treat ordinary ticket comments as unblock responses", () => {
  const store = createStore({ filename: ":memory:", seedDemo: true });
  const execution = store.createExecution("project_floop", "ticket_project_floop_2", {
    role: "developer",
    reason: "Start work before a normal comment arrives.",
  });
  store.completeExecution("project_floop", execution.id, {
    outcome: "blocked",
    summaryMd: "Need input before continuing.",
    remainingWorkMd: "Which reminder channel should be implemented first?",
    blockedKind: "needs_human_input",
  });

  const ordinaryComment = store.createAgentMessage("project_floop", {
    actor: "jacob",
    source: "human",
    intent: "comment_on_ticket",
    target: { ticketId: "ticket_project_floop_2" },
    summary: "Related note",
    body: "This is useful context, but it is not an answer to the blocked request.",
  });

  assert.throws(
    () => store.respondAgentMessage("project_floop", ordinaryComment.id, {
      responseMd: "Continue.",
      responderKind: "human",
      responderRef: "jacob",
    }),
    /Only input requests can be responded to/,
  );
  assert.equal(
    store
      .getTicket("project_floop", "ticket_project_floop_2")
      .executions.some((item) => item.role === "developer" && item.iteration === 2),
    false,
  );

  store.close();
});

test("store can persist a review directly from reviewer execution completion", () => {
  const store = createStore({ filename: ":memory:", seedDemo: true });
  store.updateProjectPolicy("project_floop", {
    interactionMode: "autonomous_with_review",
  });

  const implementation = store.createExecution("project_floop", "ticket_project_floop_2", {
    role: "developer",
    reason: "Finish implementation and auto-route review.",
  });
  store.completeExecution("project_floop", implementation.id, {
    outcome: "completed",
    summaryMd: "Implementation finished for embedded reviewer evidence.",
  });

  const reviewerExecution = store
    .getTicket("project_floop", "ticket_project_floop_2")
    .executions.find((execution) => execution.role === "reviewer");
  assert.ok(reviewerExecution);

  store.completeExecution("project_floop", reviewerExecution.id, {
    outcome: "completed",
    summaryMd: "Reviewer execution finished.",
    review: {
      verdict: "passed",
      summaryMd: "Reviewer found no blocking issues.",
      artifacts: [{ kind: "report", label: "Reviewer notes", uri: "file:///tmp/review.md" }],
      findings: [],
    },
  });

  const ticketAfterReview = store.getTicket("project_floop", "ticket_project_floop_2");
  assert.equal(ticketAfterReview.state, "VALIDATING");
  assert.equal(ticketAfterReview.reviews.length, 1);
  assert.equal(ticketAfterReview.reviews[0].artifacts[0].label, "Reviewer notes");
  assert.equal(ticketAfterReview.executions.some((execution) => execution.role === "validator"), true);

  store.close();
});

test("store can persist validation directly from validator execution completion", () => {
  const store = createStore({ filename: ":memory:", seedDemo: true });
  store.updateProjectPolicy("project_floop", {
    requireReviewer: false,
    requireValidator: true,
    interactionMode: "autonomous_with_review",
  });

  const implementation = store.createExecution("project_floop", "ticket_project_floop_2", {
    role: "developer",
    reason: "Finish implementation and auto-route validation.",
  });
  store.completeExecution("project_floop", implementation.id, {
    outcome: "completed",
    summaryMd: "Implementation finished for embedded validator evidence.",
  });

  const validatorExecution = store
    .getTicket("project_floop", "ticket_project_floop_2")
    .executions.find((execution) => execution.role === "validator");
  assert.ok(validatorExecution);

  store.completeExecution("project_floop", validatorExecution.id, {
    outcome: "completed",
    summaryMd: "Validator execution finished.",
    validation: {
      verdict: "passed",
      commandProfile: "ci",
      commands: ["npm test"],
      artifacts: [{ kind: "log", label: "Validation output", uri: "file:///tmp/validation.log" }],
      repoIds: ["repo_project_floop_floop"],
      summaryMd: "Validation checks passed.",
    },
  });

  const ticketAfterValidation = store.getTicket("project_floop", "ticket_project_floop_2");
  assert.equal(ticketAfterValidation.state, "READY_TO_MERGE");
  assert.equal(ticketAfterValidation.validations.length, 1);
  assert.equal(ticketAfterValidation.validations[0].artifacts[0].label, "Validation output");

  store.close();
});

test("store keeps ticket summaries compact while preserving full agent evidence", () => {
  const store = createStore({ filename: ":memory:", seedDemo: true });
  store.updateProjectPolicy("project_floop", {
    requireReviewer: false,
    requireValidator: true,
    requireHumanApprovalBeforeMerge: false,
    requireDemoEvidenceBeforeMerge: true,
    interactionMode: "autonomous_with_review",
  });

  const longImplementationSummary = [
    "Implementation plan: built the calendar workflow and updated the API surface for the feature.",
    "",
    "Details:",
    "- Added multiple files.",
    "- Ran local checks.",
    "- Prepared validation notes.",
  ].join("\n");
  const implementation = store.createExecution("project_floop", "ticket_project_floop_2", {
    role: "developer",
    reason: "Finish implementation with verbose evidence.",
  });
  store.completeExecution("project_floop", implementation.id, {
    outcome: "completed",
    summaryMd: longImplementationSummary,
  });

  const ticketAfterImplementation = store.getTicket("project_floop", "ticket_project_floop_2");
  assert.equal(store.getExecution("project_floop", implementation.id).summaryMd, longImplementationSummary);
  assert.equal(ticketAfterImplementation.latestSummary.includes("\n"), false);
  assert.equal(ticketAfterImplementation.latestSummary.length <= 140, true);

  const longValidationSummary = [
    "Validation plan: run API checks, inspect the browser demo path, and capture demo evidence before merge.",
    "",
    "Checks run: npm test, browser smoke, and artifact inspection.",
    "",
    "Why sufficient: the checks cover the acceptance criteria and the demo artifact proves the workflow is present.",
    "",
    "Result: passed.",
  ].join("\n");
  const validatorExecution = ticketAfterImplementation.executions.find((execution) => execution.role === "validator");
  store.completeExecution("project_floop", validatorExecution.id, {
    outcome: "completed",
    summaryMd: "Validator execution completed.",
    validation: {
      verdict: "passed",
      commandProfile: "ci",
      commands: ["npm test"],
      repoIds: ["repo_project_floop_floop"],
      summaryMd: longValidationSummary,
      artifacts: [{ kind: "demo", label: "Calendar demo evidence", uri: "file:///tmp/calendar-demo.md" }],
    },
  });

  const ticketAfterValidation = store.getTicket("project_floop", "ticket_project_floop_2");
  assert.equal(ticketAfterValidation.validations[0].summaryMd, longValidationSummary);
  assert.equal(ticketAfterValidation.latestSummary.includes("\n"), false);
  assert.equal(ticketAfterValidation.latestSummary.length <= 140, true);
  assert.match(ticketAfterValidation.latestSummary, /^Validation plan:/);

  store.close();
});

test("store enforces review and validation sequencing", () => {
  const store = createStore({ filename: ":memory:", seedDemo: true });

  const execution = store.createExecution("project_floop", "ticket_project_floop_2", {
    role: "developer",
    reason: "Start implementation before evidence lanes.",
  });

  assert.throws(
    () =>
      store.createReview("project_floop", "ticket_project_floop_2", {
        executionId: execution.id,
        verdict: "passed",
      }),
    new RegExp(`Execution ${execution.id} must be finished before review`),
  );

  store.completeExecution("project_floop", execution.id, {
    outcome: "completed",
    summaryMd: "Implementation finished and ready for review.",
  });

  assert.throws(
    () =>
      store.createValidation("project_floop", "ticket_project_floop_2", {
        executionId: execution.id,
        repoIds: ["repo_project_floop_floop"],
        verdict: "passed",
      }),
    /Ticket FLOOP-2 is not ready for validation/,
  );

  store.createReview("project_floop", "ticket_project_floop_2", {
    executionId: execution.id,
    verdict: "passed",
  });

  assert.throws(
    () =>
      store.createReview("project_floop", "ticket_project_floop_2", {
        executionId: execution.id,
        verdict: "passed",
      }),
    /Ticket FLOOP-2 is not ready for review/,
  );

  store.close();
});

test("store respects review and validation policy skips after execution completion", () => {
  const store = createStore({ filename: ":memory:", seedDemo: true });
  store.updateProjectPolicy("project_floop", {
    requireReviewer: false,
    requireValidator: true,
  });

  const execution = store.createExecution("project_floop", "ticket_project_floop_2", {
    role: "developer",
    reason: "Finish the implementation without a reviewer lane.",
  });
  store.completeExecution("project_floop", execution.id, {
    outcome: "completed",
    summaryMd: "Implementation completed under relaxed review policy.",
  });

  assert.equal(store.getTicket("project_floop", "ticket_project_floop_2").state, "VALIDATING");

  store.updateProjectPolicy("project_floop", {
    requireReviewer: false,
    requireValidator: false,
  });
  const secondExecution = store.createExecution("project_floop", "ticket_project_floop_1", {
    role: "developer",
    reason: "Finish a ticket with all gates disabled.",
  });
  store.completeExecution("project_floop", secondExecution.id, {
    outcome: "completed",
    summaryMd: "Implementation completed with direct merge readiness.",
  });

  assert.equal(store.getTicket("project_floop", "ticket_project_floop_1").state, "READY_TO_MERGE");

  store.close();
});

test("store persists merge runs and closes merge-ready tickets", () => {
  const store = createStore({ filename: ":memory:", seedDemo: true });
  store.updateProjectPolicy("project_floop", {
    requireReviewer: false,
    requireValidator: false,
    requireHumanApprovalBeforeMerge: true,
  });
  store.transitionTicket("project_floop", "ticket_project_floop_2", {
    targetState: "READY_TO_MERGE",
    reason: "All evidence is in and the ticket can merge.",
    reasonCode: "operator_merge_ready",
  });

  const queue = store.listMergeQueue("project_floop");
  assert.equal(queue.length, 1);
  assert.equal(queue[0].key, "FLOOP-2");
  assert.equal(queue[0].mergeStatus.canMerge, true);

  const mergeStatus = store.mergeTicket("project_floop", "ticket_project_floop_2", {
    strategy: "squash",
    approvedByKind: "human",
    approvedByRef: "jacob",
    summaryMd: "Merged cleanly into main after approvals.",
  });

  assert.equal(mergeStatus.ticketState, "DONE");
  assert.equal(mergeStatus.canMerge, false);
  assert.equal(mergeStatus.latestRun.status, "completed");
  assert.equal(mergeStatus.latestRun.strategy, "squash");
  assert.equal(mergeStatus.latestRun.approvedByRef, "jacob");

  const ticket = store.getTicket("project_floop", "ticket_project_floop_2");
  assert.equal(ticket.state, "DONE");
  assert.equal(ticket.mergeStatus.latestRun.status, "completed");
  assert.equal(ticket.events.at(-2).type, "merge.started");
  assert.equal(ticket.events.at(-1).type, "merge.completed");
  assert.equal(store.listMergeQueue("project_floop").length, 0);
  store.close();
});

test("store migrates legacy merge runs to allow active claims", () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "floop-legacy-merge-runs-"));
  const filename = join(fixtureDir, "floop.sqlite");
  const database = new DatabaseSync(filename);
  database.exec(`
    create table merge_runs (
      id text primary key,
      project_id text not null,
      ticket_id text not null,
      status text not null,
      strategy text not null,
      approved_by_kind text not null default '',
      approved_by_ref text not null default '',
      summary_md text not null default '',
      failure_kind text not null default '',
      claim_token text not null default '',
      claim_expires_at text,
      started_at text not null,
      finished_at text not null
    )
  `);
  database.exec(`
    create table artifacts (
      id text primary key,
      project_id text not null,
      ticket_id text not null,
      execution_id text,
      review_id text,
      validation_run_id text,
      merge_run_id text references merge_runs_legacy_notnull_finished_at(id) on delete cascade,
      kind text not null,
      label text not null,
      uri text not null,
      metadata_json text not null default '{}',
      created_at text not null
    )
  `);
  database.close();

  const store = createStore({ filename, seedDemo: true });
  store.updateProjectPolicy("project_floop", {
    requireReviewer: false,
    requireValidator: false,
    requireHumanApprovalBeforeMerge: false,
  });
  store.transitionTicket("project_floop", "ticket_project_floop_2", {
    targetState: "READY_TO_MERGE",
    reason: "Exercise legacy merge run migration.",
    reasonCode: "operator_merge_ready",
  });

  const started = store.startMergeRun("project_floop", "ticket_project_floop_2", {
    strategy: "squash",
    approvedByKind: "system",
    approvedByRef: "floop-auto",
    claimToken: "merge-worker",
  });

  assert.equal(started.status, "running");
  assert.equal(started.finishedAt, null);
  const completed = store.completeMergeRun("project_floop", started.id, {
    status: "completed",
    summaryMd: "Legacy merge run completed.",
    artifacts: [{ kind: "report", label: "legacy merge artifact", uri: "file:///tmp/legacy-merge.md" }],
  });
  assert.equal(completed.status, "completed");
  assert.equal(completed.artifacts.length, 1);
  store.close();
  rmSync(fixtureDir, { recursive: true, force: true });
});

test("store enforces merge readiness and approval policy", () => {
  const store = createStore({ filename: ":memory:", seedDemo: true });
  store.updateProjectPolicy("project_floop", {
    requireReviewer: false,
    requireValidator: false,
  });
  store.transitionTicket("project_floop", "ticket_project_floop_2", {
    targetState: "READY_TO_MERGE",
    reason: "Ready for merge policy checks.",
    reasonCode: "operator_merge_ready",
  });

  assert.throws(
    () =>
      store.mergeTicket("project_floop", "ticket_project_floop_2", {
        strategy: "merge_commit",
      }),
    /FLOOP-2 requires human approval before merge/,
  );

  const blocked = store.mergeTicket("project_floop", "ticket_project_floop_2", {
    strategy: "merge_commit",
    status: "blocked",
    summaryMd: "Repo branch protection is still preventing integration.",
  });
  assert.equal(blocked.ticketState, "BLOCKED");
  assert.equal(blocked.latestRun.status, "blocked");

  assert.throws(
    () =>
      store.mergeTicket("project_floop", "ticket_project_floop_1", {
        strategy: "squash",
        approvedByKind: "human",
        approvedByRef: "jacob",
      }),
    /Ticket FLOOP-1 is not ready for merge/,
  );

  store.close();
});

test("store bypasses human merge approval in fully autonomous mode", () => {
  const store = createStore({ filename: ":memory:", seedDemo: true });
  store.updateProjectPolicy("project_floop", {
    interactionMode: "fully_autonomous",
    requireReviewer: false,
    requireValidator: false,
    requireHumanApprovalBeforeMerge: true,
  });
  store.transitionTicket("project_floop", "ticket_project_floop_2", {
    targetState: "READY_TO_MERGE",
    reason: "Fully autonomous mode can merge without human approval.",
    reasonCode: "fully_autonomous_merge",
  });

  const mergeStatus = store.getMergeStatus("project_floop", "ticket_project_floop_2");
  assert.equal(mergeStatus.requiresHumanApproval, false);
  assert.equal(mergeStatus.approval.required, false);
  assert.equal(mergeStatus.canMerge, true);
  assert.equal(mergeStatus.readiness, "ready");

  const merged = store.mergeTicket("project_floop", "ticket_project_floop_2", {
    strategy: "merge_commit",
  });
  assert.equal(merged.latestRun.status, "completed");
  assert.equal(merged.ticketState, "DONE");

  store.close();
});

test("store routes merge rework back to the previous working lane in autonomous mode", () => {
  const store = createStore({ filename: ":memory:", seedDemo: true });
  store.updateProjectPolicy("project_floop", {
    requireReviewer: false,
    requireValidator: false,
    requireHumanApprovalBeforeMerge: false,
    interactionMode: "fully_autonomous",
  });

  const implementation = store.createExecution("project_floop", "ticket_project_floop_2", {
    role: "developer",
    reason: "Prepare a merge conflict rework test.",
  });
  store.completeExecution("project_floop", implementation.id, {
    outcome: "completed",
    summaryMd: "Implementation is ready for merge.",
  });
  assert.equal(store.getTicket("project_floop", "ticket_project_floop_2").state, "READY_TO_MERGE");

  const started = store.startMergeRun("project_floop", "ticket_project_floop_2", {
    strategy: "squash",
    approvedByKind: "system",
    approvedByRef: "floop-auto",
    claimToken: "merge-worker",
  });
  store.completeMergeRun("project_floop", started.id, {
    status: "rework",
    summaryMd: "Merge conflicted against trunk. Rebase the implementation branch and retry.",
    artifacts: [{ kind: "report", label: "merge conflict summary", uri: "file:///tmp/merge-conflict.json" }],
  });

  const ticket = store.getTicket("project_floop", "ticket_project_floop_2");
  const developerRuns = ticket.executions.filter((execution) => execution.role === "developer");
  assert.equal(ticket.state, "WORKING");
  assert.equal(developerRuns.length, 2);
  assert.equal(developerRuns[0].status, "running");
  assert.match(developerRuns[0].summaryMd || ticket.latestSummary, /merge requested rework|merge evidence/i);
  assert.equal(store.listAgentMessages("project_floop", { intent: "suggest_dispatch" }).length, 0);

  store.close();
});

test("store suggests merge rework dispatch in operator-approved mode", () => {
  const store = createStore({ filename: ":memory:", seedDemo: true });
  store.updateProjectPolicy("project_floop", {
    requireReviewer: false,
    requireValidator: false,
    requireHumanApprovalBeforeMerge: false,
    interactionMode: "operator_approved",
  });

  const implementation = store.createExecution("project_floop", "ticket_project_floop_2", {
    role: "developer",
    reason: "Prepare operator-approved merge conflict rework test.",
  });
  store.completeExecution("project_floop", implementation.id, {
    outcome: "completed",
    summaryMd: "Implementation is ready for operator-approved merge.",
  });
  const started = store.startMergeRun("project_floop", "ticket_project_floop_2", {
    strategy: "squash",
    approvedByKind: "system",
    approvedByRef: "floop-auto",
    claimToken: "merge-worker",
  });
  store.completeMergeRun("project_floop", started.id, {
    status: "rework",
    summaryMd: "Merge conflicted against trunk. Let the developer resolve the rebase.",
    artifacts: [{ kind: "report", label: "merge conflict summary", uri: "file:///tmp/merge-conflict.json" }],
  });

  const ticket = store.getTicket("project_floop", "ticket_project_floop_2");
  const developerRuns = ticket.executions.filter((execution) => execution.role === "developer");
  const suggestion = store
    .listAgentMessages("project_floop", { intent: "suggest_dispatch" })
    .find((message) => message.target.ticketId === "ticket_project_floop_2");
  assert.equal(ticket.state, "REWORK");
  assert.equal(developerRuns.length, 1);
  assert.ok(suggestion);
  assert.equal(suggestion.metadata.role, "developer");
  assert.match(suggestion.body, /merge requested rework|merge evidence/i);

  store.close();
});

test("store enforces merge validation-profile policy before merge", () => {
  const store = createStore({ filename: ":memory:", seedDemo: true });
  store.updateProjectPolicy("project_floop", {
    requireReviewer: false,
    requireValidator: true,
    requireHumanApprovalBeforeMerge: false,
    requiredValidationCommandProfileForMerge: "ci",
    interactionMode: "autonomous_with_review",
  });

  const implementation = store.createExecution("project_floop", "ticket_project_floop_2", {
    role: "developer",
    reason: "Prepare merge policy validation test.",
  });
  store.completeExecution("project_floop", implementation.id, {
    outcome: "completed",
    summaryMd: "Implementation completed for merge policy test.",
  });

  const validatorExecution = store
    .getTicket("project_floop", "ticket_project_floop_2")
    .executions.find((execution) => execution.role === "validator");
  store.completeExecution("project_floop", validatorExecution.id, {
    outcome: "completed",
    summaryMd: "Validation completed with non-ci profile.",
    validation: {
      verdict: "passed",
      commandProfile: "smoke",
      commands: ["npm test"],
      repoIds: ["repo_project_floop_floop"],
      summaryMd: "Validation passed but under the wrong profile.",
    },
  });

  const mergeStatus = store.getMergeStatus("project_floop", "ticket_project_floop_2");
  assert.equal(mergeStatus.ticketState, "READY_TO_MERGE");
  assert.equal(mergeStatus.canMerge, false);
  assert.equal(mergeStatus.readiness, "waiting");
  assert.equal(mergeStatus.blockingReasons[0].code, "validation_profile_required");
  assert.equal(mergeStatus.blockingReasons[0].source, "validation");
  assert.equal(mergeStatus.approval.required, false);
  assert.match(mergeStatus.statusSummary, /Latest validation must use ci profile before merge/);
  assert.equal(store.getTicket("project_floop", "ticket_project_floop_2").events.at(-1).reasonCode, "validation_profile_required");
  assert.equal(store.getTicket("project_floop", "ticket_project_floop_2").events.at(-1).reasonSource, "validation");

  assert.throws(
    () =>
      store.mergeTicket("project_floop", "ticket_project_floop_2", {
        strategy: "squash",
        approvedByKind: "human",
        approvedByRef: "jacob",
      }),
    /Latest validation must use ci profile before merge/,
  );

  store.close();
});

test("store requires validator demo evidence before merge when policy is enabled", () => {
  const store = createStore({ filename: ":memory:", seedDemo: true });
  store.updateProjectPolicy("project_floop", {
    requireReviewer: false,
    requireValidator: true,
    requireHumanApprovalBeforeMerge: false,
    requireDemoEvidenceBeforeMerge: true,
    interactionMode: "autonomous_with_review",
  });

  const implementation = store.createExecution("project_floop", "ticket_project_floop_2", {
    role: "developer",
    reason: "Prepare demo evidence merge policy test.",
  });
  store.completeExecution("project_floop", implementation.id, {
    outcome: "completed",
    summaryMd: "Implementation completed for demo evidence policy test.",
  });

  const validatorExecution = store
    .getTicket("project_floop", "ticket_project_floop_2")
    .executions.find((execution) => execution.role === "validator");
  store.completeExecution("project_floop", validatorExecution.id, {
    outcome: "completed",
    summaryMd: "Validation passed without demo evidence.",
    validation: {
      verdict: "passed",
      commandProfile: "ci",
      commands: ["npm test"],
      repoIds: ["repo_project_floop_floop"],
      summaryMd: "Checks passed, but no demo artifact was attached.",
      artifacts: [{ kind: "log", label: "Validation output", uri: "file:///tmp/validation.log" }],
    },
  });

  const mergeStatus = store.getMergeStatus("project_floop", "ticket_project_floop_2");
  assert.equal(mergeStatus.ticketState, "READY_TO_MERGE");
  assert.equal(mergeStatus.canMerge, false);
  assert.equal(mergeStatus.blockingReasons[0].code, "demo_evidence_required");
  assert.match(mergeStatus.statusSummary, /demo evidence/);
  assert.equal(store.getTicket("project_floop", "ticket_project_floop_2").events.at(-1).reasonCode, "demo_evidence_required");

  assert.throws(
    () =>
      store.mergeTicket("project_floop", "ticket_project_floop_2", {
        strategy: "squash",
      }),
    /Latest validation must include demo evidence before merge/,
  );

  store.close();
});

test("store routes validator failures back to the previous working lane", () => {
  const store = createStore({ filename: ":memory:", seedDemo: true });
  store.updateProjectPolicy("project_floop", {
    requireReviewer: false,
    requireValidator: true,
    interactionMode: "autonomous_with_review",
  });

  const implementation = store.createExecution("project_floop", "ticket_project_floop_2", {
    role: "developer",
    reason: "Implement before validator rework.",
  });
  store.completeExecution("project_floop", implementation.id, {
    outcome: "completed",
    summaryMd: "Implementation ready for validation.",
  });

  const validatorExecution = store
    .getTicket("project_floop", "ticket_project_floop_2")
    .executions.find((execution) => execution.role === "validator");
  store.completeExecution("project_floop", validatorExecution.id, {
    outcome: "completed",
    summaryMd: "Validator found missing demo behavior.",
    validation: {
      verdict: "failed",
      commandProfile: "ci",
      commands: ["npm test"],
      repoIds: ["repo_project_floop_floop"],
      summaryMd: "The feature is not demoable yet. Rework the implementation and rerun validation.",
      artifacts: [{ kind: "log", label: "Validation failure", uri: "file:///tmp/validation-failure.log" }],
    },
  });

  const ticket = store.getTicket("project_floop", "ticket_project_floop_2");
  const developerRuns = ticket.executions.filter((execution) => execution.role === "developer");
  assert.equal(ticket.state, "WORKING");
  assert.equal(developerRuns.length, 2);
  assert.equal(developerRuns[0].status, "running");
  assert.match(developerRuns[0].summaryMd || ticket.latestSummary, /validation found rework|routed/i);

  store.close();
});

test("store enforces project execution concurrency limits", () => {
  const store = createStore({ filename: ":memory:", seedDemo: true });
  store.updateProjectPolicy("project_floop", {
    maxParallelExecutions: 1,
  });

  const started = store.createExecution("project_floop", "ticket_project_floop_1", {
    role: "developer",
    reason: "Use the single active execution slot.",
  });

  assert.equal(started.status, "running");
  assert.throws(
    () =>
      store.createExecution("project_floop", "ticket_project_floop_2", {
        role: "reviewer",
        reason: "This second run should be rejected by project policy.",
      }),
    /Project execution limit reached for FLOOP-2: 1 active runs allowed/,
  );

  store.close();
});

test("store restarts tickets by cancelling runs and deleting worktrees", () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "floop-restart-ticket-"));
  const workspaceRoot = join(fixtureDir, "workspace");
  const store = createStore({ filename: ":memory:", seedDemo: true, workspaceRoot });

  try {
    const started = store.createExecution("project_floop", "ticket_project_floop_1", {
      role: "developer",
      reason: "Start work that will be restarted.",
    });
    const worktreePath = started.worktrees[0].path;
    mkdirSync(worktreePath, { recursive: true });

    const restarted = store.restartTicket("project_floop", "ticket_project_floop_1", {
      reason: "Operator restart from test.",
    });
    const execution = store.getExecution("project_floop", started.id);
    const cleanedWorktree = restarted.worktrees.find((worktree) => worktree.id === started.worktrees[0].id);

    assert.equal(restarted.state, "READY");
    assert.equal(restarted.latestSummary, "Operator restart from test.");
    assert.equal(execution.status, "cancelled");
    assert.equal(execution.failureKind, "restart_cancelled");
    assert.equal(cleanedWorktree.status, "cleaned");
    assert.equal(existsSync(worktreePath), false);
    assert.equal(restarted.events.some((event) => event.reasonCode === "ticket_restarted"), true);
  } finally {
    store.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("store enforces continuation budgets before mutating the active run", () => {
  const store = createStore({ filename: ":memory:", seedDemo: true });
  store.updateProjectPolicy("project_floop", {
    maxAutoContinueIterations: 1,
  });

  const started = store.createExecution("project_floop", "ticket_project_floop_1", {
    role: "developer",
    reason: "Start the bounded continuation lane.",
  });
  const continued = store.continueExecution("project_floop", started.id, {
    reason: "Spend the only continuation budget.",
  });

  assert.equal(continued.iteration, 2);
  assert.equal(continued.status, "running");
  assert.throws(
    () =>
      store.continueExecution("project_floop", continued.id, {
        reason: "Attempt to exceed the continuation limit.",
      }),
    /FLOOP-1 reached the continuation limit of 1 iterations/,
  );
  assert.equal(store.getExecution("project_floop", continued.id).status, "running");

  store.close();
});
