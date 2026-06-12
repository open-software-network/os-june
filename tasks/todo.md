# Sidebar files collapse bug

- [x] Locate the main sidenav resize/collapse logic and the agent sidebar files sidenav rendering.
- [x] Reproduce or reason through why files temporarily disappear during drag collapse.
- [x] Patch the state/layout path with the smallest scoped change.
- [x] Add or update focused tests if the behavior is covered by component tests.
- [x] Run relevant tests and document the rendered validation blocker.
- [x] Fix the reverse drag flash after collapsing while the pointer stays down.

## Review

Fixed by giving drag-collapse its own transient `data-sidebar-preview` state.
The files panel remains mounted, while fixed agent UI now follows the same
collapsed or expanded selectors during the drag threshold crossing instead of
waiting for React's committed `data-sidebar` state on pointer-up.

Follow-up correction: the collapsed drag preview hides the main sidebar again
so the files panel stays visible. Reverse-drag now uses a separate `opening`
preview state that keeps the main sidebar hidden until the gesture commits,
avoiding the mid-drag flash without regressing files.

Verification:

- `pnpm test -- src/test/sidebar-resize.test.ts`
- `pnpm test -- src/test/agent-workspace.test.tsx`
- `pnpm run lint`
- `pnpm run build`

Rendered validation note: the in-app Browser runtime was present, but the `iab`
browser was unavailable in this Conductor session. The project also does not
ship Playwright, so validation used focused unit/component coverage plus build.
