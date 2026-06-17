import {
  parseCompleteExecutionInput,
  parseContinueExecutionInput,
  parseCreateExecutionInput,
  parseCreateReviewInput,
  parseCreateValidationInput,
  parseSteerExecutionInput,
} from "../../../../packages/contracts/src/index.mjs";
import { respondCreated, respondMaybe } from "./shared.mjs";

export function handleExecutionRoute(route, _url, body, store, context = {}) {
  switch (route.name) {
    case "ticketExecutions":
      if (route.method === "GET") {
        const executions = store.listExecutions(route.params.projectId, route.params.ticketId);
        if (!executions) {
          return { status: 404, body: { error: "not_found" } };
        }
        return { status: 200, body: { executions } };
      }
      return respondCreated(
        store.createExecution(
          route.params.projectId,
          route.params.ticketId,
          parseCreateExecutionInput(body),
        ),
        "execution",
      );
    case "execution":
      return respondMaybe(store.getExecution(route.params.projectId, route.params.executionId), "execution");
    case "executionComplete":
      return respondMaybe(
        store.completeExecution(
          route.params.projectId,
          route.params.executionId,
          parseCompleteExecutionInput(body),
        ),
        "execution",
      );
    case "executionContinue":
      return respondMaybe(
        store.continueExecution(
          route.params.projectId,
          route.params.executionId,
          parseContinueExecutionInput(body),
        ),
        "execution",
      );
    case "executionCancel":
      {
        const execution = store.cancelExecution(route.params.projectId, route.params.executionId, body || {});
        context.executionDriver?.cancelExecution?.(
          route.params.projectId,
          route.params.executionId,
          body?.reason || "Execution cancelled by operator",
        );
        return respondMaybe(execution, "execution");
      }
    case "executionSteer":
      {
        const result = store.steerExecution(
          route.params.projectId,
          route.params.executionId,
          parseSteerExecutionInput(body),
        );
        if (result?.delivery?.status === "resumed") {
          context.executionDriver?.cancelExecution?.(
            route.params.projectId,
            result.delivery.interruptedExecutionId || route.params.executionId,
            "Execution interrupted for steering.",
          );
        }
        return respondMaybe(result, "steering");
      }
    case "ticketReviews":
      if (route.method === "GET") {
        const reviews = store.listReviews(route.params.projectId, route.params.ticketId);
        if (!reviews) {
          return { status: 404, body: { error: "not_found" } };
        }
        return { status: 200, body: { reviews } };
      }
      return respondCreated(
        store.createReview(
          route.params.projectId,
          route.params.ticketId,
          parseCreateReviewInput(body),
        ),
        "review",
      );
    case "ticketValidations":
      if (route.method === "GET") {
        const validations = store.listValidations(route.params.projectId, route.params.ticketId);
        if (!validations) {
          return { status: 404, body: { error: "not_found" } };
        }
        return { status: 200, body: { validations } };
      }
      return respondCreated(
        store.createValidation(
          route.params.projectId,
          route.params.ticketId,
          parseCreateValidationInput(body),
        ),
        "validations",
      );
    default:
      return null;
  }
}
