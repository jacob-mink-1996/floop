import { randomUUID } from "node:crypto";
import { reviewDto, validationRunDto } from "../../contracts/src/index.mjs";
import { compactTicketSummary } from "./ticket-summary.mjs";

export function createEvidenceCommands({
  database,
  getExecutionRow,
  getTicketRow,
  insertArtifacts,
  insertEvent,
  withTransaction,
  now,
  requiredText,
  optionalText,
  requiredProjectPolicy,
  resolveAgentProfileForExecution,
  deriveTicketStateForReviewVerdict,
  deriveTicketStateForValidationVerdict,
  deriveReviewEventReason,
  deriveValidationEventReason,
  normalizeValidationRepoIds,
  buildMergePolicyBlocks,
  getLatestReviewRow,
  getRepoTargetsByTicketId,
  getReviewsByTicketId,
  getValidationRunsByTicketId,
  listProjectArtifacts,
  startAutoRoutedLaneExecution,
  getStore,
  assertAutomaticTicketTransition,
}) {
  const commands = {
    listArtifacts(projectId, filters = {}) {
      return listProjectArtifacts(database, projectId, filters);
    },

    listReviews(projectId, ticketId) {
      if (!getTicketRow(database, projectId, ticketId)) {
        return null;
      }

      return (getReviewsByTicketId(database, projectId, [ticketId]).get(ticketId) || []).map(reviewDto);
    },

    createReview(projectId, ticketId, input) {
      const ticket = getTicketRow(database, projectId, ticketId);
      if (!ticket) {
        return null;
      }
      const execution = getExecutionRow(database, projectId, requiredText(input.executionId, "executionId"));
      if (!execution || execution.ticket_id !== ticketId) {
        throw new Error(`Unknown execution for ticket ${ticket.key}: ${input.executionId}`);
      }
      if (!execution.finished_at) {
        throw new Error(`Execution ${execution.id} must be finished before review`);
      }
      if (execution.outcome !== "completed") {
        throw new Error(`Execution ${execution.id} must complete successfully before review`);
      }
      if (ticket.state !== "REVIEWING") {
        throw new Error(`Ticket ${ticket.key} is not ready for review`);
      }

      const policy = requiredProjectPolicy(database, projectId);
      const reviewerProfile = resolveAgentProfileForExecution(
        database,
        projectId,
        "reviewer",
        input.reviewerProfileId,
      );
      const verdict = requiredText(input.verdict, "verdict");
      const findings = input.findings || [];
      const artifacts = input.artifacts || [];
      const timestamp = now();
      const review = {
        id: `review_${randomUUID()}`,
        projectId,
        ticketId,
        executionId: execution.id,
        reviewerProfileId: reviewerProfile.id,
        verdict,
        summaryMd: optionalText(input.summaryMd),
        findingsCount: findings.length,
        blockedKind: optionalText(input.blockedKind),
        createdAt: timestamp,
      };
      const nextState = deriveTicketStateForReviewVerdict(policy, verdict);
      const transitionReason = deriveReviewEventReason(review);
      assertAutomaticTicketTransition({
        fromState: ticket.state,
        toState: nextState,
        reasonCode: transitionReason.reasonCode || "review_completed",
      });
      const ticketSummary =
        compactTicketSummary(
          review.summaryMd,
          `${ticket.key} review ${verdict === "passed" ? "passed" : verdict === "rework" ? "requested rework" : "blocked"}`,
        );

      withTransaction(database, () => {
        database
          .prepare(
            `insert into reviews (
              id, project_id, ticket_id, execution_id, reviewer_profile_id,
              verdict, summary_md, findings_count, blocked_kind, created_at
            ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            review.id,
            review.projectId,
            review.ticketId,
            review.executionId,
            review.reviewerProfileId,
            review.verdict,
            review.summaryMd,
            review.findingsCount,
            review.blockedKind,
            review.createdAt,
          );

        for (const finding of findings) {
          database
            .prepare(
              `insert into review_findings (
                id, review_id, severity, category, file_path, line_number, title, details_md, created_at
              ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              `review_finding_${randomUUID()}`,
              review.id,
              finding.severity,
              finding.category,
              optionalText(finding.filePath),
              finding.lineNumber || null,
              finding.title,
              optionalText(finding.detailsMd),
              timestamp,
            );
        }

        insertArtifacts(
          database,
          projectId,
          ticketId,
          {
            reviewId: review.id,
          },
          artifacts,
          timestamp,
        );

        database
          .prepare("update tickets set state = ?, latest_summary = ?, updated_at = ? where project_id = ? and id = ?")
          .run(nextState, ticketSummary, timestamp, projectId, ticketId);

        insertEvent(database, {
          projectId,
          ticketId,
          type: "review.completed",
          summary: `${ticket.key} review ${verdict}`,
          detail: review.summaryMd || `${findings.length} finding${findings.length === 1 ? "" : "s"}`,
          ...transitionReason,
        });
      });

      if (verdict === "passed") {
        startAutoRoutedLaneExecution({
          store: getStore(),
          database,
          projectId,
          ticketId,
          reason: `${ticket.key} review passed; Floop routed the validator lane.`,
        });
      } else if (verdict === "rework") {
        startAutoRoutedLaneExecution({
          store: getStore(),
          database,
          projectId,
          ticketId,
          reason: `${ticket.key} review requested rework; Floop routed the previous working lane.`,
        });
      }

      return reviewDto(getReviewsByTicketId(database, projectId, [ticketId]).get(ticketId)[0]);
    },

    listValidations(projectId, ticketId) {
      if (!getTicketRow(database, projectId, ticketId)) {
        return null;
      }

      return (getValidationRunsByTicketId(database, projectId, [ticketId]).get(ticketId) || []).map(
        validationRunDto,
      );
    },

    createValidation(projectId, ticketId, input) {
      const ticket = getTicketRow(database, projectId, ticketId);
      if (!ticket) {
        return null;
      }

      if (input.executionId) {
        const execution = getExecutionRow(database, projectId, input.executionId);
        if (!execution || execution.ticket_id !== ticketId) {
          throw new Error(`Unknown execution for ticket ${ticket.key}: ${input.executionId}`);
        }
        if (!execution.finished_at) {
          throw new Error(`Execution ${execution.id} must be finished before validation`);
        }
        if (execution.outcome !== "completed") {
          throw new Error(`Execution ${execution.id} must complete successfully before validation`);
        }
      }

      if (ticket.state !== "VALIDATING") {
        throw new Error(`Ticket ${ticket.key} is not ready for validation`);
      }

      const repoTargets = getRepoTargetsByTicketId(database, [ticketId]).get(ticketId) || [];
      const repoIds = normalizeValidationRepoIds(database, projectId, ticket, repoTargets, input.repoIds || []);
      const verdict = requiredText(input.verdict, "verdict");
      const timestamp = now();
      const policy = requiredProjectPolicy(database, projectId);
      const nextState = deriveTicketStateForValidationVerdict(policy, verdict);
      const summaryMd = optionalText(input.summaryMd);
      const ticketSummary =
        compactTicketSummary(
          summaryMd,
          `${ticket.key} validation ${verdict === "passed" ? "passed" : verdict === "failed" ? "found rework" : "blocked"}`,
        );
      const commandProfile = optionalText(input.commandProfile);
      const commandList = input.commands || [];
      const artifacts = input.artifacts || [];
      const existingTicketArtifacts = listProjectArtifacts(database, projectId, { ticketId, limit: 200 });
      const validationIds = [];
      const mergePolicyBlocks =
        verdict === "passed"
          ? buildMergePolicyBlocks(policy, getLatestReviewRow(database, projectId, ticketId), {
              verdict,
              command_profile: commandProfile,
              artifacts: [...artifacts, ...existingTicketArtifacts],
            })
          : [];
      const transitionReason = deriveValidationEventReason({
        verdict,
        blockedKind: optionalText(input.blockedKind),
        mergePolicyBlock: mergePolicyBlocks[0] || null,
      });
      assertAutomaticTicketTransition({
        fromState: ticket.state,
        toState: nextState,
        reasonCode: transitionReason.reasonCode || "validation_completed",
      });

      withTransaction(database, () => {
        for (const repoId of repoIds) {
          const validationId = `validation_${randomUUID()}`;
          validationIds.push(validationId);
          database
            .prepare(
              `insert into validation_runs (
                id, project_id, ticket_id, repo_id, execution_id, status, verdict,
                command_profile, commands_json, summary_md, blocked_kind, started_at, finished_at
              ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              validationId,
              projectId,
              ticketId,
              repoId,
              input.executionId || null,
              "completed",
              verdict,
              commandProfile,
              JSON.stringify(commandList),
              summaryMd,
              optionalText(input.blockedKind),
              timestamp,
              timestamp,
            );
        }

        for (const validationId of validationIds) {
          insertArtifacts(
            database,
            projectId,
            ticketId,
            {
              validationRunId: validationId,
            },
            artifacts,
            timestamp,
          );
        }

        database
          .prepare("update tickets set state = ?, latest_summary = ?, updated_at = ? where project_id = ? and id = ?")
          .run(nextState, ticketSummary, timestamp, projectId, ticketId);

        insertEvent(database, {
          projectId,
          ticketId,
          type: "validation.completed",
          summary: `${ticket.key} validation ${verdict}`,
          detail:
            summaryMd ||
            `${repoIds.length} repo target${repoIds.length === 1 ? "" : "s"} · ${commandList.length} command${commandList.length === 1 ? "" : "s"}`,
          ...transitionReason,
        });
      });

      if (verdict === "failed") {
        startAutoRoutedLaneExecution({
          store: getStore(),
          database,
          projectId,
          ticketId,
          reason: `${ticket.key} validation found rework; Floop routed the previous working lane with validation evidence.`,
        });
      }
      if (mergePolicyBlocks[0]?.code === "demo_evidence_required") {
        suggestDemoEvidenceDispatch({
          store: getStore(),
          database,
          projectId,
          ticketId,
          ticket,
          reason: `${ticket.key} needs validator demo evidence before merge.`,
        });
      }

      return commands.listValidations(projectId, ticketId);
    },
  };

  return commands;
}

function suggestDemoEvidenceDispatch({ store, database, projectId, ticketId, ticket, reason }) {
  const existing = database
    .prepare(
      `select id
       from agent_messages
       where project_id = ?
         and status = 'pending'
         and intent = 'suggest_dispatch'
         and json_extract(target_json, '$.ticketId') = ?
         and json_extract(metadata_json, '$.role') = 'validator'
         and json_extract(metadata_json, '$.reasonCode') = 'demo_evidence_required'
       order by created_at desc
       limit 1`,
    )
    .get(projectId, ticketId);
  if (existing) {
    return;
  }
  store.createAgentMessage(projectId, {
    actor: "floop",
    source: "merge_policy",
    intent: "suggest_dispatch",
    target: { ticketId },
    summary: `Collect demo evidence for ${ticket.key}`,
    body: reason,
    metadata: {
      role: "validator",
      reasonCode: "demo_evidence_required",
      artifactRequirement: {
        kind: "demo",
        metadata: { demoEvidence: true },
      },
    },
  });
}
