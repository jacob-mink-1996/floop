# Agent Steering, Protocol, And Inbox Big Pass Plan

## Objective

Implement the next large agent-control pass in one coordinated workstream:

1. Add hard-steer worktree policy so interrupt-and-resume can preserve in-flight work when appropriate.
2. Spike and implement a stronger Codex adapter path through Codex MCP or SDK while preserving `codex_exec` as the reliable default.
3. Upgrade Agent Inbox and external-agent UX so external agents can steer, dispatch, attach evidence, and request status through one coherent operator-facing flow.

This plan assumes the current baseline already has:

- ticket comments with context/steer/start intent;
- `POST /executions/:executionId/steer`;
- `codex_exec --json` thread capture;
- `codex exec resume <threadId>` for interrupt-and-resume;
- Agent Inbox persistence, CLI, and MCP facade;
- interaction modes and basic autonomous promotion.

## Product Shape

The operator-facing experience should become:

- External agents, humans, and Floop all speak through ticket/workflow messages.
- A user comment can be passive context, live/near-live steering, or a dispatch-start note.
- If steering interrupts active work, Floop preserves the best available work context according to an explicit policy.
- If an agent or external tool sends two steering messages quickly, the latest message supersedes stale resumed work.
- Codex remains usable in simple headless mode, but richer adapters can opt into cleaner native session control.
- The UI shows the result of each message: context attached, queued, interrupted, resumed, superseded, failed, converted, or dispatched.

## Workstream 1: Hard-Steer Worktree Policy

### Problem

Hard-steer currently resumes the same native Codex thread but creates a new Floop execution iteration and a new worktree path. This is safe, but interrupted uncommitted work may not be visible to the resumed run.

### Policy Model

Add a project-level or execution-profile setting:

```ts
type SteeringWorktreePolicy =
  | "new_iteration_worktree"
  | "reuse_interrupted_worktree"
  | "copy_interrupted_worktree";
```

Recommended defaults:

- `new_iteration_worktree` for generic shell/custom harnesses.
- `copy_interrupted_worktree` for `codex_exec` once tested.
- `reuse_interrupted_worktree` only when the adapter can be safely stopped and Floop can transfer ownership without confusing evidence history.

### Policy Semantics

`new_iteration_worktree`:

- current behavior;
- create the next iteration worktree from repo/base branch state;
- include steering note and prior execution artifacts in prompt;
- safest but may lose uncommitted interrupted work.

`copy_interrupted_worktree`:

- create the next iteration worktree path;
- copy the interrupted worktree contents into it, excluding transient directories and nested `.git` internals that should not be duplicated blindly;
- preserve `.floop-worktree.json` with the new execution id;
- best default for steering because it preserves in-flight edits while retaining separate execution ownership.

`reuse_interrupted_worktree`:

- transfer the interrupted worktree row to the resumed execution or allow multiple executions to reference the same path through a worktree lineage table;
- mark the interrupted execution worktree as `transferred`;
- resumed execution works in the same filesystem path;
- lowest friction for agents, highest risk for audit ambiguity.

### Data Model

Add:

- `project_policies.steering_worktree_policy` or role-profile config equivalent.
- `worktrees.resumed_from_worktree_id`.
- optional `worktrees.lineage_id`.
- new worktree statuses:
  - `needs_continue`
  - `cancelled`
  - `transferred`
  - `copied`
  - existing statuses remain valid.

### Implementation Steps

1. Add domain/contract enum for steering worktree policy.
2. Add schema/migration and project settings field.
3. Thread policy into `continueExecution` / `steerExecution`.
4. Implement `copy_interrupted_worktree`:
   - identify interrupted execution's active worktree;
   - materialize the new iteration worktree;
   - copy files from old to new with an explicit ignore list:
     - `.git` file/dir handling must preserve valid worktree metadata;
     - `node_modules`, `.floop/artifacts`, `.floop/executions`, build outputs, and obvious cache dirs should not be copied unless they are inside the target repo and required for the worktree state;
   - update `.floop-worktree.json` for the new execution.
5. Implement `reuse_interrupted_worktree` only after copy mode is stable.
6. Surface policy in settings and execution detail.

### Tests

- hard-steer with `new_iteration_worktree` keeps current behavior;
- hard-steer with `copy_interrupted_worktree` preserves an uncommitted file from the interrupted worktree;
- copied worktree has new execution metadata;
- copied worktree does not duplicate forbidden cache/artifact dirs;
- rapid double-steer copies from the latest active resumed worktree, not the original stale worktree;
- reviewer/validator lanes do not reuse developer worktree state unless explicitly routed as rework;
- restart cleanup handles copied/transferred worktrees without deleting evidence needed for audit.

## Workstream 2: Codex MCP/SDK Adapter

### Problem

