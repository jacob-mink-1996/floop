# Floop MVP 2.0 Plan

## Target

One idea ticket can become working product progress with minimal user choreography, visible proof, and recoverable agent loops.

## Success Signal

A greenfield project starts from a single idea ticket and reaches `READY_TO_MERGE` or `DONE` through refinement, HITL, execution, review, validation, demo evidence, and merge with clear UI state and a proof manifest.

## Workstreams

### 1. Full Autonomous Loop

- Auto-run reviewer after developer completion.
- Auto-run validator after review passes.
- Require demo evidence from validator before merge.
- Auto-start merge when validation and demo evidence pass.
- Let reviewer and validator reprompt the previous agent when work is incomplete.
- Add proof fields and demo footage for the full loop.

Success signal: one idea ticket reaches merge readiness or completion without manual dispatch after the initial idea and any necessary HITL answers.

### 2. HITL And Steering Polish

- Clean ticket conversation UX around questions, answers, comments, steering, and dispatch.
- Distinguish blocked agent questions from user-supplied context.
- Offer context, steer active run, and open or reopen with selected agent based on work state.
- Support agent-generated forms in ticket conversation.
- Preserve HITL answers across child, parent, review, validation, merge, and rework context.

Success signal: every user message has an obvious intent and every agent question has one clear answer path.

### 3. Execution Observability

- Surface live agent logs cleanly in ticket detail and execution views.
- Remove duplicate agent-working surfaces.
- Show active work indicators on ticket cards and lanes.
- Normalize harness JSONL logs into readable milestones.
- Show current phase, current agent, elapsed time, and last meaningful event.
- Add stop and cancel behavior on ticket close and app close.

Success signal: a user can tell what is happening without opening raw logs.

### 4. Demo And Evidence System

- Record demo evidence as part of validator output.
- Store demo artifacts alongside validation evidence.
- Trim idle time automatically using ticket transitions, UI activity, and agent log events.
- Generate short proof clips per ticket and project.
- Add proof manifests for each demo with agents used, tickets changed, checks run, and evidence produced.

Success signal: every completed feature has review evidence, validation evidence, and demo evidence.

### 5. Merge And Rebase Reliability

- Route merge conflicts back to the developer session that produced the code when possible.
- Let integrator or developer perform rebase, fix, and continue.
- Add authenticated integration tests for Codex merge and rebase flows.
- Make merge queue state visible and actionable in the UI.
- Add retry and recovery for interrupted merge runs.

Success signal: merge conflicts become normal agent work instead of manual failure states.

### 6. Lifecycle Ceremonies

- Trigger refinement when backlog is messy or broad.
- Trigger planning when enough refined work is ready.
- Generate new work near sprint or project depletion.
- Prepare demos when validated work exists.
- Run retro when repeated blocked or rework patterns appear.
- Batch refinement and support combine, remove, split, and question recommendations.
- Make ceremony outputs directly actionable.

Success signal: ceremonies happen because project state warrants them, not because a timer fired.

### 7. Agent Context Architecture

- Ensure all agents receive structured project context.
- Add lookup handles for tickets, repos, events, artifacts, prior decisions, and HITL answers.
- Keep parent, child, and dependency context consistent across phases.
- Test context propagation into reviewer, validator, merge, rework, and demo phases.
- Avoid giant ticket summaries by storing full evidence as artifacts and events while keeping visible text compact.

Success signal: agents can find what they need without huge prompts or bloated ticket cards.

### 8. UI/UX MVP Polish

- Simplify ticket detail controls to actionable choices.
- Make conversation intent choices obvious and visually calm.
- Emphasize current decision, pending questions, applied proposals, and next action in ceremonies.
- Show active work, blocked questions, review status, validation status, and demo status on board cards.
- Consolidate execution view and ticket modal concepts.
- Improve constellation active, complete, and blocked states.

Success signal: each surface clearly answers what is happening and what the user can do next.

### 9. External Agent Input And ACP

- Define an agent communication adapter boundary.
- Support external agents creating comments, questions, artifacts, dispatch suggestions, and ceremony input.
- Map ACP or ACP-like messages to Floop agent messages.
- Support session resume, steer, and interrupt across Codex first, then other harnesses.
- Add race tests for rapid comments and steering.

Success signal: Codex, OpenClaw, Hermes, or another agent can participate through the same ticket and ceremony model.

### 10. MVP 2.0 Demo

- Greenfield project.
- Single idea ticket: build a calendar app.
- Refinement creates child tickets.
- Agent asks HITL.
- User answers.
- Child auto-readies and auto-dispatches.
- Developer, reviewer, and validator run.
- Demo evidence is produced.
- Merge or merge rework is shown.
- Final video is idle-trimmed and includes a proof manifest.

Success signal: the demo shows the full Floop loop from idea to evidence-backed completion.

## Recommended Execution Order

1. Full autonomous loop after developer execution.
2. Demo evidence as a validation requirement and artifact.
3. Merge and rebase reliability.
4. Execution observability pass.
5. Conversation, HITL, and steering UX polish.
6. Lifecycle ceremony tuning and work generation.
7. Context architecture hardening.
8. External agent input and ACP adapter.
9. Final MVP 2.0 demo recording.

## Delivery Plan

### Milestone 1: Trustworthy Autonomous Execution

Goal: make one ready ticket move through developer, review, validation, demo evidence, and merge without user choreography unless the agent explicitly needs help.

- Finish autonomous phase chaining for developer, reviewer, validator, demo evidence, and merge.
- Let review and validation agents send the prior working agent back through rework with full context.
- Keep ticket visible state compact: current agent, current phase, last meaningful event, and next available user action.
- Treat agent questions as normal loop output in every mode, including fully autonomous mode.
- Add regression coverage for developer rework, reviewer rework, validator rework, blocked HITL, and answered HITL resume.

