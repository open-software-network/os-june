# Focus QA

Run automated gates first, then use the real Tauri app for the workflow checks.
Do not substitute a Vite-only preview for sleep, relaunch, deep-link, native
notification, or SQLite persistence evidence.

## Automated coverage

| Risk | Coverage |
| --- | --- |
| Pause excludes elapsed time | deterministic Rust repository test |
| Planned boundary enters overtime | deterministic Rust repository test |
| Sleep crosses break and focus boundaries | deterministic Rust repository test |
| UI, agent, or deep-link race starts two sessions | SQLite partial-unique-index test |
| Project deletion erases history labels | Project snapshot repository test |
| Split or reassign changes total time | repository invariant test |
| App close and reopen loses active state | real SQLite file reopen test |
| Deep-link route accepts ambiguous or broad inputs | Rust parser allowlist tests |
| Shortcut name becomes shell syntax or is lost from a plan | native argument-boundary and repository persistence tests |
| Display duration or split midpoint drifts | frontend helper tests |
| MCP schema or route-token scopes regress | Python self-test and Rust bridge tests |

## Live Tauri checklist

1. Open Focus from the primary sidebar and create a 25-minute single session.
2. Pause, wait, and resume. Confirm the focused total excludes the paused span.
3. Finish early, add a reflection and quality, then reopen it in History.
4. Start an interval plan, start its planned break, and confirm the next focus
   interval starts with the chosen next Project.
5. Split a completed segment evenly and reassign one half. Confirm the four
   totals do not change.
6. Start Focus with `osjune://focus/start?...`, then use pause, resume, finish,
   and open routes. Confirm each opens the Focus workspace.
7. Start Focus through the June agent, ask for status, and finish it. Confirm
   the app and agent report the same session.
8. Put the Mac to sleep across a short test boundary. On wake, confirm the app
   reconciles to the correct break, focus, or overtime state and posts only the
   appropriate transition notification.
9. Relaunch June during an active session and confirm intention, Project,
   state, and elapsed totals recover.
10. Rename and delete a Project used by completed history. Confirm its saved
    name remains in the timeline.
11. Create a test Shortcut that enables a macOS Focus mode. Select it under
    **Start shortcut**, start Focus, and confirm it runs once. Pause and resume;
    confirm it does not run again.
12. Select a Shortcut that exits unsuccessfully. Confirm the Focus session
    still starts and June shows the Shortcut warning.

## Explicit non-claims

This QA pass does not claim browser-site or macOS app blocking. Those controls
are not present. It does verify that Focus remains fully usable without them.
