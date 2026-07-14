//! HTTP boundary tests for private sharing (JUN-308).
//!
//! The load-bearing assertions: the server round-trips ciphertext untouched
//! (no-plaintext guarantee at the boundary), and every unauthorized outcome
//! — unknown share, someone else's share, uninvited caller, revoked invite —
//! produces byte-identical `share_not_found` responses (non-enumeration).
#![allow(clippy::expect_used, clippy::unwrap_used)]

mod support;

use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode, header},
};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use june_api::ShareViewerInfo;
use june_domain::{
    DomainError, MAX_INVITES_PER_SHARE, NewShare, NewShareInvite, ShareInviteRecord, ShareKind,
    ShareRecord, ShareStore, ShareStoreError, ShareViewRecord, ViewRequest, ViewerIdentity,
};
use june_services::{ShareService, ShareServiceDeps};
use pretty_assertions::assert_eq;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tower::ServiceExt;

// ── In-memory store mirroring the Postgres semantics ──────────────────────

#[derive(Clone)]
struct StoredInvite {
    invite_id: String,
    email: String,
    envelope: Vec<u8>,
    envelope_iv: Vec<u8>,
    recipient_user_id: Option<String>,
    accepted: bool,
    revoked: bool,
}

#[derive(Clone)]
struct StoredShare {
    owner: String,
    kind: ShareKind,
    ciphertext: Vec<u8>,
    iv: Vec<u8>,
    invites: Vec<StoredInvite>,
    deleted: bool,
}

#[derive(Default)]
struct MemoryShareStore {
    shares: Mutex<HashMap<String, StoredShare>>,
}

#[async_trait::async_trait]
impl ShareStore for MemoryShareStore {
    async fn create_share(&self, share: NewShare) -> Result<(), ShareStoreError> {
        let mut shares = self.shares.lock().expect("lock");
        shares.insert(
            share.share_id,
            StoredShare {
                owner: share.owner_user_id.0,
                kind: share.kind,
                ciphertext: share.ciphertext,
                iv: share.iv,
                invites: share
                    .invites
                    .into_iter()
                    .map(|(invite_id, invite)| StoredInvite {
                        invite_id,
                        email: invite.email,
                        envelope: invite.envelope,
                        envelope_iv: invite.envelope_iv,
                        recipient_user_id: None,
                        accepted: false,
                        revoked: false,
                    })
                    .collect(),
                deleted: false,
            },
        );
        Ok(())
    }

    async fn list_shares(&self, owner: &str) -> Result<Vec<ShareRecord>, ShareStoreError> {
        let shares = self.shares.lock().expect("lock");
        Ok(shares
            .iter()
            .filter(|(_, share)| share.owner == owner && !share.deleted)
            .map(|(share_id, share)| ShareRecord {
                share_id: share_id.clone(),
                owner_user_id: share.owner.clone(),
                kind: share.kind,
                created_at: "2026-07-14T00:00:00Z".to_string(),
            })
            .collect())
    }

    async fn share_invites(
        &self,
        owner: &str,
        share_id: &str,
    ) -> Result<(ShareRecord, Vec<ShareInviteRecord>), ShareStoreError> {
        let shares = self.shares.lock().expect("lock");
        let share = shares
            .get(share_id)
            .filter(|share| share.owner == owner && !share.deleted)
            .ok_or(ShareStoreError::NotFound)?;
        Ok((
            ShareRecord {
                share_id: share_id.to_string(),
                owner_user_id: share.owner.clone(),
                kind: share.kind,
                created_at: "2026-07-14T00:00:00Z".to_string(),
            },
            share
                .invites
                .iter()
                .map(|invite| ShareInviteRecord {
                    invite_id: invite.invite_id.clone(),
                    email: invite.email.clone(),
                    recipient_user_id: invite.recipient_user_id.clone(),
                    accepted_at: invite.accepted.then(|| "2026-07-14T00:00:01Z".to_string()),
                    revoked_at: invite.revoked.then(|| "2026-07-14T00:00:02Z".to_string()),
                    last_access_at: invite.accepted.then(|| "2026-07-14T00:00:01Z".to_string()),
                })
                .collect(),
        ))
    }

