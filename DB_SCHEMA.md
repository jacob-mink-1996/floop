# Database Schema

## Goals

The Floop database needs to support:

- durable project and ticket state
- multi-repo targeting from the start
- append-only execution and event history
- review and validation evidence
- resumable orchestration

The current MVP uses SQLite through `packages/db`. Postgres is the intended
primary database once Floop needs multi-user operation, remote deployment, or
stronger concurrent write behavior.

## Design Principles

- normalize durable entities
- keep state transitions auditable
- prefer append-only event records for operational history
- make multi-repo coordination explicit
- separate current state from historical evidence

## Core Tables

The field lists below describe the target durable model. The current SQLite
implementation tracks the same product concepts, with SQLite-compatible types
and some MVP-oriented naming details.

### `projects`

Represents a conceptual work space.

Suggested fields:

- `id` UUID PK
- `slug` text unique not null
- `name` text not null
- `description` text
- `workspace_root` text not null
- `default_base_branch` text
- `created_at` timestamptz not null
- `updated_at` timestamptz not null

### `repos`

One project may own multiple repos.

Suggested fields:

- `id` UUID PK
- `project_id` UUID FK -> `projects.id`
- `slug` text not null
- `name` text not null
- `local_path` text not null
- `remote_url` text
- `default_branch` text not null
- `is_primary` boolean not null default false
- `created_at` timestamptz not null
- `updated_at` timestamptz not null

Suggested constraints:

- unique `(project_id, slug)`
- unique `(project_id, local_path)`

### `project_policies`

Holds the active policy set for a project.

Suggested fields:

- `id` UUID PK
- `project_id` UUID unique FK -> `projects.id`
- `require_reviewer` boolean not null default true
- `require_validator` boolean not null default true
- `require_human_approval_before_merge` boolean not null default true
- `required_validation_command_profile_for_merge` text not null default ''
- `max_parallel_executions` integer not null default 1
- `max_parallel_merges` integer not null default 1
- `max_auto_continue_iterations` integer not null default 3
- `refinement_mode` text not null default `user_approved`
- `agent_created_ticket_default_state` text not null
- `ceremony_automation_json` jsonb not null default `{}`
- `created_at` timestamptz not null
- `updated_at` timestamptz not null

`ceremony_automation_json` stores the project-level automatic ceremony trigger
profile. The default profile is operator-approved and includes sensible lifecycle
triggers for refinement, planning, daily triage, review/demo prep, work
generation, and retro. Each trigger can declare whether it is enabled, a minimum
interval throttle, participant roles, decider role, and consensus policy.
Automatically-created ceremony runs store the evaluated lifecycle reason in
`scope_json`.

### `agent_profiles`

Role-specific execution config.

Suggested fields:

- `id` UUID PK
- `project_id` UUID FK -> `projects.id`
- `role` text not null
- `adapter` text not null
- `model` text
- `display_name` text not null
- `max_iterations` integer
- `config_json` jsonb not null default '{}'::jsonb
- `created_at` timestamptz not null
- `updated_at` timestamptz not null

Suggested constraints:

- unique `(project_id, role, display_name)`

### `tickets`

Primary work item.

Suggested fields:

- `id` UUID PK
- `project_id` UUID FK -> `projects.id`
- `parent_ticket_id` UUID FK -> `tickets.id`
- `key` text not null
- `title` text not null
- `brief` text not null
- `acceptance_criteria_md` text
- `definition_of_done_md` text
- `state` text not null
- `priority` text not null
- `created_by_kind` text not null
- `created_by_ref` text
- `assigned_role` text
- `assigned_agent_profile_id` UUID FK -> `agent_profiles.id`
- `blocked_reason_kind` text
- `latest_summary` text
- `created_at` timestamptz not null
- `updated_at` timestamptz not null
- `closed_at` timestamptz

Suggested constraints:

- unique `(project_id, key)`

### `ticket_dependencies`

Explicit dependency graph.

Suggested fields:

