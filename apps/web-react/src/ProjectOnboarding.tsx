import React, { ChangeEvent, FormEvent, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { browseDirectories, cloneRepo, createDirectory, detectRepo } from "./api";
import { StatusMeter } from "./OperationalVisuals";
import type { ProjectCreateInput, RepoInput } from "./types";

type WorkspaceSourceMode = "existing" | "new" | "clone";
type ProjectDetailField = "name" | "slug" | "defaultBaseBranch";
type ProjectDetails = Record<ProjectDetailField, string>;

declare global {
  interface Window {
    floopDesktop?: {
      desktop?: boolean;
      platform?: string;
      pickDirectory?: () => Promise<string>;
    };
  }
}

export function ProjectEmptyState({ onCreateProject }: { onCreateProject: () => void }) {
  return (
    <section className="empty-state project-empty-state">
      <div>
        <h3>No project selected</h3>
        <p>Create a Floop project to register local repos, write tickets, and run the governed delivery loop.</p>
      </div>
      <button className="primary-button" type="button" onClick={onCreateProject}>
        Create project
      </button>
    </section>
  );
}

export function ProjectOnboardingDialog({
  isOpen,
  onClose,
  onSubmit,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (input: { project: ProjectCreateInput; repo: RepoInput | null }) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sourceMode, setSourceMode] = useState<WorkspaceSourceMode>("existing");
  const [pathSuggestions, setPathSuggestions] = useState<{ fieldName: string; paths: string[]; mode: "children" | "matches" } | null>(null);
  const [projectDetails, setProjectDetails] = useState<ProjectDetails>({ name: "", slug: "", defaultBaseBranch: "" });
  const touchedDetailsRef = useRef<Record<ProjectDetailField, boolean>>({ name: false, slug: false, defaultBaseBranch: false });
  const sourceDetectionRun = useRef(0);
  const canPickDirectory = typeof window.floopDesktop?.pickDirectory === "function";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setBusy(true);
    setError("");
    try {
      let workspaceRoot = String(form.get("existingPath") || "").trim();
      let repo: RepoInput | null;
      if (sourceMode === "existing") {
        repo = await detectRepo(workspaceRoot);
      } else if (sourceMode === "new") {
        workspaceRoot = String(form.get("newFolderPath") || "").trim();
        await createDirectory(workspaceRoot);
        repo = null;
      } else {
        workspaceRoot = String(form.get("repoClonePath") || "").trim();
        repo = await cloneRepo(
          String(form.get("repoRemoteUrl") || "").trim(),
          workspaceRoot,
        );
      }
      const projectName = projectDetails.name.trim() || repo?.name || pathLeaf(workspaceRoot) || "Floop Project";
      const projectSlug = projectDetails.slug.trim() || slugify(projectName);

      await onSubmit({
        project: {
          name: projectName,
          slug: projectSlug,
          workspaceRoot,
          defaultBaseBranch: (projectDetails.defaultBaseBranch || repo?.defaultBranch || "main").trim(),
          description: String(form.get("description") || "").trim(),
        },
        repo,
      });
      formElement.reset();
      resetProjectDetails();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError));
    } finally {
      setBusy(false);
    }
  }

  async function pickDirectory(targetName: string) {
    const directory = await window.floopDesktop?.pickDirectory?.();
    if (!directory) return;
    setPathInput(targetName, directory);
    void deriveDetailsFromPathInput(targetName, directory);
  }

  async function refreshPathSuggestions(fieldName: string, value: string) {
    const trimmed = value.trim();
    if (trimmed) {
      try {
        const listing = await browseDirectories(trimmed);
        setPathSuggestions({
          fieldName,
          mode: "children",
          paths: listing.entries.map((entry) => entry.path),
        });
        return;
      } catch {
        // Fall back to stem matching below.
      }
    }

    const { parentPath, fragment } = splitPathForSuggestions(value);
    try {
      const listing = await browseDirectories(parentPath);
      const normalizedFragment = fragment.toLowerCase();
      setPathSuggestions({
        fieldName,
        mode: "matches",
        paths: listing.entries
          .filter((entry) => !normalizedFragment || entry.name.toLowerCase().startsWith(normalizedFragment))
          .map((entry) => entry.path),
      });
    } catch {
      setPathSuggestions(null);
    }
  }

  function handleRemoteUrlChange(event: ChangeEvent<HTMLInputElement>) {
    const form = event.currentTarget.form;
    const destination = form?.elements.namedItem("repoClonePath");
    const repoName = repoNameFromRemote(event.currentTarget.value);
    if (!(destination instanceof HTMLInputElement) || !repoName) return;
    if (destination.value && destination.dataset.autofilled !== "true") return;
    destination.value = `~/src/${repoName}`;
    destination.dataset.autofilled = "true";
    destination.dispatchEvent(new Event("input", { bubbles: true }));
    destination.dispatchEvent(new Event("change", { bubbles: true }));
    applyDerivedDetails({ name: titleize(repoName), slug: slugify(repoName), defaultBaseBranch: "main" });
    void refreshPathSuggestions("repoClonePath", destination.value);
  }

  function handlePathChange(event: ChangeEvent<HTMLInputElement>) {
    event.currentTarget.dataset.autofilled = "false";
    void refreshPathSuggestions(event.currentTarget.name, event.currentTarget.value);
    void deriveDetailsFromPathInput(event.currentTarget.name, event.currentTarget.value);
  }

  function handlePathFocus(event: ChangeEvent<HTMLInputElement>) {
    void refreshPathSuggestions(event.currentTarget.name, event.currentTarget.value);
  }

  function choosePathSuggestion(fieldName: string, path: string) {
    const nextPath = ensureTrailingSlash(path);
    setPathInput(fieldName, nextPath);
    void deriveDetailsFromPathInput(fieldName, path);
    void refreshPathSuggestions(fieldName, nextPath);
  }

  async function deriveDetailsFromPathInput(fieldName: string, path: string) {
    const source = sourceForPathField(fieldName);
    if (!source) return;
    const run = (sourceDetectionRun.current += 1);
    if (source === "existing") {
      try {
        const repo = await detectRepo(path);
        if (run !== sourceDetectionRun.current) return;
        if (repo) {
          applyDerivedDetails({ name: repo.name, slug: repo.slug, defaultBaseBranch: repo.defaultBranch });
        } else {
          deriveDetailsFromPath(path);
        }
      } catch {
        if (run === sourceDetectionRun.current) deriveDetailsFromPath(path);
      }
      return;
    }
    deriveDetailsFromPath(path);
  }

  function deriveDetailsFromPath(path: string) {
    const name = pathLeaf(path);
    if (!name) return;
    applyDerivedDetails({ name: titleize(name), slug: slugify(name), defaultBaseBranch: "main" });
  }

  function applyDerivedDetails(next: Partial<ProjectDetails>) {
    setProjectDetails((current) => {
      const touched = touchedDetailsRef.current;
      const name = touched.name ? current.name : next.name ?? current.name;
      return {
        name,
        slug: touched.slug ? current.slug : next.slug ?? (name ? slugify(name) : current.slug),
        defaultBaseBranch: touched.defaultBaseBranch ? current.defaultBaseBranch : next.defaultBaseBranch ?? current.defaultBaseBranch,
      };
    });
  }

  function updateProjectDetail(field: ProjectDetailField, value: string) {
    touchedDetailsRef.current = { ...touchedDetailsRef.current, [field]: true };
    setProjectDetails((current) => ({
      ...current,
      [field]: value,
      slug: field === "name" && !touchedDetailsRef.current.slug ? slugify(value) : current.slug,
    }));
  }

  function resetProjectDetails() {
    setProjectDetails({ name: "", slug: "", defaultBaseBranch: "" });
    touchedDetailsRef.current = { name: false, slug: false, defaultBaseBranch: false };
  }

  function changeSourceMode(mode: WorkspaceSourceMode) {
    setSourceMode(mode);
    setPathSuggestions(null);
    sourceDetectionRun.current += 1;
  }

  function generateSlug() {
    touchedDetailsRef.current = { ...touchedDetailsRef.current, slug: true };
    setProjectDetails((current) => ({ ...current, slug: slugify(current.name) }));
  }

  function setPathInput(targetName: string, path: string) {
    const input = document.querySelector<HTMLInputElement>(`.onboarding-dialog input[name="${targetName}"]`);
    if (!input) return;
    input.value = path;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  return (
    <Dialog.Root open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-scrim" />
        <Dialog.Content className="onboarding-dialog" aria-label="New project onboarding">
          <Dialog.Description className="sr-only">
            Create a Floop project from an existing folder, new folder, or fresh clone.
          </Dialog.Description>
          <div className="drawer-heading">
            <div>
              <p className="kicker">Project Onboarding</p>
              <Dialog.Title asChild>
                <h2>New project</h2>
              </Dialog.Title>
            </div>
            <button className="icon-button" type="button" aria-label="Close onboarding" onClick={onClose}>
              <X size={18} />
            </button>
          </div>
          {error ? <div className="status is-error">{error}</div> : null}
          <form className="onboarding-form" onSubmit={handleSubmit}>
            <section className="setup-meter" aria-label="Project setup progress">
              <StatusMeter
                items={[
                  { id: "source", label: "Source", value: sourceMode ? 1 : 0, tone: sourceMode ? "done" : "neutral" },
                  { id: "details", label: "Details", value: projectDetails.name || projectDetails.slug ? 1 : 0, tone: projectDetails.name || projectDetails.slug ? "active" : "neutral" },
                  { id: "repo", label: "Repo", value: sourceMode === "new" || projectDetails.defaultBaseBranch ? 1 : 0, tone: sourceMode === "new" || projectDetails.defaultBaseBranch ? "attention" : "neutral" },
                ]}
              />
              <div className="setup-checklist" aria-label="Project readiness">
                <span className="is-done">Source</span>
                <span className={projectDetails.name ? "is-done" : ""}>Name</span>
                <span className={projectDetails.slug ? "is-done" : ""}>Slug</span>
                <span className={projectDetails.defaultBaseBranch || sourceMode === "new" ? "is-done" : ""}>Branch</span>
              </div>
            </section>
            <section className="settings-card">
              <div className="section-heading">
                <div>
                  <h3>Workspace source</h3>
                  <span className="section-note">Required</span>
                </div>
              </div>
              <div className="repo-mode-list" aria-label="Workspace source">
                <label className={`mode-pill ${sourceMode === "existing" ? "active" : ""}`}>
                  <input type="radio" name="workspaceSourceMode" value="existing" checked={sourceMode === "existing"} onChange={() => changeSourceMode("existing")} />
                  <strong>Existing folder</strong>
                  <span>Use a local folder. If it is git, Floop attaches it as primary.</span>
                </label>
                <label className={`mode-pill ${sourceMode === "new" ? "active" : ""}`}>
                  <input type="radio" name="workspaceSourceMode" value="new" checked={sourceMode === "new"} onChange={() => changeSourceMode("new")} />
                  <strong>New local folder</strong>
                  <span>Create an empty workspace now and add repos later.</span>
                </label>
                <label className={`mode-pill ${sourceMode === "clone" ? "active" : ""}`}>
                  <input type="radio" name="workspaceSourceMode" value="clone" checked={sourceMode === "clone"} onChange={() => changeSourceMode("clone")} />
                  <strong>Fresh clone</strong>
                  <span>Clone a remote repo. The clone becomes the workspace.</span>
                </label>
              </div>
              <div className="action-grid">
                {sourceMode === "existing" ? (
                  <label className="wide-field">
                    <span>Folder</span>
                    <span className="input-with-action">
                      <input name="existingPath" placeholder="/home/me/src/project" required={sourceMode === "existing"} onChange={handlePathChange} onFocus={handlePathFocus} />
                      {canPickDirectory ? <button className="quiet-button" type="button" onClick={() => pickDirectory("existingPath")}>
                        Browse
                      </button> : null}
                    </span>
                    <small className="field-help">
                      Floop checks this folder for git metadata. Non-git folders are still valid project workspaces.
                    </small>
                    <PathSuggestions fieldName="existingPath" />
                  </label>
                ) : sourceMode === "new" ? (
                  <label className="wide-field">
                    <span>New folder path</span>
                    <span className="input-with-action">
                      <input name="newFolderPath" placeholder="/home/me/src/new-project" required={sourceMode === "new"} onChange={handlePathChange} onFocus={handlePathFocus} />
                      {canPickDirectory ? <button className="quiet-button" type="button" onClick={() => pickDirectory("newFolderPath")}>
                        Browse
                      </button> : null}
                    </span>
                    <small className="field-help">Floop creates this folder if it does not already exist.</small>
                    <PathSuggestions fieldName="newFolderPath" />
                  </label>
                ) : (
                  <>
                    <label className="wide-field">
                      <span>Remote URL</span>
                      <input name="repoRemoteUrl" placeholder="https://github.com/org/repo.git" required={sourceMode === "clone"} onChange={handleRemoteUrlChange} />
                    </label>
                    <label className="wide-field">
                      <span>Clone destination</span>
                      <span className="input-with-action">
                        <input name="repoClonePath" placeholder="~/src/repo" required={sourceMode === "clone"} onChange={handlePathChange} onFocus={handlePathFocus} />
                        {canPickDirectory ? <button className="quiet-button" type="button" onClick={() => pickDirectory("repoClonePath")}>
                          Browse
                        </button> : null}
                      </span>
                      <small className="field-help">Choose the local path the repo should be cloned into.</small>
                      <PathSuggestions fieldName="repoClonePath" />
                    </label>
                  </>
                )}
              </div>
            </section>
            <section className="settings-card">
              <div className="section-heading">
                <div>
                  <h3>Project details</h3>
                  <span className="section-note">Editable</span>
                </div>
              </div>
              <div className="action-grid">
                <label>
                  <span>Name</span>
                  <input name="name" placeholder="Derived from source" value={projectDetails.name} onChange={(event) => updateProjectDetail("name", event.currentTarget.value)} autoFocus />
                </label>
                <label>
                  <span>Slug</span>
                  <span className="input-with-action">
                    <input name="slug" placeholder="Derived from name" value={projectDetails.slug} onChange={(event) => updateProjectDetail("slug", event.currentTarget.value)} />
                    <button className="quiet-button" type="button" onClick={generateSlug}>Generate</button>
                  </span>
                </label>
                <label>
                  <span>Default branch</span>
                  <input name="defaultBaseBranch" placeholder="Derived from git, fallback main" value={projectDetails.defaultBaseBranch} onChange={(event) => updateProjectDetail("defaultBaseBranch", event.currentTarget.value)} />
                </label>
                <label className="wide-field">
                  <span>Description</span>
                  <textarea name="description" rows={3} />
                </label>
              </div>
            </section>
            <div className="composer-actions">
              <button className="primary-button" type="submit" disabled={busy}>
                {busy ? "Creating project" : "Create project"}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );

  function PathSuggestions({ fieldName }: { fieldName: string }) {
    if (!pathSuggestions || pathSuggestions.fieldName !== fieldName || pathSuggestions.paths.length === 0) return null;
    return (
      <div className="path-suggestions" aria-label="Path suggestions">
        <span>{pathSuggestions.mode === "children" ? "Inside this folder" : "Matching folders"}</span>
        <div>
          {pathSuggestions.paths.map((path) => (
            <button key={path} type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => choosePathSuggestion(fieldName, path)}>
              <strong>{pathLeaf(path)}</strong>
              <small>{path}</small>
            </button>
          ))}
        </div>
      </div>
    );
  }
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function pathLeaf(path: string) {
  return path
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .filter(Boolean)
    .pop() || "";
}

