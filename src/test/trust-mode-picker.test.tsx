import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TrustModePicker } from "../components/routines/TrustModePicker";
import type { RoutineTrustMode } from "../lib/tauri";

function renderPicker(
  props: Partial<{
    value: RoutineTrustMode;
    runCount: number;
    autonomousTools: string[];
    onChange: (mode: RoutineTrustMode) => void;
    onAutonomousToolsChange: (tools: string[]) => void;
  }> = {},
) {
  return render(
    <TrustModePicker
      value={props.value ?? "read_only"}
      runCount={props.runCount ?? 0}
      autonomousTools={props.autonomousTools ?? []}
      onChange={props.onChange ?? vi.fn()}
      onAutonomousToolsChange={props.onAutonomousToolsChange ?? vi.fn()}
    />,
  );
}

describe("TrustModePicker", () => {
  it("offers the three trust modes as a separate control from the sandbox picker", () => {
    renderPicker();
    const group = screen.getByRole("group", {
      name: "What can this routine do with your Google account?",
    });
    expect(screen.getByRole("button", { name: "Read only" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approval" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Autonomous" })).toBeInTheDocument();
    // Never the sandbox options: trust and sandbox are distinct choices.
    expect(group).not.toHaveTextContent("Sandboxed");
    expect(group).not.toHaveTextContent("Unrestricted");
  });

  it("switches between read only and approval", async () => {
    const onChange = vi.fn();
    renderPicker({ onChange });
    await userEvent.click(screen.getByRole("button", { name: "Approval" }));
    expect(onChange).toHaveBeenCalledWith("approval");
  });

  it("ignores autonomous until the earned-run threshold and explains why", async () => {
    const onChange = vi.fn();
    renderPicker({ runCount: 1, onChange });

    expect(
      screen.getByText(/Runs 2 more times with approvals to unlock autonomous/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Run 2 of 3 approvals before autonomy unlocks/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Autonomous" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("allows autonomous after three approved runs", async () => {
    const onChange = vi.fn();
    renderPicker({ runCount: 3, onChange });

    expect(screen.queryByText(/unlock autonomous/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Autonomous" }));
    expect(onChange).toHaveBeenCalledWith("autonomous");
  });

  it("lists grantable connector action tools when autonomous is active", async () => {
    const onAutonomousToolsChange = vi.fn();
    renderPicker({
      value: "autonomous",
      runCount: 4,
      autonomousTools: ["create_draft"],
      onAutonomousToolsChange,
    });

    expect(screen.getByRole("checkbox", { name: "Create drafts" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Send email" })).not.toBeChecked();

    await userEvent.click(screen.getByRole("checkbox", { name: "Create events" }));
    expect(onAutonomousToolsChange).toHaveBeenCalledWith(["create_draft", "create_event"]);
  });

  it("hides the grant checklist outside autonomous", () => {
    renderPicker({ value: "approval", runCount: 4 });
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});
