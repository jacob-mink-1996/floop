import React, { FormEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import * as Dialog from "@radix-ui/react-dialog";
import * as Tabs from "@radix-ui/react-tabs";
import * as Tooltip from "@radix-ui/react-tooltip";
import { DndContext, PointerSensor, pointerWithin, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent, type DragMoveEvent } from "@dnd-kit/core";
import { Check, ChevronLeft, ChevronRight, FileText, Menu, Moon, Pencil, Plus, RefreshCw, SlidersHorizontal, Sparkles, Square, Sun, X } from "lucide-react";
import {
  ApiError,
  applyCeremony,
  cancelExecution,
  completeExecution,
  addDependency,
  cleanWorktree,
  createCeremony,
  createProject,
  createRepo,
  createTicketComment,
  createReview,
  createTicket,
  createValidation,
  deleteProject,
  getBoard,
  getProject,
  getRunObservability,
  getTicket,
  listAgentMessages,
  listArtifacts,
  listCeremonies,
  listEvents,
  listMergeQueue,
  listProjects,
  listRepos,
  mergeTicket,
  removeDependency,
  restartTicket,
  respondAgentMessage,
  startExecution,
  startProductAutopilot,
  steerExecution,
  transitionTicket,
  updateAgentMessage,
  updateTicket,
} from "./api";
import {
  formatDate,
  groupBoardColumns,
  nextActionForTicket,
  prettyRole,
  prettyState,
  priorities,
  roles,
  ticketStates,
} from "./domain";
import type {
  Artifact,
  AgentMessage,
  Board,
  BoardTicket,
  CeremonyProposal,
  CeremonyRun,
  CeremonyType,
  EventRecord,
  MergeQueueItem,
  Project,
  ProjectCreateInput,
  Repo,
  RepoInput,
  RoleName,
  RunObservability,
  TicketDetail,
  TicketState,
} from "./types";
import { ProjectEmptyState, ProjectOnboardingDialog } from "./ProjectOnboarding";
import { SettingsDrawer } from "./ProjectSettings";
import {
  ActionDock,
  ChecklistRail,
  EvidenceRail,
  LogChip,
  PhaseRail,
  StateDot,
  StatusMeter,
  toneForStatus,
  type ChecklistItem,
  type EvidenceItem as VisualEvidenceItem,
  type PhaseItem,
  type Tone,
} from "./OperationalVisuals";
import "./styles.css";

type LoadState = "idle" | "loading" | "ready" | "error";
type ThemeMode = "light" | "dark";
type WorkspaceView = "board" | "ceremonies" | "ops";
type AttentionKind = "approval" | "blocked" | "validation" | "stale" | "merge" | "ceremony" | "external_agent";

type AttentionItem = {
  id: string;
  kind: AttentionKind;
  label: string;
  title: string;
  detail: string;
  age: string;
  severity: number;
  actionLabel: string;
  meta?: string[];
  ticketId?: string;
  ceremonyRunId?: string;
  proposalIds?: string[];
  agentMessage?: AgentMessage;
};

function initialThemeMode(): ThemeMode {
  const storedTheme = window.localStorage.getItem("floop-theme");
  return storedTheme === "dark" || storedTheme === "light" ? storedTheme : "light";
}

function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [project, setProject] = useState<Project | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [mergeQueue, setMergeQueue] = useState<MergeQueueItem[]>([]);
  const [ceremonies, setCeremonies] = useState<CeremonyRun[]>([]);
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [agentMessages, setAgentMessages] = useState<AgentMessage[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [runObservability, setRunObservability] = useState<RunObservability | null>(null);
  const [selectedTicketId, setSelectedTicketId] = useState("");
  const [ticket, setTicket] = useState<TicketDetail | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [message, setMessage] = useState("");
  const [isRailOpen, setRailOpen] = useState(false);
  const [isRailCollapsed, setRailCollapsed] = useState(false);
  const [isDetailOpen, setDetailOpen] = useState(false);
  const [isComposerOpen, setComposerOpen] = useState(false);
  const [isSettingsOpen, setSettingsOpen] = useState(false);
  const [isProjectOnboardingOpen, setProjectOnboardingOpen] = useState(false);
  const [activeView, setActiveView] = useState<WorkspaceView>("ops");
  const [liveStatus, setLiveStatus] = useState("idle");
  const [themeMode, setThemeMode] = useState<ThemeMode>(initialThemeMode);

  useEffect(() => {
    document.documentElement.dataset.theme = themeMode;
    window.localStorage.setItem("floop-theme", themeMode);
  }, [themeMode]);

  useEffect(() => {
    let cancelled = false;
    setLoadState("loading");
    listProjects()
      .then((items) => {
        if (cancelled) return;
        setProjects(items);
        const hashProject = window.location.hash.slice(1);
        const initial = items.find((item) => item.id === hashProject)?.id || items[0]?.id || "";
        setProjectId(initial);
        setLoadState("ready");
      })
      .catch((error) => {
        if (cancelled) return;
        setLoadState("error");
        setMessage(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    setLoadState("loading");
    setMessage("");
    setSelectedTicketId("");
    setTicket(null);
    setDetailOpen(false);
    Promise.all([
      getProject(projectId),
      getBoard(projectId),
      listRepos(projectId),
      listMergeQueue(projectId),
      listCeremonies(projectId),
      listEvents(projectId),
      listAgentMessages(projectId),
      listArtifacts(projectId),
      getRunObservability(projectId),
    ])
      .then(([nextProject, nextBoard, nextRepos, nextMergeQueue, nextCeremonies, nextEvents, nextAgentMessages, nextArtifacts, nextRunObservability]) => {
        if (cancelled) return;
        setProject(nextProject);
        setBoard(nextBoard);
        setRepos(nextRepos);
        setMergeQueue(nextMergeQueue);
        setCeremonies(nextCeremonies);
        setEvents(nextEvents);
        setAgentMessages(nextAgentMessages);
        setArtifacts(nextArtifacts);
        setRunObservability(nextRunObservability);
        setLoadState("ready");
        setMessage("");
        window.history.replaceState(null, "", `#${projectId}`);
        const firstTicket = nextBoard.columns.flatMap((column) => column.tickets)[0];
        setSelectedTicketId((existing) =>
          existing && nextBoard.columns.some((column) => column.tickets.some((item) => item.id === existing))
            ? existing
            : firstTicket?.id || "",
        );
      })
      .catch((error) => {
        if (cancelled) return;
        setLoadState("error");
        setMessage(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    if (!projectId || typeof window.EventSource !== "function") {
      setLiveStatus(projectId ? "manual" : "idle");
      return;
    }

    let refreshTimer = 0;
    const source = new EventSource(`/api/v1/projects/${projectId}/events/stream?limit=20`);
    setLiveStatus("connecting");
    source.addEventListener("open", () => setLiveStatus("live"));
    const scheduleRefresh = () => {
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        refresh().catch((error) => setMessage(error instanceof Error ? error.message : String(error)));
      }, 180);
    };
    source.addEventListener("event", scheduleRefresh);
    source.addEventListener("snapshot", scheduleRefresh);
    source.addEventListener("error", () => setLiveStatus("reconnecting"));

    return () => {
      window.clearTimeout(refreshTimer);
      source.close();
    };
  }, [projectId, selectedTicketId]);

  useEffect(() => {
    if (!projectId || !selectedTicketId) {
      setTicket(null);
      setDetailOpen(false);
      return;
    }
    let cancelled = false;
    getTicket(projectId, selectedTicketId)
      .then((detail) => {
        if (cancelled) return;
        setTicket(detail);
        setMessage("");
      })
      .catch((error) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 404) {
          setSelectedTicketId("");
          setTicket(null);
          setDetailOpen(false);
          return;
        }
        setMessage(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, selectedTicketId]);

  const selectedTicketSummary = useMemo(() => {
    if (!board || !selectedTicketId) return null;
    return board.columns.flatMap((column) => column.tickets).find((item) => item.id === selectedTicketId) || null;
  }, [board, selectedTicketId]);
  const dragSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const selectTicket = (ticketId: string) => {
    flushSync(() => {
      setSelectedTicketId(ticketId);
      setDetailOpen(true);
    });
  };

  const refresh = async () => {
    if (!projectId) return;
    const [nextProject, nextBoard, nextRepos, nextMergeQueue, nextCeremonies, nextEvents, nextAgentMessages, nextArtifacts, nextRunObservability] = await Promise.all([
      getProject(projectId),
      getBoard(projectId),
      listRepos(projectId),
      listMergeQueue(projectId),
      listCeremonies(projectId),
      listEvents(projectId),
      listAgentMessages(projectId),
      listArtifacts(projectId),
      getRunObservability(projectId),
    ]);
    setProject(nextProject);
    setBoard(nextBoard);
    setRepos(nextRepos);
    setMergeQueue(nextMergeQueue);
    setCeremonies(nextCeremonies);
    setEvents(nextEvents);
    setAgentMessages(nextAgentMessages);
    setArtifacts(nextArtifacts);
    setRunObservability(nextRunObservability);
    setMessage("");
    if (selectedTicketId && nextBoard.columns.some((column) => column.tickets.some((item) => item.id === selectedTicketId))) {
      setTicket(await getTicket(projectId, selectedTicketId));
    } else {
      setSelectedTicketId("");
      setTicket(null);
      setDetailOpen(false);
    }
  };

  const refreshTicket = async (ticketId = selectedTicketId) => {
    if (!projectId || !ticketId) return;
    const [nextProject, nextBoard, nextTicket] = await Promise.all([
      getProject(projectId),
      getBoard(projectId),
      getTicket(projectId, ticketId),
    ]);
    setProject(nextProject);
    setBoard(nextBoard);
    setTicket(nextTicket);
    setSelectedTicketId(ticketId);
  };

  const handleTicketDrop = async (ticketId: string, targetState: TicketState) => {
    if (!projectId || !board) return;
    const ticketSummary = board.columns.flatMap((column) => column.tickets).find((item) => item.id === ticketId);
    if (!ticketSummary || ticketSummary.state === targetState) return;
    setMessage("");
    try {
      await transitionTicket(projectId, ticketId, {
        targetState,
        reason: `Moved ${ticketSummary.key} to ${prettyState(targetState)} from the board.`,
        reasonCode: "operator_board_move",
      });
      await refreshTicket(ticketId);
    } catch (dropError) {
      setMessage(dropError instanceof Error ? dropError.message : String(dropError));
    }
  };

  const handleCreateTicket = async (input: {
    title: string;
    brief: string;
    priority: string;
    state: string;
    assignedRole: string;
    repoId: string;
  }) => {
    if (!projectId) return;
    const repo = repos.find((candidate) => candidate.id === input.repoId) || repos[0];
    const created = await createTicket(projectId, {
      title: input.title,
      brief: input.brief,
      priority: input.priority,
      state: input.state,
      assignedRole: input.assignedRole,
      repoTargets: repo ? [{ repoId: repo.id, baseRef: repo.defaultBranch }] : [],
    });
    setSelectedTicketId(created.id);
    setTicket(created);
    await refreshTicket(created.id);
    await Promise.all([
      listMergeQueue(projectId).then(setMergeQueue),
      listCeremonies(projectId).then(setCeremonies),
      listEvents(projectId).then(setEvents),
      listAgentMessages(projectId).then(setAgentMessages),
      listArtifacts(projectId).then(setArtifacts),
      getRunObservability(projectId).then(setRunObservability),
    ]);
    setComposerOpen(false);
    setDetailOpen(true);
  };

  const handleRunCeremony = async (
    type: CeremonyType,
    input: { participantRoles?: RoleName[]; deciderRole?: RoleName | ""; consensusPolicy?: string } = {},
  ) => {
    if (!projectId) return;
    setMessage("");
    try {
      await createCeremony(projectId, { type, ...input });
      const [nextCeremonies, nextEvents, nextRunObservability] = await Promise.all([
        listCeremonies(projectId),
        listEvents(projectId),
        getRunObservability(projectId),
      ]);
      setCeremonies(nextCeremonies);
      setEvents(nextEvents);
      setRunObservability(nextRunObservability);
    } catch (ceremonyError) {
      setMessage(ceremonyError instanceof Error ? ceremonyError.message : String(ceremonyError));
    }
  };

  const handleApplyCeremony = async (runId: string, proposalIds: string[] = []) => {
    if (!projectId) return;
    setMessage("");
    try {
      await applyCeremony(projectId, runId, proposalIds);
      await refresh();
    } catch (ceremonyError) {
      setMessage(ceremonyError instanceof Error ? ceremonyError.message : String(ceremonyError));
    }
  };

  const handleCreateProject = async (input: { project: ProjectCreateInput; repo: RepoInput | null }) => {
    setMessage("");
    const created = await createProject(input.project);
    if (input.repo) {
      await createRepo(created.id, input.repo);
    }
    const nextProjects = await listProjects();
    setProjects(nextProjects);
    setProjectId(created.id);
    setSelectedTicketId("");
    setTicket(null);
    setProjectOnboardingOpen(false);
    setRailOpen(false);
  };

  const handleDeleteProject = async () => {
    if (!projectId) return;
    const deletedProjectId = projectId;
    setMessage("");
    await deleteProject(deletedProjectId);
    const nextProjects = await listProjects();
    const nextProjectId = nextProjects.find((candidate) => candidate.id !== deletedProjectId)?.id || "";
    setProjects(nextProjects);
    setProjectId(nextProjectId);
    setProject(null);
    setBoard(null);
    setRepos([]);
    setMergeQueue([]);
    setCeremonies([]);
    setEvents([]);
    setAgentMessages([]);
    setArtifacts([]);
    setRunObservability(null);
    setSelectedTicketId("");
    setTicket(null);
    setDetailOpen(false);
    setComposerOpen(false);
    setSettingsOpen(false);
    setRailOpen(false);
    setLoadState("ready");
    if (nextProjectId) {
      window.history.replaceState(null, "", `#${nextProjectId}`);
    } else {
      window.history.replaceState(null, "", window.location.pathname);
      setProjectOnboardingOpen(true);
    }
  };

  return (
    <Tooltip.Provider delayDuration={250}>
    <div className={`app-shell ${isRailCollapsed ? "is-rail-collapsed" : ""}`}>
      <ProjectRail
        projects={projects}
        activeProjectId={projectId}
        isOpen={isRailOpen}
        isCollapsed={isRailCollapsed}
        onClose={() => flushSync(() => setRailOpen(false))}
        onToggleCollapse={() => flushSync(() => setRailCollapsed((value) => !value))}
        onCreateProject={() => flushSync(() => setProjectOnboardingOpen(true))}
        onSelect={(id) => {
          flushSync(() => {
            setMessage("");
            setProjectId(id);
            setSelectedTicketId("");
            setTicket(null);
            setDetailOpen(false);
            setRailOpen(false);
          });
        }}
      />
      {isRailOpen ? <button className="scrim" type="button" aria-label="Close projects" onClick={() => flushSync(() => setRailOpen(false))} /> : null}

      <main className="workspace">
        <header className="topbar">
          <IconButton className="mobile-only" label="Projects" onClick={() => flushSync(() => setRailOpen(true))}>
            <Menu size={18} />
          </IconButton>
          <div className="topbar-title">
            <p className="kicker">Mission Control</p>
            <div className="project-title-line">
              <h1>{project?.name || "Floop"}</h1>
              {project?.description ? <p className="project-description">{project.description}</p> : null}
            </div>
          </div>
          <div className="topbar-actions">
            <IconButton
              label={themeMode === "dark" ? "Use day theme" : "Use deep-end theme"}
              pressed={themeMode === "dark"}
              onClick={() => setThemeMode((mode) => (mode === "dark" ? "light" : "dark"))}
            >
              {themeMode === "dark" ? <Sun size={17} /> : <Moon size={17} />}
            </IconButton>
            <span className={`live-pill live-${liveStatus}`}>{liveStatus}</span>
          </div>
        </header>

        {message ? <div className={`status ${loadState === "error" ? "is-error" : ""}`}>{message}</div> : null}

        <div className="workspace-tools">
          <Tabs.Root value={activeView} onValueChange={(value) => setActiveView(value as WorkspaceView)}>
            <Tabs.List className="view-tabs" aria-label="Workspace view">
              <Tabs.Trigger value="board">Board</Tabs.Trigger>
              <Tabs.Trigger value="ceremonies">Ceremonies</Tabs.Trigger>
              <Tabs.Trigger value="ops">Cockpit</Tabs.Trigger>
            </Tabs.List>
          </Tabs.Root>
          <div className="tool-cluster" aria-label="Workspace actions">
            <IconButton label="Refresh" onClick={refresh} disabled={!projectId}>
              <RefreshCw size={17} />
            </IconButton>
            <IconButton label="Settings" onClick={() => flushSync(() => setSettingsOpen(true))} disabled={!projectId}>
              <SlidersHorizontal size={17} />
            </IconButton>
            <IconButton className="is-primary" label="New Ticket" onClick={() => flushSync(() => setComposerOpen((value) => !value))} disabled={!projectId}>
              <Plus size={18} />
            </IconButton>
          </div>
        </div>

        <section className="board-surface">
          <BoardHeader project={project} board={board} loadState={loadState} label={activeView === "board" ? "Board" : activeView === "ceremonies" ? "Ceremonies" : "Cockpit"} />
          {!projectId && loadState === "ready" ? (
            <ProjectEmptyState onCreateProject={() => flushSync(() => setProjectOnboardingOpen(true))} />
          ) : isComposerOpen ? (
            <TicketComposer repos={repos} onSubmit={handleCreateTicket} onCancel={() => setComposerOpen(false)} />
          ) : activeView === "board" ? (
            <BoardView board={board} selectedTicketId={selectedTicketId} sensors={dragSensors} onSelectTicket={selectTicket} onMoveTicket={handleTicketDrop} />
          ) : activeView === "ceremonies" ? (
            <CeremoniesPanel ceremonies={ceremonies} onRun={handleRunCeremony} onApply={handleApplyCeremony} />
          ) : (
            <OpsPanel
              project={project}
              board={board}
              mergeQueue={mergeQueue}
              ceremonies={ceremonies}
              events={events}
              agentMessages={agentMessages}
              artifacts={artifacts}
              runObservability={runObservability}
              onSelectTicket={selectTicket}
              onApplyCeremony={handleApplyCeremony}
              onUpdateAgentMessage={async (messageId, input) => {
                if (!projectId) return;
                await updateAgentMessage(projectId, messageId, input);
                await refresh();
              }}
              onConvertAgentMessage={async (agentMessage) => {
                if (!projectId) return;
                const targetRepoId = typeof agentMessage.target.repoId === "string" ? agentMessage.target.repoId : "";
                const repo = repos.find((candidate) => candidate.id === targetRepoId) || repos[0];
                const created = await createTicket(projectId, {
                  title: agentMessage.summary,
                  brief: agentMessage.body || agentMessage.summary,
                  priority: agentMessage.intent === "raise_risk" ? "high" : "medium",
                  state: "PROPOSED",
                  assignedRole: "developer",
                  repoTargets: repo ? [{ repoId: repo.id, baseRef: repo.defaultBranch }] : [],
                });
                await updateAgentMessage(projectId, agentMessage.id, {
                  status: "converted",
                  promotedKind: "ticket",
                  promotedRef: created.id,
                });
                setSelectedTicketId(created.id);
                setTicket(created);
                await refreshTicket(created.id);
                await Promise.all([
                  listMergeQueue(projectId).then(setMergeQueue),
                  listCeremonies(projectId).then(setCeremonies),
                  listEvents(projectId).then(setEvents),
                  listAgentMessages(projectId).then(setAgentMessages),
                  listArtifacts(projectId).then(setArtifacts),
                  getRunObservability(projectId).then(setRunObservability),
                ]);
              }}
              onDispatchAgentMessage={async (agentMessage) => {
                if (!projectId || typeof agentMessage.target.ticketId !== "string" || !agentMessage.target.ticketId) return;
                const role = typeof agentMessage.metadata.role === "string" && roles.includes(agentMessage.metadata.role as RoleName)
                  ? agentMessage.metadata.role as RoleName
                  : "developer";
                const execution = await startExecution(projectId, agentMessage.target.ticketId, {
                  role,
                  reason: agentMessage.body || agentMessage.summary,
                });
                await updateAgentMessage(projectId, agentMessage.id, {
                  status: "attached",
                  promotedKind: "execution",
                  promotedRef: execution.id,
                });
                await refreshTicket(agentMessage.target.ticketId);
                await Promise.all([
                  listMergeQueue(projectId).then(setMergeQueue),
                  listCeremonies(projectId).then(setCeremonies),
                  listEvents(projectId).then(setEvents),
                  listAgentMessages(projectId).then(setAgentMessages),
                  listArtifacts(projectId).then(setArtifacts),
                  getRunObservability(projectId).then(setRunObservability),
                ]);
              }}
              onOpenCeremonies={() => setActiveView("ceremonies")}
            />
          )}
        </section>
      </main>
      <Dialog.Root open={isDetailOpen} onOpenChange={(open) => flushSync(() => setDetailOpen(open))}>
        <Dialog.Portal>
          <Dialog.Overlay className="modal-scrim" />
          <Dialog.Content className="ticket-detail">
            <Dialog.Description className="sr-only">
              Inspect ticket status, evidence, scope, timeline, and dispatch the next operator action.
            </Dialog.Description>
            <TicketDetailPanel
              projectId={projectId}
              ticket={ticket}
              selectedTicket={selectedTicketSummary}
              onClose={() => flushSync(() => setDetailOpen(false))}
              onRefresh={refreshTicket}
              onFullRefresh={refresh}
              repos={repos}
              tickets={board?.columns.flatMap((column) => column.tickets) || []}
              agentMessages={agentMessages}
            />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <SettingsDrawer
        projectId={projectId}
        project={project}
        repos={repos}
        isOpen={isSettingsOpen}
        onClose={() => flushSync(() => setSettingsOpen(false))}
        onDeleteProject={handleDeleteProject}
        onRefresh={refresh}
      />
      <ProjectOnboardingDialog
        isOpen={isProjectOnboardingOpen || (loadState === "ready" && projects.length === 0)}
        onClose={() => flushSync(() => setProjectOnboardingOpen(false))}
        onSubmit={handleCreateProject}
      />
    </div>
    </Tooltip.Provider>
  );
}

function ProjectRail({
  projects,
  activeProjectId,
  isOpen,
  isCollapsed,
  onClose,
  onToggleCollapse,
  onCreateProject,
  onSelect,
}: {
  projects: Project[];
  activeProjectId: string;
  isOpen: boolean;
  isCollapsed: boolean;
  onClose: () => void;
  onToggleCollapse: () => void;
  onCreateProject: () => void;
  onSelect: (id: string) => void;
}) {
  return (
    <aside className={`project-rail ${isOpen ? "is-open" : ""} ${isCollapsed ? "is-collapsed" : ""}`}>
      <div className="rail-heading">
        <div className="rail-title">
          <p className="kicker">Floop</p>
          <h2>Projects</h2>
        </div>
        <IconButton className="rail-collapse" label={isCollapsed ? "Expand project rail" : "Collapse project rail"} onClick={onToggleCollapse}>
          {isCollapsed ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
        </IconButton>
        <IconButton className="mobile-only" label="Close projects" onClick={onClose}>
          <X size={18} />
        </IconButton>
      </div>
      <div className="project-list">
        <button className="project-create-button" type="button" onClick={onCreateProject}>
          <Plus size={16} />
          <span>New project</span>
        </button>
        {projects.map((project) => (
          <button
            key={project.id}
            className={`project-item ${project.id === activeProjectId ? "is-active" : ""}`}
            type="button"
            onClick={() => onSelect(project.id)}
          >
            <span>{project.name}</span>
            <small>{project.ticketCount} tickets · {project.repoCount} repos</small>
            <ProjectHealthGlyphs project={project} />
          </button>
        ))}
      </div>
    </aside>
  );
}

function ProjectHealthGlyphs({ project }: { project: Project }) {
  const board = project.board || {};
  const attention = (board.BLOCKED || 0) + (board.REWORK || 0);
  const active = (board.WORKING || 0) + (board.REVIEWING || 0) + (board.VALIDATING || 0);
  const merge = (board.READY_TO_MERGE || 0) + (board.MERGING || 0);
  return (
    <span className="project-health" aria-label="Project health">
      <StateDot tone={active ? "active" : "neutral"} label={`${active} active`} />
      <StateDot tone={attention ? "attention" : "neutral"} label={`${attention} attention`} />
      <StateDot tone={merge ? "done" : "neutral"} label={`${merge} merge-ready`} />
    </span>
  );
}

function IconButton({
  label,
  className = "",
  disabled = false,
  pressed,
  onClick,
  children,
}: {
  label: string;
  className?: string;
  disabled?: boolean;
  pressed?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button
          className={`icon-button ${className}`.trim()}
          type="button"
          aria-label={label}
          aria-pressed={pressed}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tooltip-content" sideOffset={8}>
          {label}
          <Tooltip.Arrow className="tooltip-arrow" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

function BoardHeader({ project, board, loadState, label }: { project: Project | null; board: Board | null; loadState: LoadState; label: string }) {
  const summary = project?.board || {};
  const flowItems = [
    { id: "backlog", label: "Backlog", value: (summary.PROPOSED || 0) + (summary.READY || 0), tone: "neutral" as Tone },
    { id: "working", label: "Working", value: (summary.WORKING || 0) + (summary.REWORK || 0), tone: "active" as Tone },
    { id: "evidence", label: "Evidence", value: (summary.REVIEWING || 0) + (summary.VALIDATING || 0), tone: "attention" as Tone },
    { id: "merge", label: "Merge", value: (summary.READY_TO_MERGE || 0) + (summary.MERGING || 0), tone: "done" as Tone },
    { id: "blocked", label: "Blocked", value: summary.BLOCKED || 0, tone: "danger" as Tone },
  ];
  return (
    <section className="summary-strip">
      <div>
        <p className="kicker">{label}</p>
        <h2>{label === "Cockpit" ? "Cockpit" : label === "Ceremonies" ? "Agent ceremonies" : board?.projectName || (loadState === "loading" ? "Loading project..." : "No project selected")}</h2>
        <StatusMeter items={flowItems} />
      </div>
      <Metric label="Total" value={String(board?.totalTickets || 0)} />
      <Metric label="Working" value={String((summary.WORKING || 0) + (summary.REWORK || 0))} />
      <Metric label="Evidence" value={String((summary.REVIEWING || 0) + (summary.VALIDATING || 0))} />
      <Metric label="Merge" value={String((summary.READY_TO_MERGE || 0) + (summary.MERGING || 0))} />
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function OpsPanel({
  project,
  board,
  mergeQueue,
  ceremonies,
  events,
  agentMessages,
  artifacts,
  runObservability,
  onSelectTicket,
  onApplyCeremony,
  onUpdateAgentMessage,
  onConvertAgentMessage,
  onDispatchAgentMessage,
  onOpenCeremonies,
}: {
  project: Project | null;
  board: Board | null;
  mergeQueue: MergeQueueItem[];
  ceremonies: CeremonyRun[];
  events: EventRecord[];
  agentMessages: AgentMessage[];
  artifacts: Artifact[];
  runObservability: RunObservability | null;
  onSelectTicket: (id: string) => void;
  onApplyCeremony: (runId: string, proposalIds?: string[]) => Promise<void>;
  onUpdateAgentMessage: (messageId: string, input: { status: AgentMessage["status"]; promotedKind?: string; promotedRef?: string }) => Promise<void>;
  onConvertAgentMessage: (message: AgentMessage) => Promise<void>;
  onDispatchAgentMessage: (message: AgentMessage) => Promise<void>;
  onOpenCeremonies: () => void;
}) {
  const [busyAttentionId, setBusyAttentionId] = useState("");
  const attentionItems = useMemo(
    () => buildAttentionQueue({ board, mergeQueue, ceremonies, agentMessages }),
    [board, mergeQueue, ceremonies, agentMessages],
  );
  const visibleMergeQueue = mergeQueue.filter((item) => item.mergeStatus?.requiresHumanApproval || item.mergeStatus?.canMerge);

  async function actOnAttention(item: AttentionItem) {
    if (item.agentMessage) {
      const message = item.agentMessage;
      setBusyAttentionId(item.id);
      try {
        if (message.intent === "suggest_ticket" || message.intent === "raise_risk") {
          await onConvertAgentMessage(message);
        } else if (message.intent === "suggest_dispatch" && typeof message.target.ticketId === "string" && message.target.ticketId) {
          await onDispatchAgentMessage(message);
        } else if (message.intent === "comment_on_ticket" && typeof message.target.ticketId === "string" && message.target.ticketId) {
          await onUpdateAgentMessage(message.id, { status: "attached" });
        } else {
          await onUpdateAgentMessage(message.id, { status: "accepted" });
        }
      } finally {
        setBusyAttentionId("");
      }
      return;
    }
    if (item.ticketId) {
      onSelectTicket(item.ticketId);
      return;
    }
    if (item.ceremonyRunId) {
      if (item.proposalIds?.length) {
        setBusyAttentionId(item.id);
        try {
          await onApplyCeremony(item.ceremonyRunId, item.proposalIds);
        } finally {
          setBusyAttentionId("");
        }
        return;
      }
      onOpenCeremonies();
    }
  }

  return (
    <section className="ops-panel" aria-label="Cockpit overview">
      <ProductRunOverview project={project} board={board} runObservability={runObservability} onOpenCeremonies={onOpenCeremonies} />
      <div className="decision-queue attention-panel">
        <div className="section-heading">
          <h3>Attention</h3>
          <span>{attentionItems.length}</span>
        </div>
        <div className="decision-list">
          {attentionItems.length === 0 ? <p className="lane-empty">No operator decisions waiting.</p> : null}
          {attentionItems.map((item) => (
            <article key={item.id} className={`decision-item decision-${item.kind}`}>
              <div className="decision-copy">
                <span>{item.label} · {item.age}</span>
                <strong>{item.title}</strong>
                <p>{item.detail}</p>
                {item.meta?.length ? (
                  <div className="decision-meta">
                    {item.meta.map((value) => <small key={value}>{value}</small>)}
                  </div>
                ) : null}
              </div>
              <button
                className={item.agentMessage ? "primary-button decision-action" : "quiet-button decision-action"}
                type="button"
                disabled={busyAttentionId === item.id}
                onClick={() => actOnAttention(item)}
              >
                {item.actionLabel}
              </button>
            </article>
          ))}
        </div>
      </div>
      <div className="run-observability">
        <div className="section-heading">
          <h3>Agent Work</h3>
          <span>{runObservability ? formatDate(runObservability.generatedAt) : "Loading"}</span>
        </div>
        <StatusMeter
          items={[
            { id: "running", label: "Running", value: runObservability?.summary.running || 0, tone: "active" },
            { id: "attention", label: "Attention", value: runObservability?.summary.needsAttention || 0, tone: "attention" },
            { id: "failed", label: "Failed", value: runObservability?.summary.failed || 0, tone: "danger" },
            { id: "complete", label: "Recent", value: Math.max(0, (runObservability?.summary.total || 0) - (runObservability?.summary.running || 0) - (runObservability?.summary.failed || 0)), tone: "done" },
          ]}
        />
        <RunSubway runs={runObservability?.runs || []} onSelectTicket={onSelectTicket} />
        {/* Keep a fallback empty state adjacent to the subway for first-run projects. */}
        <div className="run-list is-empty-only">
          {!runObservability || runObservability.runs.length === 0 ? <p className="lane-empty">No worker runs recorded yet.</p> : null}
        </div>
      </div>
      {visibleMergeQueue.length ? <div className="ops-column">
        <div className="section-heading">
          <h3>Merge Queue</h3>
          <span>{visibleMergeQueue.length}</span>
        </div>
        <div className="compact-list">
          {visibleMergeQueue.slice(0, 4).map((item) => (
            <article key={item.id} className="compact-item">
              <strong>{item.key}</strong>
              <span>{item.mergeStatus?.statusSummary || item.title}</span>
            </article>
          ))}
        </div>
      </div> : null}
      <div className="ops-column">
        <div className="section-heading">
          <h3>Activity</h3>
          <span>{events.length}</span>
        </div>
        <div className="compact-list">
          {events.slice(0, 4).map((event) => (
            <article key={event.id} className="compact-item">
              <strong>{event.summary}</strong>
              <span>{prettyState(event.type)} · {formatDate(event.createdAt)}</span>
            </article>
          ))}
        </div>
      </div>
      <div className="ops-column">
        <div className="section-heading">
          <h3>Artifacts</h3>
          <span>{artifacts.length}</span>
        </div>
        <div className="compact-list">
          {artifacts.slice(0, 4).map((artifact) => (
            <article key={artifact.id} className="compact-item">
              <strong>{artifact.label}</strong>
              <span>{artifact.kind}</span>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function ProductRunOverview({
  project,
  board,
  runObservability,
  onOpenCeremonies,
}: {
  project: Project | null;
  board: Board | null;
  runObservability: RunObservability | null;
  onOpenCeremonies: () => void;
}) {
  const policy = project?.policy;
  const summary = project?.board || {};
  const automation = policy?.ceremonyAutomation;
  const active = policy?.interactionMode === "fully_autonomous" || policy?.interactionMode === "autopilot" || automation?.enabled;
  const triggers = automation?.triggers || {};
  const triggerItems = [
    { key: "refinement", label: "Refine", minutes: triggers.refinement?.minIntervalMinutes || 10 },
    { key: "planning", label: "Plan", minutes: triggers.planning?.minIntervalMinutes || 15 },
    { key: "daily_triage", label: "Check-in", minutes: triggers.daily_triage?.minIntervalMinutes || 30 },
    { key: "review_demo_prep", label: "Demo", minutes: triggers.review_demo_prep?.minIntervalMinutes || 30 },
    { key: "work_generation", label: "New work", minutes: triggers.work_generation?.minIntervalMinutes || 60 },
    { key: "retro", label: "Retro", minutes: triggers.retro?.minIntervalMinutes || 180 },
  ];
  const running = runObservability?.summary.running || 0;
  const evidence = (summary.REVIEWING || 0) + (summary.VALIDATING || 0);
  const merge = (summary.READY_TO_MERGE || 0) + (summary.MERGING || 0);
  const backlog = board ? board.totalTickets - running - evidence - merge - (summary.DONE || 0) : 0;

  return (
    <div className={`product-run-overview ${active ? "is-active" : ""}`}>
      <div className="section-heading">
        <h3>Product Run</h3>
        <span>{active ? prettyState(policy?.interactionMode || automation?.mode || "active") : "Not started"}</span>
      </div>
      <StatusMeter
        items={[
          { id: "plan", label: "Backlog", value: Math.max(0, backlog), tone: "neutral" },
          { id: "work", label: "Working", value: running, tone: "active" },
          { id: "proof", label: "Evidence", value: evidence, tone: "attention" },
          { id: "merge", label: "Merge", value: merge, tone: "done" },
        ]}
      />
      <div className="product-run-cadence">
        {triggerItems.map((item) => (
          <span key={item.key}>
            <strong>{item.minutes}m min</strong>
            {item.label}
          </span>
        ))}
      </div>
      <button className="quiet-button" type="button" onClick={onOpenCeremonies}>
        Open ceremonies
      </button>
    </div>
  );
}

function RunSubway({
  runs,
  onSelectTicket,
}: {
  runs: RunObservability["runs"];
  onSelectTicket: (id: string) => void;
}) {
  const sorted = [...runs].sort((a, b) => runPriority(b) - runPriority(a)).slice(0, 10);
  if (sorted.length === 0) return null;
  return (
    <div className="run-subway">
      {sorted.map((run) => (
        <RunSubwayItem key={run.id} run={run} onSelectTicket={onSelectTicket} />
      ))}
    </div>
  );
}

function RunSubwayItem({
  run,
  onSelectTicket,
}: {
  run: RunObservability["runs"][number];
  onSelectTicket: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const actionHint = runActionHint(run);
  const proofCount = run.artifactCount || Number(Boolean(run.workLogArtifactUri)) + Number(Boolean(run.stdoutArtifactUri)) + Number(Boolean(run.stderrArtifactUri));
  const hasProofLinks = Boolean(run.workLogArtifactUri || run.stdoutArtifactUri || run.stderrArtifactUri || run.worktreePaths.length);
  const phases: PhaseItem[] = [
    { id: "claim", label: "Claim", complete: run.claimStatus === "not_applicable" || run.claimStatus === "claimed", current: run.status === "running", tone: toneForStatus(run.claimStatus) },
    { id: "output", label: "Output", complete: Boolean(run.stdoutArtifactUri || run.stderrArtifactUri || run.artifactCount), tone: run.stdoutArtifactUri || run.stderrArtifactUri || run.artifactCount ? "done" : "neutral" },
    { id: "attention", label: "Attention", current: run.needsAttention, tone: run.needsAttention ? "attention" : "neutral" },
    { id: "finish", label: run.status === "failed" ? "Failed" : "Finish", complete: Boolean(run.finishedAt), tone: run.status === "failed" || run.failureKind ? "danger" : run.finishedAt ? "done" : "active" },
  ];
  return (
    <article className={`run-subway-item run-${run.kind} ${run.needsAttention ? "needs-attention" : ""}`}>
      <button className="run-subway-main" type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <div className="run-marker">
          <span>{run.kind.slice(0, 1).toUpperCase()}</span>
        </div>
        <div className="run-copy">
          <span>{prettyState(run.kind)} · {prettyState(run.status)} · {formatDate(run.finishedAt || run.startedAt)}</span>
          <strong>{run.label}</strong>
          <p>{actionHint}</p>
          <PhaseRail items={phases} compact />
        </div>
      </button>
      <div className="run-meta">
        {run.ticketId ? (
          <button className="inline-link" type="button" onClick={() => onSelectTicket(run.ticketId)}>
            {run.ticketKey || "Open ticket"}
          </button>
        ) : null}
        {run.role ? <span>{prettyRole(run.role as RoleName)}</span> : null}
        {proofCount ? <span>{proofCount} proofs</span> : null}
        {run.retryAttemptCount > 1 ? <span>{run.retryAttemptCount} attempts</span> : null}
        {run.pendingProposalCount ? <span>{run.pendingProposalCount} proposals</span> : null}
      </div>
      {open ? (
        <div className="run-action-drawer">
          <div className="run-action-summary">
            <div>
              <span>Next</span>
              <strong>{actionHint}</strong>
              <p>{run.summary || "No run summary recorded yet."}</p>
            </div>
            {run.ticketId ? (
              <button className="primary-button" type="button" onClick={() => onSelectTicket(run.ticketId)}>
                Open ticket
              </button>
            ) : null}
          </div>
          {run.movementReason ? (
            <article className="movement-reason">
              <FileText size={15} />
              <span>{run.movementReason.reasonCode || run.movementReason.summary}</span>
              <small>{run.movementReason.detail || run.movementReason.summary}</small>
            </article>
          ) : null}
          {run.kind === "execution" ? <AgentTraceSummary run={run} /> : null}
          {hasProofLinks ? (
            <details className="run-proof-links">
              <summary>Proof links</summary>
              <div>
                <LogChip label="work log" value={run.workLogArtifactUri} />
                <LogChip label="stdout" value={run.stdoutArtifactUri} />
                <LogChip label="stderr" value={run.stderrArtifactUri} />
                {run.worktreePaths.map((path) => (
                  <LogChip key={path} label="worktree" value={path} />
                ))}
              </div>
            </details>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function runActionHint(run: RunObservability["runs"][number]) {
  if (run.needsAttention) return run.ticketId ? "Needs review on the ticket." : "Needs operator attention.";
  if (run.status === "running") return run.ticketId ? "Running now; open the ticket to steer or stop." : "Running now.";
  if (run.status === "failed" || run.failureKind) return run.ticketId ? "Failed; open the ticket to recover." : "Failed; inspect proof.";
  if (run.pendingProposalCount) return "Review pending ceremony proposals.";
  if (run.finishedAt) return run.ticketId ? "Completed; open the ticket for evidence." : "Completed.";
  return run.ticketId ? "Open the ticket for the next action." : "Waiting for activity.";
}

function AgentTraceSummary({ run }: { run: RunObservability["runs"][number] }) {
  const progress = run.agentProgressSignalCount || 0;
  const questions = run.agentQuestionSignalCount || 0;
  const summary =
    run.agentTraceSummary ||
    (progress > 0
      ? "Progress recorded without question-like output."
      : "No explicit progress signals found in agent output.");
  return (
    <article className={`agent-trace-summary ${questions > 0 ? "has-questions" : ""}`}>
      <div>
        <span>Trace</span>
        <strong>{summary}</strong>
      </div>
      <div className="agent-trace-metrics">
        <span><strong>{progress}</strong> progress</span>
        <span><strong>{questions}</strong> questions</span>
      </div>
    </article>
  );
}

function runPriority(run: RunObservability["runs"][number]) {
  if (run.status === "running") return 5;
  if (run.needsAttention) return 4;
  if (run.failureKind || run.status === "failed") return 3;
  if (run.retryAttemptCount > 1) return 2;
  return 1;
}

function buildAttentionQueue({
  board,
  mergeQueue,
  ceremonies,
  agentMessages,
}: {
  board: Board | null;
  mergeQueue: MergeQueueItem[];
  ceremonies: CeremonyRun[];
  agentMessages: AgentMessage[];
}): AttentionItem[] {
  const tickets = board?.columns.flatMap((column) => column.tickets) || [];
  const items: AttentionItem[] = [];

  for (const run of ceremonies) {
    const pending = run.proposals.filter((proposal) => proposal.status === "pending");
    if (pending.length > 0) {
      items.push({
        id: `ceremony:${run.id}`,
        kind: "ceremony",
        label: "Ceremony proposals",
        title: `${prettyCeremony(run.type)} has ${pending.length} pending proposal${pending.length === 1 ? "" : "s"}`,
        detail: run.summaryMd || "Review and apply the proposals that match current operator intent.",
        age: formatDate(run.updatedAt || run.startedAt),
        severity: 3,
        actionLabel: "Apply",
        ceremonyRunId: run.id,
        proposalIds: pending.map((proposal) => proposal.id),
      });
    }
  }

  for (const message of agentMessages.filter((candidate) => candidate.status === "pending")) {
    items.push({
      id: `agent:${message.id}`,
      kind: "external_agent",
      label: attentionLabelForAgentMessage(message),
      title: message.summary,
      detail: message.body || "External agent input is waiting.",
      age: formatDate(message.createdAt),
      severity: message.intent === "raise_risk" ? 4 : 2,
      actionLabel: attentionActionForAgentMessage(message),
      meta: attentionMetaForAgentMessage(message),
      ticketId: typeof message.target.ticketId === "string" ? message.target.ticketId : undefined,
      agentMessage: message,
    });
  }

  for (const item of mergeQueue) {
    if (item.mergeStatus?.requiresHumanApproval) {
      items.push({
        id: `approval:${item.id}`,
        kind: "approval",
        label: "Merge approval",
        title: `${item.key} needs human approval`,
        detail: item.mergeStatus.statusSummary || item.title,
        age: formatDate(item.updatedAt),
        severity: 5,
        actionLabel: "Open",
        ticketId: item.id,
      });
    } else if (item.mergeStatus?.canMerge) {
      items.push({
        id: `merge:${item.id}`,
        kind: "merge",
        label: "Merge ready",
        title: `${item.key} is ready to merge`,
        detail: item.mergeStatus.statusSummary || item.title,
        age: formatDate(item.updatedAt),
        severity: 2,
        actionLabel: "Open",
        ticketId: item.id,
      });
    }
  }

  for (const ticket of tickets) {
    if (ticket.latestValidationVerdict === "failed") {
      items.push({
        id: `validation:${ticket.id}`,
        kind: "validation",
        label: "Failed validation",
        title: `${ticket.key} needs validation follow-up`,
        detail: ticket.latestSummary || ticket.title,
        age: formatDate(ticket.updatedAt),
        severity: 5,
        actionLabel: "Open",
        ticketId: ticket.id,
      });
      continue;
    }

    if (ticket.state === "BLOCKED" || ticket.state === "REWORK") {
      items.push({
        id: `blocked:${ticket.id}`,
        kind: "blocked",
        label: prettyState(ticket.state),
        title: `${ticket.key} needs an unblock decision`,
        detail: ticket.latestSummary || ticket.title,
        age: formatDate(ticket.updatedAt),
        severity: ticket.state === "BLOCKED" ? 4 : 3,
        actionLabel: "Open",
        ticketId: ticket.id,
      });
      continue;
    }

    if (isStaleActiveTicket(ticket)) {
      items.push({
        id: `stale:${ticket.id}`,
        kind: "stale",
        label: "Stale active run",
        title: `${ticket.key} has been active since ${formatDate(ticket.updatedAt)}`,
        detail: ticket.latestSummary || ticket.title,
        age: formatDate(ticket.updatedAt),
        severity: 3,
        actionLabel: "Open",
        ticketId: ticket.id,
      });
    }
  }

  return items
    .sort((a, b) => b.severity - a.severity)
    .slice(0, 12);
}

function attentionLabelForAgentMessage(message: AgentMessage) {
  if (message.intent === "suggest_dispatch") return `${message.actor} · dispatch`;
  if (message.intent === "submit_artifact") return `${message.actor} · evidence`;
  if (message.intent === "comment_on_ticket") return `${message.actor} · comment`;
  if (message.intent === "raise_risk") return `${message.actor} · risk`;
  if (message.intent === "request_status") return `${message.actor} · status`;
  return `${message.actor} · ${prettyState(message.intent)}`;
}

function attentionActionForAgentMessage(message: AgentMessage) {
  if (message.intent === "suggest_ticket" || message.intent === "raise_risk") return "Create ticket";
  if (message.intent === "suggest_dispatch") return "Dispatch";
  if (message.intent === "comment_on_ticket") return "Attach";
  if (message.intent === "submit_artifact") return "Attach evidence";
  if (message.intent === "request_status") return "Acknowledge";
  return "Accept";
}

function attentionMetaForAgentMessage(message: AgentMessage) {
  const meta = [message.source || "agent"];
  if (typeof message.target.ticketId === "string" && message.target.ticketId) {
    meta.push("ticket");
  }
  if (typeof message.metadata?.role === "string" && message.metadata.role) {
    meta.push(prettyRole(message.metadata.role as RoleName));
  }
  if (message.intent === "submit_artifact" && typeof message.metadata?.artifact === "object") {
    meta.push("evidence");
  }
  return meta;
}

function isStaleActiveTicket(ticket: BoardTicket) {
  if (!["WORKING", "REVIEWING", "VALIDATING"].includes(ticket.state)) {
    return false;
  }
  const updatedAt = Date.parse(ticket.updatedAt);
  return Number.isFinite(updatedAt) && Date.now() - updatedAt > 24 * 60 * 60 * 1000;
}

const ceremonyOptions: Array<{ type: CeremonyType; label: string; detail: string }> = [
  { type: "refinement", label: "Refinement", detail: "Clarify proposed work before agents execute." },
  { type: "planning", label: "Planning", detail: "Select the next ready slice against capacity." },
  { type: "daily_triage", label: "Daily triage", detail: "Surface blocked, rework, and active-ticket decisions." },
  { type: "review_demo_prep", label: "Review/demo prep", detail: "Assemble merge-ready and done work for PO review." },
  { type: "work_generation", label: "Work generation", detail: "Generate the next backlog slice near sprint end." },
  { type: "retro", label: "Retro", detail: "Turn repeated stalls into process-improvement work." },
];

const defaultCeremonyFanOut: Record<
  CeremonyType,
  { participantRoles: RoleName[]; deciderRole: RoleName; consensusPolicy: string }
> = {
  refinement: {
    participantRoles: ["product_manager", "architect", "developer", "reviewer"],
    deciderRole: "product_manager",
    consensusPolicy: "decider_synthesizes_objections",
  },
  planning: {
    participantRoles: ["product_manager", "architect", "developer", "integrator"],
    deciderRole: "integrator",
    consensusPolicy: "decider_synthesizes_objections",
  },
  daily_triage: {
    participantRoles: ["product_manager", "developer", "reviewer", "validator"],
    deciderRole: "product_manager",
    consensusPolicy: "blockers_and_stale_work_win",
  },
  review_demo_prep: {
    participantRoles: ["product_manager", "reviewer", "validator", "integrator"],
    deciderRole: "reviewer",
    consensusPolicy: "only_evidence_backed_done_work_is_demoable",
  },
  work_generation: {
    participantRoles: ["product_manager", "architect", "developer", "reviewer"],
    deciderRole: "product_manager",
    consensusPolicy: "decider_synthesizes_objections",
  },
  retro: {
    participantRoles: ["product_manager", "architect", "developer", "reviewer", "validator"],
    deciderRole: "product_manager",
    consensusPolicy: "recurring_systemic_risk_wins",
  },
};

function CeremoniesPanel({
  ceremonies,
  onRun,
  onApply,
}: {
  ceremonies: CeremonyRun[];
  onRun: (
    type: CeremonyType,
    input: { participantRoles?: RoleName[]; deciderRole?: RoleName | ""; consensusPolicy?: string },
  ) => Promise<void>;
  onApply: (runId: string, proposalIds?: string[]) => Promise<void>;
}) {
  const [busy, setBusy] = useState("");
  const [selectedType, setSelectedType] = useState<CeremonyType>("refinement");
  const [participantRoles, setParticipantRoles] = useState<RoleName[]>(defaultCeremonyFanOut.refinement.participantRoles);
  const [deciderRole, setDeciderRole] = useState<RoleName>(defaultCeremonyFanOut.refinement.deciderRole);
  const [consensusPolicy, setConsensusPolicy] = useState(defaultCeremonyFanOut.refinement.consensusPolicy);
  const latest = ceremonies[0] || null;
  const pending = latest?.proposals.filter((proposal) => proposal.status === "pending") || [];
  const displayRun = latest || draftCeremonyRun({
    type: selectedType,
    participantRoles,
    deciderRole,
    consensusPolicy,
  });

  async function runWithBusy(label: string, work: () => Promise<void>) {
    setBusy(label);
    try {
      await work();
    } finally {
      setBusy("");
    }
  }

  function selectCeremonyType(type: CeremonyType) {
    const defaults = defaultCeremonyFanOut[type];
    setSelectedType(type);
    setParticipantRoles(defaults.participantRoles);
    setDeciderRole(defaults.deciderRole);
    setConsensusPolicy(defaults.consensusPolicy);
  }

  function toggleParticipant(role: RoleName) {
    setParticipantRoles((current) => {
      if (current.includes(role)) {
        return current.filter((item) => item !== role);
      }
      return [...current, role];
    });
  }

  const deciderOptions = participantRoles.includes(deciderRole) ? participantRoles : [deciderRole, ...participantRoles];

  return (
    <section className="ceremonies-panel" aria-label="Agent ceremonies">
      <div className="ceremony-picker">
        {ceremonyOptions.map((option) => (
          <button
            key={option.type}
            className={`ceremony-option ${selectedType === option.type ? "is-selected" : ""}`}
            type="button"
            disabled={Boolean(busy)}
            onClick={() => selectCeremonyType(option.type)}
          >
            <Sparkles size={17} />
            <strong>{option.label}</strong>
            <span>{option.detail}</span>
          </button>
        ))}
      </div>

      <div className="ceremony-review">
        <div className="section-heading">
          <h3>Facilitation</h3>
          <span>{latest ? prettyState(latest.status) : "None"}</span>
        </div>
        <CeremonyConstellation run={displayRun} />
        <CeremonyLifecycleReason run={displayRun} />
        <div className="proposal-toolbar">
          <StatusMeter
            items={[
              { id: "pending", label: "Pending", value: pending.length, tone: "attention" },
              { id: "applied", label: "Applied", value: displayRun.proposals.filter((proposal) => proposal.status === "applied").length, tone: "done" },
              { id: "other", label: "Other", value: displayRun.proposals.filter((proposal) => proposal.status !== "pending" && proposal.status !== "applied").length, tone: "neutral" },
            ]}
          />
          <button
            className="primary-button"
            type="button"
            disabled={!latest || pending.length === 0 || Boolean(busy)}
            onClick={() => latest ? runWithBusy("Apply proposals", () => onApply(latest.id)) : undefined}
          >
            Apply pending
          </button>
        </div>
        <CeremonyProposalBuckets
          run={displayRun}
          busy={Boolean(busy)}
          onApply={(proposalId) => latest ? runWithBusy("Apply proposal", () => onApply(latest.id, [proposalId])) : Promise.resolve()}
        />
      </div>

      <div className="ceremony-history">
        <div className="section-heading">
          <h3>History</h3>
          <span>{ceremonies.length}</span>
        </div>
        <div className="ceremony-controls">
          <div className="section-heading">
            <h3>{ceremonyOptions.find((option) => option.type === selectedType)?.label}</h3>
            <span>{participantRoles.length} roles</span>
          </div>
          <label className="read-field">
            <span>Decider</span>
            <p>{prettyRole(deciderRole)}</p>
          </label>
          <button
            className="primary-button"
            type="button"
            disabled={Boolean(busy) || participantRoles.length === 0}
            onClick={() =>
              runWithBusy("Run ceremony", () =>
                onRun(selectedType, {
                  participantRoles,
                  deciderRole,
                  consensusPolicy,
                }),
              )
            }
          >
            Run fan-out
          </button>
          <details className="advanced-disclosure">
            <summary>Fan-out settings</summary>
            <div className="role-toggle-grid">
              {roles.map((role) => {
                const typedRole = role as RoleName;
                return (
                <label key={role} className="check-row">
                  <input
                    type="checkbox"
                    checked={participantRoles.includes(typedRole)}
                    onChange={() => toggleParticipant(typedRole)}
                  />
                  {prettyRole(typedRole)}
                </label>
              );
              })}
            </div>
            <label>
              <span>Decider</span>
              <select value={deciderRole} onChange={(event) => setDeciderRole(event.currentTarget.value as RoleName)}>
                {deciderOptions.map((role) => (
                  <option key={role} value={role}>
                    {prettyRole(role)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Consensus policy</span>
              <input value={consensusPolicy} onChange={(event) => setConsensusPolicy(event.currentTarget.value)} />
            </label>
          </details>
        </div>
        <div className="compact-list">
          {ceremonies.slice(0, 6).map((run) => (
            <article key={run.id} className="compact-item">
              <strong>{prettyCeremony(run.type)}</strong>
              <span>{prettyState(run.status)} · {run.proposals.length} proposal(s) · {formatDate(run.startedAt)}</span>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function CeremonyLifecycleReason({ run }: { run: CeremonyRun }) {
  const reason = isRecord(run.scope?.lifecycleReason) ? run.scope.lifecycleReason : null;
  if (!reason) {
    return null;
  }
  const summary = typeof reason.summary === "string" ? reason.summary : "Lifecycle trigger started this ceremony.";
  const code = typeof reason.code === "string" ? reason.code : "lifecycle";
  const evidence = isRecord(reason.evidence) ? reason.evidence : {};
  const evidenceItems = Object.entries(evidence).filter(([, value]) => typeof value === "number" || typeof value === "string");
  return (
    <section className="lifecycle-reason" aria-label="Ceremony lifecycle reason">
      <div>
        <span>Why this ran</span>
        <strong>{summary}</strong>
      </div>
      <div className="lifecycle-evidence">
        <span>{prettyState(code)}</span>
        {evidenceItems.slice(0, 4).map(([key, value]) => (
          <span key={key}>{prettyState(key)} {String(value)}</span>
        ))}
      </div>
    </section>
  );
}

function CeremonyConstellation({ run }: { run: CeremonyRun }) {
  const participants = run.participants.length
    ? run.participants
    : run.participantRoles.map((role, index) => ({
        id: `${run.id}:${role}`,
        role,
        status: "waiting",
        outcome: "",
        summaryMd: "Waiting for participant output",
        questionsMd: "",
        riskMd: "",
        payload: {},
        projectId: run.projectId,
        runId: run.id,
        startedAt: "",
        finishedAt: "",
        createdAt: "",
        updatedAt: "",
      }));
  const pendingCount = run.proposals.filter((proposal) => proposal.status === "pending").length;
  const appliedCount = run.proposals.filter((proposal) => proposal.status === "applied").length;
  const riskCount = participants.filter((participant) => participant.riskMd || toneForStatus(participant.outcome || participant.status) === "danger").length;
  return (
    <article className="ceremony-constellation">
      <div className="ceremony-orbit-head">
        <div>
          <strong>{prettyCeremony(run.type)}</strong>
          <span>{run.summaryMd || "No ceremony summary yet."}</span>
        </div>
        <span className="badge">{run.consensusPolicy || "operator consensus"}</span>
      </div>
      <div className="constellation-stage" aria-label="Ceremony participants" style={{ "--agent-count": participants.length } as React.CSSProperties}>
        <div className="constellation-ring" aria-hidden="true" />
        <div className="decider-node">
          <span>Decider</span>
          <strong>{run.deciderRole ? roleInitials(run.deciderRole) : "OP"}</strong>
          <small>{run.deciderRole ? prettyRole(run.deciderRole) : "operator"}</small>
        </div>
        {participants.map((participant, index) => {
          const isDeciderParticipant = participant.role === run.deciderRole;
          const tone = isDeciderParticipant ? "primary" : toneForStatus(participant.outcome || participant.status);
          const relatedProposals = run.proposals.filter((proposal) => proposal.payload?.role === participant.role);
          return (
            <Tooltip.Root key={participant.id}>
              <Tooltip.Trigger asChild>
                <button
                  className={`agent-node tone-${tone}`}
                  type="button"
                  aria-label={`${prettyRole(participant.role)} ${isDeciderParticipant ? "decider" : prettyState(participant.status)}`}
                  style={{
                    "--agent-angle": `${(360 / Math.max(participants.length, 1)) * index}deg`,
                    "--agent-angle-inverse": `${(360 / Math.max(participants.length, 1)) * index * -1}deg`,
                  } as React.CSSProperties}
                >
                  <StateDot tone={tone} />
                  <strong>{roleInitials(participant.role)}</strong>
                  <span>{isDeciderParticipant ? "Decider" : prettyState(participant.status)}</span>
                </button>
              </Tooltip.Trigger>
              <Tooltip.Portal>
                <Tooltip.Content className="agent-heatmap" sideOffset={10}>
                  <strong>{prettyRole(participant.role)}</strong>
                  <span>{prettyState(participant.outcome || participant.status)}</span>
                  <p>{participant.summaryMd || "Waiting for output."}</p>
                  {participant.questionsMd ? <small>Questions: {participant.questionsMd}</small> : null}
                  {participant.riskMd ? <small>Risk: {participant.riskMd}</small> : null}
                  <div className="heatmap-cells">
                    <span className={`tone-${tone}`}>State</span>
                    <span className={relatedProposals.length ? "tone-attention" : "tone-neutral"}>{relatedProposals.length || pendingCount} proposals</span>
                    <span className={participant.riskMd ? "tone-danger" : "tone-done"}>Risk</span>
                  </div>
                  <Tooltip.Arrow className="tooltip-arrow" />
                </Tooltip.Content>
              </Tooltip.Portal>
            </Tooltip.Root>
          );
        })}
      </div>
      <div className="consensus-strip" aria-label="Consensus heatmap">
        <ConsensusCell label="Complete" value={String(participants.filter((participant) => toneForStatus(participant.outcome || participant.status) === "done").length)} tone="done" />
        <ConsensusCell label="Risks" value={String(riskCount)} tone={riskCount ? "attention" : "done"} />
        <ConsensusCell label="Apply" value={String(pendingCount)} tone={pendingCount ? "attention" : "neutral"} />
        <ConsensusCell label="Applied" value={String(appliedCount)} tone={appliedCount ? "done" : "neutral"} />
      </div>
      {run.riskMd ? <p>{run.riskMd}</p> : null}
    </article>
  );
}

function ConsensusCell({ label, value, tone }: { label: string; value: string; tone: Tone }) {
  return (
    <div className={`consensus-cell tone-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function roleInitials(role: string) {
  const words = prettyRole(role).split(/\s+/).filter(Boolean);
  if (words.length === 0) return role.slice(0, 2).toUpperCase();
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
  return words.map((word) => word[0]).join("").slice(0, 3).toUpperCase();
}

function CeremonyProposalBuckets({
  run,
  busy,
  onApply,
}: {
  run: CeremonyRun;
  busy: boolean;
  onApply: (proposalId: string) => Promise<void>;
}) {
  const proposals = [...run.proposals].sort((a, b) => Number(b.status === "pending") - Number(a.status === "pending"));
  return (
    <section className="proposal-bucket proposal-bucket-flat">
      <div className="section-heading">
        <h3>Proposals</h3>
        <span>{proposals.length}</span>
      </div>
      <div className="proposal-list">
        {proposals.length === 0 ? <p className="lane-empty">None</p> : null}
        {proposals.map((proposal) => (
          <article key={proposal.id} className={`proposal-item proposal-${proposal.status}`}>
            <div>
              <span>{prettyState(proposal.kind)} · {proposal.ticketKey || prettyCeremony(run.type)}</span>
              <strong>{proposal.summary}</strong>
              <ProposalPayloadView proposal={proposal} />
              <details className="inline-details">
                <summary>Payload</summary>
                <code>{summarizeProposalPayload(proposal.payload)}</code>
              </details>
            </div>
            {proposal.status === "pending" ? (
              <button className="quiet-button" type="button" disabled={busy} onClick={() => onApply(proposal.id)}>
                Apply
              </button>
            ) : (
              <span className="badge">{prettyState(proposal.status)}</span>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}

function ProposalPayloadView({ proposal }: { proposal: CeremonyProposal }) {
  if (proposal.kind === "ticket_create" && proposal.payload?.sourceTicketId) {
    const ticket = isRecord(proposal.payload.ticket) ? proposal.payload.ticket : {};
    return (
      <div className="cleanup-action-list" aria-label="Split recommendation">
        <div className="cleanup-action-row">
          <span className="cleanup-action-mark cleanup-action-combine"><Plus size={14} /></span>
          <div>
            <strong>Split into ticket</strong>
            <p>{typeof ticket.title === "string" && ticket.title ? ticket.title : proposal.summary}</p>
            {typeof proposal.payload.reason === "string" && proposal.payload.reason ? <small>{proposal.payload.reason}</small> : null}
          </div>
        </div>
      </div>
    );
  }
  if (proposal.kind === "note" && proposal.payload?.refinementQuestion === true) {
    return (
      <div className="cleanup-action-list" aria-label="Refinement question">
        <div className="cleanup-action-row">
          <span className="cleanup-action-mark">?</span>
          <div>
            <strong>Needs answer</strong>
            <p>{typeof proposal.payload.note === "string" && proposal.payload.note ? proposal.payload.note : proposal.summary}</p>
            {typeof proposal.payload.reason === "string" && proposal.payload.reason ? <small>{proposal.payload.reason}</small> : null}
          </div>
        </div>
      </div>
    );
  }
  if (proposal.kind !== "ticket_backlog_cleanup") return null;
  const actions = Array.isArray(proposal.payload?.actions)
    ? proposal.payload.actions.filter((action): action is Record<string, unknown> => Boolean(action && typeof action === "object"))
    : [];
  if (actions.length === 0) {
    return <p className="proposal-note">No cleanup actions proposed.</p>;
  }
  return (
    <div className="cleanup-action-list" aria-label="Backlog cleanup actions">
      {actions.map((action, index) => (
        <CleanupActionRow key={`${String(action.type || "action")}-${index}`} action={action} />
      ))}
    </div>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function CleanupActionRow({ action }: { action: Record<string, unknown> }) {
  const actionType = String(action.type || "");
  if (actionType === "combine") {
    const keeper = String(action.keeperTicketKey || action.keeperTicketId || "");
    const duplicate = String(action.duplicateTicketKey || action.duplicateTicketId || "");
    return (
      <div className="cleanup-action-row">
        <span className="cleanup-action-mark cleanup-action-combine"><Check size={14} /></span>
        <div>
          <strong>Combine overlap</strong>
          <p>Keep {shortTicketId(keeper)} and cancel {shortTicketId(duplicate)} as duplicate work.</p>
          {typeof action.reason === "string" && action.reason ? <small>{action.reason}</small> : null}
        </div>
      </div>
    );
  }
  if (actionType === "cancel") {
    const ticket = String(action.ticketKey || action.ticketId || "");
    return (
      <div className="cleanup-action-row">
        <span className="cleanup-action-mark cleanup-action-cancel"><X size={14} /></span>
        <div>
          <strong>Remove from backlog</strong>
          <p>Cancel {shortTicketId(ticket)} so refinement does not feed unnecessary work into planning.</p>
          {typeof action.reason === "string" && action.reason ? <small>{action.reason}</small> : null}
        </div>
      </div>
    );
  }
  return (
    <div className="cleanup-action-row">
      <span className="cleanup-action-mark">?</span>
      <div>
        <strong>{prettyState(actionType || "cleanup")}</strong>
        <p>{typeof action.reason === "string" && action.reason ? action.reason : "Review this cleanup action before applying."}</p>
      </div>
    </div>
  );
}

function shortTicketId(value: string) {
  if (!value) return "ticket";
  const match = value.match(/[A-Z]+-\d+/);
  if (match) return match[0];
  return value.replace(/^ticket_[^_]+_/, "ticket ");
}

function prettyCeremony(type: string) {
  return type.replace(/_/g, " ");
}

function draftCeremonyRun({
  type,
  participantRoles,
  deciderRole,
  consensusPolicy,
}: {
  type: CeremonyType;
  participantRoles: RoleName[];
  deciderRole: RoleName | "";
  consensusPolicy: string;
}): CeremonyRun {
  const now = new Date().toISOString();
  return {
    id: `draft:${type}`,
    projectId: "",
    type,
    status: "draft",
    scope: {},
    participantRoles,
    deciderRole,
    consensusPolicy,
    inputSnapshot: {},
    summaryMd: "Ready to fan out. Select the roles, confirm the decider, then run the ceremony.",
    questionsMd: "",
    riskMd: "",
    createdByKind: "operator",
    createdByRef: "ui",
    startedAt: now,
    finishedAt: "",
    appliedAt: "",
    updatedAt: now,
    proposals: [],
    participants: participantRoles.map((role) => ({
      id: `draft:${type}:${role}`,
      projectId: "",
      runId: `draft:${type}`,
      role,
      status: "waiting",
      outcome: "",
      summaryMd: role === deciderRole ? "Decider will synthesize objections." : "Participant is queued for fan-out.",
      questionsMd: "",
      riskMd: "",
      payload: {},
      startedAt: "",
      finishedAt: "",
      createdAt: now,
      updatedAt: now,
    })),
  };
}

function summarizeProposalPayload(payload: Record<string, unknown>) {
  const keys = Object.keys(payload || {});
  if (keys.length === 0) return "No payload";
  return keys.slice(0, 4).join(", ");
}

function BoardView({
  board,
  selectedTicketId,
  sensors,
  onSelectTicket,
  onMoveTicket,
}: {
  board: Board | null;
  selectedTicketId: string;
  sensors: ReturnType<typeof useSensors>;
  onSelectTicket: (id: string) => void;
  onMoveTicket: (ticketId: string, targetState: TicketState) => void;
}) {
  const groups = useMemo(() => (board ? groupBoardColumns(board.columns) : []), [board]);
  const dragDeltaRef = useRef({ x: 0, y: 0 });
  const laneRefs = useRef(new Map<string, HTMLElement>());
  const [laneHeight, setLaneHeight] = useState(420);
  useLayoutEffect(() => {
    const measureLaneHeight = () => {
      let nextHeight = 420;
      for (const lane of laneRefs.current.values()) {
        const styles = window.getComputedStyle(lane);
        const header = lane.querySelector<HTMLElement>(".lane-header");
        const body = lane.querySelector<HTMLElement>(".lane-body");
        const headerStyles = header ? window.getComputedStyle(header) : null;
        const chrome =
          Number.parseFloat(styles.paddingTop) +
          Number.parseFloat(styles.paddingBottom) +
          Number.parseFloat(styles.borderTopWidth) +
          Number.parseFloat(styles.borderBottomWidth) +
          (headerStyles ? Number.parseFloat(headerStyles.marginBottom) : 0);
        const contentHeight = chrome + (header?.offsetHeight || 0) + (body?.scrollHeight || 0);
        nextHeight = Math.max(nextHeight, Math.ceil(contentHeight));
      }
      setLaneHeight((current) => (current === nextHeight ? current : nextHeight));
    };

    measureLaneHeight();
    const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(measureLaneHeight) : null;
    for (const lane of laneRefs.current.values()) {
      resizeObserver?.observe(lane);
    }
    window.addEventListener("resize", measureLaneHeight);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", measureLaneHeight);
    };
  }, [groups]);
  const registerLane = (id: string, node: HTMLElement | null) => {
    if (node) {
      laneRefs.current.set(id, node);
    } else {
      laneRefs.current.delete(id);
    }
  };
  const handleDragMove = (event: DragMoveEvent) => {
    dragDeltaRef.current = event.delta;
  };
  const handleDragEnd = (event: DragEndEvent) => {
    const ticketId = String(event.active.id || "");
    let targetState = event.over?.data.current?.state as TicketState | undefined;
    const sourceState = groups.flatMap((group) => group.tickets).find((item) => item.id === ticketId)?.state;
    const deltaX = event.delta.x || dragDeltaRef.current.x;
    const sourceGroupIndex = sourceState
      ? groups.findIndex((group) => (group.states as readonly string[]).includes(String(sourceState)))
      : -1;
    const targetGroupIndex = targetState
      ? groups.findIndex((group) => (group.states as readonly string[]).includes(String(targetState)))
      : -1;
    if (sourceGroupIndex >= 0 && (targetGroupIndex === -1 || targetGroupIndex === sourceGroupIndex) && Math.abs(deltaX) > 80) {
      const targetGroup = groups[sourceGroupIndex + (deltaX > 0 ? 1 : -1)];
      targetState = targetGroup?.states[0] as TicketState | undefined;
    } else if (targetGroupIndex === sourceGroupIndex) {
      targetState = sourceState;
    }
    dragDeltaRef.current = { x: 0, y: 0 };
    if (ticketId && targetState && sourceState !== targetState) {
      onMoveTicket(ticketId, targetState);
    }
  };
  if (!board) {
    return <div className="empty-state">Create or select a project to start routing tickets.</div>;
  }
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={() => {
        dragDeltaRef.current = { x: 0, y: 0 };
      }}
      onDragMove={handleDragMove}
      onDragEnd={handleDragEnd}
    >
      <div className="board-grid" aria-label="Ticket board" style={{ "--board-lane-height": `${laneHeight}px` } as React.CSSProperties}>
        {groups.map((group) => (
          <BoardLane key={group.id} group={group} selectedTicketId={selectedTicketId} onLaneRef={registerLane} onSelectTicket={onSelectTicket} />
        ))}
      </div>
    </DndContext>
  );
}

function BoardLane({
  group,
  selectedTicketId,
  onLaneRef,
  onSelectTicket,
}: {
  group: ReturnType<typeof groupBoardColumns>[number];
  selectedTicketId: string;
  onLaneRef: (id: string, node: HTMLElement | null) => void;
  onSelectTicket: (id: string) => void;
}) {
  const { isOver, setNodeRef } = useDroppable({
    id: `lane-${group.id}`,
    data: { state: group.states[0] },
  });
  const setLaneRef = (node: HTMLElement | null) => {
    setNodeRef(node);
    onLaneRef(group.id, node);
  };
  return (
    <section className={`lane ${isOver ? "is-drop-target" : ""}`} ref={setLaneRef}>
      <div className="lane-header">
        <h3>{group.label}</h3>
        <span>{group.count}</span>
      </div>
      <div className="lane-body">
        {group.tickets.length === 0 ? <p className="lane-empty">No tickets</p> : null}
        {group.tickets.map((ticket) => (
          <TicketCard
            key={ticket.id}
            ticket={ticket}
            selected={ticket.id === selectedTicketId}
            onClick={() => onSelectTicket(ticket.id)}
          />
        ))}
      </div>
    </section>
  );
}

function TicketCard({ ticket, selected, onClick }: { ticket: BoardTicket; selected: boolean; onClick: () => void }) {
  const action = nextActionForTicket(ticket);
  const phases = ticketPhaseItems(ticket);
  const hasActiveAgent = ticket.activeExecutionCount > 0;
  const exceptionChips = [
    hasActiveAgent ? `${ticket.activeExecutionClaimed ? "Agent" : "Queued"} ${ticket.activeExecutionRole ? prettyRole(ticket.activeExecutionRole as RoleName) : "active"}` : "",
    ticket.priority === "high" ? "High" : "",
    ticket.state === "BLOCKED" ? "Blocked" : "",
    ticket.state === "REWORK" ? "Rework" : "",
    ticket.latestReviewVerdict && ticket.latestReviewVerdict !== "passed" ? `Review ${prettyState(ticket.latestReviewVerdict)}` : "",
    ticket.latestValidationVerdict && ticket.latestValidationVerdict !== "passed" ? `Validation ${prettyState(ticket.latestValidationVerdict)}` : "",
  ].filter(Boolean);
  const { attributes, isDragging, listeners, setNodeRef, transform } = useDraggable({
    id: ticket.id,
    data: { state: ticket.state },
  });
  const dragStyle = transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined;
  return (
    <button
      ref={setNodeRef}
      className={`ticket-card tile-state-${ticket.state.toLowerCase().replace(/_/g, "-")} ${selected ? "is-selected" : ""} ${isDragging ? "is-dragging" : ""}`}
      type="button"
      style={dragStyle}
      onClick={onClick}
      {...listeners}
      {...attributes}
    >
      <div className="ticket-card-top">
        <span className="ticket-key">{ticket.key}</span>
        <span className={`badge state-${ticket.state.toLowerCase().replace(/_/g, "-")}`}>{prettyState(ticket.state)}</span>
      </div>
      <strong>{ticket.title}</strong>
      <PhaseRail items={phases} compact />
      <p>{ticket.latestSummary || ticket.brief}</p>
      <div className="next-action">
        <span>{action.label}</span>
      </div>
      {exceptionChips.length ? (
        <div className="card-meta">
          {exceptionChips.map((chip) => <span key={chip}>{chip}</span>)}
        </div>
      ) : null}
    </button>
  );
}

function TicketDetailPanel({
  projectId,
  ticket,
  selectedTicket,
  onClose,
  onRefresh,
  onFullRefresh,
  repos,
  tickets,
  agentMessages,
}: {
  projectId: string;
  ticket: TicketDetail | null;
  selectedTicket: BoardTicket | null;
  onClose: () => void;
  onRefresh: (ticketId?: string) => Promise<void>;
  onFullRefresh: () => Promise<void>;
  repos: Repo[];
  tickets: BoardTicket[];
  agentMessages: AgentMessage[];
}) {
  const action = nextActionForTicket(ticket || selectedTicket);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [isEditing, setEditing] = useState(false);
  const activeExecution = ticket?.executions.find((execution) => execution.status === "running");
  const childTickets = ticket ? tickets.filter((candidate) => candidate.parentTicketId === ticket.id) : [];
  const inputRequests = useMemo(
    () =>
      agentMessages.filter(
        (message) =>
          message.intent === "request_input" &&
          message.status === "pending" &&
          typeof message.target?.ticketId === "string" &&
          message.target.ticketId === ticket?.id,
    ),
    [agentMessages, ticket?.id],
  );
  const pendingRequest = inputRequests[0];
  useEffect(() => {
    setEditing(false);
  }, [ticket?.id]);
  const runAction = async (label: string, work: () => Promise<void>) => {
    setBusy(label);
    setError("");
    try {
      await work();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError));
    } finally {
      setBusy("");
    }
  };
  return (
    <>
      <div className="detail-heading">
        <div>
          <p className="kicker">Ticket Detail</p>
          <Dialog.Title asChild>
            <h2>{ticket?.title || selectedTicket?.title || "Select a ticket"}</h2>
          </Dialog.Title>
        </div>
        <div className="tool-cluster">
          {ticket ? (
            <button className={`icon-button ${isEditing ? "is-active" : ""}`} type="button" aria-label={isEditing ? "Stop editing" : "Edit ticket"} title={isEditing ? "Done" : "Edit"} onClick={() => setEditing((value) => !value)}>
              {isEditing ? <Check size={18} /> : <Pencil size={17} />}
            </button>
          ) : null}
          <button className="icon-button" type="button" aria-label="Close ticket detail" title="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
      </div>
      {!ticket ? (
        <div className="empty-state">Pick a ticket to inspect work, evidence, and merge readiness.</div>
      ) : (
        <div className="detail-stack">
          {error ? <div className="status is-error">{error}</div> : null}
          {pendingRequest ? (
            <TicketConversationSection
              projectId={projectId}
              ticket={ticket}
              messages={agentMessages}
              pendingRequest={pendingRequest}
              busy={busy}
              onRun={runAction}
              onRefresh={onRefresh}
              onFullRefresh={onFullRefresh}
            />
          ) : null}
          <ProductAutopilotPanel
            projectId={projectId}
            ticket={ticket}
            childTickets={childTickets}
            busy={busy}
            onRun={runAction}
            onRefresh={onRefresh}
            onFullRefresh={onFullRefresh}
          />
          <section className="ticket-cockpit">
            <TicketCockpit
              projectId={projectId}
              ticket={ticket}
              action={action}
              busy={busy}
              onRun={runAction}
              onRefresh={onRefresh}
              onFullRefresh={onFullRefresh}
            />
            <TicketActionForm
              projectId={projectId}
              ticket={ticket}
              busy={busy}
              onRun={runAction}
              onRefresh={onRefresh}
            />
          </section>
          {!pendingRequest ? (
            <TicketConversationSection
              projectId={projectId}
              ticket={ticket}
              messages={agentMessages}
              busy={busy}
              onRun={runAction}
              onRefresh={onRefresh}
              onFullRefresh={onFullRefresh}
            />
          ) : null}
          <section className="detail-section">
            <div className="section-heading">
              <h3>Overview</h3>
              <span>{ticket.repoTargets.length} repo{ticket.repoTargets.length === 1 ? "" : "s"}</span>
            </div>
            <p className="detail-brief">{ticket.brief}</p>
            <div className="fact-grid">
              <Fact label="Priority" value={ticket.priority} />
              <Fact label="Role" value={prettyRole(ticket.assignedRole)} />
              <Fact label="Repos" value={String(ticket.repoTargets.length)} />
              <Fact label="Updated" value={formatDate(ticket.updatedAt)} />
            </div>
          </section>
          {isEditing ? (
            <details className="detail-disclosure" open>
              <summary>Plan</summary>
              <TicketEditSection projectId={projectId} ticket={ticket} onRefresh={onRefresh} onSaved={() => setEditing(false)} />
            </details>
          ) : (
            <details className="detail-disclosure">
              <summary>Plan</summary>
              <TicketPlanSummary ticket={ticket} />
            </details>
          )}
          <details className="detail-disclosure">
            <summary>Scope</summary>
            <ScopeSection
              projectId={projectId}
              ticket={ticket}
              repos={repos}
              tickets={tickets}
              isEditing={isEditing}
              onRefresh={onRefresh}
            />
          </details>
          <details className="detail-disclosure">
            <summary>Evidence</summary>
            <section className="detail-section">
              <h3>Evidence</h3>
              <EvidenceRail items={buildTicketEvidence(ticket)} />
              <EvidenceList ticket={ticket} />
            </section>
          </details>
          <details className="detail-disclosure">
            <summary>Worktrees</summary>
            <WorktreeAndArtifactSection
              projectId={projectId}
              ticket={ticket}
              onRun={runAction}
              onRefresh={onRefresh}
              onFullRefresh={onFullRefresh}
            />
          </details>
          <details className="detail-disclosure">
            <summary>Merge</summary>
            <section className="detail-section">
              <h3>Merge Readiness</h3>
              <p>{ticket.mergeStatus?.statusSummary || (ticket.mergeStatus?.canMerge ? "Ready to merge." : "Not ready to merge yet.")}</p>
              {ticket.mergeStatus?.blockingReasons?.length ? (
                <div className="reason-list">
                  {ticket.mergeStatus.blockingReasons.map((reason) => (
                    <article key={reason.code} className="reason-card">
                      <strong>{reason.summary || reason.message || prettyState(reason.code)}</strong>
                      <span>{reason.detail || reason.source || ""}</span>
                    </article>
                  ))}
                </div>
              ) : null}
            </section>
          </details>
          <details className="detail-disclosure">
            <summary>Timeline</summary>
            <section className="detail-section">
              <h3>Timeline</h3>
              <div className="timeline">
                {ticket.events.slice(-8).map((event) => (
                  <article key={event.id}>
                    <span>{prettyState(event.type)}</span>
                    <strong>{event.summary}</strong>
                    <time>{formatDate(event.createdAt)}</time>
                  </article>
                ))}
              </div>
            </section>
          </details>
          <details className="detail-disclosure">
            <summary>Advanced</summary>
            <ManualTicketActionForm
              projectId={projectId}
              ticket={ticket}
              busy={busy}
              onRun={runAction}
              onRefresh={onRefresh}
            />
            <TicketDangerZone
              projectId={projectId}
              ticket={ticket}
              busy={busy}
              onRun={runAction}
              onRefresh={onRefresh}
              onFullRefresh={onFullRefresh}
            />
          </details>
        </div>
      )}
    </>
  );
}

function TicketCockpit({
  projectId,
  ticket,
  action,
  busy,
  onRun,
  onRefresh,
  onFullRefresh,
}: {
  projectId: string;
  ticket: TicketDetail;
  action: { label: string; detail: string };
  busy: string;
  onRun: (label: string, work: () => Promise<void>) => Promise<void>;
  onRefresh: (ticketId?: string) => Promise<void>;
  onFullRefresh: () => Promise<void>;
}) {
  const activeExecution = ticket.executions.find((execution) => execution.status === "running");
  const latestExecution = ticket.executions[0];
  const latestReview = ticket.reviews[0];
  const latestValidation = ticket.validations[0];
  return (
    <div className="ticket-cockpit-grid">
      <div className="cockpit-main">
        <span className={`badge state-${ticket.state.toLowerCase().replace(/_/g, "-")}`}>{prettyState(ticket.state)}</span>
        <h3>{action.label}</h3>
        <p>{action.detail}</p>
      </div>
      <div className="cockpit-flow">
        <PhaseRail items={ticketPhaseItems(ticket)} />
      </div>
      <div className="cockpit-work">
        <TicketWorkPanel
          projectId={projectId}
          ticket={ticket}
          execution={activeExecution}
          busy={busy}
          onRun={onRun}
          onRefresh={onRefresh}
          onFullRefresh={onFullRefresh}
        />
      </div>
      <div className="cockpit-now">
        <div className="section-heading">
          <h3>Lane status</h3>
          <span>{activeExecution ? "Active" : prettyState(ticket.state)}</span>
        </div>
        <div className="cockpit-signal-list">
          <CockpitSignal label="Build" value={activeExecution ? `${prettyRole(activeExecution.role)} iter ${activeExecution.iteration}` : latestExecution?.outcome || "Waiting"} tone={activeExecution ? "active" : toneForStatus(latestExecution?.outcome)} />
          <CockpitSignal label="Review" value={latestReview?.verdict || "No review"} tone={toneForStatus(latestReview?.verdict)} />
          <CockpitSignal label="Validation" value={latestValidation?.verdict || "No validation"} tone={toneForStatus(latestValidation?.verdict)} />
          <CockpitSignal label="Merge" value={ticket.mergeStatus?.statusSummary || (ticket.mergeStatus?.canMerge ? "Ready" : "Not ready")} tone={ticket.mergeStatus?.canMerge ? "done" : ticket.mergeStatus?.blockingReasons?.length ? "attention" : "neutral"} />
        </div>
      </div>
    </div>
  );
}

function ProductAutopilotPanel({
  projectId,
  ticket,
  childTickets,
  busy,
  onRun,
  onRefresh,
  onFullRefresh,
}: {
  projectId: string;
  ticket: TicketDetail;
  childTickets: BoardTicket[];
  busy: string;
  onRun: (label: string, work: () => Promise<void>) => Promise<void>;
  onRefresh: (ticketId?: string) => Promise<void>;
  onFullRefresh: () => Promise<void>;
}) {
  const childCount = childTickets.length;
  const canStart = ["DRAFT", "PROPOSED", "READY"].includes(ticket.state) && !ticket.parentTicketId && childCount === 0;
  const hasBreakdown = childCount > 0 || childTickets.some((child) => /break down|feature breakdown|product plan/i.test(child.title));

  if (!canStart && !hasBreakdown) {
    return null;
  }

  async function handleStart() {
    await onRun("Starting Product Autopilot", async () => {
      const result = await startProductAutopilot(projectId, ticket.id);
      await onRefresh(result.breakdownTicket?.id || ticket.id);
      await onFullRefresh();
    });
  }

  return (
    <section className="product-autopilot-panel">
      <div>
        <p className="kicker">Product Autopilot</p>
        <h3>{hasBreakdown ? "Product run started" : "Start from this idea"}</h3>
        <p>
          {hasBreakdown
            ? "Floop has a product breakdown path for this idea."
            : "Create the PM breakdown lane, enable lifecycle ceremonies, and dispatch the first planning agent."}
        </p>
      </div>
      <div className="autopilot-cadence" aria-label="Agent ceremony lifecycle">
        <span><strong>10m</strong>Refine</span>
        <span><strong>15m</strong>Plan</span>
        <span><strong>30m</strong>Check-in</span>
        <span><strong>30m</strong>Demo</span>
        <span><strong>End</strong>New work</span>
        <span><strong>180m</strong>Retro</span>
      </div>
      {canStart ? (
        <button className="primary-button" type="button" disabled={Boolean(busy)} onClick={handleStart}>
          {busy || "Start Product Autopilot"}
        </button>
      ) : null}
    </section>
  );
}

function TicketWorkPanel({
  projectId,
  ticket,
  execution,
  busy,
  onRun,
  onRefresh,
  onFullRefresh,
}: {
  projectId: string;
  ticket: TicketDetail;
  execution?: NonNullable<TicketDetail["executions"][number]>;
  busy: string;
  onRun: (label: string, work: () => Promise<void>) => Promise<void>;
  onRefresh: (ticketId?: string) => Promise<void>;
  onFullRefresh: () => Promise<void>;
}) {
  const latestExecution = ticket.executions[0];
  const visibleExecution = execution || latestExecution;
  const logArtifacts = (visibleExecution?.artifacts || []).filter((artifact) => artifact.kind === "log").slice(0, 3);
  const proofCount = visibleExecution?.artifacts?.length || 0;
  const workStatus = execution
    ? execution.claimed
      ? "Agent working"
      : "Queued"
    : visibleExecution?.outcome
      ? prettyState(visibleExecution.outcome)
      : prettyState(ticket.state);
  const phases: PhaseItem[] = [
    {
      id: "claim",
      label: "Claim",
      complete: Boolean(execution?.claimed || !execution),
      current: Boolean(execution && !execution.claimed),
      tone: execution ? execution.claimed ? "done" : "active" : "neutral",
    },
    {
      id: "output",
      label: "Output",
      complete: Boolean(visibleExecution?.artifacts?.length || visibleExecution?.summaryMd),
      current: Boolean(execution && !visibleExecution?.summaryMd),
      tone: visibleExecution?.summaryMd || visibleExecution?.artifacts?.length ? "done" : execution ? "active" : "neutral",
    },
    {
      id: "evidence",
      label: "Evidence",
      complete: Boolean(ticket.reviews.length || ticket.validations.length),
      current: ticket.state === "REVIEWING" || ticket.state === "VALIDATING",
      tone: ticket.reviews.length || ticket.validations.length ? "done" : ticket.state === "REVIEWING" || ticket.state === "VALIDATING" ? "active" : "neutral",
    },
    {
      id: "finish",
      label: visibleExecution?.status === "failed" ? "Failed" : "Finish",
      complete: Boolean(visibleExecution?.finishedAt || ticket.state === "DONE"),
      current: Boolean(execution),
      tone: visibleExecution?.failureKind || visibleExecution?.status === "failed" ? "danger" : visibleExecution?.finishedAt || ticket.state === "DONE" ? "done" : execution ? "active" : "neutral",
    },
  ];

  async function handleStop() {
    if (!execution) return;
    await onRun("Stopping agent", async () => {
      await cancelExecution(projectId, execution.id, {
        reason: `Stopped active ${prettyRole(execution.role)} lane from ${ticket.key}.`,
      });
      await onRefresh(ticket.id);
      await onFullRefresh();
    });
  }

  if (!visibleExecution) {
    return (
      <article className="ticket-work-panel">
        <div className="ticket-work-head">
          <div>
            <p className="kicker">Current work</p>
            <h3>No agent running</h3>
          </div>
          <span className="quiet-status">Ready</span>
        </div>
        <p className="ticket-work-summary">Dispatch an agent when this ticket is ready to move.</p>
        <PhaseRail items={phases} compact />
      </article>
    );
  }

  return (
    <article className={`ticket-work-panel ${execution ? "is-active" : ""}`}>
      <div className="ticket-work-head">
        <div>
          <p className="kicker">Current work</p>
          <h3>{prettyRole(visibleExecution.role)} iteration {visibleExecution.iteration}</h3>
        </div>
        {execution ? (
          <span className="work-status">
            <span className="work-pulse" aria-label="Agent is active" />
            {workStatus}
          </span>
        ) : (
          <span className="quiet-status">{workStatus}</span>
        )}
      </div>
      <p className="ticket-work-summary">{visibleExecution.summaryMd || (execution ? "Agent is working in the background." : "Latest run has no summary yet.")}</p>
      <PhaseRail items={phases} compact />
      <div className="ticket-work-meta" aria-label="Current work evidence">
        <span>{proofCount} artifact{proofCount === 1 ? "" : "s"}</span>
        <span>{logArtifacts.length} log{logArtifacts.length === 1 ? "" : "s"}</span>
      </div>
      <div className="ticket-work-actions">
        {execution ? (
          <button className="danger-button" type="button" disabled={Boolean(busy)} onClick={handleStop}>
            <Square size={14} />
            Stop agent
          </button>
        ) : null}
      </div>
    </article>
  );
}

function CockpitSignal({ label, value, tone }: { label: string; value: string; tone: Tone }) {
  return (
    <article className={`cockpit-signal tone-${tone}`}>
      <StateDot tone={tone} />
      <span>{label}</span>
      <strong>{value || "None"}</strong>
    </article>
  );
}

function TicketPlanSummary({ ticket }: { ticket: TicketDetail }) {
  return (
    <section className="detail-section">
      <div className="section-heading">
        <h3>Ticket Plan</h3>
        <span>Locked</span>
      </div>
      <ChecklistRail items={buildTicketChecklist(ticket)} />
      <div className="read-model">
        <ReadField label="Title" value={ticket.title} />
        <ReadField label="Latest summary" value={ticket.latestSummary || "No summary recorded."} />
        <ReadField label="Brief" value={ticket.brief} />
        <ReadField label="Acceptance criteria" value={ticket.acceptanceCriteriaMd || "No acceptance criteria recorded."} />
        <ReadField label="Definition of done" value={ticket.definitionOfDoneMd || "No definition of done recorded."} />
      </div>
    </section>
  );
}

function ReadField({ label, value }: { label: string; value: string }) {
  return (
    <article className="read-field">
      <span>{label}</span>
      <p>{value}</p>
    </article>
  );
}

function TicketEditSection({
  projectId,
  ticket,
  onRefresh,
  onSaved,
}: {
  projectId: string;
  ticket: TicketDetail;
  onRefresh: (ticketId?: string) => Promise<void>;
  onSaved: () => void;
}) {
  const [error, setError] = useState("");
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError("");
    try {
      await updateTicket(projectId, ticket.id, {
        title: String(form.get("title") || ticket.title),
        brief: String(form.get("brief") || ticket.brief),
        priority: String(form.get("priority") || ticket.priority),
        assignedRole: String(form.get("assignedRole") || ticket.assignedRole),
        latestSummary: String(form.get("latestSummary") || ""),
        acceptanceCriteriaMd: String(form.get("acceptanceCriteriaMd") || ""),
        definitionOfDoneMd: String(form.get("definitionOfDoneMd") || ""),
      });
      await onRefresh(ticket.id);
      onSaved();
    } catch (editError) {
      setError(editError instanceof Error ? editError.message : String(editError));
    }
  }
  return (
    <section className="detail-section">
      <div className="section-heading">
        <h3>Ticket Plan</h3>
      </div>
      {error ? <div className="status is-error">{error}</div> : null}
      <form className="subform" onSubmit={handleSubmit}>
        <label><span>Title</span><input name="title" defaultValue={ticket.title} required /></label>
        <div className="action-grid">
          <label><span>Priority</span><select name="priority" defaultValue={ticket.priority}>{priorities.map((priority) => <option key={priority} value={priority}>{priority}</option>)}</select></label>
          <label><span>Role</span><select name="assignedRole" defaultValue={ticket.assignedRole}>{roles.map((role) => <option key={role} value={role}>{prettyRole(role)}</option>)}</select></label>
        </div>
        <label><span>Latest summary</span><input name="latestSummary" defaultValue={ticket.latestSummary || ""} /></label>
        <label><span>Brief</span><textarea name="brief" defaultValue={ticket.brief} rows={3} /></label>
        <label><span>Acceptance criteria</span><textarea name="acceptanceCriteriaMd" defaultValue={ticket.acceptanceCriteriaMd || ""} rows={4} /></label>
        <label><span>Definition of done</span><textarea name="definitionOfDoneMd" defaultValue={ticket.definitionOfDoneMd || ""} rows={4} /></label>
        <button className="primary-button" type="submit">Save</button>
      </form>
    </section>
  );
}

function ScopeSection({
  projectId,
  ticket,
  repos,
  tickets,
  isEditing,
  onRefresh,
}: {
  projectId: string;
  ticket: TicketDetail;
  repos: Repo[];
  tickets: BoardTicket[];
  isEditing: boolean;
  onRefresh: (ticketId?: string) => Promise<void>;
}) {
  const availableRepos = repos.filter((repo) => !ticket.repoTargets.some((target) => target.repoId === repo.id));
  const dependencyCandidates = tickets.filter(
    (candidate) =>
      candidate.id !== ticket.id && !ticket.dependencies.some((dependency) => dependency.blockingTicketId === candidate.id),
  );

  async function addRepoTarget(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const repoId = String(form.get("repoId") || "");
    const repo = repos.find((candidate) => candidate.id === repoId);
    if (!repo) return;
    await updateTicket(projectId, ticket.id, {
      repoTargets: [
        ...ticket.repoTargets.map(toRepoTargetInput),
        {
          repoId,
          baseRef: String(form.get("baseRef") || repo.defaultBranch),
          branchName: String(form.get("branchName") || ""),
          targetScopeMd: String(form.get("targetScopeMd") || ""),
        },
      ],
    });
    await onRefresh(ticket.id);
    formElement.reset();
  }

  async function removeRepoTarget(repoId: string) {
    await updateTicket(projectId, ticket.id, {
      repoTargets: ticket.repoTargets.filter((target) => target.repoId !== repoId).map(toRepoTargetInput),
    });
    await onRefresh(ticket.id);
  }

  async function addBlocker(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const blockingTicketId = String(form.get("blockingTicketId") || "");
    if (!blockingTicketId) return;
    await addDependency(projectId, ticket.id, { blockingTicketId });
    await onRefresh(ticket.id);
    formElement.reset();
  }

  async function removeBlocker(dependencyId: string) {
    await removeDependency(projectId, ticket.id, dependencyId);
    await onRefresh(ticket.id);
  }

  return (
    <section className="detail-section">
      <div className="section-heading">
        <h3>Scope</h3>
        {!isEditing ? <span>Locked</span> : null}
      </div>
      <div className="compact-list">
        {ticket.repoTargets.map((target) => (
          <article key={target.repoId} className="compact-item split-item">
            <div>
              <strong>{target.repoName}</strong>
              <span>{target.repoSlug} · base {target.baseRef}{target.branchName ? ` · ${target.branchName}` : ""}</span>
            </div>
            {isEditing ? (
              <button className="icon-button danger-text" type="button" aria-label={`Remove ${target.repoName}`} title="Remove" onClick={() => removeRepoTarget(target.repoId)}>
                <X size={18} />
              </button>
            ) : null}
          </article>
        ))}
      </div>
      {isEditing ? (
        <form className="subform" onSubmit={addRepoTarget}>
          <div className="action-grid">
            <label><span>Add repo</span><select name="repoId" disabled={availableRepos.length === 0}>{availableRepos.map((repo) => <option key={repo.id} value={repo.id}>{repo.name}</option>)}</select></label>
            <label><span>Base ref</span><input name="baseRef" placeholder="default branch" /></label>
            <label><span>Branch</span><input name="branchName" placeholder="optional" /></label>
            <label className="wide-field"><span>Scope note</span><textarea name="targetScopeMd" rows={2} /></label>
          </div>
          <button className="quiet-button" type="submit" disabled={availableRepos.length === 0}>Add repo target</button>
        </form>
      ) : null}
      <div className="compact-list">
        {ticket.dependencies.map((dependency) => (
          <article key={dependency.id} className="compact-item split-item">
            <div>
              <strong>{dependency.blockingTicketKey} · {dependency.blockingTicketTitle}</strong>
              <span>{prettyState(dependency.blockingTicketState)} · {dependency.dependencyType}</span>
            </div>
            {isEditing ? (
              <button className="icon-button danger-text" type="button" aria-label={`Remove blocker ${dependency.blockingTicketKey}`} title="Remove" onClick={() => removeBlocker(dependency.id)}>
                <X size={18} />
              </button>
            ) : null}
          </article>
        ))}
      </div>
      {isEditing ? (
        <form className="subform inline-form" onSubmit={addBlocker}>
          <label><span>Add blocker</span><select name="blockingTicketId" disabled={dependencyCandidates.length === 0}>{dependencyCandidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.key} · {candidate.title}</option>)}</select></label>
          <button className="quiet-button" type="submit" disabled={dependencyCandidates.length === 0}>Add blocker</button>
        </form>
      ) : null}
    </section>
  );
}

function WorktreeAndArtifactSection({
  projectId,
  ticket,
  onRun,
  onRefresh,
  onFullRefresh,
}: {
  projectId: string;
  ticket: TicketDetail;
  onRun: (label: string, work: () => Promise<void>) => Promise<void>;
  onRefresh: (ticketId?: string) => Promise<void>;
  onFullRefresh: () => Promise<void>;
}) {
  const cleanableWorktrees = ticket.worktrees.filter((worktree) => worktree.status !== "active" && worktree.status !== "cleaned");
  return (
    <section className="detail-section">
      <div className="section-heading">
        <h3>Worktrees + Artifacts</h3>
        <span>{ticket.worktrees.length + ticket.artifacts.length}</span>
      </div>
      <div className="compact-list">
        {ticket.worktrees.length === 0 ? <p className="lane-empty">No worktrees planned yet.</p> : null}
        {ticket.worktrees.map((worktree) => (
          <article key={worktree.id} className="compact-item split-item">
            <div>
              <strong>{worktree.repoName} · {worktree.branchName}</strong>
              <span>{prettyState(worktree.status)} · {prettyRole(worktree.executionRole)} iter {worktree.executionIteration}</span>
              <code>{worktree.path}</code>
            </div>
            {cleanableWorktrees.some((candidate) => candidate.id === worktree.id) ? (
              <button
                className="quiet-button"
                type="button"
                onClick={() =>
                  onRun("Cleaning worktree", async () => {
                    await cleanWorktree(projectId, worktree.id);
                    await onRefresh(ticket.id);
                    await onFullRefresh();
                  })
                }
              >
                Mark cleaned
              </button>
            ) : null}
          </article>
        ))}
      </div>
      <div className="compact-list">
        {ticket.artifacts.length === 0 ? <p className="lane-empty">No durable artifacts recorded yet.</p> : null}
        {ticket.artifacts.map((artifact) => (
          <article key={artifact.id} className="compact-item">
            <strong>{artifact.label}</strong>
            <span>{artifact.kind} · {artifact.uri}</span>
          </article>
        ))}
      </div>
    </section>
  );
}

function TicketConversationSection({
  projectId,
  ticket,
  messages,
  pendingRequest,
  busy,
  onRun,
  onRefresh,
  onFullRefresh,
}: {
  projectId: string;
  ticket: TicketDetail;
  messages: AgentMessage[];
  pendingRequest?: AgentMessage;
  busy: string;
  onRun: (label: string, work: () => Promise<void>) => Promise<void>;
  onRefresh: (ticketId?: string) => Promise<void>;
  onFullRefresh: () => Promise<void>;
}) {
  const activeExecution = ticket.executions.find((execution) => execution.status === "running");
  const canStartFromComment = !activeExecution && (ticket.state === "READY" || ticket.state === "REWORK");
  const [commentMode, setCommentMode] = useState<"context" | "steer" | "dispatch">("context");
  const ticketMessages = collapseTicketConversationMessages(
    messages
      .filter((message) => message.target?.ticketId === ticket.id)
      .filter((message) => message.intent === "comment_on_ticket" || message.intent === "request_input")
      .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()),
    pendingRequest?.id,
  );
  const responders = Array.isArray(pendingRequest?.metadata?.suggestedResponders)
    ? pendingRequest.metadata.suggestedResponders.filter((value): value is string => typeof value === "string")
    : [];
  const blockedKind = typeof pendingRequest?.metadata?.blockedKind === "string" ? pendingRequest.metadata.blockedKind : "";
  const mode = pendingRequest ? "reply" : commentMode;
  const submitLabel =
    mode === "reply"
      ? "Reply and continue"
      : mode === "dispatch"
        ? "Start with comment"
        : mode === "steer"
          ? "Add steering note"
          : "Add comment";

  useEffect(() => {
    if ((commentMode === "steer" && !activeExecution) || (commentMode === "dispatch" && !canStartFromComment)) {
      setCommentMode("context");
    }
  }, [activeExecution, canStartFromComment, commentMode]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const body = String(form.get("body") || "").trim();
    if (!body) return;
    const requestedMode = String(form.get("commentMode") || "context");
    const safeMode =
      requestedMode === "steer" && activeExecution
        ? "steer"
        : requestedMode === "dispatch" && canStartFromComment
          ? "dispatch"
          : "context";
    await onRun(pendingRequest ? "Replying to agent" : submitLabel, async () => {
      if (pendingRequest) {
        await respondAgentMessage(projectId, pendingRequest.id, {
          responseMd: body,
          responderKind: "human",
          responderRef: "operator",
          continueExecution: form.get("continueExecution") === "on",
        });
      } else {
        const role = String(form.get("role") || ticket.assignedRole || "developer") as RoleName;
        const actor = "operator";
        const source = "human";
        if (safeMode === "steer" && activeExecution) {
          const canInterruptAndResume = activeExecution.harnessCapabilities?.includes("interrupt_and_resume") && activeExecution.externalThreadId;
          await steerExecution(projectId, activeExecution.id, {
            body,
            mode: canInterruptAndResume ? "hard_steer" : "soft_steer",
            actor,
            source,
          });
        } else {
          await createTicketComment(projectId, {
            ticketId: ticket.id,
            body,
            actor,
            source,
            summary: safeMode === "dispatch" ? `${ticket.key} start note` : `${ticket.key} comment`,
            metadata: {
              commentMode: safeMode,
              dispatchWithComment: safeMode === "dispatch",
              activeExecutionId: activeExecution?.id,
              role,
            },
          });
        }
        if (safeMode === "dispatch") {
          await startExecution(projectId, ticket.id, {
            role,
            reason: body,
          });
        }
      }
      formElement.reset();
      setCommentMode("context");
      await onRefresh(ticket.id);
      await onFullRefresh();
    });
  }

  return (
    <section className={`conversation-panel ${pendingRequest ? "has-pending-request" : ""}`}>
      <div className="conversation-head">
        <div>
          <p className="kicker">Conversation</p>
          <h3>{pendingRequest ? "Waiting for answer" : activeExecution ? "Comment or steer" : "Ticket comments"}</h3>
        </div>
        <span>
          {pendingRequest
            ? blockedKind.replace(/[_-]/g, " ")
            : activeExecution
              ? "active run"
              : canStartFromComment
                ? "ready"
                : "context only"}
        </span>
      </div>
      <div className="conversation-thread">
        {ticketMessages.length === 0 ? (
          <p className="lane-empty">No comments yet. Add context, steer active work, or start the next run from here.</p>
        ) : null}
        {ticketMessages.map((message) => (
          <ConversationItem key={message.id} message={message} pending={pendingRequest?.id === message.id} />
        ))}
      </div>
      <form className="conversation-composer" onSubmit={handleSubmit}>
        {!pendingRequest ? (
          <div className="conversation-mode-row" role="radiogroup" aria-label="Comment action">
            <label className={`conversation-mode ${commentMode === "context" ? "is-active" : ""}`}>
              <input
                type="radio"
                name="commentMode"
                value="context"
                checked={commentMode === "context"}
                onChange={() => setCommentMode("context")}
              />
              <span>Add note</span>
              <small>Save context for the ticket.</small>
            </label>
            {activeExecution ? (
              <label className={`conversation-mode ${commentMode === "steer" ? "is-active" : ""}`}>
                <input
                  type="radio"
                  name="commentMode"
                  value="steer"
                  checked={commentMode === "steer"}
                  onChange={() => setCommentMode("steer")}
                />
                <span>Steer run</span>
                <small>Send this to the active agent.</small>
              </label>
            ) : null}
            {canStartFromComment ? (
              <label className={`conversation-mode ${commentMode === "dispatch" ? "is-active" : ""}`}>
                <input
                  type="radio"
                  name="commentMode"
                  value="dispatch"
                  checked={commentMode === "dispatch"}
                  onChange={() => setCommentMode("dispatch")}
                />
                <span>Start work</span>
                <small>Dispatch an agent with this note.</small>
              </label>
            ) : null}
          </div>
        ) : null}
        <label>
          <span>{pendingRequest ? "Answer" : "Comment"}</span>
          <textarea
            name="body"
            rows={3}
            required
            placeholder={
              pendingRequest
                ? "Answer the agent so this lane can continue."
                : activeExecution
                  ? "Add context for the ticket or steer the active run."
                  : canStartFromComment
                    ? "Add context or start work with this note."
                    : "Add context. This will not dispatch work."
            }
          />
        </label>
        <div className="conversation-composer-actions">
          {!pendingRequest && commentMode === "dispatch" ? (
            <label>
              <span>Agent</span>
              <select name="role" defaultValue={ticket.assignedRole || "developer"}>
                <option value="product_manager">PM</option>
                <option value="architect">Architect</option>
                <option value="developer">Developer</option>
                <option value="reviewer">Reviewer</option>
                <option value="validator">Validator</option>
                <option value="integrator">Integrator</option>
              </select>
            </label>
          ) : null}
          <button className="primary-button" type="submit" disabled={Boolean(busy)}>
            {busy || submitLabel}
          </button>
        </div>
        {pendingRequest ? (
          <>
            {responders.length ? (
              <div className="responder-strip" aria-label="Suggested responders">
                {responders.map((responder) => (
                  <span key={responder}>{prettyRole(responder as RoleName)}</span>
                ))}
              </div>
            ) : null}
            <label className="checkbox-row">
              <input name="continueExecution" type="checkbox" defaultChecked />
              <span>Continue the blocked lane after this answer</span>
            </label>
          </>
        ) : null}
      </form>
    </section>
  );
}

function collapseTicketConversationMessages(messages: AgentMessage[], pendingRequestId?: string) {
  const requestIdsWithMirror = new Set(
    messages
      .filter((message) => message.intent === "comment_on_ticket" && typeof message.metadata?.requestInputMessageId === "string")
      .map((message) => String(message.metadata.requestInputMessageId)),
  );
  return messages.filter((message) => {
    if (message.intent !== "request_input") return true;
    if (message.id === pendingRequestId) return true;
    return !requestIdsWithMirror.has(message.id);
  });
}

function ConversationItem({ message, pending }: { message: AgentMessage; pending: boolean }) {
  const isQuestion = message.intent === "request_input" || message.metadata?.hitlQuestion === true;
  const isAnswer = message.metadata?.unblockResponse === true;
  const isSteering = message.metadata?.steeringNote === true;
  const isDispatch = message.metadata?.dispatchWithComment === true;
  const tone = pending ? "attention" : isAnswer || isDispatch ? "done" : isQuestion || isSteering ? "attention" : "neutral";
  const label = pending
    ? "Waiting"
    : isAnswer
      ? "Answer"
      : isDispatch
        ? "Started"
        : isQuestion
          ? "Question"
          : isSteering
            ? "Steer"
            : "Comment";
  return (
    <article className={`conversation-item tone-${tone}`}>
      <StateDot tone={tone as Tone} />
      <div>
        <span>{label} · {formatDate(message.createdAt)}</span>
        <strong>{message.summary || label}</strong>
        {message.body ? <p>{message.body}</p> : null}
      </div>
    </article>
  );
}

function TicketDangerZone({
  projectId,
  ticket,
  busy,
  onRun,
  onRefresh,
  onFullRefresh,
}: {
  projectId: string;
  ticket: TicketDetail;
  busy: string;
  onRun: (label: string, work: () => Promise<void>) => Promise<void>;
  onRefresh: (ticketId?: string) => Promise<void>;
  onFullRefresh: () => Promise<void>;
}) {
  const [confirmation, setConfirmation] = useState("");
  const activeRuns = ticket.executions.filter((execution) => execution.status === "running").length;
  const deletableWorktrees = ticket.worktrees.filter((worktree) => worktree.status !== "cleaned").length;
  const canRestart = confirmation === ticket.key && !busy;

  async function handleRestart(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canRestart) return;
    await onRun("Restarting ticket", async () => {
      await restartTicket(projectId, ticket.id, {
        reason: `Restarted ${ticket.key} from ticket detail. Cancelled ${activeRuns} active run(s) and deleted ${deletableWorktrees} worktree(s).`,
      });
      setConfirmation("");
      await onRefresh(ticket.id);
      await onFullRefresh();
    });
  }

  return (
    <section className="detail-section danger-card">
      <div className="section-heading">
        <h3>Danger Zone</h3>
        <span>Restart</span>
      </div>
      <p>
        Restarting moves this ticket back to Ready, cancels active runs, and deletes any recorded worktree directories for this ticket.
      </p>
      <form className="subform inline-form" onSubmit={handleRestart}>
        <label>
          <span>Type {ticket.key} to confirm</span>
          <input name="restartConfirmation" value={confirmation} onChange={(event) => setConfirmation(event.currentTarget.value)} />
        </label>
        <button className="danger-button" type="submit" disabled={!canRestart}>
          Restart ticket
        </button>
      </form>
    </section>
  );
}

function toRepoTargetInput(target: { repoId: string; baseRef: string; branchName?: string; targetScopeMd?: string }) {
  return {
    repoId: target.repoId,
    baseRef: target.baseRef,
    branchName: target.branchName || "",
    targetScopeMd: target.targetScopeMd || "",
  };
}

function TicketActionForm({
  projectId,
  ticket,
  busy,
  onRun,
  onRefresh,
}: {
  projectId: string;
  ticket: TicketDetail;
  busy: string;
  onRun: (label: string, work: () => Promise<void>) => Promise<void>;
  onRefresh: (ticketId?: string) => Promise<void>;
}) {
  if (ticket.state !== "READY" && ticket.state !== "REWORK") {
    return null;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const role = String(form.get("role") || ticket.assignedRole || "developer") as RoleName;
    await onRun("Dispatching agent", async () => {
      await startExecution(projectId, ticket.id, {
        role,
        reason: String(form.get("summary") || `Dispatch ${prettyRole(role)} for ${ticket.key}`),
      });
      await onRefresh(ticket.id);
      formElement.reset();
    });
  }

  return (
    <ActionDock
      label="Dispatch"
      detail="Choose who should work next. The note is optional."
      busy={Boolean(busy)}
      disabled={Boolean(busy)}
      defaultOpen
    >
      <form className="action-form dispatch-action-form" onSubmit={handleSubmit}>
        <label>
          <span>Agent</span>
          <select name="role" defaultValue={ticket.assignedRole || "developer"}>
            {roles.map((role) => (
              <option key={role} value={role}>
                {prettyRole(role)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Why</span>
          <textarea name="summary" rows={2} placeholder="Optional instruction or constraint for this run." />
        </label>
        <button className="primary-button" type="submit" disabled={Boolean(busy)}>
          {busy || "Dispatch agent"}
        </button>
      </form>
    </ActionDock>
  );
}

function ManualTicketActionForm({
  projectId,
  ticket,
  busy,
  onRun,
  onRefresh,
}: {
  projectId: string;
  ticket: TicketDetail;
  busy: string;
  onRun: (label: string, work: () => Promise<void>) => Promise<void>;
  onRefresh: (ticketId?: string) => Promise<void>;
}) {
  const activeExecution = ticket.executions.find((execution) => execution.status === "running");
  const latestCompletedExecution = ticket.executions.find(
    (execution) => execution.status === "completed" && execution.outcome === "completed",
  );
  const submitLabel = busy || primaryActionLabel(ticket);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    await onRun(primaryActionLabel(ticket), async () => {
      if (ticket.state === "READY" || ticket.state === "REWORK") {
        await startExecution(projectId, ticket.id, {
          role: String(form.get("role") || ticket.assignedRole || "developer") as RoleName,
          reason: String(form.get("summary") || `Start ${ticket.key}`),
        });
      } else if (ticket.state === "WORKING" && activeExecution) {
        await completeExecution(projectId, activeExecution.id, {
          outcome: String(form.get("outcome") || "completed"),
          summaryMd: String(form.get("summary") || `${ticket.key} execution updated.`),
          blockedKind: String(form.get("outcome")) === "blocked" ? "needs_human_input" : "",
        });
      } else if (ticket.state === "REVIEWING" && latestCompletedExecution) {
        await createReview(projectId, ticket.id, {
          executionId: latestCompletedExecution.id,
          verdict: String(form.get("verdict") || "passed"),
          summaryMd: String(form.get("summary") || `${ticket.key} review recorded.`),
        });
      } else if (ticket.state === "VALIDATING") {
        await createValidation(projectId, ticket.id, {
          executionId: latestCompletedExecution?.id,
          repoIds: ticket.repoTargets.map((target) => target.repoId),
          verdict: String(form.get("verdict") || "passed"),
          commandProfile: String(form.get("commandProfile") || "ci"),
          commands: String(form.get("commands") || "").split("\n").map((line) => line.trim()).filter(Boolean),
          summaryMd: String(form.get("summary") || `${ticket.key} validation recorded.`),
        });
      } else if (ticket.state === "READY_TO_MERGE") {
        await mergeTicket(projectId, ticket.id, {
          strategy: "squash",
          status: "completed",
          approvedByKind: ticket.mergeStatus.requiresHumanApproval ? "human" : "system",
          approvedByRef: String(form.get("approvedByRef") || "operator"),
          summaryMd: String(form.get("summary") || `${ticket.key} merge recorded.`),
        });
      } else {
        await transitionTicket(projectId, ticket.id, {
          targetState: String(form.get("targetState") || "READY") as TicketState,
          reason: String(form.get("summary") || `Move ${ticket.key}`),
          reasonCode: "operator_ticket_action",
        });
      }
      await onRefresh(ticket.id);
      formElement.reset();
    });
  }

  return (
    <ActionDock
      label="Manual lane control"
      detail={`${primaryActionLabel(ticket)} · advanced override.`}
      busy={Boolean(busy)}
      disabled={!canSubmitPrimaryAction(ticket, activeExecution, latestCompletedExecution)}
      defaultOpen
    >
      <form className="action-form" onSubmit={handleSubmit}>
        <ActionFields ticket={ticket} activeExecution={activeExecution} latestCompletedExecution={latestCompletedExecution} />
        <label>
          <span>Why</span>
          <textarea name="summary" rows={2} placeholder="Optional note for audit history." />
        </label>
        <button className="primary-button" type="submit" disabled={Boolean(busy) || !canSubmitPrimaryAction(ticket, activeExecution, latestCompletedExecution)}>
          {submitLabel}
        </button>
      </form>
    </ActionDock>
  );
}

function ActionFields({
  ticket,
  activeExecution,
  latestCompletedExecution,
}: {
  ticket: TicketDetail;
  activeExecution?: { id: string } | undefined;
  latestCompletedExecution?: { id: string } | undefined;
}) {
  if (ticket.state === "READY" || ticket.state === "REWORK") {
    return (
      <label>
        <span>Execution role</span>
        <select name="role" defaultValue={ticket.assignedRole || "developer"}>
          {roles.map((role) => (
            <option key={role} value={role}>
              {prettyRole(role)}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (ticket.state === "WORKING") {
    return (
      <label>
        <span>{activeExecution ? "Execution outcome" : "No active execution"}</span>
        <select name="outcome" defaultValue="completed" disabled={!activeExecution}>
          <option value="completed">Completed</option>
          <option value="needs_continue">Needs continue</option>
          <option value="blocked">Blocked</option>
          <option value="failed">Failed</option>
        </select>
      </label>
    );
  }
  if (ticket.state === "REVIEWING") {
    return (
      <label>
        <span>{latestCompletedExecution ? "Review verdict" : "Waiting for completed execution"}</span>
        <select name="verdict" defaultValue="passed" disabled={!latestCompletedExecution}>
          <option value="passed">Passed</option>
          <option value="rework">Rework</option>
          <option value="blocked">Blocked</option>
        </select>
      </label>
    );
  }
  if (ticket.state === "VALIDATING") {
    return (
      <div className="action-grid">
        <label>
          <span>Validation verdict</span>
          <select name="verdict" defaultValue="passed">
            <option value="passed">Passed</option>
            <option value="failed">Failed</option>
            <option value="blocked">Blocked</option>
          </select>
        </label>
        <label>
          <span>Command profile</span>
          <input name="commandProfile" defaultValue="ci" />
        </label>
        <label className="wide-field">
          <span>Commands</span>
          <textarea name="commands" rows={2} placeholder="One command per line" />
        </label>
      </div>
    );
  }
  if (ticket.state === "READY_TO_MERGE") {
    return (
      <label>
        <span>{ticket.mergeStatus.requiresHumanApproval ? "Approval reference" : "Merge reference"}</span>
        <input name="approvedByRef" defaultValue={ticket.mergeStatus.requiresHumanApproval ? "" : "floop-auto"} placeholder="operator, initials, or ticket approval" />
      </label>
    );
  }
  return (
    <label>
      <span>Move ticket to</span>
      <select name="targetState" defaultValue="READY">
        {ticketStates.map((state) => (
          <option key={state} value={state}>
            {prettyState(state)}
          </option>
        ))}
      </select>
    </label>
  );
}

function primaryActionLabel(ticket: TicketDetail) {
  switch (ticket.state) {
    case "READY":
    case "REWORK":
      return "Start run";
    case "WORKING":
      return "Record outcome";
    case "REVIEWING":
      return "Record review";
    case "VALIDATING":
      return "Record validation";
    case "READY_TO_MERGE":
      return "Record merge";
    default:
      return "Move ticket";
  }
}

function canSubmitPrimaryAction(
  ticket: TicketDetail,
  activeExecution?: { id: string } | undefined,
  latestCompletedExecution?: { id: string } | undefined,
) {
  if (ticket.state === "WORKING") return Boolean(activeExecution);
  if (ticket.state === "REVIEWING") return Boolean(latestCompletedExecution);
  if (ticket.state === "READY_TO_MERGE") return Boolean(ticket.mergeStatus?.canMerge);
  return true;
}

function EvidenceList({ ticket }: { ticket: TicketDetail }) {
  const latestExecution = ticket.executions[0];
  const latestReview = ticket.reviews[0];
  const latestValidation = ticket.validations[0];
  return (
    <div className="evidence-list">
      <EvidenceItem label="Execution" value={latestExecution?.summaryMd || "No execution evidence yet"} meta={latestExecution?.outcome || ""} />
      <EvidenceItem label="Review" value={latestReview?.summaryMd || "No review evidence yet"} meta={latestReview?.verdict || ""} />
      <EvidenceItem
        label="Validation"
        value={latestValidation?.summaryMd || "No validation evidence yet"}
        meta={latestValidation?.commandProfile || latestValidation?.verdict || ""}
      />
    </div>
  );
}

function EvidenceItem({ label, value, meta }: { label: string; value: string; meta: string }) {
  return (
    <article className="evidence-item">
      <span>{label}</span>
      <strong>{value}</strong>
      {meta ? <small>{meta}</small> : null}
    </article>
  );
}

function ticketPhaseItems(ticket: BoardTicket | TicketDetail): PhaseItem[] {
  const phases: Array<{ id: string; label: string; states: TicketState[] }> = [
    { id: "plan", label: "Plan", states: ["PROPOSED", "READY"] },
    { id: "run", label: "Run", states: ["WORKING", "REWORK", "BLOCKED"] },
    { id: "review", label: "Review", states: ["REVIEWING"] },
    { id: "validate", label: "Validate", states: ["VALIDATING"] },
    { id: "merge", label: "Merge", states: ["READY_TO_MERGE", "MERGING"] },
    { id: "done", label: "Done", states: ["DONE"] },
  ];
  const currentIndex = Math.max(0, phases.findIndex((phase) => phase.states.includes(ticket.state)));
  return phases.map((phase, index) => {
    const current = index === currentIndex;
    const complete = ticket.state === "DONE" || index < currentIndex;
    const attention = ticket.state === "BLOCKED" || ticket.state === "REWORK";
    return {
      id: phase.id,
      label: phase.label,
      current,
      complete,
      tone: complete ? "done" : current ? attention ? "attention" : "active" : "neutral",
    };
  });
}

function buildTicketEvidence(ticket: TicketDetail): VisualEvidenceItem[] {
  const latestExecution = ticket.executions[0];
  const latestReview = ticket.reviews[0];
  const latestValidation = ticket.validations[0];
  return [
    {
      id: "execution",
      label: "Execution",
      summary: latestExecution?.summaryMd || "No execution evidence",
      meta: latestExecution?.outcome || "",
      tone: latestExecution ? toneForStatus(latestExecution.outcome || latestExecution.status) : ticket.state === "WORKING" ? "active" : "neutral",
    },
    {
      id: "review",
      label: "Review",
      summary: latestReview?.summaryMd || "No review evidence",
      meta: latestReview?.verdict || "",
      tone: latestReview ? toneForStatus(latestReview.verdict) : ticket.state === "REVIEWING" ? "active" : "neutral",
    },
    {
      id: "validation",
      label: "Validation",
      summary: latestValidation?.summaryMd || "No validation evidence",
      meta: latestValidation?.commandProfile || latestValidation?.verdict || "",
      tone: latestValidation ? toneForStatus(latestValidation.verdict) : ticket.state === "VALIDATING" ? "active" : "neutral",
    },
    {
      id: "merge",
      label: "Merge",
      summary: ticket.mergeStatus?.statusSummary || (ticket.mergeStatus?.canMerge ? "Ready to merge" : "Merge gate waiting"),
      meta: ticket.mergeStatus?.requiresHumanApproval ? "Human approval" : "",
      tone: ticket.mergeStatus?.canMerge ? "done" : ticket.mergeStatus?.blockingReasons?.length ? "attention" : "neutral",
    },
  ];
}

function buildTicketChecklist(ticket: TicketDetail): ChecklistItem[] {
  const parsed = [
    ...parseChecklistLines(ticket.acceptanceCriteriaMd, "Acceptance"),
    ...parseChecklistLines(ticket.definitionOfDoneMd, "Done"),
  ].slice(0, 6);
  const fallback = [
    { id: "brief", label: "Brief", detail: ticket.brief || "No brief recorded", complete: Boolean(ticket.brief), tone: "done" as Tone },
    { id: "acceptance", label: "Acceptance criteria", detail: ticket.acceptanceCriteriaMd || "No criteria recorded", complete: Boolean(ticket.acceptanceCriteriaMd), tone: ticket.acceptanceCriteriaMd ? "done" as Tone : "neutral" as Tone },
    { id: "definition", label: "Definition of done", detail: ticket.definitionOfDoneMd || "No definition recorded", complete: Boolean(ticket.definitionOfDoneMd), tone: ticket.definitionOfDoneMd ? "done" as Tone : "neutral" as Tone },
  ];
  const evidence = [
    { id: "execution-evidence", label: "Execution evidence", detail: ticket.executions[0]?.summaryMd || "Waiting for run output", complete: ticket.executions.length > 0, tone: ticket.executions.length > 0 ? "done" as Tone : "active" as Tone },
    { id: "review-evidence", label: "Review evidence", detail: ticket.reviews[0]?.verdict || "Waiting for review", complete: ticket.reviews.length > 0, tone: ticket.reviews.length > 0 ? "done" as Tone : "neutral" as Tone },
    { id: "validation-evidence", label: "Validation evidence", detail: ticket.validations[0]?.verdict || "Waiting for validation", complete: ticket.validations.length > 0, tone: ticket.validations.length > 0 ? "done" as Tone : "neutral" as Tone },
    { id: "merge-evidence", label: "Merge readiness", detail: ticket.mergeStatus?.statusSummary || "Waiting for merge gate", complete: Boolean(ticket.mergeStatus?.canMerge), tone: ticket.mergeStatus?.canMerge ? "done" as Tone : "attention" as Tone },
  ];
  return [...(parsed.length ? parsed : fallback), ...evidence].slice(0, 8);
}

function parseChecklistLines(value: string, prefix: string): ChecklistItem[] {
  return String(value || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const checked = /^\s*[-*]?\s*\[[xX]\]/.test(line);
      const cleaned = line.replace(/^[-*]\s*/, "").replace(/^\[[ xX]\]\s*/, "");
      return {
        id: `${prefix.toLowerCase()}-${index}`,
        label: cleaned,
        detail: prefix,
        complete: checked,
        tone: checked ? "done" : "neutral",
      };
    });
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="fact">
      <span>{label}</span>
      <strong>{value || "None"}</strong>
    </div>
  );
}

function TicketComposer({
  repos,
  onSubmit,
  onCancel,
}: {
  repos: Repo[];
  onSubmit: (input: {
    title: string;
    brief: string;
    priority: string;
    state: string;
    assignedRole: string;
    repoId: string;
  }) => Promise<void>;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      await onSubmit({
        title: String(form.get("title") || ""),
        brief: String(form.get("brief") || ""),
        priority: String(form.get("priority") || "medium"),
        state: String(form.get("state") || "READY"),
        assignedRole: String(form.get("assignedRole") || "developer"),
        repoId: String(form.get("repoId") || ""),
      });
      formElement.reset();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="ticket-composer" onSubmit={handleSubmit}>
      <div className="composer-heading">
        <h3>New Ticket</h3>
        <button className="icon-button" type="button" aria-label="Close composer" title="Close" onClick={onCancel}>
          <X size={18} />
        </button>
      </div>
      {error ? <div className="status is-error">{error}</div> : null}
      <label className="wide-field">
        <span>Title</span>
        <input name="title" required maxLength={120} />
      </label>
      <input type="hidden" name="state" value="READY" />
      <label>
        <span>Brief</span>
        <textarea name="brief" required rows={3} />
      </label>
      <details className="advanced-disclosure">
        <summary>Ticket settings</summary>
        <div className="form-grid">
          <label>
            <span>Repo</span>
            <select name="repoId">
              {repos.map((repo) => (
                <option key={repo.id} value={repo.id}>
                  {repo.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Priority</span>
            <select name="priority" defaultValue="medium">
              {priorities.map((priority) => (
                <option key={priority} value={priority}>
                  {priority}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Role</span>
            <select name="assignedRole" defaultValue="developer">
              {roles.map((role) => (
                <option key={role} value={role}>
                  {prettyRole(role)}
                </option>
              ))}
            </select>
          </label>
        </div>
      </details>
      <div className="composer-actions">
        <button className="primary-button" type="submit" disabled={busy}>
          {busy ? "Creating..." : "Create ticket"}
        </button>
      </div>
    </form>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
