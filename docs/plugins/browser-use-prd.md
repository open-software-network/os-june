# PRD: Browser use plugin

- **Mode:** CEO
- **Rank:** 2 of 10
- **Score:** 91/100
- **Date:** 2026-07-13
- **Status:** Accepted direction in JUN-278
- **Canonical detailed spec:** [../browser-computer-use-prd.md](../browser-computer-use-prd.md)

## Thesis

Browser use is June's universal adapter for web work that does not yet have a
first-party connector. It turns June from an assistant that explains what to
do into one that can do the work in visible, bounded tabs while the user keeps
control of consequential actions.

It ranks second because it multiplies every other plugin and prevents the
portfolio from becoming a race to build one provider at a time. It does not
replace connectors: connectors offer narrower scopes, structured data, safer
actions, and routine support; Browser use covers the long tail and signed-in
web flows.

## Customer and problem

June can search and fetch web pages, but users still perform interactive work:
open a site, navigate stateful pages, fill a form, attach a file, or complete a
workflow inside an existing login. Giving an agent an unrestricted browser
profile would solve the capability problem by creating a larger trust problem.

## Product promise

June works only in clearly marked tabs it creates or a tab the user explicitly
shares. It pauses before sending, submitting, publishing, purchasing, deleting,
or making another consequential change. Disconnect means the browser is no
longer under June's control.

## V1 experience

- The Plugins tile guides installation and pairing of the June browser
  extension.
- June opens task-owned tabs in a visible group and can use the user's existing
  signed-in session there.
- The user may share one existing tab explicitly; all other existing tabs are
  out of bounds.
- June shows screenshots and progress in chat.
- Sensitive fields for passwords, one-time codes, and payment data always
  require human takeover.
- Sandboxed routines use a separate anonymous, ephemeral managed browser for
  public sites, never the user's profile.
- Stop and disconnect are always visible and immediate.

## Scope boundaries

Launch on Chromium-family browsers on macOS. Do not bundle a browser engine,
automate credentials or payment fields, create persistent per-site autonomy,
or expose signed-in sessions to unattended routines. Computer use is a
separate plugin and grant.

## Privacy and trust

Page content needed for reasoning follows the user's selected inference path.
The extension, native shim, and Rust broker stay on-device. June does not send
the user's browsing history or unrelated tabs to OpenSoftware. Policy lives in
the broker, not in a prompt.

## Business model

Attended Browser use should be available on Hobby during launch to maximize
trust feedback. Routine browsing and higher automation limits are Pro. There
is no provider API fee; model and support costs determine final packaging.

## Success measures

| Metric | Target |
| --- | ---: |
| Users completing pairing after opening the tile | 70% |
| Browser tasks with a user-confirmed or predeclared broker-verifiable outcome | 75% |
| Consequential actions executed without a valid approval | 0 |
| Sessions touching an unshared pre-existing tab | 0 |
| Median time from access request to first snapshot | under 90 seconds |

A verifiable outcome is defined before execution and recorded by the broker,
such as reaching a target state, producing the requested artifact, or receiving
an action receipt. Agent self-reported completion does not count.
| Users disconnecting because behavior surprised them | under 2% |

## Strategic risks

- Extension-store approval and independent update cadence are release risks.
- Browser DOMs change constantly; recovery quality matters more than demo-path
  success.
- Signed-in pages contain prompt injection and high-value actions. Structural
  tab isolation and broker approvals are mandatory.
- The plugin must never become an excuse to skip a safer structured connector
  for high-frequency workflows.

## Decision

The direction is already accepted. Ship Browser use before Computer use, keep
the user's profile attended-only, and treat the browser broker as a reusable
policy boundary for the portfolio.
