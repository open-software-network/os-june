# GitHub agent reads design

> Transport update (2026-07-17): the bearer-authenticated loopback MCP design
> below was rejected during security review because shared Hermes configuration
> did not isolate the bearer from sibling subprocesses. The fixed read contract,
> repository authorization, and content policy remain current; the transport and
> runtime capability boundary are superseded by
> [GitHub agent-read capability isolation design](2026-07-17-github-agent-read-capability-isolation-design.md)
> and [ADR 0033](../../adr/0033-kernel-authenticated-github-read-broker.md).

## Context

GitHub connector Phase 0 authenticates a GitHub App user, keeps the rotating
credential in Keychain, discovers App installations, and persists a
non-secret snapshot of the repositories selected on GitHub. It does not yet
give June's agent a tool for reading those repositories.

The first agent-facing slice is deliberately read-only. In every interactive
June session, the currently selected model may list and inspect selected
repositories, issues, and pull requests. This includes online models: GitHub
provider calls remain direct from the Mac to GitHub, but the bounded result may
be included in inference context sent to the model provider selected for that
session. June must not describe on-device connector traffic as preventing the
selected model provider from receiving retrieved content.

Issue and pull request creation, comments, reviews, merges, and repository
content changes are a later phase. They require new GitHub App permissions, a
separate action server, and approval and revalidation policies that are not
part of this design.

The live revocation defect documented in
[GitHub revocation reconnect design](2026-07-16-github-revocation-reconnect-design.md)
is a prerequisite. Read tools cannot ship until a revoked credential reliably
transitions to `reconnect_required` and invalidates agent access.

## Goals

- Make an approved read toolset available automatically in every interactive
  June session when GitHub is healthy and at least one repository is selected.
- Execute these bounded read operations without a per-call approval prompt.
- Bind every repository-specific operation to the stable `repository_id` in
  June's current selected-repository snapshot.
- Keep GitHub credential custody and GitHub REST traffic on the user's Mac.
- Return useful, bounded, source-attributed repository, issue, and pull
  request data without cloning or indexing a repository.
- Treat all repository-controlled data as untrusted content rather than agent
  instructions.
- Fail closed when authorization, installation, permission, or repository
  selection changes.

## Non-goals

- No GitHub mutation, including creating or editing issues, comments, reviews,
  merges, branches, refs, or repository content.
- No arbitrary GitHub REST or GraphQL proxy.
- No repository clone, checkout, background index, webhook, installation
  private key, installation-token signer, or GitHub credential in June API.
- No persistent cache of file contents, diffs, issue bodies, comments, or pull
  request data.
- No Discussions, Actions logs, releases, deployments, security alerts, or
  other GitHub surfaces in this slice.
- No scheduled-routine access. The first slice is for interactive June
  sessions; routine trust and source-scoping require a separate design.

## GitHub App permissions

The staging and production GitHub Apps must request these repository
permissions, all read-only:

| GitHub setting | Permission key | Why it is needed |
| --- | --- | --- |
| Metadata | `metadata` | Repository identity and metadata |
| Contents | `contents` | Directory browsing, code search, and file reads |
| Issues | `issues` | Issues and issue comments |
| Pull requests | `pull_requests` | Pull request metadata, files, commits, reviews, and review comments |
| Checks | `checks` | Check runs for a pull request head commit |
| Commit statuses | `statuses` | Combined commit statuses for a pull request head commit |

Changing App permissions can require an organization owner to approve the
installation update. June reads the installation permission snapshot already
stored during discovery. A repository is tool-eligible only when its
unsuspended installation has all required permissions at read level, and
`june_github` is registered only when at least one selected repository is
tool-eligible. Selected repositories on an installation awaiting permission
approval remain visible in settings but are not exposed to the agent. A stale
or insufficient permission snapshot fails closed with a sanitized
setup-required error and requires a fresh installation refresh; it never falls
through to an unvalidated API call. When no selected repository is
tool-eligible because approval is missing, the existing `setup_incomplete`
connection state communicates that setup is still required; this phase adds no
new settings status or permission-specific copy.

No write permission is requested in this phase.

## Architecture

June extends the app-proxied MCP boundary accepted by
[ADR 0016](../../adr/0016-private-connectors-local-mode.md):

1. A bundled, stdlib-only Python MCP process named `june_github` exposes a
   fixed set of typed read tools.