    async fn add_invites(
        &self,
        owner: &str,
        share_id: &str,
        invites: Vec<(String, NewShareInvite)>,
    ) -> Result<(), ShareStoreError> {
        let mut shares = self.shares.lock().expect("lock");
        let share = shares
            .get_mut(share_id)
            .filter(|share| share.owner == owner && !share.deleted)
            .ok_or(ShareStoreError::NotFound)?;
        if share.invites.len() + invites.len() > MAX_INVITES_PER_SHARE {
            return Err(ShareStoreError::InviteLimitExceeded);
        }
        if invites.iter().any(|(_, invite)| {
            share
                .invites
                .iter()
                .any(|existing| !existing.revoked && existing.email == invite.email)
        }) {
            return Err(ShareStoreError::DuplicateActiveInvite);
        }
        for (invite_id, invite) in invites {
            share.invites.push(StoredInvite {
                invite_id,
                email: invite.email,
                envelope: invite.envelope,
                envelope_iv: invite.envelope_iv,
                recipient_user_id: None,
                accepted: false,
                revoked: false,
            });
        }
        Ok(())
    }

    async fn revoke_invite(
        &self,
        owner: &str,
        share_id: &str,
        invite_id: &str,
    ) -> Result<(), ShareStoreError> {
        let mut shares = self.shares.lock().expect("lock");
        let share = shares
            .get_mut(share_id)
            .filter(|share| share.owner == owner && !share.deleted)
            .ok_or(ShareStoreError::NotFound)?;
        let invite = share
            .invites
            .iter_mut()
            .find(|invite| invite.invite_id == invite_id)
            .ok_or(ShareStoreError::NotFound)?;
        invite.revoked = true;
        Ok(())
    }

    async fn delete_share(&self, owner: &str, share_id: &str) -> Result<(), ShareStoreError> {
        let mut shares = self.shares.lock().expect("lock");
        let share = shares
            .get_mut(share_id)
            .filter(|share| share.owner == owner)
            .ok_or(ShareStoreError::NotFound)?;
        share.deleted = true;
        share.ciphertext.clear();
        Ok(())
    }

    async fn fetch_view(
        &self,
        request: ViewRequest<'_>,
    ) -> Result<ShareViewRecord, ShareStoreError> {
        let ViewRequest {
            share_id,
            viewer_user_id,
            viewer_emails,
            invite_id,
        } = request;
        let mut shares = self.shares.lock().expect("lock");
        let share = shares
            .get_mut(share_id)
            .filter(|share| !share.deleted)
            .ok_or(ShareStoreError::NotFound)?;
        if share.owner == viewer_user_id {
            return Ok(ShareViewRecord {
                kind: share.kind,
                owner_user_id: share.owner.clone(),
                ciphertext: share.ciphertext.clone(),
                iv: share.iv.clone(),
                envelope: None,
            });
        }
        let kind = share.kind;
        let owner = share.owner.clone();
        let ciphertext = share.ciphertext.clone();
        let iv = share.iv.clone();
        let invite = share
            .invites
            .iter_mut()
            .find(|invite| {
                !invite.revoked
                    && invite_id.is_none_or(|id| invite.invite_id == id)
                    // The invited email must still be currently verified, even
                    // for an already-bound invite; among those, the invite must
                    // be unbound or bound to this caller.
                    && viewer_emails.contains(&invite.email)
                    && invite
                        .recipient_user_id
                        .as_deref()
                        .is_none_or(|bound| bound == viewer_user_id)
            })
            .ok_or(ShareStoreError::NotFound)?;
        invite.recipient_user_id = Some(viewer_user_id.to_string());
        invite.accepted = true;
        Ok(ShareViewRecord {
            kind,
            owner_user_id: owner,
            ciphertext,
            iv,
            envelope: Some((invite.envelope.clone(), invite.envelope_iv.clone())),
        })
    }
}

