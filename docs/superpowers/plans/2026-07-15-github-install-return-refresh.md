# GitHub installation return refresh implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically run one read-only GitHub installation refresh when June regains focus after opening GitHub App installation or repository-management settings.

**Architecture:** `GitHubConnectorRow` will arm a component-local ref only for a successful installation-management browser handoff. A stable `window` focus listener consumes the ref once and invokes the existing complete-snapshot refresh, while the existing lifecycle generation remains authoritative for disconnect and unmount races.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, existing Tauri TypeScript bindings

## Global constraints

- No polling and no GitHub request on unrelated app focus.
- Installation actions continue to pass no URL and only an optional stable installation ID to Rust.
- Refresh remains read-only and replaces the complete Rust DTO.
- Unknown provider failures use the existing sanitized GitHub fallback; never render raw provider data.
- Disconnect and unmount invalidate late refresh success, failure, and cleanup.
- Preserve Google behavior and the single `june://connectors-changed` listener.
- UI copy stays sentence case with no typographic dashes or all-caps styling.
- Add no package, Rust command, database migration, GitHub permission, June API route, or GitHub write operation.

---

### Task 1: Refresh once after the installation browser returns

**Files:**

- Modify: `src/components/settings/GitHubConnectorRow.tsx`
- Test: `src/test/github-connector-row.test.tsx`
- Evidence only: `.superpowers/sdd/task-9-report.md`

**Interfaces:**

- Consumes: `githubInstallationOpen(installationId?: string): Promise<void>` from `src/lib/tauri.ts`
- Consumes: `githubInstallationsRefresh(): Promise<GitHubConnection>` from `src/lib/tauri.ts`
- Produces: one-shot automatic refresh after a successful install or manage browser handoff
- Preserves: `onConnectionChanged(connection: GitHubConnection | null): void`

- [ ] **Step 1: Add the failing install, manage, and one-shot tests**

Add these tests beside the existing installation-action and refresh tests in
`src/test/github-connector-row.test.tsx`. They use the file's existing
`connection`, `installation`, `repository`, and `StatefulRow` helpers.

```tsx
it("automatically refreshes once when June regains focus after installation", async () => {
  const installed = connection({
    status: "connected",
    installations: [installation({ repositories: [repository("test-repo")] })],
  });
  mocks.githubInstallationsRefresh.mockResolvedValue(installed);
  render(
    <StatefulRow
      initial={connection({ status: "setup_incomplete", installations: [] })}
    />,
  );

  await userEvent.click(screen.getByRole("button", { name: "Install GitHub App" }));
  expect(mocks.githubInstallationOpen).toHaveBeenCalledTimes(1);
  expect(mocks.githubInstallationOpen).toHaveBeenCalledWith();
  expect(mocks.githubInstallationsRefresh).not.toHaveBeenCalled();

  await act(async () => window.dispatchEvent(new Event("focus")));

  expect(await screen.findByText("octocat · 1 repository")).toBeInTheDocument();
  expect(mocks.githubInstallationsRefresh).toHaveBeenCalledTimes(1);

  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(mocks.githubInstallationsRefresh).toHaveBeenCalledTimes(1);
});

it("automatically refreshes after managing one stable installation id", async () => {
  const setupIncomplete = connection({
    status: "setup_incomplete",
    installations: [installation({ repositories: [] })],
  });
  mocks.githubInstallationsRefresh.mockResolvedValue(
    connection({
      installations: [installation({ repositories: [repository("test-repo")] })],
    }),
  );
  render(<StatefulRow initial={setupIncomplete} />);

  await userEvent.click(
    screen.getByRole("button", { name: "Manage repositories for octo-org" }),
  );
  expect(mocks.githubInstallationOpen).toHaveBeenCalledWith("installation-octo-org");

  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(await screen.findByText("octocat · 1 repository")).toBeInTheDocument();
  expect(mocks.githubInstallationsRefresh).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run the targeted tests and verify RED**

Run:

```bash
pnpm test src/test/github-connector-row.test.tsx -t "automatically refreshes"
```

Expected: both new tests fail because dispatching `window` focus does not call
`githubInstallationsRefresh`; existing installation-open assertions still pass.

- [ ] **Step 3: Add the minimal one-shot focus behavior**

In `GitHubConnectorRow.tsx`, import `useCallback` and add stable refs for the
latest parent callback, refresh activity, and the armed browser return:

```tsx
import { useCallback, useEffect, useRef, useState } from "react";

