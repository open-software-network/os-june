// Dev-only preview boot: fakes the Tauri IPC bridge + the Hermes gateway
// WebSocket so the real AgentWorkspace runs in plain Chromium for
// screenshots/recording. NOT committed, never shipped.

const callbacks = new Map();
let callbackId = 0;
const eventListeners = new Map(); // event name -> Set<callback id>
const scenario = new URLSearchParams(window.location.search).get("scenario") ?? "phase-a";

// --- a drawn "red bicycle" so generate_image needs no network -------------
function drawRedBicycle({ wide = false } = {}) {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 1024;
  const ctx = canvas.getContext("2d");
  // sky + ground
  const sky = ctx.createLinearGradient(0, 0, 0, 1024);
  sky.addColorStop(0, "#dcecf7");
  sky.addColorStop(1, "#f3ede2");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, 1024, 1024);
  ctx.fillStyle = "#e7dfcf";
  ctx.fillRect(0, 760, 1024, 264);
  ctx.strokeStyle = "#2b2b2b";
  ctx.lineWidth = 10;
  const rearX = wide ? 220 : 300;
  const frontX = wide ? 804 : 724;
  const seatX = wide ? 445 : 460;
  const barX = wide ? 680 : 650;
  const crankX = wide ? 512 : 520;
  // wheels
  for (const cx of [rearX, frontX]) {
    ctx.beginPath();
    ctx.arc(cx, 700, 150, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, 700, 12, 0, Math.PI * 2);
    ctx.fillStyle = "#2b2b2b";
    ctx.fill();
    // spokes
    ctx.lineWidth = 3;
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 6) {
      ctx.beginPath();
      ctx.moveTo(cx, 700);
      ctx.lineTo(cx + Math.cos(a) * 148, 700 + Math.sin(a) * 148);
      ctx.stroke();
    }
    ctx.lineWidth = 10;
  }
  // frame (red)
  ctx.strokeStyle = "#c62828";
  ctx.lineWidth = 16;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(rearX, 700); // rear hub
  ctx.lineTo(seatX, 480); // seat tube top
  ctx.lineTo(barX, 480); // top tube
  ctx.lineTo(frontX, 700); // front hub via fork
  ctx.moveTo(rearX, 700);
  ctx.lineTo(crankX, 700); // chainstay
  ctx.lineTo(seatX, 480); // seat tube
  ctx.moveTo(crankX, 700);
  ctx.lineTo(barX, 480); // down tube
  ctx.stroke();
  // handlebars + seat
  ctx.strokeStyle = "#2b2b2b";
  ctx.lineWidth = 12;
  ctx.beginPath();
  ctx.moveTo(barX, 480);
  ctx.lineTo(barX - 10, 420);
  ctx.lineTo(barX - 60, 400);
  ctx.moveTo(seatX, 480);
  ctx.lineTo(seatX - 10, 430);
  ctx.moveTo(seatX - 45, 425);
  ctx.lineTo(seatX + 27, 425); // seat
  ctx.stroke();
  // pedals
  ctx.beginPath();
  ctx.arc(crankX, 700, 34, 0, Math.PI * 2);
  ctx.stroke();
  return canvas.toDataURL("image/png").split(",")[1];
}
const BICYCLE_B64 = drawRedBicycle();
const WIDE_BICYCLE_B64 = drawRedBicycle({ wide: true });

const existingSession = {
  id: "session-1",
  title: scenario === "tool-results" ? "Image tool run" : "Weekend plans",
  preview:
    scenario === "tool-results"
      ? "Draw a red bicycle, then make it wider."
      : "Let's figure out Saturday.",
  model: "kimi-k2-6",
  last_active: "2026-07-02T08:30:00Z",
};

const textModels = [
  {
    provider: "venice",
    id: "zai-org-glm-5-2",
    name: "GLM 5.2",
    modelType: "text",
    privacy: "private",
    traits: [],
    capabilities: ["functionCalling"],
  },
  {
    provider: "venice",
    id: "kimi-k2-6",
    name: "Kimi K2.6",
    modelType: "text",
    privacy: "private",
    traits: [],
    capabilities: ["functionCalling", "supportsVision"],
  },
];

const connection = { port: 61234, wsUrl: "ws://127.0.0.1:61234", fullMode: false };
const createdSessions = new Map();

