import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFloopServer } from "../src/app.mjs";
import { createStore } from "../src/store.mjs";

test("API exposes persistent board and filtered ticket read models", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "floop-api-"));
  const filename = join(fixtureDir, "floop.sqlite");
  const store = createStore({
    filename,
    seedDemo: true,
    workspaceRoot: "/workspace/floop",
  });
  const server = createFloopServer({ store });

  try {
    await listen(server);
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const boardResponse = await fetch(`${baseUrl}/api/v1/projects/project_floop/board`);
    assert.equal(boardResponse.status, 200);
    const boardPayload = await boardResponse.json();
    assert.equal(boardPayload.board.totalTickets, 2);
    assert.equal(findColumn(boardPayload.board.columns, "READY").count, 1);
    assert.equal(findColumn(boardPayload.board.columns, "WORKING").count, 1);

    const createTicketResponse = await fetch(`${baseUrl}/api/v1/projects/project_floop/tickets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Reviewer lane readiness",
        brief: "Add filter coverage for reviewer work.",
        state: "READY",
        priority: "medium",
        assignedRole: "reviewer",
        repoTargets: [{ repoId: "repo_project_floop_floop" }],
      }),
    });
    assert.equal(createTicketResponse.status, 201);
    const createdTicketPayload = await createTicketResponse.json();
    assert.equal(createdTicketPayload.ticket.assignedRole, "reviewer");

    const filteredResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/tickets?state=READY&assignedRole=reviewer&search=reviewer`,
    );
    assert.equal(filteredResponse.status, 200);
    const filteredPayload = await filteredResponse.json();
    assert.equal(filteredPayload.tickets.length, 1);
    assert.equal(filteredPayload.tickets[0].key, "FLOOP-3");

    const childResponse = await fetch(`${baseUrl}/api/v1/projects/project_floop/tickets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Child reviewer follow-up",
        brief: "Track the next dependency under the reviewer lane.",
        parentTicketId: createdTicketPayload.ticket.id,
        state: "READY",
        priority: "medium",
        assignedRole: "reviewer",
      }),
    });
    assert.equal(childResponse.status, 201);
    const childPayload = await childResponse.json();
    assert.equal(childPayload.ticket.parentTicketId, createdTicketPayload.ticket.id);

    const parentCycleResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/tickets/${createdTicketPayload.ticket.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parentTicketId: childPayload.ticket.id,
        }),
      },
    );
    assert.equal(parentCycleResponse.status, 400);

    const parentFilteredResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/tickets?parentTicketId=${createdTicketPayload.ticket.id}`,
    );
    assert.equal(parentFilteredResponse.status, 200);
    const parentFilteredPayload = await parentFilteredResponse.json();
    assert.equal(parentFilteredPayload.tickets.length, 1);
    assert.equal(parentFilteredPayload.tickets[0].id, childPayload.ticket.id);
    assert.equal(parentFilteredPayload.tickets[0].parentTicketId, createdTicketPayload.ticket.id);

    const detailResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/tickets/${createdTicketPayload.ticket.id}`,
    );
    assert.equal(detailResponse.status, 200);
    const detailPayload = await detailResponse.json();
    assert.equal(detailPayload.ticket.repoTargets[0].repoSlug, "floop");
    assert.equal(detailPayload.ticket.events.length, 1);
    assert.equal(detailPayload.ticket.dependencies.length, 0);

    const dependencyResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/tickets/${createdTicketPayload.ticket.id}/dependencies`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          blockingTicketId: "ticket_project_floop_1",
          dependencyType: "finish_to_start",
        }),
      },
    );
    assert.equal(dependencyResponse.status, 200);
    const dependencyPayload = await dependencyResponse.json();
    assert.equal(dependencyPayload.ticket.dependencies.length, 1);
    assert.equal(dependencyPayload.ticket.dependencies[0].blockingTicketKey, "FLOOP-1");

    const dependencyCycleResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/tickets/ticket_project_floop_1/dependencies`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          blockingTicketId: createdTicketPayload.ticket.id,
          dependencyType: "finish_to_start",
        }),
      },
    );
    assert.equal(dependencyCycleResponse.status, 400);

    const invalidFilterResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/tickets?state=NOT_A_REAL_STATE`,
    );
    assert.equal(invalidFilterResponse.status, 400);
  } finally {
    await closeServer(server);
    store.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("API exposes execution start, completion, continuation, and cancellation flows", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "floop-api-"));
  const filename = join(fixtureDir, "floop.sqlite");
  const store = createStore({
    filename,
    seedDemo: true,
    workspaceRoot: "/workspace/floop",
  });
  const server = createFloopServer({ store });

  try {
    await listen(server);
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const policyResponse = await fetch(`${baseUrl}/api/v1/projects/project_floop/policy`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ interactionMode: "autonomous_with_review" }),
    });
    assert.equal(policyResponse.status, 200);

    const createExecutionResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/tickets/ticket_project_floop_2/executions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          role: "developer",
          reason: "Start the contract implementation lane.",
        }),
      },
    );
    assert.equal(createExecutionResponse.status, 201);
    const createExecutionBody = await createExecutionResponse.json();
    assert.equal(createExecutionBody.execution.status, "running");
    assert.equal(createExecutionBody.execution.iteration, 1);
    assert.equal(createExecutionBody.execution.ticketKey, "FLOOP-2");
    assert.equal(createExecutionBody.execution.ticketTitle, "Define first transport contracts");
    assert.equal(createExecutionBody.execution.ticketState, "WORKING");
    assert.equal(createExecutionBody.execution.agentProfileId, "profile_project_floop_developer");
    assert.equal(createExecutionBody.execution.worktrees.length, 1);
    assert.equal(createExecutionBody.execution.worktrees[0].repoSlug, "floop");
    assert.match(createExecutionBody.execution.worktrees[0].path, /\/workspace\/floop\/\.floop\/worktrees\/floop-2\/floop\/iter-1$/);

    const executionDetailResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/executions/${createExecutionBody.execution.id}`,
    );
    assert.equal(executionDetailResponse.status, 200);
    const executionDetailBody = await executionDetailResponse.json();
    assert.equal(executionDetailBody.execution.id, createExecutionBody.execution.id);
    assert.equal(executionDetailBody.execution.ticketKey, "FLOOP-2");
    assert.equal(executionDetailBody.execution.ticketTitle, "Define first transport contracts");
    assert.equal(executionDetailBody.execution.ticketState, "WORKING");

    const listExecutionsResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/tickets/ticket_project_floop_2/executions`,
    );
    assert.equal(listExecutionsResponse.status, 200);
    const listExecutionsBody = await listExecutionsResponse.json();
    assert.equal(listExecutionsBody.executions.length, 1);
    assert.equal(listExecutionsBody.executions[0].ticketKey, "FLOOP-2");

    const completeExecutionResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/executions/${createExecutionBody.execution.id}/complete`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          outcome: "completed",
          summaryMd: "Execution landed the shared contract changes.",
        }),
      },
    );
    assert.equal(completeExecutionResponse.status, 200);
    const completeExecutionBody = await completeExecutionResponse.json();
    assert.equal(completeExecutionBody.execution.outcome, "completed");
    assert.equal(completeExecutionBody.execution.ticketState, "REVIEWING");
    assert.equal(completeExecutionBody.execution.worktrees[0].status, "ready_for_review");

    const ticketAfterCompleteResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/tickets/ticket_project_floop_2`,
    );
    const ticketAfterCompleteBody = await ticketAfterCompleteResponse.json();
    assert.equal(ticketAfterCompleteResponse.status, 200);
    assert.equal(ticketAfterCompleteBody.ticket.state, "REVIEWING");
    assert.equal(ticketAfterCompleteBody.ticket.executions.length, 2);
    assert.equal(ticketAfterCompleteBody.ticket.worktrees.length, 2);
    assert.equal(
      ticketAfterCompleteBody.ticket.executions.find((execution) => execution.id === createExecutionBody.execution.id)
        .worktrees[0].status,
      "ready_for_review",
    );
    assert.equal(ticketAfterCompleteBody.ticket.executions.some((execution) => execution.role === "reviewer"), true);
    assert.equal(
      ticketAfterCompleteBody.ticket.executions.find((execution) => execution.role === "reviewer").status,
      "running",
    );
    assert.equal(ticketAfterCompleteBody.ticket.events.some((event) => event.type === "worktree.created"), true);
    const reviewerExecutionId = ticketAfterCompleteBody.ticket.executions.find(
      (execution) => execution.role === "reviewer",
    ).id;

    const listWorktreesResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/worktrees?ticketId=ticket_project_floop_2&status=ready_for_review`,
    );
    assert.equal(listWorktreesResponse.status, 200);
    const listWorktreesBody = await listWorktreesResponse.json();
    assert.equal(listWorktreesBody.worktrees.length, 1);
    assert.equal(listWorktreesBody.worktrees[0].executionId, createExecutionBody.execution.id);

    const cleanWorktreeResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/worktrees/${createExecutionBody.execution.worktrees[0].id}/clean`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          reason: "Operator cleaned the finished contract worktree.",
        }),
      },
    );
    assert.equal(cleanWorktreeResponse.status, 200);
    const cleanWorktreeBody = await cleanWorktreeResponse.json();
    assert.equal(cleanWorktreeBody.worktree.status, "cleaned");
    assert.ok(cleanWorktreeBody.worktree.cleanedAt);

    const cancelReviewerResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/executions/${reviewerExecutionId}/cancel`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          reason: "Clear the auto-routed reviewer lane before the continuation test.",
        }),
      },
    );
    assert.equal(cancelReviewerResponse.status, 200);

    const tightenPolicyResponse = await fetch(`${baseUrl}/api/v1/projects/project_floop/policy`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        maxParallelExecutions: 1,
        maxAutoContinueIterations: 1,
      }),
    });
    assert.equal(tightenPolicyResponse.status, 200);

    const seedContinuationResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/tickets/ticket_project_floop_1/executions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          role: "developer",
          reason: "Start the next implementation pass.",
        }),
      },
    );
    assert.equal(seedContinuationResponse.status, 201);
    const seedContinuationBody = await seedContinuationResponse.json();

    const concurrencyRejectedResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/tickets/ticket_project_floop_2/executions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          role: "reviewer",
          reason: "Try to exceed the project concurrency cap.",
        }),
      },
    );
    assert.equal(concurrencyRejectedResponse.status, 409);
    const concurrencyRejectedBody = await concurrencyRejectedResponse.json();
    assert.match(concurrencyRejectedBody.message, /Project execution limit reached for FLOOP-2/);

    const continueExecutionResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/executions/${seedContinuationBody.execution.id}/continue`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          reason: "Continue into the follow-up iteration.",
        }),
      },
    );
    assert.equal(continueExecutionResponse.status, 200);
    const continueExecutionBody = await continueExecutionResponse.json();
    assert.equal(continueExecutionBody.execution.iteration, 2);
    assert.equal(continueExecutionBody.execution.status, "running");
    assert.equal(continueExecutionBody.execution.worktrees[0].status, "active");
    assert.match(continueExecutionBody.execution.worktrees[0].path, /\/workspace\/floop\/\.floop\/worktrees\/floop-1\/floop\/iter-2$/);

    const cleanActiveWorktreeResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/worktrees/${continueExecutionBody.execution.worktrees[0].id}/clean`,
      {
        method: "POST",
      },
    );
    assert.equal(cleanActiveWorktreeResponse.status, 409);

    const overContinueResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/executions/${continueExecutionBody.execution.id}/continue`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          reason: "Attempt to exceed the continuation budget.",
        }),
      },
    );
    assert.equal(overContinueResponse.status, 409);
    const overContinueBody = await overContinueResponse.json();
    assert.match(overContinueBody.message, /FLOOP-1 reached the continuation limit of 1 iterations/);

    const cancelExecutionResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/executions/${continueExecutionBody.execution.id}/cancel`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          reason: "Operator cancelled the stale continuation.",
        }),
      },
    );
    assert.equal(cancelExecutionResponse.status, 200);
    const cancelExecutionBody = await cancelExecutionResponse.json();
    assert.equal(cancelExecutionBody.execution.status, "cancelled");
    assert.equal(cancelExecutionBody.execution.worktrees[0].status, "cancelled");

    const invalidExecutionResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/tickets/ticket_project_floop_1/executions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          role: "pilot",
        }),
      },
    );
    assert.equal(invalidExecutionResponse.status, 400);

    const mismatchedProfileResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/tickets/ticket_project_floop_1/executions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          role: "developer",
          agentProfileId: "profile_project_floop_reviewer",
        }),
      },
    );
    assert.equal(mismatchedProfileResponse.status, 400);
  } finally {
    await closeServer(server);
    store.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("API exposes review and validation evidence flows", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "floop-api-"));
  const filename = join(fixtureDir, "floop.sqlite");
  const store = createStore({
    filename,
    seedDemo: true,
    workspaceRoot: "/workspace/floop",
  });
  const server = createFloopServer({ store });

  try {
    await listen(server);
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const createExecutionResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/tickets/ticket_project_floop_2/executions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          role: "developer",
          reason: "Finish the implementation before evidence lanes.",
        }),
      },
    );
    const createExecutionBody = await createExecutionResponse.json();
    assert.equal(createExecutionResponse.status, 201);

    const completeExecutionResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/executions/${createExecutionBody.execution.id}/complete`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          outcome: "completed",
          summaryMd: "Implementation completed and ready for review.",
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
    assert.equal(completeExecutionResponse.status, 200);

    const reviewResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/tickets/ticket_project_floop_2/reviews`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          executionId: createExecutionBody.execution.id,
          verdict: "passed",
          summaryMd: "Reviewer found no blocking issues.",
          artifacts: [
            {
              kind: "report",
              label: "Reviewer notes",
              uri: "file:///workspace/floop/.floop/artifacts/floop-2-review.md",
            },
          ],
        }),
      },
    );
    assert.equal(reviewResponse.status, 201);
    const reviewBody = await reviewResponse.json();
    assert.equal(reviewBody.review.verdict, "passed");
    assert.equal(reviewBody.review.artifacts[0].label, "Reviewer notes");

    const reviewListResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/tickets/ticket_project_floop_2/reviews`,
    );
    assert.equal(reviewListResponse.status, 200);
    const reviewListBody = await reviewListResponse.json();
    assert.equal(reviewListBody.reviews.length, 1);

    const validationResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/tickets/ticket_project_floop_2/validations`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          executionId: createExecutionBody.execution.id,
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
              metadata: { demoEvidence: true },
            },
          ],
        }),
      },
    );
    assert.equal(validationResponse.status, 201);
    const validationBody = await validationResponse.json();
    assert.equal(validationBody.validations.length, 1);
    assert.equal(validationBody.validations[0].repoSlug, "floop");
    assert.equal(validationBody.validations[0].artifacts[0].kind, "log");

    const ticketDetailResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/tickets/ticket_project_floop_2`,
    );
    assert.equal(ticketDetailResponse.status, 200);
    const ticketDetailBody = await ticketDetailResponse.json();
    assert.equal(ticketDetailBody.ticket.state, "READY_TO_MERGE");
    assert.equal(ticketDetailBody.ticket.reviews.length, 1);
    assert.equal(ticketDetailBody.ticket.validations.length, 1);
    assert.equal(
      ticketDetailBody.ticket.executions.find((execution) => execution.id === createExecutionBody.execution.id)
        .artifacts[0].label,
      "Implementation diff",
    );
    assert.equal(ticketDetailBody.ticket.artifacts.length, 3);

    const boardResponse = await fetch(`${baseUrl}/api/v1/projects/project_floop/board`);
    assert.equal(boardResponse.status, 200);
    const boardBody = await boardResponse.json();
    const mergeReadyCard = findColumn(boardBody.board.columns, "READY_TO_MERGE").tickets.find(
      (ticket) => ticket.id === "ticket_project_floop_2",
    );
    assert.equal(mergeReadyCard.latestReviewVerdict, "passed");
    assert.equal(mergeReadyCard.latestValidationVerdict, "passed");
  } finally {
    await closeServer(server);
    store.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("API exposes merge readiness and merge completion flows", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "floop-api-"));
  const filename = join(fixtureDir, "floop.sqlite");
  const store = createStore({
    filename,
    seedDemo: true,
    workspaceRoot: "/workspace/floop",
  });
  const server = createFloopServer({ store });

  try {
    await listen(server);
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    await fetch(`${baseUrl}/api/v1/projects/project_floop/policy`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requireReviewer: false,
        requireValidator: false,
      }),
    });

    await fetch(`${baseUrl}/api/v1/projects/project_floop/tickets/ticket_project_floop_2/transition`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targetState: "READY_TO_MERGE",
        reason: "All evidence is already recorded for the merge lane.",
        reasonCode: "operator_merge_ready",
      }),
    });

    const mergeStatusResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/tickets/ticket_project_floop_2/merge`,
    );
    assert.equal(mergeStatusResponse.status, 200);
    const mergeStatusBody = await mergeStatusResponse.json();
    assert.equal(mergeStatusBody.merge.canMerge, true);
    assert.equal(mergeStatusBody.merge.requiresHumanApproval, true);

    const queueResponse = await fetch(`${baseUrl}/api/v1/projects/project_floop/merge-queue`);
    assert.equal(queueResponse.status, 200);
    const queueBody = await queueResponse.json();
    assert.equal(queueBody.queue.length, 1);
    assert.equal(queueBody.queue[0].key, "FLOOP-2");
    assert.equal(queueBody.queue[0].mergeStatus.canMerge, true);

    const approvalRejectedResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/tickets/ticket_project_floop_2/merge`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          strategy: "squash",
        }),
      },
    );
    assert.equal(approvalRejectedResponse.status, 409);

    const mergeResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/tickets/ticket_project_floop_2/merge`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          strategy: "squash",
          approvedByKind: "human",
          approvedByRef: "jacob",
          summaryMd: "Merged after review and validation passed.",
          artifacts: [
            {
              kind: "record",
              label: "Merge commit",
              uri: "https://example.com/floop/commit/123",
            },
          ],
        }),
      },
    );
    assert.equal(mergeResponse.status, 200);
    const mergeBody = await mergeResponse.json();
    assert.equal(mergeBody.merge.ticketState, "DONE");
    assert.equal(mergeBody.merge.latestRun.status, "completed");
    assert.equal(mergeBody.merge.latestRun.approvedByRef, "jacob");
    assert.equal(mergeBody.merge.latestRun.artifacts[0].label, "Merge commit");

    const ticketDetailResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/tickets/ticket_project_floop_2`,
    );
    assert.equal(ticketDetailResponse.status, 200);
    const ticketDetailBody = await ticketDetailResponse.json();
    assert.equal(ticketDetailBody.ticket.state, "DONE");
    assert.equal(ticketDetailBody.ticket.mergeStatus.latestRun.strategy, "squash");
    assert.equal(ticketDetailBody.ticket.mergeStatus.latestRun.artifacts[0].kind, "record");
    assert.equal(ticketDetailBody.ticket.events.at(-2).type, "merge.started");
    assert.equal(ticketDetailBody.ticket.events.at(-1).type, "merge.completed");

    const queueAfterMergeResponse = await fetch(`${baseUrl}/api/v1/projects/project_floop/merge-queue`);
    assert.equal(queueAfterMergeResponse.status, 200);
    const queueAfterMergeBody = await queueAfterMergeResponse.json();
    assert.equal(queueAfterMergeBody.queue.length, 0);
  } finally {
    await closeServer(server);
    store.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("API exposes filtered project activity events with ticket and repo context", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "floop-api-"));
  const filename = join(fixtureDir, "floop.sqlite");
  const store = createStore({
    filename,
    seedDemo: true,
    workspaceRoot: "/workspace/floop",
  });
  const server = createFloopServer({ store });

  try {
    await listen(server);
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const createExecutionResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/tickets/ticket_project_floop_2/executions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          role: "developer",
          reason: "Generate recent activity for the operator feed.",
        }),
      },
    );
    assert.equal(createExecutionResponse.status, 201);

    const filteredEventsResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/events?ticketId=ticket_project_floop_2&type=worktree.created&limit=1&order=desc`,
    );
    assert.equal(filteredEventsResponse.status, 200);
    const filteredEventsBody = await filteredEventsResponse.json();
    assert.equal(filteredEventsBody.events.length, 1);
    assert.equal(filteredEventsBody.events[0].ticketKey, "FLOOP-2");
    assert.equal(filteredEventsBody.events[0].ticketTitle, "Define first transport contracts");
    assert.equal(filteredEventsBody.events[0].repoSlug, "floop");
    assert.equal(filteredEventsBody.events[0].repoName, "floop");
    assert.equal(filteredEventsBody.events[0].type, "worktree.created");

    const recentEventsResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/events?ticketId=ticket_project_floop_2&limit=2&order=desc`,
    );
    assert.equal(recentEventsResponse.status, 200);
    const recentEventsBody = await recentEventsResponse.json();
    assert.equal(recentEventsBody.events.length, 2);
    assert.equal(recentEventsBody.events.every((event) => event.ticketId === "ticket_project_floop_2"), true);
    assert.equal(recentEventsBody.events[0].createdAt >= recentEventsBody.events[1].createdAt, true);

    const invalidFilterResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/events?order=sideways&limit=0`,
    );
    assert.equal(invalidFilterResponse.status, 400);
  } finally {
    await closeServer(server);
    store.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("API exposes project artifact feeds with ticket context and filters", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "floop-api-"));
  const filename = join(fixtureDir, "floop.sqlite");
  const store = createStore({
    filename,
    seedDemo: true,
    workspaceRoot: "/workspace/floop",
  });
  const server = createFloopServer({ store });

  try {
    await listen(server);
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const executionResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/tickets/ticket_project_floop_2/executions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          role: "developer",
          reason: "Capture artifact feed evidence.",
        }),
      },
    );
    assert.equal(executionResponse.status, 201);
    const executionBody = await executionResponse.json();

    const completeResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/executions/${executionBody.execution.id}/complete`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          outcome: "completed",
          summaryMd: "Execution completed with durable evidence.",
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
          verdict: "passed",
          summaryMd: "Review recorded its evidence for the artifact feed.",
          artifacts: [
            {
              kind: "report",
              label: "Reviewer notes",
              uri: "file:///workspace/floop/.floop/artifacts/floop-2-review.md",
            },
          ],
        }),
      },
    );
    assert.equal(reviewResponse.status, 201);

    const validationResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/tickets/ticket_project_floop_2/validations`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          executionId: executionBody.execution.id,
          repoIds: ["repo_project_floop_floop"],
          commands: ["npm test"],
          verdict: "passed",
          summaryMd: "Validation recorded its evidence for the artifact feed.",
          artifacts: [
            {
              kind: "log",
              label: "Validation output",
              uri: "file:///workspace/floop/.floop/artifacts/floop-2-validation.log",
              metadata: { demoEvidence: true },
            },
          ],
        }),
      },
    );
    assert.equal(validationResponse.status, 201);

    const mergeResponse = await fetch(`${baseUrl}/api/v1/projects/project_floop/tickets/ticket_project_floop_2/merge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        strategy: "squash",
        status: "completed",
        approvedByKind: "human",
        approvedByRef: "jacob",
        summaryMd: "Merged with durable evidence recorded.",
        artifacts: [
          {
            kind: "record",
            label: "Merge commit",
            uri: "https://example.com/floop/commit/123",
          },
        ],
      }),
    });
    assert.equal(mergeResponse.status, 200);

    const artifactsResponse = await fetch(`${baseUrl}/api/v1/projects/project_floop/artifacts?limit=2`);
    assert.equal(artifactsResponse.status, 200);
    const artifactsBody = await artifactsResponse.json();
    assert.equal(artifactsBody.artifacts.length, 2);
    assert.equal(artifactsBody.artifacts[0].label, "Merge commit");
    assert.equal(artifactsBody.artifacts[0].ticketKey, "FLOOP-2");
    assert.equal(artifactsBody.artifacts[0].ticketTitle, "Define first transport contracts");
    assert.equal(artifactsBody.artifacts[1].kind, "log");

    const filteredArtifactsResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/artifacts?ticketId=ticket_project_floop_2&kind=record&limit=1`,
    );
    assert.equal(filteredArtifactsResponse.status, 200);
    const filteredArtifactsBody = await filteredArtifactsResponse.json();
    assert.equal(filteredArtifactsBody.artifacts.length, 1);
    assert.equal(filteredArtifactsBody.artifacts[0].mergeRunId.length > 0, true);
    assert.equal(filteredArtifactsBody.artifacts[0].label, "Merge commit");
  } finally {
    await closeServer(server);
    store.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("API exposes project agent inbox messages and decisions", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "floop-api-"));
  const filename = join(fixtureDir, "floop.sqlite");
  const store = createStore({
    filename,
    seedDemo: true,
    workspaceRoot: "/workspace/floop",
  });
  const server = createFloopServer({ store });

  try {
    await listen(server);
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const createResponse = await fetch(`${baseUrl}/api/v1/projects/project_floop/agent-messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actor: "openclaw",
        source: "webhook",
        intent: "suggest_ticket",
        target: { repoId: "repo_project_floop_floop" },
        summary: "Add fixture coverage for ceremony fan-out",
        body: "The ceremony participant path should be covered with a real adapter fixture.",
        metadata: { confidence: 0.82 },
      }),
    });
    assert.equal(createResponse.status, 201);
    const createBody = await createResponse.json();
    assert.equal(createBody.message.actor, "openclaw");
    assert.equal(createBody.message.status, "pending");
    assert.equal(createBody.message.target.repoId, "repo_project_floop_floop");

    const listResponse = await fetch(`${baseUrl}/api/v1/projects/project_floop/agent-messages?status=pending`);
    assert.equal(listResponse.status, 200);
    const listBody = await listResponse.json();
    assert.equal(listBody.messages.length, 1);
    assert.equal(listBody.messages[0].summary, "Add fixture coverage for ceremony fan-out");

    const updateResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/agent-messages/${createBody.message.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "accepted" }),
      },
    );
    assert.equal(updateResponse.status, 200);
    const updateBody = await updateResponse.json();
    assert.equal(updateBody.message.status, "accepted");

    const eventsResponse = await fetch(`${baseUrl}/api/v1/projects/project_floop/events?type=agent.message_received&limit=5`);
    assert.equal(eventsResponse.status, 200);
    const eventsBody = await eventsResponse.json();
    assert.equal(eventsBody.events.some((event) => event.type === "agent.message_received"), true);
    assert.equal(eventsBody.events.every((event) => event.lane === "agent"), true);

    const invalidResponse = await fetch(`${baseUrl}/api/v1/projects/project_floop/agent-messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actor: "hermes",
        source: "webhook",
        intent: "unknown_intent",
        summary: "Invalid",
      }),
    });
    assert.equal(invalidResponse.status, 400);

    const commentResponse = await fetch(`${baseUrl}/api/v1/projects/project_floop/agent-messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actor: "hermes",
        source: "webhook",
        intent: "comment_on_ticket",
        target: { ticketId: "ticket_project_floop_2" },
        summary: "Reviewer should inspect transport errors",
        body: "Hermes saw repeated transport-contract failures in a downstream run.",
      }),
    });
    assert.equal(commentResponse.status, 201);
    const commentBody = await commentResponse.json();
    const attachResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/agent-messages/${commentBody.message.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "attached", promotedKind: "ticket_event", promotedRef: "ticket_project_floop_2" }),
      },
    );
    assert.equal(attachResponse.status, 200);
    const ticketResponse = await fetch(`${baseUrl}/api/v1/projects/project_floop/tickets/ticket_project_floop_2`);
    assert.equal(ticketResponse.status, 200);
    const ticketBody = await ticketResponse.json();
    const attachedEvent = ticketBody.ticket.events.find((event) => event.type === "agent.message_attached");
    assert.ok(attachedEvent);
    assert.match(attachedEvent.detail, /transport-contract failures/);

    const artifactResponse = await fetch(`${baseUrl}/api/v1/projects/project_floop/agent-messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actor: "openclaw",
        source: "webhook",
        intent: "submit_artifact",
        target: { ticketId: "ticket_project_floop_2" },
        summary: "External trace is ready",
        metadata: {
          artifact: {
            kind: "record",
            label: "External trace",
            uri: "https://example.com/floop/trace",
            metadata: { source: "openclaw" },
          },
        },
      }),
    });
    assert.equal(artifactResponse.status, 201);
    const artifactBody = await artifactResponse.json();
    const promoteArtifactResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/agent-messages/${artifactBody.message.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "accepted" }),
      },
    );
    assert.equal(promoteArtifactResponse.status, 200);
    const promoteArtifactBody = await promoteArtifactResponse.json();
    assert.equal(promoteArtifactBody.message.promotedKind, "artifact");

    const externalArtifactsResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/artifacts?ticketId=ticket_project_floop_2&kind=record&limit=5`,
    );
    assert.equal(externalArtifactsResponse.status, 200);
    const externalArtifactsBody = await externalArtifactsResponse.json();
    const externalArtifact = externalArtifactsBody.artifacts.find((artifact) => artifact.label === "External trace");
    assert.ok(externalArtifact);
    assert.equal(externalArtifact.ticketKey, "FLOOP-2");
    assert.equal(externalArtifact.uri, "https://example.com/floop/trace");

    const repeatPromoteResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/agent-messages/${artifactBody.message.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "accepted" }),
      },
    );
    assert.equal(repeatPromoteResponse.status, 200);
    const repeatedArtifactsResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/artifacts?ticketId=ticket_project_floop_2&kind=record&limit=10`,
    );
    assert.equal(repeatedArtifactsResponse.status, 200);
    const repeatedArtifactsBody = await repeatedArtifactsResponse.json();
    assert.equal(
      repeatedArtifactsBody.artifacts.filter((artifact) => artifact.label === "External trace").length,
      1,
    );

    const ceremonyResponse = await fetch(`${baseUrl}/api/v1/projects/project_floop/ceremonies`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "daily_triage" }),
    });
    assert.equal(ceremonyResponse.status, 201);
    const ceremonyBody = await ceremonyResponse.json();
    const ceremonyInputResponse = await fetch(`${baseUrl}/api/v1/projects/project_floop/agent-messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actor: "hermes",
        source: "webhook",
        intent: "submit_ceremony_input",
        target: { runId: ceremonyBody.ceremony.id },
        summary: "External triage signal",
        body: "Hermes recommends treating transport failures as the current triage focus.",
        metadata: { confidence: 0.74 },
      }),
    });
    assert.equal(ceremonyInputResponse.status, 201);
    const ceremonyInputBody = await ceremonyInputResponse.json();
    const promoteCeremonyInputResponse = await fetch(
      `${baseUrl}/api/v1/projects/project_floop/agent-messages/${ceremonyInputBody.message.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "accepted" }),
      },
    );
    assert.equal(promoteCeremonyInputResponse.status, 200);
    const promoteCeremonyInputBody = await promoteCeremonyInputResponse.json();
    assert.equal(promoteCeremonyInputBody.message.promotedKind, "ceremony_proposal");
    assert.match(promoteCeremonyInputBody.message.promotedRef, /^ceremony_proposal_/);

    const ceremoniesResponse = await fetch(`${baseUrl}/api/v1/projects/project_floop/ceremonies`);
    assert.equal(ceremoniesResponse.status, 200);
    const ceremoniesBody = await ceremoniesResponse.json();
    const promotedCeremony = ceremoniesBody.ceremonies.find((ceremony) => ceremony.id === ceremonyBody.ceremony.id);
    assert.ok(promotedCeremony);
    const externalProposal = promotedCeremony.proposals.find(
      (proposal) => proposal.id === promoteCeremonyInputBody.message.promotedRef,
    );
    assert.ok(externalProposal);
    assert.equal(externalProposal.kind, "note");
    assert.equal(externalProposal.status, "pending");
    assert.equal(externalProposal.payload.agentMessageId, ceremonyInputBody.message.id);
    assert.match(externalProposal.payload.note, /transport failures/);
  } finally {
    await closeServer(server);
    store.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

function findColumn(columns, state) {
  const column = columns.find((item) => item.state === state);
  assert.ok(column, `Expected board column ${state}`);
  return column;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }

    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
