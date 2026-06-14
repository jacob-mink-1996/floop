import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createStore } from "../src/store.mjs";

test("SQLite store persists ticket state and board aggregates across reopen", () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "floop-store-"));
  const filename = join(fixtureDir, "floop.sqlite");

  try {
    const store = createStore({
      filename,
      seedDemo: true,
      workspaceRoot: "/workspace/floop",
    });
    store.updateProjectPolicy("project_floop", { interactionMode: "autonomous_with_review" });

    const createdTicket = store.createTicket("project_floop", {
      title: "Implement board read model",
      brief: "Add grouped project board aggregates for the operator UI.",
      state: "PROPOSED",
      priority: "high",
      assignedRole: "developer",
      repoTargets: [
        {
          repoId: "repo_project_floop_floop",
          baseRef: "main",
          branchName: "floop-3-board-aggregate",
          targetScopeMd: "services/api read models",
        },
      ],
    });

    store.transitionTicket("project_floop", createdTicket.id, {
      targetState: "WORKING",
      reason: "Picked up for the next MVP implementation pass.",
      reasonCode: "operator_started_work",
    });

    const execution = store.createExecution("project_floop", createdTicket.id, {
      role: "developer",
      reason: "Capture durable evidence for the board read model pass.",
    });
    store.completeExecution("project_floop", execution.id, {
      outcome: "completed",
      summaryMd: "Board aggregate implementation finished.",
      artifacts: [
        {
          kind: "patch",
          label: "Board aggregate diff",
          uri: "file:///workspace/floop/.floop/artifacts/floop-3.patch",
        },
      ],
    });

    const boardBeforeClose = store.getProjectBoard("project_floop");
    const reviewingColumnBeforeClose = boardBeforeClose.columns.find((column) => column.state === "REVIEWING");
    assert.equal(reviewingColumnBeforeClose.count, 1);

    store.close();

    const reopenedStore = createStore({
      filename,
      seedDemo: false,
      workspaceRoot: "/workspace/floop",
    });

    const filteredTickets = reopenedStore.listTickets("project_floop", {
      states: ["REVIEWING"],
      search: "board read model",
    });
    assert.equal(filteredTickets.length, 1);
    assert.equal(filteredTickets[0].key, "FLOOP-3");
    assert.equal(filteredTickets[0].repoCount, 1);

    const persistedTicket = reopenedStore.getTicket("project_floop", createdTicket.id);
    assert.equal(persistedTicket.state, "REVIEWING");
    assert.equal(persistedTicket.events.length, 7);
    assert.equal(persistedTicket.repoTargets[0].repoName, "floop");
    assert.equal(persistedTicket.executions.length, 2);
    assert.equal(
      persistedTicket.executions.find((persistedExecution) => persistedExecution.id === execution.id).artifacts[0].label,
      "Board aggregate diff",
    );
    assert.equal(persistedTicket.artifacts[0].kind, "patch");
    assert.equal(persistedTicket.artifacts[0].metadata.floopDurability.storageMode, "managed_local_file");
    assert.equal(persistedTicket.artifacts[0].metadata.floopDurability.copyPolicy, "created_by_floop");

    reopenedStore.close();
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
