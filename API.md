# API

## API Goals

Floop's API should support three modes cleanly:

- operator-driven UI actions
- background orchestration
- real-time state observation

The API is not a public LLM-facing prompt surface. It is a control-plane API.

## API Shape

Suggested style:

- JSON over HTTP for commands and queries
- WebSocket or SSE for live events

Suggested base prefix:

- `/api/v1`

## Top-Level Resource Areas

- projects
- repos
- tickets
- dependencies
- executions
- reviews
- validations
- worktrees
- artifacts
- events
- agent profiles
- policies
- merges
- ceremonies

## Project Endpoints

### `GET /api/v1/projects`

List projects.

### `POST /api/v1/projects`

Create a project.

Expected fields:

- `name`
- `slug`
- `workspaceRoot`
- `description`

### `GET /api/v1/projects/:projectId`

Return project summary.

### `GET /api/v1/projects/:projectId/board`

Return the board read model for a project.

The first MVP pass groups tickets into UI board columns and includes
lightweight ticket cards with:

- key and title
- current state
- assigned role
- repo count
- dependency count
- event count
- latest summary

### `GET /api/v1/projects/:projectId/ceremonies`

List recent agent ceremony runs and their proposals.

### `POST /api/v1/projects/:projectId/ceremonies`

Create a ceremony run. Floop currently supports:

- `refinement`
- `planning`
- `daily_triage`
- `review_demo_prep`
- `work_generation`
- `retro`

Expected fields:

- `type`
- `scope`
- `participantRoles[]`
- `deciderRole`
- `consensusPolicy`

Ceremony runs produce reviewable proposals. They do not mutate tickets until an
operator applies proposals. When participant roles are configured, Floop also
creates ceremony participant records; the participant driver runs those role
profiles in parallel and appends an agent-consensus note proposal after every
participant completes.

Automated ceremony runs set `scope.trigger` to `lifecycle` and include
`scope.lifecycleReason` with a reason code, summary, and evidence counts for why
the ceremony ran.

### `GET /api/v1/projects/:projectId/ceremonies/:runId`

Return a ceremony run with proposals.

### `POST /api/v1/projects/:projectId/ceremonies/:runId/apply`

Apply selected pending proposals through the normal ticket mutation paths.

Expected fields:

- `proposalIds[]`

If `proposalIds` is omitted or empty, Floop applies all pending proposals in the
run.

### `PATCH /api/v1/projects/:projectId`

Update project metadata.

### `DELETE /api/v1/projects/:projectId`

Delete a project and all Floop-managed child records for it, including repos,
tickets, dependencies, executions, worktrees, reviews, validations, artifacts,
merge runs, events, policies, and role profiles.

### `GET /api/v1/projects/:projectId/policy`

Return project delivery policy.

### `PATCH /api/v1/projects/:projectId/policy`

Update project delivery policy.

Expected fields:

- `requireReviewer`
- `requireValidator`
- `requireHumanApprovalBeforeMerge`
- `maxParallelExecutions`
- `maxParallelMerges`
- `maxAutoContinueIterations`
- `refinementMode`
- `agentCreatedTicketDefaultState`
- `ceremonyAutomation`

`ceremonyAutomation` stores operator-configured trigger policy. It supports:

- `enabled`: master switch
- `mode`: `operator_approved` or `fully_automatic`
- `triggers`: ceremony keyed trigger config

Default trigger intent:

- `refinement`: draft/proposed tickets or backlog changes
- `planning`: ready queue changes or execution capacity opens
- `daily_triage`: blocked, rework, or stale active work
- `review_demo_prep`: done or merge-ready work appears
- `work_generation`: low ready backlog after shipped work
- `retro`: repeated blocked/rework patterns or cycle completion
- `agentCreatedTicketDefaultState`

## Repo Endpoints

### `GET /api/v1/projects/:projectId/repos`

List repos in a project.

### `POST /api/v1/projects/:projectId/repos`

Register a repo.

Expected fields:

- `name`
- `slug`
- `localPath`
- `remoteUrl`
- `defaultBranch`
- `isPrimary`

### `PATCH /api/v1/projects/:projectId/repos/:repoId`

Update repo metadata or validation settings.

## Ticket Endpoints

### `GET /api/v1/projects/:projectId/tickets`

List tickets with filters.

Useful query params:

- `state`
- `priority`
- `assignedRole`
- `search`
- `parentTicketId`

The current MVP implements:

- `state`
- `priority`
- `assignedRole`
- `search`

### `POST /api/v1/projects/:projectId/tickets`

Create a ticket.

Expected fields:

- `title`
- `brief`
- `acceptanceCriteriaMd`
- `definitionOfDoneMd`
- `priority`
- `state`
- `assignedRole`
- `repoTargets[]`

### `GET /api/v1/projects/:projectId/tickets/:ticketId`

Return full ticket detail.

Should include:

- core ticket data
- repo targets
- dependencies
- latest executions
- latest reviews
- latest validations
- artifacts
- event timeline

### `PATCH /api/v1/projects/:projectId/tickets/:ticketId`

Update ticket metadata and planning fields.

### `POST /api/v1/projects/:projectId/tickets/:ticketId/transition`

Explicit state transition endpoint.

Expected fields:

- `targetState`
- `reason`

This is useful for human/operator actions and policy-driven transitions.
Current MVP behavior accepts any canonical ticket state. The next control-plane
hardening pass should route this endpoint through transition policy so normal
workflow moves are validated and operator overrides carry explicit reason codes.

### `POST /api/v1/projects/:projectId/tickets/:ticketId/restart`

Dangerous operator action that restarts a ticket from a clean slate.