const onConnectionChangedRef = useRef(onConnectionChanged);
const refreshingRef = useRef(false);
const installationReturnRefreshArmed = useRef(false);

useEffect(() => {
  onConnectionChangedRef.current = onConnectionChanged;
}, [onConnectionChanged]);
```

Replace the current `refreshInstallations` function with a stable callback. The
ref prevents duplicate requests even before React commits the busy state:

```tsx
const refreshInstallations = useCallback(async () => {
  if (refreshingRef.current) return;
  const generation = lifecycleGeneration.current;
  refreshingRef.current = true;
  setRefreshing(true);
  setError(null);
  try {
    const nextConnection = await githubInstallationsRefresh();
    if (generation !== lifecycleGeneration.current) return;
    onConnectionChangedRef.current(nextConnection);
  } catch (cause) {
    if (generation !== lifecycleGeneration.current) return;
    setError(githubErrorMessage(cause));
  } finally {
    refreshingRef.current = false;
    if (generation === lifecycleGeneration.current) setRefreshing(false);
  }
}, []);
```

Add one stable focus listener after the callback. Consume the marker before
starting refresh so repeated focus events cannot duplicate the request:

```tsx
useEffect(() => {
  function refreshAfterInstallationReturn() {
    if (!installationReturnRefreshArmed.current) return;
    installationReturnRefreshArmed.current = false;
    void refreshInstallations();
  }

  window.addEventListener("focus", refreshAfterInstallationReturn);
  return () => {
    installationReturnRefreshArmed.current = false;
    window.removeEventListener("focus", refreshAfterInstallationReturn);
  };
}, [refreshInstallations]);
```

Arm only after Rust successfully opens the provider page:

```tsx
async function openInstallation(installationId?: string) {
  setError(null);
  try {
    if (installationId) await githubInstallationOpen(installationId);
    else await githubInstallationOpen();
    installationReturnRefreshArmed.current = true;
  } catch (cause) {
    installationReturnRefreshArmed.current = false;
    setError(githubErrorMessage(cause));
  }
}
```

Clear both transient authorities before disconnect and during the existing
unmount cleanup:

```tsx
// Existing unmount cleanup
installationReturnRefreshArmed.current = false;
lifecycleGeneration.current += 1;

// Start of disconnect()
installationReturnRefreshArmed.current = false;
refreshingRef.current = false;
const generation = ++lifecycleGeneration.current;
```

- [ ] **Step 4: Run the targeted tests and verify GREEN**

Run:

```bash
pnpm test src/test/github-connector-row.test.tsx -t "automatically refreshes"
```

Expected: 2 tests pass, with one refresh per successful browser return and no
React act warning or unhandled rejection.

- [ ] **Step 5: Add failure and lifecycle regression tests**

Add these tests to the same suite:

```tsx
it("does not arm return refresh when installation settings fail to open", async () => {
  mocks.githubInstallationOpen.mockRejectedValue({
    code: "github_request_failed",
    message: "raw shell failure",
  });
  render(
    <GitHubConnectorRow
      connection={connection({ status: "setup_incomplete", installations: [] })}
      loading={false}
      onConnectionChanged={vi.fn()}
    />,
  );

  await userEvent.click(screen.getByRole("button", { name: "Install GitHub App" }));
  expect(
    await screen.findByText("GitHub could not complete the connection. Try again."),
  ).toBeInTheDocument();
  expect(screen.queryByText(/raw shell failure/)).toBeNull();

  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(mocks.githubInstallationsRefresh).not.toHaveBeenCalled();
});

it("disarms installation return refresh before disconnect", async () => {
  render(<StatefulRow initial={connection({ status: "setup_incomplete" })} />);

  await userEvent.click(screen.getByRole("button", { name: "Install GitHub App" }));
  await userEvent.click(screen.getByRole("button", { name: "Disconnect GitHub" }));
  await userEvent.click(
    within(screen.getByRole("dialog", { name: "Disconnect GitHub?" })).getByRole(
      "button",
      { name: "Disconnect" },
    ),
  );
  expect(await screen.findByRole("button", { name: "Connect GitHub" })).toBeEnabled();

  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(mocks.githubInstallationsRefresh).not.toHaveBeenCalled();
});

