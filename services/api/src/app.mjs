import http from "node:http";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, dirname, extname, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { createStore } from "./store.mjs";
import { createLocalTrustConfig, isAuthorizedRequest } from "./local-trust.mjs";
import { handleCeremonyRoute } from "./routes/ceremony-handlers.mjs";
import { handleExecutionRoute } from "./routes/execution-handlers.mjs";
import { handleFeedRoute } from "./routes/feed-handlers.mjs";
import { handleMergeRoute } from "./routes/merge-handlers.mjs";
import { handleProjectRoute } from "./routes/project-handlers.mjs";
import { handleRepoRoute } from "./routes/repo-handlers.mjs";
import { handleTicketRoute } from "./routes/ticket-handlers.mjs";
import { inferErrorStatus, parseEventFilters, RequestError } from "./routes/shared.mjs";

const webAssets = loadWebAssets();

export function createFloopServer(options = {}) {
  const trustConfig = createLocalTrustConfig({
    host: options.host || "127.0.0.1",
    authToken: options.authToken || "",
  });
  const store = options.store || createStore();

  return http.createServer(async (request, response) => {
    try {
      if (request.method === "OPTIONS") {
        response.writeHead(204, corsHeaders());
        response.end();
        return;
      }

      if (!isAuthorizedRequest(request, trustConfig)) {
        sendJson(response, 401, {
          error: "unauthorized",
          message: "Floop API requires a valid local trust token",
        });
        return;
      }

      const url = new URL(
        request.url,
        `http://${request.headers.host || `${options.host || "127.0.0.1"}:${options.port || "4318"}`}`,
      );
      if (serveWebSurface(request, response, url)) {
        return;
      }

      const route = matchRoute(request.method || "GET", url.pathname);
      if (!route) {
        sendJson(response, 404, { error: "not_found" });
        return;
      }

      if (route.name === "eventStream") {
        await streamProjectEvents(request, response, route, url, store);
        return;
      }

      const body = await readJsonBody(request);
      const result = handleRoute(route, url, body, store, options);
      sendJson(response, result.status, result.body);
    } catch (error) {
      const status = error instanceof RequestError ? error.status : inferErrorStatus(error);
      const reasonCode = error instanceof RequestError ? error.reasonCode : inferErrorReasonCode(error);
      sendJson(response, status, {
        error: status === 500 ? "internal_error" : status === 409 ? "conflict" : "bad_request",
        message: error instanceof Error ? error.message : String(error),
        ...(reasonCode ? { reasonCode } : {}),
      });
    }
  });
}

function handleRoute(route, url, body, store, context = {}) {
  switch (route.name) {
    case "health":
      return {
        status: 200,
        body: {
          ok: true,
          service: "floop-api",
          now: new Date().toISOString(),
        },
      };
    case "meta":
      return {
        status: 200,
        body: {
          name: "Floop",
          version: "0.0.1",
          mode: "mvp",
          product: true,
          workspaceRoot: process.cwd(),
        },
      };
    case "directoryBrowse":
      return { status: 200, body: { directory: listDirectories(url.searchParams.get("path") || "") } };
    case "directoryCreate":
      return { status: 200, body: { directory: createDirectory(requiredBodyString(body, "path")) } };
    case "repoDetect":
      return { status: 200, body: { repo: detectGitRepo(requiredBodyString(body, "localPath")) } };
    case "repoInspect":
      return { status: 200, body: { repo: inspectGitRepo(requiredBodyString(body, "localPath")) } };
    case "repoClone":
      return { status: 200, body: { repo: cloneGitRepo(body || {}) } };
    default:
      return (
        handleProjectRoute(route, url, body, store) ||
        handleRepoRoute(route, url, body, store) ||
        handleTicketRoute(route, url, body, store) ||
        handleExecutionRoute(route, url, body, store, context) ||
        handleMergeRoute(route, url, body, store) ||
        handleCeremonyRoute(route, url, body, store) ||
        handleFeedRoute(route, url, body, store) ||
        { status: 404, body: { error: "not_found" } }
      );
  }
}

