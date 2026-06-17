import {
  parseAddDependencyInput,
  parseCreateTicketInput,
  parseTicketTransitionInput,
  parseUpdateTicketInput,
} from "../../../../packages/contracts/src/index.mjs";
import { defaultCeremonyAutomation } from "../../../../packages/config/src/index.mjs";
import { parseTicketFilters, RequestError, respondMaybe } from "./shared.mjs";

export function handleTicketRoute(route, url, body, store) {
  switch (route.name) {
    case "tickets":
      if (route.method === "GET") {
        return {
          status: 200,
          body: { tickets: store.listTickets(route.params.projectId, parseTicketFilters(url)) },
        };
      }
      return {
        status: 201,
        body: { ticket: store.createTicket(route.params.projectId, parseCreateTicketInput(body)) },
      };
    case "ticket":
      return respondMaybe(store.getTicket(route.params.projectId, route.params.ticketId), "ticket");
    case "ticketUpdate":
      return respondMaybe(
        store.updateTicket(route.params.projectId, route.params.ticketId, parseUpdateTicketInput(body)),
        "ticket",
      );
    case "ticketDependencies":
      {
        const input = parseAddDependencyInput(body);
        if (input.blockingTicketId === route.params.ticketId) {
          throw new RequestError(400, "A ticket cannot depend on itself");
        }
        return respondMaybe(
          store.addDependency(route.params.projectId, route.params.ticketId, input),
          "ticket",
        );
      }
    case "ticketDependency":
      return respondMaybe(
        store.removeDependency(
          route.params.projectId,
          route.params.ticketId,
          route.params.dependencyId,
        ),
        "ticket",
      );
    case "ticketTransition":
      return respondMaybe(
        store.transitionTicket(
          route.params.projectId,
          route.params.ticketId,
          parseTicketTransitionInput(body),
        ),
        "ticket",
      );
    case "ticketRestart":
      return respondMaybe(
        store.restartTicket(route.params.projectId, route.params.ticketId, body || {}),
        "ticket",
      );
    case "ticketProductAutopilot":
      return respondMaybe(
        startProductAutopilot(store, route.params.projectId, route.params.ticketId),
        "autopilot",
      );
    default:
      return null;
  }
}

function startProductAutopilot(store, projectId, ticketId) {
  const ticket = store.getTicket(projectId, ticketId);
  if (!ticket) {
    return null;
  }

  const project = store.getProjectSummary(projectId);
  if (!project) {
    return null;
  }

  const policy = store.updateProjectPolicy(projectId, productAutopilotPolicyPatch(project.policy));
  const ceremony = store.createCeremonyRun(projectId, {
    type: "work_generation",
    scope: {
      trigger: "product_autopilot_start",
      ideaTicketId: ticket.id,
      ideaTicketKey: ticket.key,
    },
    participantRoles: ["product_manager", "architect", "developer", "reviewer"],
    deciderRole: "product_manager",
    consensusPolicy: "decider_synthesizes_objections",
    createdByKind: "system",
    createdByRef: "product-autopilot",
  });
  if (!ceremony) {
    return null;
  }

  const proposalIds = ceremony.proposals
    .filter((proposal) => proposal.ticketId === ticket.id && proposal.kind === "ticket_create")
    .map((proposal) => proposal.id);
  const appliedCeremony = store.applyCeremonyRun(projectId, ceremony.id, { proposalIds });
  const breakdownTicketId =
    appliedCeremony?.proposals.find((proposal) => proposal.kind === "ticket_create" && proposal.appliedTicketId)
      ?.appliedTicketId || "";
  const breakdownTicket = breakdownTicketId
    ? store.getTicket(projectId, breakdownTicketId)
    : store.listTickets(projectId, { parentTicketId: ticket.id }).find((candidate) => /Break down/.test(candidate.title))
      || store.createTicket(projectId, productAutopilotBreakdownTicket(ticket));
  const breakdownDetail = breakdownTicket?.id ? store.getTicket(projectId, breakdownTicket.id) : null;
  const existingActive = breakdownDetail?.executions?.find((execution) => execution.status === "running");
  const execution =
    breakdownDetail && !existingActive
      ? store.createExecution(projectId, breakdownDetail.id, {
          role: "product_manager",
          reason: `Product Autopilot: break ${ticket.key} into executable feature tickets with validation and demo evidence.`,
        })
      : existingActive || null;
  const finalBreakdownTicket = breakdownDetail?.id ? store.getTicket(projectId, breakdownDetail.id) : null;

  return {
    policy,
    ceremony: appliedCeremony,
    ideaTicket: store.getTicket(projectId, ticket.id),
    breakdownTicket: finalBreakdownTicket,
    execution,
  };
}

