# Floop Big Simplification Pass Plan

## Goal

Ship one cohesive pass that makes Floop feel simpler, more autonomous, more observable, and easier to demo with real agents.

The pass should reduce operator burden without hiding important control points. The user should quickly understand what is happening, what needs attention, what can be steered, and what proof exists that agents did real work.

## Product Principles

- Default to forward motion when policy allows it.
- Treat human input as optional guidance, correction, approval, or unblock, not routine ceremony.
- Make current work visible before historical detail.
- Keep tickets compact: state, next action, important context, and proof.
- Put controls where the user is already deciding: ticket comments for guidance, active execution panels for steering, attention queue for exceptions, merge queue for merge/rebase decisions.
- Prefer graphical status, progress, and short summaries over long agent dumps.
- Keep demo proof inspectable: videos, trim plans, agent logs, prompts, work artifacts, review, validation, and merge outcomes.

## UX Thesis

Visual thesis: calm control room, dense but readable, with precise status markers and restrained accent color.

Content plan: cockpit first, ticket inspector second, execution/proof dock third, policy/settings only when needed.

Interaction thesis:

- Active work should feel live through compact progress, recent event chips, and agent state changes.
- Comments should become the main human guidance surface, with explicit modes for context, steer, or start/reopen.
- Long background agent work should be compressed in demos and summarized in the app without losing auditability.

## Scope

This is a broad pass across workflow, UI, tests, and demo proof. It includes:

- ticket comment and HITL UX
- active work state surfacing
- execution watch view cleanup
- agent logging and compact summaries
- steering and session resumption behavior
- merge conflict rebase delegation
- authenticated agent integration tests
- demo recorder fixture and real-Codex modes
- ceremony and backlog refinement coverage
- attention queue and external agent inbox polish

It does not include compatibility with old "pool" branding or legacy interaction models.

## Phase 1: Establish Baseline And Guardrails

### Objectives

- Confirm the current dirty tree and unfinished demo-recorder work.
- Protect already-covered workflow behavior before changing UI or orchestration.
- Define what "done" means for the one-pass effort.

### Work

1. Capture current status:
   - list changed files
   - note uncommitted steering, MCP, recorder, and UI work
   - identify failing or incomplete proof paths

2. Run focused baseline checks:
   - contracts tests
   - execution-driver tests
   - app/API HITL tests
   - MCP server tests
   - UI build/check

3. Define completion gates:
   - unit and integration tests pass
   - fixture demo proof passes
   - authenticated Codex demo either passes or fails with clear auth/setup error
   - idle-trim metadata is generated and validated
   - ticket modal no longer shows duplicate or low-value execution panels
   - comments support context, steer, and start/reopen decisions

### Verification

- `npm test`
- `npm run check:ui`
- focused `node --test` commands for changed tests
- `git diff --check`

## Phase 2: Ticket Comment And HITL UX

### Objectives

Make comments the natural place to guide or unblock work, while preventing accidental redispatch.

### Desired Behavior

When no agent is active:

- Comment defaults to passive context.
- User can choose "Start with agent" or "Reopen with agent" when the ticket state allows it.
- The chosen agent receives the comment as explicit context.
- Plain comments never start work by accident.

When an agent is active:

- Comment defaults to passive context.
- User can choose "Send as context" when they want the next prompt/context bundle to include it.
- User can choose "Steer active run" when the note should affect the current execution.
- If the harness supports interrupt-and-resume, hard steer interrupts and resumes the same native session.
- If live steering is unavailable, the UI labels the delivery honestly as queued, interrupted, resumed, or failed.

When an agent is blocked:

- HITL request appears as a compact question in the ticket timeline.
- Answer action is visually distinct from ordinary comment.
- Answer can continue the blocked lane, decline continuation, or delegate response to another agent.
- Fully autonomous mode still permits questions and HITL answers.

### UI Work

1. Replace ambiguous comment composer actions with a compact mode selector:
   - Context
   - Steer
   - Start/Reopen
   - Answer request, only for pending HITL

2. Show action availability based on state:
   - active execution present
   - blocked execution present
   - ticket can dispatch
   - selected agent/profile available
   - harness steering capability

3. Keep timeline tidy:
   - truncate long agent summaries
   - show "View full output" for raw content
   - show question, answer, delivery status, and resumed execution link as compact rows

4. Preserve context propagation:
   - ordinary comments reach later agents
   - HITL answers reach reviewer, validator, merge, and rework prompts
   - parent planning clarifications reach child feature tickets

### Tests

- ordinary comment while idle does not dispatch
- ordinary comment while active does not steer unless selected
- context comment during active work appears in later prompt
- hard steer interrupts and resumes when supported
- two rapid steer comments cancel or supersede safely without losing the second note
- answer to stale HITL request records context but does not redispatch
- fully autonomous mode still surfaces pending questions
- compact timeline rendering handles giant agent output

## Phase 3: Active Work And Execution Watch Polish

### Objectives

