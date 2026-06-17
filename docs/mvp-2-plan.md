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
