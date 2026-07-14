# PRD: Computer use plugin

- **Mode:** CEO
- **Rank:** 5 of 10
- **Score:** 81/100
- **Date:** 2026-07-13
- **Status:** Accepted phase 2 in JUN-278
- **Canonical detailed spec:** [../browser-computer-use-prd.md](../browser-computer-use-prd.md)

## Thesis

Computer use is June's universal adapter for Mac work that has no safe API or
browser path. It lets June operate another app in the background without
stealing the user's cursor, keyboard focus, or active Space. It is strategically
powerful and technically risky, which is why it ranks behind Browser use and
the two dominant work ecosystems.

## Customer and problem

Important follow-through still happens in desktop apps: legacy practice tools,
local files, native communication apps, and proprietary workflows. The user
cannot delegate these jobs to June today. Traditional screen-driving agents
also take over the desktop, expose unrelated content, and make silent mistakes.

## Product promise

Grant access deliberately, see every mutating step before it runs, keep using
the Mac while June works in the background, and revoke the capability at any
time.

## V1 experience

- The plugin tile explains Accessibility and Screen recording before macOS
  prompts appear.
- June reports whether the selected model can use the capability.
- The user chooses a target app/task; June captures a bounded representation
  and proposes actions.
- Every mutating action requires approval in chat.
- The user sees progress and can stop immediately.
- Disconnect removes June's runtime grant; macOS permissions can also be
  revoked from System Settings.

## Scope

Phase 2 is macOS-only, attended sessions only, vision-capable models only, and
uses the pinned runtime's computer-use toolset with a June-bundled driver.
Routines, credential entry, payment entry, security settings, destructive
system operations, and Windows support are out of scope.

## Privacy and trust

Screen captures needed for reasoning follow the user's selected inference path.
June must never imply that Screen recording means captures stay local when the
selected model is remote. The driver is pinned and signed; the upstream network
installer never runs. Mutating actions are gated structurally, not by a prompt.

## Business model

Launch as Pro because of support burden, model requirements, and risk. Revisit
after reliability and cost data. Permission education and the ability to revoke
are available regardless of plan.

## Success measures

| Metric | Target |
| --- | ---: |
| Eligible users completing TCC setup | 60% |
| Supported tasks completed without user takeover | 65% |
| Mutating actions without a June approval | 0 |
| Cursor/focus theft incidents | 0 |
| Driver crash rate per task | under 1% |
| Median user corrections per completed task | under 1 |

## Risks and gates

- The driver uses private macOS interfaces and may break on OS updates.
- Screen capture has a larger privacy blast radius than structured connectors.
- Model visual mistakes can target the wrong element.
- App sandbox and TCC behavior must be proven on signed release builds.

## Decision

The direction is accepted, but phase 2 stays gated on the driver-under-sandbox
spike and a release self-test. Do not expand it to routines at launch.
