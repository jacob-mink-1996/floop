# Floop MVP 2.0 Forward Plan

## Goal

Reach MVP 2.0 with a proof-backed product loop: one broad idea ticket can become planned, refined, executed, reviewed, validated, demoed, and merged with minimal user choreography and clear places for optional steering.

MVP 2.0 is not just "agents can run." It means the user can trust the loop, understand what is happening, intervene when useful, and review evidence without watching long idle waits.

## Definition Of Done

- A greenfield idea ticket can generate a refined backlog, execute real implementation work, pass review, pass validation, produce demo evidence, and enter merge or done state.
- Agents can ask HITL questions in every automation mode, including fully autonomous mode.
- User comments can be passive context, answers to questions, steering for active work, or reopen/start instructions when work is idle.
- Review, validation, merge, rework, and demo phases preserve important context from earlier comments and HITL answers.
- Merge conflicts become recoverable agent work, preferably routed back to the original developer session.
- UI surfaces show active work, blocked questions, review, validation, demo, and merge state without duplicate panels or raw-log dependency.
- Demo output includes idle-trimmed video, proof manifest, agent activity proof, checks run, review evidence, validation evidence, demo evidence, and merge evidence when applicable.
- Focused authenticated integration tests pass in an environment with Codex available, or fail clearly with setup instructions.

## Current Path To MVP 2.0

Last reviewed: 2026-06-17.

The next work should focus on proving and tightening the loop that already exists, not expanding scope. Fixture-backed MVP 2.0 verification passes, so the remaining MVP 2.0 work is mostly authenticated proof, release-grade UX polish, and hardening the recovery paths that make the system trustworthy.

### 1. Run Authenticated Codex Release Proof

Goal: prove MVP 2.0 with real Codex sessions, not only fixture agents.

Actions:

- Run `npm run verify:mvp2:codex` on a machine with Codex installed and authenticated.
- Confirm merge rework can resume the original developer session when possible.
- Confirm integrator fallback still works when the original developer session cannot resume.
- Capture the authenticated big-work demo proof manifest.
- Record failures as release blockers or explicit known limitations.

Exit signal: authenticated Codex gates pass, or the remaining failures are narrow enough to produce a focused fix list.

### 2. Polish The User-Facing Loop

Goal: make the UI explain what is happening and what the user can do next without exposing internal machinery.

Actions:

- Audit ticket detail, board cards, conversation, ceremonies, constellation, execution dock, evidence, and merge queue.
- Remove or hide controls that only exist to mutate internal state, such as generic manual outcome recording.
- Keep ticket-visible agent output compact, with full logs and transcripts stored as artifacts.
- Make active work, blocked questions, review, validation, demo evidence, merge state, and rework state visible at scan level.
- Verify desktop and narrow layouts with screenshot or recording evidence.

Exit signal: a user can operate a ticket from idea through merge without opening raw logs or guessing which panel matters.

### 3. Tighten HITL And Steering

Goal: make all user and agent conversation paths predictable.

Actions:

- Keep one visible representation for each agent question.
- Infer responder and reference wherever possible.
- Preserve important clarifications across developer, reviewer, validator, demo, merge, and rework phases.
- Queue rapid comments safely so one steering comment does not erase another before the harness consumes it.
- Show whether each comment became context, an answer, active steering, or a reopen/start instruction.

Exit signal: HITL, comments, and steering are reliable enough for demos and normal use.

### 4. Harden Lifecycle Product Creation

Goal: make one idea become a product backlog and keep the product moving.

Actions:

- Run batch refinement over multiple backlog tickets.
- Let refinement split, combine, remove, clarify, reorder, and accept work.
- Trigger planning, work generation, demo preparation, and retros from lifecycle state instead of time alone.
- Use project context lookup handles for agents instead of dumping large prompt bodies.
- Add proof that a broad idea becomes executable child tickets and a sensible next-work queue.

Exit signal: a greenfield project can move from idea to executable work without manual ticket grooming.

### 5. Improve Demo Evidence

Goal: make proof videos short, credible, and repeatable.

Actions:

- Cut idle time more aggressively when there is no visible transition, user action, screen work, or meaningful agent milestone.
- Preserve roughly one second around each transition so the video remains understandable.
- Produce snippet demos for focused UX flows and one full-loop release demo.
- Include agent proof, file changes, checks, artifacts, review, validation, demo evidence, merge state, and cut metadata in manifests.

Exit signal: the demo can be reviewed quickly while still proving real agent work.

### 6. Decide MVP 2.0 Release Readiness

Goal: make the release decision explicit.

Actions:

- Run `npm run verify:mvp2`.
- Run `npm run verify:mvp2:codex`.
- Review known limitations and push anything nonessential to MVP 3.0.
- Produce final release notes with proof links, demo artifacts, and unresolved risks.

Exit signal: all required gates pass and the remaining work is clearly post-MVP 2.0.

## Current Strengths To Preserve

- The main execution loop now supports developer, reviewer, validator, demo, and merge concepts.
- Review and validation can create rework loops instead of forcing manual recovery.
- HITL and comment scenarios have a growing unit and integration test base.
- Demo recording, proof manifests, and idle-cut metadata exist.
- Lifecycle ceremonies exist and are moving from timer-based behavior toward state-driven triggers.
- The UI direction is clearer: ticket cockpit, constellation, conversation, execution proof, and ceremony surfaces.

## Highest-Risk Gaps

- The app still needs stronger proof that the full autonomous loop is reliable with real Codex sessions.
- Stop, cancel, and active-work ownership need to be explicit when a ticket detail closes, the UI closes, or a run is interrupted.
- Ticket comment and HITL UX needs final polish around duplicate questions, queued steering, and visible delivery state.
- Board and ticket surfaces have scan-level status, but ticket detail still needs a final pass to remove duplicate execution/watch surfaces.
- Merge conflict recovery must be tested as a normal workflow, not just handled as an error.
- Idle trimming needs to remove waiting more aggressively while preserving visible transitions and proof.
- Lifecycle ceremonies need to generate, combine, remove, split, and reorder work in batches using project context handles.

## Workstreams

### 1. Autonomous Product Loop

Objective: make forward motion the default while preserving HITL and steering.

Work:

- Ensure one broad idea can trigger refinement, planning, execution, review, validation, demo evidence, and merge.
- Keep fully autonomous mode autonomous, but allow agents to pause and ask questions when they lack enough information.
- Make reviewer and validator rework redispatch the correct prior agent with full evidence context.
- Add explicit loop state for active, blocked, rework, validating, demoing, merging, conflict, and done.
- Prove the loop with both fixture agents and authenticated Codex agents.

Acceptance:

- A single idea ticket can produce child tickets and move at least one child through the full loop.
- A blocked question can be answered and the correct agent resumes without losing context.
- Review or validation failure sends work back with actionable evidence.

### 2. Comment, HITL, And Steering UX

Objective: make ticket conversation the main control surface for unblocking and guidance.

Work:

- Replace ambiguous conversation options with direct actions:
  - Add context
  - Answer question
  - Steer active work
  - Start or reopen with agent
- Infer responder and reference from the ticket, pending question, active work, and selected action.
- Prevent duplicate HITL rendering, including the same question showing as both scope and blocked.
- Queue rapid comments and steering actions so the newest steer does not cancel an earlier context handoff before the harness has consumed it.
- Show delivery status for each user contribution: saved as context, sent to active agent, queued for resume, answered question, or reopened work.
- Support agent-generated forms inside ticket conversation.

Acceptance:

- If an agent is active, a user can choose context or steer.
- If no agent is active, a user can comment without dispatching or explicitly reopen with an agent.
- Important clarification comments are visible to reviewer, validator, merge, and rework agents.

### 3. Board And Ticket Surface Polish

Objective: every surface should answer what is happening, why it matters, and what the user can do next.

Work:

- Consolidate duplicate "Agent working" and "Watch execution" views into one execution dock.
- Remove user-facing internal outcome recording controls unless the user is in an explicit manual mode.
- Show compact board-card signals for:
  - active or queued work
  - pending HITL
  - review status
  - validation status
  - demo evidence
  - merge readiness or conflict
- Align ticket detail cockpit, phase plan, dispatch, metadata, and conversation on a consistent grid.
- Improve ceremony screens around current proposal, pending question, applied changes, and next action.
- Make the constellation stateful: idle, queued, active, blocked, done, failed, and hover detail.

Acceptance:

- A user can scan the board and know which tickets need attention.
- Ticket detail has one execution area, one dispatch or steer action, and one conversation area.
- Ceremony surfaces avoid dense text and present batch decisions clearly.

### 4. Lifecycle Ceremonies And Backlog Intelligence

Objective: make ceremonies happen when project state warrants them, not because a timer fired.

Work:

- Trigger refinement when backlog tickets are broad, duplicated, stale, blocked, or underspecified.
- Run refinement in batches and support split, combine, remove, clarify, reorder, and accept proposals.
- Trigger planning when enough refined work exists for an execution batch.
- Trigger work generation near the end of a sprint or when ready backlog is depleted.
- Trigger demo preparation when validated work exists.
- Trigger retro when blockers, rework, validation failures, or merge conflicts repeat.
- Pass project context as lookup handles wherever possible instead of dumping large prompt text.

