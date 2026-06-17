export type TicketState =
  | "DRAFT"
  | "PROPOSED"
  | "READY"
  | "WORKING"
  | "REVIEWING"
  | "VALIDATING"
  | "REWORK"
  | "BLOCKED"
  | "READY_TO_MERGE"
  | "MERGING"
  | "DONE"
  | "CANCELLED";

export type TicketPriority = "low" | "medium" | "high" | "urgent";

export type RefinementMode = "autonomous" | "user_approved" | "user_participant" | "user_only";
export type SteeringWorktreePolicy = "new_iteration_worktree" | "reuse_interrupted_worktree" | "copy_interrupted_worktree";
export type InteractionMode = "manual" | "operator_approved" | "autonomous_with_review" | "autopilot" | "fully_autonomous";
export type CeremonyType = "refinement" | "planning" | "daily_triage" | "review_demo_prep" | "work_generation" | "retro";
export type AgentMessageIntent =
  | "suggest_ticket"
  | "comment_on_ticket"
  | "suggest_dispatch"
  | "submit_ceremony_input"
  | "raise_risk"
  | "submit_artifact"
  | "request_input"
  | "request_status";
export type AgentMessageStatus = "pending" | "accepted" | "dismissed" | "converted" | "attached";

export type RoleName =
  | "product_manager"
  | "architect"
  | "developer"
  | "reviewer"
  | "validator"
  | "integrator";

export type Project = {
  id: string;
  slug: string;
  name: string;
  description: string;
  workspaceRoot: string;
  defaultBaseBranch: string;
  repoCount: number;
  ticketCount: number;
  board: Record<string, number>;
  policy?: ProjectPolicy;
  roleProfiles?: RoleProfile[];
};

export type ProjectPolicy = {
  requireReviewer: boolean;
  requireValidator: boolean;
  requireHumanApprovalBeforeMerge: boolean;
  requireDemoEvidenceBeforeMerge: boolean;
  requiredValidationCommandProfileForMerge: string;
  maxParallelExecutions: number;
  maxParallelMerges: number;
  maxAutoContinueIterations: number;
  interactionMode: InteractionMode;
  refinementMode: RefinementMode;
  steeringWorktreePolicy: SteeringWorktreePolicy;
  agentCreatedTicketDefaultState: TicketState;
  ceremonyAutomation: CeremonyAutomation;
};

export type CeremonyAutomation = {
  enabled: boolean;
  mode: string;
  triggers: Record<string, CeremonyAutomationTrigger>;
};

export type CeremonyAutomationTrigger = {
  enabled: boolean;
  minIntervalMinutes?: number;
  participantRoles?: RoleName[];
  deciderRole?: RoleName;
  consensusPolicy?: string;
  [key: string]: unknown;
};

export type RoleProfile = {
  role: RoleName;
  adapter: string;
  model: string;
  config?: Record<string, unknown>;
};

export type ProjectUpdateInput = {
  name: string;
  description: string;
  workspaceRoot: string;
  defaultBaseBranch: string;
};

export type ProjectCreateInput = ProjectUpdateInput & {
  slug: string;
};

export type ProjectPolicyInput = {
  requireReviewer: boolean;
  requireValidator: boolean;
  requireHumanApprovalBeforeMerge: boolean;
  requireDemoEvidenceBeforeMerge: boolean;
  requiredValidationCommandProfileForMerge: string;
  maxParallelExecutions: number;
  maxParallelMerges: number;
  maxAutoContinueIterations: number;
  interactionMode: InteractionMode;
  refinementMode: RefinementMode;
  steeringWorktreePolicy: SteeringWorktreePolicy;
  agentCreatedTicketDefaultState: TicketState;
  ceremonyAutomation?: CeremonyAutomation;
};

export type AgentMessage = {
  id: string;
  projectId: string;
  actor: string;
  source: string;
  intent: AgentMessageIntent;
  target: Record<string, unknown>;
  summary: string;
  body: string;
  metadata: Record<string, unknown>;
  status: AgentMessageStatus;
  promotedKind: string;
  promotedRef: string;
  createdAt: string;
  updatedAt: string;
  dismissedAt: string;
};

