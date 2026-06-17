import {
  parseCreateProjectInput,
  parseCreateAgentMessageInput,
  parseExternalAgentIngressInput,
  parseRespondAgentMessageInput,
  parseUpdateAgentMessageInput,
  parseUpdateProjectInput,
  parseUpdateProjectPolicyInput,
  parseUpdateRoleProfileInput,
} from "../../../../packages/contracts/src/index.mjs";
import { parseTicketFilters, respondCreated, respondMaybe } from "./shared.mjs";

export function handleProjectRoute(route, url, body, store) {
  switch (route.name) {
    case "projects":
      if (route.method === "GET") {
        return { status: 200, body: { projects: store.listProjects() } };
      }
      return { status: 201, body: { project: store.createProject(parseCreateProjectInput(body)) } };
    case "project":
      if (route.method === "GET") {
        return respondMaybe(store.getProjectSummary(route.params.projectId), "project");
      }
      if (route.method === "DELETE") {
        return respondMaybe(store.deleteProject(route.params.projectId), "project");
      }
      return respondMaybe(
        store.updateProject(route.params.projectId, parseUpdateProjectInput(body)),
        "project",
      );
    case "projectPolicy":
      if (route.method === "GET") {
        return respondMaybe(store.getProjectPolicy(route.params.projectId), "policy");
      }
      return respondMaybe(
        store.updateProjectPolicy(route.params.projectId, parseUpdateProjectPolicyInput(body)),
        "policy",
      );
    case "projectBoard":
      return respondMaybe(
        store.getProjectBoard(route.params.projectId, parseTicketFilters(url)),
        "board",
      );
    case "projectAgentProfiles":
      {
        const profiles = store.listRoleProfiles(route.params.projectId);
        if (!profiles) {
          return { status: 404, body: { error: "not_found" } };
        }
        return { status: 200, body: { profiles } };
      }
    case "projectAgentProfile":
      return respondMaybe(
        store.updateRoleProfile(
          route.params.projectId,
          route.params.role,
          parseUpdateRoleProfileInput(body),
        ),
        "profile",
      );
    case "projectAgentMessages":
      if (route.method === "GET") {
        const messages = store.listAgentMessages(route.params.projectId, parseAgentMessageFilters(url));
        if (!messages) {
          return { status: 404, body: { error: "not_found" } };
        }
        return { status: 200, body: { messages } };
      }
      return respondCreated(
        store.createAgentMessage(route.params.projectId, parseCreateAgentMessageInput(body)),
        "message",
      );
    case "projectExternalAgentMessages":
      return respondCreated(
        store.createAgentMessage(route.params.projectId, parseExternalAgentIngressInput(body)),
        "message",
      );
    case "projectAgentMessage":
      return respondMaybe(
        store.updateAgentMessage(
          route.params.projectId,
          route.params.messageId,
          parseUpdateAgentMessageInput(body),
        ),
        "message",
      );
    case "projectAgentMessageResponse":
      return respondMaybe(
        store.respondAgentMessage(
          route.params.projectId,
          route.params.messageId,
          parseRespondAgentMessageInput(body),
        ),
        "message",
      );
    default:
      return null;
  }
}

function parseAgentMessageFilters(url) {
  return {
    status: url.searchParams.get("status") || "",
    intent: url.searchParams.get("intent") || "",
    limit: Number.parseInt(url.searchParams.get("limit") || "50", 10),
  };
}
