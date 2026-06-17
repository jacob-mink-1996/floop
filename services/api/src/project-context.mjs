export function buildProjectLookupContext(store, project, options = {}) {
  const projectId = project?.id || options.projectId || "";
  const tickets = projectId && store?.listTickets ? store.listTickets(projectId) : [];
  const repos = projectId && store?.listRepos ? store.listRepos(projectId) : [];
  const targetTicketId = options.ticket?.id || options.ticketId || "";
  return {
    generatedAt: new Date().toISOString(),
    project: summarizeProject(project),
    policy: { ...(project?.policy || {}) },
    repositories: repos.map(summarizeRepo),
    board: {
      ...(project?.board || {}),
      backlogCount: tickets.filter((ticket) => ["DRAFT", "PROPOSED", "READY"].includes(ticket.state)).length,
      activeCount: tickets.filter((ticket) => ["WORKING", "REVIEWING", "VALIDATING", "MERGING"].includes(ticket.state)).length,
    },
    tickets: {
      target: summarizeTicket(options.ticket || tickets.find((ticket) => ticket.id === targetTicketId)),
      backlog: tickets
        .filter((ticket) => ["DRAFT", "PROPOSED", "READY"].includes(ticket.state))
        .map(summarizeTicket),
      active: tickets
        .filter((ticket) => ["WORKING", "REVIEWING", "VALIDATING", "MERGING"].includes(ticket.state))
        .map(summarizeTicket),
      recentlyDone: tickets
        .filter((ticket) => ["READY_TO_MERGE", "DONE"].includes(ticket.state))
        .slice(-12)
        .map(summarizeTicket),
      blockedOrRework: tickets
        .filter((ticket) => ["BLOCKED", "REWORK"].includes(ticket.state))
        .map(summarizeTicket),
    },
    roleProfiles: (project?.roleProfiles || []).map((profile) => ({
      role: profile.role,
      adapter: profile.adapter,
      model: profile.model,
      configured: Boolean(profile.adapter && profile.adapter !== "mock"),
    })),
    lookupHints: [
      "Use tickets.backlog to detect duplicate, overlapping, obsolete, or unnecessary work before creating new tickets.",
      "Use repositories and ticket.repoTargets to resolve repo scope without relying on prompt text.",
      "Use policy to decide when HITL, review, validation, demo evidence, and merge approval are required.",
    ],
  };
}

function summarizeProject(project) {
  if (!project) {
    return null;
  }
  return {
    id: project.id,
    slug: project.slug,
    name: project.name,
    description: project.description,
    workspaceRoot: project.workspaceRoot,
    defaultBaseBranch: project.defaultBaseBranch,
    repoCount: project.repoCount,
    ticketCount: project.ticketCount,
  };
}

function summarizeRepo(repo) {
  return {
    id: repo.id,
    slug: repo.slug,
    name: repo.name,
    localPath: repo.localPath,
    defaultBranch: repo.defaultBranch,
    isPrimary: Boolean(repo.isPrimary),
  };
}

function summarizeTicket(ticket) {
  if (!ticket) {
    return null;
  }
  return {
    id: ticket.id,
    key: ticket.key,
    title: ticket.title,
    state: ticket.state,
    priority: ticket.priority,
    assignedRole: ticket.assignedRole,
    parentTicketId: ticket.parentTicketId,
    latestSummary: ticket.latestSummary,
    brief: ticket.brief,
    acceptanceCriteriaMd: ticket.acceptanceCriteriaMd,
    definitionOfDoneMd: ticket.definitionOfDoneMd,
    repoTargets: ticket.repoTargets || [],
    dependencyCount: ticket.dependencyCount || 0,
    activeExecutionCount: ticket.activeExecutionCount || 0,
  };
}
