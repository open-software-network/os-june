import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BrowserController,
  browserFailureResponse,
  chunkBytes,
  PendingShareRegistry,
  TaskTabRegistry,
} from "../browser";
import { type BrowserRequestMessage, PROTOCOL_VERSION } from "../protocol";

function browserRequest(
  id: number,
  tool: BrowserRequestMessage["tool"],
  arguments_: Record<string, unknown>,
): BrowserRequestMessage {
  return { v: PROTOCOL_VERSION, type: "request", id, tool, arguments: arguments_ };
}

function chromeHarness() {
  const tabs = new Map<number, { id: number; title: string; url: string }>([
    [10, { id: 10, title: "User tab", url: "https://example.com" }],
    [11, { id: 11, title: "Other tab", url: "https://private.example" }],
  ]);
  const attach = vi.fn().mockResolvedValue(undefined);
  const detach = vi.fn().mockResolvedValue(undefined);
  const remove = vi.fn().mockResolvedValue(undefined);
  const sendCommand = vi.fn().mockResolvedValue({});
  vi.stubGlobal("chrome", {
    debugger: {
      attach,
      detach,
      sendCommand,
      onEvent: { addListener: vi.fn() },
      onDetach: { addListener: vi.fn() },
    },
    tabs: {
      get: vi.fn(async (tabId: number) => {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error("missing tab");
        return tab;
      }),
      remove,
      onRemoved: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn() },
    },
    tabGroups: { onUpdated: { addListener: vi.fn() } },
  });
  return { attach, detach, remove, sendCommand };
}

afterEach(() => vi.unstubAllGlobals());

describe("task tab registry", () => {
  it("refuses tabs outside the broker session", () => {
    const registry = new TaskTabRegistry();
    registry.start("session-a");
    registry.addCreated("session-a", 10);
    expect(() => registry.tab("session-a", 11)).toThrow(/not owned/);
    expect(() => registry.tab("session-b", 10)).toThrow(/not found/);
  });

  it("expires snapshot refs on navigation or mutation", () => {
    const registry = new TaskTabRegistry();
    registry.start("session-a");
    registry.addCreated("session-a", 10);
    expect(registry.setRefs("session-a", 10, 0, ["e0:n20"])).toBe(true);
    expect(registry.acceptsRef("session-a", 10, "e0:n20")).toBe(true);
    expect(registry.invalidate("session-a", 10)).toBe(1);
    expect(registry.acceptsRef("session-a", 10, "e0:n20")).toBe(false);
    expect(registry.setRefs("session-a", 10, 0, ["e0:n20"])).toBe(false);
  });

  it("plans disconnect cleanup using owned tabs only", () => {
    const registry = new TaskTabRegistry();
    registry.start("one");
    registry.start("two");
    registry.addCreated("one", 1);
    registry.addShared("two", 2);
    expect(registry.cleanupPlan().sort()).toEqual([1, 2]);
  });

  it("forgets an empty tab group so a later task tab can create a new one", () => {
    const registry = new TaskTabRegistry();
    registry.start("session-a");
    registry.addCreated("session-a", 10);
    registry.session("session-a").groupId = 42;
    registry.removeTab("session-a", 10);
    expect(registry.session("session-a").groupId).toBeUndefined();
  });

  it("keeps shared tabs out of the close plan at task end", () => {
    const registry = new TaskTabRegistry();
    registry.start("session-a");
    registry.addCreated("session-a", 10);
    registry.addShared("session-a", 11);
    expect(registry.removeSession("session-a")).toEqual({ created: [10], shared: [11] });
  });

  it("does not let the same tab belong to two tasks", () => {
    const registry = new TaskTabRegistry();
    registry.start("session-a");
    registry.start("session-b");
    registry.addShared("session-a", 10);
    expect(() => registry.addShared("session-b", 10)).toThrow(/already belongs/);
  });
});

