import { describe, expect, it } from "vitest";
import { defaultNav, navEquals, type TabNav } from "../app/tabs/tabs";

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
    expect(navEquals(base, { view: "agent", agentSessionId: "s2" })).toBe(
      false,
    );
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
    expect(
      navEquals({ view: "folders" }, { view: "folders", folderId: "f1" }),
    ).toBe(false);
    expect(
      navEquals(
        { view: "folders", folderId: "f1" },
        { view: "folders", folderId: "f1" },
      ),
    ).toBe(true);
  });
});