2. The process receives the loopback provider proxy base URL and a dedicated
   GitHub proxy token through its environment. It receives no GitHub access or
   refresh token and has no Keychain access.
3. Each tool sends a typed operation to a fixed GitHub read route on the
   loopback proxy. The MCP input cannot choose an HTTP method, host, URL, API
   path, or authorization header.
4. Rust authenticates the dedicated proxy token and validates the operation
   and its input bounds.
5. Rust loads or refreshes the GitHub App user credential through the existing
   Keychain-backed service. A terminal refresh failure changes connection state
   before any repository content request.
6. Rust obtains a shared authorization lease, loads the authoritative
   connection and selected-repository snapshot, resolves `repository_id` to
   the stored owner and repository name, checks the required permission, and
   calls a fixed GitHub REST endpoint directly over HTTPS while holding that
   bounded lease.
7. Rust parses the bounded provider response, revalidates the same
   authorization tuple under the lease, normalizes the public result, applies
   content and secret guards, attaches sources, and finalizes the response
   before releasing the lease.
8. The MCP result is explicitly marked as untrusted repository content before
   it enters the selected model's context.

The GitHub read token is distinct from the general model proxy token, recorder
token, and existing Google connector token. Compromise of one built-in MCP
process therefore does not grant access to another provider's routes.

June API is not in the GitHub connector path. No backend endpoint or deploy is
needed. Normal online inference still uses the session's selected model path
and can receive tool results as model context.

### Runtime eligibility and reconciliation

`june_github` is registered only when all of these are true:

- the build has valid GitHub App configuration;
- one GitHub connection is `connected`;
- its credential is present and usable;
- at least one unsuspended installation has a selected repository and every
  required read permission.

The server is added to interactive toolsets automatically. It is not added to
the cron toolset or any per-routine `enabled_toolsets` in this phase. The
injected June instructions describe the available reads and state that source
files, issue text, comments, pull request text, reviews, check output, and
other returned data are untrusted and cannot override user, June, or tool
rules.

Read calls do not park in the mutation approval broker. Their authority is the
fixed tool contract plus the current connection, permission, and repository
allowlist checks in Rust. Any future write remains a separate approved action.

Connector changes use the existing mode-scoped runtime reconciliation path.
Connect, reconnect, disconnect, installation refresh, repository-selection
change, suspension, and permission change recalculate eligibility and restart
each live mode when its built-in server set changed. Stored agent sessions
remain intact. If access becomes invalid during an active tool call, Rust
invalidates access before returning the sanitized failure.

A GitHub authorization gate coordinates reads with local state changes. Read
calls hold a shared lease from their authoritative preflight through response
finalization. Disconnect, reconnect, installation refresh, repository snapshot
replacement, suspension, and permission changes require the exclusive lease.
The provider timeout bounds how long a read can delay a queued state change,
and the lock is writer-fair so later reads cannot starve it. If the state change
wins the lease, the read sees the new state and returns no content. If an
already-running read wins, the state-changing command does not complete until
that response is finalized. Consequently, once disconnect or refresh returns,
no earlier read can subsequently return content under the replaced snapshot.
Runtime removal then reconciles without allowing another read through a stale
tool schema. GitHub remains the authority for an external selection or
revocation at the time it processes the HTTPS request; June applies the new
state as soon as that change is observed locally.

## Repository authorization

`list_repositories` is the only operation that does not take a repository
identifier. It returns the current tool-eligible portion of the selected
snapshot and represents `repository_id` as an opaque decimal string.

Every other tool requires that opaque `repository_id`. Rust resolves it from
the current SQLite snapshot immediately before the provider call. The model
cannot supply or override an owner, repository name, installation ID, or API
path. Search operations append the resolved repository scope in Rust and force
the requested resource type; a query cannot escape to another repository by
including GitHub search qualifiers.

The same authorization tuple is checked again after the provider response and
before returning any content while the shared authorization lease is still
held. Local state replacement takes the exclusive lease. The ordering is
therefore explicit: either the read finalizes under the old state before the
change takes effect, or the change takes effect first and the read returns no
content. A completed disconnect or refresh can never be followed by content
from a read authorized under the replaced snapshot.