`codex_exec` is reliable and easy to test, but it is still a process-oriented interface. The stronger long-term path is a session-oriented adapter through Codex MCP or SDK.

### Evaluation Criteria

Choose the adapter path that provides:

- durable thread/session id;
- structured event stream;
- explicit run/turn lifecycle;
- resumable sessions;
- ability to send subsequent prompts without rebuilding shell command state;
- clear cancellation behavior;
- stable authentication behavior in a local user environment;
- testability with a fake server/client.

### Candidate A: Codex MCP Adapter

Shape:

- launch or connect to `codex mcp-server`;
- call `codex` to start a session;
- persist `structuredContent.threadId`;
- call `codex-reply` for continuation/steering;
- map MCP tool response to Floop result contract.

Pros:

- documented continuation tool;
- clean tool boundary;
- likely useful for other agent-tooling integration.

Risks:

- MCP process lifecycle management;
- streaming/partial progress may need additional protocol handling;
- fake MCP testing needs a small local fixture server.

### Candidate B: Codex SDK Adapter

Shape:

- use Codex TypeScript or Python SDK from a Floop worker adapter;
- start/resume thread;
- call `run()` for normal work and continuation;
- persist thread id.

Pros:

- direct programmatic thread abstraction;
- no CLI arg construction;
- likely cleaner cancellation/session API.

Risks:

- dependency/runtime packaging;
- SDK availability/version drift;
- Floop backend is Node ESM, so Python SDK adds process boundary unless we use TypeScript SDK.

### Recommended Sequence

1. Keep `codex_exec` as default.
2. Add an adapter capability test harness independent of real Codex:
   - fake Codex MCP server;
   - fake Codex SDK wrapper or mock module boundary.
3. Implement `codex_mcp` as a spike behind role-profile config.
4. Compare:
   - session capture;
   - interrupt/resume behavior;
   - logs/progress;
   - cancellation;
   - auth failure reporting.
5. Promote one adapter to supported once it passes the same execution-driver contract tests as `codex_exec`.

### Adapter Contract

Extract a harness interface:

```ts
interface HarnessAdapter {
  kind: string;
  capabilities: string[];
  start(input: HarnessStartInput): Promise<HarnessRunResult>;
  resume?(input: HarnessResumeInput): Promise<HarnessRunResult>;
  cancel?(input: HarnessCancelInput): Promise<void>;
}
```

Then map:

- `codex_exec`: process adapter, `interrupt_and_resume`;
- `codex_mcp`: session adapter, `interrupt_and_resume`, maybe `live_reply` if verified;
- `codex_sdk`: session adapter, maybe `live_reply` if verified;
- `shell`: process adapter, `queued_context`, optional `cooperative_inbox`.

### Tests

- all adapters satisfy the same result contract;
- auth-required failures are clear;
- session id persists;
- resume prompt includes steering note;
- cancellation stops the active work;
- rapid double-steer supersedes stale resumed work;
- adapter-specific events become run observability signals.

## Workstream 3: Agent Inbox And External-Agent UX

### Problem

Agent Inbox exists, but the operator experience should become more action-oriented and connected to ticket comments/steering. External agents should not just drop messages; they should be able to request concrete Floop actions under policy control.

### Message Intent Model

Keep existing intents, but add or formalize action metadata:

- `comment_on_ticket`
  - `commentMode: context | steer | dispatch`
  - `steeringMode: soft_steer | hard_steer`
  - `role` for dispatch/start requests
- `suggest_dispatch`
  - role, reason, target ticket
- `submit_artifact`
  - artifact payload, evidence role
- `request_status`
  - target ticket/execution/project scope
- `raise_risk`
  - severity, impacted ticket/repo

Potential new intents:

- `steer_execution`
- `request_worktree_policy`
- `request_human_input`

Recommendation: avoid adding `steer_execution` at first if `comment_on_ticket` with `commentMode: steer` is enough. Add it only if external agents need a non-comment command semantic.

### UX Surfaces

#### Ticket Conversation

Add delivery state to conversation items:

- Context attached
- Steering queued
- Interrupted
- Resumed
- Superseded
- Failed
- Started

Show the target execution and resumed execution link for steering comments.

#### Agent Inbox

Move from generic inbox actions to intent-specific action rows:

- Context comment: Attach to ticket
- Steering comment: Steer active run / Queue context / Dismiss
- Dispatch suggestion: Start role / Change role / Dismiss
- Artifact: Attach evidence / Mark demo evidence / Dismiss
- Status request: Reply with status / Link run proof / Dismiss
- Risk: Convert to ticket / Attach to ticket / Dismiss

#### Ops/Attention

Surface only items requiring action:

- failed steering delivery;
- queued steering that could not resume;
- external dispatch suggestions in guarded modes;
- artifact submissions needing trust;
- policy/risk gates;
- stale resumed work superseded by newer steering.

