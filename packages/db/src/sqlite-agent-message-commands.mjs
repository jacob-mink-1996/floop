import { randomUUID } from "node:crypto";
import { agentMessageDto } from "../../contracts/src/index.mjs";

export function createAgentMessageCommands({
  database,
  getProjectRow,
  insertEvent,
  mapAgentMessage,
  now,
  optionalText,
  requiredText,
  withTransaction,
}) {
  const commands = {
    listAgentMessages(projectId, filters = {}) {
      if (!getProjectRow(database, projectId)) {
        return null;
      }

      const clauses = ["project_id = ?"];
      const values = [projectId];
      if (filters.status) {
        clauses.push("status = ?");
        values.push(filters.status);
      }
      if (filters.intent) {
        clauses.push("intent = ?");
        values.push(filters.intent);
      }

      const limit = Math.max(1, Math.min(Number(filters.limit) || 50, 200));
      values.push(limit);
      return database
        .prepare(
          `select *
           from agent_messages
           where ${clauses.join(" and ")}
           order by created_at desc, id desc
           limit ?`,
        )
        .all(...values)
        .map(mapAgentMessage)
        .map(agentMessageDto);
    },

    createAgentMessage(projectId, input) {
      const project = getProjectRow(database, projectId);
      if (!project) {
        return null;
      }

      const timestamp = now();
      const id = `agent_message_${randomUUID()}`;
      withTransaction(database, () => {
        database
          .prepare(
            `insert into agent_messages (
              id, project_id, actor, source, intent, target_json, summary, body,
              metadata_json, status, promoted_kind, promoted_ref, created_at, updated_at, dismissed_at
            ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            projectId,
            requiredText(input.actor, "actor"),
            requiredText(input.source, "source"),
            requiredText(input.intent, "intent"),
            JSON.stringify(input.target || {}),
            requiredText(input.summary, "summary"),
            optionalText(input.body),
            JSON.stringify(input.metadata || {}),
            "pending",
            "",
            "",
            timestamp,
            timestamp,
            null,
          );
        insertEvent(database, {
          projectId,
          type: "agent.message_received",
          summary: `${input.actor} suggested ${input.intent.replaceAll("_", " ")}`,
          detail: input.summary,
          reasonCode: input.intent,
          reasonSource: input.source,
        });
      });

      return commands.getAgentMessage(projectId, id);
    },

    getAgentMessage(projectId, messageId) {
      const row = database
        .prepare("select * from agent_messages where project_id = ? and id = ?")
        .get(projectId, messageId);
      return row ? agentMessageDto(mapAgentMessage(row)) : null;
    },

    updateAgentMessage(projectId, messageId, input) {
      const existing = commands.getAgentMessage(projectId, messageId);
      if (!existing) {
        return null;
      }

      const timestamp = now();
      const dismissedAt = input.status === "dismissed" ? timestamp : existing.dismissedAt || null;
      withTransaction(database, () => {
        database
          .prepare(
            `update agent_messages
             set status = ?, promoted_kind = ?, promoted_ref = ?, dismissed_at = ?, updated_at = ?
             where project_id = ? and id = ?`,
          )
          .run(
            input.status,
            optionalText(input.promotedKind, existing.promotedKind),
            optionalText(input.promotedRef, existing.promotedRef),
            dismissedAt || null,
            timestamp,
            projectId,
            messageId,
          );
        insertEvent(database, {
          projectId,
          type: `agent.message_${input.status}`,
          summary: `${existing.actor} message ${input.status}`,
          detail: existing.summary,
          reasonCode: input.status,
          reasonSource: "operator",
        });
      });

      return commands.getAgentMessage(projectId, messageId);
    },
  };

  return commands;
}
