//! Private sharing (JUN-308). This layer owns authorization semantics and
//! non-enumeration: every "does not exist / not yours / revoked / uninvited"
//! outcome collapses into one `ShareNotFound` error so callers cannot probe
//! for shares or recipients. Content here is ciphertext only; nothing in
//! this module can decrypt it, and payload bytes are never logged.

use crate::error::ServiceError;
use june_domain::{
    MAX_INVITES_PER_SHARE, NewShare, NewShareInvite, ShareInviteRecord, ShareKind, ShareRecord,
    ShareStore, ShareStoreError, ShareViewRecord, UserId, ViewRequest, ViewerIdentity,
};
use std::sync::Arc;

/// 20 random bytes, base64url: 160 bits of entropy, non-sequential.
const ID_RANDOM_BYTES: usize = 20;
const MAX_EMAIL_CHARS: usize = 254;
/// AES-256-GCM of a 32-byte content key: 32 + 16-byte tag.
const ENVELOPE_BYTES: usize = 48;
const IV_BYTES: usize = 12;

pub struct ShareServiceDeps {
    pub store: Arc<dyn ShareStore>,
    pub identity: Arc<dyn ViewerIdentity>,
    pub max_ciphertext_bytes: usize,
}

pub struct ShareService {
    store: Arc<dyn ShareStore>,
    identity: Arc<dyn ViewerIdentity>,
    max_ciphertext_bytes: usize,
}

#[derive(Clone, Debug)]
pub struct InviteInput {
    pub email: String,
    pub envelope: Vec<u8>,
    pub envelope_iv: Vec<u8>,
}

#[derive(Clone, Debug)]
pub struct CreateShareInput {
    pub owner: UserId,
    pub kind: ShareKind,
    pub ciphertext: Vec<u8>,
    pub iv: Vec<u8>,
    pub invites: Vec<InviteInput>,
}

#[derive(Clone, Debug)]
pub struct CreatedShare {
    pub share_id: String,
    pub invites: Vec<CreatedInvite>,
}

#[derive(Clone, Debug)]
pub struct CreatedInvite {
    pub invite_id: String,
    pub email: String,
}

impl ShareService {
    pub fn new(deps: ShareServiceDeps) -> Self {
        Self {
            store: deps.store,
            identity: deps.identity,
            max_ciphertext_bytes: deps.max_ciphertext_bytes,
        }
    }

    pub async fn create(&self, input: CreateShareInput) -> Result<CreatedShare, ServiceError> {
        if input.ciphertext.is_empty() || input.ciphertext.len() > self.max_ciphertext_bytes {
            return Err(ServiceError::InvalidInput {
                reason: format!("ciphertext must be 1..={} bytes", self.max_ciphertext_bytes),
            });
        }
        validate_iv(&input.iv)?;
        if input.invites.is_empty() || input.invites.len() > MAX_INVITES_PER_SHARE {
            return Err(ServiceError::InvalidInput {
                reason: format!("invites must be 1..={MAX_INVITES_PER_SHARE}"),
            });
        }
        let share_id = prefixed_random_id("shr");
        let invites = normalized_invites(input.invites)?;
        let created = CreatedShare {
            share_id: share_id.clone(),
            invites: invites
                .iter()
                .map(|(invite_id, invite)| CreatedInvite {
                    invite_id: invite_id.clone(),
                    email: invite.email.clone(),
                })
                .collect(),
        };
        self.store
            .create_share(NewShare {
                share_id,
                owner_user_id: input.owner,
                kind: input.kind,
                ciphertext: input.ciphertext,
                iv: input.iv,
                invites,
            })
            .await?;
        Ok(created)
    }

    pub async fn list(&self, owner: &UserId) -> Result<Vec<ShareRecord>, ServiceError> {
        Ok(self.store.list_shares(&owner.0).await?)
    }

    pub async fn detail(
        &self,
        owner: &UserId,
        share_id: &str,
    ) -> Result<(ShareRecord, Vec<ShareInviteRecord>), ServiceError> {
        Ok(self.store.share_invites(&owner.0, share_id).await?)
    }

    pub async fn add_invites(
        &self,
        owner: &UserId,
        share_id: &str,
        invites: Vec<InviteInput>,
    ) -> Result<Vec<CreatedInvite>, ServiceError> {
        if invites.is_empty() || invites.len() > MAX_INVITES_PER_SHARE {
            return Err(ServiceError::InvalidInput {
                reason: format!("invites must be 1..={MAX_INVITES_PER_SHARE}"),
            });
        }
        let invites = normalized_invites(invites)?;
        let created = invites
            .iter()
            .map(|(invite_id, invite)| CreatedInvite {
                invite_id: invite_id.clone(),
                email: invite.email.clone(),
            })
            .collect();
        self.store.add_invites(&owner.0, share_id, invites).await?;
        Ok(created)
    }

