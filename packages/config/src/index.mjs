import { roleNames } from "../../domain/src/index.mjs";

export function defaultProjectPolicy() {
  return {
    requireReviewer: true,
    requireValidator: true,
    requireHumanApprovalBeforeMerge: true,
    requireDemoEvidenceBeforeMerge: true,
    requiredValidationCommandProfileForMerge: "",
    maxParallelExecutions: 3,
    maxParallelMerges: 1,
    maxAutoContinueIterations: 5,
    interactionMode: "manual",
    refinementMode: "user_approved",
    steeringWorktreePolicy: "new_iteration_worktree",
    agentCreatedTicketDefaultState: "PROPOSED",
    ceremonyAutomation: defaultCeremonyAutomation(),
  };
}

export function defaultCeremonyAutomation() {
  return {
    enabled: false,
    mode: "operator_approved",
    triggers: {
      refinement: {
        enabled: true,
        onTicketCreatedStates: ["DRAFT", "PROPOSED"],
        onBacklogChange: true,
        minIntervalMinutes: 10,
        participantRoles: ["product_manager", "architect", "developer", "reviewer"],
        deciderRole: "product_manager",
        consensusPolicy: "decider_synthesizes_objections",
      },
      planning: {
        enabled: true,
        onReadyQueueChanged: true,
        onCapacityAvailable: true,
        minIntervalMinutes: 15,
        participantRoles: ["product_manager", "architect", "developer", "integrator"],
        deciderRole: "integrator",
        consensusPolicy: "decider_synthesizes_objections",
      },
      daily_triage: {
        enabled: true,
        onActiveWorkCheckIn: true,
        onStaleActiveWorkHours: 2,
        onBlockedOrRework: true,
        minIntervalMinutes: 30,
        participantRoles: ["product_manager", "developer", "reviewer", "validator"],
        deciderRole: "product_manager",
        consensusPolicy: "blockers_and_stale_work_win",
      },
      review_demo_prep: {
        enabled: true,
        onDoneOrMergeReady: true,
        minIntervalMinutes: 30,
        participantRoles: ["product_manager", "reviewer", "validator", "integrator"],
        deciderRole: "reviewer",
        consensusPolicy: "only_evidence_backed_done_work_is_demoable",
      },
      retro: {
        enabled: true,
        onRepeatedBlockedOrReworkCount: 3,
        onCycleComplete: true,
        minIntervalMinutes: 180,
        participantRoles: ["product_manager", "architect", "developer", "reviewer", "validator"],
        deciderRole: "product_manager",
        consensusPolicy: "recurring_systemic_risk_wins",
      },
    },
  };
}

export function defaultRoleProfiles() {
  return roleNames.map((role) => ({
    role,
    adapter: role === "reviewer" || role === "validator" ? "opencode" : "codex",
    model: "default",
  }));
}
