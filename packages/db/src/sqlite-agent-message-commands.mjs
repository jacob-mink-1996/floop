import { randomUUID } from "node:crypto";
import { agentMessageDto } from "../../contracts/src/index.mjs";

export function createAgentMessageCommands({
  database,
  getProjectRow,
  insertArtifacts,
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
      const ticketId = typeof existing.target?.ticketId === "string" && existing.target.ticketId
        ? existing.target.ticketId
        : null;
      const repoId = typeof existing.target?.repoId === "string" && existing.target.repoId
        ? existing.target.repoId
        : null;
      const ceremonyRunId = typeof existing.target?.runId === "string" && existing.target.runId
        ? existing.target.runId
        : null;
      const promotedKind = optionalText(input.promotedKind, defaultPromotedKind(existing, input.status));
      let promotedRef = optionalText(input.promotedRef, existing.promotedRef);
      const shouldPromoteArtifact =
        ticketId &&
        !existing.promotedKind &&
        promotedKind === "artifact" &&
        existing.intent === "submit_artifact" &&
        (input.status === "accepted" || input.status === "attached") &&
        isArtifactInput(existing.metadata?.artifact);
      const shouldPromoteCeremonyInput =
        ceremonyRunId &&
        !existing.promotedKind &&
        promotedKind === "ceremony_proposal" &&
        existing.intent === "submit_ceremony_input" &&
        (input.status === "accepted" || input.status === "attached");
      const ceremonyInputProposalId = shouldPromoteCeremonyInput
        ? promotedRef || `ceremony_proposal_${randomUUID()}`
        : "";
      if (shouldPromoteCeremonyInput) {
        const run = database
          .prepare("select id from ceremony_runs where project_id = ? and id = ?")
          .get(projectId, ceremonyRunId);
        if (!run) {
          throw new Error(`Target ceremony run not found: ${ceremonyRunId}`);
        }
        promotedRef = ceremonyInputProposalId;
      }
      withTransaction(database, () => {
        database
          .prepare(
            `update agent_messages
             set status = ?, promoted_kind = ?, promoted_ref = ?, dismissed_at = ?, updated_at = ?
             where project_id = ? and id = ?`,
          )
          .run(
            input.status,
            promotedKind,
            promotedRef,
            dismissedAt || null,
            timestamp,
            projectId,
            messageId,
          );
        if (shouldPromoteArtifact) {
          insertArtifacts(database, projectId, ticketId, {}, [existing.metadata.artifact], timestamp);
        }
        if (shouldPromoteCeremonyInput) {
          insertCeremonyInputProposal(database, {
            projectId,
            runId: ceremonyRunId,
            proposalId: ceremonyInputProposalId,
            message: existing,
            timestamp,
          });
        }
        insertEvent(database, {
          projectId,
          repoId,
          ticketId,
          type: `agent.message_${input.status}`,
          summary: `${existing.actor} message ${input.status}`,
          detail: existing.body || existing.summary,
          reasonCode: input.status,
          reasonSource: "operator",
        });
      });

      return commands.getAgentMessage(projectId, messageId);
    },
  };

  return commands;
}

function defaultPromotedKind(message, status) {
  if (message.promotedKind) {
    return message.promotedKind;
  }
  if (status === "attached" && message.intent === "comment_on_ticket") {
    return "ticket_event";
  }
  if ((status === "accepted" || status === "attached") && message.intent === "submit_artifact") {
    return "artifact";
  }
  if ((status === "accepted" || status === "attached") && message.intent === "submit_ceremony_input") {
    return "ceremony_proposal";
  }
  return "";
}

function isArtifactInput(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof value.kind === "string" &&
      typeof value.label === "string" &&
      typeof value.uri === "string",
  );
}

function insertCeremonyInputProposal(database, { projectId, runId, proposalId, message, timestamp }) {
  const detail = message.body || message.summary;
  database
    .prepare(
      `insert into ceremony_proposals (
        id, project_id, run_id, kind, status, summary, ticket_id,
        payload_json, applied_ticket_id, applied_at, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      proposalId,
      projectId,
      runId,
      "note",
      "pending",
      message.summary || `External input from ${message.actor}`,
      null,
      JSON.stringify({
        note: detail,
        actor: message.actor,
        source: message.source,
        agentMessageId: message.id,
        metadata: message.metadata || {},
      }),
      null,
      null,
      timestamp,
      timestamp,
    );
  database
    .prepare("update ceremony_runs set updated_at = ? where project_id = ? and id = ?")
    .run(timestamp, projectId, runId);
}
