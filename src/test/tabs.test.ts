import { describe, expect, it } from "vitest";
import { defaultNav, navEquals, reorderTabs, type Tab, type TabNav } from "../app/tabs/tabs";

describe("tab navigation snapshots", () => {
  it("a fresh tab lands on the agent hero (a new chat)", () => {
    expect(defaultNav()).toEqual({ view: "agent" });
  });

  it("treats different views as different", () => {
    expect(navEquals({ view: "notes" }, { view: "routines" })).toBe(false);
  });

  it("compares only the fields a view actually shows", () => {
    // Section views carry no selection, so unrelated leftover fields are
    // ignored — this is what keeps the capture effect from churning the tab.
    const a: TabNav = { view: "routines", noteId: "n1" };
    const b: TabNav = { view: "routines", folderId: "f9" };
    expect(navEquals(a, b)).toBe(true);
  });

  it("distinguishes notes by id and by breadcrumb origin", () => {
    const base: TabNav = { view: "meetings", noteId: "n1" };
    expect(navEquals(base, { view: "meetings", noteId: "n2" })).toBe(false);
    expect(
      navEquals(base, {
        view: "meetings",
        noteId: "n1",
        originAllNotes: true,
      }),
    ).toBe(false);
    expect(
      navEquals(base, {
        view: "meetings",
        noteId: "n1",
        originFolderId: "f1",
      }),
    ).toBe(false);
    // Absent vs. explicitly-false origin is the same tab.
    expect(
      navEquals(base, {
        view: "meetings",
        noteId: "n1",
        originAllNotes: false,
      }),
    ).toBe(true);
  });

  it("distinguishes agent tabs by session and origin", () => {
    const base: TabNav = { view: "agent", agentSessionId: "s1" };
    expect(navEquals(base, { view: "agent", agentSessionId: "s2" })).toBe(false);
    // The title is fallback display metadata, not tab identity.
    expect(
      navEquals(
        { view: "agent", agentSessionId: "s1", agentSessionTitle: "First" },
        { view: "agent", agentSessionId: "s1", agentSessionTitle: "Second" },
      ),
    ).toBe(true);
    expect(
      navEquals(
        {
          view: "agent",
          agentSessionId: "s1",
          agentOrigin: { kind: "routines" },
        },
        {
          view: "agent",
          agentSessionId: "s1",
          agentOrigin: { kind: "project", folderId: "f1" },
        },
      ),
    ).toBe(false);
    expect(
      navEquals(
        {
          view: "agent",
          agentSessionId: "s1",
          agentOrigin: { kind: "project", folderId: "f1" },
        },
        {
          view: "agent",
          agentSessionId: "s1",
          agentOrigin: { kind: "project", folderId: "f1" },
        },
      ),
    ).toBe(true);
  });

  it("distinguishes projects by folder id", () => {
    expect(navEquals({ view: "folders" }, { view: "folders", folderId: "f1" })).toBe(false);
    expect(
      navEquals({ view: "folders", folderId: "f1" }, { view: "folders", folderId: "f1" }),
    ).toBe(true);
  });
});

describe("reorderTabs", () => {
  const tab = (id: string): Tab => ({ id, nav: defaultNav() });
  const ids = (tabs: Tab[]) => tabs.map((t) => t.id);

  it("applies the new visible order", () => {
    const tabs = [tab("a"), tab("b"), tab("c")];
    expect(ids(reorderTabs(tabs, ["b", "c", "a"]))).toEqual(["b", "c", "a"]);
  });

  it("keeps overflowed (non-visible) tabs in their slots", () => {
    // a, b, d are on the strip; c and e sit in the overflow popover. Swapping
    // a and d must leave c and e exactly where they were.
    const tabs = [tab("a"), tab("b"), tab("c"), tab("d"), tab("e")];
    expect(ids(reorderTabs(tabs, ["d", "b", "a"]))).toEqual(["d", "b", "c", "a", "e"]);
  });

  it("returns the same array when the order is unchanged", () => {
    const tabs = [tab("a"), tab("b")];
    expect(reorderTabs(tabs, ["a", "b"])).toBe(tabs);
  });

  it("ignores ids that no longer exist", () => {
    const tabs = [tab("a"), tab("b")];
    expect(ids(reorderTabs(tabs, ["b", "gone", "a"]))).toEqual(["b", "a"]);
  });
});