export type BoardTicket = {
  id: string;
  projectId: string;
  parentTicketId: string;
  key: string;
  title: string;
  brief: string;
  state: TicketState;
  priority: TicketPriority;
  assignedRole: RoleName;
  latestSummary: string;
  latestReviewVerdict: string;
  latestValidationVerdict: string;
  activeExecutionCount: number;
  activeExecutionRole: string;
  activeExecutionClaimed: boolean;
  pendingAgentMessageCount: number;
  latestValidationHasDemoEvidence: boolean;
  mergeReadiness: string;
  mergeStatusSummary: string;
  mergeBlockingReasonCode: string;
  repoCount: number;
  dependencyCount: number;
  eventCount: number;
  createdAt: string;
  updatedAt: string;
};

export type BoardColumn = {
  state: TicketState;
  label: string;
  count: number;
  tickets: BoardTicket[];
};

export type Board = {
  projectId: string;
  projectName: string;
  columns: BoardColumn[];
  totalTickets: number;
  generatedAt: string;
};

export type RepoTarget = {
  id: string;
  repoId: string;
  repoSlug: string;
  repoName: string;
  repoLocalPath: string;
  repoDefaultBranch: string;
  baseRef: string;
  branchName: string;
  targetScopeMd: string;
};

export type Execution = {
  id: string;
  projectId: string;
  ticketId: string;
  ticketKey: string;
  ticketTitle: string;
  ticketState: string;
  agentProfileId: string;
  role: RoleName;
  iteration: number;
  status: string;
  outcome: string;
  summaryMd: string;
  remainingWorkMd: string;
  expectedNextEvidenceMd?: string;
  failureKind?: string;
  blockedKind?: string;
  claimed?: boolean;
  claimExpiresAt?: string;
  harnessKind?: string;
  externalThreadId?: string;
  externalSessionId?: string;
  externalConversationId?: string;
  harnessCapabilities?: string[];
  resumedFromExecutionId?: string;
  steeringMetadata?: Record<string, unknown>;
  startedAt: string;
  finishedAt: string;
  artifacts?: Artifact[];
  worktrees?: Worktree[];
};

export type Review = {
  id: string;
  verdict: string;
  summaryMd: string;
  findingsCount: number;
  createdAt: string;
};

export type ValidationRun = {
  id: string;
  repoSlug: string;
  verdict: string;
  commandProfile: string;
  summaryMd: string;
  finishedAt: string;
};

export type EventRecord = {
  id: string;
  type: string;
  lane: string;
  summary: string;
  detail: string;
  createdAt: string;
};

export type TicketDependency = {
  id: string;
  blockedTicketId: string;
  blockingTicketId: string;
  blockingTicketKey: string;
  blockingTicketTitle: string;
  blockingTicketState: TicketState;
  dependencyType: string;
  createdAt: string;
};

export type Worktree = {
  id: string;
  projectId: string;
  repoId: string;
  ticketId: string;
  executionId: string;
  resumedFromWorktreeId?: string;
  lineageId?: string;
  repoSlug: string;
  repoName: string;
  executionRole: RoleName;
  executionIteration: number;
  path: string;
  branchName: string;
  baseRef: string;
  status: string;
  isDirty: boolean;
  updatedAt: string;
  cleanedAt: string | null;
};

export type Artifact = {
  id: string;
  kind: string;
  label: string;
  uri: string;
  createdAt: string;
};

