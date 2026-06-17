export const migration = {
  version: 10,
  up(database) {
    const projectPolicyColumns = new Set(
      database.prepare("pragma table_info(project_policies)").all().map((row) => row.name),
    );
    if (!projectPolicyColumns.has("steering_worktree_policy")) {
      database.exec(
        "alter table project_policies add column steering_worktree_policy text not null default 'new_iteration_worktree'",
      );
    }

    const worktreeColumns = new Set(database.prepare("pragma table_info(worktrees)").all().map((row) => row.name));
    if (!worktreeColumns.has("resumed_from_worktree_id")) {
      database.exec(
        "alter table worktrees add column resumed_from_worktree_id text references worktrees(id) on delete set null",
      );
    }
    if (!worktreeColumns.has("lineage_id")) {
      database.exec("alter table worktrees add column lineage_id text not null default ''");
      database.exec("update worktrees set lineage_id = id where lineage_id = ''");
    }

    database.exec(`
      create index if not exists idx_worktrees_resumed_from_worktree_id on worktrees(resumed_from_worktree_id);
      create index if not exists idx_worktrees_lineage_id on worktrees(lineage_id);
    `);
  },
};
