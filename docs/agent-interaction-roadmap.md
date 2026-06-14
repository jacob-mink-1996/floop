# Agent Interaction Roadmap

## Goal

Make Floop require less operator participation by default while giving humans and external agents clearer optional ways to guide the system.

This roadmap has two parallel workstreams:

1. Simplify the interaction model so Floop can keep moving without asking the user to participate in every step.
2. Add an external agent ingress path so agents such as OpenClaw, Hermes, or other tools can interact with Floop manually or semi-automatically.

## Workstream 1: Simpler Interaction Model

### Product Direction

Floop should default to "do the obvious next thing" when policy allows it. Human participation should be an optional opportunity to guide, correct, approve, or inspect.

The operator should mainly see:

- work currently moving
- work waiting on a policy gate
- blocked work
- failed validation
- risky merges
- external-agent suggestions that need a decision

Routine steps should not require repeated manual dispatch.

### Automation Ladder

Add a per-project automation mode with explicit behavior:

- `manual`: user dispatches each step.
- `operator_approved`: Floop proposes next steps and asks before acting.
- `autonomous_with_review`: Floop runs routine execution/review/validation, but stops for risky transitions.
- `autopilot`: Floop keeps routine work moving and applies low-risk inputs while surfacing exceptions.
- `fully_autonomous`: Floop turns external suggestions into work, dispatches requested lanes, and bypasses human approval gates.

This should build on the existing ceremony automation policy rather than becoming a separate policy system.

### Next Actions

1. Audit every user-required action in the ticket loop.
2. Classify each action as routine, policy-gated, risk-gated, or human-only.
3. Add a project policy field for interaction/automation mode.
4. Teach the drivers to auto-dispatch routine next steps when policy allows.
5. Update the UI so manual dispatch remains available but is not the primary path when automation is enabled.
6. Add an Ops/Attention view that focuses on exceptions instead of all activity.

## Workstream 2: External Agent Ingress

### Product Direction

External agents should be able to interact with Floop without needing to own Floop internals. Floop should accept structured messages, map them into its existing domain model, and keep operator control over risky changes.

The first integration point should be a small "Agent Inbox" rather than a full commitment to one protocol.

### Agent Inbox MVP

Add:

```text
POST /api/v1/projects/:projectId/agent-messages
```

Initial payload:

```json
{
  "actor": "openclaw",
  "source": "webhook",
  "intent": "suggest_ticket",
  "target": {
    "ticketId": "",
    "repoId": ""
  },
  "summary": "Add fixture coverage for ceremony fan-out",
  "body": "The ceremony participant path should be covered with a real adapter fixture.",
  "metadata": {}
}
```

Initial intents:

- `suggest_ticket`
- `comment_on_ticket`
- `suggest_dispatch`
- `submit_ceremony_input`
- `raise_risk`
- `submit_artifact`
- `request_status`

Initial persistence:

- record every message as a project event
- expose messages in a project-scoped inbox
- allow promotion to ticket, ticket comment, ceremony proposal, or artifact later

### UI Surface

Add an "External Agents" area in Ops/Attention:

- group messages by intent and risk
- show the source agent and target
- provide one-click actions: accept, convert to ticket, attach to ticket, dismiss
- keep raw metadata available but collapsed

## Protocol Options

### Webhook and CLI

Best first step.

Pros:

- low implementation cost
- easy for external agents to call
- maps cleanly to the Agent Inbox
- does not require us to pick a protocol too early

Cons:

- no standardized discovery or capability model
- weaker long-running task semantics unless we design them

### MCP

Good if Floop should be exposed as tools/resources to coding agents.

Useful capabilities:

- list projects
- list tickets
- create ticket
- append agent message
- request dispatch
- inspect run status
- read artifacts

Pros:

- strong fit for tool access
- widely understood in agent tooling
- can be layered over existing HTTP API

Cons:

- MCP is more "agent uses Floop as a tool" than "agents coordinate with each other"
- we still need internal policy/risk gates