function productAutopilotBreakdownTicket(ticket) {
  return {
    parentTicketId: ticket.id,
    title: `Break down ${ticket.key}: ${ticket.title}`,
    brief: `Turn the product idea into an executable plan.\n\nParent idea: ${ticket.title}\n\n${ticket.brief || ""}`.trim(),
    acceptanceCriteriaMd:
      "- Product boundaries and non-goals are captured\n- Child feature tickets are created with acceptance criteria and repo targets\n- Validation and demo evidence expectations are named for each feature\n- Open product questions are asked as HITL comments instead of guessed",
    definitionOfDoneMd:
      "- Feature tickets exist and are ready for planning\n- Architecture, implementation, review, validation, demo, and merge expectations are explicit\n- The parent idea can be tracked from plan through demo evidence",
    priority: ticket.priority || "high",
    state: "READY",
    assignedRole: "product_manager",
    repoTargets: ticket.repoTargets || [],
    latestSummary: "Product Autopilot created a product breakdown lane for autonomous planning.",
  };
}

function productAutopilotPolicyPatch(policy = {}) {
  return {
    requireReviewer: true,
    requireValidator: true,
    requireHumanApprovalBeforeMerge: false,
    requireDemoEvidenceBeforeMerge: true,
    maxParallelExecutions: Math.max(2, Number(policy.maxParallelExecutions || 1)),
    maxParallelMerges: Math.max(1, Number(policy.maxParallelMerges || 1)),
    maxAutoContinueIterations: Math.max(5, Number(policy.maxAutoContinueIterations || 1)),
    interactionMode: "fully_autonomous",
    refinementMode: "autonomous",
    agentCreatedTicketDefaultState: "READY",
    ceremonyAutomation: productAutopilotCeremonyAutomation(policy.ceremonyAutomation),
  };
}

function productAutopilotCeremonyAutomation(existing = {}) {
  const defaults = defaultCeremonyAutomation();
  const triggers = existing.triggers || {};
  return {
    ...defaults,
    ...existing,
    enabled: true,
    mode: "fully_automatic",
    triggers: {
      ...defaults.triggers,
      ...triggers,
      refinement: { ...defaults.triggers.refinement, ...(triggers.refinement || {}), enabled: true, minIntervalMinutes: 10 },
      planning: { ...defaults.triggers.planning, ...(triggers.planning || {}), enabled: true, minIntervalMinutes: 15 },
      daily_triage: {
        ...defaults.triggers.daily_triage,
        ...(triggers.daily_triage || {}),
        enabled: true,
        onActiveWorkCheckIn: true,
        onStaleActiveWorkHours: 2,
        minIntervalMinutes: 30,
      },
      review_demo_prep: { ...defaults.triggers.review_demo_prep, ...(triggers.review_demo_prep || {}), enabled: true, minIntervalMinutes: 30 },
      work_generation: {
        ...defaults.triggers.work_generation,
        ...(triggers.work_generation || {}),
        enabled: true,
        onSprintEndPlanning: true,
        onReadyBacklogBelow: 2,
        minIntervalMinutes: 60,
      },
      retro: { ...defaults.triggers.retro, ...(triggers.retro || {}), enabled: true, minIntervalMinutes: 180 },
    },
  };
}
