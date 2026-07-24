import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useConnectorPolicy } from "../lib/connector-policy";
import { representativeConnectorPolicy } from "./fixtures/connector-policy";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: mocks.invoke,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useConnectorPolicy", () => {
  it("loads the native policy through the additive command", async () => {
    const catalog = representativeConnectorPolicy();
    mocks.invoke.mockResolvedValue(catalog);

    const { result } = renderHook(() => useConnectorPolicy());

    await waitFor(() => expect(result.current.policy).toEqual(catalog));
    expect(mocks.invoke).toHaveBeenCalledWith("connectors_policy");
    expect(result.current.error).toBeNull();
  });

  it("fails closed when the native contract is unavailable or malformed", async () => {
    mocks.invoke.mockResolvedValue([]);

    const { result } = renderHook(() => useConnectorPolicy());

    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error));
    expect(result.current.policy).toBeNull();
  });
});
