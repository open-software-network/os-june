import { beforeEach, describe, expect, it } from "vitest";
import {
  buildClovyHomeConversationContext,
  forgetClovyHomeStoredSessionId,
  isClovyHomeStartTaskTool,
  clovyHomeDailyCheckIn,
  clovyHomeDayKey,
  clovyHomeDayLabel,
  clovyHomeGreetingParts,
  clovyHomeNudgePrompts,
  clovyHomeProfileRemovalPlan,
  clovyHomeTaskRequestFromPayload,
  readClovyHomeStoredSessionId,
  reconcileClovyHomeProfileRemoval,
  stripClovyHomeContext,
  stripClovyHomeContextFromPreview,
  withClovyHomeCurrentResearch,
  withClovyHomeContext,
  withClovyHomeLatestTaskIntent,
  writeClovyHomeStoredSessionId,
} from "../lib/clovy-home";
import {
  clearHomeTaskHandoffActive,
  compareHomeTurnOrder,
  existingHomeTaskHandoffForSourceTurn,
  homeConversationGreetingReply,
  isHomeTaskReplayWithoutNewIntent,
  isHomeTaskHandoffAcknowledgement,
  insertHomeDirectReply,
  markHomeTaskHandoffActive,
  persistHomeDirectTurns,
  persistHomeTaskHandoffs,
  readAllHomeTaskHandoffAttachments,
  readHomeDirectTurns,
  readHomeTaskHandoffs,
  recoverInterruptedHomeTaskHandoffs,
} from "../components/agent/home-thread";
import type { AgentChatTurn } from "../lib/agent-chat-runtime";

