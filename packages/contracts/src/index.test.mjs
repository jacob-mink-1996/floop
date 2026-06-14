import test from "node:test";
import assert from "node:assert/strict";

import {
  boardDto,
  eventDto,
  parseCompleteExecutionInput,
  parseContinueExecutionInput,
  parseCreateReviewInput,
  parseCreateExecutionInput,
  parseMergeTicketInput,
  parseCreateRepoInput,
  parseCreateTicketInput,
  parseCreateValidationInput,
  parseUpdateProjectPolicyInput,
  parseUpdateProjectInput,
  parseUpdateRoleProfileInput,
  parseUpdateTicketInput,
  projectSummaryDto,
  ticketDto,
} from "./index.mjs";

test("eventDto projects a stable event contract for live consumers", () => {
  const event = eventDto({
    id: "event_1",
    sequence: 17,
    projectId: "project_floop",
    repoId: "repo_project_floop_floop",
    repoSlug: "floop",
    repoName: "floop",
    ticketId: "ticket_1",
    ticketKey: "FLOOP-1",
    ticketTitle: "Build API",
    type: "execution.completed",
    summary: "FLOOP-1 developer iteration 1 completed",
    detail: "Execution landed cleanly.",
    reasonCode: "interrupted",
    reasonSource: "execution",
    createdAt: "2026-06-10T05:10:00.000Z",
  });

  assert.equal(event.family, "execution");
  assert.equal(event.action, "completed");
  assert.equal(event.lane, "execution");
  assert.equal(event.cursor, "2026-06-10T05:10:00.000Z:17");
  assert.equal(event.reasonCode, "interrupted");
  assert.equal(event.reasonSource, "execution");
});

test("boardDto groups tickets by state", () => {
  const board = boardDto("project_floop", [
    {
      id: "ticket_1",
      key: "FLOOP-1",
      title: "Build API",
      state: "WORKING",
      priority: "high",
      assignedRole: "developer",
      latestSummary: "In progress",
      latestReviewVerdict: "passed",
      updatedAt: "2026-06-10T05:00:00.000Z",
    },
    {
      id: "ticket_2",
      key: "FLOOP-2",
      title: "Review API",
      state: "READY",
      priority: "medium",
      assignedRole: "reviewer",
      latestSummary: "Ready",
      updatedAt: "2026-06-10T05:01:00.000Z",
    },
  ]);

  assert.equal(board.projectId, "project_floop");
  assert.equal(board.totalTickets, 2);
  assert.equal(board.lanes.WORKING.count, 1);
  assert.equal(board.lanes.WORKING.tickets[0].latestReviewVerdict, "passed");
  assert.equal(board.lanes.READY.tickets[0].key, "FLOOP-2");
});

