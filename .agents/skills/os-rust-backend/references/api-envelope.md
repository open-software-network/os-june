# API response envelope

Every HTTP endpoint in an Open Software backend returns the same envelope. This
is the contract between server and consumer — apps, the portal BFF, and other
backends all parse it once and branch the same way.

## The type

Defined in `*-api/src/lib.rs`, derived once, used everywhere:

```rust
use serde::Serialize;
use utoipa::ToSchema;

#[derive(Serialize, ToSchema)]
pub struct ApiResponse<T: ToSchema> {
    pub data: Option<T>,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl<T: ToSchema> ApiResponse<T> {
    pub fn ok(data: T) -> Self {
        Self { data: Some(data), success: true, error_code: None, message: None }
    }

    pub fn err(code: i32, message: impl Into<String>) -> ApiResponse<()> {
        ApiResponse { data: None, success: false, error_code: Some(code), message: Some(message.into()) }
    }
}
```

## On the wire

### Success

```json
{ "data": { "id": "usr_abc", "handle": "alex" }, "success": true }
```

### Success with a list

```json
{ "data": [{ "id": "usr_abc" }, { "id": "usr_def" }], "success": true }
```

Lists go *inside* `data`, never at the top level — that's the whole point of
the envelope.

### Error

```json
{ "data": null, "success": false, "error_code": 1001, "message": "user not found" }
```

`message` is required on error, optional on success. `error_code` is **always**
present on error.

## Error code bands

Application-level codes (not HTTP status). Each band maps to one HTTP status,
which the envelope sets when the handler returns the error. Keep them as
constants in `*-api/src/lib.rs`:

```rust
pub const ERR_NOT_FOUND: i32 = 1001;          // 404
pub const ERR_BAD_REQUEST: i32 = 2001;        // 400
pub const ERR_FORBIDDEN: i32 = 3001;          // 403
pub const ERR_CONFLICT: i32 = 4001;           // 409
pub const ERR_GONE: i32 = 4101;               // 410
pub const ERR_UNPROCESSABLE: i32 = 4201;      // 422
pub const ERR_INSUFFICIENT_CREDITS: i32 = 4301;  // 402
pub const ERR_RATE_LIMITED: i32 = 4401;       // 429
pub const ERR_INTERNAL: i32 = 5000;           // 500
pub const ERR_NOT_IMPLEMENTED: i32 = 9001;    // 501
```

| Band | HTTP | Use for |
|---|---|---|
| 1001–1999 | 404 | "not found": user, app, grant, resource. |
| 2001–2999 | 400 | Generic bad input the schema can't catch. |
| 3001–3999 | 403 | Auth fails: invalid token, missing scope, wrong app. |
| 4001–4099 | 409 | Idempotency-key collisions, double-spend, grant-already-used. |
| 4101–4199 | 410 | Resource is gone: grant expired, link revoked. |
| 4201–4299 | 422 | Schema valid, semantically invalid: cap exceeded, ttl out of range. |
| 4301–4399 | 402 | **Billing.** Insufficient credits sits here. Reserved for "needs money". |
| 4401–4499 | 429 | Rate limited. |
| 5000–5099 | 500 | Server failure: DB down, provider 500. |
| 9001–9999 | 501 | Not implemented (a route registered but not coded yet). |

Why bands instead of one code per error: with bands, **consumers can branch on
the band alone for common cases** (`code >= 4301 && code < 4400` → show top-up
UI) while still pinning specific codes (`4301` exactly → insufficient credits
*for this charge*). Document the specific codes per endpoint in the utoipa
annotation.

## Returning the envelope from a handler

```rust
use axum::{Json, http::StatusCode, response::IntoResponse};

#[utoipa::path(
    get, path = "/me",
    responses(
        (status = 200, body = ApiResponse<UserSummary>),
        (status = 403, body = ApiResponse<()>, description = "missing or invalid token"),
    )
)]
pub async fn me(
    State(state): State<ApiState>,
    auth: AuthenticatedUser,
) -> Result<Json<ApiResponse<UserSummary>>, ApiError> {
    let user = state.users.find_by_id(auth.user_id).await?
        .ok_or(ApiError::NotFound { code: ERR_NOT_FOUND, message: "user not found" })?;
    Ok(Json(ApiResponse::ok(UserSummary::from(user))))
}
```

## The handler error type

Don't `unwrap` in handlers and don't return `anyhow::Error` — define an
`ApiError` enum that knows how to render itself as `ApiResponse + StatusCode`.
This is where the band → HTTP status mapping lives:

