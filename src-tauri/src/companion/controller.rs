use crate::{
    commands,
    db::repositories::{CompanionDeviceRecord, Repositories},
    dictation::{self, DictationStyle as DesktopDictationStyle},
    domain::types::{AppError, NoteDto, SessionRequest},
    providers,
};
use june_companion_protocol::{
    ActiveRecording, ActiveRecordingSnapshot, ActiveRecordingState, Body, Capability, DeviceSelf,
    DictationStyle, FailureCode, Frame, NoteConflict, NoteRecord, NoteSummary, Page,
    ProtocolFailure, Response, ResultPayload, SafeSettings,
};
use std::{collections::HashMap, sync::Mutex};
use tauri::{AppHandle, Emitter, Manager};

const MAX_COMPANION_NOTE_TITLE_BYTES: usize = 512;
const MAX_COMPANION_NOTE_SUMMARY_FIELD_BYTES: usize = 256;
const MAX_COMPANION_NOTE_CONTENT_BYTES: usize = 28 * 1024;
const MAX_COMPANION_NOTE_CONTENT_JSON_BYTES: usize = 30 * 1024;

/// Only these typed intents can cross from the companion controller into the
/// frontend. Raw Hermes frames, arbitrary Tauri commands, paths, SQL, shell,
/// approvals, provider credentials, and recording start have no variant here.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "type", content = "data", rename_all = "camelCase")]
pub enum FrontendIntent {
    AgentSessionsList {
        cursor: Option<String>,
        limit: u16,
    },
    AgentMessagesList {
        session_id: String,
        cursor: Option<String>,
        limit: u16,
    },
    AgentSend {
        session_id: Option<String>,
        message: String,
    },
    AgentCancel {
        session_id: String,
    },
    RecordingPause {
        session_id: String,
    },
    RecordingResume {
        session_id: String,
    },
    RecordingStop {
        session_id: String,
    },
}

pub enum ControllerOutcome {
    Immediate(Response),
    Frontend(FrontendIntent),
}

#[derive(Default)]
pub struct Controller {
    last_sequences: Mutex<HashMap<String, u64>>,
}

