# Agent Protocol Spike

## Context

Floop needs an external-agent ingress path for agents such as OpenClaw, Hermes, and similar tools. The implemented path is:

- Agent Inbox HTTP API
- CLI wrapper around that API
- MCP stdio facade for tool-capable coding agents

This spike checks whether A2A or ACP should replace or extend that path now.

## Current Findings

There is no concrete OpenClaw or Hermes protocol surface in this repository. Until one of those agents exposes an A2A Agent Card, ACP manifest, ACP REST endpoint, or equivalent compatibility target, Floop cannot validate a real A2A/ACP integration end to end.

The current A2A specification centers on agent discovery, task operations, task updates, messages, artifacts, Agent Cards, and JSON-RPC / HTTP+JSON / gRPC bindings.

The current ACP documentation describes a REST-based interoperability protocol with synchronous and asynchronous communication, streaming, stateful and stateless operation, agent discovery, and long-running tasks. ACP documentation also states that ACP is now part of A2A under the Linux Foundation.

## Decision

Keep MCP and webhook/CLI as the production integration path for now.

Rationale:

- The implemented MCP facade maps directly onto Floop's stable project, ticket, inbox, run, and artifact APIs.
- The Agent Inbox preserves Floop policy gates and audit events.
- MCP/webhook requires no commitment to a peer-agent task lifecycle before Floop has a concrete agent target.
- A2A and ACP both add discovery and task-lifecycle concepts that are useful later but premature without a target agent contract.

## Future A2A Adapter Shape

Add A2A only when Floop should present itself as a coordinating agent.

Likely first slice:

1. Serve a Floop Agent Card advertising coordination skills.
2. Map A2A send-message/task requests into Agent Inbox messages.
3. Map Floop execution, ceremony, and merge runs into task status updates.
4. Keep all state mutations behind the existing `interactionMode` and merge policy gates.

## Future ACP Adapter Shape

Add ACP only when a target agent exposes ACP compatibility.

Likely first slice:

1. Serve an ACP-compatible agent manifest or discovery endpoint.
2. Accept ACP REST messages and map them into Agent Inbox payloads.
3. Return run status and artifacts through ACP message/artifact structures.
4. Preserve Floop's Agent Inbox status as the source of truth for acceptance, dismissal, conversion, attachment, and autonomous promotion.

## Sources

- A2A Protocol specification: https://a2a-protocol.org/latest/specification/
- ACP documentation: https://agentcommunicationprotocol.dev/introduction/welcome