test("ticketDto includes projected events", () => {
  const ticket = ticketDto(
    {
      id: "ticket_1",
      projectId: "project_floop",
      parentTicketId: "ticket_parent_1",
      key: "FLOOP-1",
      title: "Build API",
      brief: "Implement something.",
      state: "READY",
      priority: "high",
      acceptanceCriteriaMd: "",
      definitionOfDoneMd: "",
      assignedRole: "developer",
      latestSummary: "Ready",
      createdAt: "2026-06-10T05:00:00.000Z",
      updatedAt: "2026-06-10T05:00:00.000Z",
    },
    {
      executions: [
        {
          id: "execution_1",
          projectId: "project_floop",
          ticketId: "ticket_1",
          ticketKey: "FLOOP-1",
          ticketTitle: "Build API",
          ticketState: "READY",
          agentProfileId: "profile_project_floop_developer",
          role: "developer",
          iteration: 1,
          status: "completed",
          outcome: "completed",
          summaryMd: "Implemented the execution lane.",
          remainingWorkMd: "",
          expectedNextEvidenceMd: "Reviewer findings.",
          failureKind: "",
          blockedKind: "",
          startedAt: "2026-06-10T05:00:00.000Z",
          finishedAt: "2026-06-10T05:10:00.000Z",
          artifacts: [
            {
              id: "artifact_1",
              projectId: "project_floop",
              ticketId: "ticket_1",
              ticketKey: "FLOOP-1",
              ticketTitle: "Build API",
              executionId: "execution_1",
              kind: "patch",
              label: "API diff",
              uri: "file:///workspace/floop/diffs/floop-1.patch",
              metadata: { sizeBytes: 1024 },
              createdAt: "2026-06-10T05:10:00.000Z",
            },
          ],
          worktrees: [
            {
              id: "worktree_1",
              projectId: "project_floop",
              repoId: "repo_project_floop_floop",
              ticketId: "ticket_1",
              executionId: "execution_1",
              repoSlug: "floop",
              repoName: "floop",
              executionRole: "developer",
              executionIteration: 1,
              path: "/workspace/floop/.floop/worktrees/floop-1/floop/iter-1",
              branchName: "floop-1-build-api",
              baseRef: "main",
              status: "active",
              isDirty: false,
              createdAt: "2026-06-10T05:00:00.000Z",
              updatedAt: "2026-06-10T05:00:00.000Z",
              cleanedAt: null,
            },
          ],
        },
      ],
      dependencies: [
        {
          id: "dependency_1",
          projectId: "project_floop",
          blockedTicketId: "ticket_1",
          blockingTicketId: "ticket_2",
          blockingTicketKey: "FLOOP-2",
          blockingTicketTitle: "Define contracts",
          blockingTicketState: "WORKING",
          dependencyType: "finish_to_start",
          createdAt: "2026-06-10T05:00:00.000Z",
        },
      ],
      reviews: [
        {
          id: "review_1",
          projectId: "project_floop",
          ticketId: "ticket_1",
          executionId: "execution_1",
          reviewerProfileId: "profile_project_floop_reviewer",
          verdict: "rework",
          summaryMd: "Found a blocking issue in the update path.",
          findingsCount: 1,
          createdAt: "2026-06-10T05:12:00.000Z",
          findings: [
            {
              id: "finding_1",
              severity: "high",
              category: "correctness",
              filePath: "services/api/src/app.mjs",
              lineNumber: 120,
              title: "Missing route guard",
              detailsMd: "The handler accepts an invalid transition.",
              createdAt: "2026-06-10T05:12:00.000Z",
            },
          ],
        },
      ],
      validations: [
        {
          id: "validation_1",
          projectId: "project_floop",
          ticketId: "ticket_1",
          repoId: "repo_project_floop_floop",
          repoSlug: "floop",
          repoName: "floop",
          executionId: "execution_1",
          status: "completed",
          verdict: "passed",
          commandProfile: "default",
          commands: ["npm test"],
          summaryMd: "API tests passed.",
          startedAt: "2026-06-10T05:20:00.000Z",
          finishedAt: "2026-06-10T05:21:00.000Z",
        },
      ],
      worktrees: [
        {
          id: "worktree_1",
          projectId: "project_floop",
          repoId: "repo_project_floop_floop",
          ticketId: "ticket_1",
          executionId: "execution_1",
          repoSlug: "floop",
          repoName: "floop",
          executionRole: "developer",
          executionIteration: 1,
          path: "/workspace/floop/.floop/worktrees/floop-1/floop/iter-1",
          branchName: "floop-1-build-api",
          baseRef: "main",
          status: "active",
          isDirty: false,
          createdAt: "2026-06-10T05:00:00.000Z",
          updatedAt: "2026-06-10T05:00:00.000Z",
          cleanedAt: null,
        },
      ],
      artifacts: [
        {
          id: "artifact_ticket_1",
          projectId: "project_floop",
          ticketId: "ticket_1",
          ticketKey: "FLOOP-1",
          ticketTitle: "Build API",
          executionId: "execution_1",
          kind: "patch",
          label: "API diff",
          uri: "file:///workspace/floop/diffs/floop-1.patch",
          metadata: { sizeBytes: 1024 },
          createdAt: "2026-06-10T05:10:00.000Z",
        },
      ],
      mergeStatus: {
        projectId: "project_floop",
        ticketId: "ticket_1",
        ticketKey: "FLOOP-1",
        ticketTitle: "Build API",
        ticketState: "READY_TO_MERGE",
        requiresHumanApproval: true,
        canMerge: true,
        statusSummary: "Ready for an operator-approved merge.",
        uncleanedWorktreeCount: 1,
        latestRun: {
          id: "merge_1",
          projectId: "project_floop",
          ticketId: "ticket_1",
          status: "rework",
          strategy: "squash",
          approvedByKind: "",
          approvedByRef: "",
          summaryMd: "Merge conflicted against trunk.",
          startedAt: "2026-06-10T05:22:00.000Z",
          finishedAt: "2026-06-10T05:22:00.000Z",
        },
      },
      repoTargets: [],
      events: [
        {
          id: "event_1",
          projectId: "project_floop",
          repoId: null,
          ticketId: "ticket_1",
          type: "ticket.created",
          summary: "Created",
          detail: "",
          reasonCode: "",
          reasonSource: "",
          createdAt: "2026-06-10T05:00:00.000Z",
        },
      ],
    },
  );

  assert.equal(ticket.dependencies.length, 1);
  assert.equal(ticket.executions.length, 1);
  assert.equal(ticket.executions[0].outcome, "completed");
  assert.equal(ticket.executions[0].ticketKey, "FLOOP-1");
  assert.equal(ticket.executions[0].ticketState, "READY");
  assert.equal(ticket.executions[0].worktrees.length, 1);
  assert.equal(ticket.reviews.length, 1);
  assert.equal(ticket.reviews[0].findings[0].severity, "high");
  assert.equal(ticket.validations.length, 1);
  assert.equal(ticket.validations[0].commands[0], "npm test");
  assert.equal(ticket.dependencies[0].blockingTicketKey, "FLOOP-2");
  assert.equal(ticket.worktrees.length, 1);
  assert.equal(ticket.worktrees[0].path, "/workspace/floop/.floop/worktrees/floop-1/floop/iter-1");
  assert.equal(ticket.mergeStatus.canMerge, true);
  assert.equal(ticket.mergeStatus.latestRun.strategy, "squash");
  assert.equal(ticket.executions[0].artifacts[0].kind, "patch");
  assert.equal(ticket.artifacts[0].label, "API diff");
  assert.equal(ticket.artifacts[0].ticketKey, "FLOOP-1");
  assert.equal(ticket.artifacts[0].ticketTitle, "Build API");
  assert.equal(ticket.events.length, 1);
  assert.equal(ticket.events[0].type, "ticket.created");
  assert.equal(ticket.parentTicketId, "ticket_parent_1");
});