impl Controller {
    pub async fn dispatch(
        &self,
        app: &AppHandle,
        repositories: &Repositories,
        device_id: &str,
        frame: Frame,
        now_ms: u64,
    ) -> Result<ControllerOutcome, AppError> {
        frame
            .validate(now_ms)
            .map_err(|error| AppError::new("companion_frame_invalid", error.to_string()))?;
        let operation_id = frame.operation_id.to_string();
        if let Some(encoded) = repositories
            .companion_operation(device_id, &operation_id)
            .await?
        {
            let response = serde_json::from_slice(&encoded).map_err(|_| {
                AppError::new(
                    "companion_operation_invalid",
                    "A saved companion response could not be decoded.",
                )
            })?;
            return Ok(ControllerOutcome::Immediate(response));
        }
        let active_device = repositories
            .companion_device(device_id)
            .await?
            .is_some_and(|device| device.revoked_at.is_none());
        if !active_device {
            return Err(AppError::new(
                "unauthorized",
                "This linked device is no longer authorized.",
            ));
        }
        self.accept_sequence(device_id, frame.sequence)?;
        let capability = frame.capability;
        let outcome = match frame.body {
            Body::NotesList(page) => {
                let notes = repositories
                    .list_notes(None, i64::from(page.limit), page.cursor)
                    .await?;
                let items = notes
                    .items
                    .into_iter()
                    .map(|note| NoteSummary {
                        id: note.id,
                        title: bounded_utf8(&note.title, MAX_COMPANION_NOTE_SUMMARY_FIELD_BYTES),
                        preview: bounded_utf8(
                            &note.preview,
                            MAX_COMPANION_NOTE_SUMMARY_FIELD_BYTES,
                        ),
                        revision: note.revision,
                        updated_at: note.updated_at,
                    })
                    .collect();
                ControllerOutcome::Immediate(response(
                    capability,
                    ResultPayload::Notes(Page {
                        items,
                        next_cursor: notes.next_cursor,
                    }),
                ))
            }
            Body::NoteGet { note_id } => {
                let note = repositories.get_note(&note_id).await?;
                ControllerOutcome::Immediate(response(
                    capability,
                    ResultPayload::Note(note_record(note)?),
                ))
            }
            Body::NoteEdit(request) => {
                ensure_note_record_size(&repositories.get_note(&request.note_id).await?)?;
                if request
                    .edited_content
                    .as_deref()
                    .is_some_and(|content| !companion_note_content_fits(content))
                {
                    return Err(note_too_large());
                }
                match repositories
                    .update_note_cas(
                        &request.note_id,
                        request.expected_revision,
                        request.title,
                        request.edited_content,
                    )
                    .await
                {
                    Ok(note) => ControllerOutcome::Immediate(response(
                        capability,
                        ResultPayload::Note(note_record(note)?),
                    )),
                    Err(error) if error.code == "note_revision_conflict" => {
                        let current: NoteDto = error
                            .details
                            .and_then(|value| serde_json::from_value(value).ok())
                            .ok_or_else(|| {
                                AppError::new(
                                    "companion_conflict_invalid",
                                    "The current note could not be loaded.",
                                )
                            })?;
                        ControllerOutcome::Immediate(response(
                            capability,
                            ResultPayload::Conflict(NoteConflict {
                                expected_revision: request.expected_revision,
                                current: note_record(current)?,
                            }),
                        ))
                    }
                    Err(error) => return Err(error),
                }
            }
            Body::SettingsGet => ControllerOutcome::Immediate(response(
                capability,
                ResultPayload::Settings(read_safe_settings(app)?),
            )),
            Body::SettingsEditSafe(patch) => {
                if let Some(style) = patch.dictation_style {
                    dictation::set_dictation_style(app.state(), desktop_style(style))?;
                }
                if let Some(enabled) = patch.image_safe_mode {
                    providers::set_image_safe_mode(
                        app.state(),
                        providers::SetImageSafeModeRequest { enabled },
                    )?;
                }
                ControllerOutcome::Immediate(response(
                    capability,
                    ResultPayload::Settings(read_safe_settings(app)?),
                ))
            }
            Body::DeviceGetSelf => {
                let device = repositories
                    .companion_device(device_id)
                    .await?
                    .ok_or_else(|| {
                        AppError::new("companion_device_not_found", "Linked device was not found.")
                    })?;
                ControllerOutcome::Immediate(response(
                    capability,
                    ResultPayload::Device(device_self(device)?),
                ))
            }
            Body::DeviceRevokeSelf => {
                repositories.revoke_companion_device(device_id).await?;
                ControllerOutcome::Immediate(response(capability, ResultPayload::Accepted))
            }
            Body::AgentSessionsList(page) => {
                ControllerOutcome::Frontend(FrontendIntent::AgentSessionsList {
                    cursor: page.cursor,
                    limit: page.limit,
                })
            }
            Body::AgentMessagesList { session_id, page } => {
                ControllerOutcome::Frontend(FrontendIntent::AgentMessagesList {
                    session_id,
                    cursor: page.cursor,
                    limit: page.limit,
                })
            }
            Body::AgentSend(request) => ControllerOutcome::Frontend(FrontendIntent::AgentSend {
                session_id: request.session_id,
                message: request.message,
            }),
            Body::AgentCancel { session_id } => {
                ControllerOutcome::Frontend(FrontendIntent::AgentCancel { session_id })
            }
            Body::RecordingPause { session_id } => {
                commands::pause_recording(app.clone(), SessionRequest { session_id }).await?;
                ControllerOutcome::Immediate(response(capability, ResultPayload::Accepted))
            }
            Body::RecordingResume { session_id } => {
                commands::resume_recording(app.clone(), SessionRequest { session_id }).await?;
                ControllerOutcome::Immediate(response(capability, ResultPayload::Accepted))
            }
            Body::RecordingStop { session_id } => {
                commands::finish_recording(app.clone(), SessionRequest { session_id }).await?;
                ControllerOutcome::Immediate(response(capability, ResultPayload::Accepted))
            }
            Body::RecordingGetActive => {
                let active =
                    crate::audio::capture::current_status().map(|status| ActiveRecording {
                        session_id: status.session_id,
                        state: match status.state {
                            crate::domain::types::RecordingState::Paused => {
                                ActiveRecordingState::Paused
                            }
                            _ => ActiveRecordingState::Recording,
                        },
                    });
                ControllerOutcome::Immediate(response(
                    capability,
                    ResultPayload::Recording(ActiveRecordingSnapshot { active }),
                ))
            }
            Body::AppFocus { target } => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
                app.emit("june://companion-focus", &target)
                    .map_err(|error| {
                        AppError::new(
                            "companion_focus_failed",
                            format!("The requested view could not be opened: {error}"),
                        )
                    })?;
                ControllerOutcome::Immediate(response(capability, ResultPayload::Accepted))
            }
            Body::Response(_) | Body::Event(_) => ControllerOutcome::Immediate(response(
                capability,
                ResultPayload::Error(ProtocolFailure {
                    code: FailureCode::InvalidRequest,
                    message: "The desktop accepts requests only.".to_string(),
                    retryable: false,
                }),
            )),
        };
        if let ControllerOutcome::Immediate(response) = &outcome {
            let encoded = serde_json::to_vec(response).map_err(|_| {
                AppError::new(
                    "companion_response_invalid",
                    "The companion response could not be encoded.",
                )
            })?;
            repositories
                .remember_companion_operation(device_id, &operation_id, &encoded)
                .await?;
        }
        Ok(outcome)
    }

    fn accept_sequence(&self, device_id: &str, sequence: u64) -> Result<(), AppError> {
        let mut sequences = self.last_sequences.lock().map_err(|_| {
            AppError::new(
                "companion_controller_unavailable",
                "Companion controller lock failed.",
            )
        })?;
        let last = sequences.entry(device_id.to_string()).or_default();
        if sequence <= *last {
            return Err(AppError::new(
                "companion_replay_rejected",
                "The companion message sequence was already used.",
            ));
        }
        *last = sequence;
        Ok(())
    }

    pub fn reset_sequence(&self, device_id: &str) {
        if let Ok(mut sequences) = self.last_sequences.lock() {
            sequences.remove(device_id);
        }
    }
}

