# Tauri desktop app integration

Use this for a **Tauri (v2) desktop app** — a Rust core + webview frontend. A
desktop app is a **public client**: the binary ships to users, so it can hold no
shared secret and there is no server origin, no httpOnly cookie, and no BFF. That
changes three things versus the web flow:

1. **Login can't use a web redirect to your own server.** Capture the
   authorization-code redirect with a **deep link** (custom scheme) or a
   **loopback** `http://127.0.0.1:<port>` listener, then exchange the code from
   the Rust core. **PKCE is mandatory** (no client secret protects the exchange).
2. **Tokens live in the OS keychain**, owned by the Rust core — never in the
   webview's `localStorage`/`sessionStorage` (XSS-readable) or a plaintext file.
   The webview gets *data* (handle, balance) via Tauri commands, never the token.
3. **The App API key must NOT be embedded in the binary.** It can charge *any*
   user and is trivially extracted from a distributed app. So **metering
   (`authorize`/`charge`) is brokered by your backend**, not the desktop app —
   see "Metering from a desktop app" below.

So the desktop app does **identity + self-service** on-device with the user's own
token (sign in, read `/me` + `/billing/balance`, and — since it's the user acting
on their own account — profile and own billing-config writes). The hard line is
the **App API key**, not read-vs-write: anything requiring it (**app-attributed
spend** — `authorize`/`charge`) goes through a backend you control. The pattern
below deliberately keeps even Top-up off-device by opening the system browser, so
the on-device surface stays identity + reads. It can still **capture the User's
`credits:spend` Consent at login** (ADR-0010) so your backend Broker can meter —
capturing consent is not spending, and the binary never holds the App API key.

## Plugins & crates

```toml
# src-tauri/Cargo.toml
[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-deep-link = "2"   # capture custom-scheme redirect (recommended)
tauri-plugin-opener = "2"      # open the system browser for login + top-up
# optional on Windows/Linux if you need one running instance to receive deep links:
# tauri-plugin-single-instance = { version = "2", features = ["deep-link"] }
keyring = "3"                  # OS keychain (Keychain / Credential Manager / libsecret)
# token exchange + verification from the core:
reqwest = { version = "0.12", features = ["json"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
sha2 = "0.10"
base64 = "0.22"
rand = "0.8"
url = "2"
urlencoding = "2"
```

```jsonc
// src-tauri/tauri.conf.json — register your callback scheme.
// This static config is required on macOS. Runtime registration is not supported there.
{
  "plugins": {
    "deep-link": { "desktop": { "schemes": ["yourapp"] } }
  }
}
```

