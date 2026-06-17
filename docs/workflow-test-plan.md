# Workflow Test Plan

This plan covers scenario tests that should protect Floop against the real-world failures we have seen while recording demos and running long autonomous loops. It includes HITL propagation, but it is broader than HITL.

## Goals

- Agents should always receive the context needed to make the next decision.
- User comments, HITL answers, reviews, validation evidence, merge status, and demo proof should cross the right workflow boundaries.
- Normal communication should not accidentally mutate work state.
- Long-running demos should be repeatable, inspectable, and resumable without hand-fixing state.

## Phase 1: HITL Context Propagation

1. Developer clarification reaches reviewer context. Covered.
   - Setup: developer blocks with `needs_human_input`, user answers, developer continues and completes.
   - Assert: reviewer `context.json` includes both the original question and the user answer.
   - Risk covered: reviewer misses clarified scope and rejects or approves against the wrong criteria.

2. Reviewer clarification reaches validator context. Covered.
   - Setup: reviewer blocks, user or architect answers, reviewer continues and passes.
   - Assert: validator `context.json` includes the reviewer question and answer.
   - Risk covered: validation runs the wrong checks because review-time scope was lost.

3. Validator clarification reaches merge/rework context. Covered.
   - Setup: validator blocks, answer changes validation scope, validator passes, merge conflict or rework occurs.
   - Assert: rework execution context includes validator clarification and validation evidence.
   - Risk covered: rework agent preserves code but violates validation constraints.

4. Ordinary comments reach later agents without redispatch. Covered.
   - Setup: user leaves a ticket comment while no execution is blocked.
   - Assert: later developer/reviewer/validator context includes the comment; no new execution starts from the comment alone.
   - Risk covered: useful context is lost, or comments accidentally trigger work.

5. Multiple HITL questions stay ordered and scoped. Covered.
   - Setup: developer and reviewer both ask questions on the same ticket.
   - Assert: both answers are present in chronological order; each request continues only its own execution.
   - Risk covered: agents apply the wrong answer to the wrong lane.

6. Parallel tickets do not leak HITL context. Covered.
   - Setup: two tickets have similar questions and answers.
   - Assert: each execution context only includes its ticket's comments/events.
   - Risk covered: agents copy requirements across unrelated work.

7. Parent-to-child propagation. Covered.
   - Setup: parent planning/pre-work ticket gets a HITL clarification, then child feature tickets are created.
   - Assert: child execution context includes relevant parent clarification or an explicit parent context summary.
   - Risk covered: feature tickets lose product decisions made during planning.

8. Child-to-parent rollup. Covered.
   - Setup: child ticket receives a critical HITL clarification and completes.
   - Assert: parent summary/review context can see the child clarification.
   - Risk covered: parent-level review misses important implementation constraints.

9. Stale/cancelled HITL handling. Covered for restart and execution cancel.
   - Setup: ticket is restarted or execution cancelled after a question, then user answers the old request.
   - Assert: answer is retained as context but does not revive cancelled work.
   - Risk covered: old answers resurrect stale branches.

10. Sensitive HITL redaction boundary. Covered for credential-like HITL answers in later agent context.
    - Setup: user provides a credential-like answer.
    - Assert: broad downstream context receives a redacted reference, while a scoped secret/credential path is used for authorized work.
    - Risk covered: secrets leak into every agent prompt and artifact.

## Phase 2: Agent Work State and Restart/Resume

1. UI close does not orphan running work. Covered for worker restart reconciliation.
   - Setup: start a ticket execution, simulate API/worker restart.
   - Assert: active execution is either reconciled as interrupted or reclaimed according to lease state.
   - Risk covered: UI appears idle while an old agent is still mutating a worktree.

2. Ticket close or restart cancels active execution. Covered for ticket restart and execution cancellation.
   - Setup: active adapter process is running; user restarts ticket.
   - Assert: process is terminated, execution is cancelled, worktree status is cancelled, and no late result mutates the ticket.
   - Risk covered: closed work keeps running and lands stale changes.

3. Work state indicator reflects claim state. Covered.
   - Setup: execution exists in `running` with and without active claim token.
   - Assert: board/ticket summary exposes active role, active count, and claimed/unclaimed distinction.
   - Risk covered: UI cannot tell whether an agent is actually doing work.

4. Restart with pending HITL. Covered.
   - Setup: ticket has pending request_input and is restarted.
   - Assert: old request is stale/dismissed or clearly no longer actionable.
   - Risk covered: user answers a stale question after workflow reset.

5. Continuation budget exhausted. Covered.
   - Setup: blocked execution reaches max auto-continue iterations.
   - Assert: answer is recorded, no new execution starts, and UI sees actionable reason.
   - Risk covered: system silently ignores answer or loops forever.

## Phase 3: Merge, Rework, and Evidence

1. Merge conflict rework context is complete. Covered for ticket-context HITL, review, validation, and merge summary.
   - Setup: merge conflict after implementation, review, validation, and HITL clarification.
   - Assert: rework agent context includes conflict summary, source branch, review findings, validation evidence, and HITL decisions.
   - Risk covered: rework resolves conflict while discarding validated behavior.

2. Merge conflict asks previous worker first. Covered.
   - Setup: developer work conflicts at merge.
   - Assert: autonomous mode starts the same previous working role/profile; operator-approved mode creates a dispatch suggestion.
   - Risk covered: wrong agent owns rebase/rework.