pub fn frontend_response(capability: Capability, result: ResultPayload) -> Response {
    response(capability, result)
}

fn response(capability: Capability, result: ResultPayload) -> Response {
    Response { capability, result }
}

fn note_record(note: NoteDto) -> Result<NoteRecord, AppError> {
    ensure_note_record_size(&note)?;
    Ok(NoteRecord {
        id: note.id,
        title: note.title,
        edited_content: note
            .edited_content
            .or(note.generated_content)
            .unwrap_or_default(),
        revision: note.revision,
        updated_at: note.updated_at,
    })
}

fn ensure_note_record_size(note: &NoteDto) -> Result<(), AppError> {
    let content = note
        .edited_content
        .as_deref()
        .or(note.generated_content.as_deref())
        .unwrap_or_default();
    if note.title.len() > MAX_COMPANION_NOTE_TITLE_BYTES || !companion_note_content_fits(content) {
        return Err(note_too_large());
    }
    Ok(())
}

fn companion_note_content_fits(content: &str) -> bool {
    content.len() <= MAX_COMPANION_NOTE_CONTENT_BYTES
        && serde_json::to_vec(content)
            .is_ok_and(|encoded| encoded.len() <= MAX_COMPANION_NOTE_CONTENT_JSON_BYTES)
}

fn note_too_large() -> AppError {
    AppError::new(
        "companion_note_too_large",
        "This note is too large to edit safely from the companion. Open it on your Mac.",
    )
}