Remove duplicate panels and make active work obvious without forcing the user into a separate watch screen.

### Work

1. Consolidate "Agent working" and "Watch execution" into one execution dock:
   - current role/profile
   - current lane
   - elapsed time
   - recent progress events
   - latest question signal
   - steering/comment action
   - open full logs

2. Remove low-value status rows:
   - avoid standalone "Worktree active"
   - avoid static "Logs: Starting"
   - avoid top-level "Execution outcome", "Why", and "Record outcome" for normal users

3. Replace manual outcome recording with useful controls:
   - Dispatch
   - Steer
   - Stop
   - Reopen/start with selected agent
   - Move to next phase only where manual mode requires it

4. Surface active work across the app:
   - board card indicator
   - ticket modal header indicator
   - attention queue active item
   - ceremony constellation agent color/state
   - execution log row state

### Tests

- active execution indicator appears on board and ticket detail
- indicator clears on completion, block, cancel, and restart
- ticket modal does not render duplicate watch panels
- execution dock shows progress when JSONL/log events arrive
- stale running execution is visually different from claimed active work

## Phase 4: Agent Logging And Compact Output

### Objectives

Prove agents are working without flooding tickets.

### Work

1. Normalize harness log events:
   - progress
   - command start/end
   - file touched
   - question signal
   - final message
   - artifact attached

2. Store logs as artifacts or execution events, not giant ticket comments.

3. Generate concise summaries:
   - one-line execution result
   - short evidence list
   - expandable full transcript

4. Parse Codex JSONL where available:
   - thread/session id
   - tool activity
   - assistant final message
   - question-like messages
   - token/error/auth status when available

### Tests

- Codex JSONL creates progress proof
- missing result JSON fails cleanly with log artifacts
- question signals do not become false success
- ticket timeline remains compact after large output
- full raw output remains available for audit

## Phase 5: Orchestration Simplification

### Objectives

Make greenfield work flow from idea to merged features with fewer clicks.

### Work

1. Add or refine pre-planning behavior:
   - architect/product lane breaks a big request into feature tickets
   - agent can ask clarifying HITL questions first
   - backlog refinement runs after the first ticket set is created

2. Make routine lane transitions automatic by policy:
   - plan to run
   - run to review
   - review to validation
   - validation to demo evidence when required
   - validation/demo evidence to merge

3. Keep policy gates explicit:
   - human approval before merge
   - missing demo evidence
   - failed validation
   - merge conflict
   - auth/environment failure
   - agent blocked for input

4. Make fully autonomous mode honest:
   - it can proceed without routine approval
   - it can still ask questions
   - it can delegate answers to another agent when policy allows
   - it does not fake decisions when information is missing

### Tests

- big work request creates feature breakdown
- backlog refinement runs after initial tickets
- autonomous mode moves routine work forward
- fully autonomous mode still creates HITL request when needed
- policy gates stop or create attention items correctly

## Phase 6: Merge Conflict And Rebase Delegation

### Objectives

When merge conflicts happen, ask the most appropriate agent to fix them and preserve validation context.

### Work

1. Detect conflict with structured data:
   - target branch
   - source branch
   - conflicted files
   - last successful validation
   - related demo evidence

2. Delegate rebase/rework:
   - prefer the same role/profile/session that produced the code
   - include review findings, validation evidence, HITL clarifications, and merge conflict summary
   - allow operator steer before dispatch in guarded modes
   - proceed automatically in fully autonomous mode when policy allows

3. Preserve proof:
   - demo evidence survives rework
   - validation reruns or explicitly accepts preserved evidence
   - merge retry records outcome

### Tests

- conflict starts previous-worker rework in autonomous modes
- guarded mode creates operator-dispatch suggestion
- rework prompt includes HITL, review, validation, and conflict summary
- demo evidence still satisfies merge policy after rework
- failed rebase becomes actionable attention item

## Phase 7: External Agent And ACP/MCP Ingress

### Objectives

Let other agents interact with Floop through stable, policy-gated surfaces.

### Work

1. Finish MCP facade coverage:
   - list projects/tickets
   - create ticket
   - append comment/context
   - steer execution
   - request dispatch
   - attach artifact
   - get run status

2. Keep Agent Inbox as the policy boundary:
   - suggestions can be accepted, dismissed, or auto-promoted based on mode
   - external dispatch requests respect project automation mode
   - external artifacts are attached with provenance

3. Prepare for ACP/A2A later:
   - document capability mapping
   - avoid protocol-specific assumptions in domain model
   - treat MCP as the practical first integration

### Tests

- MCP steer request records comment and resumes supported harness
- MCP dispatch request becomes suggestion or active work based on mode
- MCP artifact attachment is durable and visible in ticket proof
- unknown external agent input fails with stable validation errors

## Phase 8: Ceremonies And Constellation UX

### Objectives

Make ceremonies visibly useful and connect them to ticket workflow.

### Work