/// Emails come from the fake bearer token itself: `user:usr_x|a@b.c,d@e.f`.
struct TokenEmailsIdentity;

#[async_trait::async_trait]
impl ViewerIdentity for TokenEmailsIdentity {
    async fn verified_emails(&self, access_token: &str) -> Result<Vec<String>, DomainError> {
        Ok(access_token
            .split('|')
            .nth(1)
            .unwrap_or("")
            .split(',')
            .filter(|email| !email.is_empty())
            .map(str::to_string)
            .collect())
    }
}

fn share_router() -> Router {
    let service = Arc::new(ShareService::new(ShareServiceDeps {
        store: Arc::new(MemoryShareStore::default()),
        identity: Arc::new(TokenEmailsIdentity),
        max_ciphertext_bytes: 1024 * 1024,
    }));
    june_api::router(state_with_share(Some(service)))
}

fn state_with_share(share: Option<Arc<ShareService>>) -> june_api::ApiState {
    support::test_state_with_share(
        share,
        ShareViewerInfo {
            accounts_url: "https://accounts.example".to_string(),
            accounts_api_url: "https://accounts-api.example".to_string(),
            client_id: "client_viewer".to_string(),
        },
    )
}

async fn call(router: &Router, request: Request<Body>) -> (StatusCode, Value) {
    let response = router
        .clone()
        .oneshot(request)
        .await
        .expect("request completes");
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body reads");
    let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, body)
}

fn authed(request: axum::http::request::Builder, token: &str) -> axum::http::request::Builder {
    request.header(header::AUTHORIZATION, format!("Bearer {token}"))
}

fn create_request(token: &str, invites: &[Value]) -> Request<Body> {
    let body = json!({
        "kind": "note",
        "ciphertextB64": BASE64.encode(b"opaque-ciphertext"),
        "ivB64": BASE64.encode([7u8; 12]),
        "invites": invites,
    });
    authed(Request::builder().method("POST").uri("/v1/shares"), token)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .expect("request builds")
}

fn invite_wire(email: &str) -> Value {
    json!({
        "email": email,
        "envelopeB64": BASE64.encode([1u8; 48]),
        "envelopeIvB64": BASE64.encode([2u8; 12]),
    })
}

const OWNER: &str = "user:usr_owner|owner@example.com";
const RECIPIENT: &str = "user:usr_friend|friend@example.com";
const STRANGER: &str = "user:usr_stranger|stranger@example.com";

#[tokio::test]
async fn share_endpoints_answer_501_until_configured() {
    let router = june_api::router(state_with_share(None));
    let (status, body) = call(&router, create_request(OWNER, &[invite_wire("a@b.c")])).await;
    assert_eq!(status, StatusCode::NOT_IMPLEMENTED);
    assert_eq!(body["message"], "sharing_unavailable");
}

