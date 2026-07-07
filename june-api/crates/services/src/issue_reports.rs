use june_config::IssueReportsConfig;
use june_domain::{
    AgentChatCompleter, AgentChatCompletion, AgentChatRequest, DomainError, IssueReport,
    IssueReportSink, ModelId, ProviderCredentials,
};
use serde::Deserialize;
use std::{
    collections::HashMap,
    fmt::Write as _,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use thiserror::Error;
use tokio::time::timeout;

const ISSUE_REPORT_DIAGNOSIS_SYSTEM_PROMPT: &str = r"You diagnose June issue reports for internal triage.

Return only numbered issue sections. Emit every section with exactly this markdown heading shape:
**Issue N — Title:**

Use N as 1, 2, 3, and so on. Replace Title with a short tracker-ready title.
Under each heading include:
- Root-cause hypothesis: one or two concise sentences based only on the report.
- Severity guess: low, medium, high, or critical, with a brief reason.

If the report appears to describe one issue, emit exactly one section. If it describes separate issues, emit one section per issue. Do not include a summary, signoff, or attachment bytes.";

pub struct IssueReportServiceDeps {
    pub sink: Arc<dyn IssueReportSink>,
    pub chat_completer: Arc<dyn AgentChatCompleter>,
    pub config: IssueReportsConfig,
}

pub struct IssueReportService {
    sink: Arc<dyn IssueReportSink>,
    chat_completer: Arc<dyn AgentChatCompleter>,
    diagnosis_model: Option<ModelId>,
    diagnosis_timeout: Duration,
    diagnosis_hourly_cap: u64,
    // The diagnosis call is June-funded and unmetered, so this window is the
    // only per-user bound on upstream spend. In-memory is deliberate: a
    // process restart forgiving the window is fine, an exceeded cap only
    // skips the diagnosis — delivery is never limited.
    diagnosis_windows: Mutex<HashMap<String, DiagnosisWindow>>,
}

struct DiagnosisWindow {
    started: Instant,
    count: u64,
}

const DIAGNOSIS_WINDOW: Duration = Duration::from_hours(1);

impl IssueReportService {
    pub fn new(deps: IssueReportServiceDeps) -> Self {
        Self {
            sink: deps.sink,
            chat_completer: deps.chat_completer,
            diagnosis_model: configured_diagnosis_model(&deps.config),
            diagnosis_timeout: Duration::from_secs(deps.config.diagnosis_timeout_secs),
            diagnosis_hourly_cap: deps.config.diagnosis_max_per_user_per_hour,
            diagnosis_windows: Mutex::new(HashMap::new()),
        }
    }

    pub async fn submit(&self, mut report: IssueReport) -> Result<(), DomainError> {
        if has_non_empty_diagnosis(&report) {
            return self.sink.deliver(report).await;
        }
        report.agent_diagnosis = None;

        if let Some(model) = self.diagnosis_model.as_ref()
            && self.take_diagnosis_slot(&report)
            && let Some(diagnosis) = self.diagnose(&report, model.clone()).await
        {
            report.agent_diagnosis = Some(diagnosis);
        }

        self.sink.deliver(report).await
    }

    /// Counts this report against the user's hourly diagnosis window; false
    /// means the cap is exhausted and the report delivers undiagnosed.
    fn take_diagnosis_slot(&self, report: &IssueReport) -> bool {
        // A poisoned lock must not block report delivery; skip the diagnosis
        // rather than risk unbounded spend with no counter.
        let Ok(mut windows) = self.diagnosis_windows.lock() else {
            return false;
        };
        let now = Instant::now();
        windows.retain(|_, window| now.duration_since(window.started) < DIAGNOSIS_WINDOW);
        let window = windows
            .entry(report.user_id.0.clone())
            .or_insert(DiagnosisWindow {
                started: now,
                count: 0,
            });
        if window.count >= self.diagnosis_hourly_cap {
            tracing::warn!(
                user_id = %report.user_id.0,
                cap = self.diagnosis_hourly_cap,
                "issue_reports: per-user diagnosis cap reached; delivering report without diagnosis"
            );
            return false;
        }
        window.count += 1;
        true
    }

    async fn diagnose(&self, report: &IssueReport, model: ModelId) -> Option<String> {
        let request = AgentChatRequest {
            body: issue_report_diagnosis_body(report),
            model: model.clone(),
            provider_credentials: ProviderCredentials::default(),
        };
        match timeout(
            self.diagnosis_timeout,
            self.chat_completer.complete(request),
        )
        .await
        {
            Ok(Ok(completion)) => match diagnosis_text_from_completion(&completion) {
                Ok(text) => Some(text),
                Err(error) => {
                    tracing::warn!(
                        %error,
                        user_id = %report.user_id.0,
                        model = %model.0,
                        "issue_reports: diagnosis response unusable; delivering report without diagnosis"
                    );
                    None
                }
            },
            Ok(Err(error)) => {
                tracing::warn!(
                    %error,
                    user_id = %report.user_id.0,
                    model = %model.0,
                    "issue_reports: diagnosis provider call failed; delivering report without diagnosis"
                );
                None
            }
            Err(error) => {
                tracing::warn!(
                    %error,
                    user_id = %report.user_id.0,
                    model = %model.0,
                    timeout_secs = self.diagnosis_timeout.as_secs(),
                    "issue_reports: diagnosis timed out; delivering report without diagnosis"
                );
                None
            }
        }
    }
}

fn configured_diagnosis_model(config: &IssueReportsConfig) -> Option<ModelId> {
    config
        .diagnosis_model
        .as_deref()
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .map(|model| ModelId(model.to_string()))
}

fn has_non_empty_diagnosis(report: &IssueReport) -> bool {
    report
        .agent_diagnosis
        .as_deref()
        .map(str::trim)
        .is_some_and(|diagnosis| !diagnosis.is_empty())
}

fn issue_report_diagnosis_body(report: &IssueReport) -> serde_json::Value {
    serde_json::json!({
        "stream": false,
        "temperature": 0.2,
        // The call is unmetered (June's own expense), so the output cap is the
        // only per-report cost bound besides the timeout.
        "max_tokens": 1024,
        "messages": [
            {
                "role": "system",
                "content": ISSUE_REPORT_DIAGNOSIS_SYSTEM_PROMPT
            },
            {
                "role": "user",
                "content": issue_report_diagnosis_user_prompt(report)
            }
        ]
    })
}

fn issue_report_diagnosis_user_prompt(report: &IssueReport) -> String {
    let mut prompt = String::new();
    let _ = writeln!(
        prompt,
        "Category: {}",
        report.category.as_deref().unwrap_or("unspecified")
    );
    let _ = writeln!(
        prompt,
        "App version: {}",
        report.app_version.as_deref().unwrap_or("unspecified")
    );
    let _ = writeln!(
        prompt,
        "Platform: {}",
        report.platform.as_deref().unwrap_or("unspecified")
    );
    let attachment_names = report_attachment_names(report);
    let _ = writeln!(
        prompt,
        "Attachment file names: {}",
        if attachment_names.is_empty() {
            "none".to_string()
        } else {
            attachment_names.join(", ")
        }
    );
    let _ = writeln!(prompt);
    let _ = writeln!(prompt, "User description:");
    prompt.push_str(report.description.trim());
    prompt
}

fn report_attachment_names(report: &IssueReport) -> Vec<String> {
    report
        .attachment_names
        .iter()
        .chain(report.attachments.iter().map(|attachment| &attachment.name))
        .map(|name| name.trim())
        .filter(|name| !name.is_empty())
        .map(ToString::to_string)
        .collect()
}

fn diagnosis_text_from_completion(
    completion: &AgentChatCompletion,
) -> Result<String, DiagnosisParseError> {
    let parsed: ChatCompletionBody = serde_json::from_slice(&completion.body)?;
    let text = parsed
        .choices
        .first()
        .map(|choice| choice.message.content.trim().to_string())
        .filter(|text| !text.is_empty())
        .ok_or(DiagnosisParseError::EmptyText)?;
    Ok(text)
}

#[derive(Debug, Error)]
enum DiagnosisParseError {
    #[error("chat completion body was not parseable JSON")]
    Json(#[from] serde_json::Error),
    #[error("chat completion body did not contain non-empty text")]
    EmptyText,
}

#[derive(Deserialize)]
struct ChatCompletionBody {
    choices: Vec<ChatCompletionChoice>,
}

#[derive(Deserialize)]
struct ChatCompletionChoice {
    message: ChatCompletionMessage,
}

#[derive(Deserialize)]
struct ChatCompletionMessage {
    content: String,
}

#[cfg(test)]
mod tests {
    use super::{
        ISSUE_REPORT_DIAGNOSIS_SYSTEM_PROMPT, IssueReportService, IssueReportServiceDeps,
        issue_report_diagnosis_body, issue_report_diagnosis_user_prompt,
    };
    use async_trait::async_trait;
    use june_config::IssueReportsConfig;
    use june_domain::{
        AgentChatCompleter, AgentChatCompletion, AgentChatRequest, DomainError, IssueReport,
        IssueReportAttachment, IssueReportSink, TokenUsage, UserId,
    };
    use pretty_assertions::assert_eq;
    use rstest::rstest;
    use std::{
        sync::{Arc, Mutex},
        time::Duration,
    };

    #[tokio::test]
    async fn configured_model_adds_model_diagnosis_before_delivery() {
        let sink = Arc::new(RecordingSink::default());
        let completer = Arc::new(RecordingCompleter::with_behavior(CompleterBehavior::Text(
            "**Issue 1 — Recorder freeze:**\nRoot-cause hypothesis: capture is blocked.\nSeverity guess: high, recording is unavailable."
                .to_string(),
        )));
        let service = service_with_model(sink.clone(), completer.clone(), Some("diagnosis-model"));

        service
            .submit(report_without_diagnosis())
            .await
            .expect("report delivery succeeds");

        assert_eq!(completer.call_count(), 1);
        let delivered = sink.delivered();
        assert_eq!(delivered.len(), 1);
        assert_eq!(
            delivered[0].agent_diagnosis.as_deref(),
            Some(
                "**Issue 1 — Recorder freeze:**\nRoot-cause hypothesis: capture is blocked.\nSeverity guess: high, recording is unavailable."
            )
        );
        let requests = completer.requests();
        assert_eq!(requests[0].model.0, "diagnosis-model");
        assert_eq!(requests[0].provider_credentials.venice_api_key, None);
    }

    #[tokio::test]
    async fn client_diagnosis_passes_through_without_model_call() {
        let sink = Arc::new(RecordingSink::default());
        let completer = Arc::new(RecordingCompleter::with_behavior(CompleterBehavior::Text(
            "server diagnosis".to_string(),
        )));
        let service = service_with_model(sink.clone(), completer.clone(), Some("diagnosis-model"));
        let mut report = report_without_diagnosis();
        report.agent_diagnosis = Some("  Client diagnosis stays verbatim  ".to_string());

        service
            .submit(report)
            .await
            .expect("report delivery succeeds");

        assert_eq!(completer.call_count(), 0);
        assert_eq!(
            sink.delivered()[0].agent_diagnosis.as_deref(),
            Some("  Client diagnosis stays verbatim  ")
        );
    }

    #[tokio::test]
    async fn unset_model_delivers_without_model_call() {
        let sink = Arc::new(RecordingSink::default());
        let completer = Arc::new(RecordingCompleter::with_behavior(CompleterBehavior::Text(
            "server diagnosis".to_string(),
        )));
        let service = service_with_model(sink.clone(), completer.clone(), None);

        service
            .submit(report_without_diagnosis())
            .await
            .expect("report delivery succeeds");

        assert_eq!(completer.call_count(), 0);
        assert_eq!(sink.delivered()[0].agent_diagnosis, None);
    }

    #[rstest]
    #[case::provider_error(CompleterBehavior::Error)]
    #[case::timeout(CompleterBehavior::Delay)]
    #[tokio::test]
    async fn diagnosis_failure_still_delivers_without_diagnosis(
        #[case] behavior: CompleterBehavior,
    ) {
        let sink = Arc::new(RecordingSink::default());
        let completer = Arc::new(RecordingCompleter::with_behavior(behavior));
        let service = service_with_model(sink.clone(), completer.clone(), Some("diagnosis-model"));

        service
            .submit(report_without_diagnosis())
            .await
            .expect("report delivery succeeds");

        assert_eq!(completer.call_count(), 1);
        let delivered = sink.delivered();
        assert_eq!(delivered.len(), 1);
        assert_eq!(delivered[0].agent_diagnosis, None);
    }

    #[tokio::test]
    async fn hourly_cap_skips_diagnosis_but_still_delivers() {
        let sink = Arc::new(RecordingSink::default());
        let completer = Arc::new(RecordingCompleter::with_behavior(CompleterBehavior::Text(
            "server diagnosis".to_string(),
        )));
        let config = IssueReportsConfig {
            diagnosis_model: Some("diagnosis-model".to_string()),
            diagnosis_timeout_secs: 1,
            diagnosis_max_per_user_per_hour: 1,
            ..IssueReportsConfig::default()
        };
        let service = IssueReportService::new(IssueReportServiceDeps {
            sink: sink.clone(),
            chat_completer: completer.clone(),
            config,
        });

        service
            .submit(report_without_diagnosis())
            .await
            .expect("first report delivery succeeds");
        service
            .submit(report_without_diagnosis())
            .await
            .expect("capped report still delivers");
        let mut other_user = report_without_diagnosis();
        other_user.user_id = UserId("usr_other".to_string());
        service
            .submit(other_user)
            .await
            .expect("other user's report delivery succeeds");

        // One call per user within the window: the same user's second report
        // is delivered undiagnosed instead of spending again.
        assert_eq!(completer.call_count(), 2);
        let delivered = sink.delivered();
        assert_eq!(delivered.len(), 3);
        assert!(delivered[0].agent_diagnosis.is_some());
        assert_eq!(delivered[1].agent_diagnosis, None);
        assert!(delivered[2].agent_diagnosis.is_some());
    }

    #[test]
    fn prompt_locks_heading_shape_for_existing_splitter() {
        assert!(ISSUE_REPORT_DIAGNOSIS_SYSTEM_PROMPT.contains("**Issue N — Title:**"));
        let body = issue_report_diagnosis_body(&report_without_diagnosis());
        assert_eq!(body["stream"], false);
        assert_eq!(body["max_tokens"], 1024);
        assert_eq!(
            body["messages"][0]["content"],
            ISSUE_REPORT_DIAGNOSIS_SYSTEM_PROMPT
        );
    }

    #[test]
    fn prompt_includes_report_context_without_attachment_bytes() {
        let report = report_without_diagnosis();

        let prompt = issue_report_diagnosis_user_prompt(&report);

        assert!(prompt.contains("Category: bug"));
        assert!(prompt.contains("App version: 0.2.0"));
        assert!(prompt.contains("Platform: macos"));
        assert!(prompt.contains("Attachment file names: screenshot.png, logs.txt"));
        assert!(prompt.contains("The recorder freezes after pause."));
        assert!(!prompt.contains("fake-bytes"));
    }

    fn service_with_model(
        sink: Arc<RecordingSink>,
        completer: Arc<RecordingCompleter>,
        diagnosis_model: Option<&str>,
    ) -> IssueReportService {
        let config = IssueReportsConfig {
            diagnosis_model: diagnosis_model.map(ToString::to_string),
            diagnosis_timeout_secs: 1,
            ..IssueReportsConfig::default()
        };
        IssueReportService::new(IssueReportServiceDeps {
            sink,
            chat_completer: completer,
            config,
        })
    }

    fn report_without_diagnosis() -> IssueReport {
        IssueReport {
            user_id: UserId("usr_test".to_string()),
            category: Some("bug".to_string()),
            description: "The recorder freezes after pause.".to_string(),
            agent_diagnosis: None,
            attachment_names: vec!["screenshot.png".to_string()],
            attachments: vec![IssueReportAttachment {
                name: "logs.txt".to_string(),
                content_type: "text/plain".to_string(),
                bytes: b"fake-bytes".to_vec(),
            }],
            session_id: Some("session-1".to_string()),
            app_version: Some("0.2.0".to_string()),
            platform: Some("macos".to_string()),
        }
    }

    #[derive(Clone, Debug, Eq, PartialEq)]
    enum CompleterBehavior {
        Text(String),
        Error,
        Delay,
    }

    #[derive(Default)]
    struct RecordingSink {
        delivered: Mutex<Vec<IssueReport>>,
    }

    impl RecordingSink {
        fn delivered(&self) -> Vec<IssueReport> {
            self.delivered
                .lock()
                .expect("sink mutex should not be poisoned")
                .clone()
        }
    }

    #[async_trait]
    impl IssueReportSink for RecordingSink {
        async fn deliver(&self, report: IssueReport) -> Result<(), DomainError> {
            self.delivered
                .lock()
                .map_err(|_| DomainError::UpstreamProvider)?
                .push(report);
            Ok(())
        }
    }

    struct RecordingCompleter {
        behavior: CompleterBehavior,
        requests: Mutex<Vec<AgentChatRequest>>,
    }

    impl RecordingCompleter {
        fn with_behavior(behavior: CompleterBehavior) -> Self {
            Self {
                behavior,
                requests: Mutex::new(Vec::new()),
            }
        }

        fn call_count(&self) -> usize {
            self.requests
                .lock()
                .expect("request mutex should not be poisoned")
                .len()
        }

        fn requests(&self) -> Vec<AgentChatRequest> {
            self.requests
                .lock()
                .expect("request mutex should not be poisoned")
                .clone()
        }

        fn record_request(&self, request: AgentChatRequest) -> Result<(), DomainError> {
            self.requests
                .lock()
                .map_err(|_| DomainError::UpstreamProvider)?
                .push(request);
            Ok(())
        }
    }

    #[async_trait]
    impl AgentChatCompleter for RecordingCompleter {
        async fn complete(
            &self,
            request: AgentChatRequest,
        ) -> Result<AgentChatCompletion, DomainError> {
            self.record_request(request)?;
            match &self.behavior {
                CompleterBehavior::Text(text) => Ok(completion_with_text(text)),
                CompleterBehavior::Error => Err(DomainError::UpstreamProvider),
                CompleterBehavior::Delay => {
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    Ok(completion_with_text(
                        "**Issue 1 — Recorder freeze:**\nRoot-cause hypothesis: capture is blocked.\nSeverity guess: high, recording is unavailable.",
                    ))
                }
            }
        }
    }

    fn completion_with_text(text: &str) -> AgentChatCompletion {
        AgentChatCompletion {
            body: serde_json::json!({
                "choices": [{ "message": { "content": text } }],
                "usage": { "prompt_tokens": 1, "completion_tokens": 1 }
            })
            .to_string()
            .into_bytes(),
            content_type: "application/json".to_string(),
            provider: "test".to_string(),
            usage: TokenUsage {
                prompt_tokens: 1,
                completion_tokens: 1,
            },
        }
    }
}
