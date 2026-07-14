//! Private sharing endpoints (JUN-308). Owner CRUD plus the recipient view.
//! Every payload field here is ciphertext or ACL metadata; nothing in this
//! module (or below it) can decrypt share content, and no handler logs
//! payload bytes. Non-enumeration: unknown, deleted, revoked, not-owned, and
//! uninvited all surface as the same `share_not_found` 404.

use crate::{
    auth::{authenticated_user, bearer_token},
    envelope::ApiResponse,
    error::ApiError,
    state::ApiState,
};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::HeaderMap,
};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use june_domain::{ShareKind, UserId};
use june_services::{CreateShareInput, InviteInput, ShareService};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InviteWire {
    email: String,
    envelope_b64: String,
    envelope_iv_b64: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateShareRequest {
    kind: String,
    ciphertext_b64: String,
    iv_b64: String,
    invites: Vec<InviteWire>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreatedInviteWire {
    invite_id: String,
    email: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateShareResponse {
    share_id: String,
    invites: Vec<CreatedInviteWire>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ShareSummaryWire {
    share_id: String,
    kind: String,
    /// RFC 3339.
    created_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ShareInviteWire {
    invite_id: String,
    email: String,
    /// `pending` | `accepted` | `revoked`.
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_access_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ShareDetailResponse {
    share_id: String,
    kind: String,
    created_at: String,
    invites: Vec<ShareInviteWire>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AddInvitesRequest {
    invites: Vec<InviteWire>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AddInvitesResponse {
    invites: Vec<CreatedInviteWire>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ShareViewResponse {
    kind: String,
    ciphertext_b64: String,
    iv_b64: String,
    /// Absent when the viewer is the owner (they hold the content key).
    #[serde(skip_serializing_if = "Option::is_none")]
    envelope_b64: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    envelope_iv_b64: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeletedResponse {
    deleted: bool,
}

pub(crate) async fn create(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(request): Json<CreateShareRequest>,
) -> Result<Json<ApiResponse<CreateShareResponse>>, ApiError> {
    let (service, user) = share_context(&state, &headers).await?;
    let kind = parse_kind(&request.kind)?;
    let created = service
        .create(CreateShareInput {
            owner: user,
            kind,
            ciphertext: decode_b64("ciphertext_b64", &request.ciphertext_b64)?,
            iv: decode_b64("iv_b64", &request.iv_b64)?,
            invites: decode_invites(request.invites)?,
        })
        .await?;
    Ok(Json(ApiResponse::ok(CreateShareResponse {
        share_id: created.share_id,
        invites: created
            .invites
            .into_iter()
            .map(|invite| CreatedInviteWire {
                invite_id: invite.invite_id,
                email: invite.email,
            })
            .collect(),
    })))
}

pub(crate) async fn list(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<ApiResponse<Vec<ShareSummaryWire>>>, ApiError> {
    let (service, user) = share_context(&state, &headers).await?;
    let shares = service.list(&user).await?;
    Ok(Json(ApiResponse::ok(
        shares
            .into_iter()
            .map(|share| ShareSummaryWire {
                share_id: share.share_id,
                kind: share.kind.as_str().to_string(),
                created_at: share.created_at,
            })
            .collect(),
    )))
}

pub(crate) async fn detail(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(share_id): Path<String>,
) -> Result<Json<ApiResponse<ShareDetailResponse>>, ApiError> {
    let (service, user) = share_context(&state, &headers).await?;
    let (share, invites) = service.detail(&user, &share_id).await?;
    Ok(Json(ApiResponse::ok(ShareDetailResponse {
        share_id: share.share_id,
        kind: share.kind.as_str().to_string(),
        created_at: share.created_at,
        invites: invites
            .into_iter()
            .map(|invite| ShareInviteWire {
                state: if invite.revoked_at.is_some() {
                    "revoked"
                } else if invite.accepted_at.is_some() {
                    "accepted"
                } else {
                    "pending"
                },
                invite_id: invite.invite_id,
                email: invite.email,
                last_access_at: invite.last_access_at,
            })
            .collect(),
    })))
}

pub(crate) async fn add_invites(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(share_id): Path<String>,
    Json(request): Json<AddInvitesRequest>,
) -> Result<Json<ApiResponse<AddInvitesResponse>>, ApiError> {
    let (service, user) = share_context(&state, &headers).await?;
    let created = service
        .add_invites(&user, &share_id, decode_invites(request.invites)?)
        .await?;
    Ok(Json(ApiResponse::ok(AddInvitesResponse {
        invites: created
            .into_iter()
            .map(|invite| CreatedInviteWire {
                invite_id: invite.invite_id,
                email: invite.email,
            })
            .collect(),
    })))
}

pub(crate) async fn revoke_invite(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path((share_id, invite_id)): Path<(String, String)>,
) -> Result<Json<ApiResponse<DeletedResponse>>, ApiError> {
    let (service, user) = share_context(&state, &headers).await?;
    service.revoke_invite(&user, &share_id, &invite_id).await?;
    Ok(Json(ApiResponse::ok(DeletedResponse { deleted: true })))
}

pub(crate) async fn delete(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(share_id): Path<String>,
) -> Result<Json<ApiResponse<DeletedResponse>>, ApiError> {
    let (service, user) = share_context(&state, &headers).await?;
    service.delete(&user, &share_id).await?;
    Ok(Json(ApiResponse::ok(DeletedResponse { deleted: true })))
}

#[derive(Debug, Deserialize)]
pub(crate) struct ViewQuery {
    /// The invite id from the link fragment (`invite_id.IK`). Only the id
    /// reaches the server; the key material stays in the fragment. Optional so
    /// an owner opening `/view` without a fragment still works.
    invite: Option<String>,
}

pub(crate) async fn view(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(share_id): Path<String>,
    Query(query): Query<ViewQuery>,
) -> Result<Json<ApiResponse<ShareViewResponse>>, ApiError> {
    let (service, user) = share_context(&state, &headers).await?;
    let token = bearer_token(&headers)?.to_string();
    let record = service
        .view(&user, &token, &share_id, query.invite.as_deref())
        .await?;
    let (envelope_b64, envelope_iv_b64) = match record.envelope {
        Some((envelope, iv)) => (Some(BASE64.encode(envelope)), Some(BASE64.encode(iv))),
        None => (None, None),
    };
    Ok(Json(ApiResponse::ok(ShareViewResponse {
        kind: record.kind.as_str().to_string(),
        ciphertext_b64: BASE64.encode(record.ciphertext),
        iv_b64: BASE64.encode(record.iv),
        envelope_b64,
        envelope_iv_b64,
    })))
}

/// Shared preamble: sharing must be configured, the caller authenticated,
/// and inside the per-user rate budget.
async fn share_context<'a>(
    state: &'a ApiState,
    headers: &HeaderMap,
) -> Result<(&'a ShareService, UserId), ApiError> {
    let service = state.share().ok_or(ApiError::SharingUnavailable)?;
    let user = authenticated_user(state, headers).await?;
    if !state.share_rate().allow(&user.0) {
        return Err(ApiError::AuthorizationDenied);
    }
    Ok((service, user))
}

fn parse_kind(kind: &str) -> Result<ShareKind, ApiError> {
    ShareKind::parse(kind).ok_or_else(|| ApiError::bad_request("kind must be note or session"))
}

fn decode_b64(field: &str, value: &str) -> Result<Vec<u8>, ApiError> {
    BASE64
        .decode(value)
        .map_err(|_| ApiError::bad_request(format!("{field} is not valid base64")))
}

fn decode_invites(invites: Vec<InviteWire>) -> Result<Vec<InviteInput>, ApiError> {
    invites
        .into_iter()
        .map(|invite| {
            Ok(InviteInput {
                email: invite.email,
                envelope: decode_b64("envelope_b64", &invite.envelope_b64)?,
                envelope_iv: decode_b64("envelope_iv_b64", &invite.envelope_iv_b64)?,
            })
        })
        .collect()
}
