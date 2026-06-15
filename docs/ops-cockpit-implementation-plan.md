# Ops Cockpit Implementation Plan

## Objective

Make Ops the primary Floop cockpit: one place that answers what needs operator attention, what agents are doing, and where to drill down when needed.

## Product Direction

- Default the app to the cockpit for selected projects.
- Keep Board and Ceremonies as drill-down surfaces, not the first decision point.
- Convert fragmented operator queues into one unified Attention queue.
- Rename and organize Run Subway as agent proof rather than internal machinery.
- Continue reducing mandatory user input. Notes, detailed settings, and uncommon controls should be optional.

## Implementation Steps

1. Define a shared UI attention item model in the React app.
   - Include tickets, merge approvals, ceremony proposals, stale/failed work, and external agent messages.
   - Preserve existing actions: open, apply, convert, dispatch, attach, accept, dismiss.

2. Make Ops the default workspace.
   - Initialize the selected workspace view to Ops.
   - Rename the visible Ops surface to Cockpit while preserving existing route/state names where practical.
   - Keep Board and Ceremonies available as tabs.

3. Rebuild Ops layout around cockpit priorities.
   - Left: unified Attention queue.
   - Center: Agent Work proof stream.
   - Right: compact Activity and Artifacts.
   - Show merge queue only when there are merge items, especially approvals.

4. Simplify Board cards.
   - Keep title, state, graphical phase rail, next action, and exceptional badges.
   - Remove routine priority, role, repo, review, and validation chips from cards.

5. Simplify Ticket Detail.
   - Keep cockpit/action visible at top.
   - Collapse secondary sections into disclosures: Plan, Scope, Evidence, Worktrees, Merge, Timeline, Advanced.
   - Keep restart under Advanced.

6. Simplify ceremony proposal presentation.
   - Use compact rows focused on affected target, proposal summary, and Apply.
   - Keep raw payload collapsed.

7. Update the usage recorder.
   - Start on Cockpit/Ops.
   - Show unified Attention and Agent Work proof.
   - Keep developer execution proof visible long enough to verify real agent work.

8. Verify and commit.
   - Run `npm run build:web`.
   - Run `npm run demo:record`.
   - Inspect sampled frames for clipped panels, text collisions, clear Attention, and visible agent proof.
   - Commit the passing slice.

