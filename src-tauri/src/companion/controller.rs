use crate::{
    commands,
    db::repositories::{CompanionDeviceRecord, Repositories},
    dictation::{self, DictationStyle as DesktopDictationStyle},
    domain::types::{AppError, NoteDto, SessionRequest},
    providers,
};
use clovy_companion_protocol::{
    ActiveRecording, ActiveRecordingSnapshot, ActiveRecordingState, Body, Capability, DeviceSelf,
    DictationStyle, FailureCode, FocusTarget, Frame, NoteConflict, NoteRecord, NoteSummary, Page,
    ProtocolFailure, Response, ResultPayload, SafeSettings, DEFAULT_CONTROL_TTL_MS,
    MAX_ENCODED_FRAME_BYTES,
};
use std::{collections::HashMap, sync::Mutex};
use tauri::{AppHandle, Emitter, Manager};

const MAX_COMPANION_NOTE_TITLE_BYTES: usize = 512;
const MAX_COMPANION_NOTE_SUMMARY_FIELD_BYTES: usize = 256;
const MAX_COMPANION_NOTE_CONTENT_BYTES: usize = 28 * 1024;
const MAX_COMPANION_NOTE_CONTENT_JSON_BYTES: usize = 30 * 1024;

/// Only these typed intents can cross from the companion controller into the
/// frontend. Raw agent-harness frames, arbitrary Tauri commands or paths, SQL,
/// shell, approvals, provider credentials, and recording start have no variant
/// here. Attachment paths are injected only after the controller resolves
/// authenticated, device-scoped opaque references.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(
    tag = "type",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum FrontendIntent {
    AgentSessionsList {
        #[serde(skip_serializing_if = "Option::is_none")]
        cursor: Option<String>,
        limit: u16,
    },
    AgentMessagesList {
        stored_session_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        cursor: Option<String>,
        limit: u16,
    },
    AgentSend {
        #[serde(skip_serializing_if = "Option::is_none")]
        stored_session_id: Option<String>,
        message: String,
        attachments: Vec<super::files::ResolvedAttachment>,
        attachment_reference_ids: Vec<uuid::Uuid>,
    },
    MediaFetch {
        stored_session_id: String,
        artifact_id: String,
        offset_bytes: u64,
    },
    AgentCancel {
        stored_session_id: String,
    },
    ModelsList,
    SessionModelGet {
        #[serde(rename = "storedSessionId")]
        stored_session_id: String,
    },
    SessionModelSet {
        #[serde(rename = "storedSessionId")]
        stored_session_id: String,
        #[serde(rename = "modelId")]
        model_id: String,
    },
    RecordingPause {
        recording_session_id: String,
    },
    RecordingResume {
        recording_session_id: String,
    },
    RecordingStop {
        recording_session_id: String,
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
        account_user_id: &str,
        device_id: &str,
        frame: Frame,
        now_ms: u64,
    ) -> Result<ControllerOutcome, AppError> {
        super::ensure_companion_pairing_enabled(&app.state::<super::CompanionRuntime>())?;
        frame
            .validate(now_ms)
            .map_err(|error| AppError::new("companion_frame_invalid", error.to_string()))?;
        let active_device = repositories
            .companion_device(account_user_id, device_id)
            .await?
            .is_some_and(|device| device.revoked_at.is_none());
        if !active_device {
            return Err(AppError::new(
                "unauthorized",
                "This linked device is no longer authorized.",
            ));
        }
        let operation_id = frame.operation_id.to_string();
        if let Some(encoded) = repositories
            .companion_operation(account_user_id, device_id, &operation_id)
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
        self.accept_sequence(device_id, frame.sequence)?;
        let capability = frame.capability;
        let is_mutation = frame.body.is_mutation();
        if is_mutation {
            let pending = pending_operation_response(capability);
            let encoded = serde_json::to_vec(&pending).map_err(|_| {
                AppError::new(
                    "companion_response_invalid",
                    "The companion operation reservation could not be encoded.",
                )
            })?;
            if !repositories
                .reserve_companion_operation(account_user_id, device_id, &operation_id, &encoded)
                .await?
            {
                let Some(encoded) = repositories
                    .companion_operation(account_user_id, device_id, &operation_id)
                    .await?
                else {
                    return Ok(ControllerOutcome::Immediate(reservation_capacity_response(
                        capability,
                    )));
                };
                let response = serde_json::from_slice(&encoded).map_err(|_| {
                    AppError::new(
                        "companion_operation_invalid",
                        "A saved companion response could not be decoded.",
                    )
                })?;
                return Ok(ControllerOutcome::Immediate(response));
            }
        }
        let active_profile = crate::commands::active_profile(app);
        let outcome = match frame.body {
            Body::NotesList(page) => {
                let notes = repositories
                    .list_notes(&active_profile, None, i64::from(page.limit), page.cursor)
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
                    .collect::<Vec<_>>();
                ControllerOutcome::Immediate(response(
                    capability,
                    ResultPayload::Notes(bounded_notes_page(
                        items,
                        notes.item_cursors,
                        notes.next_cursor,
                    )?),
                ))
            }
            Body::NoteGet { note_id } => {
                let note = repositories
                    .get_note_in_profile(&active_profile, &note_id)
                    .await
                    .map_err(companion_note_lookup_error)?;
                ControllerOutcome::Immediate(response(
                    capability,
                    ResultPayload::Note(note_record(note)?),
                ))
            }
            Body::NoteEdit(request) => {
                ensure_note_record_size(
                    &repositories
                        .get_note_in_profile(&active_profile, &request.note_id)
                        .await
                        .map_err(companion_note_lookup_error)?,
                )?;
                if request
                    .edited_content
                    .as_deref()
                    .is_some_and(|content| !companion_note_content_fits(content))
                {
                    return Err(note_too_large());
                }
                match repositories
                    .update_note_cas_in_profile(
                        &active_profile,
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
                    .companion_device(account_user_id, device_id)
                    .await?
                    .ok_or_else(|| {
                        AppError::new("companion_device_not_found", "Linked device was not found.")
                    })?;
                ControllerOutcome::Immediate(response(
                    capability,
                    ResultPayload::Device(device_self(
                        device,
                        app.state::<super::CompanionRuntime>()
                            .desktop_display_name(),
                    )?),
                ))
            }
            Body::DeviceRevokeSelf => {
                let relay_device_id = uuid::Uuid::parse_str(device_id).map_err(|_| {
                    AppError::new(
                        "companion_device_invalid",
                        "The linked device id is invalid.",
                    )
                })?;
                super::revoke_device_remote(relay_device_id).await?;
                repositories
                    .revoke_companion_device(account_user_id, device_id)
                    .await?;
                super::files::cleanup_device_uploads(app, repositories, account_user_id, device_id)
                    .await;
                ControllerOutcome::Immediate(response(capability, ResultPayload::Accepted))
            }
            Body::AgentSessionsList(page) => {
                ControllerOutcome::Frontend(FrontendIntent::AgentSessionsList {
                    cursor: page.cursor,
                    limit: page.limit,
                })
            }
            Body::AgentMessagesList {
                stored_session_id,
                page,
            } => ControllerOutcome::Frontend(FrontendIntent::AgentMessagesList {
                stored_session_id,
                cursor: page.cursor,
                limit: page.limit,
            }),
            Body::AgentSend(request) => {
                let attachments = super::files::resolve_attachments(
                    app,
                    repositories,
                    account_user_id,
                    device_id,
                    &request.attachment_reference_ids,
                )
                .await?;
                ControllerOutcome::Frontend(FrontendIntent::AgentSend {
                    stored_session_id: request.stored_session_id,
                    message: request.message,
                    attachments,
                    attachment_reference_ids: request.attachment_reference_ids,
                })
            }
            Body::UploadBegin(request) => {
                let progress = super::files::begin_upload(
                    app,
                    repositories,
                    account_user_id,
                    device_id,
                    &request,
                )
                .await?;
                ControllerOutcome::Immediate(response(capability, ResultPayload::Upload(progress)))
            }
            Body::UploadChunk(request) => {
                let progress = super::files::append_upload_chunk(
                    app,
                    repositories,
                    account_user_id,
                    device_id,
                    &request,
                )
                .await?;
                ControllerOutcome::Immediate(response(capability, ResultPayload::Upload(progress)))
            }
            Body::UploadCommit { reservation_id } => {
                let progress = super::files::commit_upload(
                    app,
                    repositories,
                    account_user_id,
                    device_id,
                    reservation_id,
                )
                .await?;
                ControllerOutcome::Immediate(response(capability, ResultPayload::Upload(progress)))
            }
            Body::BrowseRootsList => ControllerOutcome::Immediate(response(
                capability,
                ResultPayload::BrowseRoots(
                    super::files::protocol_roots(repositories, account_user_id).await?,
                ),
            )),
            Body::BrowseDirList {
                root_id,
                relative_path,
                page,
            } => ControllerOutcome::Immediate(response(
                capability,
                ResultPayload::BrowseEntries(
                    super::files::list_directory(
                        repositories,
                        account_user_id,
                        root_id,
                        &relative_path,
                        &page,
                    )
                    .await?,
                ),
            )),
            Body::BrowseFileStat {
                root_id,
                relative_path,
            } => ControllerOutcome::Immediate(response(
                capability,
                ResultPayload::BrowseFile(
                    super::files::stat_file(
                        app,
                        repositories,
                        account_user_id,
                        device_id,
                        root_id,
                        &relative_path,
                    )
                    .await?,
                ),
            )),
            Body::MediaFetch(request) => ControllerOutcome::Frontend(FrontendIntent::MediaFetch {
                stored_session_id: request.stored_session_id,
                artifact_id: request.artifact_id,
                offset_bytes: request.offset_bytes,
            }),
            Body::AgentCancel { stored_session_id } => {
                ControllerOutcome::Frontend(FrontendIntent::AgentCancel { stored_session_id })
            }
            Body::ModelsList => ControllerOutcome::Frontend(FrontendIntent::ModelsList),
            Body::SessionModelGet { stored_session_id } => {
                ControllerOutcome::Frontend(FrontendIntent::SessionModelGet { stored_session_id })
            }
            Body::SessionModelSet(request) => {
                ControllerOutcome::Frontend(FrontendIntent::SessionModelSet {
                    stored_session_id: request.stored_session_id,
                    model_id: request.model_id,
                })
            }
            Body::RecordingPause {
                recording_session_id,
            } => {
                commands::pause_recording(
                    app.clone(),
                    SessionRequest {
                        session_id: recording_session_id,
                    },
                )
                .await?;
                ControllerOutcome::Immediate(response(capability, ResultPayload::Accepted))
            }
            Body::RecordingResume {
                recording_session_id,
            } => {
                commands::resume_recording(
                    app.clone(),
                    SessionRequest {
                        session_id: recording_session_id,
                    },
                )
                .await?;
                ControllerOutcome::Immediate(response(capability, ResultPayload::Accepted))
            }
            Body::RecordingStop {
                recording_session_id,
            } => {
                commands::finish_recording(
                    app.clone(),
                    SessionRequest {
                        session_id: recording_session_id,
                    },
                )
                .await?;
                ControllerOutcome::Immediate(response(capability, ResultPayload::Accepted))
            }
            Body::RecordingGetActive => {
                let active =
                    crate::audio::capture::current_status().map(|status| ActiveRecording {
                        recording_session_id: status.session_id,
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
                if let FocusTarget::Note { note_id } = &target {
                    repositories
                        .get_note_in_profile(&active_profile, note_id)
                        .await
                        .map_err(companion_note_lookup_error)?;
                }
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
                app.emit("clovy://companion-focus", &target)
                    .map_err(|error| {
                        AppError::new(
                            "companion_focus_failed",
                            format!("The requested view could not be opened: {error}"),
                        )
                    })?;
                ControllerOutcome::Immediate(response(capability, ResultPayload::Accepted))
            }
            Body::ComputerUseApprovalReceived(receipt) => {
                let device_uuid = device_id.parse().map_err(|_| {
                    AppError::new(
                        "companion_device_invalid",
                        "The linked device identity is invalid.",
                    )
                })?;
                if !app
                    .state::<super::CompanionRuntime>()
                    .peer_has_capability(device_uuid, Capability::ComputerUseApprove)
                {
                    return Err(AppError::new(
                        "companion_computer_use_approval_disabled",
                        "This linked device did not advertise Computer use approval support.",
                    ));
                }
                super::confirm_computer_use_approval_delivery(
                    app,
                    &receipt.request_id,
                    &receipt.stored_session_id,
                )?;
                ControllerOutcome::Immediate(response(capability, ResultPayload::Accepted))
            }
            Body::ComputerUseApprovalRespond(request) => {
                let device_uuid = device_id.parse().map_err(|_| {
                    AppError::new(
                        "companion_device_invalid",
                        "The linked device identity is invalid.",
                    )
                })?;
                if !app
                    .state::<super::CompanionRuntime>()
                    .peer_has_capability(device_uuid, Capability::ComputerUseApprove)
                {
                    return Err(AppError::new(
                        "companion_computer_use_approval_disabled",
                        "This linked device did not advertise Computer use approval support.",
                    ));
                }
                let result = crate::agent_runtime::api::resolve_companion_computer_use_approval(
                    app,
                    &request.request_id,
                    &request.stored_session_id,
                    request.decision,
                    super::ComputerUseApprovalOrigin::Companion {
                        device_id: device_id.to_string(),
                    },
                )
                .await;
                tracing::info!(
                    request_id = %request.request_id,
                    stored_session_id = %request.stored_session_id,
                    decision = ?request.decision,
                    accepted = result.is_ok(),
                    error_code = result.as_ref().err().map(|error| error.code.as_str()),
                    "handled linked Computer use approval decision"
                );
                result?;
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
            if is_mutation {
                repositories
                    .complete_companion_operation(
                        account_user_id,
                        device_id,
                        &operation_id,
                        &encoded,
                    )
                    .await?;
            } else {
                repositories
                    .remember_companion_operation(
                        account_user_id,
                        device_id,
                        &operation_id,
                        &encoded,
                    )
                    .await?;
            }
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

fn pending_operation_response(capability: Capability) -> Response {
    response(
        capability,
        ResultPayload::Error(ProtocolFailure {
            code: FailureCode::OutcomeUnknown,
            message: "This request may already have reached Clovy. Check your Mac, then choose the action again only if it is still needed."
                .to_string(),
            retryable: false,
        }),
    )
}

fn reservation_capacity_response(capability: Capability) -> Response {
    response(
        capability,
        ResultPayload::Error(ProtocolFailure {
            code: FailureCode::Busy,
            message:
                "Clovy is still resolving earlier companion actions. Check your Mac, then try again."
                    .to_string(),
            retryable: true,
        }),
    )
}

fn response(capability: Capability, result: ResultPayload) -> Response {
    Response { capability, result }
}

fn bounded_notes_page(
    items: Vec<NoteSummary>,
    item_cursors: Vec<String>,
    repository_next_cursor: Option<String>,
) -> Result<Page<NoteSummary>, AppError> {
    if items.len() != item_cursors.len() {
        return Err(AppError::new(
            "companion_response_invalid",
            "The companion notes page could not be encoded.",
        ));
    }

    let total_items = items.len();
    let has_repository_next_page = repository_next_cursor.is_some();
    let mut included = Vec::with_capacity(total_items);
    for (index, item) in items.into_iter().enumerate() {
        included.push(item);
        let candidate_cursor = (index + 1 < total_items || has_repository_next_page)
            .then(|| item_cursors[index].clone());
        if !notes_page_fits(&Page {
            items: included.clone(),
            next_cursor: candidate_cursor,
        })? {
            included.pop();
            break;
        }
    }

    if included.is_empty() && total_items > 0 {
        return Err(AppError::new(
            "companion_response_invalid",
            "A companion note summary exceeded the response size limit.",
        ));
    }

    let next_cursor = if included.len() < total_items {
        item_cursors.get(included.len().saturating_sub(1)).cloned()
    } else {
        repository_next_cursor
    };
    let page = Page {
        items: included,
        next_cursor,
    };
    if !notes_page_fits(&page)? {
        return Err(AppError::new(
            "companion_response_invalid",
            "The companion notes page exceeded the response size limit.",
        ));
    }
    Ok(page)
}

fn notes_page_fits(page: &Page<NoteSummary>) -> Result<bool, AppError> {
    let frame = Frame::new(
        uuid::Uuid::from_u128(u128::MAX),
        u64::MAX,
        u64::MAX.saturating_sub(DEFAULT_CONTROL_TTL_MS),
        Capability::NotesRead,
        Body::Response(response(
            Capability::NotesRead,
            ResultPayload::Notes(page.clone()),
        )),
    );
    serde_json::to_vec(&frame)
        .map(|encoded| encoded.len() < MAX_ENCODED_FRAME_BYTES)
        .map_err(|_| {
            AppError::new(
                "companion_response_invalid",
                "The companion notes page could not be encoded.",
            )
        })
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

fn companion_note_lookup_error(error: sqlx::error::Error) -> AppError {
    if matches!(error, sqlx::error::Error::RowNotFound) {
        return AppError::new(
            "note_not_found",
            "That note is not available in the current data partition.",
        );
    }
    AppError::from(error)
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

fn device_self(
    device: CompanionDeviceRecord,
    desktop_display_name: String,
) -> Result<DeviceSelf, AppError> {
    Ok(DeviceSelf {
        device_id: device.id.parse().map_err(|_| {
            AppError::new("companion_device_invalid", "Linked device id is invalid.")
        })?,
        display_name: device.display_name,
        desktop_display_name: Some(desktop_display_name),
        linked_at: device.linked_at,
        last_seen_at: device.last_seen_at,
        revoked_at: device.revoked_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use clovy_companion_protocol::{
        AgentSendRequest, ComputerUseApprovalDecision, ComputerUseApprovalDecisionRequest,
        ComputerUseApprovalReceipt, PageRequest,
    };
    use uuid::Uuid;

    #[test]
    fn allowlist_has_no_remote_recording_start_or_privileged_escape_hatch() {
        let allowed = [
            Body::NotesList(PageRequest::default()),
            Body::AgentSend(AgentSendRequest {
                stored_session_id: None,
                message: "Hello".to_string(),
                attachment_reference_ids: Vec::new(),
            }),
            Body::RecordingPause {
                recording_session_id: "active".to_string(),
            },
            Body::DeviceRevokeSelf,
            Body::ComputerUseApprovalReceived(ComputerUseApprovalReceipt {
                request_id: "call-1".to_string(),
                stored_session_id: "session-1".to_string(),
            }),
            Body::ComputerUseApprovalRespond(ComputerUseApprovalDecisionRequest {
                request_id: "call-1".to_string(),
                stored_session_id: "session-1".to_string(),
                decision: ComputerUseApprovalDecision::Deny,
            }),
        ];
        assert_eq!(allowed.len(), 6);
        // Compile-time exhaustiveness in `dispatch` is the real gate. This
        // regression assertion makes the most important exclusions visible.
        let encoded = serde_json::to_string(&allowed).unwrap();
        for forbidden in ["recordingStart", "shell", "filesystem", "deleteNote"] {
            assert!(!encoded.contains(forbidden));
        }
        assert!(encoded.contains("computerUseApprovalRespond"));
        assert!(encoded.contains("computerUseApprovalReceived"));
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
    fn model_frontend_intents_keep_the_typed_wire_boundary() {
        let intents = [
            FrontendIntent::ModelsList,
            FrontendIntent::SessionModelGet {
                stored_session_id: "session-1".to_string(),
            },
            FrontendIntent::SessionModelSet {
                stored_session_id: "session-1".to_string(),
                model_id: "kimi-k2-6".to_string(),
            },
        ];
        let encoded = serde_json::to_value(intents).unwrap();

        assert_eq!(encoded[0]["type"], "modelsList");
        assert_eq!(encoded[1]["type"], "sessionModelGet");
        assert_eq!(encoded[1]["data"]["storedSessionId"], "session-1");
        assert_eq!(encoded[2]["type"], "sessionModelSet");
        assert_eq!(encoded[2]["data"]["modelId"], "kimi-k2-6");
    }

    #[test]
    fn frontend_intents_omit_absent_optional_fields() {
        let sessions = serde_json::to_value(FrontendIntent::AgentSessionsList {
            cursor: None,
            limit: 50,
        })
        .unwrap();
        assert_eq!(
            sessions,
            serde_json::json!({
                "type": "agentSessionsList",
                "data": { "limit": 50 },
            })
        );

        let send = serde_json::to_value(FrontendIntent::AgentSend {
            stored_session_id: None,
            message: "Hello".to_string(),
            attachments: Vec::new(),
            attachment_reference_ids: Vec::new(),
        })
        .unwrap();
        assert_eq!(
            send,
            serde_json::json!({
                "type": "agentSend",
                "data": {
                    "message": "Hello",
                    "attachments": [],
                    "attachmentReferenceIds": [],
                },
            })
        );
    }

    #[test]
    fn frontend_intents_use_camel_case_fields() {
        let messages = serde_json::to_value(FrontendIntent::AgentMessagesList {
            stored_session_id: "stored-1".to_string(),
            cursor: Some("next".to_string()),
            limit: 50,
        })
        .unwrap();
        assert_eq!(
            messages,
            serde_json::json!({
                "type": "agentMessagesList",
                "data": {
                    "storedSessionId": "stored-1",
                    "cursor": "next",
                    "limit": 50,
                },
            })
        );

        let cancel = serde_json::to_value(FrontendIntent::AgentCancel {
            stored_session_id: "stored-1".to_string(),
        })
        .unwrap();
        assert_eq!(
            cancel,
            serde_json::json!({
                "type": "agentCancel",
                "data": { "storedSessionId": "stored-1" },
            })
        );
    }

    #[test]
    fn outcome_unknown_requires_an_explicit_new_user_action() {
        let response = pending_operation_response(Capability::AgentChat);
        assert!(matches!(
            response.result,
            ResultPayload::Error(ProtocolFailure {
                code: FailureCode::OutcomeUnknown,
                retryable: false,
                ..
            })
        ));
    }

    #[test]
    fn reservation_capacity_is_retryable_without_dispatching() {
        let response = reservation_capacity_response(Capability::AgentChat);
        assert!(matches!(
            response.result,
            ResultPayload::Error(ProtocolFailure {
                code: FailureCode::Busy,
                retryable: true,
                ..
            })
        ));
    }

    #[test]
    fn device_self_includes_the_cached_desktop_name() {
        let device = CompanionDeviceRecord {
            id: Uuid::nil().to_string(),
            display_name: "Phone".to_string(),
            public_key: vec![1_u8; 32],
            linked_at: "2026-07-27T12:00:00Z".to_string(),
            last_seen_at: None,
            revoked_at: None,
        };

        let projected = device_self(device, "Studio Mac".to_string()).unwrap();

        assert_eq!(projected.display_name, "Phone");
        assert_eq!(
            projected.desktop_display_name.as_deref(),
            Some("Studio Mac")
        );
    }

    #[test]
    fn note_projection_stays_within_the_encrypted_frame_budget() {
        assert!(companion_note_content_fits(&"a".repeat(28 * 1024)));
        assert!(!companion_note_content_fits(&"\n".repeat(16 * 1024)));

        let title = bounded_utf8(&"🙂".repeat(200), 512);
        assert!(title.len() <= 512);
        assert!(title.ends_with("..."));
    }

    #[test]
    fn maximum_length_limit_100_notes_paginate_below_the_frame_ceiling() {
        let mut remaining = (0..100)
            .map(|index| NoteSummary {
                id: format!("00000000-0000-0000-0000-{index:012}"),
                title: "t".repeat(MAX_COMPANION_NOTE_SUMMARY_FIELD_BYTES),
                preview: "p".repeat(MAX_COMPANION_NOTE_SUMMARY_FIELD_BYTES),
                revision: u64::MAX,
                updated_at: "2026-07-27T12:34:56.789Z".to_string(),
            })
            .collect::<Vec<_>>();
        let mut remaining_cursors = (0..100)
            .map(|index| format!("cursor-{index:03}"))
            .collect::<Vec<_>>();
        let mut page_count = 0;

        while !remaining.is_empty() {
            let page =
                bounded_notes_page(remaining.clone(), remaining_cursors.clone(), None).unwrap();
            let included = page.items.len();
            assert!(included > 0, "every page must make pagination progress");
            assert!(notes_page_fits(&page).unwrap());
            if included < remaining.len() {
                assert_eq!(
                    page.next_cursor.as_deref(),
                    remaining_cursors.get(included - 1).map(String::as_str)
                );
            } else {
                assert!(page.next_cursor.is_none());
            }
            remaining.drain(..included);
            remaining_cursors.drain(..included);
            page_count += 1;
        }

        assert!(page_count > 1, "the maximum page must be byte-budgeted");
    }
}