    pub async fn revoke_invite(
        &self,
        owner: &UserId,
        share_id: &str,
        invite_id: &str,
    ) -> Result<(), ServiceError> {
        Ok(self
            .store
            .revoke_invite(&owner.0, share_id, invite_id)
            .await?)
    }

    pub async fn delete(&self, owner: &UserId, share_id: &str) -> Result<(), ServiceError> {
        Ok(self.store.delete_share(&owner.0, share_id).await?)
    }

    /// Recipient (or owner) fetch. The caller's verified emails are resolved
    /// through OS Accounts with the caller's own token; the store matches,
    /// binds, and stamps access.
    // Caller identity (viewer + token) and target (share + invite) are all
    // independent inputs; bundling them would only obscure the call site.
    #[allow(clippy::too_many_arguments)]
    pub async fn view(
        &self,
        viewer: &UserId,
        access_token: &str,
        share_id: &str,
        invite_id: Option<&str>,
    ) -> Result<ShareViewRecord, ServiceError> {
        let emails = self.identity.verified_emails(access_token).await?;
        Ok(self
            .store
            .fetch_view(ViewRequest {
                share_id,
                viewer_user_id: &viewer.0,
                viewer_emails: &emails,
                invite_id,
            })
            .await?)
    }
}

fn normalized_invites(
    invites: Vec<InviteInput>,
) -> Result<Vec<(String, NewShareInvite)>, ServiceError> {
    let normalized = invites
        .into_iter()
        .map(|invite| {
            let email = invite.email.trim().to_ascii_lowercase();
            if email.is_empty() || email.len() > MAX_EMAIL_CHARS || !email.contains('@') {
                return Err(ServiceError::InvalidInput {
                    reason: "invite email is not a valid address".to_string(),
                });
            }
            if invite.envelope.len() != ENVELOPE_BYTES {
                return Err(ServiceError::InvalidInput {
                    reason: format!("envelope must be {ENVELOPE_BYTES} bytes"),
                });
            }
            validate_iv(&invite.envelope_iv)?;
            Ok((
                prefixed_random_id("shi"),
                NewShareInvite {
                    email,
                    envelope: invite.envelope,
                    envelope_iv: invite.envelope_iv,
                },
            ))
        })
        .collect::<Result<Vec<_>, _>>()?;
    // Reject duplicate emails within one request: two active invites for the
    // same address let revoking one leave the other open. (Collisions with
    // existing invites are caught atomically by the store.)
    let mut seen = std::collections::HashSet::new();
    for (_, invite) in &normalized {
        if !seen.insert(invite.email.as_str()) {
            return Err(ServiceError::InvalidInput {
                reason: "an email appears more than once in the invite list".to_string(),
            });
        }
    }
    Ok(normalized)
}

fn validate_iv(iv: &[u8]) -> Result<(), ServiceError> {
    if iv.len() != IV_BYTES {
        return Err(ServiceError::InvalidInput {
            reason: format!("iv must be {IV_BYTES} bytes"),
        });
    }
    Ok(())
}

fn prefixed_random_id(prefix: &str) -> String {
    // uuid::v7 carries a timestamp; share ids must be non-sequential, so use
    // two independent v4-style random UUIDs' bytes as the entropy source.
    let mut bytes = Vec::with_capacity(ID_RANDOM_BYTES);
    while bytes.len() < ID_RANDOM_BYTES {
        bytes.extend_from_slice(uuid::Uuid::new_v4().as_bytes());
    }
    bytes.truncate(ID_RANDOM_BYTES);
    format!("{prefix}_{}", base64_url(&bytes))
}