### API Additions

Extend Agent Inbox actions:

- `POST /agent-messages/:messageId/actions/attach-comment`
- `POST /agent-messages/:messageId/actions/steer`
- `POST /agent-messages/:messageId/actions/dispatch`
- `POST /agent-messages/:messageId/actions/attach-artifact`
- `POST /agent-messages/:messageId/actions/reply-status`

Alternatively keep `PATCH /agent-messages/:id` for simple status changes and add only action endpoints that perform domain mutations.

### MCP Facade Additions

Add tools:

- `floop_steer_execution`
- `floop_comment_ticket`
- `floop_start_ticket_agent`
- `floop_attach_artifact`
- `floop_get_ticket_detail`
- `floop_get_execution`

Each tool should return Floop delivery metadata and policy status, not just raw API payload.

### Tests

- external agent sends steer request for active ticket and operator accepts;
- external agent sends steer request with no active execution and Floop queues context;
- autopilot handles low-risk comments but does not hard-steer without policy;
- fully autonomous can hard-steer active work if project policy allows it;
- status request returns active execution/worktree/proof summary;
- submitted artifact can be marked as demo evidence and satisfy merge policy;
- Agent Inbox UI shows next obvious action first for each intent.

## Cross-Workstream Design Decisions

### Decision 1: Native Session Scope

Keep native session reuse ticket/role scoped.

Do not use project-wide session reuse by default. It is too likely to leak old plans, stale assumptions, and unrelated ticket context.

### Decision 2: Steering Supersession

Latest hard-steer wins for the same ticket/role/session chain.

Implementation rule:

- stale steering requests resolve to the latest active continuation;
- new hard-steer marks the latest active continuation `needs_continue`;
- next continuation includes the newest steering note;
- older resumed work is visible in history but no longer considered the active steering target.

### Decision 3: Worktree Preservation

Default to `copy_interrupted_worktree` for hard-steer once implemented and verified.

Rationale:

- preserves in-flight uncommitted work;
- keeps Floop execution/worktree ownership clear;
- avoids reusing a path that another process may still have open.

### Decision 4: Adapter Promotion

Do not replace `codex_exec` until MCP/SDK passes the same local contract tests.

## Implementation Order

### Phase 0: Guardrails

1. Add top-level goal checklist to this doc as implementation progresses.
2. Keep `npm test` and `npm run check:ui` green after each major slice.
3. Add fixtures before real Codex dependency where possible.

### Phase 1: Worktree Policy

1. Add enum/config/schema.
2. Implement `new_iteration_worktree` as explicit policy.
3. Implement `copy_interrupted_worktree`.
4. Add store and execution-driver tests.
5. Add settings UI.

### Phase 2: Harness Adapter Abstraction

1. Extract process adapter logic behind a harness interface.
2. Re-home `codex_exec` into that interface.
3. Keep shell/mock adapters passing.
4. Add contract tests that each adapter must satisfy.

### Phase 3: Codex MCP Or SDK Spike

1. Build fake MCP/SDK test fixture.
2. Implement `codex_mcp` or `codex_sdk` behind role-profile config.
3. Verify session capture, resume, cancellation, logs, and auth failures.
4. Document which adapter should be default.

### Phase 4: Agent Inbox Actions

1. Add domain action endpoints for steer, dispatch, attach artifact, status reply.
2. Extend MCP facade tools.
3. Update CLI wrapper where useful.
4. Add store/API/MCP tests.

### Phase 5: UI/UX Pass

1. Ticket conversation delivery states.
2. Agent Inbox intent-specific actions.
3. Ops/Attention exception focus.
4. Browser smoke updates and visual pass.

### Phase 6: Demo And Proof

1. Record snippets:
   - hard-steer preserving worktree state;
   - rapid second steer superseding first;
   - external agent steering via MCP/CLI;
   - Codex MCP/SDK adapter session resume if supported.
2. Save proof bundle with logs and trim metadata.

## Completion Criteria

- Hard-steer can preserve interrupted worktree state under an explicit policy.
- `codex_exec` still works and remains tested.
- A session-oriented Codex adapter spike is implemented or explicitly rejected with evidence.
- External agents can request/comment/steer/dispatch/attach evidence through stable APIs and MCP tools.
- UI shows what happened to each comment/message in actionable terms.
- Rapid repeated steering remains guarded.
- `npm test` passes.
- `npm run check:ui` passes.
- Implementation summary and findings are written after the pass.

## Known Risks

- Copying worktrees can corrupt git worktree metadata if `.git` handling is wrong.
- True `live_reply` may not be possible even with MCP/SDK if Codex serializes turns.
- Adding too many inbox actions can make the UI noisy; intent-specific primary actions should stay compact.
- Role-profile config could become fragmented if worktree policy, adapter kind, and interaction mode are split across too many settings.