3. Missing demo evidence blocks merge. Covered with validator dispatch suggestion.
   - Setup: validation passes without demo artifact while policy requires demo evidence.
   - Assert: merge is blocked with `demo_evidence_required`; validator/demo lane can be dispatched.
   - Risk covered: non-demoable features merge.

4. Demo evidence survives merge rework. Covered.
   - Setup: validator attaches demo evidence, merge conflict triggers rework, merge retries.
   - Assert: merge policy still sees valid demo evidence after rework.
   - Risk covered: rework loses proof and blocks indefinitely.

5. Human approval before merge. Covered.
   - Setup: merge-ready ticket with human approval required.
   - Assert: manual/operator modes block, fully autonomous bypasses only when policy allows.
   - Risk covered: accidental merge in guarded modes.

## Phase 4: Real Codex/Agent Harness Behavior

1. Authenticated Codex required. Covered.
   - Setup: Codex adapter configured but Codex auth missing.
   - Assert: execution fails with clear blocked/auth-needed reason and no fake success.
   - Risk covered: demos appear to run agents but only exercise fixture commands.

2. Codex result contract enforcement. Covered.
   - Setup: adapter exits successfully but omits result JSON.
   - Assert: execution fails and records stdout/stderr/final message artifacts.
   - Risk covered: agents appear done without structured outcome.

3. Agent asks instead of looping. Covered.
   - Setup: adapter output contains question signals and returns blocked.
   - Assert: `questionSignalCount` increments, ticket gets HITL request, and no false completion is recorded.
   - Risk covered: agents ask a question in logs but Floop marks work done.

4. Agent progress proof. Covered.
   - Setup: real or fixture agent emits JSONL/stdout progress.
   - Assert: work log artifact contains progress signals, question signals, and final message pointer.
   - Risk covered: demo looks too fast or unproven.

5. Filesystem/git metadata recovery. Covered.
   - Setup: agent produces work but cannot commit due read-only git metadata.
   - Assert: execution recovers or blocks with actionable evidence; validator evidence can still be recovered.
   - Risk covered: sandbox/git metadata issues derail long demos.

## Phase 5: Demo Recording and Proof Bundles

1. Strict idle cutting. Covered.
   - Setup: recorder creates long background waits between visible transitions.
   - Assert: trim plan cuts periods without obvious ticket transition or screen work, preserving short transition buffers.
   - Risk covered: demo video keeps long idle spans.

2. Trim metadata audit. Covered.
   - Setup: recording completes.
   - Assert: proof bundle records raw duration, trimmed duration, idle definition, keep/cut ranges, and final video path.
   - Risk covered: no way to explain or reproduce cuts.

3. Full-loop demo proof. Covered by recorder proof assertions.
   - Setup: big work demo executes planning, feature breakdown, development, review, validation, demo evidence, merge.
   - Assert: proof includes agent conversations, prompts for Codex mode, work logs, review count, validation count, demo artifacts, and final app smoke.
   - Risk covered: video shows UI but not that agents did real work.

4. Demo fixture retention on failure. Covered.
   - Setup: demo fails in Codex mode.
   - Assert: fixture path is retained and proof/logs point at failed execution artifacts.
   - Risk covered: failures are impossible to debug after cleanup.

5. Browser/demo app smoke. Covered by recorder browser/API smoke.
   - Setup: generated frontend/backend app starts.
   - Assert: recorder can create/read sample data and capture final demo evidence.
   - Risk covered: validation passes but app is not demoable.

## Phase 6: Ceremonies and Agent Collaboration

1. Ceremony HITL stays ceremony-scoped. Covered.
   - Setup: ceremony participant asks a question.
   - Assert: question appears on ceremony/run attention, not as an execution unblock unless tied to a ticket execution.
   - Risk covered: ceremony discussion accidentally restarts ticket work.

2. Ceremony decision propagates to tickets. Covered.
   - Setup: ceremony applies a ticket mutation or planning decision.
   - Assert: later ticket agents see the applied ceremony decision in context.
   - Risk covered: decisions made in ceremonies are invisible during execution.

3. Participant fan-out evidence. Covered.
   - Setup: product manager, developer, reviewer, validator participate.
   - Assert: each participant result is captured; decider synthesis references objections.
   - Risk covered: constellation UI shows activity but no durable agent proof.

4. Operator-approved ceremony application. Covered.
   - Setup: ceremony automation creates proposed run in operator-approved mode.
   - Assert: proposals stay pending until explicit apply action.
   - Risk covered: ceremony automation mutates tickets without approval.

## Phase 7: API/SSE/UI Observability

1. HITL lifecycle emits distinct events. Covered.
   - Setup: request created, question comment attached, answer attached, continuation started.
   - Assert: SSE stream carries enough events for UI to update without reload.
   - Risk covered: UI misses blocked/answered/working changes.

2. Active work indicators update from run observability. Covered.
   - Setup: execution starts, claims, renews, completes, or blocks.
   - Assert: board cards and ticket detail can distinguish active, waiting, blocked, and stale.
   - Risk covered: user cannot tell what is happening.

3. Agent logs are available while active. Covered.
   - Setup: adapter emits progress over time.
   - Assert: run proof/log dock surfaces recent progress and question signals.
   - Risk covered: agent work looks like idle waiting.

4. Error contracts stay specific. Covered.
   - Setup: stale HITL answer, invalid transition, missing validation evidence, human merge approval required.
   - Assert: API returns stable 4xx reason code and message.
   - Risk covered: UI cannot render useful recovery actions.

## Suggested Next Implementation Order

1. Run or record the Codex-backed big-work demo when authenticated agents are available.
2. Consider exact-source assertions for all API error reason codes in contract tests.