async function streamProjectEvents(request, response, route, url, store) {
  if (!store.getProjectSummary(route.params.projectId)) {
    sendJson(response, 404, { error: "not_found" });
    return;
  }

  const filters = {
    ...parseEventFilters(url),
    order: "asc",
    limit: Math.min(parseEventFilters(url).limit || 100, 200),
  };
  const seenEventIds = new Set();

  response.writeHead(200, {
    ...corsHeaders(),
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });

  const initialEvents = store.listEvents(route.params.projectId, filters);
  for (const event of initialEvents) {
    seenEventIds.add(event.id);
  }
  writeSseEvent(response, "snapshot", { events: initialEvents });

  const pollTimer = setInterval(() => {
    const nextEvents = store
      .listEvents(route.params.projectId, filters)
      .filter((event) => !seenEventIds.has(event.id));
    for (const event of nextEvents) {
      seenEventIds.add(event.id);
      writeSseEvent(response, "event", event);
    }
  }, 500);
  pollTimer.unref?.();

  const heartbeatTimer = setInterval(() => {
    writeSseEvent(response, "heartbeat", { now: new Date().toISOString() });
  }, 15000);
  heartbeatTimer.unref?.();

  const cleanup = () => {
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
    if (!response.writableEnded) {
      response.end();
    }
  };

  request.on("close", cleanup);
  request.on("error", cleanup);
}

function listDirectories(inputPath) {
  const path = resolveUserPath(inputPath || homedir());
  const stats = statSync(path);
  if (!stats.isDirectory()) {
    throw new RequestError(400, `Not a directory: ${path}`);
  }

  const entries = readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      path: resolve(path, entry.name),
      hidden: entry.name.startsWith("."),
    }))
    .sort((a, b) => Number(a.hidden) - Number(b.hidden) || a.name.localeCompare(b.name));

  return {
    path,
    parentPath: dirname(path) === path ? "" : dirname(path),
    entries,
  };
}

function createDirectory(inputPath) {
  const path = resolveUserPath(inputPath);
  mkdirSync(path, { recursive: true });
  const stats = statSync(path);
  if (!stats.isDirectory()) {
    throw new RequestError(400, `Not a directory: ${path}`);
  }
  return { path };
}

function detectGitRepo(localPath) {
  try {
    return inspectGitRepo(localPath);
  } catch (error) {
    if (error instanceof RequestError && error.status === 400) return null;
    throw error;
  }
}

function inspectGitRepo(localPath) {
  const root = git(localPath, ["rev-parse", "--show-toplevel"]);
  const branch = git(root, ["symbolic-ref", "--short", "HEAD"], { optional: true }) || git(root, ["rev-parse", "--short", "HEAD"], { optional: true }) || "main";
  const remoteUrl = git(root, ["remote", "get-url", "origin"], { optional: true });
  const name = basename(root);
  return {
    name,
    slug: slugify(name),
    localPath: root,
    remoteUrl,
    defaultBranch: branch,
    isPrimary: true,
  };
}

function cloneGitRepo(input) {
  const remoteUrl = requiredBodyString(input, "remoteUrl");
  const destinationPath = resolveUserPath(requiredBodyString(input, "destinationPath"));
  mkdirSync(dirname(destinationPath), { recursive: true });
  execFileSync("git", ["clone", remoteUrl, destinationPath], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return inspectGitRepo(destinationPath);
}

function git(cwd, args, options = {}) {
  try {
    return execFileSync("git", ["-C", resolveUserPath(cwd), ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    if (options.optional) return "";
    const stderr = error?.stderr ? String(error.stderr).trim() : "";
    throw new RequestError(400, stderr || `Git command failed in ${cwd}`);
  }
}

function resolveUserPath(value) {
  const raw = String(value || "").trim();
  if (!raw) return homedir();
  if (raw === "~") return homedir();
  if (raw.startsWith("~/")) return resolve(homedir(), raw.slice(2));
  return isAbsolute(raw) ? resolve(raw) : resolve(process.cwd(), raw);
}

function requiredBodyString(body, field) {
  const value = body && typeof body === "object" ? body[field] : undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new RequestError(400, `Missing required field: ${field}`);
  }
  return value.trim();
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "") || "repo";
}

async function readJsonBody(request) {
  if (request.method === "GET" || request.method === "HEAD") {
    return null;
  }

  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return null;
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    throw new RequestError(
      400,
      error instanceof Error ? `Invalid JSON body: ${error.message}` : "Invalid JSON body",
    );
  }
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    ...corsHeaders(),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

function sendText(response, status, body, contentType, method = "GET", extraHeaders = {}) {
  response.writeHead(status, {
    ...corsHeaders(),
    "content-type": contentType,
    ...extraHeaders,
  });
  response.end(method === "HEAD" ? "" : body);
}

function writeSseEvent(response, event, payload) {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function inferErrorReasonCode(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("Unknown execution for ticket ")) return "unknown_execution";
  if (message.startsWith("Execution already running for ")) return "execution_already_running";
  if (message.startsWith("Project execution limit reached for ")) return "execution_capacity_reached";
  if (message.startsWith("Project merge limit reached for ")) return "merge_capacity_reached";
  if (message.includes(" reached the continuation limit of ")) return "execution_continue_limit_reached";
  if (message.includes(" must be finished before review")) return "review_execution_not_finished";
  if (message.includes(" must complete successfully before review")) return "review_execution_not_completed";
  if (message.includes(" must be finished before validation")) return "validation_execution_not_finished";
  if (message.includes(" must complete successfully before validation")) return "validation_execution_not_completed";
  if (message.includes(" is not ready for review")) return "ticket_not_ready_for_review";
  if (message.includes(" is not ready for validation")) return "ticket_not_ready_for_validation";
  if (message.includes(" is not ready for merge")) return "ticket_not_ready";
  if (message.includes(" requires human approval before merge")) return "human_approval_required";
  if (message.includes("Latest review must pass before merge")) return "review_required";
  if (message.includes("Latest validation must pass before merge")) return "validation_required";
  if (message.includes("Latest validation must use ")) return "validation_profile_required";
  if (message === "Cannot clean an active worktree") return "worktree_active";
  return "";
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "authorization,content-type,x-floop-auth",
  };
}