```rust
use axum::{Json, http::StatusCode, response::{IntoResponse, Response}};

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("{message}")]
    NotFound { code: i32, message: &'static str },

    #[error("{message}")]
    BadRequest { code: i32, message: String },

    #[error("{message}")]
    Forbidden { code: i32, message: &'static str },

    #[error("insufficient credits")]
    InsufficientCredits { available: i64, requested: i64 },

    #[error(transparent)]
    Persistence(#[from] PersistenceError),

    #[error(transparent)]
    Service(#[from] ServiceError),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, code, message) = match &self {
            ApiError::NotFound { code, message } => (StatusCode::NOT_FOUND, *code, (*message).to_string()),
            ApiError::BadRequest { code, message } => (StatusCode::BAD_REQUEST, *code, message.clone()),
            ApiError::Forbidden { code, message } => (StatusCode::FORBIDDEN, *code, (*message).to_string()),
            ApiError::InsufficientCredits { .. } => (StatusCode::PAYMENT_REQUIRED, ERR_INSUFFICIENT_CREDITS, "insufficient credits".to_string()),
            ApiError::Persistence(err) => {
                tracing::error!(%err, "persistence error");
                (StatusCode::INTERNAL_SERVER_ERROR, ERR_INTERNAL, "internal error".to_string())
            }
            ApiError::Service(err) => {
                tracing::error!(%err, "service error");
                (StatusCode::INTERNAL_SERVER_ERROR, ERR_INTERNAL, "internal error".to_string())
            }
        };

        let body: ApiResponse<()> = ApiResponse {
            data: None,
            success: false,
            error_code: Some(code),
            message: Some(message),
        };
        (status, Json(body)).into_response()
    }
}
```

Two rules baked into the design:

1. **Internal errors are logged with full detail and rendered as a generic
   `5000`.** Never leak SQL state, provider message bodies, or panic strings to
   clients — that's how secrets and schemas escape.
2. **Domain errors map to specific bands.** `InsufficientCredits` is its own
   variant (not a `Forbidden`) because it has its own band and clients need to
   distinguish "no money" from "wrong scope".

## What goes in `data`?

- A single object: `{ id: "usr_abc", handle: "alex" }`.
- A list: `[ { ... }, { ... } ]`.
- An empty list when there are no items: `[]`. **Not** `null`.
- For mutating endpoints with no useful payload: `{ ok: true }` or the affected
  resource. **Not** `null` — that signals an error.
- Never a primitive at top level: not `42`, not `"some string"`, not `true`.
  Wrap it: `{ count: 42 }`. Otherwise the consumer can't add fields later
  without breaking the contract.

## OpenAPI generation

Both repos derive OpenAPI from utoipa and commit `openapi.json` so the frontend
generates types from it. The contract job in CI compares the committed file to
a fresh export and fails on drift.

```rust
use utoipa::OpenApi;

#[derive(OpenApi)]
#[openapi(
    paths(me, login, top_up, /* … */),
    components(schemas(
        ApiResponse::<UserSummary>, ApiResponse::<BalanceSummary>, /* … */,
        UserSummary, BalanceSummary,
    )),
    tags(
        (name = "identity", description = "Login, refresh, /me"),
        (name = "billing", description = "Authorize, charge, balance"),
    ),
)]
pub struct ApiDoc;
```

Then a binary in `crates/api/src/bin/export-openapi.rs` (or a `make` target)
writes `ApiDoc::openapi().to_pretty_json()` to `api/openapi.json`. The CI job
is `make contract-check`.

## Common envelope mistakes

- **Returning `Json(my_thing)` directly.** Always wrap: `Json(ApiResponse::ok(my_thing))`.
- **Using HTTP status alone instead of the envelope.** Some legacy callers will
  do `if (response.status === 200) { ... }`. New clients should branch on
  `success`/`error_code`. Both signals must be consistent — a 200 with
  `success: false` is a bug.
- **Sending the band's HTTP status but the wrong code.** If you return a 404,
  the `error_code` must be in `1001–1999`. Mismatches confuse consumers.
- **Defining ad-hoc error codes per endpoint.** Use the constants. New codes
  go in `*-api/src/lib.rs` next to the existing ones, in the right band.
- **Empty `message` on error.** Always include a human-readable message — even
  if it's just `"forbidden"`. Debuggers will thank you.
- **Leaking provider error bodies into `message`.** Sanitize. Log the upstream
  body; return a curated message.
