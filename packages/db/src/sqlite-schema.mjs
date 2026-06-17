import { latestSqliteMigrationVersion, sqliteMigrations } from "./sqlite-migrations/index.mjs";

export const sqliteSchema = `
pragma foreign_keys = on;

create table if not exists projects (
  id text primary key,
  slug text not null unique,
  name text not null,
  description text not null default '',
  workspace_root text not null,
  default_base_branch text not null,
  created_at text not null,
  updated_at text not null
);

create table if not exists project_policies (
  id text primary key,
  project_id text not null unique references projects(id) on delete cascade,
  require_reviewer integer not null default 1,
  require_validator integer not null default 1,
  require_human_approval_before_merge integer not null default 1,
  require_demo_evidence_before_merge integer not null default 1,
  required_validation_command_profile_for_merge text not null default '',
  max_parallel_executions integer not null default 1,
  max_parallel_merges integer not null default 1,
  max_auto_continue_iterations integer not null default 3,
  refinement_mode text not null default 'user_approved',
  agent_created_ticket_default_state text not null,
  ceremony_automation_json text not null default '{}',
  created_at text not null,
  updated_at text not null
);

create table if not exists agent_profiles (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  role text not null,
  adapter text not null,
  model text not null,
  config_json text not null default '{}',
  created_at text not null,
  updated_at text not null,
  unique (project_id, role)
);

create table if not exists repos (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  slug text not null,
  name text not null,
  local_path text not null,
  remote_url text not null default '',
  default_branch text not null,
  is_primary integer not null default 0,
  created_at text not null,
  updated_at text not null,
  unique (project_id, slug),
  unique (project_id, local_path)
);

create table if not exists tickets (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  parent_ticket_id text references tickets(id) on delete set null,
  key text not null,
  title text not null,
  brief text not null,
  acceptance_criteria_md text not null default '',
  definition_of_done_md text not null default '',
  state text not null,
  priority text not null,
  assigned_role text not null,
  latest_summary text not null default '',
  created_at text not null,
  updated_at text not null,
  unique (project_id, key)
);

create table if not exists ticket_dependencies (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  blocking_ticket_id text not null references tickets(id) on delete cascade,
  blocked_ticket_id text not null references tickets(id) on delete cascade,
  dependency_type text not null default 'finish_to_start',
  created_at text not null,
  unique (blocking_ticket_id, blocked_ticket_id, dependency_type)
);

create table if not exists ticket_repo_targets (
  id text primary key,
  ticket_id text not null references tickets(id) on delete cascade,
  repo_id text not null references repos(id) on delete cascade,
  base_ref text not null,
  branch_name text not null default '',
  target_scope_md text not null default '',
  created_at text not null,
  updated_at text not null,
  unique (ticket_id, repo_id)
);

create table if not exists executions (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  ticket_id text not null references tickets(id) on delete cascade,
  agent_profile_id text references agent_profiles(id) on delete set null,
  role text not null,
  iteration integer not null,
  status text not null,
  outcome text,
  summary_md text not null default '',
  remaining_work_md text not null default '',
  expected_next_evidence_md text not null default '',
  failure_kind text not null default '',
  blocked_kind text not null default '',
  claim_token text not null default '',
  claim_expires_at text,
  harness_kind text not null default '',
  external_thread_id text not null default '',
  external_session_id text not null default '',
  external_conversation_id text not null default '',
  harness_capabilities_json text not null default '[]',
  resumed_from_execution_id text references executions(id) on delete set null,
  steering_metadata_json text not null default '{}',
  started_at text not null,
  finished_at text,
  created_at text not null,
  updated_at text not null,
  unique (ticket_id, role, iteration)
);

create table if not exists worktrees (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  repo_id text not null references repos(id) on delete cascade,
  ticket_id text not null references tickets(id) on delete cascade,
  execution_id text not null references executions(id) on delete cascade,
  path text not null,
  branch_name text not null,
  base_ref text not null,
  status text not null,
  is_dirty integer not null default 0,
  created_at text not null,
  updated_at text not null,
  cleaned_at text,
  unique (repo_id, path)
);

create table if not exists reviews (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  ticket_id text not null references tickets(id) on delete cascade,
  execution_id text not null references executions(id) on delete cascade,
  reviewer_profile_id text references agent_profiles(id) on delete set null,
  verdict text not null,
  summary_md text not null default '',
  findings_count integer not null default 0,
  blocked_kind text not null default '',
  created_at text not null
);

create table if not exists review_findings (
  id text primary key,
  review_id text not null references reviews(id) on delete cascade,
  severity text not null,
  category text not null,
  file_path text not null default '',
  line_number integer,
  title text not null,
  details_md text not null default '',
  created_at text not null
);

create table if not exists validation_runs (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  ticket_id text not null references tickets(id) on delete cascade,
  repo_id text not null references repos(id) on delete cascade,
  execution_id text references executions(id) on delete set null,
  status text not null,
  verdict text not null,
  command_profile text not null default '',
  commands_json text not null default '[]',
  summary_md text not null default '',
  blocked_kind text not null default '',
  started_at text not null,
  finished_at text not null
);

create table if not exists artifacts (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  ticket_id text not null references tickets(id) on delete cascade,
  execution_id text references executions(id) on delete cascade,
  review_id text references reviews(id) on delete cascade,
  validation_run_id text references validation_runs(id) on delete cascade,
  merge_run_id text references merge_runs(id) on delete cascade,
  kind text not null,
  label text not null,
  uri text not null,
  metadata_json text not null default '{}',
  created_at text not null
);

create table if not exists merge_runs (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  ticket_id text not null references tickets(id) on delete cascade,
  status text not null,
  strategy text not null,
  approved_by_kind text not null default '',
  approved_by_ref text not null default '',
  summary_md text not null default '',
  failure_kind text not null default '',
  claim_token text not null default '',
  claim_expires_at text,
  started_at text not null,
  finished_at text
);

create table if not exists events (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  repo_id text references repos(id) on delete set null,
  ticket_id text references tickets(id) on delete set null,
  type text not null,
  summary text not null,
  detail text not null default '',
  reason_code text not null default '',
  reason_source text not null default '',
  created_at text not null
);

create table if not exists ceremony_runs (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  type text not null,
  status text not null,
  scope_json text not null default '{}',
  input_snapshot_json text not null default '{}',
  summary_md text not null default '',
  questions_md text not null default '',
  risk_md text not null default '',
  created_by_kind text not null default 'human',
  created_by_ref text not null default 'operator',
  started_at text not null,
  finished_at text,
  applied_at text,
  created_at text not null,
  updated_at text not null
);

create table if not exists ceremony_proposals (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  run_id text not null references ceremony_runs(id) on delete cascade,
  kind text not null,
  status text not null,
  summary text not null,
  ticket_id text references tickets(id) on delete set null,
  payload_json text not null default '{}',
  applied_ticket_id text references tickets(id) on delete set null,
  applied_at text,
  created_at text not null,
  updated_at text not null
);

create table if not exists ceremony_participants (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  run_id text not null references ceremony_runs(id) on delete cascade,
  role text not null,
  status text not null,
  outcome text not null default '',
  summary_md text not null default '',
  questions_md text not null default '',
  risk_md text not null default '',
  payload_json text not null default '{}',
  started_at text,
  finished_at text,
  created_at text not null,
  updated_at text not null,
  unique (run_id, role)
);

create index if not exists idx_repos_project_id on repos(project_id);
create index if not exists idx_tickets_project_id on tickets(project_id);
create index if not exists idx_ticket_repo_targets_ticket_id on ticket_repo_targets(ticket_id);
create index if not exists idx_ticket_dependencies_blocked_ticket_id on ticket_dependencies(blocked_ticket_id);
create index if not exists idx_executions_project_id on executions(project_id);
create index if not exists idx_executions_ticket_id on executions(ticket_id);
create index if not exists idx_executions_external_thread_id on executions(external_thread_id);
create index if not exists idx_executions_resumed_from_execution_id on executions(resumed_from_execution_id);
create index if not exists idx_worktrees_project_id on worktrees(project_id);
create index if not exists idx_worktrees_ticket_id on worktrees(ticket_id);
create index if not exists idx_worktrees_execution_id on worktrees(execution_id);
create index if not exists idx_reviews_project_id on reviews(project_id);
create index if not exists idx_reviews_ticket_id on reviews(ticket_id);
create index if not exists idx_review_findings_review_id on review_findings(review_id);
create index if not exists idx_validation_runs_project_id on validation_runs(project_id);
create index if not exists idx_validation_runs_ticket_id on validation_runs(ticket_id);
create index if not exists idx_artifacts_project_id on artifacts(project_id);
create index if not exists idx_artifacts_ticket_id on artifacts(ticket_id);
create index if not exists idx_artifacts_execution_id on artifacts(execution_id);
create index if not exists idx_artifacts_review_id on artifacts(review_id);
create index if not exists idx_artifacts_validation_run_id on artifacts(validation_run_id);
create index if not exists idx_artifacts_merge_run_id on artifacts(merge_run_id);
create index if not exists idx_merge_runs_project_id on merge_runs(project_id);
create index if not exists idx_merge_runs_ticket_id on merge_runs(ticket_id);
create index if not exists idx_events_project_id on events(project_id);
create index if not exists idx_events_ticket_id on events(ticket_id);
create index if not exists idx_ceremony_runs_project_id on ceremony_runs(project_id);
create index if not exists idx_ceremony_proposals_run_id on ceremony_proposals(run_id);
create index if not exists idx_ceremony_participants_status on ceremony_participants(status);
`;

export function migrateSchema(database) {
  const currentVersion = Number(database.prepare("pragma user_version").get().user_version || 0);
  for (const migration of sqliteMigrations) {
    if (migration.version <= currentVersion) {
      continue;
    }
    migration.up(database);
    database.exec(`pragma user_version = ${migration.version}`);
  }

  const finalVersion = Number(database.prepare("pragma user_version").get().user_version || 0);
  if (finalVersion < latestSqliteMigrationVersion) {
    throw new Error(`SQLite migrations stopped at version ${finalVersion}; expected ${latestSqliteMigrationVersion}`);
  }
}
