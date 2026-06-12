use crate::{
    auth::authenticated_user,
    envelope::ApiResponse,
    error::ApiError,
    remote::{AttachError, LinkHandle, PEER_HERE_CONTROLLER, PEER_HERE_HOST, Role},
    state::ApiState,
};
use axum::{
    Json,
    extract::{
        Path, Query, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, StatusCode, header},
    response::{Html, IntoResponse, Response},
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreatePairingResponse {
    pairing_id: String,
    code: String,
    expires_in_seconds: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClaimPairingResponse {
    pairing_id: String,
    controller_token: String,
}

/// Host (desktop, authenticated) mints a pairing. The `code` is shown to the
/// user to type on their phone; the desktop then opens the host WS with the
/// returned `pairingId` and its own OS Accounts bearer.
pub(crate) async fn create_pairing(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<ApiResponse<CreatePairingResponse>>, ApiError> {
    let user = authenticated_user(&state, &headers).await?;
    let (pairing_id, code) = state.remote().create_pairing(
        user,
        crate::remote::now_unix(),
        crate::remote::new_pairing_id(),
    );
    Ok(Json(ApiResponse::ok(CreatePairingResponse {
        pairing_id,
        code,
        expires_in_seconds: crate::remote::PAIRING_TTL_SECONDS,
    })))
}

/// Phone claims a pairing by code. Deliberately UNAUTHENTICATED: the code is
/// the capability (shown only on the trusted desktop, single-use, short TTL).
/// The phone gets a controller token scoped to that one pairing and never
/// signs in.
pub(crate) async fn claim_pairing(
    State(state): State<ApiState>,
    Path(code): Path<String>,
) -> Result<Json<ApiResponse<ClaimPairingResponse>>, ApiError> {
    let claim = state
        .remote()
        .claim_pairing(&code, crate::remote::now_unix())
        .ok_or_else(|| ApiError::not_found("pairing_not_found"))?;
    Ok(Json(ApiResponse::ok(ClaimPairingResponse {
        pairing_id: claim.pairing_id,
        controller_token: claim.controller_token,
    })))
}

#[derive(Deserialize)]
pub(crate) struct LinkQuery {
    #[serde(default)]
    pairing: String,
    role: String,
}

/// The relay socket. Both devices reach it outbound. The credential rides in
/// the `Sec-WebSocket-Protocol` header (browsers can set it; query strings
/// risk landing in logs): the host sends its OS Accounts bearer, the phone
/// sends its controller token.
pub(crate) async fn link(
    State(state): State<ApiState>,
    Query(query): Query<LinkQuery>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let Some(credential) = headers
        .get(header::SEC_WEBSOCKET_PROTOCOL)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return (StatusCode::UNAUTHORIZED, "missing credential").into_response();
    };
    let credential = credential.to_string();

    let (pairing, role, handle) = match query.role.as_str() {
        "host" => {
            let Ok(user) = state.token_verifier().verify(&credential).await else {
                return (StatusCode::UNAUTHORIZED, "invalid token").into_response();
            };
            match state.remote().attach_host(&query.pairing, &user) {
                Ok(handle) => (query.pairing.clone(), Role::Host, handle),
                Err(error) => return attach_error_response(&error),
            }
        }
        "controller" => match state.remote().attach_controller(&credential) {
            Ok((pairing, handle)) => (pairing, Role::Controller, handle),
            Err(error) => return attach_error_response(&error),
        },
        _ => return (StatusCode::BAD_REQUEST, "invalid role").into_response(),
    };

    // Echo the credential back as the negotiated subprotocol to complete the
    // browser handshake.
    ws.protocols([credential])
        .on_upgrade(move |socket| run_link(state, LinkContext { pairing, role }, handle, socket))
}

/// Identifies one side of a live link, bundled so `run_link` stays under the
/// argument-count lint.
struct LinkContext {
    pairing: String,
    role: Role,
}

fn attach_error_response(error: &AttachError) -> Response {
    match error {
        AttachError::UnknownPairing => (StatusCode::NOT_FOUND, "unknown pairing").into_response(),
        AttachError::RoleTaken => (StatusCode::CONFLICT, "role already connected").into_response(),
    }
}

async fn run_link(state: ApiState, ctx: LinkContext, mut handle: LinkHandle, socket: WebSocket) {
    let (mut sink, mut stream) = socket.split();

    // First frame: tell this side whether its peer is already attached, so the
    // phone shows "connected" the instant the desktop is online (and vice
    // versa) without waiting for traffic.
    if state.remote().peer_present(&ctx.pairing, ctx.role) {
        let hello = match ctx.role {
            Role::Host => PEER_HERE_CONTROLLER,
            Role::Controller => PEER_HERE_HOST,
        };
        let _ = sink.send(Message::Text(hello.to_string().into())).await;
    }

    loop {
        tokio::select! {
            outbound = handle.recv() => {
                match outbound {
                    Some(text) => {
                        if sink.send(Message::Text(text.into())).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                }
            }
            incoming = stream.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        // A false return means the peer isn't attached; keep
                        // the socket open so the phone can wait for the
                        // desktop to (re)connect rather than dropping.
                        let _ = handle.send_to_peer(text.to_string());
                    }
                    // Binary/ping/pong aren't part of the text-JSON relay; a
                    // Close or stream end means this side is gone.
                    Some(Ok(Message::Binary(_) | Message::Ping(_) | Message::Pong(_))) => {}
                    None | Some(Ok(Message::Close(_)) | Err(_)) => break,
                }
            }
        }
    }
    drop(handle); // fires the presence guard, notifying the peer
    state.remote().release_if_idle(&ctx.pairing);
}

/// The phone client: one self-contained page. The user types the code shown
/// on their desktop, the page claims it (no login) and opens the relay. Public
/// and unauthenticated like /verify and /s.
pub(crate) async fn mobile_page() -> Html<&'static str> {
    Html(MOBILE_PAGE)
}

const MOBILE_PAGE: &str = include_str!("remote_mobile.html");