The local snapshot is an allowlist, not the final proof of access. GitHub also
enforces the App installation's live repository selection. A provider 403 or
404 never causes June to probe a broader name. June refreshes the non-secret
snapshot when appropriate and returns a single access-removed or not-found
result that does not reveal whether an unselected repository exists.

## Tool contract

The built-in server exposes only these tools:

| Tool | Purpose | Principal inputs |
| --- | --- | --- |
| `list_repositories` | List repositories currently selected for June | `cursor`, `limit` |
| `get_repository` | Read repository metadata and default branch | `repository_id` |
| `list_directory` | Browse one repository directory at a ref | `repository_id`, `path`, `ref`, `cursor`, `limit` |
| `read_file` | Read a bounded line window from one text file | `repository_id`, `path`, `ref`, `start_line`, `line_count` |
| `search_code` | Search paths and bounded matches in one repository | `repository_id`, `query`, `cursor`, `limit` |
| `list_issues` | List or search issues, excluding pull requests | `repository_id`, `state`, `query`, `labels`, `cursor`, `limit` |
| `get_issue` | Read one issue | `repository_id`, `number` |
| `list_issue_comments` | Read one issue's comments | `repository_id`, `number`, `cursor`, `limit` |
| `list_pull_requests` | List or search pull requests | `repository_id`, `state`, `query`, `base`, `head`, `cursor`, `limit` |
| `get_pull_request` | Read one pull request and its head/base identities | `repository_id`, `number` |
| `list_pull_request_files` | List changed-file metadata and issue an opaque reference for each file | `repository_id`, `number`, `cursor`, `limit` |
| `read_pull_request_file_diff` | Read a bounded provider-supplied patch for one referenced file | `repository_id`, `number`, `file_ref`, `cursor` |
| `list_pull_request_commits` | List commits in a pull request | `repository_id`, `number`, `cursor`, `limit` |
| `list_pull_request_reviews` | List submitted reviews | `repository_id`, `number`, `cursor`, `limit` |
| `list_pull_request_review_comments` | List inline review comments | `repository_id`, `number`, `cursor`, `limit` |
| `list_pull_request_checks` | List check runs and commit statuses for the current head SHA | `repository_id`, `number`, `cursor`, `limit` |

Issue and pull request numbers are positive integers. An omitted ref resolves
to the repository's current default branch. A supplied ref remains inside the
already authorized repository and is length- and character-bounded before use.
Repository paths are relative, normalized strings; absolute paths, NULs,
backslashes, empty non-root paths, and `.` or `..` traversal segments are
rejected.

List tools default to 30 items and accept at most 50. Continuation uses opaque,
server-issued cursors bound to the operation, repository, and original
filters. A cursor cannot carry a user-controlled provider URL or change the
authorization scope. Cursor state contains pagination metadata only, lives in
process memory, expires, and is never persisted.

Each item from `list_pull_request_files` includes an opaque `file_ref` bound to
the repository, pull request number, observed head SHA, absolute file index,
and expected path. `read_pull_request_file_diff` re-reads the fixed list-files
endpoint with `per_page=1` and the bound index, then verifies the head and path
before returning the provider-supplied patch. It does not search pages by a
model-supplied path or download a whole-PR diff.

