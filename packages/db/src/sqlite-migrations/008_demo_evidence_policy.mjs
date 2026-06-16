export const migration = {
  version: 8,
  name: "demo evidence merge policy",
  up(database) {
    const policyColumns = database.prepare("pragma table_info(project_policies)").all();
    if (!policyColumns.some((column) => column.name === "require_demo_evidence_before_merge")) {
      database.exec(
        "alter table project_policies add column require_demo_evidence_before_merge integer not null default 1",
      );
    }
  },
};
