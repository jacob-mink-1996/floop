export function buildProjectLookupContext(store, project, options = {}) {
  const projectId = project?.id || options.projectId || "";
  const tickets = projectId && store?.listTickets ? store.listTickets(projectId) : [];
  const repos = projectId && store?.listRepos ? store.listRepos(projectId) : [];
  const events = projectId && store?.listEvents ? store.listEvents(projectId, { order: "desc", limit: 24 }) || [] : [];
  const artifacts = projectId && store?.listArtifacts ? store.listArtifacts(projectId, { limit: 24 }) || [] : [];
  const agentMessages = projectId && store?.listAgentMessages ? store.listAgentMessages(projectId, { limit: 100 }) || [] : [];
  const targetTicketId = options.ticket?.id || options.ticketId || "";
  const targetTicket = options.ticket || tickets.find((ticket) => ticket.id === targetTicketId);
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
      target: summarizeTicket(targetTicket),
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
    evidence: {
      recentArtifacts: artifacts.map(summarizeArtifact),
      targetArtifacts: targetTicket
        ? artifacts.filter((artifact) => artifact.ticketId === targetTicket.id).map(summarizeArtifact)
        : [],
    },
    activity: {
      recentEvents: events.map(summarizeEvent),
      targetEvents: targetTicket
        ? events.filter((event) => event.ticketId === targetTicket.id).map(summarizeEvent)
        : [],
    },
    conversation: {
      pendingQuestions: agentMessages
        .filter((message) => message.status === "pending")
        .filter((message) => message.intent === "request_input" || message.intent === "submit_ceremony_input")
        .map(summarizeAgentMessage),
      targetMessages: targetTicket
        ? agentMessages
            .filter((message) => message.target?.ticketId === targetTicket.id)
            .map(summarizeAgentMessage)
        : [],
      recentComments: agentMessages
        .filter((message) => message.intent === "comment_on_ticket")
        .slice(0, 24)
        .map(summarizeAgentMessage),
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
      "Use evidence artifact ids and URIs as lookup handles for full validation, demo, log, and merge proof.",
      "Use activity events and conversation messages to preserve HITL answers, steering, and prior decisions across phases.",
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

function summarizeArtifact(artifact) {
  return {
    id: artifact.id,
    ticketId: artifact.ticketId || "",
    executionId: artifact.executionId || "",
    kind: artifact.kind,
    label: artifact.label,
    uri: artifact.uri,
    createdAt: artifact.createdAt,
  };
}

function summarizeEvent(event) {
  return {
    id: event.id,
    ticketId: event.ticketId || "",
    repoId: event.repoId || "",
    type: event.type,
    summary: event.summary,
    reasonCode: event.reasonCode || "",
    reasonSource: event.reasonSource || "",
    createdAt: event.createdAt,
  };
}

function summarizeAgentMessage(message) {
  return {
    id: message.id,
    actor: message.actor,
    source: message.source,
    intent: message.intent,
    status: message.status,
    target: message.target || {},
    summary: message.summary,
    bodyPreview: preview(message.body),
    promotedKind: message.promotedKind,
    promotedRef: message.promotedRef,
    metadata: {
      requestInputMessageId: message.metadata?.requestInputMessageId || "",
      responseToMessageId: message.metadata?.responseToMessageId || "",
      deliveryStatus: message.metadata?.deliveryStatus || "",
      hitlQuestion: message.metadata?.hitlQuestion === true || message.metadata?.ceremonyHitlQuestion === true,
      unblockResponse: message.metadata?.unblockResponse === true,
      steeringNote: message.metadata?.steeringNote === true,
      ceremonyResponse: message.metadata?.ceremonyResponse === true,
    },
    createdAt: message.createdAt,
  };
}

function preview(value, limit = 240) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit - 1)}…`;
}