test("projectSummaryDto copies board counts", () => {
  const project = projectSummaryDto(
    {
      id: "project_floop",
      slug: "floop",
      name: "Floop",
      description: "desc",
      workspaceRoot: "/tmp/floop",
      defaultBaseBranch: "main",
      policy: { requireReviewer: true },
      roleProfiles: [{ role: "developer", adapter: "codex", model: "codex-latest" }],
      createdAt: "2026-06-10T05:00:00.000Z",
      updatedAt: "2026-06-10T05:00:00.000Z",
    },
    1,
    2,
    { READY: 1, WORKING: 1 },
  );

  assert.equal(project.repoCount, 1);
  assert.equal(project.ticketCount, 2);
  assert.equal(project.board.WORKING, 1);
});

test("request parsers normalize project and ticket payloads", () => {
  const project = parseUpdateProjectInput({
    name: " Floop Mission Control ",
    description: " Tight loop for autonomous delivery. ",
    workspaceRoot: " /workspace/floop ",
  });
  const policy = parseUpdateProjectPolicyInput({
    requireReviewer: false,
    maxParallelExecutions: 4,
    maxParallelMerges: 2,
    maxAutoContinueIterations: 7,
    interactionMode: " fully_autonomous ",
    refinementMode: " user_participant ",
    agentCreatedTicketDefaultState: " READY ",
    ceremonyAutomation: {
      enabled: true,
      mode: "fully_automatic",
      triggers: {
        refinement: {
          enabled: true,
          minIntervalMinutes: 20,
          participantRoles: ["product_manager", "developer"],
          deciderRole: "product_manager",
        },
      },
    },
  });
  const roleProfile = parseUpdateRoleProfileInput({
    adapter: " codex ",
    model: " codex-latest ",
    config: { reasoning: "high" },
  });
  const ticket = parseCreateTicketInput({
    title: " Add repo orchestration ",
    brief: " Register and update project repos. ",
    state: "READY",
    priority: "high",
    assignedRole: "developer",
    repoTargets: [{ repoId: "repo_project_floop_floop", baseRef: " trunk " }],
  });

  assert.deepEqual(project, {
    name: "Floop Mission Control",
    description: "Tight loop for autonomous delivery.",
    workspaceRoot: "/workspace/floop",
  });
  assert.deepEqual(policy, {
    requireReviewer: false,
    maxParallelExecutions: 4,
    maxParallelMerges: 2,
    maxAutoContinueIterations: 7,
    interactionMode: "fully_autonomous",
    refinementMode: "user_participant",
    agentCreatedTicketDefaultState: "READY",
    ceremonyAutomation: {
      enabled: true,
      mode: "fully_automatic",
      triggers: {
        refinement: {
          enabled: true,
          minIntervalMinutes: 20,
          participantRoles: ["product_manager", "developer"],
          deciderRole: "product_manager",
        },
      },
    },
  });
  assert.deepEqual(roleProfile, {
    adapter: "codex",
    model: "codex-latest",
    config: { reasoning: "high" },
  });
  assert.equal(ticket.title, "Add repo orchestration");
  assert.equal(ticket.repoTargets[0].baseRef, "trunk");

  const ticketPatch = parseUpdateTicketInput({
    parentTicketId: " ticket_project_floop_1 ",
    latestSummary: " Retargeting for the docs repo ",
    repoTargets: [{ repoId: "repo_project_floop_docs", baseRef: " release ", targetScopeMd: " docs only " }],
  });
  assert.deepEqual(ticketPatch, {
    parentTicketId: "ticket_project_floop_1",
    latestSummary: "Retargeting for the docs repo",
    repoTargets: [
      {
        repoId: "repo_project_floop_docs",
        baseRef: "release",
        branchName: "",
        targetScopeMd: "docs only",
      },
    ],
  });
});

