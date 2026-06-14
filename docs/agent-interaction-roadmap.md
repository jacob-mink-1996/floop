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
- `fully_autonomous`: Floop runs eligible work and applies eligible proposals without routine approval.

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
- One-click attachment closure for messages that target an existing ticket.
- Project-level `interactionMode` policy field.
- Settings UI for the interaction mode ladder.
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

Remaining:

- Convert accepted inbox messages into ticket comments, ceremony inputs, artifacts, or dispatch requests.
- Gate routine auto-dispatch behavior through `interactionMode`.
- Add an MCP facade over the stable Agent Inbox and project/ticket APIs.
- Spike A2A or ACP once OpenClaw/Hermes protocol support is concrete.

## Open Questions

- Which protocol, if any, do OpenClaw and Hermes already support?
- Should external agents be allowed to create tickets directly, or should all new work enter as inbox suggestions first?
- What authentication model should protect local-only use versus remote agent use?
- Should agent messages be immutable events only, or should they have first-class inbox state?
- Which transitions are safe for autonomous execution in a greenfield project?
