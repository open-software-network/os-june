import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AgentArtifactsSection } from "../components/agent/AgentActivityDrawer";
import type { AgentArtifact } from "../lib/hermes-artifact-store";

function artifact(
  partial: Partial<AgentArtifact> & Pick<AgentArtifact, "id" | "path">,
): AgentArtifact {
  return {
    sessionId: "s1",
    mode: "sandboxed",
    kind: "file",
    action: "created",
    displayName: partial.path?.split("/").pop(),
    createdAt: Date.UTC(2026, 5, 24, 12, 0, 0),
    ...partial,
  };
}

function renderSection(
  props: Partial<Parameters<typeof AgentArtifactsSection>[0]> = {},
) {
  return render(
    <AgentArtifactsSection
      artifacts={[]}
      onOpenArtifact={vi.fn()}
      {...props}
    />,
  );
}

describe("AgentArtifactsSection", () => {
  it("renders nothing when there are no artifacts", () => {
    const { container } = renderSection({ artifacts: [] });
    expect(container).toBeEmptyDOMElement();
  });

  it("lists a created file with its display name", () => {
    renderSection({
      artifacts: [
        artifact({ id: "a1", path: "/tmp/notes.md", action: "created" }),
      ],
    });
    expect(
      screen.getByRole("region", { name: /artifacts/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("notes.md")).toBeInTheDocument();
    // The action is conveyed in text, sentence case.
    expect(screen.getByText(/created/i)).toBeInTheDocument();
  });

  it("calls onOpenArtifact with the artifact when a row is clicked", async () => {
    const onOpenArtifact = vi.fn();
    const a1 = artifact({ id: "a1", path: "/tmp/notes.md" });
    renderSection({ artifacts: [a1], onOpenArtifact });
    await userEvent.click(screen.getByRole("button", { name: /notes\.md/i }));
    expect(onOpenArtifact).toHaveBeenCalledWith(a1);
  });

  it("labels a sandboxed file as a sandboxed copy", () => {
    renderSection({
      artifacts: [
        artifact({ id: "a1", path: "/tmp/x.txt", mode: "sandboxed" }),
      ],
    });
    const row = screen.getByRole("listitem");
    expect(within(row).getByText(/sandbox/i)).toBeInTheDocument();
  });

  it("labels an unrestricted file as an unrestricted local path", () => {
    renderSection({
      artifacts: [
        artifact({ id: "a1", path: "/etc/hosts", mode: "unrestricted" }),
      ],
    });
    const row = screen.getByRole("listitem");
    expect(within(row).getByText(/unrestricted/i)).toBeInTheDocument();
  });

  it("labels a url artifact as remote", () => {
    renderSection({
      artifacts: [
        artifact({
          id: "a1",
          path: "https://example.com/r.pdf",
          kind: "url",
          action: "downloaded",
        }),
      ],
    });
    const row = screen.getByRole("listitem");
    expect(within(row).getByText(/remote/i)).toBeInTheDocument();
  });

  it("renders a failed access distinctly", () => {
    renderSection({
      artifacts: [
        artifact({
          id: "a1",
          path: "/root/secret",
          action: "failed",
          kind: "file",
        }),
      ],
    });
    const row = screen.getByRole("listitem");
    expect(row).toHaveAttribute("data-action", "failed");
    expect(within(row).getByText(/failed/i)).toBeInTheDocument();
  });

  it("shows a count of all artifacts in the heading", () => {
    renderSection({
      artifacts: [
        artifact({ id: "a1", path: "/tmp/a.txt" }),
        artifact({ id: "a2", path: "/tmp/b.txt", action: "modified" }),
        artifact({ id: "a3", path: "/tmp/c.txt", action: "read" }),
      ],
    });
    const region = screen.getByRole("region", { name: /artifacts/i });
    expect(within(region).getByText("3")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });

  it("renders the action verbs for each artifact kind of action", () => {
    renderSection({
      artifacts: [
        artifact({ id: "a1", path: "/tmp/a.txt", action: "created" }),
        artifact({ id: "a2", path: "/tmp/b.txt", action: "modified" }),
        artifact({ id: "a3", path: "/tmp/c.txt", action: "read" }),
        artifact({
          id: "a4",
          path: "https://x.com/y",
          action: "downloaded",
          kind: "url",
        }),
      ],
    });
    expect(screen.getByText(/created/i)).toBeInTheDocument();
    expect(screen.getByText(/modified/i)).toBeInTheDocument();
    expect(screen.getByText(/^read$/i)).toBeInTheDocument();
    expect(screen.getByText(/downloaded/i)).toBeInTheDocument();
  });
});