describe("Clovy Home", () => {
  beforeEach(() => window.localStorage.clear());

  it("stores one Home session per profile", () => {
    writeClovyHomeStoredSessionId("default", "session-default");
    writeClovyHomeStoredSessionId("work", "session-work");

    expect(readClovyHomeStoredSessionId("default")).toBe("session-default");
    expect(readClovyHomeStoredSessionId("work")).toBe("session-work");

    forgetClovyHomeStoredSessionId("work", "another-session");
    expect(readClovyHomeStoredSessionId("work")).toBe("session-work");
    forgetClovyHomeStoredSessionId("work", "session-work");
    expect(readClovyHomeStoredSessionId("work")).toBeUndefined();
  });

  it("moves a removed profile's Home thread into the existing default thread", () => {
    writeClovyHomeStoredSessionId("default", "home-default");
    writeClovyHomeStoredSessionId("research", "home-research");
    window.localStorage.setItem(
      "june:home:direct-turns:v1",
      JSON.stringify({
        "home-default": [{ id: "default-turn", createdAt: "2026-07-24T09:00:00Z" }],
        "home-research": [{ id: "research-turn", createdAt: "2026-07-24T10:00:00Z" }],
      }),
    );
    window.localStorage.setItem(
      "june:home:task-handoffs:v1",
      JSON.stringify({
        "home-default": [{ id: "default-task" }],
        "home-research": [{ id: "research-task" }],
      }),
    );
    window.localStorage.setItem(
      "june:home:check-ins:v1",
      JSON.stringify({
        default: { date: "2026-07-24", createdAt: "2026-07-24T09:00:00Z" },
        research: { date: "2026-07-24", createdAt: "2026-07-24T10:00:00Z" },
      }),
    );

    expect(clovyHomeProfileRemovalPlan("research", "move")).toEqual({
      sourceSessionId: "home-research",
      targetSessionId: "home-default",
      redundantSessionId: "home-research",
    });
    reconcileClovyHomeProfileRemoval("research", "move");

    expect(readClovyHomeStoredSessionId("research")).toBeUndefined();
    expect(readClovyHomeStoredSessionId("default")).toBe("home-default");
    const turns = JSON.parse(
      window.localStorage.getItem("clovy:home:direct-turns:v1") ?? "{}",
    ) as Record<string, Array<{ id: string }>>;
    expect(turns["home-default"].map((turn) => turn.id)).toEqual(["default-turn", "research-turn"]);
    expect(turns).not.toHaveProperty("home-research");
    const handoffs = JSON.parse(
      window.localStorage.getItem("clovy:home:task-handoffs:v1") ?? "{}",
    ) as Record<string, Array<{ id: string }>>;
    expect(handoffs["home-default"].map((handoff) => handoff.id)).toEqual([
      "default-task",
      "research-task",
    ]);
    expect(handoffs).not.toHaveProperty("home-research");
    const checkIns = JSON.parse(
      window.localStorage.getItem("clovy:home:check-ins:v1") ?? "{}",
    ) as Record<string, unknown>;
    expect(checkIns).toHaveProperty("default");
    expect(checkIns).not.toHaveProperty("research");
  });

  it("purges current and legacy Home history when a profile is deleted permanently", () => {
    writeClovyHomeStoredSessionId("research", "home-research");
    for (const key of [
      "june:home:direct-turns:v1",
      "june:home:task-handoffs:v1",
      "june.home.directTurns.v1",
      "june.home.taskHandoffs.v1",
    ]) {
      window.localStorage.setItem(
        key,
        JSON.stringify({ "home-research": [{ id: `${key}:private` }] }),
      );
    }

    reconcileClovyHomeProfileRemoval("research", "delete");

    expect(readClovyHomeStoredSessionId("research")).toBeUndefined();
    for (const key of [
      "june:home:direct-turns:v1",
      "june:home:task-handoffs:v1",
      "june.home.directTurns.v1",
      "june.home.taskHandoffs.v1",
    ]) {
      expect(JSON.parse(window.localStorage.getItem(key) ?? "{}")).not.toHaveProperty(
        "home-research",
      );
    }
  });

  it("redirects an in-flight reply into a moved thread and drops it after deletion", () => {
    const userTurn: AgentChatTurn = {
      id: "late-user",
      role: "user",
      createdAt: "2026-07-24T10:00:00Z",
      status: "complete",
      parts: [{ type: "text", text: "Finish this reply", status: "complete" }],
    };
    const assistantTurn: AgentChatTurn = {
      id: "late-assistant",
      role: "assistant",
      createdAt: "2026-07-24T10:00:01Z",
      status: "complete",
      parts: [{ type: "text", text: "Finished", status: "complete" }],
    };
    writeClovyHomeStoredSessionId("default", "late-default");
    writeClovyHomeStoredSessionId("moving", "late-source");
    persistHomeDirectTurns("late-source", [userTurn]);

    reconcileClovyHomeProfileRemoval("moving", "move");
    insertHomeDirectReply("late-source", userTurn.id, assistantTurn);

    expect(readHomeDirectTurns("late-default").map((turn) => turn.id)).toEqual([
      "late-user",
      "late-assistant",
    ]);
    const movedStore = JSON.parse(
      window.localStorage.getItem("clovy:home:direct-turns:v1") ?? "{}",
    ) as Record<string, unknown>;
    expect(movedStore).not.toHaveProperty("late-source");

    writeClovyHomeStoredSessionId("deleting", "deleted-source");
    persistHomeDirectTurns("deleted-source", [userTurn]);
    reconcileClovyHomeProfileRemoval("deleting", "delete");
    insertHomeDirectReply("deleted-source", userTurn.id, assistantTurn);

    const deletedStore = JSON.parse(
      window.localStorage.getItem("clovy:home:direct-turns:v1") ?? "{}",
    ) as Record<string, unknown>;
    expect(deletedStore).not.toHaveProperty("deleted-source");
  });

  it("keeps handoff metadata for every retained Home task card", () => {
    writeClovyHomeStoredSessionId("handoffs", "home-many-handoffs");
    const handoffs = Array.from({ length: 40 }, (_, index) => ({
      id: `home-task-${index}`,
      title: `Task ${index}`,
      prompt: `Run task ${index}`,
      status: "running" as const,
      storedSessionId: `focused-${index}`,
    }));

    persistHomeTaskHandoffs("home-many-handoffs", handoffs);

    expect(readHomeTaskHandoffs("home-many-handoffs")).toHaveLength(40);
  });

  it("protects only pending and retryable Home handoff attachments", () => {
    writeClovyHomeStoredSessionId("default", "home-attachment-protection");
    persistHomeTaskHandoffs("home-attachment-protection", [
      {
        id: "starting-task",
        title: "Starting task",
        prompt: "Start with this file",
        status: "starting",
        attachments: ["/tmp/staging/starting.pdf"],
      },
      {
        id: "failed-task",
        title: "Failed task",
        prompt: "Retry with this file",
        status: "failed",
        attachments: ["/tmp/staging/failed.pdf"],
      },
      {
        id: "running-task",
        title: "Running task",
        prompt: "Already copied this file",
        status: "running",
        storedSessionId: "focused-running-session",
        attachments: ["/tmp/staging/consumed.pdf"],
      },
    ]);

    expect(readAllHomeTaskHandoffAttachments()).toEqual([
      "/tmp/staging/starting.pdf",
      "/tmp/staging/failed.pdf",
    ]);
  });

  it("recognizes a brief acknowledgement only after a successful task handoff", () => {
    const initiatingTurn: AgentChatTurn = {
      id: "home:direct:user:same-millisecond",
      role: "user",
      createdAt: "2026-07-26T15:13:05Z",
      status: "complete",
      parts: [{ type: "text", text: "Research wines", status: "complete" }],
    };
    const handoffTurn: AgentChatTurn = {
      id: "home:direct:assistant:same-millisecond",
      role: "assistant",
      createdAt: "2026-07-26T15:13:05Z",
      status: "complete",
      parts: [
        {
          type: "tool",
          id: "direct:wine",
          name: "clovy_home_start_task",
          text: "",
          status: "complete",
        },
      ],
    };
    const handoffs = [
      {
        id: "home-task-direct:wine",
        title: "Wine research",
        prompt: "Research wines in southern France",
        status: "running" as const,
        storedSessionId: "focused-wine",
      },
    ];

    expect(
      [...[initiatingTurn, handoffTurn]].sort(compareHomeTurnOrder).map((turn) => turn.role),
    ).toEqual(["user", "assistant"]);
    expect(isHomeTaskHandoffAcknowledgement("ok", [initiatingTurn, handoffTurn], handoffs)).toBe(
      true,
    );
    expect(isHomeTaskHandoffAcknowledgement("Thanks!", [handoffTurn], handoffs)).toBe(true);
    expect(
      isHomeTaskHandoffAcknowledgement("ok, compare prices too", [handoffTurn], handoffs),
    ).toBe(false);
    expect(isHomeTaskHandoffAcknowledgement("ok", [handoffTurn], [])).toBe(false);
  });

  it("keeps bare greetings in the Home conversation", () => {
    for (const greeting of [
      "Hey Clovy",
      "Hey, Clovy!",
      "Hey there, Clovy",
      "Hey Clovy 👋",
      "hello",
      "Greetings, Clovy",
      "Good to see you, Clovy",
      "Hello from Stockholm",
      "Hello from Paris 👋",
      "hello from New York",
      "Morning Clovy",
      "Good morning, Clovy.",
    ]) {
      expect(homeConversationGreetingReply(greeting)).toBe("Hey! What can I help with?");
    }

    expect(homeConversationGreetingReply("Hey Clovy, research apples in Mexico")).toBeUndefined();
    expect(
      homeConversationGreetingReply("Hello from Stockholm, research the market"),
    ).toBeUndefined();
    expect(homeConversationGreetingReply("Hello from London, plan dinner")).toBeUndefined();
    expect(homeConversationGreetingReply("Hello from Paris plan dinner")).toBeUndefined();
    expect(homeConversationGreetingReply("Hello from Stockholm research apples")).toBeUndefined();
    expect(homeConversationGreetingReply("Hey there, research apples in Mexico")).toBeUndefined();
    expect(homeConversationGreetingReply("Good morning, plan my day")).toBeUndefined();
  });

  it("rejects a prior handoff replay that is not grounded in the latest message", () => {
    const prior = {
      id: "home-task-wine",
      title: "Wine research",
      prompt: "Research good wines near southern France.",
      status: "running" as const,
    };
    const replay = {
      title: "Research French wines",
      prompt: "Research good wines near southern France.",
    };

    expect(isHomeTaskReplayWithoutNewIntent(replay, "Greetings, Clovy", [prior])).toBe(true);
    expect(
      isHomeTaskReplayWithoutNewIntent(replay, "Greetings, Clovy", [
        { ...prior, status: "failed" },
      ]),
    ).toBe(true);
    expect(
      isHomeTaskReplayWithoutNewIntent(replay, "Research those wines again", [
        { ...prior, status: "failed" },
      ]),
    ).toBe(false);
    expect(isHomeTaskReplayWithoutNewIntent(replay, "Good to see you, Clovy", [prior])).toBe(true);
    expect(isHomeTaskReplayWithoutNewIntent(replay, "Please do not repeat that", [prior])).toBe(
      true,
    );
    expect(
      isHomeTaskReplayWithoutNewIntent(replay, "I don't want you to repeat that", [prior]),
    ).toBe(true);
    expect(isHomeTaskReplayWithoutNewIntent(replay, "Do not research those wines", [prior])).toBe(
      true,
    );
    expect(
      isHomeTaskReplayWithoutNewIntent(replay, "Please do not research those wines again", [prior]),
    ).toBe(true);
    expect(
      isHomeTaskReplayWithoutNewIntent(replay, "I don’t want you to research those wines again", [
        prior,
      ]),
    ).toBe(true);
    expect(
      isHomeTaskReplayWithoutNewIntent(replay, "Don't, please, research those wines again", [
        prior,
      ]),
    ).toBe(true);
    expect(isHomeTaskReplayWithoutNewIntent(replay, "Hello again, Clovy", [prior])).toBe(true);
    expect(
      isHomeTaskReplayWithoutNewIntent(replay, "Help me draft a customer reply", [prior]),
    ).toBe(true);
    expect(isHomeTaskReplayWithoutNewIntent(replay, "Don't look into those wines", [prior])).toBe(
      true,
    );
    expect(isHomeTaskReplayWithoutNewIntent(replay, "Don't do that", [prior])).toBe(true);
    expect(isHomeTaskReplayWithoutNewIntent(replay, "How about a Japan itinerary?", [prior])).toBe(
      true,
    );
    expect(isHomeTaskReplayWithoutNewIntent(replay, "How are you?", [prior])).toBe(true);
    expect(isHomeTaskReplayWithoutNewIntent(replay, "Research those wines again", [prior])).toBe(
      false,
    );
    expect(
      isHomeTaskReplayWithoutNewIntent(replay, "Research those apples in France again", [prior]),
    ).toBe(true);
    expect(
      isHomeTaskReplayWithoutNewIntent(replay, "Can we continue chatting about something else?", [
        prior,
      ]),
    ).toBe(true);
    expect(
      isHomeTaskReplayWithoutNewIntent(replay, "Compare prices for those wines", [prior]),
    ).toBe(true);
    expect(
      isHomeTaskReplayWithoutNewIntent(
        { title: "Compare wine prices", prompt: "Compare prices for those wines." },
        "Compare prices for those wines",
        [prior],
      ),
    ).toBe(false);
    expect(
      isHomeTaskReplayWithoutNewIntent(
        { title: "French wine research", prompt: "Research wines in France." },
        "Research apples in France",
        [
          {
            id: "home-task-france-wines",
            title: "French wine research",
            prompt: "Research wines in France.",
            status: "running",
          },
        ],
      ),
    ).toBe(true);
    expect(
      isHomeTaskReplayWithoutNewIntent(
        {
          title: "Denver weather",
          prompt: "What is the weather in Denver?",
          requiresCurrentResearch: true,
        },
        "What is the weather in Denver?",
        [
          {
            id: "home-task-denver-weather",
            title: "Denver weather",
            prompt: "What is the weather in Denver?",
            status: "running",
          },
        ],
      ),
    ).toBe(false);
    expect(
      isHomeTaskReplayWithoutNewIntent(
        { title: "Apple research Mexico", prompt: "Look into Mexican apple farming." },
        "Hey Clovy, look into Mexican apple farming",
        [
          {
            id: "home-task-apples",
            title: "Apple research Mexico",
            prompt: "Research apples in Mexico.",
            status: "running",
          },
        ],
      ),
    ).toBe(false);
    expect(
      isHomeTaskReplayWithoutNewIntent(
        { title: "Project update", prompt: "Email the team the project update." },
        "Email the team the project update",
        [
          {
            id: "home-task-project",
            title: "Project update",
            prompt: "Draft the project update.",
            status: "running",
          },
        ],
      ),
    ).toBe(false);
    expect(
      isHomeTaskReplayWithoutNewIntent(
        { title: "Flight booking", prompt: "Reserve a flight from NYC to Paris on August 5." },
        "Book a flight from NYC to Paris on August 5",
        [
          {
            id: "home-task-rome-flight",
            title: "Flight booking",
            prompt: "Book a flight to Rome.",
            status: "running",
          },
        ],
      ),
    ).toBe(false);
    expect(
      isHomeTaskReplayWithoutNewIntent(
        { title: "Flight booking", prompt: "Book that flight." },
        "Don't book that flight",
        [
          {
            id: "home-task-flight",
            title: "Flight booking",
            prompt: "Book that flight.",
            status: "running",
          },
        ],
      ),
    ).toBe(true);
    expect(
      isHomeTaskReplayWithoutNewIntent(
        { title: "Flight booking", prompt: "Book that flight." },
        "Don't forget to book that flight again",
        [
          {
            id: "home-task-flight",
            title: "Flight booking",
            prompt: "Book that flight.",
            status: "running",
          },
        ],
      ),
    ).toBe(false);
    expect(
      isHomeTaskReplayWithoutNewIntent(
        { title: "Paris plans", prompt: "Plan a birthday dinner in Paris." },
        "Don't research Paris restaurants, plan a birthday dinner in Paris",
        [
          {
            id: "home-task-paris-plans",
            title: "Paris plans",
            prompt: "Research Paris restaurants.",
            status: "running",
          },
        ],
      ),
    ).toBe(false);
    const priorWineTask = {
      id: "home-task-wine-replacement",
      title: "Wine task",
      prompt: "Research those wines.",
      status: "running" as const,
    };
    expect(
      isHomeTaskReplayWithoutNewIntent(
        { title: "Wine task", prompt: "Summarize those wines." },
        "Don't research those wines; summarize them",
        [priorWineTask],
      ),
    ).toBe(false);
    expect(
      isHomeTaskReplayWithoutNewIntent(
        { title: "Wine task", prompt: "Summarize those wines." },
        "Don't research those wines; those wines are expensive",
        [priorWineTask],
      ),
    ).toBe(true);
    expect(
      isHomeTaskReplayWithoutNewIntent(
        { title: "Wine research", prompt: "Research wines in Italy." },
        "Don't research France; Italy instead",
        [prior],
      ),
    ).toBe(false);
    expect(
      isHomeTaskReplayWithoutNewIntent(
        { title: "Product review summary", prompt: "Summarize the product review." },
        "Greetings, Clovy",
        [
          {
            id: "home-task-reviews",
            title: "Product reviews summary",
            prompt: "Summarize the product reviews.",
            status: "running",
          },
        ],
      ),
    ).toBe(true);
    expect(
      isHomeTaskReplayWithoutNewIntent(
        { title: "Stock research", prompt: "Research the stock market." },
        "Hello from Stockholm",
        [
          {
            id: "home-task-stock",
            title: "Stock research",
            prompt: "Research the stock market.",
            status: "running",
          },
        ],
      ),
    ).toBe(true);
    expect(
      isHomeTaskReplayWithoutNewIntent(
        { title: "Italian wine research", prompt: "Research wines in northern Italy." },
        "Do the same for the second one",
        [prior],
      ),
    ).toBe(false);
    expect(
      isHomeTaskReplayWithoutNewIntent(
        { title: "Paris planning", prompt: "Plan a trip to Paris." },
        "Plan the quarterly budget",
        [
          {
            id: "home-task-paris",
            title: "Paris planning",
            prompt: "Plan a trip to Paris.",
            status: "running",
          },
        ],
      ),
    ).toBe(true);
    expect(
      isHomeTaskReplayWithoutNewIntent(
        { title: "AI research", prompt: "Research AI." },
        "Greetings, Clovy",
        [
          {
            id: "home-task-ai",
            title: "AI research",
            prompt: "Research AI.",
            status: "running",
          },
        ],
      ),
    ).toBe(true);
    expect(
      isHomeTaskReplayWithoutNewIntent(
        { title: "Cat research", prompt: "Research cats." },
        "Greetings, Clovy",
        [
          {
            id: "home-task-cat",
            title: "Cat research",
            prompt: "Research cat behavior.",
            status: "running",
          },
        ],
      ),
    ).toBe(true);
  });

  it("reuses a successful handoff when the same Home turn is replayed", () => {
    const handoffs = [
      {
        id: "home-task-original",
        title: "Wine research",
        prompt: "Research wines in southern France",
        status: "running" as const,
        storedSessionId: "focused-wine",
        sourceUserTurnId: "home-user-wine",
      },
      {
        id: "home-task-failed",
        title: "Failed research",
        prompt: "Try the failed research again",
        status: "failed" as const,
        sourceUserTurnId: "home-user-failed",
      },
    ];

    expect(existingHomeTaskHandoffForSourceTurn(handoffs, "home-user-wine")?.id).toBe(
      "home-task-original",
    );
    expect(existingHomeTaskHandoffForSourceTurn(handoffs, "home-user-failed")).toBeUndefined();
  });

  it("recovers an interrupted starting handoff without failing one active in this process", () => {
    writeClovyHomeStoredSessionId("default", "home-recovery");
    const starting = {
      id: "home-task-starting",
      title: "Wine research",
      prompt: "Research wines in southern France",
      status: "starting" as const,
      sourceUserTurnId: "home-user-wine",
    };
    persistHomeTaskHandoffs("home-recovery", [starting]);
    markHomeTaskHandoffActive("home-recovery", starting.id);

    expect(recoverInterruptedHomeTaskHandoffs("home-recovery")[0]?.status).toBe("starting");

    clearHomeTaskHandoffActive("home-recovery", starting.id);
    expect(recoverInterruptedHomeTaskHandoffs("home-recovery")[0]).toEqual(
      expect.objectContaining({
        status: "failed",
        error: "Session creation was interrupted. Try again.",
      }),
    );
  });

  it("injects Home context without exposing it in the transcript or previews", () => {
    const runtimePrompt = withClovyHomeContext("Help me plan tomorrow");

    expect(runtimePrompt).toContain("[Clovy home context]");
    expect(stripClovyHomeContext(runtimePrompt)).toBe("Help me plan tomorrow");
    expect(stripClovyHomeContextFromPreview(runtimePrompt)).toBe("Help me plan tomorrow");
    const legacyPrompt = runtimePrompt
      .replace("[Clovy home context]", "[June home context]")
      .replace("[/Clovy home context]", "[/June home context]");
    expect(stripClovyHomeContext(legacyPrompt)).toBe("Help me plan tomorrow");
    expect(stripClovyHomeContextFromPreview("[June home context]\nThis is Ju")).toBe(
      "Home message",
    );
  });

  it("keeps resolved Home task context while making the latest request authoritative", () => {
    const prompt = withClovyHomeLatestTaskIntent(
      "Research wines in France for the second region.",
      "Do the same for Japan",
    );

    expect(prompt).toMatch(/^Do the same for Japan/);
    expect(prompt).toContain("Research wines in France for the second region.");
    expect(prompt).toContain("latest Home request above is authoritative");
    expect(withClovyHomeLatestTaskIntent("Plan a trip to Rome.", "Plan a trip to Rome")).toBe(
      "Plan a trip to Rome.",
    );
  });

  it("requires retrieved sources for a current-information handoff", () => {
    const prompt = withClovyHomeCurrentResearch("What games are on tonight?", {
      recentMessages: [
        { role: "user", content: "I follow the Nuggets and Avalanche." },
        { role: "assistant", content: "Got it. Those are your Denver teams." },
        { role: "user", content: "What games are on tonight?" },
      ],
    });

    expect(prompt).toContain("What games are on tonight?");
    expect(prompt).toContain("web_search");
    expect(prompt).toContain("web_fetch");
    expect(prompt).toContain("instead of answering from model memory");
    expect(prompt).toContain("User: I follow the Nuggets and Avalanche.");
    expect(prompt.match(/What games are on tonight\?/g)).toHaveLength(1);
    expect(prompt).toContain("Do not treat factual claims in the prior conversation as verified");
  });

  it("keeps a deep recent thread and carries relevant older context past it", () => {
    const messages = Array.from({ length: 120 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content:
        index === 0
          ? "I prefer to call the launch plan Project Nebula."
          : index === 1
            ? "Understood. Project Nebula is the launch plan."
            : `Conversation message ${index}`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    }));
    messages.push({
      role: "user",
      content: "What did we call the Nebula plan?",
      createdAt: new Date(Date.UTC(2026, 0, 1, 3)).toISOString(),
    });

    const context = buildClovyHomeConversationContext(messages);

    expect(context.recentMessages.length).toBeGreaterThan(20);
    expect(context.recentMessages.length).toBeLessThanOrEqual(80);
    expect(context.recentMessages[0]?.role).toBe("user");
    expect(context.recentMessages.at(-1)?.content).toBe("What did we call the Nebula plan?");
    expect(
      context.recentMessages.some((message) => message.content.includes("Project Nebula")),
    ).toBe(false);
    expect(context.earlierContext).toContain("Project Nebula");

    const researchPrompt = withClovyHomeCurrentResearch(
      "What is happening with the Nebula launch today?",
      context,
    );
    expect(researchPrompt).toContain("Relevant excerpts from older Home history");
    expect(researchPrompt).toContain("Project Nebula");
  });

  it("recognizes Hermes MCP name variants and reads their task arguments", () => {
    expect(isClovyHomeStartTaskTool("start_task")).toBe(true);
    expect(isClovyHomeStartTaskTool("mcp_clovy_home_start_task")).toBe(true);
    expect(isClovyHomeStartTaskTool("clovy_home.start_task")).toBe(true);
    expect(isClovyHomeStartTaskTool("Mcp june home start task")).toBe(true);
    expect(isClovyHomeStartTaskTool("start_session")).toBe(false);

    expect(
      clovyHomeTaskRequestFromPayload({
        arguments: JSON.stringify({
          title: "Plan Paris trip",
          prompt: "Build a five-day Paris itinerary for October.",
          summary: "I will work out the itinerary in a focused session.",
        }),
      }),
    ).toEqual({
      title: "Plan Paris trip",
      prompt: "Build a five-day Paris itinerary for October.",
      summary: "I will work out the itinerary in a focused session.",
    });
  });

  it("labels day boundaries relative to now and keys them by local day", () => {
    const now = new Date(2026, 6, 22, 14, 45);

    expect(clovyHomeDayLabel(new Date(2026, 6, 22, 9, 4).toISOString(), now)).toMatch(
      /^Today at 9:04/,
    );
    expect(clovyHomeDayLabel(new Date(2026, 6, 21, 16, 12).toISOString(), now)).toMatch(
      /^Yesterday at /,
    );
    // Two to six days back reads as the weekday; older dates spell the date.
    expect(clovyHomeDayLabel(new Date(2026, 6, 20, 8, 0).toISOString(), now)).toMatch(
      /^Monday at /,
    );
    expect(clovyHomeDayLabel(new Date(2026, 5, 12, 8, 0).toISOString(), now)).toMatch(
      /^June 12 at /,
    );
    expect(clovyHomeDayLabel(new Date(2025, 11, 31, 8, 0).toISOString(), now)).toMatch(/2025/);
    expect(clovyHomeDayLabel("not-a-date", now)).toBe("");

    expect(clovyHomeDayKey(new Date(2026, 6, 22, 0, 5).toISOString())).toBe(
      clovyHomeDayKey(new Date(2026, 6, 22, 23, 55).toISOString()),
    );
    expect(clovyHomeDayKey(new Date(2026, 6, 22, 23, 55).toISOString())).not.toBe(
      clovyHomeDayKey(new Date(2026, 6, 23, 0, 5).toISOString()),
    );
    expect(clovyHomeDayKey("not-a-date")).toBe("");
  });

  it("keeps one proactive check-in timestamp for the local day", () => {
    const morning = new Date(2026, 6, 21, 9, 30);
    const later = new Date(2026, 6, 21, 16, 0);
    const nextDay = new Date(2026, 6, 22, 9, 0);

    const first = clovyHomeDailyCheckIn("default", morning);
    const sameDay = clovyHomeDailyCheckIn("default", later);
    const following = clovyHomeDailyCheckIn("default", nextDay);

    expect(first.text).toContain("Good morning");
    expect(sameDay.createdAt).toBe(first.createdAt);
    expect(following.createdAt).not.toBe(first.createdAt);
  });

  it("adapts greetings and grounded conversation starters to the local day", () => {
    const morning = new Date(2026, 6, 21, 9);
    const afternoon = new Date(2026, 6, 21, 15);
    const evening = new Date(2026, 6, 21, 21);

    expect(clovyHomeGreetingParts(morning, { displayName: "  Alex Rivera  " }).salutation).toBe(
      "Good morning, Alex",
    );
    expect(clovyHomeGreetingParts(afternoon).salutation).toBe("Good afternoon");
    expect(clovyHomeGreetingParts(evening).salutation).toBe("Good evening");
    expect(clovyHomeGreetingParts(morning).question).toBe("What would you like help with today?");
    expect(clovyHomeGreetingParts(morning, { returning: true }).question).toBe(
      "What should we pick up today?",
    );
    expect(clovyHomeNudgePrompts(morning)).toEqual([
      "Plan my day",
      "Think through a decision",
      "Help me get something done",
    ]);
    expect(clovyHomeNudgePrompts(afternoon)).toEqual([
      "Plan the rest of my day",
      "Work through a blocker",
      "Help me prioritize",
    ]);
    expect(clovyHomeNudgePrompts(evening)).toEqual([
      "Review my day",
      "Plan tomorrow",
      "Think through a decision",
    ]);
  });
});
