export const migration = {
  version: 7,
  name: "agent messages and interaction mode",
  up(database) {
    const policyColumns = database.prepare("pragma table_info(project_policies)").all();
    if (!policyColumns.some((column) => column.name === "interaction_mode")) {
      database.exec("alter table project_policies add column interaction_mode text not null default 'manual'");
    }

    database.exec(`
      create table if not exists agent_messages (
        id text primary key,
        project_id text not null references projects(id) on delete cascade,
        actor text not null,
        source text not null,
        intent text not null,
        target_json text not null default '{}',
        summary text not null,
        body text not null default '',
        metadata_json text not null default '{}',
        status text not null default 'pending',
        promoted_kind text not null default '',
        promoted_ref text not null default '',
        created_at text not null,
        updated_at text not null,
        dismissed_at text
      )
    `);
    database.exec("create index if not exists idx_agent_messages_project_status on agent_messages(project_id, status)");
    database.exec("create index if not exists idx_agent_messages_project_created on agent_messages(project_id, created_at)");
  },
};