#[tokio::test]
async fn each_invite_link_resolves_to_its_own_envelope_by_invite_id() {
    // One recipient user holding two verified emails, each with its own invite.
    // The addresses differ, so both invites stay active (per-email uniqueness
    // still holds). A link's invite id must select that invite's envelope, not
    // merely the first active invite the caller's emails happen to match.
    const RECIPIENT_TWO: &str = "user:usr_friend|first@example.com,second@example.com";

    let router = share_router();
    let (status, body) = call(
        &router,
        create_request(
            OWNER,
            &[json!({
                "email": "first@example.com",
                "envelopeB64": BASE64.encode([0x11u8; 48]),
                "envelopeIvB64": BASE64.encode([0x21u8; 12]),
            })],
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let share_id = body["data"]["shareId"]
        .as_str()
        .expect("share id")
        .to_string();
    let invite_one = body["data"]["invites"][0]["inviteId"]
        .as_str()
        .expect("invite one")
        .to_string();

    let (status, body) = call(
        &router,
        authed(
            Request::builder()
                .method("POST")
                .uri(format!("/v1/shares/{share_id}/invites")),
            OWNER,
        )
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            json!({
                "invites": [{
                    "email": "second@example.com",
                    "envelopeB64": BASE64.encode([0x33u8; 48]),
                    "envelopeIvB64": BASE64.encode([0x44u8; 12]),
                }]
            })
            .to_string(),
        ))
        .expect("request builds"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let invite_two = body["data"]["invites"][0]["inviteId"]
        .as_str()
        .expect("invite two")
        .to_string();
    assert_ne!(invite_one, invite_two);

    // The second link resolves to invite_two's envelope for this user.
    let (status, body) = call(
        &router,
        authed(
            Request::builder()
                .method("GET")
                .uri(format!("/v1/shares/{share_id}/view?invite={invite_two}")),
            RECIPIENT_TWO,
        )
        .body(Body::empty())
        .expect("request builds"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"]["envelopeB64"], BASE64.encode([0x33u8; 48]));
    assert_eq!(body["data"]["envelopeIvB64"], BASE64.encode([0x44u8; 12]));

    // The first link still resolves to its own envelope for the same user.
    let (status, body) = call(
        &router,
        authed(
            Request::builder()
                .method("GET")
                .uri(format!("/v1/shares/{share_id}/view?invite={invite_one}")),
            RECIPIENT_TWO,
        )
        .body(Body::empty())
        .expect("request builds"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"]["envelopeB64"], BASE64.encode([0x11u8; 48]));
    assert_eq!(body["data"]["envelopeIvB64"], BASE64.encode([0x21u8; 12]));
}

#[tokio::test]
async fn bound_invite_lapses_when_the_recipient_loses_the_verified_email() {
    let router = share_router();
    let (status, body) = call(
        &router,
        create_request(OWNER, &[invite_wire("friend@example.com")]),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let share_id = body["data"]["shareId"]
        .as_str()
        .expect("share id")
        .to_string();

    // First view binds the invite to usr_friend (the token carries the email).
    let (status, _) = call(
        &router,
        authed(
            Request::builder()
                .method("GET")
                .uri(format!("/v1/shares/{share_id}/view")),
            "user:usr_friend|friend@example.com",
        )
        .body(Body::empty())
        .expect("request builds"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // Same user, but the invited email is no longer in their verified set:
    // access must lapse (byte-identical 404), not persist through the binding.
    let (status, body) = call(
        &router,
        authed(
            Request::builder()
                .method("GET")
                .uri(format!("/v1/shares/{share_id}/view")),
            "user:usr_friend|other@example.com",
        )
        .body(Body::empty())
        .expect("request builds"),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["message"], "share_not_found");
}

#[tokio::test]
async fn create_with_the_same_email_twice_in_one_request_is_rejected() {
    let router = share_router();
    let (status, _) = call(
        &router,
        create_request(
            OWNER,
            &[
                invite_wire("dup@example.com"),
                invite_wire("Dup@example.com"),
            ],
        ),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn duplicate_active_invite_is_rejected_but_reinvite_after_revoke_is_allowed() {
    let router = share_router();
    let (status, body) = call(
        &router,
        create_request(OWNER, &[invite_wire("friend@example.com")]),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let share_id = body["data"]["shareId"]
        .as_str()
        .expect("share id")
        .to_string();
    let invite_id = body["data"]["invites"][0]["inviteId"]
        .as_str()
        .expect("invite id")
        .to_string();

    let add = |email: &str| {
        let body = json!({ "invites": [invite_wire(email)] });
        authed(
            Request::builder()
                .method("POST")
                .uri(format!("/v1/shares/{share_id}/invites")),
            OWNER,
        )
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .expect("request builds")
    };

    // The address is already active (case-insensitively): re-inviting is refused.
    let (status, _) = call(&router, add("Friend@Example.com")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Revoke that invite, then the same address can be invited again.
    let (status, _) = call(
        &router,
        authed(
            Request::builder()
                .method("DELETE")
                .uri(format!("/v1/shares/{share_id}/invites/{invite_id}")),
            OWNER,
        )
        .body(Body::empty())
        .expect("request builds"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = call(&router, add("friend@example.com")).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn invited_recipient_views_exact_ciphertext_and_uninvited_cannot_be_told_from_missing() {
    let router = share_router();
    let (status, body) = call(
        &router,
        create_request(OWNER, &[invite_wire("Friend@Example.com")]),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let share_id = body["data"]["shareId"]
        .as_str()
        .expect("share id")
        .to_string();
    assert_eq!(body["data"]["invites"][0]["email"], "friend@example.com");

    // Invited recipient: gets envelope + the EXACT bytes the owner posted —
    // the server neither reads nor rewrites content.
    let (status, body) = call(
        &router,
        authed(
            Request::builder()
                .method("GET")
                .uri(format!("/v1/shares/{share_id}/view")),
            RECIPIENT,
        )
        .body(Body::empty())
        .expect("request builds"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["data"]["ciphertextB64"],
        BASE64.encode(b"opaque-ciphertext")
    );
    assert_eq!(body["data"]["envelopeB64"], BASE64.encode([1u8; 48]));

    // Uninvited authenticated user vs a share that does not exist: identical
    // status AND identical body. Nothing distinguishes the two.
    let (stranger_status, stranger_body) = call(
        &router,
        authed(
            Request::builder()
                .method("GET")
                .uri(format!("/v1/shares/{share_id}/view")),
            STRANGER,
        )
        .body(Body::empty())
        .expect("request builds"),
    )
    .await;
    let (missing_status, missing_body) = call(
        &router,
        authed(
            Request::builder()
                .method("GET")
                .uri("/v1/shares/shr_does-not-exist/view"),
            STRANGER,
        )
        .body(Body::empty())
        .expect("request builds"),
    )
    .await;
    assert_eq!(stranger_status, StatusCode::NOT_FOUND);
    assert_eq!(missing_status, StatusCode::NOT_FOUND);
    assert_eq!(stranger_body, missing_body);
}

#[tokio::test]
async fn owner_sees_invite_lifecycle_and_revocation_cuts_access() {
    let router = share_router();
    let (_, body) = call(
        &router,
        create_request(OWNER, &[invite_wire("friend@example.com")]),
    )
    .await;
    let share_id = body["data"]["shareId"]
        .as_str()
        .expect("share id")
        .to_string();
    let invite_id = body["data"]["invites"][0]["inviteId"]
        .as_str()
        .expect("invite id")
        .to_string();

    // Pending before first access.
    let (_, body) = call(
        &router,
        authed(
            Request::builder()
                .method("GET")
                .uri(format!("/v1/shares/{share_id}")),
            OWNER,
        )
        .body(Body::empty())
        .expect("request builds"),
    )
    .await;
    assert_eq!(body["data"]["invites"][0]["state"], "pending");

    // Recipient views once: accepted.
    let (status, _) = call(
        &router,
        authed(
            Request::builder()
                .method("GET")
                .uri(format!("/v1/shares/{share_id}/view")),
            RECIPIENT,
        )
        .body(Body::empty())
        .expect("request builds"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (_, body) = call(
        &router,
        authed(
            Request::builder()
                .method("GET")
                .uri(format!("/v1/shares/{share_id}")),
            OWNER,
        )
        .body(Body::empty())
        .expect("request builds"),
    )
    .await;
    assert_eq!(body["data"]["invites"][0]["state"], "accepted");

    // Revoke: recipient's next fetch is the standard 404.
    let (status, _) = call(
        &router,
        authed(
            Request::builder()
                .method("DELETE")
                .uri(format!("/v1/shares/{share_id}/invites/{invite_id}")),
            OWNER,
        )
        .body(Body::empty())
        .expect("request builds"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, body) = call(
        &router,
        authed(
            Request::builder()
                .method("GET")
                .uri(format!("/v1/shares/{share_id}/view")),
            RECIPIENT,
        )
        .body(Body::empty())
        .expect("request builds"),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["message"], "share_not_found");
}

#[tokio::test]
async fn non_owner_cannot_inspect_or_mutate_a_share() {
    let router = share_router();
    let (_, body) = call(
        &router,
        create_request(OWNER, &[invite_wire("friend@example.com")]),
    )
    .await;
    let share_id = body["data"]["shareId"]
        .as_str()
        .expect("share id")
        .to_string();

    for (method, uri) in [
        ("GET", format!("/v1/shares/{share_id}")),
        ("DELETE", format!("/v1/shares/{share_id}")),
        ("POST", format!("/v1/shares/{share_id}/invites")),
    ] {
        let request = authed(Request::builder().method(method).uri(uri), STRANGER)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                json!({ "invites": [invite_wire("x@y.z")] }).to_string(),
            ))
            .expect("request builds");
        let (status, body) = call(&router, request).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{method} must not leak");
        assert_eq!(body["message"], "share_not_found");
    }
}

#[tokio::test]
async fn viewer_shell_is_static_noindex_and_identical_for_any_id() {
    let router = share_router();
    let mut pages = Vec::new();
    for share_id in ["shr_real-looking-id", "shr_another-id"] {
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(format!("/s/{share_id}"))
                    .body(Body::empty())
                    .expect("request builds"),
            )
            .await
            .expect("request completes");
        assert_eq!(response.status(), StatusCode::OK);
        let headers = response.headers();
        assert_eq!(
            headers.get("x-robots-tag").and_then(|v| v.to_str().ok()),
            Some("noindex, nofollow, noarchive")
        );
        assert_eq!(
            headers.get("referrer-policy").and_then(|v| v.to_str().ok()),
            Some("no-referrer")
        );
        let csp = headers
            .get(header::CONTENT_SECURITY_POLICY)
            .and_then(|v| v.to_str().ok())
            .expect("csp present");
        assert!(csp.contains("default-src 'none'"));
        assert!(csp.contains("connect-src 'self'"));
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body reads");
        pages.push(bytes);
    }
    // Same bytes for every id: the shell reveals nothing about existence.
    assert_eq!(pages[0], pages[1]);
}

#[tokio::test]
async fn robots_txt_disallows_share_paths() {
    let router = share_router();
    let response = router
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/robots.txt")
                .body(Body::empty())
                .expect("request builds"),
        )
        .await
        .expect("request completes");
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body reads");
    let text = String::from_utf8_lossy(&bytes).to_string();
    assert!(text.contains("Disallow: /s/"));
}

#[tokio::test]
async fn invites_cannot_grow_past_the_cumulative_cap() {
    let router = share_router();
    let (_, body) = call(
        &router,
        create_request(OWNER, &[invite_wire("friend@example.com")]),
    )
    .await;
    let share_id = body["data"]["shareId"]
        .as_str()
        .expect("share id")
        .to_string();

    // Fill to the cap in batches, then one more must fail.
    let mut added = 1;
    while added < MAX_INVITES_PER_SHARE {
        let batch: Vec<Value> = (0..(MAX_INVITES_PER_SHARE - added).min(40))
            .map(|n| invite_wire(&format!("extra{added}x{n}@example.com")))
            .collect();
        added += batch.len();
        let request = authed(
            Request::builder()
                .method("POST")
                .uri(format!("/v1/shares/{share_id}/invites")),
            OWNER,
        )
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(json!({ "invites": batch }).to_string()))
        .expect("request builds");
        let (status, _) = call(&router, request).await;
        assert_eq!(status, StatusCode::OK);
    }

    let request = authed(
        Request::builder()
            .method("POST")
            .uri(format!("/v1/shares/{share_id}/invites")),
        OWNER,
    )
    .header(header::CONTENT_TYPE, "application/json")
    .body(Body::from(
        json!({ "invites": [invite_wire("overflow@example.com")] }).to_string(),
    ))
    .expect("request builds");
    let (status, body) = call(&router, request).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        body["message"]
            .as_str()
            .unwrap_or_default()
            .contains("at most")
    );
}