Acceptance:

- A ticket can start from `READY` and finish in `DONE` with no manual lane moves.
- If an agent asks a question, the ticket pauses cleanly and resumes from the answer.
- Ticket cards and modal surfaces never require the user to inspect raw logs to know what is happening.

### Milestone 2: Lifecycle-Driven Product Creation

Goal: make a single broad idea become executable product work through ceremonies that trigger from project state instead of time.

- Trigger refinement when the backlog is broad, duplicated, stale, or underspecified.
- Batch refinement across multiple backlog tickets and allow combine, remove, split, clarify, and reorder proposals.
- Trigger planning when enough refined work is available for a sprint-sized execution batch.
- Generate new work near the end of a sprint or when the ready backlog is depleted.
- Run demo preparation when validated work exists.
- Run retro when repeated blockers, rework, or merge failures appear.
- Pass project context by lookup handles wherever possible instead of dumping huge text prompts.

Acceptance:

- One idea ticket can produce a refined backlog with parent-child links, deduplication, and ready child tickets.
- Ceremonies produce actionable proposals the UI can apply, reject, or inspect.
- The system can keep producing next work until the product surface is meaningfully complete.

### Milestone 3: HITL And Steering UX

Goal: make every user comment, question answer, and steering action obvious, useful, and low-friction.

- Replace ambiguous conversation controls with direct actions: answer question, add context, steer active work, reopen with agent, and comment.
- Infer responder and reference context from the ticket and active question whenever possible.
- Prevent duplicate HITL rendering, such as the same agent question appearing as both scope and blocked.
- Queue rapid steering comments so the newest steering does not accidentally cancel or hide prior context before the harness has consumed it.
- Show whether a comment was attached as passive context, sent to an active agent, or used to reopen work.
- Support agent-generated forms in ticket conversation and let a user or another agent submit them.

Acceptance:

- If work is active, the user can choose whether a comment is context or steering.
- If no work is active, the user can choose an agent and reopen or redispatch.
- Review, validation, merge, and rework agents can see important clarification comments from earlier phases.

### Milestone 4: Demo Evidence And Proof

Goal: make demos repeatable proof of product progress, not one-off manual videos.

- Require demo evidence before merge for user-facing or behavior-changing work.
- Store demo artifacts alongside validation artifacts.
- Generate proof manifests with agents used, tickets changed, checks run, artifacts produced, merge output, and idle-cut metadata.
- Improve idle detection so cuts remove waiting unless there is visible UI activity, ticket transition, log milestone, or user interaction.
- Support short snippet recordings for targeted UI and workflow proof.
- Keep generated ticket summaries short and link to artifacts for detailed evidence.

Acceptance:

- A completed feature has review evidence, validation evidence, demo evidence, and a proof manifest.
- Demo videos are short enough to review without long background-agent waits.
- The proof manifest can explain what happened without replaying the full video.

### Milestone 5: Merge, Rebase, And Recovery

Goal: make integration failures recoverable agent work.

- Detect merge conflicts and route them back to the developer session that produced the branch when possible.
- Fall back to an integrator agent when the original developer session cannot resume.
- Preserve user steering and validation findings during rebase or conflict repair.
- Add authenticated integration tests that expect a usable Codex environment and fail clearly when unavailable.
- Surface merge queue state and conflict action in ticket detail and board cards.

Acceptance:

- A merge conflict creates actionable rework instead of ending the loop.
- The original developer or integrator can rebase, fix, rerun checks, and continue to validation or merge.
- Interrupted merge runs can be retried without corrupting ticket state.

### Milestone 6: UI Surface Polish

Goal: make every surface answer what is happening, why it matters, and what the user can do next.

- Consolidate duplicate ticket execution and watch-execution layouts.
- Remove user-facing outcome-recording controls that are only useful for internal state transitions.
- Align ticket detail cockpit, plan, dispatch, and status groups on a consistent grid.
- Improve constellation state: idle, queued, active, blocked, done, failed, and hover heatmap detail.
- Simplify ceremonies around current proposal, pending question, applied changes, and next action.
- Make board cards show active work, blocked HITL, review, validation, demo, and merge state without clutter.

Acceptance:

- Ticket detail has one execution surface, one clear dispatch action, and one obvious conversation area.
- Ceremony screens make batch proposals understandable without dense text.
- The constellation makes agent activity legible at a glance.

### Milestone 7: External Agent Protocol

Goal: let Codex and other agents participate through the same ticket, ceremony, and artifact model.

- Define an adapter boundary for comments, questions, artifacts, dispatch suggestions, session resume, interrupt, and steer.
- Implement Codex first with session reuse where appropriate.
- Map ACP or ACP-like messages into Floop events.
- Add tests for external comments, steering, artifact creation, blocked questions, and rapid-comment races.
- Keep harness-specific details out of core ticket lifecycle state.

Acceptance:

- Codex can be steered, interrupted, and resumed from ticket conversation.
- Another harness can be added without changing core ticket semantics.
- External agent input appears in the same UI as native agent work.

## MVP 2.0 Exit Criteria

- A greenfield calendar-app demo starts from one idea ticket.
- Refinement batches backlog work, deduplicates tickets, asks at least one useful HITL question, and creates ready child tickets.
- Developer, reviewer, validator, demo evidence, and merge run with real Codex-backed execution where required.
- The validator can reject work and send it back to the developer with context.
- Merge conflicts can be routed to rework.
- The UI clearly shows active work, blocked questions, next actions, ceremony proposals, evidence, and merge state.
- A trimmed demo video and proof manifest show the loop from idea to evidence-backed completion.
