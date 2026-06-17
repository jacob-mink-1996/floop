# Agent Steering And Session Resumption Plan

## Goal

Make ticket comments able to steer active agent work, with a default strategy that works across most harnesses: record the operator note, interrupt the active run when requested, and resume the same underlying agent session with the steering note as the next instruction.

This should work first for Codex, then generalize to other harnesses through a small capability contract.

## Current State

- Ticket comments can already be recorded as context.
- The ticket UI can distinguish passive context, steering active work, and starting work with a selected agent.
- Floop has execution continuations through `continueExecution`, but those are Floop-level iterations.
- Current continuations create a new execution iteration and a new worktree path.
- The database does not currently persist a native agent session/thread id on `executions`.
- The Codex adapter currently runs `codex exec`, passes the prompt through stdin, closes stdin, and watches stdout/stderr/result artifacts.
- Because stdin is closed and no native session id is persisted, a running Codex execution cannot yet receive a deterministic live steering message.

## Research Summary

Codex has three relevant programmatic surfaces:

- `codex exec`: good for one-shot headless execution. It can emit JSONL events and can resume a prior session with `codex exec resume <SESSION_ID>`, but it is not a documented live message pipe into an already-running turn.
- Codex SDK: starts or resumes a thread and can run additional prompts on the same thread.
- Codex MCP server: exposes `codex` to start a session and `codex-reply` to continue one by thread id.

For broad harness support, the most reliable common behavior is interrupt-and-resume:

1. Persist the native session handle as soon as the harness reports it.
2. When the user steers active work, record the steering note on the ticket and execution.
3. Cancel the currently running process cleanly.
4. Start a resumed run against the same native session/thread with a prompt containing the steering note and current Floop context.

This gives the user an immediate steering mechanism without requiring every harness to support true live injection.

## Harness Capability Contract

Add an internal harness capability model:

```ts
type SteeringCapability =
  | "queued_context"
  | "cooperative_inbox"
  | "interrupt_and_resume"
  | "live_reply";

type SteeringMode = "context" | "soft_steer" | "hard_steer";
```

Capability meanings:

- `queued_context`: the steering note is persisted and included in later prompts.
- `cooperative_inbox`: the running agent is instructed to poll a steering inbox file.
- `interrupt_and_resume`: Floop can cancel the active process and resume the same native session/thread.
- `live_reply`: Floop can send a new message to the active session without cancelling the current process, if the harness supports that safely.

Initial policy:

- `context` always uses `queued_context`.
- `soft_steer` records a steering note and uses `cooperative_inbox` if available.
- `hard_steer` prefers `live_reply`, then `interrupt_and_resume`, then falls back to `queued_context` with a visible “queued” status.

## Data Model

Add persisted agent session metadata. The exact shape can be normalized or JSON-backed, but the fields should support:

- `execution_id`
- `harness_kind` such as `codex_exec`, `codex_sdk`, `codex_mcp`, `opencode`, `openclaw`, `hermes`, or `custom`
- `external_thread_id`
- `external_session_id`
- `external_conversation_id`
- `process_id`
- `capabilities`
- `status`
- `started_at`
- `updated_at`

Add steering event/message metadata:

- `commentMode: "steer"`
- `steeringMode: "soft_steer" | "hard_steer"`
- `targetExecutionId`
- `targetHarnessKind`
- `deliveryStatus: "queued" | "delivered" | "interrupted" | "resumed" | "failed"`
- `resumedExecutionId` when hard steering creates a new execution iteration or attempt

## API

Add:

- `POST /api/v1/projects/:projectId/executions/:executionId/steer`

Request:

```json
{
  "body": "Use SQLite for the first pass and avoid adding Redis.",
  "mode": "hard_steer",
  "actor": "operator",
  "source": "human"
}
```

Response:

```json
{
  "message": {},
  "delivery": {
    "status": "resumed",
    "capability": "interrupt_and_resume",
    "resumedExecutionId": "execution_..."
  }
}
```

The endpoint should be idempotent enough for UI retry by storing the comment first and then updating delivery metadata as the harness action proceeds.