window.__TAURI_INTERNALS__ = {
  transformCallback(cb) {
    callbackId += 1;
    callbacks.set(callbackId, cb);
    return callbackId;
  },
  unregisterCallback(id) {
    callbacks.delete(id);
  },
  convertFileSrc(path) {
    return path;
  },
  async invoke(cmd, args = {}) {
    switch (cmd) {
      case "plugin:event|listen": {
        if (!eventListeners.has(args.event)) eventListeners.set(args.event, new Set());
        eventListeners.get(args.event).add(args.handler);
        return args.handler;
      }
      case "plugin:event|unlisten":
      case "plugin:event|emit":
        return null;
      case "list_agent_tasks":
        return { items: [] };
      case "provider_model_settings":
        return {
          settings: {
            transcriptionProvider: "venice",
            generationProvider: "venice",
            transcriptionModel: "nvidia/parakeet-tdt-0.6b-v3",
            generationModel: "kimi-k2-6",
            remoteGenerationModel: "kimi-k2-6",
            imageModel: "venice-sd35",
            veniceApiKeyConfigured: false,
            localGeneration: { baseUrl: "", modelId: "", apiKey: "" },
            imageSafeMode: false,
          },
        };
      case "list_venice_models":
        return {
          mode: "generation",
          modelType: "text",
          selectedModel: "kimi-k2-6",
          models: textModels,
        };
      case "hermes_bridge_status":
        return { running: true, connection, connections: [connection] };
      case "start_hermes_bridge":
        return { running: true, connection, connections: [connection] };
      case "hermes_bridge_sessions":
        return { sessions: [existingSession, ...createdSessions.values()] };
      case "hermes_bridge_session_messages": {
        const sessionId = args?.sessionId ?? args?.request?.sessionId;
        return {
          messages:
            scenario === "tool-results" && sessionId === "session-1"
              ? toolConversationMessages("session-1")
              : sessionId && createdSessions.has(sessionId)
              ? toolConversationMessages(sessionId)
              : [],
        };
      }
      case "hermes_agent_cli_access":
        return { enabled: false };
      case "hermes_bridge_skills":
        return [];
      case "hermes_bridge_toolsets":
        return [];
      case "hermes_bridge_messaging_platforms":
        return { platforms: [] };
      case "hermes_bridge_filesystem_snapshot":
        return { roots: [] };
      case "hermes_bridge_file_preview":
        return /\.(png|jpe?g|gif|webp)$/i.test(String(args.request?.path ?? args.path ?? ""))
          ? `data:image/png;base64,${BICYCLE_B64}`
          : null;
      case "hermes_bridge_file_text":
        return null;
      case "ensure_hermes_bridge_session":
        return {};
      case "generate_image":
        await new Promise((resolve) => setTimeout(resolve, 2600)); // visible loader
        return {
          imageBase64: BICYCLE_B64,
          mimeType: "image/png",
          model: "venice-sd35",
          provider: "venice",
        };
      case "import_hermes_bridge_file_bytes": {
        const name = args.request?.name ?? "generated-image.png";
        return {
          name,
          path: `/Users/alex/Library/Application Support/co.opensoftware.june/hermes/workspace/uploads/${name}`,
          rootLabel: "Workspace",
          size: 5,
          previewDataUrl: null,
        };
      }
      case "suggest_agent_session_title":
        return { title: titleForPrompt(args?.prompt ?? args?.request?.prompt ?? "") };
      case "os_accounts_status":
        return {
          signedIn: true,
          user: { id: "usr_demo", email: "alex@example.com", name: "Alex" },
          credits: { balance: 128_000 },
        };
      default:
        console.log("[preview] unstubbed invoke:", cmd, JSON.stringify(args).slice(0, 200));
        return null;
    }
  },
};

window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
  unregisterListener(event, id) {
    eventListeners.get(event)?.delete(id);
  },
};

// --- fake Hermes gateway over a fake WebSocket -----------------------------
const VISION_REPLY =
  "Kimi can read the attached image here: it is a red bicycle with two black " +
  "wheels, a simple red frame, and handlebars against a pale outdoor scene. " +
  "The proportions came out clean.";

const TOOL_REPLY =
  "Done. I generated the first image, then used edit_image with the returned " +
  "filename to make a wider version.";

function titleForPrompt(prompt) {
  const text = String(prompt ?? "").toLowerCase();
  if (text.includes("wider")) return "Wider bicycle";
  return "Red bicycle";
}

function nowIso(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString();
}

function contentBlocks(prompt, filename) {
  const isEdit = prompt.includes("wider");
  return [
    { type: "image", data: isEdit ? WIDE_BICYCLE_B64 : BICYCLE_B64, mimeType: "image/png" },
    {
      type: "text",
      text: JSON.stringify({
        filename,
        label: prompt,
        model: isEdit ? "firered-image-edit" : "venice-sd35",
        mimeType: "image/png",
      }),
    },
  ];
}

