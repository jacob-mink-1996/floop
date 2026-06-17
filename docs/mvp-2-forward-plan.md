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

## Current Strengths To Preserve

- The main execution loop now supports developer, reviewer, validator, demo, and merge concepts.
- Review and validation can create rework loops instead of forcing manual recovery.
- HITL and comment scenarios have a growing unit and integration test base.
- Demo recording, proof manifests, and idle-cut metadata exist.
- Lifecycle ceremonies exist and are moving from timer-based behavior toward state-driven triggers.
- The UI direction is clearer: ticket cockpit, constellation, conversation, execution proof, and ceremony surfaces.

## Highest-Risk Gaps

- The app still needs stronger proof that the full autonomous loop is reliable with real Codex sessions.
- Ticket comment and HITL UX must be obvious enough that users know whether they are answering, steering, adding context, or reopening work.
- Board and ticket surfaces need compact scan-level status for active work, pending questions, review, validation, demo evidence, and merge readiness.
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

1. Board and ticket scan-level status polish.
2. Comment, HITL, and steering UX cleanup.
3. Lifecycle batch refinement and work generation hardening.
4. Full-loop authenticated Codex proof with HITL included.
5. Merge conflict rebase delegation and authenticated tests.
6. Demo idle-trim improvements and snippet recording workflow.
7. External agent adapter spike and ACP mapping.
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

## Immediate Next Slice

Implement board and ticket scan-level status polish:

- Extend board ticket read models and DTOs with pending HITL, demo evidence, and merge readiness.
- Update React board cards to show compact status signals without clutter.
- Update ticket detail execution surfaces to avoid duplicate active-work views.
- Add tests proving the new board fields and active-work indicators.
- Run focused tests and commit the slice.