GitHub does not certify that every returned `patch` field is a complete file
diff. June therefore labels a present patch `provider_supplied` rather than
claiming completeness. An omitted patch is `unavailable`, and a single-file
response above June's defensive ceiling is `response_too_large`. Continuation
can traverse only patch text June successfully parsed; it never invents bytes
GitHub did not provide. The list-files endpoint exposes at most 3,000 files, so
June reports `provider_file_limit_reached` when the pull request's changed-file
count exceeds that [documented limit](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2026-03-10#list-pull-requests-files).

Every result uses a common envelope containing:

- `trust: "untrusted_repository_content"`;
- normalized data or items;
- truncation and continuation information;
- one or more source references with repository full name, GitHub URL, stable
  object ID or number, and path plus ref/SHA when applicable.

Tool failures use stable sanitized application codes and never include a
credential, provider response body, raw authorization header, internal
loopback token, or provider URL assembled with user-controlled data.

## Response and content bounds

- A normalized tool response is at most 256 KiB. When useful content remains,
  the result says it was truncated and provides a continuation cursor.
- A file read returns at most 1,000 lines and 256 KiB. The next read must ask
  for another explicit line window; June never reads the rest automatically.
- A per-file diff response returns at most 2,000 lines and 256 KiB. A cursor
  can continue only within patch text GitHub actually returned for the same
  head SHA. Large pull requests are traversed explicitly through changed-file
  pages and their opaque file references.
- Issue bodies, pull request bodies, comments, review bodies, check output,
  commit messages, and code-search matches are individually bounded before
  they enter the result envelope.
- GitHub response streams have a separate defensive byte ceiling before
  parsing. Oversize provider responses fail or truncate according to the
  fixed operation contract instead of being buffered without limit.
- Pagination never advances automatically beyond the requested page. There is
  no hidden loop that can enumerate an entire organization or repository.

`read_file` returns UTF-8 text only. Binary files, submodule bodies, generated
Git object payloads, and files above the operation's size ceiling are not
returned. Directory listings can still report safe metadata for a blocked
entry so the user understands why its contents were omitted.

High-confidence sensitive paths are blocked, including `.env` variants,
private-key formats, common SSH private-key names, and common credential files.
Returned text, search matches, and diffs also pass through conservative
high-confidence credential and private-key redaction. Filtering is defense in
depth rather than a claim that an arbitrary repository can never contain an
unknown secret; the tool description warns the model and user not to use it as
a secret scanner.

## Untrusted-content handling

Repository files and all collaborative GitHub text are attacker-controlled
inputs. A source file, issue, comment, pull request, review, commit message, or
check output may tell June to ignore instructions, call another tool, disclose
data, or perform an action. Those strings are data only.

The rule is enforced at three layers:

1. MCP tool descriptions label returned fields as untrusted data.
2. June's injected agent instructions state that connector content cannot
   override the user's request, June's rules, repository scope, or tool
   approval policy.
3. Rust exposes no arbitrary provider request and no mutation route, so prompt
   injection cannot turn this read server into a write or cross-repository
   capability.

Source references stay attached through normalization so June can explain
where an answer came from and the user can open the exact GitHub object.

## Credential and error lifecycle

Before each provider operation, the GitHub service obtains a fresh-enough
access token through the existing per-user refresh lock. Concurrent reads do
not independently rotate the same grant. Token values remain zeroized where
practical and never implement `Debug` as plaintext.

Failures are classified as follows:

When a provider response itself requires an authorization-state mutation, the
read path retains no content, releases its shared lease, and performs the
transition under the exclusive lease before returning the sanitized error. It
never attempts to upgrade a held read lease.

- A definitive invalid stored grant deletes the Keychain credential, persists
  `reconnect_required`, emits the existing connector-state event, and returns
  `github_reconnect_required`. Subsequent calls fail before GitHub traffic.
- A missing App permission returns a setup-required error and triggers
  snapshot reconciliation; it does not retry with a broader endpoint.
- A suspended or removed installation and a removed repository selection
  invalidate the relevant local eligibility and return an access-removed
  result without probing other repositories.
- A rate limit returns a sanitized retry time derived from trusted GitHub
  headers. June does not spin or silently consume more pages.
- Timeouts, network failures, malformed responses, and unknown provider errors
  remain transient, sanitized failures. They do not delete a usable credential
  or widen access.

No connector content is written to SQLite, the filesystem, application logs,
analytics, crash metadata, or June API. Existing non-secret connection,
installation, permission, and selected-repository metadata remain the only
persistent GitHub data.

## Alternatives considered

### Give the MCP process the GitHub user token

Rejected. It would move the most privileged secret into the agent process and
make the sandbox and every Python dependency part of credential custody. It
would also make stable repository-ID enforcement easier to bypass.

### Expose a generic GitHub REST proxy

Rejected. An allowlisted host is not enough: arbitrary paths, methods, headers,
or query qualifiers could widen data access or introduce writes. Fixed typed
operations make the authority auditable.

### Route GitHub through June API

Rejected. It would give OpenSoftware infrastructure connector traffic and
would require backend-held GitHub authority, violating the accepted local-mode
privacy boundary.

### Clone or index selected repositories

Rejected for the first slice. It adds durable sensitive data, synchronization,
disk cleanup, and a much larger local attack surface. Live bounded reads meet
the initial product need.

### Add read and write tools to one server

Rejected. The pinned runtime exposes an MCP server as one toolset, and normal
MCP calls do not pass through Hermes approval. A separate future
`june_github_actions` server gives Rust an explicit mutation boundary and lets
June omit that entire authority until the user enables and approves it.

## Verification

Implementation is test-first and covers four layers.

### Rust protocol and policy tests

- Every operation selects the exact fixed method, API path template, headers,
  and required permission against a loopback mock GitHub server.
- No request input can choose a host, method, raw path, owner, repository name,
  installation ID, or authorization header.
- Repository-ID binding, stale selection, suspension, missing permissions,
  search qualifier injection, path traversal, invalid refs, and object-number
  bounds fail closed.
- Disconnect, reconnect, permission refresh, suspension, and repository
  selection replacement racing an in-flight provider response obey the
  authorization lease: a winning write blocks or rejects the read, while a
  winning read finalizes before the state-changing operation can complete.
- Pagination cursors cannot be replayed across operations, repositories, or
  filters and cannot encode a provider URL.
- Provider response ceilings, item limits, line windows, diff limits,
  truncation, binary detection, sensitive-path blocking, and high-confidence
  redaction are deterministic.
- Pull request file references are bound to repository, pull request, head SHA,
  absolute index, and expected path. Provider-omitted and oversize patches and
  the 3,000-file provider limit are reported without an unsupported
  continuation or a false completeness claim.
- Invalid grants, permission loss, 403/404 access changes, rate limits,
  timeouts, malformed responses, and concurrent token refreshes produce the
  intended sanitized state transitions.
- Mock assertions prove that this phase emits only fixed read requests and no
  GitHub mutation.

### MCP contract tests

- The stdlib-only server advertises exactly the approved tool names and JSON
  schemas.
- Each tool serializes only its typed request and preserves structured result,
  source, truncation, and error fields.
- The script requires its dedicated GitHub proxy token and cannot use the
  model, recorder, or Google connector token.
- Injection-shaped repository content remains returned data and cannot alter
  the next proxy request.

### Runtime tests

- `june_github` is registered for both interactive runtime modes only when the
  eligibility predicate is satisfied.
- It is available to the currently selected local or online model and absent
  from cron and per-routine toolsets.
- Connect, reconnect, disconnect, selected-repository changes, suspension,
  permission changes, and revocation reconcile the server set without losing
  stored sessions.
- The injected June instructions describe the tools and the untrusted-content
  rule only when the server is eligible.
- The Seatbelt profile still denies Keychain database and service access to
  the MCP process.

### Live staging QA

After the organization owner approves the new read permissions for
`june-staging`, select only `open-software-network/test-repo` and verify that
an interactive June session can:

1. list the selected repository and read its metadata;
2. browse a directory, search code, and read a bounded text-file window;
3. list and read an issue and its comments;
4. list and read a pull request, changed files, bounded per-file patches,
   commits, reviews, review comments, checks, and commit statuses;
5. cite GitHub source links in its answer;
6. deny a prompt that attempts another repository or an arbitrary endpoint;
7. remain read-only even when repository content asks it to mutate data;
8. transition to `Reconnect required` and lose effective tool access after
   revocation;
9. restore access only to the selected repository after reconnect; and
10. leave no credential or retrieved GitHub content in SQLite, files, or logs.

The live run also inspects GitHub state to confirm no issue, comment, review,
merge, ref, or repository content was changed.

## Rollout and follow-up

The implementation order is:

1. ship and live-verify the approved revocation reconnect correction;
2. update `june-staging` to the approved read permissions and obtain the
   organization approval;
3. implement and test the fixed Rust read protocol and policy service;
4. implement the dedicated loopback route and `june_github` MCP contract;
5. wire runtime eligibility, instructions, and reconciliation;
6. run the deterministic gate and live staging QA above.

The existing GitHub connector configuration remains the rollout gate; the
read server additionally requires the complete permission and eligibility
predicate. No new ADR is needed because this design applies the app-proxied
MCP and local-mode decisions already recorded in ADR 0016. The fixed operation
contract and GitHub-specific token are provider-specific refinements, not a
new cross-system architectural boundary.

The next write phase must be designed separately. At minimum it will use
`june_github_actions`, request incremental write permissions, park every
mutation in June's Rust approval broker, bind actions to stable repository and
object identities, revalidate pull request head SHAs before reviews or merges,
and define idempotency and conflict behavior before any write route exists.