Acceptance:

- Refinement can reduce backlog noise, not just expand one ticket into many.
- A single idea can become a sensible project plan and executable child ticket set.
- Ceremony outputs are directly actionable in the UI.

### 5. Evidence, Logging, And Demo Proof

Objective: prove agents are doing real work without cluttering tickets.

Work:

- Normalize harness logs into readable milestones:
  - started
  - command run
  - file touched
  - question asked
  - artifact produced
  - review result
  - validation result
  - demo result
  - merge result
- Store full transcripts and raw logs as artifacts, not giant ticket comments.
- Keep ticket visible summaries short and link to full evidence.
- Require demo evidence alongside validation evidence before merge for user-facing work.
- Improve idle trimming so idle means no visible ticket transition, screen work, user action, or meaningful log milestone.
- Generate targeted snippet demos for UI workflows and longer full-loop demos for release proof.

Acceptance:

- Completed work has review evidence, validation evidence, demo evidence, and a proof manifest.
- Demo clips are short enough to review and still show proof of real agent activity.
- The ticket remains tidy after long agent runs.

### 6. Merge, Rebase, And Recovery

Objective: make integration failures recoverable by agents.

Work:

- Detect merge conflicts and route them to the developer session that produced the branch when possible.
- Fall back to an integrator agent when the original session cannot resume.
- Preserve review, validation, HITL, and steering context during conflict repair.
- Add authenticated integration tests that expect Codex to be present and fail clearly if not.
- Surface merge queue state, conflict reason, selected repair agent, and next action in UI.

Acceptance:

- A merge conflict creates actionable rework instead of a dead-end failure.
- The responsible agent can rebase, fix, rerun checks, and continue.
- Interrupted merge runs can be retried without corrupting state.

### 7. External Agent And Protocol Readiness

Objective: keep the system open to Codex, OpenClaw, Hermes, ACP, and ACP-like integrations.

Work:

- Define the adapter boundary for external agents.
- Map external messages into Floop comments, questions, artifacts, dispatch suggestions, and ceremony input.
- Support session resume, interrupt, and steer where the harness allows it.
- Capture capability flags per harness instead of assuming Codex behavior everywhere.
- Add race tests for rapid comments, queued steering, stale sessions, and unsupported live steering.

Acceptance:

- External agents can participate through the same ticket and ceremony model.
- Unsupported features degrade clearly instead of pretending to be live.

## Recommended Execution Order

1. Merge conflict rebase delegation and authenticated tests.
2. Full-loop authenticated Codex proof with HITL included.
3. Demo idle-trim improvements and snippet recording workflow.
4. Lifecycle batch refinement and work generation hardening.
5. Comment, HITL, and steering final polish for any gaps found during proof.
6. External agent adapter hardening and ACP mapping.
7. Release-level UI audit across board, ticket detail, conversation, ceremonies, constellation, and merge queue.
8. Final MVP 2.0 release demo and proof manifest.

## Proof Checklist

- `npm test`
- `npm run check:ui`
- focused execution-driver tests
- focused HITL/comment tests
- focused ceremony automation tests
- focused merge/rebase authenticated integration tests
- fixture full-loop demo
- authenticated Codex full-loop demo
- idle-trimmed video output
- proof manifest with agents, tickets, checks, artifacts, review, validation, demo, and merge state

## Completed Foundation

- Stop, cancel, and active-work ownership are implemented for ticket close and UI close paths.
- Ticket detail now uses one execution dock instead of separate "Agent working" and "Watch execution" panels.
- Conversation/HITL state is cleaner and suppresses duplicated questions.
- Project context now includes lookup handles for recent artifacts, target artifacts, events, pending questions, target messages, and recent comments.
- Big-work proof manifests now assert full-loop gates for idea refinement, HITL answer, review evidence, validation evidence, demo evidence, merge evidence, and idle-cut metadata.

## Immediate Next Slice

Harden merge conflict rework as a normal agent workflow:

- Confirm how merge rework currently selects the repair agent and whether it resumes the original developer execution/session when available.
- Route merge conflicts back to the previous developer session with `resumedFromExecutionId` and harness session metadata when the harness supports resume.
- Fall back to an integrator or fresh developer execution when the original session cannot resume.
- Preserve review, validation, demo, HITL, steering, and merge evidence through the repair run.
- Add store/API tests for autonomous rework routing, operator-approved rework suggestions, original-session resumption, integrator fallback, and interrupted retry.
- Update the merge rework proof so the manifest records responsible execution, repair execution, harness kind, resume lineage, retry result, and final merge state.
- Run focused merge tests and commit the slice.

