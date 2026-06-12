use async_trait::async_trait;
use scribe_config::SurveysConfig;
use scribe_domain::{DomainError, OnboardingSurvey, SurveySink};
use serde::Serialize;

/// Forwards onboarding survey answers as a JSON POST to the configured webhook.
pub struct WebhookSurveySink {
    http: reqwest::Client,
    webhook_url: String,
}

pub struct PostHogSurveySink {
    http: reqwest::Client,
    api_host: String,
    project_key: String,
}

impl PostHogSurveySink {
    pub fn from_config(http: reqwest::Client, config: &SurveysConfig) -> Option<Self> {
        let api_host = config.posthog_api_host.trim().trim_end_matches('/');
        let project_key = config.posthog_project_key.trim();
        if api_host.is_empty() || project_key.is_empty() {
            return None;
        }
        Some(Self {
            http,
            api_host: api_host.to_string(),
            project_key: project_key.to_string(),
        })
    }
}

#[async_trait]
impl SurveySink for PostHogSurveySink {
    async fn deliver(&self, survey: OnboardingSurvey) -> Result<(), DomainError> {
        let body = PostHogCaptureWire::from_survey(&self.project_key, &survey);
        let response = self
            .http
            .post(format!("{}/capture", self.api_host))
            .json(&body)
            .send()
            .await
            .map_err(|error| {
                tracing::error!(%error, "surveys: PostHog transport error");
                DomainError::UpstreamProvider
            })?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            tracing::error!(%status, body_bytes = body.len(), "surveys: PostHog rejected answer");
            return Err(DomainError::UpstreamProvider);
        }
        tracing::info!(
            user_id = %survey.user_id.0,
            source = survey.source.as_str(),
            app_version = survey.app_version.as_deref().unwrap_or(""),
            platform = survey.platform.as_deref().unwrap_or(""),
            "surveys: answer captured in PostHog"
        );
        Ok(())
    }
}

impl WebhookSurveySink {
    /// `None` when no webhook is configured. The caller falls back to the
    /// log sink so survey answers are never dropped silently.
    pub fn from_config(http: reqwest::Client, config: &SurveysConfig) -> Option<Self> {
        let webhook_url = config.webhook_url.trim();
        if webhook_url.is_empty() {
            return None;
        }
        Some(Self {
            http,
            webhook_url: webhook_url.to_string(),
        })
    }
}

#[async_trait]
impl SurveySink for WebhookSurveySink {
    async fn deliver(&self, survey: OnboardingSurvey) -> Result<(), DomainError> {
        let body = OnboardingSurveyWire::from(&survey);
        let response = self
            .http
            .post(&self.webhook_url)
            .json(&body)
            .send()
            .await
            .map_err(|error| {
                tracing::error!(%error, "surveys: webhook transport error");
                DomainError::UpstreamProvider
            })?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            tracing::error!(%status, body_bytes = body.len(), "surveys: webhook rejected answer");
            return Err(DomainError::UpstreamProvider);
        }
        tracing::info!(
            user_id = %survey.user_id.0,
            source = survey.source.as_str(),
            app_version = survey.app_version.as_deref().unwrap_or(""),
            platform = survey.platform.as_deref().unwrap_or(""),
            "surveys: answer forwarded to webhook"
        );
        Ok(())
    }
}

/// Fallback sink when no webhook is configured: the answer becomes a
/// structured log line, so it still reaches whoever reads deploy logs.
pub struct LogSurveySink;

#[async_trait]
impl SurveySink for LogSurveySink {
    async fn deliver(&self, survey: OnboardingSurvey) -> Result<(), DomainError> {
        tracing::warn!(
            user_id = %survey.user_id.0,
            source = survey.source.as_str(),
            app_version = survey.app_version.as_deref().unwrap_or(""),
            platform = survey.platform.as_deref().unwrap_or(""),
            "surveys: no webhook configured; answer logged only"
        );
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OnboardingSurveyWire<'a> {
    user_id: &'a str,
    source: &'a str,
    app_version: Option<&'a str>,
    platform: Option<&'a str>,
}

impl<'a> From<&'a OnboardingSurvey> for OnboardingSurveyWire<'a> {
    fn from(survey: &'a OnboardingSurvey) -> Self {
        Self {
            user_id: &survey.user_id.0,
            source: survey.source.as_str(),
            app_version: survey.app_version.as_deref(),
            platform: survey.platform.as_deref(),
        }
    }
}

#[derive(Serialize)]
struct PostHogCaptureWire<'a> {
    api_key: &'a str,
    event: &'static str,
    distinct_id: &'a str,
    properties: PostHogCaptureProperties<'a>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PostHogCaptureProperties<'a> {
    source: &'a str,
    app_version: Option<&'a str>,
    platform: Option<&'a str>,
}