1. Improve constellation fidelity:
   - agents change color/state when working, blocked, done, or idle
   - hover state shows role, current proposal, risk, or last contribution
   - heatmap behavior is integrated into agent nodes

2. Add ceremony surfaces for:
   - backlog refinement
   - planning
   - daily triage
   - review/demo prep
   - retro

3. Connect ceremony outcomes to tickets:
   - applied decisions become prompt context
   - ticket mutations are visible
   - ceremony-scoped questions do not accidentally restart ticket execution

### Tests

- all ceremony types render in showcase/demo
- participant activity updates constellation state
- applied ceremony decision appears in later ticket context
- ceremony HITL remains ceremony-scoped unless explicitly attached to a ticket

## Phase 9: Demo Recorder And Proof Bundle

### Objectives

Produce repeatable demos that show real work while cutting idle time aggressively.

### Work

1. Complete the new-feature recorder path:
   - fixture mode
   - authenticated Codex mode
   - optional recording mode
   - proof JSON
   - retained fixture on failure

2. Capture the full loop:
   - project creation/setup
   - big work request
   - feature breakdown
   - backlog refinement
   - ticket dispatch
   - HITL question and scripted response
   - development
   - review
   - validation
   - demo evidence
   - merge
   - ceremonies
   - external agent/MCP interaction
   - steering/session resumption proof

3. Improve idle clipping:
   - idle means no visible ticket transition, screen work, UI state change, or proof-focused interaction
   - keep one-second buffers around cuts
   - record raw and trimmed durations
   - write keep/cut ranges to metadata
   - assert that trimmed output removes meaningful idle time

4. Prove agents are real:
   - show Codex prompt/session id where available
   - include work log artifacts
   - include generated files and tests
   - include review and validation artifacts
   - avoid custom sleep agents for proof

### Tests And Commands

- `npm run demo:new-features:fixture`
- `npm run demo:new-features:fixture:record`
- `npm run demo:new-features:codex`
- `npm run demo:new-features:codex:record`

## Phase 10: Isolated Authenticated Integration Tests

### Objectives

Reduce restarts and demo surprises by testing the real harness boundary in small, isolated cases.

### Work

1. Add authenticated Codex smoke tests that may fail fast when Codex auth is missing:
   - thread/session capture
   - simple file edit
   - structured result JSON
   - question/block result
   - interrupt-and-resume steer

2. Keep tests isolated:
   - temp repo
   - temp DB
   - short prompts
   - strict timeout
   - retained artifacts on failure

3. Separate normal CI from local authenticated checks:
   - default tests stay deterministic
   - authenticated checks are explicit commands
   - failure reason distinguishes auth, timeout, result-contract, and product failure

### Tests

- `npm run test:codex-auth`
- `npm run test:codex-steering`
- `npm run test:demo-recorder`

## Phase 11: Surface Polish Audit

### Objectives

Assess every user-facing surface by usefulness, actionability, visual quality, and placement.

### Surfaces

- cockpit
- ticket board
- ticket detail modal
- ticket comments and HITL
- execution dock/watch view
- attention queue
- ceremonies/constellation
- merge queue
- agent inbox/external agents
- project settings
- execution log
- demo/proof artifacts

### Review Questions

- What can the user act on here?
- What information is repeated elsewhere?
- Is the most important current state above the fold?
- Is any text too long for the decision being made?
- Are controls in the same place as the decision?
- Does the layout align on a clear grid?
- Can the same state be understood from color, icon, progress, or checklist before reading paragraphs?
- Does it still work in manual, operator-approved, autonomous, autopilot, and fully autonomous modes?

### Output

- annotated findings
- prioritized fixes
- screenshots before/after
- UI checks for core surfaces

## Phase 12: Final Verification And Commit

### Required Checks

- `npm test`
- `npm run check:ui`
- `npm run build:web`
- focused API/execution/MCP tests
- fixture demo proof
- fixture demo recording with trim metadata
- authenticated Codex smoke or clear auth failure
- `git diff --check`

### Commit Strategy

Prefer a small number of coherent commits:

1. steering/session/resumption infrastructure
2. comment/HITL and active execution UX
3. orchestration and merge/rework behavior
4. recorder/proof improvements
5. tests and docs

If the working tree is already too intertwined, make one clearly named integration commit after all checks pass.

## Open Decisions

- Should "Steer" default to soft steer or interrupt-and-resume when both are available?
- Should a passive context comment during active work be included in the running execution only through cooperative inbox, or only in later prompts?
- Should fully autonomous mode allow an agent to answer another agent's HITL question without user approval?
- Should demo evidence be a validation lane responsibility, a separate demo lane, or both depending on ticket type?
- Should merge conflict rework reuse the previous execution's native session whenever possible?
- How much raw Codex transcript should be visible in the UI versus artifact-only?

## Immediate Next Step

Finish the new-feature recorder proof path, because it exercises the broadest set of new behavior and will reveal which UX and orchestration issues are still visible in practice.
