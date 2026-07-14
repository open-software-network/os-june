# Configuration reference

June has two independent env surfaces: the **desktop app / client** (repo-root
`.env`, copied from `.env.example`) and the **June API backend**
(`june-api/.env` + `june-api/config.toml`). The client env must never hold a
server secret — upstream provider keys and the OS Accounts App API key live only
in June API.

The fully-commented sources of truth are `.env.example`,
`june-api/.env.example`, and `june-api/config.toml`. This page summarizes them;
when they disagree, the files win.

## How June API config resolves (Figment)

`AppConfig::default()` ← `config.toml` (ships in the Docker image) ← env vars
`JUNE__SECTION__FIELD` (a double underscore separates sections; single
underscores in field names stay literal, so `APP_API_KEY` → `app_api_key`).
Secrets are env-only and redacted in logs. Pricing layers once more:
built-in fallback ← `config.toml` ← the **live Venice catalog at boot**.

## Desktop app / client (repo-root `.env`)

| Var | Purpose | Default |
|-----|---------|---------|
| `JUNE_API_URL` | June API base URL the app calls | `https://june-api.opensoftware.co` in code; `.env` (from `.env.example`) sets `http://127.0.0.1:8080` for local dev |
| `OS_JUNE_LOCAL_DEV` | Use a local bearer token instead of Login with Open Software | `1` (example) |
| `OS_JUNE_LOCAL_DEV_BEARER_TOKEN` / `_USER_ID` | The local-mode identity | `local-dev-token` / `usr_local_dev` |
| `OS_ACCOUNTS_URL` / `OS_ACCOUNTS_API_URL` | OS Accounts portal + API (optional in local mode) | unset |
| `OS_ACCOUNTS_CLIENT_ID` | OAuth client id (`ocl_...`) sent on `/login` | unset |
| `OS_ACCOUNTS_LOOPBACK_PORT` | Login redirect loopback port; must match the registered `http://127.0.0.1:<port>/callback` | `8765` |
| `OS_JUNE_DEV_PLAINTEXT_TOKEN_STORE` | Debug builds only: explicitly opt in to plaintext local OS Accounts, Google, or GitHub token fixtures instead of Keychain. User access and refresh tokens live in Keychain by default; release builds never use the override. Never share or commit the fixtures | `0` |
| `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` | Google Desktop OAuth credential for Gmail/Calendar connectors. Google requires both at token exchange; the second value is not confidential in an installed app and grants no user-data access by itself | unset |
| `GITHUB_APP_CLIENT_ID` | Public GitHub App client identifier used by device flow. It may be supplied at runtime or build time, with the runtime value winning. App ID `4296474` is fixture metadata, not a runtime input. June uses no GitHub client secret, private key, installation token, or webhook secret. User access and rotating refresh tokens live in Keychain, except for the explicit debug-only plaintext override. June API is not in the GitHub credential or repository-discovery path, so this desktop change needs no June API deploy | unset |
| `GITHUB_APP_SLUG` | Public GitHub App slug used to build the App installation-management URL. It may be supplied at runtime or build time, with the runtime value winning | unset |
| `VENICE_TRANSCRIPTION_MODEL` / `OPENAI_TRANSCRIPTION_MODEL` | Initial transcription model (Settings can override) | see `.env.example` |
| `VENICE_GENERATION_MODEL` | Initial note-generation model | `zai-org-glm-5-2` |
| `VENICE_TITLE_SUGGESTION_MODEL` | Fast model for note-title suggestions | fallback to cleanup model |
| `OS_NOTETAKER_TRANSCRIPTION_LANGUAGE` | Optional ISO-639-1 language hint | unset |

Dev-only toggles also read in code: `OS_JUNE_ENABLE_DEV_SINGLE_INSTANCE`,
`OS_JUNE_USE_PROD_ACCOUNTS_TOKENS`, `OS_JUNE_USE_PROD_DATA_DIR`,
`JUNE_HERMES_DISABLE_SANDBOX`.

## June API backend (`june-api/.env`, `JUNE__…`)

**Secrets — env only, never in `config.toml` or the client `.env`:**

| Var | Purpose |
|-----|---------|
| `JUNE__UPSTREAMS__VENICE__API_KEY` | Venice key (default text / dictation / private transcription) |
| `JUNE__UPSTREAMS__OPENAI__API_KEY` | OpenAI key (optional; OpenAI ASR only) |
| `JUNE__OS_ACCOUNTS__APP_API_KEY` | The `osk_` App API key June API uses to authorize/charge |
| `JUNE__ISSUE_REPORTS__OS_PLATFORM_API_KEY` | Bot key to file issue reports as os-platform Issues (else log-only) |

Non-secret (usually left to `config.toml`): `JUNE__SERVER__HOST` / `PORT`,
`JUNE__OS_ACCOUNTS__API_URL`, `JUNE__LOCAL_DEV__ENABLED` / `BEARER_TOKEN` /
`USER_ID`, `JUNE__UPSTREAMS__*__BASE_URL`.

## Backend knobs (`june-api/config.toml`)

- **Server:** `request_timeout_secs` 600, `max_audio_bytes` 25 MiB, `max_json_bytes` 512 KiB, `max_issue_report_bytes` 301 MiB total (one 300 MiB os-platform attachment plus multipart overhead), `max_image_edit_bytes` sized for a 50 MiB source image after base64 expansion.
- **Metering estimate:** `flat_estimate_credits` 250 — the flat credit Hold per metered action; skips per-request estimation.
- **Hold TTLs (secs):** `note_transcribe` 60, `note_generate` 300, `dictate_transcribe` 30, `dictate_cleanup` 30, `web` 30, `image` defaults to `request_timeout_secs` + 30 (630) — validation rejects an image TTL that cannot outlive the request timeout, so a slow generation can still settle its charge.
- **Web tools:** `web_search_credits` 20, `web_fetch_credits` 20 (flat).
- **Preview cap:** `note_transcribe_preview_max_audio_secs` 30.
- **OS Accounts token contract:** `iss` `https://accounts.opensoftware.co`, `aud` `open-software-apps`, `jwks_refresh_secs` 300, `jwks_miss_min_backoff_secs` 5.
- **Pricing:** one `[pricing."<model_id>"]` table per priced model (unit, credits, provider, model_type, capabilities, ...). A model with no pricing entry is rejected at the boundary; the live Venice catalog extends this at boot (see [ADR-0007](adr/0007-model-capability-source-of-truth.md)).
- **Attestation / issue reports:** the TEE trust-center URL + the fixed os-platform destination (`open-software` / `june`).