test("execution parsers normalize execution payloads", () => {
  const createExecution = parseCreateExecutionInput({
    role: "developer",
    agentProfileId: " profile_project_floop_developer ",
    iteration: 2,
    reason: " Continue the work loop ",
  });
  const continueExecution = parseContinueExecutionInput({
    reason: " Pick up the remaining review findings ",
  });
  const completeExecution = parseCompleteExecutionInput({
    outcome: "needs_continue",
    summaryMd: " Implemented the first half ",
    remainingWorkMd: " Finish the follow-up persistence ",
    artifacts: [{ kind: "log", label: "Run log", uri: "file:///tmp/floop.log" }],
    review: {
      verdict: "rework",
      summaryMd: " Needs another pass ",
      artifacts: [{ kind: "report", label: "Review notes", uri: "file:///tmp/review.md" }],
      findings: [
        {
          severity: "high",
          category: "correctness",
          title: " Null guard missing ",
        },
      ],
    },
    validation: {
      verdict: "passed",
      commandProfile: " ci ",
      commands: [" npm test "],
      artifacts: [{ kind: "log", label: "CI output", uri: "file:///tmp/ci.txt" }],
    },
    followupTickets: [
      {
        title: " Add calculator division ",
        brief: " Extend the CLI calculator with division. ",
        assignedRole: " developer ",
        priority: " high ",
        repoTargets: [
          {
            repoId: " repo_project_floop_floop ",
            baseRef: " main ",
            branchName: " calc-division ",
            targetScopeMd: " CLI behavior ",
          },
        ],
      },
    ],
  });
  const review = parseCreateReviewInput({
    executionId: " execution_1 ",
    verdict: "rework",
    summaryMd: " Needs another pass ",
    artifacts: [{ kind: "report", label: "Review notes", uri: "file:///tmp/review.md" }],
    findings: [
      {
        severity: "high",
        category: "correctness",
        filePath: " services/api/src/app.mjs ",
        lineNumber: 42,
        title: " Null guard missing ",
        detailsMd: " Add an early return. ",
      },
    ],
  });
  const validation = parseCreateValidationInput({
    executionId: " execution_1 ",
    repoIds: [" repo_project_floop_floop "],
    commandProfile: " ci ",
    commands: [" npm test ", " npm run lint "],
    verdict: "passed",
    summaryMd: " Everything passed ",
    artifacts: [{ kind: "log", label: "CI output", uri: "file:///tmp/ci.txt" }],
  });

  assert.deepEqual(createExecution, {
    role: "developer",
    agentProfileId: "profile_project_floop_developer",
    iteration: 2,
    reason: "Continue the work loop",
  });
  assert.deepEqual(continueExecution, {
    reason: "Pick up the remaining review findings",
  });
  assert.deepEqual(completeExecution, {
    outcome: "needs_continue",
    summaryMd: "Implemented the first half",
    remainingWorkMd: "Finish the follow-up persistence",
    artifacts: [{ kind: "log", label: "Run log", uri: "file:///tmp/floop.log" }],
    review: {
      verdict: "rework",
      summaryMd: "Needs another pass",
      artifacts: [{ kind: "report", label: "Review notes", uri: "file:///tmp/review.md" }],
      findings: [
        {
          severity: "high",
          category: "correctness",
          title: "Null guard missing",
        },
      ],
    },
    validation: {
      verdict: "passed",
      commandProfile: "ci",
      commands: ["npm test"],
      artifacts: [{ kind: "log", label: "CI output", uri: "file:///tmp/ci.txt" }],
    },
    followupTickets: [
      {
        title: "Add calculator division",
        brief: "Extend the CLI calculator with division.",
        priority: "high",
        assignedRole: "developer",
        repoTargets: [
          {
            repoId: "repo_project_floop_floop",
            baseRef: "main",
            branchName: "calc-division",
            targetScopeMd: "CLI behavior",
          },
        ],
      },
    ],
  });
  assert.deepEqual(review, {
    executionId: "execution_1",
    verdict: "rework",
    summaryMd: "Needs another pass",
    artifacts: [{ kind: "report", label: "Review notes", uri: "file:///tmp/review.md" }],
    findings: [
      {
        severity: "high",
        category: "correctness",
        filePath: "services/api/src/app.mjs",
        lineNumber: 42,
        title: "Null guard missing",
        detailsMd: "Add an early return.",
      },
    ],
  });
  assert.deepEqual(validation, {
    executionId: "execution_1",
    repoIds: ["repo_project_floop_floop"],
    commandProfile: "ci",
    commands: ["npm test", "npm run lint"],
    verdict: "passed",
    summaryMd: "Everything passed",
    artifacts: [{ kind: "log", label: "CI output", uri: "file:///tmp/ci.txt" }],
  });
});

