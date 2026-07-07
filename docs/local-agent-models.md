# Local agent models

June can route Hermes agent chat through a user-supplied OpenAI-compatible
endpoint. This is useful for local models served by tools such as vLLM, as long
as the server supports the Chat Completions API shape Hermes uses:

- `POST /v1/chat/completions`
- OpenAI-style `tools` requests
- OpenAI-style `tool_calls` responses
- Optional `stream: true` server-sent events

The local endpoint is only used after the user opts in from Settings. June still
runs its built-in MCP servers through the June loopback proxy, so note search,
web tools, image tools, and other Hermes tools continue to register separately
from the local model endpoint.

## GLM-4.5-Air with vLLM

For GLM-4.5-Air, prefer vLLM because it has a GLM-4.5 tool parser. Start the
server with automatic tool choice enabled:

```bash
vllm serve zai-org/GLM-4.5-Air \
  --host 127.0.0.1 \
  --port 8000 \
  --enable-auto-tool-choice \
  --tool-call-parser glm45
```

If the server requires a bearer token, also pass vLLM's API key option and enter
the same key in June's local model settings.

## June settings

Open Settings > Models > More options > Local model and enter:

- Endpoint: `http://127.0.0.1:8000/v1`
- Model ID: `zai-org/GLM-4.5-Air`
- API key: blank, unless the local server requires one

Use Test connection to read `/v1/models`, save the settings, then enable the
local model. A loopback endpoint enables in one step. A non-loopback endpoint
requires an extra confirmation because prompts leave this machine.

For a running agent session, switch models from the composer model picker after
enabling the local model. New sessions use the active Settings selection.

## Live verification

The local proxy has ignored tests for live endpoints. With the vLLM server above
running:

```bash
JUNE_QA_LOCAL_BASE_URL=http://127.0.0.1:8000/v1 \
JUNE_QA_LOCAL_MODEL=zai-org/GLM-4.5-Air \
cargo test --manifest-path src-tauri/Cargo.toml --locked \
  live_local_agent_proxy_returns_tool_calls -- --ignored --nocapture
```

If the local endpoint uses a bearer token, add:

```bash
JUNE_QA_LOCAL_API_KEY=<token>
```

The test sends an OpenAI-style tool schema through June's agent proxy and
expects the model response to contain a `tool_calls` entry. This verifies the
piece June needs for Hermes tools to execute.