### A2A

Good if Floop should present itself as a coordinating agent with capabilities.

Useful capabilities:

- publish an agent card for Floop
- expose task delegation and status
- let other agents ask Floop to coordinate work

Pros:

- better conceptual match for agent-to-agent delegation
- supports capability discovery

Cons:

- higher implementation cost than webhook/CLI
- likely premature before the Agent Inbox domain model is stable

### ACP

Worth a spike only after we know which ACP flavor OpenClaw/Hermes support.

Pros:

- may provide a direct path if target agents already speak it
- could support richer agent communication semantics than simple webhooks

Cons:

- "ACP" is ambiguous across current agent ecosystems
- implementation details vary
- not the safest first dependency without a concrete target implementation

## Recommended Sequence

1. Build the Agent Inbox HTTP API and event persistence.
2. Add the Ops/Attention inbox UI.
3. Add project-level interaction mode and auto-dispatch policy.
4. Convert routine ticket-loop actions to auto-dispatch when policy allows.
5. Add a CLI wrapper for external agents.
6. Add an MCP server facade if agent tooling wants tool/resource access.
7. Spike A2A or ACP against a concrete OpenClaw/Hermes integration.

## Implementation Status

Implemented:

- Agent Inbox storage table and migration.
- `POST /api/v1/projects/:projectId/agent-messages`.
- `GET /api/v1/projects/:projectId/agent-messages`.
- `PATCH /api/v1/projects/:projectId/agent-messages/:messageId`.
- Project events for received and decided external-agent messages.
- Ops/Attention "External Agents" inbox with accept/dismiss actions and collapsed metadata.
- One-click conversion from `suggest_ticket` and `raise_risk` messages into proposed tickets.
- One-click dispatch for `suggest_dispatch` messages that target an existing ticket.
- One-click attachment closure for `comment_on_ticket` messages that target an existing ticket.
- Ticket-targeted attached messages appear in the ticket timeline.
- Accepted or attached `submit_artifact` messages become durable ticket artifacts.
- Accepted or attached `submit_ceremony_input` messages become pending ceremony note proposals.
- Project-level `interactionMode` policy field.
- Settings UI for the interaction mode ladder.
- Routine evidence-lane dispatch is gated by `interactionMode`:
  - `manual`: no automatic next-lane dispatch
  - `operator_approved`: creates a pending `suggest_dispatch` inbox message
  - `autonomous_with_review` / `autopilot` / `fully_autonomous`: starts eligible next-lane executions
- `autopilot` auto-promotes low-risk inbox messages:
  - `comment_on_ticket` with a target ticket is attached to the ticket timeline
  - `submit_artifact` with a target ticket and valid artifact metadata becomes a durable artifact
  - `submit_ceremony_input` with a target ceremony run becomes a pending ceremony note proposal
  - `suggest_ticket`, `raise_risk`, and external `suggest_dispatch` remain operator-visible
- `fully_autonomous` acts on broad inbox messages without operator review:
  - `suggest_ticket` and `raise_risk` become ready tickets and start developer work when execution capacity allows
  - `suggest_dispatch` starts the requested role execution
  - low-risk inbox messages use the same promotion path as `autopilot`
  - human merge approval gates are bypassed while technical merge blockers still apply
- CLI wrapper:

```bash
npm run agent:message -- \
  --project project_floop \
  --actor openclaw \
  --intent suggest_ticket \
  --summary "Add fixture coverage for ceremony fan-out" \
  --body "The ceremony participant path should be covered with a real adapter fixture." \
  --target '{"repoId":"repo_project_floop_floop"}'
```
- MCP stdio facade:

```bash
npm run mcp:server
```

Available MCP tools:

- `floop_list_projects`
- `floop_list_tickets`
- `floop_append_agent_message`
- `floop_request_dispatch`
- `floop_get_run_status`
- `floop_list_artifacts`

## Current Execution Plan

