#!/usr/bin/env node

import { parseExternalAgentIngressInput } from "../packages/contracts/src/index.mjs";

const args = parseArgs(process.argv.slice(2));

if (args.help || !args.project || !args.actor || (!args.intent && !args.action) || !args.summary) {
  printUsage();
  process.exit(args.help ? 0 : 1);
}

const baseUrl = String(args.url || process.env.FLOOP_API_URL || "http://127.0.0.1:4318").replace(/\/+$/, "");
const message = args.action
  ? parseExternalAgentIngressInput({
      actor: args.actor,
      protocol: args.protocol || args.source || "cli",
      source: args.source || args.protocol || "cli",
      action: args.action,
      target: parseJsonArg(args.target, "target"),
      summary: args.summary,
      body: args.body || "",
      metadata: parseJsonArg(args.metadata, "metadata"),
    })
  : {
      actor: args.actor,
      source: args.source || "cli",
      intent: args.intent,
      target: parseJsonArg(args.target, "target"),
      summary: args.summary,
      body: args.body || "",
      metadata: parseJsonArg(args.metadata, "metadata"),
    };

const response = await fetch(`${baseUrl}/api/v1/projects/${encodeURIComponent(args.project)}/agent-messages`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(message),
});
const payload = await response.json().catch(() => null);
if (!response.ok) {
  const detail = payload?.message ? `: ${payload.message}` : "";
  console.error(`Floop agent message failed (${response.status})${detail}`);
  process.exit(1);
}

console.log(JSON.stringify(payload.message, null, 2));

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--help" || value === "-h") {
      parsed.help = true;
      continue;
    }
    if (!value.startsWith("--")) {
      throw new Error(`Unexpected argument: ${value}`);
    }
    const key = value.slice(2);
    parsed[key] = values[index + 1] || "";
    index += 1;
  }
  return parsed;
}

function parseJsonArg(value, label) {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${label} must be a JSON object`);
    }
    return parsed;
  } catch (error) {
    console.error(`Invalid ${label} JSON: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

function printUsage() {
  console.log(`Usage:
  node scripts/floop-agent-message.mjs --project project_floop --actor openclaw --intent suggest_ticket --summary "Add fixture coverage"

Options:
  --url       Floop API URL. Defaults to FLOOP_API_URL or http://127.0.0.1:4318
  --project   Project id, for example project_floop
  --actor     External agent name
  --source    Source name. Defaults to cli
  --protocol  External protocol name when using --action. Defaults to --source or cli
  --action    Protocol action: ticket, comment, question, dispatch, ceremony_input, artifact, risk, status
  --intent    suggest_ticket, comment_on_ticket, suggest_dispatch, submit_ceremony_input, raise_risk, submit_artifact, request_status
  --summary   Short operator-facing summary
  --body      Longer message body
  --target    JSON object with optional ticketId/repoId
  --metadata  JSON object with extra protocol-specific data`);
}
