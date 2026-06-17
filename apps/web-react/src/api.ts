import type {
  Artifact,
  AgentMessage,
  AgentMessageStatus,
  Board,
  CeremonyRun,
  CeremonyType,
  DirectoryCreateResult,
  DirectoryListing,
  EventRecord,
  Execution,
  MergeQueueItem,
  Project,
  ProjectCreateInput,
  ProjectPolicyInput,
  ProjectUpdateInput,
  Repo,
  RepoInput,
  RepoMetadata,
  RepoUpdateInput,
  RoleProfile,
  RoleName,
  RunObservability,
  TicketDetail,
  TicketState,
  Worktree,
} from "./types";

export class ApiError extends Error {
  status: number;
  payload: unknown;

  constructor(message: string, status: number, payload: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

async function fetchJson<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, options);
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "message" in payload
        ? String(payload.message)
        : `Request failed: ${response.status}`;
    throw new ApiError(message, response.status, payload);
  }
  return payload as T;
}

export async function listProjects(): Promise<Project[]> {
  const payload = await fetchJson<{ projects: Project[] }>("/api/v1/projects");
  return payload.projects;
}

export async function getProject(projectId: string): Promise<Project> {
  const payload = await fetchJson<{ project: Project }>(`/api/v1/projects/${projectId}`);
  return payload.project;
}

export async function createProject(input: ProjectCreateInput): Promise<Project> {
  const payload = await fetchJson<{ project: Project }>("/api/v1/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return payload.project;
}

export async function browseDirectories(path = ""): Promise<DirectoryListing> {
  const payload = await fetchJson<{ directory: DirectoryListing }>(
    `/api/v1/fs/directories?path=${encodeURIComponent(path)}`,
  );
  return payload.directory;
}

export async function createDirectory(path: string): Promise<DirectoryCreateResult> {
  const payload = await fetchJson<{ directory: DirectoryCreateResult }>("/api/v1/fs/directories", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
  });
  return payload.directory;
}

export async function detectRepo(localPath: string): Promise<RepoMetadata | null> {
  const payload = await fetchJson<{ repo: RepoMetadata | null }>("/api/v1/git/detect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ localPath }),
  });
  return payload.repo;
}

export async function inspectRepo(localPath: string): Promise<RepoMetadata> {
  const payload = await fetchJson<{ repo: RepoMetadata }>("/api/v1/git/inspect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ localPath }),
  });
  return payload.repo;
}

export async function cloneRepo(remoteUrl: string, destinationPath: string): Promise<RepoMetadata> {
  const payload = await fetchJson<{ repo: RepoMetadata }>("/api/v1/git/clone", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ remoteUrl, destinationPath }),
  });
  return payload.repo;
}

export async function getBoard(projectId: string): Promise<Board> {
  const payload = await fetchJson<{ board: Board }>(`/api/v1/projects/${projectId}/board`);
  return payload.board;
}

export async function getTicket(projectId: string, ticketId: string): Promise<TicketDetail> {
  const payload = await fetchJson<{ ticket: TicketDetail }>(
    `/api/v1/projects/${projectId}/tickets/${ticketId}`,
  );
  return payload.ticket;
}

export async function listRepos(projectId: string): Promise<Repo[]> {
  const payload = await fetchJson<{ repos: Repo[] }>(`/api/v1/projects/${projectId}/repos`);
  return payload.repos;
}

export async function listMergeQueue(projectId: string): Promise<MergeQueueItem[]> {
  const payload = await fetchJson<{ queue: MergeQueueItem[] }>(`/api/v1/projects/${projectId}/merge-queue`);
  return payload.queue;
}

export async function listCeremonies(projectId: string): Promise<CeremonyRun[]> {
  const payload = await fetchJson<{ ceremonies: CeremonyRun[] }>(`/api/v1/projects/${projectId}/ceremonies`);
  return payload.ceremonies;
}

