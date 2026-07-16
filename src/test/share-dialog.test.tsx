import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ShareDialog } from "../components/share/ShareDialog";
import { decryptPayload, fromBase64, fromBase64Url, unwrapKey } from "../lib/share-crypto";
import { buildNotePayload } from "../lib/share-payload";

const mocks = vi.hoisted(() => ({
  shareCreate: vi.fn(),
  shareGet: vi.fn(),
  shareDelete: vi.fn(),
  shareKeyGet: vi.fn(),
  shareKeySave: vi.fn(),
  shareInviteKeySave: vi.fn(),
  shareInviteKeysGet: vi.fn(),
  getShareBaseUrl: vi.fn(),
  writeClipboardText: vi.fn(),
}));

vi.mock("../lib/tauri", () => ({
  shareCreate: mocks.shareCreate,
  shareGet: mocks.shareGet,
  shareDelete: mocks.shareDelete,
  shareKeyGet: mocks.shareKeyGet,
  shareKeySave: mocks.shareKeySave,
  shareInviteKeySave: mocks.shareInviteKeySave,
  shareInviteKeysGet: mocks.shareInviteKeysGet,
  getShareBaseUrl: mocks.getShareBaseUrl,
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: mocks.writeClipboardText,
}));

const BASE_URL = "https://june-api.opensoftware.co";

function noteItem(overrides: Partial<Parameters<typeof ShareDialog>[0]["item"]> = {}) {
  return {
    kind: "note" as const,
    itemId: "note_1",
    title: "Weekly sync",
    buildPayload: () =>
      buildNotePayload({
        title: "Weekly sync",
        markdown: "# Agenda",
        sharedAt: "2026-07-14T00:00:00.000Z",
      }),
    ...overrides,
  };
}

function mockClipboard() {
  mocks.writeClipboardText.mockResolvedValue(undefined);
  return mocks.writeClipboardText;
}

function mockStoredLink() {
  const keyB64 = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
  mocks.shareKeyGet.mockResolvedValue({ shareId: "shr_1", contentKeyB64: keyB64 });
  mocks.shareGet.mockResolvedValue({
    shareId: "shr_1",
    kind: "note",
    invites: [{ inviteId: "shi_link", email: "link@share.invalid", state: "pending" }],
  });
  mocks.shareInviteKeysGet.mockResolvedValue([{ inviteId: "shi_link", inviteKeyB64: keyB64 }]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getShareBaseUrl.mockResolvedValue(BASE_URL);
  mocks.shareKeyGet.mockResolvedValue(null);
  mocks.shareKeySave.mockResolvedValue(undefined);
  mocks.shareInviteKeySave.mockResolvedValue(undefined);
  mocks.shareInviteKeysGet.mockResolvedValue([]);
  mocks.shareDelete.mockResolvedValue(undefined);
  mocks.writeClipboardText.mockResolvedValue(undefined);
});

