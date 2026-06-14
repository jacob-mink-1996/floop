import assert from "node:assert/strict";
import test from "node:test";
import { handleMcpRequest, toolDefinitions } from "./floop-mcp-server.mjs";

test("Floop MCP facade advertises project and agent inbox tools", () => {
  const tools = toolDefinitions();
  assert.equal(tools.some((tool) => tool.name === "floop_list_projects"), true);
  assert.equal(tools.some((tool) => tool.name === "floop_append_agent_message"), true);
  assert.equal(tools.some((tool) => tool.name === "floop_request_dispatch"), true);
});

test("Floop MCP facade forwards agent inbox tools to the HTTP API", async () => {
  const requests = [];
  const fetch = async (url, options = {}) => {
    requests.push({ url, options });
    return {
      ok: true,
      status: 200,
      async json() {
        return { ok: true };
      },
    };
  };

  const appendResponse = await handleMcpRequest(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "floop_append_agent_message",
        arguments: {
          projectId: "project_floop",
          actor: "openclaw",
          intent: "comment_on_ticket",
          summary: "Inspect transport errors",
          target: { ticketId: "ticket_project_floop_2" },
        },
      },
    },
    { apiUrl: "http://floop.local", fetch },
  );
  assert.equal(appendResponse.id, 1);
  assert.equal(requests[0].url, "http://floop.local/api/v1/projects/project_floop/agent-messages");
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    actor: "openclaw",
    source: "mcp",
    intent: "comment_on_ticket",
    summary: "Inspect transport errors",
    body: "",
    target: { ticketId: "ticket_project_floop_2" },
    metadata: {},
  });

  await handleMcpRequest(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "floop_request_dispatch",
        arguments: {
          projectId: "project_floop",
          ticketId: "ticket_project_floop_2",
          role: "reviewer",
          actor: "hermes",
          summary: "Review lane is ready",
        },
      },
    },
    { apiUrl: "http://floop.local", fetch },
  );
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    actor: "hermes",
    source: "mcp",
    intent: "suggest_dispatch",
    summary: "Review lane is ready",
    body: "Review lane is ready",
    target: { ticketId: "ticket_project_floop_2" },
    metadata: { role: "reviewer" },
  });
});