test("merge parser normalizes merge payloads", () => {
  const merge = parseMergeTicketInput({
    strategy: " squash ",
    status: " completed ",
    approvedByKind: " human ",
    approvedByRef: " Jacob ",
    summaryMd: " Merged after review and validation passed. ",
    artifacts: [{ kind: "record", label: "Merge commit", uri: "https://example.com/merge/123" }],
  });

  assert.deepEqual(merge, {
    strategy: "squash",
    status: "completed",
    approvedByKind: "human",
    approvedByRef: "Jacob",
    summaryMd: "Merged after review and validation passed.",
    artifacts: [{ kind: "record", label: "Merge commit", uri: "https://example.com/merge/123" }],
  });
});

test("request parsers reject invalid enum values and types", () => {
  assert.throws(
    () => parseCreateRepoInput({ name: "repo", slug: "repo", localPath: "/tmp/repo", isPrimary: "yes" }),
    /Field isPrimary must be a boolean/,
  );
  assert.throws(
    () => parseUpdateTicketInput({ priority: "critical" }),
    /Invalid ticket priority: critical/,
  );
  assert.throws(
    () => parseUpdateProjectPolicyInput({ maxParallelExecutions: 0 }),
    /Field maxParallelExecutions must be a positive integer/,
  );
  assert.throws(
    () => parseUpdateProjectPolicyInput({ maxParallelMerges: 0 }),
    /Field maxParallelMerges must be a positive integer/,
  );
  assert.throws(
    () => parseUpdateProjectPolicyInput({ agentCreatedTicketDefaultState: "SOON" }),
    /Invalid ticket state: SOON/,
  );
  assert.throws(
    () => parseUpdateRoleProfileInput({ config: [] }),
    /Field config must be a JSON object/,
  );
  assert.throws(
    () => parseUpdateTicketInput({ parentTicketId: 42 }),
    /Field parentTicketId must be a string or null/,
  );
  assert.throws(
    () => parseCreateExecutionInput({ role: "pilot" }),
    /Invalid assigned role: pilot/,
  );
  assert.throws(
    () => parseCreateExecutionInput({ role: "developer", iteration: 0 }),
    /Field iteration must be a positive integer/,
  );
  assert.throws(
    () => parseCompleteExecutionInput({ outcome: "unknown" }),
    /Invalid execution outcome: unknown/,
  );
  assert.throws(
    () => parseCreateReviewInput({ executionId: "execution_1", verdict: "ship-it" }),
    /Invalid review verdict: ship-it/,
  );
  assert.throws(
    () => parseCreateValidationInput({ verdict: "passed", repoIds: [""], commands: ["npm test"] }),
    /Field repoIds\[0\] must be a non-empty string/,
  );
  assert.throws(
    () => parseMergeTicketInput({ strategy: "squash", status: "green" }),
    /Invalid merge status: green/,
  );
  assert.throws(
    () => parseMergeTicketInput({ strategy: "squash", approvedByKind: "human" }),
    /approvedByKind and approvedByRef must be provided together/,
  );
  assert.throws(
    () =>
      parseCreateReviewInput({
        executionId: "execution_1",
        verdict: "rework",
        findings: [{ severity: "critical", category: "correctness", title: "bad" }],
      }),
    /Invalid review finding severity: critical/,
  );
});