## Forward-Looking MVP 2.0 Plan

### Phase 1: Merge And Rebase Proof

Goal: a merge conflict is treated as routine product work, not a terminal failure.

Deliverables:

- Original developer session resumption for conflict repair when available.
- Integrator fallback when the original session is unavailable or cannot resume.
- Merge queue state visible enough for a user to understand conflict, repair owner, retry status, and next action.
- Authenticated Codex integration proof that expects local Codex auth and fails clearly when unavailable.

Exit signal:

- A conflict can be created, repaired by an agent, checks rerun, and merge retried without manual database surgery or app restart.

### Phase 2: Authenticated Full-Loop Codex Demo

Goal: prove the real product loop with real Codex agents.

Deliverables:

- Start from one greenfield idea ticket, such as a calendar application with frontend and backend.
- Run backlog refinement before execution and produce a batch of child tickets.
- Include one HITL question and scripted answer to prove ticket comment unblocking.
- Exercise developer, reviewer, validator, demo evidence, merge, and merge rework where possible.
- Capture proof that agents did real work: commands, files changed, artifacts, checks, review, validation, demo, and merge state.

Exit signal:

- The demo reaches evidence-backed completion with an idle-trimmed recording and a proof manifest.

### Phase 3: Demo Editing And Evidence Quality

Goal: make proof videos easy to watch without hiding important work.

Deliverables:

- Treat idle as any time with no visible ticket transition, screen work, user action, or meaningful agent milestone.
- Preserve roughly one second around each visible transition.
- Produce short snippets for specific UX proofs and one longer release proof for the full loop.
- Keep long harness output out of ticket comments and store it as artifacts/logs with compact ticket summaries.

Exit signal:

- A reviewer can watch a short video and understand the agent loop without long waiting periods or giant ticket messages.

### Phase 4: Lifecycle Product Engine

Goal: make Floop advance a product from idea to backlog to shipped surface based on lifecycle state.

Deliverables:

- Batch refinement that can split, combine, remove, clarify, reorder, and accept work.
- New-work generation near sprint end, product milestone completion, or ready-backlog depletion.
- Planning when enough refined work exists for an execution batch.
- Demo preparation when validated work exists.
- Retro when repeated blockers, rework, validation failures, or merge conflicts appear.
- Project context supplied through lookup handles, not prompt dumps.

Exit signal:

- One broad idea can become a sensible product backlog and continue generating next work until the product surface is meaningful.

### Phase 5: HITL, Steering, And External Agent Inputs

Goal: make human and external-agent interaction first-class without making the user babysit the system.

Deliverables:

- Comments can be context, answers, steering, or reopen/start instructions depending on ticket state and user choice.
- Rapid comments are ordered safely so later steering does not erase earlier context.
- Agents can ask questions in all modes, including fully autonomous mode.
- ACP/OpenClaw/Hermes-style messages map into Floop comments, questions, artifacts, dispatch suggestions, and ceremony inputs.
- Harness capability flags control resume, interrupt, steer, artifact, and question behavior.

Exit signal:

- External agents and users can interact through the same ticket model, and unsupported live features degrade into queued context or reopen instructions.

### Phase 6: Release UI/UX Audit

Goal: every MVP 2.0 surface is calm, useful, and action-oriented.

Deliverables:

- Board cards show active work, HITL, review, validation, demo, and merge status at scan level.
- Ticket detail has one cockpit, one execution dock, one conversation area, and one obvious next action.
- Ceremony screens show current proposal, pending question, applied changes, and next action without dense prose.
- Constellation communicates idle, queued, active, blocked, done, failed, and hover detail states.
- Merge queue explains conflict, repair owner, retry, and final state.

Exit signal:

- A user can understand current state and available actions without reading raw logs or agent transcripts.

### Phase 7: MVP 2.0 Release Gate

Goal: ship only when the loop is proof-backed and repeatable.

Required proof:

- Unit and integration tests for execution, HITL/comment, ceremony automation, context handles, merge rework, and UI smoke.
- Fixture full-loop demo for fast regression.
- Authenticated Codex full-loop demo for real-agent proof.
- Idle-trimmed video with proof manifest.
- Final issue list showing known limitations, risks, and MVP 3 candidates.

Release commands:

