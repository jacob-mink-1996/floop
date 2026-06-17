export const migration = {
  version: 9,
  up(database) {
    const columns = new Set(database.prepare("pragma table_info(executions)").all().map((row) => row.name));
    const addColumn = (name, sql) => {
      if (!columns.has(name)) {
        database.exec(`alter table executions add column ${sql}`);
      }
    };

    addColumn("harness_kind", "harness_kind text not null default ''");
    addColumn("external_thread_id", "external_thread_id text not null default ''");
    addColumn("external_session_id", "external_session_id text not null default ''");
    addColumn("external_conversation_id", "external_conversation_id text not null default ''");
    addColumn("harness_capabilities_json", "harness_capabilities_json text not null default '[]'");
    addColumn("resumed_from_execution_id", "resumed_from_execution_id text references executions(id) on delete set null");
    addColumn("steering_metadata_json", "steering_metadata_json text not null default '{}'");

    database.exec(`
      create index if not exists idx_executions_external_thread_id on executions(external_thread_id);
      create index if not exists idx_executions_resumed_from_execution_id on executions(resumed_from_execution_id);
    `);
  },
};
