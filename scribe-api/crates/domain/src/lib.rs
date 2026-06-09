use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::{fmt, time::Duration};
use thiserror::Error;

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub struct UserId(pub String);

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub struct ModelId(pub String);

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Credits(pub u64);

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionSlug {
    AgentChat,
    DictateCleanup,
    DictateTranscribe,
    NoteGenerate,
    NoteTranscribe,
}

impl ActionSlug {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AgentChat => "agent_chat",
            Self::DictateCleanup => "dictate_cleanup",
            Self::DictateTranscribe => "dictate_transcribe",
            Self::NoteGenerate => "note_generate",
            Self::NoteTranscribe => "note_transcribe",
        }
    }
}

impl fmt::Display for ActionSlug {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelKind {
    Asr,
    Text,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    pub text: String,
    pub language: Option<String>,
    pub provider: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedNote {
    pub content: String,
    pub title_suggestion: Option<String>,
    pub provider: String,
    pub usage: TokenUsage,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanedText {
    pub text: String,
    pub provider: String,
    pub usage: TokenUsage,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentChatCompletion {
    pub body: Vec<u8>,
    pub content_type: String,
    pub provider: String,
    pub usage: TokenUsage,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
}

impl TokenUsage {
    pub fn total(self) -> Option<u64> {
        self.prompt_tokens.checked_add(self.completion_tokens)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Authorization {
    pub allowed: bool,
    pub action_token: Option<String>,
    pub cap_credits: Option<Credits>,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub credits_charged: Credits,
    pub idempotent_replay: bool,
}

#[derive(Clone, Debug)]
pub struct TranscriptionRequest {
    pub audio: Vec<u8>,
    pub filename: String,
    pub title: String,
    pub context: Option<String>,
    pub language: Option<String>,
    pub model: ModelId,
}

#[derive(Clone, Debug)]
pub struct GenerationRequest {
    pub title: String,
    pub transcript: String,
    pub manual_notes: Option<String>,
    pub language: Option<String>,
    pub existing_generated_note: Option<String>,
    pub model: ModelId,
    pub system_prompt: String,
}

#[derive(Clone, Debug)]
pub struct CleanupRequest {
    pub text: String,
    pub dictionary_context: Option<String>,
    pub style: String,
    pub model: ModelId,
    pub system_prompt: String,
}

#[derive(Clone, Debug)]
pub struct AgentChatRequest {
    pub body: serde_json::Value,
    pub model: ModelId,
}

#[derive(Clone, Debug)]
pub struct AuthorizeRequest {
    pub user_id: UserId,
    pub action: ActionSlug,
    pub estimate: Credits,
    pub hold_ttl_seconds: u64,
}

#[derive(Clone, Debug)]
pub struct ChargeRequest {
    pub action_token: String,
    pub credits: Credits,
    pub idempotency_key: String,
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum DomainError {
    #[error("model is not priced")]
    ModelNotPriced,
    #[error("insufficient credits")]
    InsufficientCredits,
    #[error("upstream provider failed")]
    UpstreamProvider,
    #[error("invalid input: {reason}")]
    InvalidInput { reason: String },
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum AuthError {
    #[error("missing bearer token")]
    MissingToken,
    #[error("invalid access token")]
    InvalidToken,
}

#[async_trait]
pub trait Transcriber: Send + Sync {
    async fn transcribe(&self, request: TranscriptionRequest) -> Result<Transcript, DomainError>;
}

#[async_trait]
pub trait Generator: Send + Sync {
    async fn generate(&self, request: GenerationRequest) -> Result<GeneratedNote, DomainError>;
}

#[async_trait]
pub trait Cleaner: Send + Sync {
    async fn cleanup(&self, request: CleanupRequest) -> Result<CleanedText, DomainError>;
}

#[async_trait]
pub trait AgentChatCompleter: Send + Sync {
    async fn complete(&self, request: AgentChatRequest)
    -> Result<AgentChatCompletion, DomainError>;
}

#[async_trait]
pub trait OsAccountsClient: Send + Sync {
    async fn authorize(&self, request: AuthorizeRequest) -> Result<Authorization, DomainError>;

    async fn charge(&self, request: ChargeRequest) -> Result<Receipt, DomainError>;
}

#[async_trait]
pub trait TokenVerifier: Send + Sync {
    async fn verify(&self, access_jwt: &str) -> Result<UserId, AuthError>;
}

pub trait AudioDurationProbe: Send + Sync {
    fn probe(&self, audio: &[u8]) -> Result<Duration, DomainError>;
}
