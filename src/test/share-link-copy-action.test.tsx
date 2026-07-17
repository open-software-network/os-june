import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ShareLinkCopyAction } from "../components/share/ShareLinkCopyAction";
import { BreadcrumbBar } from "../components/ui/BreadcrumbBar";

const mocks = vi.hoisted(() => ({
  writeClipboardText: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: mocks.writeClipboardText,
}));

describe("ShareLinkCopyAction", () => {
  it("copies from the current breadcrumb and resets its icon feedback", async () => {
    mocks.writeClipboardText.mockResolvedValue(undefined);
    render(
      <BreadcrumbBar
        items={[
          { label: "Meeting notes" },
          {
            label: "Weekly sync",
            action: <ShareLinkCopyAction url="https://june.test/s/shr_1#link.key" />,
          },
        ]}
      />,
    );

    const copyButton = screen.getByRole("button", { name: "Copy share link" });
    const iconSwap = copyButton.querySelector(".t-icon-swap");
    expect(iconSwap).toHaveAttribute("data-state", "a");
    expect(iconSwap?.querySelectorAll(".t-icon")).toHaveLength(2);

    vi.useFakeTimers();
    try {
      fireEvent.focus(copyButton);
      expect(screen.getByRole("tooltip")).toHaveTextContent("Copy share link");

      await act(async () => {
        fireEvent.click(copyButton);
        await Promise.resolve();
      });

      expect(mocks.writeClipboardText).toHaveBeenCalledWith("https://june.test/s/shr_1#link.key");
      expect(copyButton).toHaveAccessibleName("Share link copied");
      expect(iconSwap).toHaveAttribute("data-state", "b");
      expect(screen.getByRole("tooltip")).toHaveTextContent("Copied");

      act(() => vi.advanceTimersByTime(1200));
      await act(async () => {
        fireEvent.click(copyButton);
        await Promise.resolve();
      });
      expect(mocks.writeClipboardText).toHaveBeenCalledTimes(2);

      act(() => vi.advanceTimersByTime(401));
      expect(copyButton).toHaveAccessibleName("Share link copied");
      expect(iconSwap).toHaveAttribute("data-state", "b");

      act(() => vi.advanceTimersByTime(1198));
      expect(copyButton).toHaveAccessibleName("Share link copied");

      act(() => vi.advanceTimersByTime(1));
      expect(copyButton).toHaveAccessibleName("Copy share link");
      expect(iconSwap).toHaveAttribute("data-state", "a");
    } finally {
      vi.useRealTimers();
    }
  });
});