- `id` UUID PK
- `project_id` UUID FK -> `projects.id`
- `blocking_ticket_id` UUID FK -> `tickets.id`
- `blocked_ticket_id` UUID FK -> `tickets.id`
- `dependency_type` text not null default 'finish_to_start'
- `created_at` timestamptz not null

Suggested constraints:

- unique `(blocking_ticket_id, blocked_ticket_id, dependency_type)`

### `ticket_repo_targets`

Maps tickets to one or more repos.

Suggested fields:

- `id` UUID PK
- `ticket_id` UUID FK -> `tickets.id`
- `repo_id` UUID FK -> `repos.id`
- `base_ref` text not null
- `branch_name` text
- `target_scope_md` text
- `created_at` timestamptz not null
- `updated_at` timestamptz not null

Suggested constraints:

- unique `(ticket_id, repo_id)`

### `ceremony_runs`

Durable record of an agent ceremony over a project snapshot.

Suggested fields:

- `id` UUID PK
- `project_id` UUID FK -> `projects.id`
- `type` text not null
- `status` text not null
- `scope_json` jsonb not null
- `input_snapshot_json` jsonb not null
- `summary_md` text
- `questions_md` text
- `risk_md` text
- `created_by_kind` text not null
- `created_by_ref` text
- `started_at` timestamptz not null
- `finished_at` timestamptz
- `applied_at` timestamptz
- `created_at` timestamptz not null
- `updated_at` timestamptz not null

### `ceremony_proposals`

Reviewable proposed changes from a ceremony run. Applying a proposal uses the
normal ticket mutation paths.

Suggested fields:

- `id` UUID PK
- `project_id` UUID FK -> `projects.id`
- `run_id` UUID FK -> `ceremony_runs.id`
- `kind` text not null
- `status` text not null
- `summary` text not null
- `ticket_id` UUID FK -> `tickets.id`
- `payload_json` jsonb not null
- `applied_ticket_id` UUID FK -> `tickets.id`
- `applied_at` timestamptz
- `created_at` timestamptz not null
- `updated_at` timestamptz not null

### `ceremony_participants`

Stores one role contribution for a ceremony fan-out run.

Suggested fields:

- `id` UUID PK
- `project_id` UUID FK -> `projects.id`
- `run_id` UUID FK -> `ceremony_runs.id`
- `role` text not null
- `status` text not null
- `outcome` text not null default ''
- `summary_md` text not null default ''
- `questions_md` text not null default ''
- `risk_md` text not null default ''
- `payload_json` jsonb not null default `{}`
- `started_at` timestamptz
- `finished_at` timestamptz
- `created_at` timestamptz not null
- `updated_at` timestamptz not null

The ceremony participant driver runs pending participants through their role
profiles in parallel. Once all participants complete, Floop appends an
agent-consensus note proposal to the ceremony run.

### `executions`

One agent run against one ticket.

Suggested fields:

- `id` UUID PK
- `ticket_id` UUID FK -> `tickets.id`
- `agent_profile_id` UUID FK -> `agent_profiles.id`
- `role` text not null
- `iteration` integer not null
- `status` text not null
- `outcome` text
- `started_at` timestamptz not null
- `finished_at` timestamptz
- `summary_md` text
- `remaining_work_md` text
- `expected_next_evidence_md` text
- `failure_kind` text
- `blocked_kind` text
- `prompt_snapshot_uri` text
- `context_snapshot_json` jsonb

Suggested constraints:

- unique `(ticket_id, role, iteration)`

### `execution_repo_targets`

Execution-level targeting for multi-repo work.

Suggested fields:

- `id` UUID PK
- `execution_id` UUID FK -> `executions.id`
- `repo_id` UUID FK -> `repos.id`
- `branch_name` text not null
- `worktree_path` text
- `created_at` timestamptz not null

Suggested constraints:

- unique `(execution_id, repo_id)`

### `worktrees`

Tracks isolated workspaces.

Suggested fields:

- `id` UUID PK
- `project_id` UUID FK -> `projects.id`
- `repo_id` UUID FK -> `repos.id`
- `ticket_id` UUID FK -> `tickets.id`
- `execution_id` UUID FK -> `executions.id`
- `path` text not null
- `branch_name` text not null
- `base_ref` text not null
- `status` text not null
- `is_dirty` boolean not null default false
- `created_at` timestamptz not null
- `updated_at` timestamptz not null
- `cleaned_at` timestamptz

