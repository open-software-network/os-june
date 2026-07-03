# ADR 0011: Bundle selected Hermes skills as read-only resources

Date: 2026-07-03
Status: accepted

## Context

June embeds a pinned Hermes runtime instead of tracking upstream `main`. The
current runtime pin is `v2026.6.19`, and runtime bumps are gated by the Hermes
upgrade checklist because they can change the bridge contract, dashboard API,
event stream, skill behavior, and bundled dependencies.

The requested `unbroker` security skill exists upstream on Hermes `main`, but it
is not present in the current pin or in the latest tagged Hermes release
available when this decision was made (`v2026.7.1`). Bumping June directly to an
untagged upstream commit would pull unrelated runtime changes into a production
desktop app only to expose one skill.

## Decision

June may vendor selected upstream Hermes skills under
`src-tauri/resources/hermes-skills/` and ship them as read-only Tauri resources.
The Tauri bundle maps that directory to `native/hermes-skills`, and the Hermes
bridge registers it through `skills.external_dirs` after user-managed skill
directories.

Skill lookup precedence is:

- `$HERMES_HOME/skills` for Hermes-managed skills.
- `~/.agents/skills` for user or team-installed skills.
- June's bundled resource directory for app-owned fallback skills.

That order means user/profile-installed skills can shadow a bundled skill with
the same name. It also keeps the app-bundled copy read-only and clearly owned by
June.

## Consequences

- June can ship a narrowly selected skill without taking an untagged Hermes
  runtime bump.
- Bundled skill provenance lives in the resource directory README and must be
  revisited during every Hermes pin bump through
  [docs/hermes-upgrade-checklist.md](../hermes-upgrade-checklist.md).
- Bundled skills are app resources, not profile state. They are updated only by
  app releases.
- This pattern should stay rare. If a skill is available in the next acceptable
  Hermes pin, prefer removing the vendored copy over maintaining a fork.

## Alternatives considered

- **Bump Hermes to upstream `main`.** Rejected: that would ship unrelated
  runtime changes outside the pinned-release process.
- **Wait for a Hermes tag containing the skill.** Rejected: the skill was needed
  before an acceptable tagged runtime contained it.
- **Copy the skill into `$HERMES_HOME/skills`.** Rejected: that would mutate
  profile-owned runtime state and blur ownership between user-managed and
  app-managed skills.