describe("ShareDialog", () => {
  it("offers one create-link action with an optional passcode", async () => {
    render(<ShareDialog open onClose={vi.fn()} item={noteItem()} />);
    expect(await screen.findByRole("button", { name: "Create link" })).toBeEnabled();
    expect(screen.getByRole("switch", { name: "Require a passcode" })).not.toBeChecked();
    expect(screen.queryByLabelText("Passcode")).not.toBeInTheDocument();
    expect(screen.queryByText(/Invite by email/i)).not.toBeInTheDocument();
  });

  it("creates an anonymous encrypted link and copies it automatically", async () => {
    mocks.shareCreate.mockImplementation(async (input) => ({
      shareId: "shr_1",
      invites: [{ inviteId: "shi_link", email: input.invites[0].email }],
    }));
    let finishInviteKeySave: () => void = () => {};
    mocks.shareInviteKeySave.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishInviteKeySave = resolve;
        }),
    );
    const user = userEvent.setup();
    const clipboard = mockClipboard();
    render(<ShareDialog open onClose={vi.fn()} item={noteItem()} />);

    await user.click(await screen.findByRole("button", { name: "Create link" }));
    await waitFor(() => expect(mocks.shareInviteKeySave).toHaveBeenCalledTimes(1));
    expect(clipboard).not.toHaveBeenCalled();
    finishInviteKeySave();

    const linkField = (await screen.findByRole("textbox", {
      name: /Share link for/i,
    })) as HTMLInputElement;
    expect(mocks.shareCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        invites: [expect.objectContaining({ email: "link@share.invalid" })],
      }),
    );
    const link = linkField.value;
    const fragment = link.split("#")[1].split(".");
    expect(fragment.slice(0, 3)).toEqual(["link", "shi_link", "key"]);

    const request = mocks.shareCreate.mock.calls[0][0];
    const linkKey = fromBase64Url(fragment[3]);
    const contentKey = await unwrapKey(
      linkKey,
      fromBase64(request.invites[0].envelopeB64),
      fromBase64(request.invites[0].envelopeIvB64),
    );
    const plaintext = await decryptPayload(
      contentKey,
      fromBase64(request.ciphertextB64),
      fromBase64(request.ivB64),
    );
    expect(JSON.parse(plaintext)).toMatchObject({ kind: "note", title: "Weekly sync" });
    expect(mocks.shareInviteKeySave).toHaveBeenCalledWith(
      expect.objectContaining({ inviteId: "shi_link" }),
    );
    await waitFor(() => expect(clipboard).toHaveBeenCalledWith(link));
    expect(screen.getByRole("button", { name: "Copy link" })).toBeEnabled();
  });

  it("creates a passcode link whose fragment carries only a salt", async () => {
    mocks.shareCreate.mockResolvedValue({
      shareId: "shr_1",
      invites: [{ inviteId: "shi_link", email: "link@share.invalid" }],
    });
    const user = userEvent.setup();
    const clipboard = mockClipboard();
    render(<ShareDialog open onClose={vi.fn()} item={noteItem()} />);

    await user.click(await screen.findByRole("switch", { name: "Require a passcode" }));
    await user.type(screen.getByLabelText("Passcode"), "correct horse battery staple");
    await user.click(screen.getByRole("button", { name: "Create link" }));

    const linkField = (await screen.findByRole("textbox", {
      name: /Share link for/i,
    })) as HTMLInputElement;
    const fragment = linkField.value.split("#")[1].split(".");
    expect(fragment.slice(0, 3)).toEqual(["link", "shi_link", "pass"]);
    expect(fromBase64Url(fragment[3])).toHaveLength(16);
    expect(mocks.shareInviteKeySave.mock.calls[0][0].inviteKeyB64).toBe(fragment[3]);
    await waitFor(() => expect(clipboard).toHaveBeenCalledWith(linkField.value));
    expect(screen.getByText(/June never stores the passcode/i)).toBeInTheDocument();

    let finishPasscodeCopy: () => void = () => {};
    clipboard.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishPasscodeCopy = resolve;
        }),
    );
    await user.click(screen.getByRole("button", { name: "Copy passcode" }));
    expect(screen.getByRole("button", { name: "Copy link" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Copy passcode" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Copy link" }));
    expect(clipboard).toHaveBeenCalledTimes(2);
    finishPasscodeCopy();
    await waitFor(() => expect(clipboard).toHaveBeenLastCalledWith("correct horse battery staple"));
    const copiedPasscodeButton = screen.getByRole("button", { name: "Passcode copied" });
    expect(copiedPasscodeButton).toBeEnabled();
    expect(copiedPasscodeButton).toHaveTextContent("Copy passcode");
    expect(copiedPasscodeButton.querySelector(".t-icon-swap")).toHaveAttribute("data-state", "b");
    fireEvent.focus(copiedPasscodeButton);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Copied");
  });

  it("keeps a created link available when automatic copy fails", async () => {
    mocks.shareCreate.mockResolvedValue({
      shareId: "shr_1",
      invites: [{ inviteId: "shi_link", email: "link@share.invalid" }],
    });
    mocks.writeClipboardText.mockRejectedValueOnce(new Error("clipboard unavailable"));
    const user = userEvent.setup();
    render(<ShareDialog open onClose={vi.fn()} item={noteItem()} />);

    await user.click(await screen.findByRole("button", { name: "Create link" }));

    const linkField = (await screen.findByRole("textbox", {
      name: /Share link for/i,
    })) as HTMLInputElement;
    expect(await screen.findByText(/Link created, but couldn't copy it/i)).toBeInTheDocument();
    expect(mocks.shareDelete).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(mocks.writeClipboardText).toHaveBeenLastCalledWith(linkField.value));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("loads and copies an existing link without recreating the share", async () => {
    mockStoredLink();
    const user = userEvent.setup();
    const clipboard = mockClipboard();
    render(<ShareDialog open onClose={vi.fn()} item={noteItem()} />);

    const linkField = (await screen.findByRole("textbox", {
      name: /Share link for/i,
    })) as HTMLInputElement;
    expect(linkField).toHaveAttribute("readonly");
    expect(linkField.value).toContain("/s/shr_1#link.");
    expect(linkField.closest(".copy-link-field")).not.toBeNull();
    expect(linkField.closest(".share-dialog-section")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(clipboard).toHaveBeenCalledWith(expect.stringContaining("#link.")));
    expect(mocks.shareCreate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Link copied" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Stop sharing" })).toBeEnabled();
  });

  it("keeps link creation disabled when an existing share fails to reload", async () => {
    const keyB64 = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
    mocks.shareKeyGet.mockResolvedValue({ shareId: "shr_1", contentKeyB64: keyB64 });
    mocks.shareGet.mockRejectedValue(new Error("temporary load failure"));
    render(<ShareDialog open onClose={vi.fn()} item={noteItem()} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("temporary load failure");
    const passcodeSwitch = screen.getByRole("switch", { name: "Require a passcode" });
    expect(passcodeSwitch).toBeDisabled();
    fireEvent.click(passcodeSwitch);
    expect(mocks.shareCreate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Stop sharing" })).toBeEnabled();
  });

  it("reports a stored link while closed for breadcrumb actions", async () => {
    mockStoredLink();
    const onLinkChange = vi.fn();

    const { rerender } = render(
      <ShareDialog open={false} onClose={vi.fn()} onLinkChange={onLinkChange} item={noteItem()} />,
    );

    await waitFor(() =>
      expect(onLinkChange).toHaveBeenLastCalledWith(expect.stringContaining("/s/shr_1#link.")),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    rerender(<ShareDialog open onClose={vi.fn()} onLinkChange={onLinkChange} item={noteItem()} />);
    expect(await screen.findByRole("button", { name: "Copy link" })).toBeEnabled();
    rerender(
      <ShareDialog open={false} onClose={vi.fn()} onLinkChange={onLinkChange} item={noteItem()} />,
    );

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mocks.shareKeyGet).toHaveBeenCalledOnce();
    expect(onLinkChange).toHaveBeenLastCalledWith(expect.stringContaining("/s/shr_1#link."));
  });

  it("resets explicit copy feedback after the platform delay", async () => {
    mockStoredLink();
    mockClipboard();
    render(<ShareDialog open onClose={vi.fn()} item={noteItem()} />);

    const copyButton = await screen.findByRole("button", { name: "Copy link" });
    const iconSwap = copyButton.querySelector(".t-icon-swap");
    expect(iconSwap).toHaveAttribute("data-state", "a");
    expect(iconSwap?.querySelectorAll(".t-icon")).toHaveLength(2);
    expect(iconSwap?.querySelector('[data-icon="a"]')).not.toBeNull();
    expect(iconSwap?.querySelector('[data-icon="b"]')).not.toBeNull();
    expect(copyButton).toHaveTextContent("");

    vi.useFakeTimers();
    try {
      fireEvent.focus(copyButton);
      expect(screen.getByRole("tooltip")).toHaveTextContent("Copy link");

      await act(async () => {
        fireEvent.click(copyButton);
        await Promise.resolve();
      });
      expect(copyButton).toHaveAccessibleName("Link copied");
      expect(iconSwap).toHaveAttribute("data-state", "b");
      expect(screen.getByRole("tooltip")).toHaveTextContent("Copied");

      act(() => vi.advanceTimersByTime(1_599));
      expect(copyButton).toHaveAccessibleName("Link copied");
      expect(iconSwap).toHaveAttribute("data-state", "b");

      await act(async () => {
        fireEvent.click(copyButton);
        await Promise.resolve();
      });
      act(() => vi.advanceTimersByTime(1));
      expect(copyButton).toHaveAccessibleName("Link copied");
      expect(iconSwap).toHaveAttribute("data-state", "b");

      act(() => vi.advanceTimersByTime(1_599));
      expect(copyButton).toHaveAccessibleName("Copy link");
      expect(iconSwap).toHaveAttribute("data-state", "a");
      expect(screen.queryByRole("tooltip")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("blocks every close path while link creation is in flight", async () => {
    let resolveCreate: (value: unknown) => void = () => {};
    mocks.shareCreate.mockReturnValue(
      new Promise((resolve) => {
        resolveCreate = resolve;
      }),
    );
    mockClipboard();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<ShareDialog open onClose={onClose} item={noteItem()} />);

    await user.click(await screen.findByRole("button", { name: "Create link" }));
    await waitFor(() => expect(mocks.shareCreate).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Creating link..." })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    resolveCreate({
      shareId: "shr_1",
      invites: [{ inviteId: "shi_link", email: "link@share.invalid" }],
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop sharing" })).toBeEnabled());
  });

  it("maps the sharing_unavailable machine code to a human message", async () => {
    mocks.shareCreate.mockRejectedValue({ message: "sharing_unavailable" });
    mockClipboard();
    const user = userEvent.setup();
    render(<ShareDialog open onClose={vi.fn()} item={noteItem()} />);

    await user.click(await screen.findByRole("button", { name: "Create link" }));

    expect(
      await screen.findByText(/Sharing isn't available on this June server yet/i),
    ).toBeInTheDocument();
    expect(screen.queryByText("sharing_unavailable")).not.toBeInTheDocument();
  });

  it("surfaces legacy invite shares without making them anonymous", async () => {
    mocks.shareKeyGet.mockResolvedValue({ shareId: "shr_old", contentKeyB64: "key" });
    mocks.shareGet.mockResolvedValue({
      shareId: "shr_old",
      kind: "note",
      invites: [{ inviteId: "shi_old", email: "friend@example.com", state: "pending" }],
    });
    mocks.shareInviteKeysGet.mockResolvedValue([]);
    render(<ShareDialog open onClose={vi.fn()} item={noteItem()} />);
    expect(await screen.findByText(/previous invite-only sharing model/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create link" })).not.toBeInTheDocument();
  });
});
