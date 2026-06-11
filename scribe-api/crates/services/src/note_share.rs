use crate::error::ServiceError;
use scribe_domain::{
    CreateSharedNoteParams, RevokeOutcome, ShareId, SharedNote, SharedNotesStore, UserId,
};
use std::sync::Arc;

/// Hard caps on what a share may carry. Generous for real notes, small
/// enough that the share endpoint cannot become a free blob store.
const MAX_TITLE_CHARS: usize = 300;
const MAX_BODY_CHARS: usize = 200_000;
const MAX_SHARED_BY_CHARS: usize = 120;
/// Unlisted-URL entropy: 21 url-safe chars ~ 124 bits.
const SHARE_ID_LENGTH: usize = 21;

pub struct NoteShareServiceDeps {
    pub store: Arc<dyn SharedNotesStore>,
    /// Origin the public share pages are reachable on, no trailing slash.
    pub public_base_url: String,
}

pub struct NoteShareService {
    store: Arc<dyn SharedNotesStore>,
    public_base_url: String,
}

pub struct CreateShareParams {
    pub user_id: UserId,
    pub title: String,
    pub body_markdown: String,
    pub shared_by: String,
    /// RFC3339 creation instant, supplied by the caller so this stays pure.
    pub created_at: String,
}

pub struct CreatedShare {
    pub id: ShareId,
    pub url: String,
}

impl NoteShareService {
    pub fn new(deps: NoteShareServiceDeps) -> Self {
        Self {
            store: deps.store,
            public_base_url: deps.public_base_url.trim_end_matches('/').to_string(),
        }
    }

    pub fn share_url(&self, id: &ShareId) -> String {
        format!("{}/s/{}", self.public_base_url, id.0)
    }

    pub async fn create(&self, params: CreateShareParams) -> Result<CreatedShare, ServiceError> {
        let title = params.title.trim();
        let body = params.body_markdown.trim();
        let shared_by = params.shared_by.trim();
        if body.is_empty() {
            return Err(ServiceError::InvalidInput {
                reason: "share body is empty".to_string(),
            });
        }
        if title.chars().count() > MAX_TITLE_CHARS
            || body.chars().count() > MAX_BODY_CHARS
            || shared_by.chars().count() > MAX_SHARED_BY_CHARS
        {
            return Err(ServiceError::InvalidInput {
                reason: "share content exceeds size limits".to_string(),
            });
        }
        let id = ShareId(nanoid::nanoid!(SHARE_ID_LENGTH));
        let created = self
            .store
            .create(CreateSharedNoteParams {
                id,
                user_id: params.user_id,
                title: title.to_string(),
                body_markdown: body.to_string(),
                shared_by: shared_by.to_string(),
                created_at: params.created_at,
            })
            .await?;
        tracing::info!(user_id = %created.user_id.0, share_id = %created.id.0, "note share created");
        let url = self.share_url(&created.id);
        Ok(CreatedShare {
            id: created.id,
            url,
        })
    }

    pub async fn get(&self, id: &ShareId) -> Result<Option<SharedNote>, ServiceError> {
        Ok(self.store.get(id).await?)
    }

    pub async fn revoke(
        &self,
        id: &ShareId,
        owner: &UserId,
    ) -> Result<RevokeOutcome, ServiceError> {
        let outcome = self.store.revoke(id, owner).await?;
        if outcome == RevokeOutcome::Revoked {
            tracing::info!(user_id = %owner.0, share_id = %id.0, "note share revoked");
        }
        Ok(outcome)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use scribe_domain::DomainError;
    use std::sync::Mutex;

    struct MemoryStore {
        notes: Mutex<Vec<SharedNote>>,
    }

    #[async_trait]
    impl SharedNotesStore for MemoryStore {
        async fn create(&self, params: CreateSharedNoteParams) -> Result<SharedNote, DomainError> {
            let note = SharedNote {
                id: params.id,
                user_id: params.user_id,
                title: params.title,
                body_markdown: params.body_markdown,
                shared_by: params.shared_by,
                created_at: params.created_at,
            };
            self.notes.lock().expect("lock").push(note.clone());
            Ok(note)
        }

        async fn get(&self, id: &ShareId) -> Result<Option<SharedNote>, DomainError> {
            Ok(self
                .notes
                .lock()
                .expect("lock")
                .iter()
                .find(|note| &note.id == id)
                .cloned())
        }

        async fn revoke(&self, id: &ShareId, owner: &UserId) -> Result<RevokeOutcome, DomainError> {
            let mut notes = self.notes.lock().expect("lock");
            let before = notes.len();
            notes.retain(|note| !(&note.id == id && &note.user_id == owner));
            Ok(if notes.len() < before {
                RevokeOutcome::Revoked
            } else {
                RevokeOutcome::NotFound
            })
        }
    }

    fn service() -> NoteShareService {
        NoteShareService::new(NoteShareServiceDeps {
            store: Arc::new(MemoryStore {
                notes: Mutex::new(Vec::new()),
            }),
            public_base_url: "https://scribe-api.example.test/".to_string(),
        })
    }

    fn create_params(body: &str) -> CreateShareParams {
        CreateShareParams {
            user_id: UserId("usr_a".to_string()),
            title: "Weekly sync".to_string(),
            body_markdown: body.to_string(),
            shared_by: "Gaut".to_string(),
            created_at: "2026-06-11T00:00:00Z".to_string(),
        }
    }

    #[tokio::test]
    async fn creates_with_unlisted_id_and_public_url() {
        let service = service();
        let created = service
            .create(create_params("# Hello"))
            .await
            .expect("create");
        assert_eq!(created.id.0.len(), SHARE_ID_LENGTH);
        assert_eq!(
            created.url,
            format!("https://scribe-api.example.test/s/{}", created.id.0)
        );
    }

    #[tokio::test]
    async fn rejects_empty_and_oversized_bodies() {
        let service = service();
        assert!(matches!(
            service.create(create_params("   ")).await,
            Err(ServiceError::InvalidInput { .. })
        ));
        let oversized = "a".repeat(MAX_BODY_CHARS + 1);
        assert!(matches!(
            service.create(create_params(&oversized)).await,
            Err(ServiceError::InvalidInput { .. })
        ));
    }
}
