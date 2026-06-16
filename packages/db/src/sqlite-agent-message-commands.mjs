import { randomUUID } from "node:crypto";
import { agentMessageDto } from "../../contracts/src/index.mjs";

const roleNames = new Set(["product_manager", "architect", "developer", "reviewer", "validator", "integrator"]);

export function createAgentMessageCommands({
  database,
  getStore,
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

      maybeAutoPromoteAgentMessage(commands, database, getStore, projectId, id);
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
          reasonSource: input.reasonSource || "operator",
        });
      });

      return commands.getAgentMessage(projectId, messageId);
    },

    respondAgentMessage(projectId, messageId, input) {
      const existing = commands.getAgentMessage(projectId, messageId);
      if (!existing) {
        return null;
      }
      if (existing.intent !== "request_input") {
        throw new Error("Only input requests can be responded to");
      }
      if (existing.status !== "pending") {
        throw new Error("Input request is no longer pending");
      }

      const store = getStore();
      const responseMd = requiredText(input.responseMd, "responseMd");
      const responderKind = optionalText(input.responderKind, "human");
      const responderRef = optionalText(input.responderRef, "operator");
      const executionId = typeof existing.target?.executionId === "string" ? existing.target.executionId : "";
      const ticketId = typeof existing.target?.ticketId === "string" ? existing.target.ticketId : "";
      const updated = commands.updateAgentMessage(projectId, messageId, {
        status: "attached",
        promotedKind: "ticket_event",
        promotedRef: ticketId,
        reasonSource: responderKind,
      });

      const responseMessage = store.createAgentMessage(projectId, {
        actor: responderRef,
        source: responderKind,
        intent: "comment_on_ticket",
        target: { ticketId, executionId, responseToMessageId: messageId },
        summary: `Response to ${existing.summary}`,
        body: responseMd,
        metadata: {
          responseToMessageId: messageId,
          responderKind,
          responderRef,
          unblockResponse: true,
        },
      });
      commands.updateAgentMessage(projectId, responseMessage.id, {
        status: "attached",
        promotedKind: "ticket_event",
        promotedRef: ticketId,
        reasonSource: responderKind,
      });

      if (input.continueExecution !== false && executionId) {
        try {
          const continued = store.continueExecution(projectId, executionId, {
            reason: `Unblock response from ${responderRef}: ${responseMd}`,
          });
          if (continued) {
            commands.updateAgentMessage(projectId, messageId, {
              status: "accepted",
              promotedKind: "execution",
              promotedRef: continued.id,
              reasonSource: responderKind,
            });
          }
        } catch {
          // The response remains attached even if the lane cannot continue automatically.
        }
      }

      return commands.getAgentMessage(projectId, messageId) || updated;
    },
  };

  return commands;
}

function maybeAutoPromoteAgentMessage(commands, database, getStore, projectId, messageId) {
  const interactionMode = projectInteractionMode(database, projectId);
  if (interactionMode !== "autopilot" && interactionMode !== "fully_autonomous") {
    return;
  }
  const message = commands.getAgentMessage(projectId, messageId);
  const decision = interactionMode === "fully_autonomous"
    ? fullyAutonomousDecision(getStore(), database, projectId, message)
    : lowRiskAutonomousDecision(message);
  if (!decision) {
    return;
  }
  commands.updateAgentMessage(projectId, messageId, {
    ...decision,
    reasonSource: "interaction_policy",
  });
}

function projectInteractionMode(database, projectId) {
  const row = database
    .prepare("select interaction_mode from project_policies where project_id = ?")
    .get(projectId);
  return row?.interaction_mode || "manual";
}

function lowRiskAutonomousDecision(message) {
  if (!message || message.status !== "pending") {
    return null;
  }
  if (message.intent === "comment_on_ticket" && hasTarget(message, "ticketId")) {
    return { status: "attached" };
  }
  if (message.intent === "submit_artifact" && hasTarget(message, "ticketId") && isArtifactInput(message.metadata?.artifact)) {
    return { status: "accepted" };
  }
  if (message.intent === "submit_ceremony_input" && hasTarget(message, "runId")) {
    return { status: "accepted" };
  }
  return null;
}

function fullyAutonomousDecision(store, database, projectId, message) {
  const lowRiskDecision = lowRiskAutonomousDecision(message);
  if (lowRiskDecision) {
    return lowRiskDecision;
  }
  if (!message || message.status !== "pending") {
    return null;
  }
  if (message.intent === "suggest_ticket" || message.intent === "raise_risk") {
    const ticket = store.createTicket(projectId, {
      title: message.summary,
      brief: message.body || message.summary,
      priority: message.intent === "raise_risk" ? "urgent" : "medium",
      state: "READY",
      assignedRole: roleFromMessage(message),
      latestSummary: `Created from ${message.actor} ${message.intent.replaceAll("_", " ")}.`,
      repoTargets: repoTargetsForMessage(database, projectId, message),
    });
    if (!ticket) {
      return null;
    }
    try {
      store.createExecution(projectId, ticket.id, {
        role: ticket.assignedRole || roleFromMessage(message),
        reason: message.body || message.summary,
      });
    } catch {
      // Ticket creation is still progress; execution may be blocked by concurrency or missing role policy.
    }
    return { status: "converted", promotedKind: "ticket", promotedRef: ticket.id };
  }
  if (message.intent === "suggest_dispatch" && hasTarget(message, "ticketId")) {
    const execution = store.createExecution(projectId, message.target.ticketId, {
      role: roleFromMessage(message),
      reason: message.body || message.summary,
    });
    return execution
      ? { status: "attached", promotedKind: "execution", promotedRef: execution.id }
      : null;
  }
  return null;
}

function roleFromMessage(message) {
  return typeof message.metadata?.role === "string" && roleNames.has(message.metadata.role)
    ? message.metadata.role
    : "developer";
}

function repoTargetsForMessage(database, projectId, message) {
  const targetRepoId = typeof message.target?.repoId === "string" ? message.target.repoId : "";
  const repo = targetRepoId
    ? database.prepare("select id, default_branch from repos where project_id = ? and id = ?").get(projectId, targetRepoId)
    : database.prepare("select id, default_branch from repos where project_id = ? order by is_primary desc, created_at asc limit 1").get(projectId);
  return repo ? [{ repoId: repo.id, baseRef: repo.default_branch || "main" }] : [];
}

function hasTarget(message, key) {
  return typeof message.target?.[key] === "string" && Boolean(message.target[key]);
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