## Codex Implementation

### Phase 1: Codex Exec Session Capture

- Run Codex with `--json` so stdout emits machine-readable events.
- Parse `thread.started.thread_id` from the JSONL stream.
- Persist the Codex thread id against the active execution.
- Keep recording human-readable logs and final message artifacts.
- Update tests to prove the driver captures the thread id from Codex JSONL.

### Phase 2: Codex Exec Interrupt And Resume

- On hard steer:
  - create an attached `comment_on_ticket` steering message;
  - mark delivery as `interrupted`;
  - cancel the active process using the existing process-tree cancellation path;
  - create a continuation execution for the same ticket/role;
  - run `codex exec resume <thread_id>` with a steering prompt;
  - mark delivery as `resumed` and link the resumed execution id.
- The resumed prompt should include:
  - the steering note;
  - the ticket brief, acceptance criteria, and current execution context;
  - a reminder to inspect current worktree state before changing files;
  - the same result contract as normal runs.

### Phase 3: Codex SDK Or MCP Adapter

- Add an optional adapter kind for `codex_sdk` or `codex_mcp`.
- Use Codex SDK thread ids or Codex MCP `codex` / `codex-reply`.
- Prefer SDK/MCP for future live or near-live steering because those surfaces model a long-lived thread directly.
- Keep `codex_exec` as the conservative, easy-to-debug default until SDK/MCP behavior is proven in our worker model.

## Generic Harness Implementation

Every harness adapter should expose:

```ts
interface HarnessAdapter {
  kind: string;
  capabilities: SteeringCapability[];
  start(input): Promise<HarnessRun>;
  cancel(run): Promise<void>;
  resume?(run, steering): Promise<HarnessRun>;
  sendMessage?(run, steering): Promise<SteeringDelivery>;
}
```

For harnesses without native sessions:

- support `queued_context`;
- optionally support `cooperative_inbox`;
- implement `interrupt_and_resume` as a fresh process with the prior worktree and all prior ticket/execution context.

For harnesses with native sessions:

- persist their native session/thread id;
- implement `resume`;
- implement `sendMessage` only when the harness documents safe active-turn message delivery.

## UI Behavior

Ticket comments should present:

- `Context`: always available, never interrupts or dispatches.
- `Steer active run`: available only when an execution is active.
- For steer mode:
  - default to `soft_steer` if we only have queued/cooperative delivery;
  - show `Interrupt and resume` when the active harness supports it;
  - label the resulting ticket event as `Queued`, `Interrupted`, `Resumed`, or `Failed`.
- `Start with agent`: available when no execution is active and the ticket can be dispatched.

The UI should avoid promising live steering unless the harness reports `live_reply`.

## Tests

Unit tests:

- ordinary comment remains passive context;
- steer comment targets the active execution;
- steer comment is rejected or queued when no active execution exists;
- hard steer chooses `live_reply` before `interrupt_and_resume`;
- hard steer falls back to queued context when no delivery capability exists;
- delivery metadata transitions from queued/interrupted/resumed/failed correctly;
- Codex JSONL parser captures `thread.started.thread_id`;
- Codex resume args use `codex exec resume <thread_id>`.

Integration tests:

- active Codex execution receives hard steer, gets cancelled, and resumes with same Codex thread id;
- resumed execution receives steering note in prompt;
- worktree state is preserved or explicitly reconciled before resumed work starts;
- ticket detail shows steering event and resumed execution link;
- failed resume leaves a clean ticket comment explaining what happened;
- soft steer records context without cancelling the process.

## Open Questions

- Should hard steer create a new Floop execution iteration, or keep the same execution id with an internal attempt record?
- If the current execution has already committed partial work, should the resumed execution reuse the same worktree path or a new iteration worktree?
- Should “steer” be available to automation agents through MCP as a first-class tool?
- How aggressively should Floop cancel a process if the harness can checkpoint but not immediately stop?

## Recommended Next Step

Implement Phase 1 and Phase 2 for `codex_exec` first. That gives us useful steering with the harness we already run, while keeping the design compatible with Codex SDK/MCP and other agent harnesses later.
