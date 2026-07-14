use async_trait::async_trait;
use axum::{
    body::Body,
    http::{Method, Request, StatusCode, header},
};
use june_api::{AttestationInfo, router};
use june_config::DEFAULT_MAX_IMAGE_EDIT_BYTES;
use june_domain::{
    AgentChatCompleter, AgentChatCompletion, AgentChatRequest, AgentChatStream, DomainError,
    GeneratedNote, GenerationRequest, Generator, IssueReport, IssueReportDelivery, IssueReportSink,
    P3aReport, Transcriber, Transcript, TranscriptionRequest, UserId,
};
use june_services::NOTE_GENERATE_PROMPT_VERSION;
use pretty_assertions::assert_eq;
use std::{
    error::Error,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tower::ServiceExt;

mod support;
use support::*;

#[tokio::test]
async fn integration_missing_auth_returns_unauthorized_envelope() -> Result<(), Box<dyn Error>> {
    let response = send(json_request(
        "/v1/notes/generate",
        &serde_json::json!({
            "noteId": "note-1",
            "promptVersion": "prompt-v1",
            "title": "Planning",
            "transcript": "Transcript",
            "model": "text-model"
        }),
        None,
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let body = response_json(response).await?;
    assert_eq!(body["success"], false);
    assert_eq!(body["error_code"], 3001);
    assert_eq!(body["message"], "missing_bearer_token");
    Ok(())
}

#[tokio::test]
async fn integration_note_generate_returns_enveloped_response() -> Result<(), Box<dyn Error>> {
    let response = send(json_request(
        "/v1/notes/generate",
        &serde_json::json!({
            "noteId": "note-1",
            "promptVersion": "prompt-v1",
            "title": "Planning",
            "transcript": "System: launch is Friday",
            "manualNotes": "Ask about rate limits",
            "model": "text-model"
        }),
        Some(AUTHORIZATION),
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok()),
        Some("application/json")
    );
    let body = response_json(response).await?;
    assert_eq!(body["success"], true);
    assert_eq!(body["data"]["content"], "Generated note body");
    assert_eq!(body["data"]["titleSuggestion"], "Generated title");
    assert_eq!(body["data"]["provider"], "fake-generator");
    assert_eq!(body["data"]["privacyLevel"], "no-retention");
    assert_eq!(body["data"]["upstreamEndpoint"], "venice-private");
    assert_eq!(body["data"]["promptVersion"], NOTE_GENERATE_PROMPT_VERSION);
    assert_eq!(body["data"]["creditsCharged"], 1);
    Ok(())
}

#[tokio::test]
async fn integration_note_generate_stream_returns_result_event() -> Result<(), Box<dyn Error>> {
    let buffered_response = send(json_request(
        "/v1/notes/generate",
        &note_generate_request(false),
        Some(AUTHORIZATION),
    )?)
    .await;
    assert_eq!(buffered_response.status(), StatusCode::OK);
    let buffered_body = response_json(buffered_response).await?;

    let response = send(json_request(
        "/v1/notes/generate",
        &note_generate_request(true),
        Some(AUTHORIZATION),
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok()),
        Some("text/event-stream")
    );
    let body = response_text(response).await?;
    let event_body = sse_event_data(&body, "result")?;
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&event_body)?,
        buffered_body
    );
    Ok(())
}

#[tokio::test]
async fn integration_note_generate_stream_returns_error_event() -> Result<(), Box<dyn Error>> {
    let request = serde_json::json!({
        "noteId": "note-1",
        "promptVersion": "prompt-v1",
        "title": "Planning",
        "transcript": "boom",
        "model": "text-model"
    });
    let buffered_response = send(json_request(
        "/v1/notes/generate",
        &request,
        Some(AUTHORIZATION),
    )?)
    .await;
    assert_eq!(buffered_response.status(), StatusCode::BAD_GATEWAY);
    let buffered_status = buffered_response.status().as_u16();
    let buffered_body = response_json(buffered_response).await?;

    let mut stream_request = request;
    stream_request["stream"] = serde_json::Value::Bool(true);
    let response = send(json_request(
        "/v1/notes/generate",
        &stream_request,
        Some(AUTHORIZATION),
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_text(response).await?;
    let event_body = serde_json::from_str::<serde_json::Value>(&sse_event_data(&body, "error")?)?;
    assert_eq!(event_body["status"], buffered_status);
    assert_eq!(event_body["body"], buffered_body);
    Ok(())
}

#[tokio::test]
async fn integration_note_generate_stream_sends_keep_alive_before_result()
-> Result<(), Box<dyn Error>> {
    let app = router(test_state_with_generator_and_timeout(
        Arc::new(SlowGenerator),
        30,
    ));
    let response = match app
        .oneshot(json_request(
            "/v1/notes/generate",
            &note_generate_request(true),
            Some(AUTHORIZATION),
        )?)
        .await
    {
        Ok(response) => response,
        Err(error) => match error {},
    };

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_text(response).await?;
    let keep_alive_index = body.find(": keep-alive").ok_or("missing keep-alive")?;
    let result_index = body.find("event: result").ok_or("missing result event")?;
    assert!(keep_alive_index < result_index);
    Ok(())
}

#[tokio::test]
async fn integration_p3a_report_uses_user_auth_and_forwards_anonymous_bucket()
-> Result<(), Box<dyn Error>> {
    let sink = Arc::new(RecordingP3aSink::default());
    let app = router(test_state_with_p3a_sink(sink.clone()));
    let response = match app
        .oneshot(json_request(
            "/v1/p3a/reports",
            &serde_json::json!({
                "schema": 1,
                "questionId": "onboarding.use-case.work",
                "epoch": "2026-W28",
                "platform": "macos",
                "versionSeries": "0.0.x",
                "bucket": 0,
            }),
            Some(AUTHORIZATION),
        )?)
        .await
    {
        Ok(response) => response,
        Err(error) => match error {},
    };

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await?;
    assert_eq!(body["success"], true);
    assert_eq!(body["data"]["accepted"], true);
    assert_eq!(
        sink.reports()?,
        vec![P3aReport {
            product_slug: "june".to_string(),
            question_id: "onboarding.use-case.work".to_string(),
            epoch: "2026-W28".to_string(),
            platform: "macos".to_string(),
            version_series: "0.0.x".to_string(),
            bucket: 0,
        }]
    );
    Ok(())
}

#[tokio::test]
async fn integration_note_generate_stream_auth_failure_stays_json_401() -> Result<(), Box<dyn Error>>
{
    let response = send(json_request(
        "/v1/notes/generate",
        &note_generate_request(true),
        None,
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok()),
        Some("application/json")
    );
    let body = response_json(response).await?;
    assert_eq!(body["success"], false);
    assert_eq!(body["error_code"], 3001);
    assert_eq!(body["message"], "missing_bearer_token");
    Ok(())
}

#[tokio::test]
async fn integration_p3a_report_requires_user_auth() -> Result<(), Box<dyn Error>> {
    let response = send(json_request(
        "/v1/p3a/reports",
        &serde_json::json!({
            "schema": 1,
            "questionId": "dictation.sessions",
            "epoch": "2026-W28",
            "platform": "macos",
            "versionSeries": "0.0.x",
            "bucket": 0,
        }),
        None,
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let body = response_json(response).await?;
    assert_eq!(body["success"], false);
    assert_eq!(body["message"], "missing_bearer_token");
    Ok(())
}

#[tokio::test]
async fn integration_agent_chat_stream_returns_upstream_sse_body() -> Result<(), Box<dyn Error>> {
    let response = send(json_request(
        "/v1/chat/completions",
        &serde_json::json!({
            "model": "text-model",
            "stream": true,
            "messages": [{ "role": "user", "content": "hello" }]
        }),
        Some(AUTHORIZATION),
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response
            .headers()
            .get("x-os-provider")
            .and_then(|value| value.to_str().ok()),
        Some("fake-chat")
    );
    assert_eq!(
        response
            .headers()
            .get("x-os-privacy-level")
            .and_then(|value| value.to_str().ok()),
        Some("no-retention")
    );
    assert_eq!(
        response
            .headers()
            .get("x-os-endpoint")
            .and_then(|value| value.to_str().ok()),
        Some("venice-private")
    );
    assert_eq!(
        response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok()),
        Some("text/event-stream")
    );
    let body = response_text(response).await?;
    assert_eq!(body, "data: {\"choices\":[]}\n\n");
    Ok(())
}

#[tokio::test]
async fn integration_agent_chat_routes_stale_model_through_auto() -> Result<(), Box<dyn Error>> {
    let response = send(json_request(
        "/v1/chat/completions",
        &serde_json::json!({
            "model": "retired-venice-model",
            "messages": [{ "role": "user", "content": "hello" }]
        }),
        Some(AUTHORIZATION),
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await?;
    assert_eq!(body["id"], "chatcmpl_test");
    Ok(())
}

#[tokio::test]
async fn integration_agent_chat_local_auto_fallback_strips_auto_policy()
-> Result<(), Box<dyn Error>> {
    let completer = Arc::new(RecordingChatCompleter::default());
    let app = router(test_state_with_local_text_pricing(
        Arc::new(FakeGenerator),
        completer.clone(),
    ));
    let response = match app
        .oneshot(json_request(
            "/v1/chat/completions",
            &serde_json::json!({
                "model": "open-software/auto",
                "auto": { "cost_quality": 0.75 },
                "messages": [{ "role": "user", "content": "hello" }]
            }),
            Some(AUTHORIZATION),
        )?)
        .await
    {
        Ok(response) => response,
        Err(error) => match error {},
    };

    assert_eq!(response.status(), StatusCode::OK);
    let requests = completer
        .requests
        .lock()
        .map_err(|_| "chat request mutex poisoned")?;
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].model.0, "zai-org-glm-5-2");
    assert!(requests[0].body.get("auto").is_none());
    assert!(!requests[0].body.to_string().contains("cost_quality"));
    Ok(())
}

#[tokio::test]
async fn integration_agent_chat_non_local_missing_auto_fails_loudly() -> Result<(), Box<dyn Error>>
{
    let app = router(test_state_with_text_pricing_without_auto(
        false,
        Arc::new(FakeGenerator),
        Arc::new(FakeChatCompleter),
    ));
    let response = match app
        .oneshot(json_request(
            "/v1/chat/completions",
            &serde_json::json!({
                "model": "open-software/auto",
                "messages": [{ "role": "user", "content": "hello" }]
            }),
            Some(AUTHORIZATION),
        )?)
        .await
    {
        Ok(response) => response,
        Err(error) => match error {},
    };

    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let body = response_json(response).await?;
    assert_eq!(body["message"], "model_not_priced");
    Ok(())
}

#[tokio::test]
async fn integration_agent_chat_local_auto_image_and_tools_falls_back_to_compatible_model()
-> Result<(), Box<dyn Error>> {
    let completer = Arc::new(RecordingChatCompleter::default());
    let app = router(test_state_with_local_text_pricing(
        Arc::new(FakeGenerator),
        completer.clone(),
    ));
    let response = match app
        .oneshot(json_request(
            "/v1/chat/completions",
            &serde_json::json!({
                "model": "open-software/auto",
                "auto": { "cost_quality": 0.75 },
                "messages": [{
                    "role": "user",
                    "content": [
                        { "type": "text", "text": "describe this image" },
                        {
                            "type": "image_url",
                            "image_url": { "url": "https://example.com/image.png" }
                        }
                    ]
                }],
                "tools": [{
                    "type": "function",
                    "function": {
                        "name": "save_description",
                        "parameters": { "type": "object" }
                    }
                }]
            }),
            Some(AUTHORIZATION),
        )?)
        .await
    {
        Ok(response) => response,
        Err(error) => match error {},
    };

    assert_eq!(response.status(), StatusCode::OK);
    let requests = completer
        .requests
        .lock()
        .map_err(|_| "chat request mutex poisoned")?;
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].model.0, "kimi-k2-6");
    assert!(requests[0].body.get("auto").is_none());
    assert!(requests[0].body.get("tools").is_some());
    Ok(())
}

#[tokio::test]
async fn integration_agent_chat_local_auto_rejects_when_capabilities_are_unavailable()
-> Result<(), Box<dyn Error>> {
    let app = router(
        test_state_with_text_pricing_without_auto_and_kimi_capabilities(
            true,
            Arc::new(FakeGenerator),
            Arc::new(FakeChatCompleter),
            vec!["supportsVision".to_string()],
        ),
    );
    let response = match app
        .oneshot(json_request(
            "/v1/chat/completions",
            &serde_json::json!({
                "model": "open-software/auto",
                "messages": [{
                    "role": "user",
                    "content": [{
                        "type": "image_url",
                        "image_url": { "url": "https://example.com/image.png" }
                    }]
                }],
                "tools": [{
                    "type": "function",
                    "function": {
                        "name": "save_description",
                        "parameters": { "type": "object" }
                    }
                }]
            }),
            Some(AUTHORIZATION),
        )?)
        .await
    {
        Ok(response) => response,
        Err(error) => match error {},
    };

    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let body = response_json(response).await?;
    assert_eq!(body["message"], "model_capability_unavailable");
    Ok(())
}

#[tokio::test]
async fn integration_note_generate_local_auto_fallback_omits_cost_quality()
-> Result<(), Box<dyn Error>> {
    let generator = Arc::new(RecordingGenerator::default());
    let app = router(test_state_with_local_text_pricing(
        generator.clone(),
        Arc::new(FakeChatCompleter),
    ));
    let response = match app
        .oneshot(json_request(
            "/v1/notes/generate",
            &serde_json::json!({
                "noteId": "note-local-auto",
                "promptVersion": "prompt-v1",
                "title": "Planning",
                "transcript": "System: launch is Friday",
                "model": "open-software/auto",
                "costQuality": 0.75
            }),
            Some(AUTHORIZATION),
        )?)
        .await
    {
        Ok(response) => response,
        Err(error) => match error {},
    };

    assert_eq!(response.status(), StatusCode::OK);
    let requests = generator
        .requests
        .lock()
        .map_err(|_| "generation request mutex poisoned")?;
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].model.0, "zai-org-glm-5-2");
    assert_eq!(requests[0].cost_quality, None);
    Ok(())
}

#[tokio::test]
async fn integration_agent_chat_rejects_byok_when_stale_model_would_fallback()
-> Result<(), Box<dyn Error>> {
    let response = send(json_request_with_venice_api_key(
        "/v1/chat/completions",
        &serde_json::json!({
            "model": "retired-venice-model",
            "messages": [{ "role": "user", "content": "hello" }]
        }),
        "opaque_user_venice_key",
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let body = response_json(response).await?;
    assert_eq!(body["message"], "venice_api_key_model_unavailable");
    Ok(())
}

#[tokio::test]
async fn integration_note_generate_rejects_byok_when_stale_model_would_fallback()
-> Result<(), Box<dyn Error>> {
    let response = send(json_request_with_venice_api_key(
        "/v1/notes/generate",
        &serde_json::json!({
            "noteId": "note-1",
            "promptVersion": "prompt-v1",
            "title": "Planning",
            "transcript": "System: launch is Friday",
            "model": "retired-venice-model"
        }),
        "opaque_user_venice_key",
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let body = response_json(response).await?;
    assert_eq!(body["success"], false);
    assert_eq!(body["message"], "venice_api_key_model_unavailable");
    Ok(())
}

#[tokio::test]
async fn integration_note_generate_forwards_venice_api_key_header() -> Result<(), Box<dyn Error>> {
    let response = send(json_request_with_venice_api_key(
        "/v1/notes/generate",
        &serde_json::json!({
            "noteId": "note-1",
            "promptVersion": "prompt-v1",
            "title": "Planning",
            "transcript": "System: launch is Friday",
            "model": "venice-text-model"
        }),
        "opaque_user_venice_key",
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await?;
    assert_eq!(body["success"], true);
    assert_eq!(
        body["data"]["content"],
        "Generated note body with user Venice key"
    );
    assert!(!body.to_string().contains("opaque_user_venice_key"));
    Ok(())
}

#[tokio::test]
async fn integration_note_generate_rejects_byok_for_current_non_venice_model()
-> Result<(), Box<dyn Error>> {
    let response = send(json_request_with_venice_api_key(
        "/v1/notes/generate",
        &serde_json::json!({
            "noteId": "note-1",
            "promptVersion": "prompt-v1",
            "title": "Planning",
            "transcript": "System: launch is Friday",
            "model": "text-model"
        }),
        "opaque_user_venice_key",
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let body = response_json(response).await?;
    assert_eq!(body["success"], false);
    assert_eq!(body["message"], "venice_api_key_model_unavailable");
    Ok(())
}

#[tokio::test]
async fn integration_note_generate_rejects_malformed_venice_api_key_header()
-> Result<(), Box<dyn Error>> {
    let response = send(json_request_with_venice_api_key(
        "/v1/notes/generate",
        &serde_json::json!({
            "noteId": "note-1",
            "promptVersion": "prompt-v1",
            "title": "Planning",
            "transcript": "System: launch is Friday",
            "model": "text-model"
        }),
        &"x".repeat(4_097),
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response_json(response).await?;
    assert_eq!(body["success"], false);
    assert_eq!(body["message"], "venice_api_key_too_long");
    Ok(())
}

#[tokio::test]
async fn integration_note_generate_rejects_wrong_model_kind() -> Result<(), Box<dyn Error>> {
    let response = send(json_request(
        "/v1/notes/generate",
        &serde_json::json!({
            "noteId": "note-1",
            "promptVersion": "prompt-v1",
            "title": "Planning",
            "transcript": "Transcript",
            "model": "asr-model"
        }),
        Some(AUTHORIZATION),
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let body = response_json(response).await?;
    assert_eq!(body["success"], false);
    assert_eq!(body["message"], "model_type_invalid");
    Ok(())
}

#[tokio::test]
async fn integration_issue_report_requires_auth() -> Result<(), Box<dyn Error>> {
    let response = send(multipart_request_with_auth(
        "/v1/issue-reports",
        multipart_body([text_part("description", "The recorder freezes")]),
        None,
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let body = response_json(response).await?;
    assert_eq!(body["success"], false);
    assert_eq!(body["error_code"], 3001);
    Ok(())
}

#[tokio::test]
async fn integration_issue_report_rejects_blank_description() -> Result<(), Box<dyn Error>> {
    let response = send(multipart_request(
        "/v1/issue-reports",
        multipart_body([text_part("description", "   ")]),
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response_json(response).await?;
    assert_eq!(body["success"], false);
    assert_eq!(body["message"], "description_required");
    Ok(())
}

#[tokio::test]
async fn integration_issue_report_delivers_attachments_to_the_sink() -> Result<(), Box<dyn Error>> {
    let sink = Arc::new(RecordingIssueReportSink {
        delivery: IssueReportDelivery {
            unattached_names: vec!["recording.mov".to_string()],
        },
        ..RecordingIssueReportSink::default()
    });
    let router = router(test_state_with_issue_sink(sink.clone(), test_attestation()));
    // The legacy June-only cap was 10 MiB. Crossing it proves the video bytes
    // now reach the authenticated June API boundary instead of being dropped
    // by the desktop before submission.
    let recording_bytes = vec![0x5a; (10 * 1024 * 1024) + 1];

    let response = match router
        .oneshot(multipart_request(
            "/v1/issue-reports",
            multipart_body([
                text_part("description", "The recorder freezes after a long meeting"),
                text_part("category", "feedback"),
                text_part(
                    "agentDiagnosis",
                    "Likely the audio capture thread is blocked",
                ),
                text_part("attachmentName", "screenshot.png"),
                text_part("attachmentName", "recording.mov"),
                text_part("sessionId", "session-9"),
                text_part("appVersion", "0.0.5"),
                text_part("platform", "macos"),
                typed_file_part(
                    "attachment",
                    "screenshot.png",
                    "image/png",
                    b"fake-png-bytes".to_vec(),
                ),
                // JUN-238: a second attachment part must survive the boundary
                // alongside the first.
                typed_file_part(
                    "attachment",
                    "recording.mov",
                    "video/quicktime",
                    recording_bytes.clone(),
                ),
            ]),
        )?)
        .await
    {
        Ok(response) => response,
        Err(error) => match error {},
    };

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await?;
    assert_eq!(body["success"], true);
    assert_eq!(body["data"]["received"], true);
    assert_eq!(
        body["data"]["skippedAttachmentNames"],
        serde_json::json!(["recording.mov"])
    );

    let Ok(reports) = sink.reports.lock() else {
        return Err("sink mutex poisoned".into());
    };
    assert_eq!(reports.len(), 1);
    assert_eq!(reports[0].user_id, UserId("usr_test".to_string()));
    assert_eq!(
        reports[0].description,
        "The recorder freezes after a long meeting"
    );
    assert_eq!(reports[0].category.as_deref(), Some("feedback"));
    assert_eq!(
        reports[0].agent_diagnosis.as_deref(),
        Some("Likely the audio capture thread is blocked")
    );
    assert_eq!(
        reports[0].attachment_names,
        vec!["screenshot.png", "recording.mov"]
    );
    assert_eq!(reports[0].session_id.as_deref(), Some("session-9"));
    assert_eq!(reports[0].attachments.len(), 2);
    assert_eq!(reports[0].attachments[0].name, "screenshot.png");
    assert_eq!(reports[0].attachments[0].content_type, "image/png");
    assert_eq!(reports[0].attachments[0].bytes, b"fake-png-bytes".to_vec());
    assert_eq!(reports[0].attachments[1].name, "recording.mov");
    assert_eq!(reports[0].attachments[1].content_type, "video/quicktime");
    assert_eq!(reports[0].attachments[1].bytes.len(), recording_bytes.len());
    assert!(
        reports[0].attachments[1]
            .bytes
            .iter()
            .all(|byte| *byte == 0x5a)
    );
    Ok(())
}

#[tokio::test]
async fn integration_issue_report_stream_opt_in_preserves_buffered_json()
-> Result<(), Box<dyn Error>> {
    let sink = Arc::new(RecordingIssueReportSink {
        delivery: IssueReportDelivery {
            unattached_names: vec!["clip.mov".to_string()],
        },
        ..RecordingIssueReportSink::default()
    });
    let app = router(test_state_with_issue_sink(sink, test_attestation()));

    let buffered_response = match app
        .clone()
        .oneshot(multipart_request(
            "/v1/issue-reports",
            multipart_body([text_part("description", "Buffered report")]),
        )?)
        .await
    {
        Ok(response) => response,
        Err(error) => match error {},
    };
    assert_eq!(buffered_response.status(), StatusCode::OK);
    assert_eq!(
        buffered_response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok()),
        Some("application/json")
    );
    let buffered_body = response_json(buffered_response).await?;

    let streamed_response = match app
        .oneshot(multipart_request(
            "/v1/issue-reports",
            multipart_body([
                text_part("description", "Streamed report"),
                text_part("stream", "true"),
            ]),
        )?)
        .await
    {
        Ok(response) => response,
        Err(error) => match error {},
    };
    assert_eq!(streamed_response.status(), StatusCode::OK);
    assert_eq!(
        streamed_response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok()),
        Some("text/event-stream")
    );
    let streamed_body = response_text(streamed_response).await?;
    let event_body = sse_event_data(&streamed_body, "result")?;
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&event_body)?,
        buffered_body
    );
    Ok(())
}

#[tokio::test]
async fn integration_issue_report_stream_returns_compatible_error_event()
-> Result<(), Box<dyn Error>> {
    let app = router(test_state_with_issue_sink(
        Arc::new(FailingIssueReportSink),
        test_attestation(),
    ));

    let buffered_response = match app
        .clone()
        .oneshot(multipart_request(
            "/v1/issue-reports",
            multipart_body([text_part("description", "Buffered failure")]),
        )?)
        .await
    {
        Ok(response) => response,
        Err(error) => match error {},
    };
    assert_eq!(buffered_response.status(), StatusCode::BAD_GATEWAY);
    let buffered_status = buffered_response.status().as_u16();
    let buffered_body = response_json(buffered_response).await?;

    let streamed_response = match app
        .oneshot(multipart_request(
            "/v1/issue-reports",
            multipart_body([
                text_part("description", "Streamed failure"),
                text_part("stream", "true"),
            ]),
        )?)
        .await
    {
        Ok(response) => response,
        Err(error) => match error {},
    };
    assert_eq!(streamed_response.status(), StatusCode::OK);
    let streamed_body = response_text(streamed_response).await?;
    let event_body =
        serde_json::from_str::<serde_json::Value>(&sse_event_data(&streamed_body, "error")?)?;
    assert_eq!(event_body["status"], buffered_status);
    assert_eq!(event_body["body"], buffered_body);
    Ok(())
}

#[tokio::test]
async fn integration_issue_report_stream_sends_keep_alive_before_result()
-> Result<(), Box<dyn Error>> {
    let app = router(test_state_with_issue_sink_and_timeout(
        Arc::new(SlowIssueReportSink),
        test_attestation(),
        30,
    ));
    let response = match app
        .oneshot(multipart_request(
            "/v1/issue-reports",
            multipart_body([
                text_part("description", "Slow report"),
                text_part("stream", "true"),
            ]),
        )?)
        .await
    {
        Ok(response) => response,
        Err(error) => match error {},
    };

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_text(response).await?;
    let keep_alive_index = body.find(": keep-alive").ok_or("missing keep-alive")?;
    let result_index = body.find("event: result").ok_or("missing result event")?;
    assert!(keep_alive_index < result_index);
    Ok(())
}

#[tokio::test]
async fn integration_issue_report_permit_survives_stream_disconnect_until_delivery_finishes()
-> Result<(), Box<dyn Error>> {
    let sink = Arc::new(BlockingIssueReportSink::new());
    let app = router(test_state_with_issue_sink_and_timeout(
        sink.clone(),
        test_attestation(),
        30,
    ));
    let first_response = match app
        .clone()
        .oneshot(multipart_request(
            "/v1/issue-reports",
            multipart_body([
                text_part("description", "First report"),
                text_part("stream", "true"),
            ]),
        )?)
        .await
    {
        Ok(response) => response,
        Err(error) => match error {},
    };
    tokio::time::timeout(Duration::from_secs(1), sink.wait_until_started(1)).await?;

    // Dropping the response simulates the production ingress closing its
    // upstream response stream or the desktop client disconnecting. Delivery
    // is still blocked in the background and must continue holding the permit.
    drop(first_response);
    let second = app.oneshot(multipart_request(
        "/v1/issue-reports",
        multipart_body([
            text_part("description", "Second report"),
            text_part("stream", "true"),
        ]),
    )?);
    tokio::pin!(second);
    assert!(
        tokio::time::timeout(Duration::from_millis(100), &mut second)
            .await
            .is_err(),
        "second report entered while disconnected first delivery was running"
    );
    assert_eq!(sink.started.load(Ordering::SeqCst), 1);

    sink.release.add_permits(1);
    let second_response = match tokio::time::timeout(Duration::from_secs(1), &mut second).await? {
        Ok(response) => response,
        Err(error) => match error {},
    };
    tokio::time::timeout(Duration::from_secs(1), sink.wait_until_started(2)).await?;
    drop(second_response);
    sink.release.add_permits(1);
    Ok(())
}

#[tokio::test]
async fn integration_issue_report_stream_deadline_includes_permit_wait()
-> Result<(), Box<dyn Error>> {
    let sink = Arc::new(DeadlineBudgetIssueReportSink::new());
    let app = router(test_state_with_issue_sink_and_timeout(
        sink.clone(),
        test_attestation(),
        1,
    ));
    let first_response = match app
        .clone()
        .oneshot(multipart_request(
            "/v1/issue-reports",
            multipart_body([
                text_part("description", "Permit holder"),
                text_part("stream", "true"),
            ]),
        )?)
        .await
    {
        Ok(response) => response,
        Err(error) => match error {},
    };
    tokio::time::timeout(Duration::from_secs(1), sink.wait_until_first_started()).await?;
    drop(first_response);

    // The second request establishes its one-second deadline before waiting
    // for the first report's permit. Spend most of that budget queued, then let
    // its 500ms delivery run: a reset-at-headers timer would return success,
    // while the shared absolute deadline must emit timeout.
    let second = tokio::spawn(app.oneshot(multipart_request(
        "/v1/issue-reports",
        multipart_body([
            text_part("description", "Deadline consumer"),
            text_part("stream", "true"),
        ]),
    )?));
    tokio::task::yield_now().await;
    tokio::time::sleep(Duration::from_millis(700)).await;
    sink.release_first.add_permits(1);

    let second_response = match tokio::time::timeout(Duration::from_secs(1), second).await?? {
        Ok(response) => response,
        Err(error) => match error {},
    };
    assert_eq!(second_response.status(), StatusCode::OK);
    let body = response_text(second_response).await?;
    let event = serde_json::from_str::<serde_json::Value>(&sse_event_data(&body, "error")?)?;
    assert_eq!(event["status"], StatusCode::GATEWAY_TIMEOUT.as_u16());
    assert_eq!(event["body"]["message"], "timeout");
    Ok(())
}

#[tokio::test]
async fn integration_note_transcribe_accepts_valid_audio_multipart() -> Result<(), Box<dyn Error>> {
    let response = send(multipart_request(
        "/v1/notes/transcribe",
        multipart_body([
            text_part("model", "asr-model"),
            text_part("title", "Standup"),
            text_part("noteId", "note-1"),
            text_part("context", "Previous transcript context"),
            text_part("language", "en"),
            file_part("audio", "recording.wav", valid_wav()),
        ]),
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await?;
    assert_eq!(body["success"], true);
    assert_eq!(body["data"]["text"], "Transcribed audio");
    assert_eq!(body["data"]["language"], "en");
    assert_eq!(body["data"]["provider"], "fake-transcriber");
    Ok(())
}

#[tokio::test]
async fn integration_note_transcribe_routes_retired_asr_model_through_priced_fallback()
-> Result<(), Box<dyn Error>> {
    let response = send(multipart_request(
        "/v1/notes/transcribe",
        multipart_body([
            text_part("model", "retired-asr-model"),
            text_part("title", "Standup"),
            text_part("noteId", "note-stale-asr"),
            file_part("audio", "recording.wav", valid_wav()),
        ]),
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await?;
    assert_eq!(body["success"], true);
    assert_eq!(body["data"]["text"], "Transcribed audio");
    Ok(())
}

#[tokio::test]
async fn integration_note_transcribe_keeps_byok_for_current_venice_model()
-> Result<(), Box<dyn Error>> {
    let response = send(multipart_request_with_venice_api_key(
        "/v1/notes/transcribe",
        multipart_body([
            text_part("model", "nvidia/parakeet-tdt-0.6b-v3"),
            text_part("title", "Standup"),
            text_part("noteId", "note-1"),
            file_part("audio", "recording.wav", valid_wav()),
        ]),
        "opaque_user_venice_key",
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await?;
    assert_eq!(body["success"], true);
    assert_eq!(body["data"]["text"], "Transcribed audio");
    Ok(())
}

#[tokio::test]
async fn integration_note_transcribe_rejects_byok_for_current_non_venice_model()
-> Result<(), Box<dyn Error>> {
    let response = send(multipart_request_with_venice_api_key(
        "/v1/notes/transcribe",
        multipart_body([
            text_part("model", "asr-model"),
            text_part("title", "Standup"),
            text_part("noteId", "note-1"),
            file_part("audio", "recording.wav", valid_wav()),
        ]),
        "opaque_user_venice_key",
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let body = response_json(response).await?;
    assert_eq!(body["success"], false);
    assert_eq!(body["message"], "venice_api_key_model_unavailable");
    Ok(())
}

#[tokio::test]
async fn integration_note_transcribe_rejects_unsupported_audio() -> Result<(), Box<dyn Error>> {
    let response = send(multipart_request(
        "/v1/notes/transcribe",
        multipart_body([
            text_part("model", "asr-model"),
            text_part("title", "Standup"),
            text_part("noteId", "note-1"),
            file_part("audio", "recording.txt", b"not-audio".to_vec()),
        ]),
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response_json(response).await?;
    assert_eq!(body["success"], false);
    assert_eq!(body["message"], "unsupported_audio_format");
    Ok(())
}

#[tokio::test]
async fn integration_dictate_routes_retired_asr_model_through_priced_fallback()
-> Result<(), Box<dyn Error>> {
    let response = send(multipart_request(
        "/v1/dictate",
        multipart_body([
            text_part("model", "retired-asr-model"),
            text_part("sessionId", "session-stale-asr"),
            text_part("utteranceId", "utterance-stale-asr"),
            file_part("audio", "dictation.wav", valid_wav()),
        ]),
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await?;
    assert_eq!(body["success"], true);
    assert_eq!(body["data"]["text"], "Transcribed audio");
    Ok(())
}

#[tokio::test]
async fn integration_dictate_keeps_byok_when_retired_asr_model_falls_back_to_venice()
-> Result<(), Box<dyn Error>> {
    let response = send(multipart_request_with_venice_api_key(
        "/v1/dictate",
        multipart_body([
            text_part("model", "retired-asr-model"),
            text_part("sessionId", "session-stale-asr"),
            text_part("utteranceId", "utterance-stale-asr"),
            file_part("audio", "dictation.wav", valid_wav()),
        ]),
        "opaque_user_venice_key",
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await?;
    assert_eq!(body["success"], true);
    assert_eq!(body["data"]["text"], "Transcribed audio");
    Ok(())
}

#[tokio::test]
async fn integration_dictate_fills_language_when_provider_returns_none()
-> Result<(), Box<dyn Error>> {
    // Venice ASR never returns a detected language, so the provider yields
    // `None` and the service must fill it in from the transcript text (JUN-180).
    let state = test_state_with_sinks_and_transcriber(
        test_issue_report_service(Arc::new(RecordingIssueReportSink::default())),
        test_attestation(),
        Arc::new(LanguagelessTranscriber),
    );
    let response = match router(state)
        .oneshot(multipart_request(
            "/v1/dictate",
            multipart_body([
                text_part("model", "asr-model"),
                text_part("sessionId", "session-1"),
                text_part("utteranceId", "utterance-1"),
                file_part("audio", "dictation.wav", valid_wav()),
            ]),
        )?)
        .await
    {
        Ok(response) => response,
        Err(error) => match error {},
    };

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await?;
    assert_eq!(body["success"], true);
    assert_eq!(body["data"]["language"], "en");
    Ok(())
}

#[tokio::test]
async fn integration_dictate_prefers_requested_language_over_detection()
-> Result<(), Box<dyn Error>> {
    // When the user configured a dictation language, that explicit choice must
    // reach enrichment and win over text detection (JUN-180 P2). The transcript
    // text is English, but the request asks for Polish.
    let state = test_state_with_sinks_and_transcriber(
        test_issue_report_service(Arc::new(RecordingIssueReportSink::default())),
        test_attestation(),
        Arc::new(LanguagelessTranscriber),
    );
    let response = match router(state)
        .oneshot(multipart_request(
            "/v1/dictate",
            multipart_body([
                text_part("model", "asr-model"),
                text_part("sessionId", "session-1"),
                text_part("utteranceId", "utterance-1"),
                text_part("language", "pl"),
                file_part("audio", "dictation.wav", valid_wav()),
            ]),
        )?)
        .await
    {
        Ok(response) => response,
        Err(error) => match error {},
    };

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await?;
    assert_eq!(body["success"], true);
    assert_eq!(body["data"]["language"], "pl");
    Ok(())
}

#[tokio::test]
async fn integration_dictate_cleanup_returns_enveloped_response() -> Result<(), Box<dyn Error>> {
    let response = send(json_request(
        "/v1/dictate/cleanup",
        &serde_json::json!({
            "sessionId": "session-1",
            "utteranceId": "utterance-1",
            "text": "hello june",
            "dictionaryContext": "June",
            "style": "standard",
            "model": "text-model"
        }),
        Some(AUTHORIZATION),
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await?;
    assert_eq!(body["success"], true);
    assert_eq!(body["data"]["text"], "Cleaned dictation");
    assert_eq!(body["data"]["creditsCharged"], 0);
    Ok(())
}

#[tokio::test]
async fn integration_web_search_returns_enveloped_results() -> Result<(), Box<dyn Error>> {
    let response = send(json_request(
        "/v1/web/search",
        &serde_json::json!({ "query": "rust async", "limit": 5, "requestId": "req-1" }),
        Some(AUTHORIZATION),
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await?;
    assert_eq!(body["success"], true);
    assert_eq!(body["data"]["provider"], "brave");
    assert_eq!(body["data"]["results"][0]["title"], "Result one");
    assert_eq!(body["data"]["results"][0]["url"], "https://example.com/one");
    Ok(())
}

#[tokio::test]
async fn integration_web_search_requires_auth() -> Result<(), Box<dyn Error>> {
    let response = send(json_request(
        "/v1/web/search",
        &serde_json::json!({ "query": "rust async", "requestId": "req-1" }),
        None,
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let body = response_json(response).await?;
    assert_eq!(body["success"], false);
    assert_eq!(body["error_code"], 3001);
    Ok(())
}

#[tokio::test]
async fn integration_web_search_rejects_blank_query() -> Result<(), Box<dyn Error>> {
    let response = send(json_request(
        "/v1/web/search",
        &serde_json::json!({ "query": "   ", "requestId": "req-1" }),
        Some(AUTHORIZATION),
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response_json(response).await?;
    assert_eq!(body["success"], false);
    assert_eq!(body["message"], "query_required");
    Ok(())
}

#[tokio::test]
async fn integration_web_search_requires_request_id() -> Result<(), Box<dyn Error>> {
    let response = send(json_request(
        "/v1/web/search",
        &serde_json::json!({ "query": "rust async" }),
        Some(AUTHORIZATION),
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response_json(response).await?;
    assert_eq!(body["success"], false);
    assert_eq!(body["message"], "request_id_required");
    Ok(())
}

#[tokio::test]
async fn integration_web_fetch_returns_markdown() -> Result<(), Box<dyn Error>> {
    let response = send(json_request(
        "/v1/web/fetch",
        &serde_json::json!({ "url": "https://93.184.216.34/post", "requestId": "req-1" }),
        Some(AUTHORIZATION),
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await?;
    assert_eq!(body["success"], true);
    assert_eq!(body["data"]["url"], "https://93.184.216.34/post");
    assert_eq!(body["data"]["format"], "markdown");
    assert_eq!(body["data"]["content"], "# Heading\n\nBody.");
    Ok(())
}

#[tokio::test]
async fn integration_web_fetch_forwards_canonical_url() -> Result<(), Box<dyn Error>> {
    let response = send(json_request(
        "/v1/web/fetch",
        &serde_json::json!({
            "url": "http://93.184.216.34\\@169.254.169.254/",
            "requestId": "req-1"
        }),
        Some(AUTHORIZATION),
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await?;
    assert_eq!(body["success"], true);
    assert_eq!(
        body["data"]["url"],
        "http://93.184.216.34/@169.254.169.254/"
    );
    Ok(())
}

#[tokio::test]
async fn integration_web_fetch_blocked_site_returns_bad_request() -> Result<(), Box<dyn Error>> {
    let response = send(json_request(
        "/v1/web/fetch",
        &serde_json::json!({ "url": "https://93.184.216.34/x.com/some/post", "requestId": "req-1" }),
        Some(AUTHORIZATION),
    )?)
    .await;

    // A site Venice refuses to scrape surfaces as a usable 400, not a 502.
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response_json(response).await?;
    assert_eq!(body["success"], false);
    assert_eq!(body["message"], "web_fetch_unsupported_url");
    Ok(())
}

#[tokio::test]
async fn integration_web_fetch_rejects_non_http_url() -> Result<(), Box<dyn Error>> {
    let response = send(json_request(
        "/v1/web/fetch",
        &serde_json::json!({ "url": "file:///etc/passwd", "requestId": "req-1" }),
        Some(AUTHORIZATION),
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response_json(response).await?;
    assert_eq!(body["success"], false);
    assert_eq!(body["message"], "url_must_be_http");
    Ok(())
}

#[tokio::test]
async fn integration_web_fetch_rejects_private_network_url() -> Result<(), Box<dyn Error>> {
    let response = send(json_request(
        "/v1/web/fetch",
        &serde_json::json!({
            "url": "http://169.254.169.254/latest/meta-data",
            "requestId": "req-1"
        }),
        Some(AUTHORIZATION),
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response_json(response).await?;
    assert_eq!(body["success"], false);
    assert_eq!(body["message"], "url_must_be_public_http");
    Ok(())
}

#[tokio::test]
async fn integration_image_generate_returns_enveloped_image() -> Result<(), Box<dyn Error>> {
    let response = send(json_request(
        "/v1/image/generate",
        &serde_json::json!({ "prompt": "a red bicycle", "model": "venice-sd35" }),
        Some(AUTHORIZATION),
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await?;
    assert_eq!(body["success"], true);
    assert_eq!(body["data"]["imageBase64"], "aGVsbG8=");
    assert_eq!(body["data"]["mimeType"], "image/png");
    assert_eq!(body["data"]["model"], "venice-sd35");
    assert_eq!(body["data"]["provider"], "fake-image");
    Ok(())
}

#[tokio::test]
async fn integration_image_generate_requires_auth() -> Result<(), Box<dyn Error>> {
    let response = send(json_request(
        "/v1/image/generate",
        &serde_json::json!({ "prompt": "a red bicycle", "model": "venice-sd35" }),
        None,
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let body = response_json(response).await?;
    assert_eq!(body["success"], false);
    assert_eq!(body["error_code"], 3001);
    Ok(())
}

#[tokio::test]
async fn integration_image_generate_rejects_blank_prompt() -> Result<(), Box<dyn Error>> {
    let response = send(json_request(
        "/v1/image/generate",
        &serde_json::json!({ "prompt": "   ", "model": "venice-sd35" }),
        Some(AUTHORIZATION),
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response_json(response).await?;
    assert_eq!(body["success"], false);
    assert_eq!(body["message"], "prompt_required");
    Ok(())
}

#[tokio::test]
async fn integration_image_generate_maps_upstream_failure_to_502() -> Result<(), Box<dyn Error>> {
    let response = send(json_request(
        "/v1/image/generate",
        &serde_json::json!({ "prompt": "boom", "model": "venice-sd35" }),
        Some(AUTHORIZATION),
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    let body = response_json(response).await?;
    assert_eq!(body["success"], false);
    assert_eq!(body["message"], "upstream_provider_failed");
    Ok(())
}

#[tokio::test]
async fn integration_image_generate_rejects_unpriced_model() -> Result<(), Box<dyn Error>> {
    // A model with no configured image price is rejected at the metering
    // boundary (before Venice is called) rather than generating for free.
    let response = send(json_request(
        "/v1/image/generate",
        &serde_json::json!({ "prompt": "a red bicycle", "model": "unpriced-image-model" }),
        Some(AUTHORIZATION),
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let body = response_json(response).await?;
    assert_eq!(body["success"], false);
    assert_eq!(body["message"], "model_not_priced");
    Ok(())
}

#[tokio::test]
async fn integration_image_edit_returns_enveloped_image() -> Result<(), Box<dyn Error>> {
    // No model is sent (the image MCP names none); the default edit model is used
    // and its base64 result comes back in the standard envelope.
    let response = send(json_request(
        "/v1/image/edit",
        &serde_json::json!({ "image": "aGVsbG8=", "prompt": "make it fluffier" }),
        Some(AUTHORIZATION),
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await?;
    assert_eq!(body["success"], true);
    assert_eq!(body["data"]["imageBase64"], "ZWRpdGVk");
    assert_eq!(body["data"]["mimeType"], "image/png");
    assert_eq!(body["data"]["model"], "firered-image-edit");
    Ok(())
}

#[tokio::test]
async fn integration_image_edit_requires_a_source_image() -> Result<(), Box<dyn Error>> {
    let response = send(json_request(
        "/v1/image/edit",
        &serde_json::json!({ "image": "   ", "prompt": "make it fluffier" }),
        Some(AUTHORIZATION),
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response_json(response).await?;
    assert_eq!(body["success"], false);
    assert_eq!(body["message"], "image_required");
    Ok(())
}

#[tokio::test]
async fn integration_image_edit_maps_upstream_failure_to_502() -> Result<(), Box<dyn Error>> {
    let response = send(json_request(
        "/v1/image/edit",
        &serde_json::json!({ "image": "aGVsbG8=", "prompt": "boom" }),
        Some(AUTHORIZATION),
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    let body = response_json(response).await?;
    assert_eq!(body["success"], false);
    assert_eq!(body["message"], "upstream_provider_failed");
    Ok(())
}

#[tokio::test]
async fn integration_image_edit_accepts_body_at_configured_limit() -> Result<(), Box<dyn Error>> {
    let body = image_edit_body_with_len(DEFAULT_MAX_IMAGE_EDIT_BYTES)?;
    let router = router(test_state());
    let response = match router
        .oneshot(raw_json_request_with_venice_api_key(
            "/v1/image/edit",
            body,
            "VENICE_INFERENCE_KEY_user",
        )?)
        .await
    {
        Ok(response) => response,
        Err(error) => match error {},
    };

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await?;
    assert_eq!(body["success"], true);
    assert_eq!(body["data"]["imageBase64"], "ZWRpdGVk");
    Ok(())
}

#[tokio::test]
async fn integration_image_edit_rejects_body_over_configured_limit() -> Result<(), Box<dyn Error>> {
    let body = format!(
        "{} ",
        image_edit_body_with_len(DEFAULT_MAX_IMAGE_EDIT_BYTES)?
    );
    let router = router(test_state());
    let response = match router
        .oneshot(raw_json_request_with_venice_api_key(
            "/v1/image/edit",
            body,
            "VENICE_INFERENCE_KEY_user",
        )?)
        .await
    {
        Ok(response) => response,
        Err(error) => match error {},
    };

    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    Ok(())
}

#[tokio::test]
async fn integration_video_generate_returns_job_id() -> Result<(), Box<dyn Error>> {
    let response = send(json_request(
        "/v1/video/generate",
        &serde_json::json!({
            "prompt": "a robot dancing",
            "model": "wan-2.2-a14b-text-to-video",
            "duration": "5s",
        }),
        Some(AUTHORIZATION),
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await?;
    assert_eq!(body["success"], true);
    assert!(
        body["data"]["jobId"]
            .as_str()
            .is_some_and(|id| !id.is_empty()),
        "expected a non-empty jobId, got {body}"
    );
    Ok(())
}

#[tokio::test]
async fn integration_video_generate_rejects_blank_duration() -> Result<(), Box<dyn Error>> {
    let response = send(json_request(
        "/v1/video/generate",
        &serde_json::json!({
            "prompt": "a robot dancing",
            "model": "wan-2.2-a14b-text-to-video",
        }),
        Some(AUTHORIZATION),
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response_json(response).await?;
    assert_eq!(body["message"], "duration_required");
    Ok(())
}

#[tokio::test]
async fn integration_video_generate_rejects_unpriced_model() -> Result<(), Box<dyn Error>> {
    let response = send(json_request(
        "/v1/video/generate",
        &serde_json::json!({
            "prompt": "a robot dancing",
            "model": "unpriced-video-model",
            "duration": "5s",
        }),
        Some(AUTHORIZATION),
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let body = response_json(response).await?;
    assert_eq!(body["message"], "model_not_priced");
    Ok(())
}

#[tokio::test]
async fn integration_video_status_reports_processing_json() -> Result<(), Box<dyn Error>> {
    // Generate and status must hit the SAME state (the in-process job registry),
    // so drive both against one router rather than a fresh `send`.
    let router = test_router();
    let generate = match router
        .clone()
        .oneshot(json_request(
            "/v1/video/generate",
            &serde_json::json!({
                "prompt": "a robot dancing",
                "model": "wan-2.2-a14b-text-to-video",
                "duration": "5s",
            }),
            Some(AUTHORIZATION),
        )?)
        .await
    {
        Ok(response) => response,
        Err(error) => match error {},
    };
    let job_id = response_json(generate).await?["data"]["jobId"]
        .as_str()
        .ok_or("missing jobId")?
        .to_string();

    let response = match router
        .oneshot(get_request_with_auth(
            &format!("/v1/video/status/{job_id}"),
            Some(AUTHORIZATION),
        )?)
        .await
    {
        Ok(response) => response,
        Err(error) => match error {},
    };

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await?;
    assert_eq!(body["success"], true);
    assert_eq!(body["data"]["status"], "processing");
    assert_eq!(body["data"]["averageExecutionMs"], 145_000);
    Ok(())
}

#[tokio::test]
async fn integration_video_status_unknown_job_is_not_found() -> Result<(), Box<dyn Error>> {
    let response = send(get_request_with_auth(
        "/v1/video/status/nonexistent-job",
        Some(AUTHORIZATION),
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let body = response_json(response).await?;
    assert_eq!(body["success"], false);
    assert_eq!(body["message"], "job_not_found");
    Ok(())
}

#[tokio::test]
async fn integration_video_animate_rejects_body_over_configured_limit() -> Result<(), Box<dyn Error>>
{
    // Animate uses the image-edit body budget; a body one byte over is rejected
    // by the route body limit before the handler runs.
    let body = format!(
        "{} ",
        image_edit_body_with_len(DEFAULT_MAX_IMAGE_EDIT_BYTES)?
    );
    let router = router(test_state());
    let response = match router
        .oneshot(raw_json_request_with_venice_api_key(
            "/v1/video/animate",
            body,
            "VENICE_INFERENCE_KEY_user",
        )?)
        .await
    {
        Ok(response) => response,
        Err(error) => match error {},
    };

    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    Ok(())
}

#[tokio::test]
async fn integration_verify_page_is_public_html() -> Result<(), Box<dyn Error>> {
    let response = send(get_request("/verify")?).await;

    assert_eq!(response.status(), StatusCode::OK);
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    assert!(
        content_type.starts_with("text/html"),
        "unexpected content type: {content_type}"
    );
    let body = response_text(response).await?;
    assert!(body.contains("Verify this server"));
    assert!(body.contains("<title>Verify this server</title>"));
    assert!(body.contains("This server runs inside an Intel TDX confidential VM."));
    assert!(body.contains("<dt>Version</dt>"));
    assert!(!body.contains("Verify this server ·"));
    assert!(!body.contains("<dt>Service</dt>"));
    assert!(!body.to_ascii_lowercase().contains("scribe-api"));
    assert!(!body.to_ascii_lowercase().contains("scribe api"));
    assert!(body.contains("ghcr.io/open-software-network/june-api:0123abc"));
    assert!(body.contains(&format!(
        "https://github.com/open-software-network/os-june/commit/{TEST_COMMIT}"
    )));
    assert!(body.contains("https://trust.phala.com/app/test-app-id"));
    Ok(())
}

#[tokio::test]
async fn integration_verify_page_without_commit_reports_unstamped_build()
-> Result<(), Box<dyn Error>> {
    let attestation = AttestationInfo {
        source_commit: String::new(),
        ..test_attestation()
    };
    let response = match router(test_state_with_attestation(attestation))
        .oneshot(get_request("/verify")?)
        .await
    {
        Ok(response) => response,
        Err(error) => match error {},
    };

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_text(response).await?;
    assert!(body.contains("not stamped"));
    Ok(())
}

fn note_generate_request(stream: bool) -> serde_json::Value {
    let mut request = serde_json::json!({
        "noteId": "note-1",
        "promptVersion": "prompt-v1",
        "title": "Planning",
        "transcript": "System: launch is Friday",
        "manualNotes": "Ask about rate limits",
        "model": "text-model"
    });
    if stream {
        request["stream"] = serde_json::Value::Bool(true);
    }
    request
}

fn json_request_with_venice_api_key(
    uri: &str,
    value: &serde_json::Value,
    venice_api_key: &str,
) -> Result<Request<Body>, axum::http::Error> {
    Request::builder()
        .method(Method::POST)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::AUTHORIZATION, AUTHORIZATION)
        .header("x-venice-api-key", venice_api_key)
        .body(Body::from(value.to_string()))
}

fn raw_json_request_with_venice_api_key(
    uri: &str,
    body: String,
    venice_api_key: &str,
) -> Result<Request<Body>, axum::http::Error> {
    Request::builder()
        .method(Method::POST)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::AUTHORIZATION, AUTHORIZATION)
        .header("x-venice-api-key", venice_api_key)
        .body(Body::from(body))
}

fn image_edit_body_with_len(total_len: usize) -> Result<String, Box<dyn Error>> {
    let prefix = "{\"image\":\"";
    for extra_prompt_chars in 0..4 {
        let prompt = format!("boundary{}", "x".repeat(extra_prompt_chars));
        let suffix = format!(
            "\",\"prompt\":\"{prompt}\",\"mimeType\":\"image/png\",\"requestId\":\"boundary-req\"}}"
        );
        let overhead = prefix.len() + suffix.len();
        if overhead <= total_len && (total_len - overhead).is_multiple_of(4) {
            let image_len = total_len - overhead;
            let mut body = String::with_capacity(total_len);
            body.push_str(prefix);
            body.push_str(&"A".repeat(image_len));
            body.push_str(&suffix);
            assert_eq!(body.len(), total_len);
            return Ok(body);
        }
    }
    Err("could not construct image edit body at requested length".into())
}

fn multipart_request_with_venice_api_key(
    uri: &str,
    body: Vec<u8>,
    venice_api_key: &str,
) -> Result<Request<Body>, axum::http::Error> {
    Request::builder()
        .method(Method::POST)
        .uri(uri)
        .header(
            header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={}", boundary()),
        )
        .header(header::AUTHORIZATION, AUTHORIZATION)
        .header("x-venice-api-key", venice_api_key)
        .body(Body::from(body))
}

struct FailingIssueReportSink;

#[async_trait]
impl IssueReportSink for FailingIssueReportSink {
    async fn deliver(&self, _report: IssueReport) -> Result<IssueReportDelivery, DomainError> {
        Err(DomainError::UpstreamProvider)
    }
}

struct SlowIssueReportSink;

#[async_trait]
impl IssueReportSink for SlowIssueReportSink {
    async fn deliver(&self, _report: IssueReport) -> Result<IssueReportDelivery, DomainError> {
        tokio::time::sleep(Duration::from_secs(11)).await;
        Ok(IssueReportDelivery::default())
    }
}

struct BlockingIssueReportSink {
    started: AtomicUsize,
    started_notify: tokio::sync::Notify,
    release: tokio::sync::Semaphore,
}

impl BlockingIssueReportSink {
    fn new() -> Self {
        Self {
            started: AtomicUsize::new(0),
            started_notify: tokio::sync::Notify::new(),
            release: tokio::sync::Semaphore::new(0),
        }
    }

    async fn wait_until_started(&self, target: usize) {
        loop {
            let notified = self.started_notify.notified();
            if self.started.load(Ordering::SeqCst) >= target {
                return;
            }
            notified.await;
        }
    }
}

#[async_trait]
impl IssueReportSink for BlockingIssueReportSink {
    async fn deliver(&self, _report: IssueReport) -> Result<IssueReportDelivery, DomainError> {
        self.started.fetch_add(1, Ordering::SeqCst);
        self.started_notify.notify_one();
        self.release
            .acquire()
            .await
            .map_err(|_| DomainError::UpstreamProvider)?
            .forget();
        Ok(IssueReportDelivery::default())
    }
}

struct DeadlineBudgetIssueReportSink {
    calls: AtomicUsize,
    first_started: tokio::sync::Notify,
    release_first: tokio::sync::Semaphore,
}

impl DeadlineBudgetIssueReportSink {
    fn new() -> Self {
        Self {
            calls: AtomicUsize::new(0),
            first_started: tokio::sync::Notify::new(),
            release_first: tokio::sync::Semaphore::new(0),
        }
    }

    async fn wait_until_first_started(&self) {
        loop {
            let notified = self.first_started.notified();
            if self.calls.load(Ordering::SeqCst) >= 1 {
                return;
            }
            notified.await;
        }
    }
}

#[async_trait]
impl IssueReportSink for DeadlineBudgetIssueReportSink {
    async fn deliver(&self, _report: IssueReport) -> Result<IssueReportDelivery, DomainError> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        if call == 0 {
            self.first_started.notify_one();
            self.release_first
                .acquire()
                .await
                .map_err(|_| DomainError::UpstreamProvider)?
                .forget();
        } else {
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        Ok(IssueReportDelivery::default())
    }
}

/// so the service layer must fill it in from the text.
struct LanguagelessTranscriber;

#[async_trait]
impl Transcriber for LanguagelessTranscriber {
    async fn transcribe(&self, _request: TranscriptionRequest) -> Result<Transcript, DomainError> {
        Ok(Transcript {
            text: "Let us schedule a call for next week to discuss the project roadmap and the budget."
                .to_string(),
            language: None,
            provider: "fake-transcriber".to_string(),
        })
    }
}

#[derive(Default)]
struct RecordingGenerator {
    requests: Mutex<Vec<GenerationRequest>>,
}

#[async_trait]
impl Generator for RecordingGenerator {
    async fn generate(&self, request: GenerationRequest) -> Result<GeneratedNote, DomainError> {
        self.requests
            .lock()
            .map_err(|_| DomainError::UpstreamProvider)?
            .push(request.clone());
        FakeGenerator.generate(request).await
    }
}

struct SlowGenerator;

#[async_trait]
impl Generator for SlowGenerator {
    async fn generate(&self, request: GenerationRequest) -> Result<GeneratedNote, DomainError> {
        tokio::time::sleep(Duration::from_secs(11)).await;
        FakeGenerator.generate(request).await
    }
}

#[derive(Default)]
struct RecordingChatCompleter {
    requests: Mutex<Vec<AgentChatRequest>>,
}

#[async_trait]
impl AgentChatCompleter for RecordingChatCompleter {
    async fn complete(
        &self,
        request: AgentChatRequest,
    ) -> Result<AgentChatCompletion, DomainError> {
        self.requests
            .lock()
            .map_err(|_| DomainError::UpstreamProvider)?
            .push(request.clone());
        FakeChatCompleter.complete(request).await
    }

    async fn complete_stream(
        &self,
        request: AgentChatRequest,
    ) -> Result<AgentChatStream, DomainError> {
        self.requests
            .lock()
            .map_err(|_| DomainError::UpstreamProvider)?
            .push(request.clone());
        FakeChatCompleter.complete_stream(request).await
    }
}