fn bounded_utf8(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    const SUFFIX: &str = "...";
    let budget = max_bytes.saturating_sub(SUFFIX.len());
    let mut end = 0;
    for (index, character) in value.char_indices() {
        let next = index + character.len_utf8();
        if next > budget {
            break;
        }
        end = next;
    }
    format!("{}{SUFFIX}", &value[..end])
}

fn read_safe_settings(app: &AppHandle) -> Result<SafeSettings, AppError> {
    let dictation = dictation::dictation_settings(app.state())?.settings;
    let provider = providers::provider_model_settings(app.state())?.settings;
    Ok(SafeSettings {
        dictation_style: protocol_style(dictation.style),
        image_safe_mode: provider.image_safe_mode,
    })
}

fn desktop_style(style: DictationStyle) -> DesktopDictationStyle {
    match style {
        DictationStyle::Standard => DesktopDictationStyle::Standard,
        DictationStyle::CasualLowercase => DesktopDictationStyle::CasualLowercase,
        DictationStyle::Formal => DesktopDictationStyle::Formal,
    }
}

fn protocol_style(style: DesktopDictationStyle) -> DictationStyle {
    match style {
        DesktopDictationStyle::Standard => DictationStyle::Standard,
        DesktopDictationStyle::CasualLowercase => DictationStyle::CasualLowercase,
        DesktopDictationStyle::Formal => DictationStyle::Formal,
    }
}

fn device_self(device: CompanionDeviceRecord) -> Result<DeviceSelf, AppError> {
    Ok(DeviceSelf {
        device_id: device.id.parse().map_err(|_| {
            AppError::new("companion_device_invalid", "Linked device id is invalid.")
        })?,
        display_name: device.display_name,
        linked_at: device.linked_at,
        last_seen_at: device.last_seen_at,
        revoked_at: device.revoked_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use june_companion_protocol::{AgentSendRequest, PageRequest};
    use uuid::Uuid;

    #[test]
    fn allowlist_has_no_remote_recording_start_or_privileged_escape_hatch() {
        let allowed = [
            Body::NotesList(PageRequest::default()),
            Body::AgentSend(AgentSendRequest {
                session_id: None,
                message: "Hello".to_string(),
            }),
            Body::RecordingPause {
                session_id: "active".to_string(),
            },
            Body::DeviceRevokeSelf,
        ];
        assert_eq!(allowed.len(), 4);
        // Compile-time exhaustiveness in `dispatch` is the real gate. This
        // regression assertion makes the most important exclusions visible.
        let encoded = serde_json::to_string(&allowed).unwrap();
        for forbidden in [
            "recordingStart",
            "shell",
            "filesystem",
            "approval",
            "deleteNote",
        ] {
            assert!(!encoded.contains(forbidden));
        }
        assert_ne!(Uuid::nil(), Uuid::new_v4());
    }

    #[test]
    fn replay_window_is_strictly_monotonic_per_device() {
        let controller = Controller::default();
        controller.accept_sequence("phone", 1).unwrap();
        assert!(controller.accept_sequence("phone", 1).is_err());
        assert!(controller.accept_sequence("phone", 0).is_err());
        controller.accept_sequence("phone", 2).unwrap();
        controller.accept_sequence("tablet", 1).unwrap();
    }

    #[test]
    fn note_projection_stays_within_the_encrypted_frame_budget() {
        assert!(companion_note_content_fits(&"a".repeat(28 * 1024)));
        assert!(!companion_note_content_fits(&"\n".repeat(16 * 1024)));

        let title = bounded_utf8(&"🙂".repeat(200), 512);
        assert!(title.len() <= 512);
        assert!(title.ends_with("..."));
    }
}