- `npm run verify:mvp2` runs the fixture-backed MVP 2.0 release gate.
- `npm run verify:mvp2:codex` runs the fixture gate plus authenticated Codex merge rework and full-loop big-work proof. This command must pass before MVP 2.0 is declared complete on a machine with Codex installed and logged in.

## MVP 2.0 Slice Backlog

### P0: Execution Ownership And Cancellation

Why: users need to trust that closing or interrupting a surface does not leave hidden agent work running.

Deliverables:

- Active execution detection in ticket detail and board scan models.
- One consistent "agent working" view shared by ticket detail and watch execution.
- Stop-on-ticket-close behavior with recorded reason and refreshed ticket state.
- Best-effort UI-close cancellation through lifecycle events.
- Tests for active work cleanup, canceled execution history, and stale indicator removal.

Proof:

- Focused API/store tests.
- React UI check showing a dispatched ticket, active indicator, close action, and cleared state.

### P0: Full Loop Demo Reliability

Why: MVP 2.0 needs a repeatable proof that the product loop works with real Codex agents, not fixture agents alone.

Deliverables:

- Greenfield calendar-app script starts from one idea ticket.
- Refinement runs before execution and creates a batch of child work.
- Script includes one HITL question and answer path.
- Developer, reviewer, validator, demo evidence, and merge or merge rework are exercised.
- Proof manifest records tickets, agents, checks, artifacts, review, validation, demo evidence, merge state, and cut metadata.

Proof:

- Fixture full-loop run for speed.
- Authenticated Codex full-loop run in an environment with Codex already logged in.

### P1: Ticket Conversation And HITL Polish

Why: the conversation surface is the user's steering and unblock path, so it must avoid ambiguous modes and duplicate questions.

Deliverables:

- Remove duplicate display of a single HITL request across scope and blocked sections.
- Keep conversation actions to user-meaningful choices: answer, add context, steer active run, start or reopen.
- Infer responder and reference from ticket state instead of asking users to supply them.
- Queue rapid steering/comment actions and preserve delivery order.
- Show delivery state for each comment without raw protocol terms.

Proof:

- Unit tests for duplicate HITL suppression.
- Integration tests for active comment, idle comment, answer, steer, reopen, and rapid double-comment races.

### P1: Lifecycle Ceremonies As Product Engine

Why: Floop should create product progress from state, not from timer-like ceremonies.

Deliverables:

- Refinement runs in batches and can split, combine, remove, clarify, reorder, and accept tickets.
- New-work generation runs near sprint end or backlog depletion.
- Planning starts when enough refined work exists for an execution batch.
- Demo prep starts when validated work exists.
- Retro starts when repeated blockers, rework, validation failures, or merge conflicts appear.
- Agents receive project context through lookup handles wherever possible.

Proof:

- Ceremony tests for batch refinement, dedupe/removal, work generation, and context lookup handles.
- UI snippet showing a broad idea becoming a refined, executable batch.

### P1: Merge Rework As Normal Flow

Why: merge conflicts have been a repeated demo and reliability failure point.

Deliverables:

- Merge queue state is visible on board cards and ticket detail.
- Conflicts route to the original developer session when available.
- Integrator fallback handles unavailable original sessions.
- Rework preserves HITL answers, validation findings, and review evidence.
- Interrupted merge runs can retry safely.

Proof:

- Authenticated Codex merge-conflict integration test.
- Fixture fallback test for unavailable developer session.

### P2: External Agent Protocol Readiness

Why: ACP, OpenClaw, Hermes, and other agents should use Floop's lifecycle without changing core ticket semantics.

Deliverables:

- Adapter capability flags for comment, question, artifact, dispatch suggestion, resume, interrupt, and steer.
- ACP-like message mapping into native Floop events.
- Unsupported harness capabilities degrade into queued context or reopen instructions.
- External agent artifacts appear in the same evidence model as native agents.

Proof:

- API tests for external comments, questions, artifacts, dispatch suggestions, and unsupported steering fallback.

### P2: Release-Level UI Polish

Why: MVP 2.0 should feel calm, legible, and action-oriented across the main surfaces.

Deliverables:

- Ticket cockpit, plan, dispatch, metadata, execution, evidence, and conversation align to a consistent grid.
- Constellation clearly shows idle, queued, active, blocked, done, failed, and hover detail states.
- Ceremony screens focus on current proposal, pending question, applied changes, and next action.
- Ticket cards stay compact while showing active work, HITL, review, validation, demo, and merge state.

Proof:

- UI screenshot audit across desktop and narrow widths.
- Snippet recordings for ticket detail, conversation/HITL, ceremony refinement, constellation, and merge queue.