Create the App and OAuth client in the OS Accounts Admin console. Allowlist the
matching OAuth client `redirect_uri`: `yourapp://auth/callback` (deep link)
**or** `http://127.0.0.1:<port>/callback` (loopback). Loopback is the most
compatible (it's a normal http redirect the existing `/auth` flow already
handles); deep link is the cleaner UX. The example below uses the deep link and
requires an `OS_ACCOUNTS_CLIENT_ID` (`ocl_...`). On macOS, custom schemes must be registered through
Tauri deep-link configuration and tested from a bundled app; do not rely on
`register("yourapp")` or `register_all()` at runtime. On Windows/Linux
development builds, runtime registration can be used so the OS knows which binary
handles the URL. See the official [Tauri deep-linking plugin
docs](https://v2.tauri.app/plugin/deep-linking/).
For Windows/Linux production behavior, also account for Tauri's platform behavior:
the OS may start a new app instance with the URL, so use the single-instance
plugin with deep-link support or parse the launch argv.

## Staging/prod URLs

OS Accounts URLs are not secrets. Load them from build-time config or a bundled
non-secret config file so the same module can target local, staging, and prod:

| Environment | `OS_ACCOUNTS_URL` | `OS_ACCOUNTS_API_URL` |
|---|---|---|
| Local | `http://localhost:3000` | `http://localhost:4000` |
| Staging | `https://os-accounts-portal-staging.up.railway.app` | `https://os-accounts-api-staging.up.railway.app` |
| Prod | `https://accounts.opensoftware.co` | `https://accounts-api.opensoftware.co` |

Do not load `OS_ACCOUNTS_APP_API_KEY` in Tauri. That secret belongs only in your
backend broker.

## Login (PKCE + deep link), entirely in the Rust core

`src-tauri/src/os_accounts.rs`:

```rust
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use sha2::{Digest, Sha256};
use tauri_plugin_opener::OpenerExt;

const DEFAULT_ACCOUNTS_URL: &str = "https://accounts.opensoftware.co";
const DEFAULT_API_URL: &str = "https://accounts-api.opensoftware.co";
const REDIRECT_URI: &str = "yourapp://auth/callback";
const CLIENT_ID: &str = env!("OS_ACCOUNTS_CLIENT_ID");
const KEYCHAIN_SERVICE: &str = "com.yourapp.os-accounts";

#[derive(Clone)]
struct OsAccountsConfig {
    accounts_url: String,
    api_url: String,
}

fn os_accounts_config() -> OsAccountsConfig {
    OsAccountsConfig {
        accounts_url: option_env!("OS_ACCOUNTS_URL")
            .unwrap_or(DEFAULT_ACCOUNTS_URL)
            .trim_end_matches('/')
            .to_owned(),
        api_url: option_env!("OS_ACCOUNTS_API_URL")
            .unwrap_or(DEFAULT_API_URL)
            .trim_end_matches('/')
            .to_owned(),
    }
}

#[derive(Clone, Debug)]
pub struct Pending {
    verifier: String,
    csrf: String,
}

pub struct LoginFlow(pub Mutex<Option<Pending>>);

#[derive(Serialize, Deserialize)]
struct TokenPair { access_token: String, refresh_token: String }

#[derive(Deserialize)]
struct Envelope<T> {
    data: Option<T>,
    success: bool,
    error_code: Option<i64>,
    message: Option<String>,
}

fn b64url(bytes: &[u8]) -> String { URL_SAFE_NO_PAD.encode(bytes) }

fn pkce() -> (String, String) {
    let mut buf = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut buf);
    let verifier = b64url(&buf);
    let challenge = b64url(&Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

/// Step 1: open the system browser at the OS Accounts login page.
/// Stash `verifier` + `state` in app state to use when the redirect returns.
#[tauri::command]
pub fn begin_login(app: tauri::AppHandle, state: tauri::State<LoginFlow>) -> Result<(), String> {
    let (verifier, challenge) = pkce();
    let mut csrf = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut csrf);
    let csrf = b64url(&csrf);
    *state.0.lock().unwrap() = Some(Pending { verifier, csrf: csrf.clone() });

    let config = os_accounts_config();
    let url = format!(
        "{}/login?client_id={}&redirect_uri={}&scope={}&state={csrf}&code_challenge={challenge}&code_challenge_method=S256",
        config.accounts_url,
        urlencoding::encode(CLIENT_ID),
        urlencoding::encode(REDIRECT_URI),
        // Request `credits:spend` HERE if your App meters usage. A public client
        // MAY capture this consent (ADR-0010); it can never *spend* with it (it
        // holds no App API key). This is the consent your backend Broker relies
        // on at /authorize — omit it and metering fails with
        // `missing_spend_consent`. Drop it for identity-only apps.
        urlencoding::encode("profile:read profile:write billing:read credits:spend"),
    );
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string()) // system browser
}

/// Step 2: the deep-link handler receives yourapp://auth/callback?code=&state=
/// Verify state, exchange the code (with the PKCE verifier), store the pair.
pub async fn complete_login(pending: Pending, code: &str, state: &str) -> Result<(), String> {
    if state != pending.csrf { return Err("state mismatch".into()); }
    let config = os_accounts_config();
    let client = reqwest::Client::new();
    let resp: Envelope<TokenPair> = client
        .post(format!("{}/auth/token", config.api_url))
        .json(&serde_json::json!({
            "grant_type": "authorization_code",
            "code": code,
            "code_verifier": pending.verifier,
            "redirect_uri": REDIRECT_URI,
        }))
        .send().await.map_err(|e| e.to_string())?
        .json().await.map_err(|e| e.to_string())?;
    let pair = resp
        .data
        .filter(|_| resp.success)
        .ok_or_else(|| resp.message.unwrap_or_else(|| "token exchange failed".to_owned()))?;
    store_tokens(&pair)   // OS keychain, not a file
}

// --- token storage: OS keychain via `keyring` ---
fn store_tokens(pair: &TokenPair) -> Result<(), String> {
    let json = serde_json::to_string(pair).map_err(|e| e.to_string())?;
    keyring::Entry::new(KEYCHAIN_SERVICE, "tokens")
        .and_then(|e| e.set_password(&json))
        .map_err(|e| e.to_string())
}
fn load_tokens() -> Option<TokenPair> {
    let raw = keyring::Entry::new(KEYCHAIN_SERVICE, "tokens").ok()?.get_password().ok()?;
    serde_json::from_str(&raw).ok()
}
```

Wire the deep link in `run()`:

```rust
use tauri::{Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;
use url::Url;

fn handle_login_deep_link(handle: tauri::AppHandle, url: &Url) {
    if url.scheme() != "yourapp" || url.host_str() != Some("auth") || url.path() != "/callback" {
        return;
    }

    let code = url
        .query_pairs()
        .find_map(|(key, value)| (key == "code").then(|| value.into_owned()));
    let returned_state = url
        .query_pairs()
        .find_map(|(key, value)| (key == "state").then(|| value.into_owned()));

    let Some(code) = code else {
        let _ = handle.emit("os-accounts-login-error", "missing code");
        return;
    };
    let Some(returned_state) = returned_state else {
        let _ = handle.emit("os-accounts-login-error", "missing state");
        return;
    };

    let pending = handle.state::<LoginFlow>().0.lock().unwrap().take();
    let Some(pending) = pending else {
        let _ = handle.emit("os-accounts-login-error", "no pending login");
        return;
    };

    tauri::async_runtime::spawn(async move {
        match complete_login(pending, &code, &returned_state).await {
            Ok(()) => {
                let _ = handle.emit("os-accounts-login-complete", true);
            }
            Err(error) => {
                let _ = handle.emit("os-accounts-login-error", error);
            }
        }
    });
}

tauri::Builder::default()
    .plugin(tauri_plugin_deep_link::init())
    .plugin(tauri_plugin_opener::init())
    .manage(LoginFlow(Default::default()))
    .setup(|app| {
        // macOS deep links must be registered statically in tauri.conf.json.
        // Runtime registration is only for Windows/Linux development flows.
        #[cfg(any(target_os = "windows", target_os = "linux"))]
        app.deep_link().register("yourapp")?;
        let handle = app.handle().clone();
        app.deep_link().on_open_url(move |event| {
            for url in event.urls() {
                handle_login_deep_link(handle.clone(), url);
            }
        });
        Ok(())
    })
    .invoke_handler(tauri::generate_handler![begin_login, who_am_i, get_balance, logout, top_up])
    .run(tauri::generate_context!())
    .expect("run tauri app");
```

> The frontend can also listen with the JS plugin —
> `import { onOpenUrl } from '@tauri-apps/plugin-deep-link'` — but keep the *code
> exchange and token storage in Rust* so the access token never enters the webview.

## Reading the user & balance (commands the webview calls)

Authenticate these calls with the **user's own** access token from the keychain.
On `error_code 3001` (expired), refresh once via `/auth/refresh` (rotating — store
the new pair), then retry.

The Avatar is network-wide profile state (ADR-0034 through ADR-0036). Render a
supported `v1:<payload>` seed with the Open Software Avatar v1 renderer. Without
one — including when a future unsupported version is stored — derive the
presentation-only seed `v1:default:<User.id>`. The seed fixes cloud geometry;
use a neutral gray palette by default or supply the App's semantic accent and
bright-accent colors. A theme change never writes profile state. Never replace
an unknown version or write a new seed during login/startup — `PATCH /me` is
reserved for an explicit User choice.

```rust
#[derive(Serialize, Deserialize)]
pub struct Me {
    pub id: String,
    pub handle: String,
    pub avatar_url: Option<String>,
    pub avatar_seed: Option<String>,
}

#[tauri::command]
pub async fn who_am_i() -> Result<Me, String> {
    authed_get::<Me>("/me").await
}

#[derive(Serialize, Deserialize)]
pub struct Balance { pub credits: i64, pub usd_millis: i64 }

#[tauri::command]
pub async fn get_balance() -> Result<Balance, String> {
    authed_get::<Balance>("/billing/balance").await   // USD = usd_millis / 1000
}

async fn authed_get<T: for<'de> Deserialize<'de>>(path: &str) -> Result<T, String> {
    let mut pair = load_tokens().ok_or("signed out")?;
    let config = os_accounts_config();
    let client = reqwest::Client::new();
    for attempt in 0..2 {
        let resp: Envelope<T> = client
            .get(format!("{}{}", config.api_url, path))
            .bearer_auth(&pair.access_token)
            .send().await.map_err(|e| e.to_string())?
            .json().await.map_err(|e| e.to_string())?;
        if resp.success { return resp.data.ok_or("empty body".into()); }
        if resp.error_code == Some(3001) && attempt == 0 {
            pair = refresh(&pair.refresh_token).await?;   // rotate + persist
            continue;
        }
        return Err("request failed".into());
    }
    Err("unauthorized".into())
}

async fn refresh(refresh_token: &str) -> Result<TokenPair, String> {
    let config = os_accounts_config();
    let resp: Envelope<TokenPair> = reqwest::Client::new()
        .post(format!("{}/auth/refresh", config.api_url))
        .json(&serde_json::json!({ "refresh_token": refresh_token }))
        .send().await.map_err(|e| e.to_string())?
        .json().await.map_err(|e| e.to_string())?;
    let pair = resp
        .data
        .filter(|_| resp.success)
        .ok_or_else(|| resp.message.unwrap_or_else(|| "refresh failed".to_owned()))?;
    store_tokens(&pair)?;
    Ok(pair)
}
```

`logout` deletes the keychain entry (and optionally `POST /auth/logout`). The
webview only ever sees `Me`/`Balance` — never a token.

## Metering from a desktop app — broker through YOUR backend

**Do not put the App API key (`osk_…`) in the desktop binary.** A shared key that
can charge any user, shipped to every user's machine, is extractable and
catastrophic if leaked. Instead:

```
desktop app ──(user access token)──▶  YOUR backend  ──(App API key, osk_)──▶  /authorize + /charge
   (public client, no osk_)        (confidential: holds osk_,        (server-to-server)
                                     verifies the user token)
```

Your backend is the **Broker** (a Confidential client): it verifies the incoming
user token (JWKS/ES256 — see [verifying-tokens.md](verifying-tokens.md)) to get the
`usr_` id, then runs the `authorize`→`charge` sequence with the App API key (see
[metering-and-billing.md](metering-and-billing.md)). The desktop app just calls
*your* endpoint with the user's token:

> **Consent prerequisite.** `/authorize` requires the User to have granted this
> App `credits:spend`. That consent is captured during *this app's* login —
> request `credits:spend` in `begin_login`'s `scope` (above). A public client
> capturing spend consent is allowed (ADR-0010) and inert on its own: the consent
> only becomes spend when your Broker presents the App API key. Omit the scope and
> the Broker's first `/authorize` returns `missing_spend_consent`.

```rust
#[tauri::command]
pub async fn run_paid_action(payload: serde_json::Value) -> Result<serde_json::Value, String> {
    let pair = load_tokens().ok_or("signed out")?;
    reqwest::Client::new()
        .post("https://api.yourapp.com/paid-action")  // YOUR backend, not OS Accounts
        .bearer_auth(&pair.access_token)              // the user's token; your backend verifies it
        .json(&payload)
        .send().await.map_err(|e| e.to_string())?
        .json().await.map_err(|e| e.to_string())
}
```

If your app has **no backend at all**, it can't meter safely — credits-gated
features require a server that holds the App API key. (A user-facing app with only
free features can still do identity-only on-device.)

## Top-up — open the system browser

Same rule as everywhere: you never build checkout. Open OS Accounts in the
system browser; the balance reflects the top-up on the next `get_balance` once the
webhook settles.

```rust
#[tauri::command]
pub fn top_up(app: tauri::AppHandle) -> Result<(), String> {
    let config = os_accounts_config();
    app.opener().open_url(config.accounts_url, None::<&str>).map_err(|e| e.to_string())
}
```

## Verify it works

- Sign in → the system browser opens OS Accounts; after login the deep link returns and the app shows the handle. The access token is in the OS keychain, **not** in the webview (check devtools `localStorage` is empty of tokens).
- `who_am_i` returns the `usr_` id + handle; `get_balance` shows credits + USD from `usd_millis/1000`.
- A paid action succeeds **only** through your backend; grep the desktop binary/bundle for `osk_` — there must be **zero** matches.
- Kill the app mid-session and relaunch → still signed in (keychain persists); an expired access token refreshes transparently.
