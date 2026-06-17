# Agent Steering Implementation Summary

## Implemented

- Added execution-level native harness session metadata:
  - `harnessKind`
  - `externalThreadId`
  - `externalSessionId`
  - `externalConversationId`
  - `harnessCapabilities`
  - `resumedFromExecutionId`
  - `steeringMetadata`
- Added a SQLite migration for existing databases and updated the base schema for fresh databases.
- Added store support for:
  - updating harness session metadata as a running adapter reports it;
  - steering an execution;
  - hard-steering by interrupting the current Floop execution and creating a same-ticket/same-role continuation with the same native harness session id;
  - rapid repeated steering, where a stale second steering request is retargeted to the latest active resumed continuation.
- Added `POST /api/v1/projects/:projectId/executions/:executionId/steer`.
- Updated the ticket comment UI so `Steer active run` calls the steering endpoint instead of only creating a tagged comment.
- Updated the Codex exec adapter to:
  - run `codex exec --json`;
  - parse `thread.started.thread_id`;
  - persist the Codex thread id and `interrupt_and_resume` capability;
  - run steered continuations as `codex exec --json resume <threadId>`;
  - prepend the steering note to the resumed prompt.

## Tested

- Store hard-steer creates a same-ticket/same-role continuation with native Codex thread metadata.
- Store rapid repeated steering retargets stale execution ids to the latest active resumed execution.
- API steering route records steering comments and returns delivery metadata.
- API rapid repeated steering reports the interrupted resumed execution and creates the next continuation.
- Codex exec driver captures `thread.started.thread_id` from JSONL stdout.
- Codex exec driver resumes with `codex exec --json resume <threadId>` and includes the steering note in the prompt.
- Existing HITL, execution, route, schema, and browser checks continue to pass.

## Session Continuation Audit

### Current Floop Semantics

Floop session continuation is ticket/role scoped:

- A continuation belongs to the same ticket.
- A continuation keeps the same role.
- A continuation increments the Floop execution iteration.
- A continuation inherits the native harness session metadata when it exists.
- A continuation records `resumedFromExecutionId`.

This is the correct default. A developer session should not be reused by a reviewer or validator, because those lanes are supposed to be independent evidence checks. A project-wide session is also too broad: it risks leaking unrelated tickets, stale plans, and prior implementation assumptions into new work.

### When To Resume The Same Native Harness Session

Resume the same native harness session when all are true:

- same project;
- same ticket;
- same lane role;
- same continuation chain;
- same repo/worktree context or an explicit steering/continuation prompt that explains the changed worktree;
- the previous run ended as `needs_continue`, `blocked` and answered, or was interrupted for steering;
- the harness has a durable session/thread id.

Do not resume the same native harness session when:

- moving from developer to reviewer or validator;
- moving from reviewer to validator;
- starting a different ticket, even in the same project;
- running merge integration after validation;
- the previous run failed from auth, environment, corrupted state, or driver crash unless the operator explicitly requests resume;
- the harness does not expose a durable session id.

### Harness Capability Findings

- `codex_exec` now supports `queued_context` and `interrupt_and_resume`.
- `codex_exec` does not support true live injection into an already-running turn. Steering is implemented as interrupt and resume.
- Shell/custom harnesses currently support queued context only unless their command is explicitly enhanced to read a steering inbox or expose a session handle.
- Codex SDK or Codex MCP should be the next adapter to evaluate for richer `live_reply` or cleaner thread control.

### Important Limitation

Floop continuations still create a new Floop execution iteration and worktree path. Hard-steer now resumes the same native Codex thread, but it does not automatically reuse the prior iteration's worktree path. That matches existing continuation semantics and keeps worktree ownership simple, but it means partial uncommitted changes in the interrupted worktree are not automatically present in the resumed worktree.

Recommended follow-up: add an explicit worktree continuation policy for hard steer:

- `new_iteration_worktree`: current behavior, safest for isolation;
- `reuse_interrupted_worktree`: best for preserving in-flight uncommitted work, but requires worktree ownership transfer;
- `copy_interrupted_worktree`: middle ground, preserving state while keeping iteration ownership distinct.

### Rapid Comment Handling

If an operator leaves two steer comments quickly:

- the first hard-steer creates a resumed execution;
- the second request can arrive with a stale execution id;
- Floop now resolves that stale id to the latest active same-ticket/same-role continuation with the same native thread id;
- it marks that active continuation as `needs_continue`;
- it creates the next continuation with the same native session id and the newer steering note.

This prevents the first resumed run from racing ahead with stale steering context when the operator has already superseded it.

## Big-Pass Update: Worktree Policy, Harness Bridges, And Inbox Actions

### Implemented

- Added `steeringWorktreePolicy` to project policy with three named modes:
  - `new_iteration_worktree`;
  - `copy_interrupted_worktree`;
  - `reuse_interrupted_worktree`.
- Added worktree continuation metadata:
  - `resumedFromWorktreeId`;
  - `lineageId`.
- Hard-steer continuations now stamp the selected worktree policy into execution steering metadata.
- `copy_interrupted_worktree` now copies useful interrupted-worktree files into the resumed worktree while skipping Git internals and bulky generated directories.
- Rapid repeated hard steering now preserves worktree lineage from the latest active resumed run.
- Added explicit `codex_sdk` and `codex_mcp` bridge adapter kinds behind role-profile config while keeping `codex_exec` as the default reliable path.
- Extended the MCP facade with first-class tools for:
  - steering an execution;
  - attaching ticket evidence;
  - dispatch suggestion;
  - run status;
  - existing generic Agent Inbox append.
- Polished the Cockpit Attention queue for external-agent messages with intent-specific labels, action text, and compact metadata chips.

### Verified

- `npm test`
- `npm run check:ui`

### Current Follow-Ups

- `reuse_interrupted_worktree` is represented as a policy option, but the safe production default remains `new_iteration_worktree`; `copy_interrupted_worktree` is the practical middle path for preserving in-flight files without sharing ownership of the same directory.
- The `codex_sdk` and `codex_mcp` adapters are bridge-command spikes, not native SDK/MCP clients yet. They prove the role-profile contract and result path while preserving the tested `codex_exec` behavior.