function ensureTrailingSlash(path: string) {
  return /[\\/]$/.test(path) ? path : `${path}/`;
}

function sourceForPathField(fieldName: string): WorkspaceSourceMode | null {
  if (fieldName === "existingPath") return "existing";
  if (fieldName === "newFolderPath") return "new";
  if (fieldName === "repoClonePath") return "clone";
  return null;
}

function splitPathForSuggestions(path: string) {
  const value = path.trim();
  if (!value || value === "~") return { parentPath: "~", fragment: "" };
  const normalized = value.replace(/[\\/]+$/, "");
  const separatorIndex = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  if (separatorIndex < 0) return { parentPath: "", fragment: normalized };
  if (separatorIndex === 0) return { parentPath: "/", fragment: normalized.slice(1) };
  return {
    parentPath: normalized.slice(0, separatorIndex),
    fragment: normalized.slice(separatorIndex + 1),
  };
}

function repoNameFromRemote(remoteUrl: string) {
  const trimmed = remoteUrl.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    const name = url.pathname.split("/").filter(Boolean).pop() || "";
    return name.replace(/\.git$/i, "");
  } catch {
    // SSH remotes usually look like git@host:org/repo.git.
  }
  const pathPart = trimmed.split(":").pop() || trimmed;
  const name = pathPart.replace(/[?#].*$/, "").replace(/\/+$/, "").split("/").filter(Boolean).pop() || "";
  return name.replace(/\.git$/i, "");
}

function titleize(value: string) {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}