### Slice 1: Finish Inbox Promotion

Goal: external-agent messages should become useful domain objects with one operator action.

Steps:

1. Promote `comment_on_ticket` messages into ticket timeline events when accepted or attached.
2. Promote `submit_artifact` messages into ticket artifacts when accepted or attached.
3. Add a dispatch action for `suggest_dispatch` messages so operator-approved mode is genuinely two clicks: do it and record why.
4. Add test coverage for ticket timeline promotion, artifact promotion, and dispatch request handling.
5. Update the Ops/Attention inbox copy and button ordering so pending messages show the next obvious action first.

### Slice 2: Make Interaction Modes Real

Goal: reduce required user participation without removing policy control.

Steps:

1. Audit the ticket loop for every user-required action.
2. Mark each action as routine, policy-gated, risk-gated, or human-only.
3. Apply `interactionMode` consistently:
   - `manual`: never start routine follow-up work automatically.
   - `operator_approved`: create pending `suggest_dispatch` messages for routine follow-up work.
   - `autonomous_with_review`: start routine execution, review, and validation, but stop at risky transitions.
   - `autopilot`: start eligible routine work and apply eligible low-risk inputs.
   - `fully_autonomous`: convert external suggestions into work, dispatch external lane requests, and bypass human approval gates.
4. Add explicit tests for each mode at the driver/store boundary.
5. Keep manual dispatch visible as an override, not the primary path.

### Interaction Classification

Routine:

- start reviewer execution after implementation completes
- start validator execution after review completes
- attach external comments to an existing ticket
- attach externally submitted artifacts to an existing ticket
- attach external ceremony input to an existing ceremony as a note proposal

Policy-gated:

- merge when human approval is required
- merge when a required validation profile has not passed
- ceremony proposal application when ceremony automation is operator-approved
- external dispatch suggestions outside the internal routine-lane path

Risk-gated:

- external `raise_risk` messages
- new work suggested by external agents
- blocked execution, failed validation, rework review, and dirty merge targets

Human-only:

- deleting projects
- restarting tickets
- changing project policy and role profiles
- approving ambiguous or destructive external-agent requests

### Slice 3: External Agent Tooling

Goal: give OpenClaw, Hermes, and similar agents a stable manual integration path without coupling them to Floop internals.

Steps:

1. Keep the webhook and CLI as the lowest-friction ingress path.
2. Add and document the MCP stdio facade for agents that can use tools:
   - list projects
   - list tickets
   - append agent messages
   - request dispatch
   - inspect run status
   - list artifacts
3. Treat MCP as the default near-term integration format because it maps cleanly to Floop's existing API.
4. Spike A2A only if we want Floop to advertise itself as a coordinating agent with task delegation semantics.
5. Spike ACP only after OpenClaw or Hermes has a concrete ACP implementation we can target.

### Slice 4: Operator Experience Cleanup

Goal: make autonomy calmer and easier to supervise.

Steps:

1. Reframe Ops/Attention around exceptions: waiting approvals, risks, failed validations, blocked tickets, and external-agent suggestions.
2. Keep raw agent metadata collapsed by default.
3. Show current activity up front with compact status, progress, and lane indicators.
4. Prefer graphical progress and checklists over explanatory text where the state is obvious.
5. Verify the web UI with browser checks after each meaningful surface change.

Remaining:

- No current implementation blocker. A2A/ACP remains deferred until OpenClaw, Hermes, or another target agent exposes a concrete protocol surface Floop can validate against.

Deferred protocol note:

- See [Agent Protocol Spike](./agent-protocol-spike.md).

## Open Questions

- Which protocol, if any, do OpenClaw and Hermes already support?
- Should external agents be allowed to create tickets directly, or should all new work enter as inbox suggestions first?
- What authentication model should protect local-only use versus remote agent use?
- Should agent messages be immutable events only, or should they have first-class inbox state?
- Which transitions are safe for autonomous execution in a greenfield project?