export type RunObservabilityItem = {
  id: string;
  runId: string;
  kind: "execution" | "merge" | "ceremony";
  status: string;
  outcome: string;
  label: string;
  summary: string;
  ticketId: string;
  ticketKey: string;
  ticketTitle: string;
  role: string;
  failureKind: string;
  claimStatus: string;
  claimExpiresAt: string;
  retryAttemptCount: number;
  workLogArtifactUri: string;
  agentTraceSummary: string;
  agentProgressSignalCount: number;
  agentQuestionSignalCount: number;
  stdoutArtifactUri: string;
  stderrArtifactUri: string;
  worktreePaths: string[];
  movementReason: {
    eventId: string;
    type: string;
    summary: string;
    detail: string;
    reasonCode: string;
    reasonSource: string;
    createdAt: string;
  } | null;
  startedAt: string;
  finishedAt: string;
  artifactCount: number;
  worktreeCount: number;
  needsAttention: boolean;
  liveAgentLog?: {
    available: boolean;
    stdoutTail: string;
    stderrTail: string;
    agentEventsUri: string;
    stdoutUri: string;
    stderrUri: string;
    recentEvents: unknown[];
    milestones: Array<{
      id: string;
      kind: string;
      label: string;
      text: string;
      stream: string;
    }>;
    progressSignalCount: number;
    questionSignalCount: number;
    updatedAt: string;
  };
  pendingProposalCount?: number;
  participantCount?: number;
};

export type RunObservability = {
  generatedAt: string;
  summary: {
    total: number;
    running: number;
    needsAttention: number;
    failed: number;
  };
  runs: RunObservabilityItem[];
};

export type MergeStatus = {
  readiness: string;
  canMerge: boolean;
  requiresHumanApproval: boolean;
  statusSummary?: string;
  blockingReasons: Array<{ code: string; source?: string; message?: string; summary?: string; detail?: string }>;
  latestRun?: {
    status: string;
    strategy: string;
    summaryMd: string;
    startedAt: string;
    finishedAt: string;
  };
};

export type CeremonyProposal = {
  id: string;
  projectId: string;
  runId: string;
  kind: string;
  status: string;
  summary: string;
  ticketId: string;
  ticketKey: string;
  ticketTitle: string;
  payload: Record<string, unknown>;
  appliedTicketId: string;
  appliedAt: string;
  createdAt: string;
};

export type CeremonyParticipant = {
  id: string;
  projectId: string;
  runId: string;
  role: RoleName;
  status: string;
  outcome: string;
  summaryMd: string;
  questionsMd: string;
  riskMd: string;
  payload: Record<string, unknown>;
  startedAt: string;
  finishedAt: string;
  createdAt: string;
  updatedAt: string;
};

export type CeremonyRun = {
  id: string;
  projectId: string;
  type: CeremonyType;
  status: string;
  scope: Record<string, unknown>;
  participantRoles: RoleName[];
  deciderRole: RoleName | "";
  consensusPolicy: string;
  inputSnapshot: Record<string, unknown>;
  summaryMd: string;
  questionsMd: string;
  riskMd: string;
  createdByKind: string;
  createdByRef: string;
  startedAt: string;
  finishedAt: string;
  appliedAt: string;
  updatedAt: string;
  proposals: CeremonyProposal[];
  participants: CeremonyParticipant[];
};

export type TicketDetail = BoardTicket & {
  acceptanceCriteriaMd: string;
  definitionOfDoneMd: string;
  repoTargets: RepoTarget[];
  executions: Execution[];
  reviews: Review[];
  validations: ValidationRun[];
  dependencies: TicketDependency[];
  worktrees: Worktree[];
  events: EventRecord[];
  artifacts: Artifact[];
  mergeStatus: MergeStatus;
};

export type Repo = {
  id: string;
  projectId: string;
  slug: string;
  name: string;
  localPath: string;
  remoteUrl: string;
  defaultBranch: string;
  isPrimary: boolean;
};

export type RepoInput = {
  name: string;
  slug: string;
  localPath: string;
  remoteUrl: string;
  defaultBranch: string;
  isPrimary: boolean;
};

export type DirectoryListing = {
  path: string;
  parentPath: string;
  entries: Array<{ name: string; path: string; hidden: boolean }>;
};

export type DirectoryCreateResult = {
  path: string;
};

export type RepoMetadata = RepoInput;

export type RepoUpdateInput = Partial<Omit<RepoInput, "slug">>;

export type MergeQueueItem = BoardTicket & {
  mergeStatus: MergeStatus | null;
};