Effects:

- cancels active executions for the ticket
- marks recorded ticket worktrees as cleaned
- deletes recorded worktree directories under `.floop/worktrees`
- moves the ticket back to `READY`

Expected fields:

- `reason`

## Dependency Endpoints

### `POST /api/v1/projects/:projectId/tickets/:ticketId/dependencies`

Add a dependency.

Expected fields:

- `blockingTicketId`
- `dependencyType`

### `DELETE /api/v1/projects/:projectId/tickets/:ticketId/dependencies/:dependencyId`

Remove a dependency.

## Execution Endpoints

### `POST /api/v1/projects/:projectId/tickets/:ticketId/executions`

Create and enqueue a new execution.

Expected fields:

- `role`
- `agentProfileId`
- `iteration`
- `reason`

If `agentProfileId` is omitted, the current MVP automatically binds the
execution to the project's configured profile for the selected `role`.

### `GET /api/v1/projects/:projectId/tickets/:ticketId/executions`

List executions for a ticket.

### `GET /api/v1/projects/:projectId/executions/:executionId`

Get execution detail, including artifacts and live state.

### `POST /api/v1/projects/:projectId/executions/:executionId/complete`

Record a lane result. Adapter drivers write this same shape to their
execution result file.

Expected fields:

- `outcome`
- `summaryMd`
- `remainingWorkMd`
- `expectedNextEvidenceMd`
- `artifacts[]`
- `review`
- `validation`
- `followupTickets[]`

Artifact payloads use `{ kind, label, uri, metadata? }`. Floop validates `uri`
as a URI and persists it as evidence. Floop-created driver files live under
`.floop/artifacts/` and are marked as managed in `metadata.floopDurability`.
External file and remote URIs are references; Floop does not copy or clean them.

`followupTickets[]` uses the normal ticket creation fields, excluding
`parentTicketId`. Floop persists these as child tickets of the completed
execution's ticket. Child ticket readiness is governed by `refinementMode`:
`autonomous` may honor `agentCreatedTicketDefaultState` or an agent-requested
state, while `user_approved`, `user_participant`, and `user_only` keep
agent-created follow-ups in refinement (`PROPOSED`, or `DRAFT` when explicitly
requested) until a user transitions them. This is the bounded mechanism for a
goal or refinement lane to extend itself into runnable tickets.

### `POST /api/v1/projects/:projectId/executions/:executionId/continue`

Trigger a bounded continuation for a run or generate the next iteration.

Expected fields:

- `reason`

### `POST /api/v1/projects/:projectId/executions/:executionId/cancel`

Cancel an active run.

## Review Endpoints

### `POST /api/v1/projects/:projectId/tickets/:ticketId/reviews`

Create a review lane execution or review request.

### `GET /api/v1/projects/:projectId/tickets/:ticketId/reviews`

List reviews and findings.

## Validation Endpoints

### `POST /api/v1/projects/:projectId/tickets/:ticketId/validations`

Create a validation run.

Expected fields:

- `repoIds[]`
- `commandProfile`

### `GET /api/v1/projects/:projectId/tickets/:ticketId/validations`

List validation runs.

## Merge Endpoints

### `POST /api/v1/projects/:projectId/tickets/:ticketId/merge`

Attempt merge for a merge-ready ticket.

Expected fields:

- `strategy`
- `approvedByKind`
- `approvedByRef`

### `GET /api/v1/projects/:projectId/tickets/:ticketId/merge`

Return merge status for the ticket.

## Agent Profile Endpoints

### `GET /api/v1/projects/:projectId/agent-profiles`

List role profiles for a project.

### `PATCH /api/v1/projects/:projectId/agent-profiles/:role`

Update the adapter, model, or config for a role profile.

Expected fields:

- `adapter`
- `model`
- `config`

List agent profiles.

### `POST /api/v1/projects/:projectId/agent-profiles`

Create a profile.

### `PATCH /api/v1/projects/:projectId/agent-profiles/:profileId`

Update profile config.

## Policy Endpoints

### `GET /api/v1/projects/:projectId/policy`

Get current project policy.

### `PATCH /api/v1/projects/:projectId/policy`

Update project policy.

## Worktree Endpoints

### `GET /api/v1/projects/:projectId/worktrees`

List worktrees.

Useful filters:

- `repoId`
- `ticketId`
- `status`

### `POST /api/v1/projects/:projectId/worktrees/:worktreeId/clean`

Request cleanup of a stale or finished worktree.

## Event Stream

### `GET /api/v1/projects/:projectId/events`

Paginated historical event list.

### `GET /api/v1/projects/:projectId/stream`

Live stream endpoint via WebSocket or SSE.

Suggested event types:

- `ticket.created`
- `ticket.updated`
- `ticket.transitioned`
- `dependency.added`
- `execution.started`
- `execution.updated`
- `execution.completed`
- `review.completed`
- `validation.completed`
- `worktree.created`
- `worktree.cleaned`
- `merge.started`
- `merge.completed`

## View Models For The UI

The UI will want a few aggregated endpoints.

### `GET /api/v1/projects/:projectId/board`

Returns board-optimized data:

- columns or states
- ticket cards
- counts
- blocked summaries

### `GET /api/v1/projects/:projectId/dashboard`

Returns project health:

- active tickets
- blocked tickets
- queued merges
- validation failures
- agent utilization

## V1 Recommendation

Implement in this order:

1. projects
2. repos
3. tickets
4. dependencies
5. board view
6. executions
7. reviews
8. validations
9. worktrees
10. event stream

Merge endpoints can follow once the execution/review loop is operating.
