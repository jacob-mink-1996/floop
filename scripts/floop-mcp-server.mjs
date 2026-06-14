#!/usr/bin/env node

const defaultApiUrl = (process.env.FLOOP_API_URL || "http://127.0.0.1:4318").replace(/\/+$/, "");

export async function handleMcpRequest(message, options = {}) {
  const apiUrl = (options.apiUrl || defaultApiUrl).replace(/\/+$/, "");
  const fetchImpl = options.fetch || fetch;
  const { id, method, params = {} } = message || {};

  try {
    if (method === "initialize") {
      return response(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "floop", version: "0.0.1" },
      });
    }
    if (method === "notifications/initialized") {
      return null;
    }
    if (method === "tools/list") {
      return response(id, { tools: toolDefinitions() });
    }
    if (method === "tools/call") {
      const result = await callTool(params.name, params.arguments || {}, { apiUrl, fetch: fetchImpl });
      return response(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
    }
    return errorResponse(id, -32601, `Unknown method: ${method}`);
  } catch (error) {
    return errorResponse(id, -32000, error instanceof Error ? error.message : String(error));
  }
}

export function toolDefinitions() {
  return [
    {
      name: "floop_list_projects",
      description: "List Floop projects.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "floop_list_tickets",
      description: "List tickets for a Floop project.",
      inputSchema: {
        type: "object",
        required: ["projectId"],
        properties: {
          projectId: { type: "string" },
          state: { type: "string" },
          assignedRole: { type: "string" },
          search: { type: "string" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "floop_append_agent_message",
      description: "Append a structured external-agent message to the Floop Agent Inbox.",
      inputSchema: {
        type: "object",
        required: ["projectId", "actor", "intent", "summary"],
        properties: {
          projectId: { type: "string" },
          actor: { type: "string" },
          source: { type: "string" },
          intent: { type: "string" },
          summary: { type: "string" },
          body: { type: "string" },
          target: { type: "object" },
          metadata: { type: "object" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "floop_request_dispatch",
      description: "Ask Floop to dispatch a role for a ticket by creating an operator-visible dispatch suggestion.",
      inputSchema: {
        type: "object",
        required: ["projectId", "ticketId", "role", "actor", "summary"],
        properties: {
          projectId: { type: "string" },
          ticketId: { type: "string" },
          role: { type: "string" },
          actor: { type: "string" },
          summary: { type: "string" },
          body: { type: "string" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "floop_get_run_status",
      description: "Read the current run observability feed for a project.",
      inputSchema: {
        type: "object",
        required: ["projectId"],
        properties: {
          projectId: { type: "string" },
          limit: { type: "number" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "floop_list_artifacts",
      description: "List recent project artifacts.",
      inputSchema: {
        type: "object",
        required: ["projectId"],
        properties: {
          projectId: { type: "string" },
          ticketId: { type: "string" },
          kind: { type: "string" },
          limit: { type: "number" },
        },
        additionalProperties: false,
      },
    },
  ];
}

async function callTool(name, args, { apiUrl, fetch }) {
  switch (name) {
    case "floop_list_projects":
      return apiGet(fetch, `${apiUrl}/api/v1/projects`);
    case "floop_list_tickets": {
      const query = new URLSearchParams();
      for (const key of ["state", "assignedRole", "search"]) {
        if (args[key]) query.set(key, String(args[key]));
      }
      const suffix = query.toString() ? `?${query}` : "";
      return apiGet(fetch, `${apiUrl}/api/v1/projects/${encodeURIComponent(required(args, "projectId"))}/tickets${suffix}`);
    }
    case "floop_append_agent_message":
      return apiPost(fetch, `${apiUrl}/api/v1/projects/${encodeURIComponent(required(args, "projectId"))}/agent-messages`, {
        actor: required(args, "actor"),
        source: args.source || "mcp",
        intent: required(args, "intent"),
        summary: required(args, "summary"),
        body: args.body || "",
        target: args.target || {},
        metadata: args.metadata || {},
      });
    case "floop_request_dispatch":
      return apiPost(fetch, `${apiUrl}/api/v1/projects/${encodeURIComponent(required(args, "projectId"))}/agent-messages`, {
        actor: required(args, "actor"),
        source: "mcp",
        intent: "suggest_dispatch",
        summary: required(args, "summary"),
        body: args.body || args.summary,
        target: { ticketId: required(args, "ticketId") },
        metadata: { role: required(args, "role") },
      });
    case "floop_get_run_status": {
      const query = new URLSearchParams();
      if (args.limit) query.set("limit", String(args.limit));
      const suffix = query.toString() ? `?${query}` : "";
      return apiGet(fetch, `${apiUrl}/api/v1/projects/${encodeURIComponent(required(args, "projectId"))}/runs${suffix}`);
    }
    case "floop_list_artifacts": {
      const query = new URLSearchParams();
      for (const key of ["ticketId", "kind", "limit"]) {
        if (args[key]) query.set(key, String(args[key]));
      }
      const suffix = query.toString() ? `?${query}` : "";
      return apiGet(fetch, `${apiUrl}/api/v1/projects/${encodeURIComponent(required(args, "projectId"))}/artifacts${suffix}`);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function apiGet(fetchImpl, url) {
  return apiRequest(fetchImpl, url, { method: "GET" });
}

async function apiPost(fetchImpl, url, body) {
  return apiRequest(fetchImpl, url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function apiRequest(fetchImpl, url, options) {
  const result = await fetchImpl(url, options);
  const payload = await result.json().catch(() => null);
  if (!result.ok) {
    throw new Error(payload?.message || `Floop API returned ${result.status}`);
  }
  return payload;
}

function required(args, key) {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing required tool argument: ${key}`);
  }
  return value.trim();
}

function response(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function errorResponse(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runStdioServer().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
}

async function runStdioServer() {
  process.stdin.setEncoding("utf8");
  let buffer = "";
  for await (const chunk of process.stdin) {
    buffer += chunk;
    while (true) {
      const parsed = readMessage(buffer);
      if (!parsed) break;
      buffer = parsed.rest;
      const output = await handleMcpRequest(parsed.message);
      if (output) {
        writeMessage(output);
      }
    }
  }
}

function readMessage(buffer) {
  const headerEnd = buffer.indexOf("\r\n\r\n");
  if (headerEnd < 0) {
    return null;
  }
  const headers = buffer.slice(0, headerEnd).split("\r\n");
  const contentLengthHeader = headers.find((header) => header.toLowerCase().startsWith("content-length:"));
  if (!contentLengthHeader) {
    throw new Error("Missing Content-Length header");
  }
  const length = Number.parseInt(contentLengthHeader.split(":")[1], 10);
  const bodyStart = headerEnd + 4;
  const bodyEnd = bodyStart + length;
  if (buffer.length < bodyEnd) {
    return null;
  }
  return {
    message: JSON.parse(buffer.slice(bodyStart, bodyEnd)),
    rest: buffer.slice(bodyEnd),
  };
}

function writeMessage(message) {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}