fn base64_url(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

impl From<ShareStoreError> for ServiceError {
    fn from(error: ShareStoreError) -> Self {
        match error {
            ShareStoreError::NotFound => Self::ShareNotFound,
            ShareStoreError::InviteLimitExceeded => Self::InvalidInput {
                reason: format!("a share can have at most {MAX_INVITES_PER_SHARE} invites"),
            },
            ShareStoreError::DuplicateActiveInvite => Self::InvalidInput {
                reason: "that email already has an active invite on this share".to_string(),
            },
            ShareStoreError::Unavailable { reason } => {
                tracing::error!(%reason, "share store unavailable");
                Self::ShareUnavailable
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        CreateShareInput, InviteInput, ShareService, ShareServiceDeps, prefixed_random_id,
    };
    use crate::error::ServiceError;
    use async_trait::async_trait;
    use june_domain::{
        DomainError, NewShare, NewShareInvite, ShareInviteRecord, ShareKind, ShareRecord,
        ShareStore, ShareStoreError, ShareViewRecord, UserId, ViewRequest, ViewerIdentity,
    };
    use pretty_assertions::assert_eq;
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct RecordingStore {
        created: Mutex<Vec<NewShare>>,
    }

    #[async_trait]
    impl ShareStore for RecordingStore {
        async fn create_share(&self, share: NewShare) -> Result<(), ShareStoreError> {
            if let Ok(mut created) = self.created.lock() {
                created.push(share);
            }
            Ok(())
        }
        async fn list_shares(&self, _owner: &str) -> Result<Vec<ShareRecord>, ShareStoreError> {
            Ok(Vec::new())
        }
        async fn share_invites(
            &self,
            _owner: &str,
            _share_id: &str,
        ) -> Result<(ShareRecord, Vec<ShareInviteRecord>), ShareStoreError> {
            Err(ShareStoreError::NotFound)
        }
        async fn add_invites(
            &self,
            _owner: &str,
            _share_id: &str,
            _invites: Vec<(String, NewShareInvite)>,
        ) -> Result<(), ShareStoreError> {
            Ok(())
        }
        async fn revoke_invite(
            &self,
            _owner: &str,
            _share_id: &str,
            _invite_id: &str,
        ) -> Result<(), ShareStoreError> {
            Ok(())
        }
        async fn delete_share(&self, _owner: &str, _share_id: &str) -> Result<(), ShareStoreError> {
            Ok(())
        }
        async fn fetch_view(
            &self,
            _request: ViewRequest<'_>,
        ) -> Result<ShareViewRecord, ShareStoreError> {
            Err(ShareStoreError::NotFound)
        }
    }

    struct FixedIdentity;

    #[async_trait]
    impl ViewerIdentity for FixedIdentity {
        async fn verified_emails(&self, _token: &str) -> Result<Vec<String>, DomainError> {
            Ok(vec!["viewer@example.com".to_string()])
        }
    }

    fn service(store: Arc<RecordingStore>) -> ShareService {
        ShareService::new(ShareServiceDeps {
            store,
            identity: Arc::new(FixedIdentity),
            max_ciphertext_bytes: 1024,
        })
    }

    fn valid_invite(email: &str) -> InviteInput {
        InviteInput {
            email: email.to_string(),
            envelope: vec![0u8; 48],
            envelope_iv: vec![0u8; 12],
        }
    }

    #[tokio::test]
    async fn create_normalizes_emails_and_mints_prefixed_ids() {
        let store = Arc::new(RecordingStore::default());
        let created = service(store.clone())
            .create(CreateShareInput {
                owner: UserId("usr_owner".to_string()),
                kind: ShareKind::Note,
                ciphertext: vec![1, 2, 3],
                iv: vec![0u8; 12],
                invites: vec![valid_invite("  Friend@Example.COM ")],
            })
            .await
            .expect("share created");

        assert!(created.share_id.starts_with("shr_"));
        assert_eq!(created.invites.len(), 1);
        assert!(created.invites[0].invite_id.starts_with("shi_"));
        assert_eq!(created.invites[0].email, "friend@example.com");
        let stored = store.created.lock().expect("lock").clone();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].invites[0].1.email, "friend@example.com");
        // The stored bytes are exactly the submitted ciphertext: the service
        // neither inspects nor transforms content (no-plaintext guarantee at
        // this layer).
        assert_eq!(stored[0].ciphertext, vec![1, 2, 3]);
    }

    #[tokio::test]
    async fn create_rejects_bad_email_oversized_ciphertext_and_bad_envelope() {
        let store = Arc::new(RecordingStore::default());
        let svc = service(store);
        let base = CreateShareInput {
            owner: UserId("usr_owner".to_string()),
            kind: ShareKind::Note,
            ciphertext: vec![1],
            iv: vec![0u8; 12],
            invites: vec![valid_invite("a@b.c")],
        };

        let mut bad_email = base.clone();
        bad_email.invites = vec![valid_invite("not-an-email")];
        assert!(matches!(
            svc.create(bad_email).await,
            Err(ServiceError::InvalidInput { .. })
        ));

        let mut oversized = base.clone();
        oversized.ciphertext = vec![0u8; 2048];
        assert!(matches!(
            svc.create(oversized).await,
            Err(ServiceError::InvalidInput { .. })
        ));

        let mut bad_envelope = base.clone();
        bad_envelope.invites = vec![InviteInput {
            envelope: vec![0u8; 5],
            ..valid_invite("a@b.c")
        }];
        assert!(matches!(
            svc.create(bad_envelope).await,
            Err(ServiceError::InvalidInput { .. })
        ));

        let mut no_invites = base;
        no_invites.invites = Vec::new();
        assert!(matches!(
            svc.create(no_invites).await,
            Err(ServiceError::InvalidInput { .. })
        ));
    }

    #[test]
    fn ids_are_prefixed_and_high_entropy() {
        let a = prefixed_random_id("shr");
        let b = prefixed_random_id("shr");
        assert_ne!(a, b);
        assert!(a.starts_with("shr_"));
        // 20 bytes -> 27 base64url chars.
        assert_eq!(a.len(), "shr_".len() + 27);
    }
}