export async function createCeremony(
  projectId: string,
  input: {
    type: CeremonyType;
    scope?: Record<string, unknown>;
    participantRoles?: RoleName[];
    deciderRole?: RoleName | "";
    consensusPolicy?: string;
  },
): Promise<CeremonyRun> {
  const payload = await fetchJson<{ ceremony: CeremonyRun }>(`/api/v1/projects/${projectId}/ceremonies`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return payload.ceremony;
}

export async function applyCeremony(
  projectId: string,
  runId: string,
  proposalIds: string[] = [],
): Promise<CeremonyRun> {
  const payload = await fetchJson<{ ceremony: CeremonyRun }>(`/api/v1/projects/${projectId}/ceremonies/${runId}/apply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ proposalIds }),
  });
  return payload.ceremony;
}

export async function listEvents(projectId: string, limit = 20): Promise<EventRecord[]> {
  const payload = await fetchJson<{ events: EventRecord[] }>(
    `/api/v1/projects/${projectId}/events?order=desc&limit=${limit}`,
  );
  return payload.events;
}

export async function listArtifacts(projectId: string, limit = 10): Promise<Artifact[]> {
  const payload = await fetchJson<{ artifacts: Artifact[] }>(
    `/api/v1/projects/${projectId}/artifacts?limit=${limit}`,
  );
  return payload.artifacts;
}

export async function getRunObservability(projectId: string, limit = 20): Promise<RunObservability> {
  const payload = await fetchJson<{ observability: RunObservability }>(
    `/api/v1/projects/${projectId}/runs?limit=${limit}`,
  );
  return payload.observability;
}

export async function listAgentMessages(projectId: string, limit = 20): Promise<AgentMessage[]> {
  const payload = await fetchJson<{ messages: AgentMessage[] }>(
    `/api/v1/projects/${projectId}/agent-messages?limit=${limit}`,
  );
  return payload.messages;
}

export async function updateAgentMessage(
  projectId: string,
  messageId: string,
  input: { status: AgentMessageStatus; promotedKind?: string; promotedRef?: string },
): Promise<AgentMessage> {
  const payload = await fetchJson<{ message: AgentMessage }>(
    `/api/v1/projects/${projectId}/agent-messages/${messageId}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  return payload.message;
}

export async function createTicketComment(
  projectId: string,
  input: { ticketId: string; body: string; actor?: string; source?: string; summary?: string; metadata?: Record<string, unknown> },
): Promise<AgentMessage> {
  const payload = await fetchJson<{ message: AgentMessage }>(
    `/api/v1/projects/${projectId}/agent-messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actor: input.actor || "operator",
        source: input.source || "human",
        intent: "comment_on_ticket",
        target: { ticketId: input.ticketId },
        summary: input.summary || "Ticket comment",
        body: input.body,
        metadata: { operatorComment: true, ...(input.metadata || {}) },
      }),
    },
  );
  return payload.message;
}

export async function respondAgentMessage(
  projectId: string,
  messageId: string,
  input: { responseMd: string; responderKind?: string; responderRef?: string; continueExecution?: boolean },
): Promise<AgentMessage> {
  const payload = await fetchJson<{ message: AgentMessage }>(
    `/api/v1/projects/${projectId}/agent-messages/${messageId}/respond`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  return payload.message;
}

export async function steerExecution(
  projectId: string,
  executionId: string,
  input: { body: string; mode?: "soft_steer" | "hard_steer"; actor?: string; source?: string },
): Promise<unknown> {
  const payload = await fetchJson<{ steering: unknown }>(
    `/api/v1/projects/${projectId}/executions/${executionId}/steer`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  return payload.steering;
}

export async function updateProject(projectId: string, input: ProjectUpdateInput): Promise<Project> {
  const payload = await fetchJson<{ project: Project }>(`/api/v1/projects/${projectId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return payload.project;
}

export async function deleteProject(projectId: string): Promise<Project> {
  const payload = await fetchJson<{ project: Project }>(`/api/v1/projects/${projectId}`, {
    method: "DELETE",
  });
  return payload.project;
}

export async function updateProjectPolicy(projectId: string, input: ProjectPolicyInput): Promise<Project["policy"]> {
  const payload = await fetchJson<{ policy: Project["policy"] }>(`/api/v1/projects/${projectId}/policy`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return payload.policy;
}

export async function createRepo(projectId: string, input: RepoInput): Promise<Repo> {
  const payload = await fetchJson<{ repo: Repo }>(`/api/v1/projects/${projectId}/repos`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return payload.repo;
}

export async function updateRepo(projectId: string, repoId: string, input: RepoUpdateInput): Promise<Repo> {
  const payload = await fetchJson<{ repo: Repo }>(`/api/v1/projects/${projectId}/repos/${repoId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return payload.repo;
}

export async function updateRoleProfile(
  projectId: string,
  role: RoleName,
  input: { adapter: string; model: string; config: Record<string, unknown> },
): Promise<RoleProfile> {
  const payload = await fetchJson<{ profile: RoleProfile }>(`/api/v1/projects/${projectId}/agent-profiles/${role}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return payload.profile;
}

export async function createTicket(
  projectId: string,
  input: {
    title: string;
    brief: string;
    priority: string;
    state: string;
    assignedRole: string;
    repoTargets: Array<{ repoId: string; baseRef: string }>;
  },
): Promise<TicketDetail> {
  const payload = await fetchJson<{ ticket: TicketDetail }>(`/api/v1/projects/${projectId}/tickets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return payload.ticket;
}

export async function updateTicket(
  projectId: string,
  ticketId: string,
  input: Partial<{
    title: string;
    brief: string;
    acceptanceCriteriaMd: string;
    definitionOfDoneMd: string;
    latestSummary: string;
    parentTicketId: string | null;
    priority: string;
    assignedRole: string;
    repoTargets: Array<{ repoId: string; baseRef: string; branchName?: string; targetScopeMd?: string }>;
  }>,
): Promise<TicketDetail> {
  const payload = await fetchJson<{ ticket: TicketDetail }>(`/api/v1/projects/${projectId}/tickets/${ticketId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return payload.ticket;
}

export async function addDependency(
  projectId: string,
  ticketId: string,
  input: { blockingTicketId: string; dependencyType?: string },
): Promise<TicketDetail> {
  const payload = await fetchJson<{ ticket: TicketDetail }>(
    `/api/v1/projects/${projectId}/tickets/${ticketId}/dependencies`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  return payload.ticket;
}

export async function removeDependency(projectId: string, ticketId: string, dependencyId: string): Promise<TicketDetail> {
  const payload = await fetchJson<{ ticket: TicketDetail }>(
    `/api/v1/projects/${projectId}/tickets/${ticketId}/dependencies/${dependencyId}`,
    { method: "DELETE" },
  );
  return payload.ticket;
}

export async function cleanWorktree(projectId: string, worktreeId: string): Promise<Worktree> {
  const payload = await fetchJson<{ worktree: Worktree }>(`/api/v1/projects/${projectId}/worktrees/${worktreeId}/clean`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason: "Marked cleaned from React operator UI" }),
  });
  return payload.worktree;
}

export async function transitionTicket(
  projectId: string,
  ticketId: string,
  input: { targetState: TicketState; reason: string; reasonCode: string },
): Promise<TicketDetail> {
  const payload = await fetchJson<{ ticket: TicketDetail }>(
    `/api/v1/projects/${projectId}/tickets/${ticketId}/transition`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  return payload.ticket;
}

export async function restartTicket(projectId: string, ticketId: string, input: { reason: string }): Promise<TicketDetail> {
  const payload = await fetchJson<{ ticket: TicketDetail }>(
    `/api/v1/projects/${projectId}/tickets/${ticketId}/restart`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  return payload.ticket;
}

export async function startExecution(
  projectId: string,
  ticketId: string,
  input: { role: RoleName; reason: string },
): Promise<Execution> {
  const payload = await fetchJson<{ execution: Execution }>(
    `/api/v1/projects/${projectId}/tickets/${ticketId}/executions`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  return payload.execution;
}

export async function completeExecution(
  projectId: string,
  executionId: string,
  input: { outcome: string; summaryMd: string; remainingWorkMd?: string; blockedKind?: string },
): Promise<Execution> {
  const payload = await fetchJson<{ execution: Execution }>(
    `/api/v1/projects/${projectId}/executions/${executionId}/complete`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  return payload.execution;
}

export async function cancelExecution(
  projectId: string,
  executionId: string,
  input: { reason: string },
): Promise<Execution> {
  const payload = await fetchJson<{ execution: Execution }>(
    `/api/v1/projects/${projectId}/executions/${executionId}/cancel`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  return payload.execution;
}

export async function createReview(
  projectId: string,
  ticketId: string,
  input: { executionId: string; verdict: string; summaryMd: string },
): Promise<unknown> {
  const payload = await fetchJson<unknown>(`/api/v1/projects/${projectId}/tickets/${ticketId}/reviews`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return payload;
}

export async function createValidation(
  projectId: string,
  ticketId: string,
  input: { executionId?: string; repoIds: string[]; verdict: string; commandProfile: string; commands: string[]; summaryMd: string },
): Promise<unknown> {
  const payload = await fetchJson<unknown>(`/api/v1/projects/${projectId}/tickets/${ticketId}/validations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return payload;
}

export async function mergeTicket(
  projectId: string,
  ticketId: string,
  input: { strategy: string; status: string; approvedByKind?: string; approvedByRef?: string; summaryMd: string },
): Promise<unknown> {
  const payload = await fetchJson<unknown>(`/api/v1/projects/${projectId}/tickets/${ticketId}/merge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return payload;
}
