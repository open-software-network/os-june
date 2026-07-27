import { describe, expect, it } from "vitest";
import { buildFolderItemIndex } from "../components/folders/folder-item-index";
import { filterNotesByQuery } from "../components/notes-list/notes-list-helpers";
import { buildSidebarSessionLists } from "../components/sidebar/sidebar-session-lists";
import type { AgentSessionDto } from "../lib/agent-runtime-contract";
import type { NoteListItemDto } from "../lib/tauri";

const NOW = "2026-07-22T12:00:00Z";

function note(
  id: string,
  title: string,
  preview: string,
  folderIds: string[] = [],
): NoteListItemDto {
  return {
    id,
    title,
    preview,
    processingStatus: "ready",
    folderIds,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function session(id: string): AgentSessionDto {
  return {
    id,
    title: id,
    status: "idle",
    model: "auto",
    safetyMode: "sandboxed",
    workspacePath: `/tmp/${id}`,
    source: "user",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe("list render hygiene helpers", () => {
  it("filters notes by normalized title or preview and reuses the unfiltered list", () => {
    const notes = [
      note("roadmap", "Product roadmap", "Q3 priorities"),
      note("retro", "Weekly retro", "Decisions and follow-ups"),
    ];

    expect(filterNotesByQuery(notes, "  PRODUCT ")).toEqual([notes[0]]);
    expect(filterNotesByQuery(notes, "FOLLOW-UP")).toEqual([notes[1]]);
    expect(filterNotesByQuery(notes, "   ")).toBe(notes);
  });

  it("categorizes, orders, and bounds every sidebar session group", () => {
    const sessions = [
      session("active-1"),
      session("pinned-2"),
      session("completed-old"),
      session("pinned-1"),
      session("active-2"),
      session("completed-new"),
      session("active-3"),
    ];
    const lists = buildSidebarSessionLists(
      sessions,
      new Set(["pinned-1", "pinned-2", "completed-new"]),
      {
        "completed-old": "2026-07-20T12:00:00Z",
        "completed-new": "2026-07-22T12:00:00Z",
      },
      2,
    );

    expect(lists.pinned.map(({ id }) => id)).toEqual(["pinned-1", "pinned-2"]);
    expect(lists.visible.map(({ id }) => id)).toEqual(["active-1", "active-2"]);
    expect(lists.completed.map(({ id }) => id)).toEqual(["completed-new", "completed-old"]);
    expect(lists).toMatchObject({ pinnedTotal: 2, visibleTotal: 3, completedTotal: 2 });
  });

  it("indexes folder notes and sessions once while preserving source order", () => {
    const first = note("first", "First", "", ["project-a", "project-a", "project-b"]);
    const second = note("second", "Second", "", ["project-a"]);
    const firstSession = session("session-1");
    const secondSession = session("session-2");

    const index = buildFolderItemIndex([first, second], [firstSession, secondSession], {
      "session-1": ["project-a", "project-a"],
      "session-2": ["project-b"],
    });

    expect(index.notesByFolderId.get("project-a")).toEqual([first, second]);
    expect(index.notesByFolderId.get("project-b")).toEqual([first]);
    expect(index.sessionsByFolderId.get("project-a")).toEqual([firstSession]);
    expect(index.sessionsByFolderId.get("project-b")).toEqual([secondSession]);
    expect(index.notesByFolderId.has("missing")).toBe(false);
  });
});