describe("explicit tab shares", () => {
  it("mints a one-use offer for only the selected tab", () => {
    const shares = new PendingShareRegistry();
    expect(shares.offer(10, "share-a")).toBe("share-a");
    expect(shares.hasTab(10)).toBe(true);
    expect(shares.hasTab(11)).toBe(false);
    expect(shares.consume("share-a")).toBe(10);
    expect(() => shares.consume("share-a")).toThrow(/not found or has expired/);
  });

  it("revokes pending offers by tab", () => {
    const shares = new PendingShareRegistry();
    shares.offer(10, "share-a");
    expect(shares.revokeTab(10)).toBe(true);
    expect(() => shares.consume("share-a")).toThrow(/not found or has expired/);
  });

  it("attaches only the offered tab and returns it untouched at task end", async () => {
    const { attach, detach, remove } = chromeHarness();
    const controller = new BrowserController();
    const shareId = controller.offerTab(10);

    await expect(
      controller.execute(browserRequest(1, "start_session", { session_id: "task" })),
    ).resolves.toMatchObject({ response: { success: true } });
    await expect(
      controller.execute(
        browserRequest(2, "accept_shared_tab", { session_id: "task", share_id: shareId }),
      ),
    ).resolves.toMatchObject({ response: { success: true, data: { tabId: 10, shared: true } } });
    expect(attach).toHaveBeenCalledWith({ tabId: 10 }, "1.3");
    expect(controller.registry.find(11)).toBeNull();

    await controller.execute(browserRequest(3, "close_session", { session_id: "task" }));
    expect(detach).toHaveBeenCalledWith({ tabId: 10 });
    expect(remove).not.toHaveBeenCalled();
  });

  it("revokes an accepted share without closing the user's tab", async () => {
    const { detach, remove } = chromeHarness();
    const released = vi.fn();
    const controller = new BrowserController(released);
    const shareId = controller.offerTab(10);
    await controller.execute(browserRequest(1, "start_session", { session_id: "task" }));
    await controller.execute(
      browserRequest(2, "accept_shared_tab", { session_id: "task", share_id: shareId }),
    );

    await expect(controller.revokeSharedTab(10)).resolves.toBe(true);
    expect(controller.registry.find(10)).toBeNull();
    expect(detach).toHaveBeenCalledWith({ tabId: 10 });
    expect(remove).not.toHaveBeenCalled();
    expect(released).toHaveBeenCalledWith(10);
  });

  it("keeps revoke authoritative while debugger attachment is in flight", async () => {
    const { attach, remove } = chromeHarness();
    let finishAttach: (() => void) | undefined;
    attach.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishAttach = resolve;
        }),
    );
    const controller = new BrowserController();
    const shareId = controller.offerTab(10);
    await controller.execute(browserRequest(1, "start_session", { session_id: "task" }));
    const accepting = controller.execute(
      browserRequest(2, "accept_shared_tab", { session_id: "task", share_id: shareId }),
    );
    await vi.waitFor(() => expect(controller.registry.find(10)).not.toBeNull());

    await controller.revokeSharedTab(10);
    finishAttach?.();

    await expect(accepting).resolves.toMatchObject({
      response: { success: false, errorCode: "share_revoked" },
    });
    expect(controller.registry.find(10)).toBeNull();
    expect(remove).not.toHaveBeenCalled();
  });
});

describe("native payload chunking", () => {
  it("keeps chunks well below the native frame limit and roundtrips bytes", () => {
    const input = Uint8Array.from({ length: 700_000 }, (_, index) => index % 251);
    const chunks = chunkBytes(input);
    expect(chunks.length).toBeGreaterThan(1);
    expect(Math.max(...chunks.map((chunk) => chunk.length))).toBeLessThan(512 * 1024);
    const output = chunks.flatMap((chunk) => [
      ...Uint8Array.from(atob(chunk), (value) => value.charCodeAt(0)),
    ]);
    expect(Uint8Array.from(output)).toEqual(input);
  });
});

