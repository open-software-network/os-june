import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BiographySection } from "../components/settings/BiographySection";
import { AGENT_NEW_SESSION_PENDING_KEY, AGENT_OPEN_EVENT } from "../lib/agent-events";
import type { Biography } from "../lib/tauri";

const mocks = vi.hoisted(() => ({
  biographyGet: vi.fn<() => Promise<Biography | null>>(),
  biographySet: vi.fn(),
  biographyDelete: vi.fn(),
}));

vi.mock("../lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/tauri")>()),
  biographyGet: mocks.biographyGet,
  biographySet: mocks.biographySet,
  biographyDelete: mocks.biographyDelete,
}));

const stored: Biography = {
  markdown: "# About you\nYou lead the June desktop work.",
  updatedAt: "2026-07-01T10:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
  mocks.biographyGet.mockResolvedValue(null);
  mocks.biographySet.mockImplementation(async ({ markdown }: { markdown: string }) => ({
    markdown,
    updatedAt: "2026-07-09T10:00:00Z",
  }));
  mocks.biographyDelete.mockResolvedValue(undefined);
});

describe("BiographySection", () => {
  it("shows the empty state with the local-only framing", async () => {
    render(<BiographySection />);

    expect(
      await screen.findByText(/Here's what I already know, and it never left your Mac/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Build my profile" })).toBeInTheDocument();
  });

  it("hands the generation prompt to a fresh agent session on build", async () => {
    const opened = vi.fn();
    window.addEventListener(AGENT_OPEN_EVENT, opened);
    render(<BiographySection />);
    await screen.findByRole("button", { name: "Build my profile" });

    await userEvent.click(screen.getByRole("button", { name: "Build my profile" }));

    const pending = window.sessionStorage.getItem(AGENT_NEW_SESSION_PENDING_KEY);
    expect(pending).toBeTruthy();
    const payload = JSON.parse(pending ?? "{}") as { prompt?: string };
    expect(payload.prompt).toContain("stays on this Mac");
    expect(payload.prompt).toContain("```markdown");
    expect(opened).toHaveBeenCalled();
    window.removeEventListener(AGENT_OPEN_EVENT, opened);
  });

  it("saves an edited profile, stripping a pasted fenced block", async () => {
    render(<BiographySection />);
    await screen.findByRole("button", { name: "Write it myself" });

    await userEvent.click(screen.getByRole("button", { name: "Write it myself" }));
    const editor = screen.getByRole("textbox", { name: "Profile" });
    await userEvent.click(editor);
    await userEvent.paste("```markdown\n# About you\nShips June.\n```");
    await userEvent.click(screen.getByRole("button", { name: "Save profile" }));

    await waitFor(() =>
      expect(mocks.biographySet).toHaveBeenCalledWith({
        markdown: "# About you\nShips June.",
      }),
    );
    expect(await screen.findByText(/Ships June/)).toBeInTheDocument();
  });

  it("loads and edits an existing profile", async () => {
    mocks.biographyGet.mockResolvedValue(stored);
    render(<BiographySection />);

    expect(await screen.findByText(/You lead the June desktop work/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    const editor = screen.getByRole("textbox", { name: "Profile" });
    expect(editor).toHaveValue(stored.markdown);
    await userEvent.clear(editor);
    await userEvent.type(editor, "Updated profile.");
    await userEvent.click(screen.getByRole("button", { name: "Save profile" }));

    await waitFor(() =>
      expect(mocks.biographySet).toHaveBeenCalledWith({ markdown: "Updated profile." }),
    );
  });

  it("deletes the profile after confirmation", async () => {
    mocks.biographyGet.mockResolvedValue(stored);
    render(<BiographySection />);
    await screen.findByText(/You lead the June desktop work/);

    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete your profile?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(mocks.biographyDelete).toHaveBeenCalled());
    expect(await screen.findByRole("button", { name: "Build my profile" })).toBeInTheDocument();
  });

  it("offers regenerate on an existing profile", async () => {
    mocks.biographyGet.mockResolvedValue(stored);
    render(<BiographySection />);
    await screen.findByText(/You lead the June desktop work/);

    await userEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    expect(window.sessionStorage.getItem(AGENT_NEW_SESSION_PENDING_KEY)).toBeTruthy();
  });
});