function serveWebSurface(request, response, url) {
  const method = request.method || "GET";
  if (method !== "GET" && method !== "HEAD") {
    return false;
  }

  const assetPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const asset = webAssets.get(assetPath);
  if (asset) {
    sendText(response, 200, asset.body, asset.contentType, method, {
      "cache-control": "no-store",
    });
    return true;
  }

  return false;
}

function loadWebAssets() {
  const reactBuildRoot = new URL("../../../apps/web-react/dist/", import.meta.url);
  if (!existsSync(reactBuildRoot)) {
    throw new Error("Missing apps/web-react/dist. Run npm run build:web before starting the API.");
  }

  const assets = new Map();
  walkWebAssetTree(reactBuildRoot, "", assets);
  return assets;
}

function walkWebAssetTree(directoryUrl, prefix, assets) {
  for (const entry of readdirSync(directoryUrl, { withFileTypes: true })) {
    const childUrl = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directoryUrl);
    const childPath = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      walkWebAssetTree(childUrl, childPath, assets);
      continue;
    }

    assets.set(childPath, {
      body: readFileSync(childUrl, "utf8"),
      contentType: contentTypeForExtension(extname(entry.name)),
    });
  }
}

function contentTypeForExtension(extension) {
  switch (extension) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".ico":
      return "image/x-icon";
    default:
      return "text/plain; charset=utf-8";
  }
}

