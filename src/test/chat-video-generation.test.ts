import { describe, expect, it, vi } from "vitest";
import { generateChatVideo, type GenerateChatVideoDeps } from "../lib/chat-video-generation";

describe("chat video generation", () => {
  it("starts a job and polls to completion", async () => {
    const deps: GenerateChatVideoDeps = {
      startGenerate: vi.fn().mockResolvedValue({ jobId: "job-1" }),
      pollStatus: vi
        .fn()
        .mockResolvedValueOnce({
          status: "processing",
          averageExecutionMs: 120_000,
          executionMs: 10_000,
        })
        .mockResolvedValueOnce({
          status: "completed",
          path: "/Users/alex/Library/Application Support/co.opensoftware.june/hermes/videos/out.mp4",
          mimeType: "video/mp4",
          sizeBytes: 1234,
          model: "seedance-2-0-fast-text-to-video",
        }),
      onProgress: vi.fn(),
      sleep: vi.fn().mockResolvedValue(undefined),
    };

    const result = await generateChatVideo(
      "a calm lake",
      deps,
      "seedance-2-0-fast-text-to-video",
      "video-req-1",
      { safeMode: false },
    );

    expect(deps.startGenerate).toHaveBeenCalledWith(
      "a calm lake",
      "seedance-2-0-fast-text-to-video",
      "video-req-1",
      { safeMode: false },
    );
    expect(deps.onProgress).toHaveBeenCalledWith({
      jobId: "job-1",
      status: "processing",
      averageExecutionMs: 120_000,
      executionMs: 10_000,
    });
    expect(result).toEqual({
      status: "ok",
      jobId: "job-1",
      path: "/Users/alex/Library/Application Support/co.opensoftware.june/hermes/videos/out.mp4",
      mimeType: "video/mp4",
      sizeBytes: 1234,
      model: "seedance-2-0-fast-text-to-video",
    });
  });

  it("returns an error for a failed job", async () => {
    const deps: GenerateChatVideoDeps = {
      startGenerate: vi.fn().mockResolvedValue({ jobId: "job-1" }),
      pollStatus: vi.fn().mockResolvedValue({ status: "failed", reason: "content blocked" }),
    };

    await expect(generateChatVideo("a lake", deps)).resolves.toEqual({
      status: "error",
      message: "content blocked",
      jobId: "job-1",
    });
  });

  it("rejects a blank prompt without starting a job", async () => {
    const deps: GenerateChatVideoDeps = {
      startGenerate: vi.fn(),
      pollStatus: vi.fn(),
    };

    await expect(generateChatVideo("   ", deps)).resolves.toEqual({
      status: "error",
      message: "Enter a prompt to generate a video.",
    });
    expect(deps.startGenerate).not.toHaveBeenCalled();
  });
});