function toolConversationMessages(sessionId) {
  const base = nowIso(-5000);
  return [
    {
      id: `${sessionId}-user-1`,
      role: "user",
      content: "Draw a red bicycle, then make it wider using the image tool.",
      timestamp: base,
    },
    {
      id: `${sessionId}-assistant-1`,
      role: "assistant",
      content: "",
      timestamp: nowIso(-4000),
      tool_calls: JSON.stringify([
        {
          id: `${sessionId}-call-generate`,
          function: {
            name: "generate_image",
            arguments: { prompt: "a red bicycle" },
          },
        },
      ]),
    },
    {
      id: `${sessionId}-tool-generate`,
      role: "tool",
      tool_call_id: `${sessionId}-call-generate`,
      tool_name: "generate_image",
      content: contentBlocks("a red bicycle", "generated-image-red-bike.png"),
      timestamp: nowIso(-3000),
    },
    {
      id: `${sessionId}-assistant-2`,
      role: "assistant",
      content: "",
      timestamp: nowIso(-2000),
      tool_calls: JSON.stringify([
        {
          id: `${sessionId}-call-edit`,
          function: {
            name: "edit_image",
            arguments: {
              source_filename: "generated-image-red-bike.png",
              instruction: "make it wider",
            },
          },
        },
      ]),
    },
    {
      id: `${sessionId}-tool-edit`,
      role: "tool",
      tool_call_id: `${sessionId}-call-edit`,
      tool_name: "edit_image",
      content: contentBlocks("make it wider", "generated-image-red-bike-wide.png"),
      timestamp: nowIso(-1000),
    },
    {
      id: `${sessionId}-assistant-3`,
      role: "assistant",
      content: TOOL_REPLY,
      timestamp: nowIso(-500),
    },
  ];
}

class FakeGatewaySocket extends EventTarget {
  static OPEN = 1;
  constructor(url) {
    super();
    this.url = url;
    this.readyState = 0;
    setTimeout(() => {
      this.readyState = 1;
      this.dispatchEvent(new Event("open"));
      this.#emit({ type: "gateway.ready" });
    }, 30);
  }
  #frame(frame) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
  }
  #emit(event) {
    this.#frame({ method: "event", params: event });
  }
  send(raw) {
    const { id, method, params } = JSON.parse(raw);
    const respond = (result) => setTimeout(() => this.#frame({ id, result }), 40);
    switch (method) {
      case "session.resume":
        return respond({ session_id: "runtime-session-1" });
      case "session.create": {
        const storedSessionId = `session-${createdSessions.size + 2}`;
        const runtimeSessionId = `runtime-${storedSessionId}`;
        createdSessions.set(storedSessionId, {
          id: storedSessionId,
          title: params?.title ?? "New chat",
          preview: params?.title ?? "New chat",
          model: params?.model ?? "kimi-k2-6",
          last_active: nowIso(),
        });
        return respond({ session_id: runtimeSessionId, stored_session_id: storedSessionId });
      }
      case "session.active_list":
        return respond({ sessions: [] });
      case "image.attach_bytes":
        console.log("[preview] image.attach_bytes", params?.filename, params?.session_id);
        return respond({});
      case "prompt.submit": {
        respond({});
        const sessionId = params?.session_id ?? "runtime-session-1";
        const messageId = `m-${Date.now()}`;
        let delay = 900;
        setTimeout(
          () => this.#emit({ type: "message.start", session_id: sessionId, payload: { message_id: messageId, role: "assistant" } }),
          delay,
        );
        const words = VISION_REPLY.split(" ");
        for (let i = 0; i < words.length; i += 3) {
          delay += 130;
          const chunk = `${words.slice(i, i + 3).join(" ")} `;
          setTimeout(
            () => this.#emit({ type: "message.delta", session_id: sessionId, payload: { message_id: messageId, delta: chunk } }),
            delay,
          );
        }
        setTimeout(
          () => this.#emit({ type: "message.complete", session_id: sessionId, payload: { message_id: messageId, text: VISION_REPLY } }),
          delay + 300,
        );
        return;
      }
      default:
        console.log("[preview] gateway request:", method, JSON.stringify(params ?? {}).slice(0, 160));
        return respond({});
    }
  }
  close() {
    this.readyState = 3;
  }
  // HermesGatewayClient uses addEventListener only; EventTarget covers it.
}
window.WebSocket = FakeGatewaySocket;

await import("/preview/agent.jsx");