function matchRoute(method, pathname) {
  const routes = [
    { method: "GET", pattern: /^\/api\/v1\/health$/, name: "health" },
    { method: "GET", pattern: /^\/api\/v1\/meta$/, name: "meta" },
    { method: "GET", pattern: /^\/api\/v1\/fs\/directories$/, name: "directoryBrowse" },
    { method: "POST", pattern: /^\/api\/v1\/fs\/directories$/, name: "directoryCreate" },
    { method: "POST", pattern: /^\/api\/v1\/git\/detect$/, name: "repoDetect" },
    { method: "POST", pattern: /^\/api\/v1\/git\/inspect$/, name: "repoInspect" },
    { method: "POST", pattern: /^\/api\/v1\/git\/clone$/, name: "repoClone" },
    { method: "GET", pattern: /^\/api\/v1\/projects$/, name: "projects" },
    { method: "POST", pattern: /^\/api\/v1\/projects$/, name: "projects" },
    { method: "PATCH", pattern: /^\/api\/v1\/projects\/([^/]+)$/, name: "project", keys: ["projectId"] },
    { method: "DELETE", pattern: /^\/api\/v1\/projects\/([^/]+)$/, name: "project", keys: ["projectId"] },
    { method: "GET", pattern: /^\/api\/v1\/projects\/([^/]+)\/policy$/, name: "projectPolicy", keys: ["projectId"] },
    { method: "PATCH", pattern: /^\/api\/v1\/projects\/([^/]+)\/policy$/, name: "projectPolicy", keys: ["projectId"] },
    { method: "GET", pattern: /^\/api\/v1\/projects\/([^/]+)\/agent-profiles$/, name: "projectAgentProfiles", keys: ["projectId"] },
    { method: "PATCH", pattern: /^\/api\/v1\/projects\/([^/]+)\/agent-profiles\/([^/]+)$/, name: "projectAgentProfile", keys: ["projectId", "role"] },
    { method: "GET", pattern: /^\/api\/v1\/projects\/([^/]+)\/agent-messages$/, name: "projectAgentMessages", keys: ["projectId"] },
    { method: "POST", pattern: /^\/api\/v1\/projects\/([^/]+)\/agent-messages$/, name: "projectAgentMessages", keys: ["projectId"] },
    { method: "POST", pattern: /^\/api\/v1\/projects\/([^/]+)\/agent-messages\/([^/]+)\/respond$/, name: "projectAgentMessageResponse", keys: ["projectId", "messageId"] },
    { method: "PATCH", pattern: /^\/api\/v1\/projects\/([^/]+)\/agent-messages\/([^/]+)$/, name: "projectAgentMessage", keys: ["projectId", "messageId"] },
    { method: "GET", pattern: /^\/api\/v1\/projects\/([^/]+)\/board$/, name: "projectBoard", keys: ["projectId"] },
    { method: "GET", pattern: /^\/api\/v1\/projects\/([^/]+)\/merge-queue$/, name: "projectMergeQueue", keys: ["projectId"] },
    { method: "GET", pattern: /^\/api\/v1\/projects\/([^/]+)\/ceremonies$/, name: "projectCeremonies", keys: ["projectId"] },
    { method: "POST", pattern: /^\/api\/v1\/projects\/([^/]+)\/ceremonies$/, name: "projectCeremonies", keys: ["projectId"] },
    { method: "GET", pattern: /^\/api\/v1\/projects\/([^/]+)\/ceremonies\/([^/]+)$/, name: "projectCeremony", keys: ["projectId", "runId"] },
    { method: "POST", pattern: /^\/api\/v1\/projects\/([^/]+)\/ceremonies\/([^/]+)\/apply$/, name: "projectCeremonyApply", keys: ["projectId", "runId"] },
    { method: "GET", pattern: /^\/api\/v1\/projects\/([^/]+)$/, name: "project", keys: ["projectId"] },
    { method: "GET", pattern: /^\/api\/v1\/projects\/([^/]+)\/repos$/, name: "repos", keys: ["projectId"] },
    { method: "POST", pattern: /^\/api\/v1\/projects\/([^/]+)\/repos$/, name: "repos", keys: ["projectId"] },
    { method: "PATCH", pattern: /^\/api\/v1\/projects\/([^/]+)\/repos\/([^/]+)$/, name: "repo", keys: ["projectId", "repoId"] },
    { method: "GET", pattern: /^\/api\/v1\/projects\/([^/]+)\/tickets$/, name: "tickets", keys: ["projectId"] },
    { method: "POST", pattern: /^\/api\/v1\/projects\/([^/]+)\/tickets$/, name: "tickets", keys: ["projectId"] },
    { method: "GET", pattern: /^\/api\/v1\/projects\/([^/]+)\/tickets\/([^/]+)$/, name: "ticket", keys: ["projectId", "ticketId"] },
    { method: "PATCH", pattern: /^\/api\/v1\/projects\/([^/]+)\/tickets\/([^/]+)$/, name: "ticketUpdate", keys: ["projectId", "ticketId"] },
    { method: "GET", pattern: /^\/api\/v1\/projects\/([^/]+)\/tickets\/([^/]+)\/executions$/, name: "ticketExecutions", keys: ["projectId", "ticketId"] },
    { method: "POST", pattern: /^\/api\/v1\/projects\/([^/]+)\/tickets\/([^/]+)\/executions$/, name: "ticketExecutions", keys: ["projectId", "ticketId"] },
    { method: "GET", pattern: /^\/api\/v1\/projects\/([^/]+)\/tickets\/([^/]+)\/reviews$/, name: "ticketReviews", keys: ["projectId", "ticketId"] },
    { method: "POST", pattern: /^\/api\/v1\/projects\/([^/]+)\/tickets\/([^/]+)\/reviews$/, name: "ticketReviews", keys: ["projectId", "ticketId"] },
    { method: "GET", pattern: /^\/api\/v1\/projects\/([^/]+)\/tickets\/([^/]+)\/validations$/, name: "ticketValidations", keys: ["projectId", "ticketId"] },
    { method: "POST", pattern: /^\/api\/v1\/projects\/([^/]+)\/tickets\/([^/]+)\/validations$/, name: "ticketValidations", keys: ["projectId", "ticketId"] },
    { method: "GET", pattern: /^\/api\/v1\/projects\/([^/]+)\/tickets\/([^/]+)\/merge$/, name: "ticketMerge", keys: ["projectId", "ticketId"] },
    { method: "POST", pattern: /^\/api\/v1\/projects\/([^/]+)\/tickets\/([^/]+)\/merge$/, name: "ticketMerge", keys: ["projectId", "ticketId"] },
    { method: "POST", pattern: /^\/api\/v1\/projects\/([^/]+)\/tickets\/([^/]+)\/dependencies$/, name: "ticketDependencies", keys: ["projectId", "ticketId"] },
    { method: "DELETE", pattern: /^\/api\/v1\/projects\/([^/]+)\/tickets\/([^/]+)\/dependencies\/([^/]+)$/, name: "ticketDependency", keys: ["projectId", "ticketId", "dependencyId"] },
    { method: "POST", pattern: /^\/api\/v1\/projects\/([^/]+)\/tickets\/([^/]+)\/transition$/, name: "ticketTransition", keys: ["projectId", "ticketId"] },
    { method: "POST", pattern: /^\/api\/v1\/projects\/([^/]+)\/tickets\/([^/]+)\/restart$/, name: "ticketRestart", keys: ["projectId", "ticketId"] },
    { method: "POST", pattern: /^\/api\/v1\/projects\/([^/]+)\/tickets\/([^/]+)\/product-autopilot$/, name: "ticketProductAutopilot", keys: ["projectId", "ticketId"] },
    { method: "GET", pattern: /^\/api\/v1\/projects\/([^/]+)\/executions\/([^/]+)$/, name: "execution", keys: ["projectId", "executionId"] },
    { method: "POST", pattern: /^\/api\/v1\/projects\/([^/]+)\/executions\/([^/]+)\/complete$/, name: "executionComplete", keys: ["projectId", "executionId"] },
    { method: "POST", pattern: /^\/api\/v1\/projects\/([^/]+)\/executions\/([^/]+)\/continue$/, name: "executionContinue", keys: ["projectId", "executionId"] },
    { method: "POST", pattern: /^\/api\/v1\/projects\/([^/]+)\/executions\/([^/]+)\/steer$/, name: "executionSteer", keys: ["projectId", "executionId"] },
    { method: "POST", pattern: /^\/api\/v1\/projects\/([^/]+)\/executions\/([^/]+)\/cancel$/, name: "executionCancel", keys: ["projectId", "executionId"] },
    { method: "GET", pattern: /^\/api\/v1\/projects\/([^/]+)\/runs$/, name: "runs", keys: ["projectId"] },
    { method: "GET", pattern: /^\/api\/v1\/projects\/([^/]+)\/worktrees$/, name: "worktrees", keys: ["projectId"] },
    { method: "POST", pattern: /^\/api\/v1\/projects\/([^/]+)\/worktrees\/([^/]+)\/clean$/, name: "worktreeClean", keys: ["projectId", "worktreeId"] },
    { method: "GET", pattern: /^\/api\/v1\/projects\/([^/]+)\/events$/, name: "events", keys: ["projectId"] },
    { method: "GET", pattern: /^\/api\/v1\/projects\/([^/]+)\/events\/stream$/, name: "eventStream", keys: ["projectId"] },
    { method: "GET", pattern: /^\/api\/v1\/projects\/([^/]+)\/artifacts$/, name: "artifacts", keys: ["projectId"] },
  ];

  for (const route of routes) {
    if (route.method !== method) {
      continue;
    }

    const match = pathname.match(route.pattern);
    if (!match) {
      continue;
    }

    const params = {};
    for (const [index, key] of (route.keys || []).entries()) {
      params[key] = match[index + 1];
    }
    return { name: route.name, method: route.method, params };
  }

  return null;
}
