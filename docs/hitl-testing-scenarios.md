# HITL Testing Scenarios

This inventory tracks human-in-the-loop behavior and adjacent workflow risks where a user, agent, or policy decision can change execution state.

## Covered in This Pass

- Blocked developer execution creates one pending `request_input` and one ticket-visible question comment.
- The blocked question body stays compact and is also stored as `metadata.questionMd`.
- Manual, operator-approved, and autonomous-with-review modes keep question comments pending for operator handling.
- Autopilot and fully-autonomous modes auto-attach low-risk question comments to the ticket.
- Ordinary ticket comments are allowed in every interaction mode.
- Ordinary ticket comments never redispatch an agent lane by themselves.
- Only `request_input` messages can be answered through the unblock response path.
- A response to `request_input` creates a ticket comment containing the answer.
- A response to `request_input` can redispatch the same agent lane.
- A response to `request_input` can explicitly avoid redispatch with `continueExecution: false`.
- Reviewer HITL questions redispatch the reviewer lane, not the developer lane.
- Validator HITL questions redispatch the validator lane, not the reviewer or developer lane.
- A developer HITL answer is included in later reviewer execution context so review can honor clarified scope.
- A developer HITL answer is included in later validator execution context so validation can honor clarified scope.
- A reviewer HITL answer is included in later validator execution context so validation can honor review-time scope.
- HITL context is scoped to the current ticket and does not leak across parallel tickets.
- Agent-authored unblock responses can continue work, not only human-authored responses.
- Duplicate completion of the same blocked execution does not create duplicate pending HITL requests.
- A stale or already-answered HITL request cannot be answered again.
- Restarting a ticket dismisses pending HITL requests so late answers cannot revive stale work.
- Cancelling a blocked execution dismisses its pending HITL request so late answers cannot continue stale work.
- The HTTP API returns client errors for responding to ordinary comments and stale input requests.

## High-Priority HITL Scenarios Still Worth Adding

- Blocked architect or product-manager pre-work ticket asks a product question and resumes the same pre-work role.
- Agent asks a question while a ticket has active reviewer/validator work elsewhere, and only the blocked execution is continued.
- User answers a blocked request after the ticket was manually moved to `DONE`; response should not redispatch.
- User answers a blocked request after a newer execution iteration is already running; response should not create a duplicate lane.
- Operator converts an ordinary comment into an explicit "continue with this comment" action.
- Agent or human dismisses a pending question; ticket should remain blocked unless another policy action moves it.
- Multiple different executions on the same ticket block at different stages; each question should target and continue only its own execution and stay ordered in downstream context.
- A validator blocks with `needs_environment_fix`; suggested responders should favor developer/integrator.
- A policy block uses `needs_policy_override`; suggested responders should favor product manager/architect.
- An unblock answer that exceeds continuation budget should attach as a comment and leave the request non-executing.
- A malformed or empty unblock response should fail contract validation without changing request status.
- A pending HITL form response should appear in run observability as needing attention.
- Fully autonomous mode should still leave `request_input` pending while attaching the visible question comment.
- Ticket summaries should stay compact after very large question and answer bodies.

## Adjacent Workflow Scenario Opportunities

- Merge conflict rework asks the previous working agent for help, but a user comment does not trigger rework unless attached to an explicit action.
- Merge blocked by human approval exposes a clear pending decision and does not auto-merge outside fully autonomous mode.
- Merge blocked by missing demo evidence routes validator/demo evidence work before merge.
- Validator failure routes back to the previous working lane and can include a HITL question before retry.
- Review failure routes back to implementation with findings preserved as context.
- Ticket restart cancels active execution, active merge, pending HITL requests, or marks them stale.
- Closing the UI or ticket detail stops visible work indicators but does not lose run state.
- Capacity limits produce pending dispatch suggestions or blocked-visible state instead of silently dropping work.
- Ceremony participant questions should become ceremony-scoped input, not ticket execution input, unless the ceremony targets a ticket.
- Ceremony decider asks a HITL question before applying proposals.
- Ceremony proposal application in operator-approved mode waits for explicit approval.
- Agent inbox messages that submit artifacts, dispatch suggestions, risks, and ticket suggestions are each gated by interaction mode.
- Worktree cleanup during restart should not delete evidence needed to answer or audit a HITL request.
- Agent JSONL/log streams should surface question signals separately from progress signals.
- Long-running active executions should keep claim state visible so users do not answer stale questions blindly.
- API/SSE event streams should emit enough events for the UI to update HITL badges, ticket comments, and active lane indicators without reload.