it("ignores a late installation return refresh after unmount", async () => {
  const pendingRefresh = deferred<GitHubConnection>();
  const onConnectionChanged = vi.fn();
  mocks.githubInstallationsRefresh.mockReturnValue(pendingRefresh.promise);
  const { unmount } = render(
    <GitHubConnectorRow
      connection={connection({ status: "setup_incomplete" })}
      loading={false}
      onConnectionChanged={onConnectionChanged}
    />,
  );

  await userEvent.click(screen.getByRole("button", { name: "Install GitHub App" }));
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(mocks.githubInstallationsRefresh).toHaveBeenCalledTimes(1);

  unmount();
  await act(async () => pendingRefresh.resolve(connection()));
  expect(onConnectionChanged).not.toHaveBeenCalled();
});
```

- [ ] **Step 6: Run the full row suite and verify GREEN**

Run:

```bash
pnpm test src/test/github-connector-row.test.tsx
```

Expected: all row tests pass with no act warning, duplicate focus refresh, or
unhandled promise rejection.

- [ ] **Step 7: Run focused connector regression gates**

Run:

```bash
pnpm test src/test/github-connector-row.test.tsx src/test/connectors-section.test.tsx src/test/github-connectors.test.ts src/test/connectors.test.ts src/test/connector-provider-icon.test.tsx
```

Expected: all focused GitHub and Google connector tests pass.

- [ ] **Step 8: Run frontend static gates**

Run:

```bash
pnpm typecheck
pnpm check
git diff --check
```

Expected: every command exits 0. `pnpm check` may print the existing ratcheted
warning baseline but no errors.

- [ ] **Step 9: Update Task 9 evidence and commit the scoped fix**

Append the live reproduction, root cause, RED/GREEN commands, and gate results
to ignored `.superpowers/sdd/task-9-report.md`, then stage only the component
and test:

```bash
git add src/components/settings/GitHubConnectorRow.tsx src/test/github-connector-row.test.tsx
git commit -m "fix: refresh GitHub after installation return"
```

Expected: one commit containing exactly two files.

### Task 2: Resume live staging verification

**Files:**

- Evidence only: `.superpowers/sdd/task-9-report.md`
- No tracked file unless live verification proves another scoped defect

**Interfaces:**

- Consumes: running `make dev-staging` native app with Keychain-only storage
- Consumes: installed `june-staging` App selected for `open-software-network/test-repo`
- Produces: redacted live evidence for automatic discovery and the remaining Task 9 lifecycle contract

- [ ] **Step 1: Prove automatic post-install discovery**

With June showing `setup_incomplete`, select **Install GitHub App** again. GitHub
should show the existing installation. Return focus to June without sharing any
device code, token, private repository name, or installation metadata.

Expected: June automatically calls refresh, changes the row to `Connected`, and
shows one selected repository.

- [ ] **Step 2: Verify the non-secret local snapshot**

Run count and selected-fixture queries without reading Keychain values:

```bash
DB="$HOME/Library/Application Support/co.opensoftware.june-dev/notes.sqlite3"
sqlite3 "$DB" "SELECT count(*) FROM github_connections; SELECT count(*) FROM github_installations; SELECT count(*) FROM github_repositories; SELECT count(*) FROM github_repositories WHERE full_name = 'open-software-network/test-repo';"
```

Expected: one connection, at least one installation, one repository total, and
one matching `test-repo` row. The plaintext token fixture remains absent and the
GitHub Keychain service is present without reading its value.

- [ ] **Step 3: Continue the approved live lifecycle charter**

Complete the existing Task 9 sequence serially under the fixture lock:

1. Run the one-shot forced refresh probe without printing token values.
2. Manage repositories, remove and restore `test-repo`, and verify automatic
   focus refresh fails closed then restores `connected`.
3. Suspend and unsuspend, then uninstall and reinstall the App, restoring the
   original selected-repository state.
4. Revoke the disposable user's authorization, verify `reconnect_required`,
   reconnect, and verify repository recovery.
5. Disconnect and verify zero GitHub database rows and no Keychain entry.

Do not mutate GitHub repository content or settings outside the staging App
installation lifecycle.

- [ ] **Step 4: Inspect logs and finish private evidence**

Search captured local diagnostics for token prefixes and secret field names
without printing matching secret values. Confirm GitHub traffic stays desktop
direct and no GitHub request reaches June API. Record screenshot/video capture
as blocked if macOS Screen Recording permission remains unavailable.

- [ ] **Step 5: Run final review and branch verification**

Package the complete branch diff from `4bf69495` to `HEAD`, run independent
standards/spec/adversarial review, fix any Critical or Important finding with a
separate tested commit, and rerun the smallest relevant gates plus
`CARGO_INCREMENTAL=0 make verify` when tracked implementation changes require
the full repository gate.