describe("attended reference actions", () => {
  const element = {
    tag: "button",
    inputType: "button",
    role: "",
    name: "checkout",
    id: "buy",
    label: "Purchase now",
    autocomplete: "",
    inForm: true,
    contentEditable: false,
  };

  function interactionController() {
    const harness = chromeHarness();
    const controller = new BrowserController();
    controller.registry.start("task");
    controller.registry.addShared("task", 10);
    controller.registry.setRefs("task", 10, 0, ["e0:n20"]);
    return { controller, ...harness };
  }

  it("handles broker inspect and act messages with expected facts", async () => {
    const { controller, sendCommand } = interactionController();
    sendCommand.mockImplementation(
      async (_target: unknown, method: string, params?: Record<string, unknown>) => {
        if (method === "DOM.resolveNode") return { object: { objectId: "node-20" } };
        if (method === "Runtime.callFunctionOn") {
          const declaration = String(params?.functionDeclaration ?? "");
          return declaration.includes("operation, value, expected")
            ? { result: { value: { status: "ok" } } }
            : { result: { value: { element, url: "https://example.com/checkout" } } };
        }
        if (method === "Accessibility.getFullAXTree") return { nodes: [] };
        if (method === "Runtime.evaluate") return { result: { value: "complete" } };
        return {};
      },
    );

    await expect(
      controller.execute(
        browserRequest(20, "inspect_reference", {
          session_id: "task",
          tab_id: 10,
          ref: "e0:n20",
        }),
      ),
    ).resolves.toMatchObject({
      response: { success: true, data: { element, url: "https://example.com/checkout" } },
    });
    await expect(
      controller.execute(
        browserRequest(21, "click", {
          session_id: "task",
          tab_id: 10,
          ref: "e0:n20",
          expected: element,
        }),
      ),
    ).resolves.toMatchObject({ response: { success: true, data: { epoch: 1 } } });
    expect(
      sendCommand.mock.calls.some(
        (call) =>
          call[1] === "Runtime.callFunctionOn" &&
          String(call[2]?.functionDeclaration).includes("expected"),
      ),
    ).toBe(true);
  });

  it("aborts the act message when element facts no longer match", async () => {
    const { controller, sendCommand } = interactionController();
    sendCommand.mockImplementation(async (_target: unknown, method: string) => {
      if (method === "DOM.resolveNode") return { object: { objectId: "node-20" } };
      if (method === "Runtime.callFunctionOn") return { result: { value: { status: "changed" } } };
      return {};
    });

    await expect(
      controller.execute(
        browserRequest(22, "click", {
          session_id: "task",
          tab_id: 10,
          ref: "e0:n20",
          expected: element,
        }),
      ),
    ).resolves.toMatchObject({
      response: { success: false, errorCode: "browser_stale_reference" },
    });
    expect(controller.registry.acceptsRef("task", 10, "e0:n20")).toBe(true);
  });

  it("dispatches click, fill, and press only with broker-supplied expected facts", async () => {
    for (const [tool, extra] of [
      ["click", {}],
      ["fill", { text: "" }],
      ["press", { key: "Enter" }],
    ] as const) {
      const { controller, sendCommand } = interactionController();
      sendCommand.mockImplementation(async (_target: unknown, method: string) => {
        if (method === "DOM.resolveNode") return { object: { objectId: "node-20" } };
        if (method === "Runtime.callFunctionOn") return { result: { value: { status: "ok" } } };
        if (method === "Accessibility.getFullAXTree") return { nodes: [] };
        if (method === "Runtime.evaluate") return { result: { value: "complete" } };
        return {};
      });

      const result = await controller.execute(
        browserRequest(30, tool, {
          session_id: "task",
          tab_id: 10,
          ref: "e0:n20",
          expected: element,
          ...extra,
        }),
      );
      expect(result.response.success, `${tool} should execute`).toBe(true);
      expect(
        sendCommand.mock.calls.some(
          (call) =>
            call[1] === "Runtime.callFunctionOn" &&
            (call[2]?.arguments as Array<{ value?: unknown }> | undefined)?.[2]?.value === element,
        ),
        `${tool} must receive expected facts`,
      ).toBe(true);
      if (tool === "press") {
        expect(
          sendCommand.mock.calls.filter((call) => call[1] === "Input.dispatchKeyEvent"),
        ).toHaveLength(2);
      }
    }
  });
});

describe("browser error redaction", () => {
  it("omits browser content from protocol failures", () => {
    const error = Object.assign(
      new Error(
        "Page text from https://private.example/secret with screenshot bytes and field-value-123",
      ),
      { code: "https://private.example/secret" },
    );
    const response = browserFailureResponse(
      {
        v: 2,
        type: "request",
        id: 9,
        tool: "navigate",
        arguments: {
          session_id: "session-123",
          tab_id: 42,
          url: "https://private.example/secret",
          text: "field-value-123",
        },
      },
      error,
    );

    expect(response.errorCode).toBe("extension_request_failed");
    expect(response.message).toContain("navigate");
    expect(response.message).toContain("session-123");
    expect(response.message).toContain("tab 42");
    expect(response.message).not.toContain("private.example");
    expect(response.message).not.toContain("Page text");
    expect(response.message).not.toContain("screenshot bytes");
    expect(response.message).not.toContain("field-value-123");
  });
});