Suggested constraints:

- unique `(repo_id, path)`

### `reviews`

Separate reviewer lane output.

Suggested fields:

- `id` UUID PK
- `ticket_id` UUID FK -> `tickets.id`
- `review_execution_id` UUID FK -> `executions.id`
- `reviewer_agent_profile_id` UUID FK -> `agent_profiles.id`
- `verdict` text not null
- `summary_md` text
- `findings_count` integer not null default 0
- `created_at` timestamptz not null

### `review_findings`

Structured review issues.

Suggested fields:

- `id` UUID PK
- `review_id` UUID FK -> `reviews.id`
- `severity` text not null
- `category` text not null
- `file_path` text
- `line_number` integer
- `title` text not null
- `details_md` text
- `created_at` timestamptz not null

### `validation_runs`

Machine or agent validation lane.

Suggested fields:

- `id` UUID PK
- `ticket_id` UUID FK -> `tickets.id`
- `repo_id` UUID FK -> `repos.id`
- `validation_execution_id` UUID FK -> `executions.id`
- `status` text not null
- `verdict` text
- `commands_json` jsonb not null default '[]'::jsonb
- `summary_md` text
- `started_at` timestamptz not null
- `finished_at` timestamptz

### `artifacts`

Durable artifacts from executions, reviews, validations, merges.

Durability contract:

- Floop persists the artifact record and URI in SQLite.
- Driver-created local evidence is written under `.floop/artifacts/` and marked
  `managed_local_file`.
- Local files outside `.floop/artifacts/` and remote URIs are `referenced_uri`
  records. They are not copied, retained, or cleaned by Floop.
- `metadata_json.floopDurability` records `storageMode`, `copyPolicy`, and
  `cleanupPolicy`.

Suggested fields:

- `id` UUID PK
- `project_id` UUID FK -> `projects.id`
- `ticket_id` UUID FK -> `tickets.id`
- `execution_id` UUID FK -> `executions.id`
- `kind` text not null
- `label` text not null
- `uri` text not null
- `metadata_json` jsonb not null default '{}'::jsonb
- `created_at` timestamptz not null

### `merge_runs`

Tracks merge attempts and results.

Suggested fields:

- `id` UUID PK
- `ticket_id` UUID FK -> `tickets.id`
- `status` text not null
- `strategy` text not null
- `approved_by_kind` text
- `approved_by_ref` text
- `started_at` timestamptz not null
- `finished_at` timestamptz
- `summary_md` text

### `event_log`

Append-only operational history.

Suggested fields:

- `id` UUID PK
- `project_id` UUID FK -> `projects.id`
- `ticket_id` UUID FK -> `tickets.id`
- `execution_id` UUID FK -> `executions.id`
- `event_type` text not null
- `payload_json` jsonb not null
- `created_at` timestamptz not null

## Recommended Enums

Suggested logical enums:

- ticket state
- priority
- execution status
- execution outcome
- review verdict
- validation verdict
- worktree status
- merge status
- blocker kind

Start as text columns if you want migration agility; harden into database enums later
only once the product language stabilizes.

## Indexing Priorities

Add indexes early for:

- `tickets(project_id, state, priority)`
- `executions(ticket_id, started_at desc)`
- `event_log(project_id, created_at desc)`
- `event_log(ticket_id, created_at desc)`
- `worktrees(ticket_id)`
- `ticket_dependencies(blocked_ticket_id)`
- `ticket_dependencies(blocking_ticket_id)`

## V1 Recommendation

Implement the following first:

- `projects`
- `repos`
- `project_policies`
- `agent_profiles`
- `tickets`
- `ticket_dependencies`
- `ticket_repo_targets`
- `executions`
- `worktrees`
- `reviews`
- `review_findings`
- `validation_runs`
- `artifacts`
- `event_log`

`merge_runs` can arrive slightly after the first execution/review loop if needed.