impl<'a> PostHogCaptureWire<'a> {
    fn from_survey(project_key: &'a str, survey: &'a OnboardingSurvey) -> Self {
        Self {
            api_key: project_key,
            event: "onboarding discovery source submitted",
            distinct_id: &survey.user_id.0,
            properties: PostHogCaptureProperties {
                source: survey.source.as_str(),
                app_version: survey.app_version.as_deref(),
                platform: survey.platform.as_deref(),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use scribe_domain::{OnboardingSurveySource, UserId};
    use wiremock::{
        Mock, MockServer, ResponseTemplate,
        matchers::{body_json, method, path},
    };

    fn survey() -> OnboardingSurvey {
        OnboardingSurvey {
            user_id: UserId("usr_test".to_string()),
            source: OnboardingSurveySource::AiChat,
            app_version: Some("0.0.8".to_string()),
            platform: Some("macos".to_string()),
        }
    }

    #[test]
    fn webhook_sink_is_disabled_without_url() {
        let config = SurveysConfig::default();
        assert!(WebhookSurveySink::from_config(reqwest::Client::new(), &config).is_none());
    }

    #[test]
    fn posthog_sink_requires_host_and_project_key() {
        assert!(
            PostHogSurveySink::from_config(reqwest::Client::new(), &SurveysConfig::default())
                .is_none()
        );
        assert!(
            PostHogSurveySink::from_config(
                reqwest::Client::new(),
                &SurveysConfig {
                    posthog_api_host: "https://us.i.posthog.com".to_string(),
                    ..SurveysConfig::default()
                }
            )
            .is_none()
        );
        assert!(
            PostHogSurveySink::from_config(
                reqwest::Client::new(),
                &SurveysConfig {
                    posthog_project_key: "phc_test".to_string(),
                    ..SurveysConfig::default()
                }
            )
            .is_none()
        );
    }

    #[tokio::test]
    async fn posthog_sink_captures_the_survey_answer() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/capture"))
            .and(body_json(serde_json::json!({
                "api_key": "phc_test",
                "event": "onboarding discovery source submitted",
                "distinct_id": "usr_test",
                "properties": {
                    "source": "ai-chat",
                    "appVersion": "0.0.8",
                    "platform": "macos"
                }
            })))
            .respond_with(ResponseTemplate::new(200))
            .expect(1)
            .mount(&server)
            .await;
        let config = SurveysConfig {
            posthog_api_host: server.uri(),
            posthog_project_key: "phc_test".to_string(),
            ..SurveysConfig::default()
        };
        let sink =
            PostHogSurveySink::from_config(reqwest::Client::new(), &config).expect("posthog sink");

        sink.deliver(survey()).await.expect("survey captured");
    }

    #[tokio::test]
    async fn posthog_sink_returns_upstream_error_when_rejected() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/capture"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;
        let config = SurveysConfig {
            posthog_api_host: server.uri(),
            posthog_project_key: "phc_test".to_string(),
            ..SurveysConfig::default()
        };
        let sink =
            PostHogSurveySink::from_config(reqwest::Client::new(), &config).expect("posthog sink");

        assert_eq!(
            sink.deliver(survey()).await,
            Err(DomainError::UpstreamProvider)
        );
    }

    #[tokio::test]
    async fn webhook_sink_posts_the_survey_answer() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/survey"))
            .and(body_json(serde_json::json!({
                "userId": "usr_test",
                "source": "ai-chat",
                "appVersion": "0.0.8",
                "platform": "macos"
            })))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&server)
            .await;
        let config = SurveysConfig {
            webhook_url: format!("{}/survey", server.uri()),
            ..SurveysConfig::default()
        };
        let sink =
            WebhookSurveySink::from_config(reqwest::Client::new(), &config).expect("webhook sink");

        sink.deliver(survey()).await.expect("survey delivered");
    }

    #[tokio::test]
    async fn webhook_sink_returns_upstream_error_when_rejected() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/survey"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;
        let config = SurveysConfig {
            webhook_url: format!("{}/survey", server.uri()),
            ..SurveysConfig::default()
        };
        let sink =
            WebhookSurveySink::from_config(reqwest::Client::new(), &config).expect("webhook sink");

        assert_eq!(
            sink.deliver(survey()).await,
            Err(DomainError::UpstreamProvider)
        );
    }

    #[tokio::test]
    async fn log_sink_accepts_survey_answers() {
        LogSurveySink
            .deliver(survey())
            .await
            .expect("survey logged");
    }
}
