//! Automatic Persona dossier updates and prep-brief generation.
//!
//! The repository owns durable job claiming and transactional application.
//! This module owns the metered model call, strict response validation, and a
//! single process-wide worker so two completed recordings cannot rewrite the
//! same dossier concurrently.

use crate::{
    db::repositories::{
        PersonaCommitmentProposal, PersonaCommitmentUpdateProposal, PersonaDossierJob,
        PersonaDossierJobContext, PersonaDossierUpdate, Repositories,
    },
    domain::types::{AppError, NoteDto, PersonaCommitmentDirection},
    june_api,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

const MAX_DOSSIER_CHARS: usize = 60_000;
const MAX_TRUSTED_TRANSCRIPT_CHARS: usize = 120_000;
const MAX_COMMITMENTS: usize = 200;
const MAX_COMMITMENT_OPERATIONS: usize = 50;
const MAX_COMMITMENT_TEXT_CHARS: usize = 2_000;
const MAX_DUE_CHARS: usize = 160;
#[allow(dead_code)] // Phase 3 command wiring follows the isolated generator.
const MAX_PREP_CHARS: usize = 60_000;
const MAX_JOB_ERROR_CHARS: usize = 1_000;

static DOSSIER_WORKER: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Enqueues every trusted Participant attached to `generation_result_id` and
/// starts the shared worker. The task is detached deliberately: a ready note
/// stays ready even when storage, billing, or model generation fails here.
pub(crate) fn schedule_dossier_updates(repositories: Repositories, generation_result_id: String) {
    tauri::async_runtime::spawn(async move {
        if let Err(error) = repositories
            .enqueue_dossier_jobs_for_generation(&generation_result_id)
            .await
        {
            tracing::warn!(
                generation_result_id,
                %error,
                "failed to enqueue Persona dossier jobs"
            );
            return;
        }
        drain_dossier_jobs(repositories).await;
    });
}

/// Drains jobs already pending in durable storage. App startup and explicit
/// retry paths call this after they have reset or requeued the relevant jobs.
pub(crate) fn resume_dossier_updates(repositories: Repositories) {
    tauri::async_runtime::spawn(drain_dossier_jobs(repositories));
}

/// A process restart invalidates every in-memory worker lease. Reclaim those
/// jobs immediately instead of leaving them stuck until a fifteen-minute
/// lease expires. A reclaimed model call is a fresh metered attempt; production
/// remains gated on the durable response-recovery contract documented in the
/// Personas implementation plan.
pub(crate) fn resume_dossier_updates_after_restart(repositories: Repositories) {
    tauri::async_runtime::spawn(async move {
        let _worker = DOSSIER_WORKER.lock().await;
        if let Err(error) = repositories.requeue_interrupted_dossier_jobs().await {
            tracing::warn!(%error, "failed to reclaim interrupted Persona dossier jobs");
            return;
        }
        if let Err(error) = repositories.requeue_interrupted_prep_offers().await {
            tracing::warn!(%error, "failed to reclaim interrupted Persona prep offers");
        }
        drain_dossier_jobs_locked(repositories).await;
    });
}

async fn drain_dossier_jobs(repositories: Repositories) {
    let _worker = DOSSIER_WORKER.lock().await;
    drain_dossier_jobs_locked(repositories).await;
}

async fn drain_dossier_jobs_locked(repositories: Repositories) {
    loop {
        let job = match repositories.claim_next_dossier_job().await {
            Ok(Some(job)) => job,
            Ok(None) => return,
            Err(error) => {
                tracing::warn!(%error, "failed to claim a Persona dossier job");
                return;
            }
        };
        let job_id = job.id.clone();
        tracing::debug!(
            job_id,
            attempt_count = job.attempt_count,
            "claimed Persona dossier job"
        );
        if let Err(error) = run_dossier_job(&repositories, &job).await {
            let failure = bounded_job_error(&error);
            if let Err(storage_error) = repositories
                .fail_persona_dossier_job(&job_id, &failure)
                .await
            {
                tracing::warn!(
                    job_id,
                    %storage_error,
                    "failed to persist a Persona dossier job failure"
                );
            } else {
                tracing::warn!(
                    job_id,
                    error_code = error.code,
                    "Persona dossier job failed without changing its note"
                );
            }
        }
    }
}

async fn run_dossier_job(
    repositories: &Repositories,
    job: &PersonaDossierJob,
) -> Result<(), AppError> {
    let context = repositories.persona_dossier_job_context(job).await?;
    if context.source_note_id.trim().is_empty() {
        return Err(AppError::new(
            "persona_memory_context_invalid",
            "Persona dossier context has no source note.",
        ));
    }
    let dossier_revision = context.dossier_revision;
    let prompt = build_persona_memory_prompt(&context)?;
    let request_id = persona_operation_request_id(&job.idempotency_key);
    let raw = june_api::generate_persona_memory_json(&prompt, &request_id).await?;
    let parsed = parse_persona_dossier_update(&raw)?;
    let update = repository_update(parsed, &context)?;
    repositories
        .complete_persona_dossier_job(&job.id, dossier_revision, &update)
        .await
}

fn build_persona_memory_prompt(context: &PersonaDossierJobContext) -> Result<String, AppError> {
    let commitments = context
        .commitments
        .iter()
        .map(|commitment| {
            json!({
                "id": commitment.id,
                "direction": model_direction(&commitment.direction),
                "text": commitment.text,
                "due": commitment.due_value,
                "status": commitment.status,
            })
        })
        .collect::<Vec<_>>();
    let value = json!({
        "personaName": context.persona_name,
        "relationship": context.relationship,
        "dossier": context.dossier,
        "commitments": commitments,
        "trustedTranscript": context.trusted_transcript,
    });
    build_persona_memory_prompt_from_value(&value)
}

/// Copies only fields explicitly approved for configured-model context. This
/// is intentionally a whitelist instead of serializing a repository record:
/// future storage fields (especially Voiceprints or audio provenance) cannot
/// start leaving the device by accident.
fn build_persona_memory_prompt_from_value(context: &Value) -> Result<String, AppError> {
    let persona_name = required_string(context, &["personaName", "persona_name"], "Persona name")?;
    let relationship = optional_string(context, &["relationship"])?;
    let dossier = optional_string(context, &["dossier"])?.unwrap_or_default();
    reject_chars("Dossier", &dossier, MAX_DOSSIER_CHARS)?;
    let trusted_transcript = required_string(
        context,
        &["trustedTranscript", "trusted_transcript"],
        "Trusted transcript",
    )?;
    reject_chars(
        "Trusted transcript",
        &trusted_transcript,
        MAX_TRUSTED_TRANSCRIPT_CHARS,
    )?;

    let raw_commitments = value_field(context, &["commitments"])
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if raw_commitments.len() > MAX_COMMITMENTS {
        return Err(AppError::new(
            "persona_memory_context_invalid",
            "Persona context contains too many Commitments.",
        ));
    }
    let commitments = raw_commitments
        .iter()
        .map(commitment_context_value)
        .collect::<Result<Vec<_>, _>>()?;

    serde_json::to_string(&json!({
        "persona": {
            "name": persona_name,
            "relationship": relationship,
            "dossier": dossier,
        },
        "existingCommitments": commitments,
        "trustedTranscript": trusted_transcript,
    }))
    .map_err(|error| AppError::new("persona_memory_context_invalid", error.to_string()))
}

fn commitment_context_value(value: &Value) -> Result<Value, AppError> {
    let id = required_string(value, &["id"], "Commitment id")?;
    let direction = required_string(value, &["direction"], "Commitment direction")?;
    validate_direction(&direction)?;
    let text = required_string(value, &["text"], "Commitment text")?;
    reject_chars("Commitment text", &text, MAX_COMMITMENT_TEXT_CHARS)?;
    let due = optional_string(value, &["due"])?;
    if let Some(due) = due.as_deref() {
        reject_chars("Commitment due value", due, MAX_DUE_CHARS)?;
    }
    let status = required_string(value, &["status"], "Commitment status")?;
    validate_status(&status)?;
    Ok(json!({
        "id": id,
        "direction": direction,
        "text": text,
        "due": due,
        "status": status,
    }))
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ParsedPersonaDossierUpdate {
    dossier: String,
    #[serde(default)]
    new_commitments: Vec<ParsedNewCommitment>,
    #[serde(default)]
    commitment_updates: Vec<ParsedCommitmentUpdate>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ParsedNewCommitment {
    direction: String,
    text: String,
    due: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ParsedCommitmentUpdate {
    id: String,
    status: String,
}

fn parse_persona_dossier_update(raw: &str) -> Result<ParsedPersonaDossierUpdate, AppError> {
    let raw = strip_json_fence(raw.trim());
    let mut value: Value = serde_json::from_str(raw)
        .map_err(|error| AppError::new("persona_memory_response_invalid", error.to_string()))?;
    validate_and_normalize_update(&mut value)?;
    serde_json::from_value(value)
        .map_err(|error| AppError::new("persona_memory_response_invalid", error.to_string()))
}

fn repository_update(
    parsed: ParsedPersonaDossierUpdate,
    context: &PersonaDossierJobContext,
) -> Result<PersonaDossierUpdate, AppError> {
    let new_commitments = parsed
        .new_commitments
        .into_iter()
        .map(|commitment| {
            let direction = repository_direction(&commitment.direction)?;
            Ok(PersonaCommitmentProposal {
                item_key: commitment_item_key(
                    &commitment.direction,
                    &commitment.text,
                    commitment.due.as_deref(),
                ),
                direction,
                text: commitment.text,
                due: commitment.due,
            })
        })
        .collect::<Result<Vec<_>, AppError>>()?;
    let commitment_updates = parsed
        .commitment_updates
        .into_iter()
        .map(|update| {
            let existing = context
                .commitments
                .iter()
                .find(|commitment| commitment.id == update.id)
                .ok_or_else(|| {
                    AppError::new(
                        "persona_memory_response_invalid",
                        "Persona memory response referenced an unknown Commitment.",
                    )
                })?;
            Ok(PersonaCommitmentUpdateProposal {
                id: update.id,
                status: update.status,
                text: existing.text.clone(),
                due: existing.due_value.clone(),
            })
        })
        .collect::<Result<Vec<_>, AppError>>()?;
    Ok(PersonaDossierUpdate {
        dossier: parsed.dossier,
        new_commitments,
        commitment_updates,
    })
}

fn model_direction(direction: &PersonaCommitmentDirection) -> &'static str {
    match direction {
        PersonaCommitmentDirection::PersonaOwesUser => "persona_to_user",
        PersonaCommitmentDirection::UserOwesPersona => "user_to_persona",
    }
}

fn repository_direction(direction: &str) -> Result<PersonaCommitmentDirection, AppError> {
    match direction {
        "persona_to_user" => Ok(PersonaCommitmentDirection::PersonaOwesUser),
        "user_to_persona" => Ok(PersonaCommitmentDirection::UserOwesPersona),
        _ => Err(AppError::new(
            "persona_memory_response_invalid",
            "Commitment direction is invalid.",
        )),
    }
}

fn commitment_item_key(direction: &str, text: &str, due: Option<&str>) -> String {
    let mut digest = Sha256::new();
    digest.update(direction.as_bytes());
    digest.update([0]);
    digest.update(text.as_bytes());
    digest.update([0]);
    digest.update(due.unwrap_or_default().as_bytes());
    format!("v1:{:x}", digest.finalize())
}

pub(crate) fn persona_operation_request_id(idempotency_key: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(idempotency_key.as_bytes());
    format!("june-persona-operation:{:x}", digest.finalize())
}

fn validate_and_normalize_update(value: &mut Value) -> Result<(), AppError> {
    let object = value.as_object_mut().ok_or_else(|| {
        AppError::new(
            "persona_memory_response_invalid",
            "Persona memory response must be a JSON object.",
        )
    })?;
    reject_unknown_keys(
        object,
        &["dossier", "newCommitments", "commitmentUpdates"],
        "Persona memory response",
    )?;
    normalize_required_text(object, "dossier", "Dossier", MAX_DOSSIER_CHARS, true)?;
    normalize_operation_array(object, "newCommitments", normalize_new_commitment)?;
    normalize_operation_array(object, "commitmentUpdates", normalize_commitment_update)?;
    Ok(())
}

fn normalize_operation_array(
    object: &mut Map<String, Value>,
    field: &str,
    normalize: fn(&mut Value) -> Result<(), AppError>,
) -> Result<(), AppError> {
    if !object.contains_key(field) {
        object.insert(field.to_string(), Value::Array(Vec::new()));
    }
    let operations = object
        .get_mut(field)
        .and_then(Value::as_array_mut)
        .ok_or_else(|| {
            AppError::new(
                "persona_memory_response_invalid",
                format!("{field} must be an array."),
            )
        })?;
    if operations.len() > MAX_COMMITMENT_OPERATIONS {
        return Err(AppError::new(
            "persona_memory_response_invalid",
            format!("{field} contains too many operations."),
        ));
    }
    for operation in operations {
        normalize(operation)?;
    }
    Ok(())
}

fn normalize_new_commitment(value: &mut Value) -> Result<(), AppError> {
    let object = value.as_object_mut().ok_or_else(|| {
        AppError::new(
            "persona_memory_response_invalid",
            "Each new Commitment must be an object.",
        )
    })?;
    reject_unknown_keys(object, &["direction", "text", "due"], "New Commitment")?;
    let direction =
        normalize_required_text(object, "direction", "Commitment direction", 32, false)?;
    validate_direction(&direction)?;
    normalize_required_text(
        object,
        "text",
        "Commitment text",
        MAX_COMMITMENT_TEXT_CHARS,
        false,
    )?;
    normalize_optional_text(object, "due", "Commitment due value", MAX_DUE_CHARS)?;
    Ok(())
}

fn normalize_commitment_update(value: &mut Value) -> Result<(), AppError> {
    let object = value.as_object_mut().ok_or_else(|| {
        AppError::new(
            "persona_memory_response_invalid",
            "Each Commitment update must be an object.",
        )
    })?;
    reject_unknown_keys(object, &["id", "status"], "Commitment update")?;
    normalize_required_text(object, "id", "Commitment id", 128, false)?;
    let status = normalize_required_text(object, "status", "Commitment status", 16, false)?;
    validate_status(&status)
}

fn normalize_required_text(
    object: &mut Map<String, Value>,
    field: &str,
    label: &str,
    max_chars: usize,
    allow_empty: bool,
) -> Result<String, AppError> {
    let text = object
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .ok_or_else(|| {
            AppError::new(
                "persona_memory_response_invalid",
                format!("{label} must be text."),
            )
        })?;
    if !allow_empty && text.is_empty() {
        return Err(AppError::new(
            "persona_memory_response_invalid",
            format!("{label} cannot be empty."),
        ));
    }
    reject_chars(label, text, max_chars)?;
    let normalized = text.to_string();
    object.insert(field.to_string(), Value::String(normalized.clone()));
    Ok(normalized)
}

fn normalize_optional_text(
    object: &mut Map<String, Value>,
    field: &str,
    label: &str,
    max_chars: usize,
) -> Result<(), AppError> {
    let Some(value) = object.get(field) else {
        object.insert(field.to_string(), Value::Null);
        return Ok(());
    };
    if value.is_null() {
        return Ok(());
    }
    let text = value.as_str().map(str::trim).ok_or_else(|| {
        AppError::new(
            "persona_memory_response_invalid",
            format!("{label} must be text or null."),
        )
    })?;
    reject_chars(label, text, max_chars)?;
    object.insert(field.to_string(), Value::String(text.to_string()));
    Ok(())
}

fn reject_unknown_keys(
    object: &Map<String, Value>,
    allowed: &[&str],
    label: &str,
) -> Result<(), AppError> {
    if let Some(key) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(AppError::new(
            "persona_memory_response_invalid",
            format!("{label} contains an unsupported field: {key}."),
        ));
    }
    Ok(())
}

fn validate_direction(direction: &str) -> Result<(), AppError> {
    if matches!(direction, "persona_to_user" | "user_to_persona") {
        Ok(())
    } else {
        Err(AppError::new(
            "persona_memory_response_invalid",
            "Commitment direction is invalid.",
        ))
    }
}

fn validate_status(status: &str) -> Result<(), AppError> {
    if matches!(status, "open" | "done" | "dropped") {
        Ok(())
    } else {
        Err(AppError::new(
            "persona_memory_response_invalid",
            "Commitment status is invalid.",
        ))
    }
}

fn strip_json_fence(value: &str) -> &str {
    let Some(after_open) = value
        .strip_prefix("```json")
        .or_else(|| value.strip_prefix("```JSON"))
        .or_else(|| value.strip_prefix("```"))
    else {
        return value;
    };
    after_open
        .trim_start_matches(['\r', '\n'])
        .strip_suffix("```")
        .unwrap_or(after_open)
        .trim()
}

fn required_string(value: &Value, names: &[&str], label: &str) -> Result<String, AppError> {
    let value = optional_string(value, names)?.unwrap_or_default();
    if value.is_empty() {
        Err(AppError::new(
            "persona_memory_context_invalid",
            format!("{label} is empty."),
        ))
    } else {
        Ok(value)
    }
}

fn optional_string(value: &Value, names: &[&str]) -> Result<Option<String>, AppError> {
    let Some(value) = value_field(value, names) else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    value
        .as_str()
        .map(str::trim)
        .map(str::to_string)
        .map(Some)
        .ok_or_else(|| {
            AppError::new(
                "persona_memory_context_invalid",
                format!("{} must be text.", names[0]),
            )
        })
}

fn value_field<'a>(value: &'a Value, names: &[&str]) -> Option<&'a Value> {
    names.iter().find_map(|name| value.get(*name))
}

fn reject_chars(label: &str, value: &str, max_chars: usize) -> Result<(), AppError> {
    if value.chars().count() > max_chars {
        Err(AppError::new(
            "persona_memory_context_invalid",
            format!("{label} is too long."),
        ))
    } else {
        Ok(())
    }
}

fn bounded_job_error(error: &AppError) -> String {
    let text = format!("{}: {}", error.code, error.message);
    text.chars().take(MAX_JOB_ERROR_CHARS).collect()
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)] // Phase 3 command wiring follows the isolated generator.
pub(crate) struct PrepBriefContext {
    pub expected_people: Vec<PrepPersonContext>,
    pub recent_notes: Vec<PrepNoteContext>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)] // Constructed by the Phase 3 detection/manual prep adapters.
pub(crate) struct PrepPersonContext {
    pub name: String,
    pub relationship: Option<String>,
    pub dossier: String,
    pub commitments: Vec<PrepCommitmentContext>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)] // Constructed by the Phase 3 detection/manual prep adapters.
pub(crate) struct PrepCommitmentContext {
    pub direction: String,
    pub text: String,
    pub due: Option<String>,
    pub status: String,
    pub source_note_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)] // Constructed by the Phase 3 detection/manual prep adapters.
pub(crate) struct PrepNoteContext {
    pub note_id: String,
    pub title: String,
    pub content: String,
}

pub(crate) struct GeneratedPrepBrief {
    pub title: String,
    pub content: String,
}

/// Builds a metered prep brief from local Persona context, then persists it as
/// a normal ready note. Callers must only invoke this after an explicit user
/// request or accepted prep offer.
pub(crate) async fn create_prep_brief(
    repositories: &Repositories,
    persona_ids: &[String],
) -> Result<NoteDto, AppError> {
    let draft = generate_prep_brief_draft(repositories, persona_ids, None).await?;
    let note = repositories.create_note(None).await?;
    repositories
        .set_generated_note(&note.id, Some(draft.title), draft.content)
        .await
        .map_err(Into::into)
}

pub(crate) async fn generate_prep_brief_draft(
    repositories: &Repositories,
    persona_ids: &[String],
    request_id: Option<&str>,
) -> Result<GeneratedPrepBrief, AppError> {
    if persona_ids.is_empty() || persona_ids.len() > 12 {
        return Err(AppError::new(
            "persona_prep_context_invalid",
            "A prep brief needs 1 to 12 expected people.",
        ));
    }
    let mut seen_people = HashSet::new();
    let mut seen_notes = HashSet::new();
    let mut expected_people = Vec::new();
    let mut recent_notes = Vec::new();
    for persona_id in persona_ids {
        let persona_id = persona_id.trim();
        if persona_id.is_empty() || !seen_people.insert(persona_id.to_string()) {
            continue;
        }
        let detail = repositories.get_persona(persona_id).await?;
        if detail.archived_at.is_some() {
            return Err(AppError::new(
                "persona_prep_archived",
                "Restore this Persona before preparing a meeting with them.",
            ));
        }
        let commitments = detail
            .commitments
            .iter()
            .filter(|commitment| commitment.status == "open")
            .map(|commitment| PrepCommitmentContext {
                direction: match &commitment.direction {
                    PersonaCommitmentDirection::PersonaOwesUser => "personaOwesUser".to_string(),
                    PersonaCommitmentDirection::UserOwesPersona => "userOwesPersona".to_string(),
                },
                text: commitment.text.clone(),
                due: commitment.due_value.clone(),
                status: commitment.status.clone(),
                source_note_id: commitment.source_note_id.clone(),
            })
            .collect();
        expected_people.push(PrepPersonContext {
            name: detail.name.clone(),
            relationship: detail.relationship.clone(),
            dossier: detail.dossier,
            commitments,
        });
        for meeting in detail.meetings.iter().take(5) {
            if recent_notes.len() >= 20 || !seen_notes.insert(meeting.note_id.clone()) {
                continue;
            }
            let note = repositories.get_note(&meeting.note_id).await?;
            let content = note
                .edited_content
                .or(note.generated_content)
                .unwrap_or_default()
                .chars()
                .take(20_000)
                .collect();
            recent_notes.push(PrepNoteContext {
                note_id: note.id,
                title: note.title,
                content,
            });
        }
    }
    if expected_people.is_empty() {
        return Err(AppError::new(
            "persona_prep_context_invalid",
            "No valid expected people were selected.",
        ));
    }
    let title = format!(
        "Prep for {}",
        expected_people
            .iter()
            .map(|person| person.name.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    );
    let content = generate_prep_brief_content(
        &PrepBriefContext {
            expected_people,
            recent_notes,
        },
        request_id,
    )
    .await?;
    Ok(GeneratedPrepBrief { title, content })
}

/// Generates only the Markdown body. The caller owns user acceptance, note
/// creation, and refresh events.
#[allow(dead_code)] // Phase 3 command wiring follows the isolated generator.
pub(crate) async fn generate_prep_brief_content(
    context: &PrepBriefContext,
    request_id: Option<&str>,
) -> Result<String, AppError> {
    let prompt = build_prep_brief_prompt(context)?;
    let content = june_api::generate_persona_prep_markdown(&prompt, request_id).await?;
    let content = content.trim();
    if content.is_empty() {
        return Err(AppError::new(
            "persona_prep_empty",
            "Persona prep generation returned an empty brief.",
        ));
    }
    reject_chars("Prep brief", content, MAX_PREP_CHARS)?;
    validate_prep_brief_citations(content, context)?;
    Ok(content.to_string())
}

fn validate_prep_brief_citations(
    content: &str,
    context: &PrepBriefContext,
) -> Result<(), AppError> {
    if context.recent_notes.is_empty()
        || context
            .recent_notes
            .iter()
            .map(|note| note_reference(&note.note_id, &note.title))
            .any(|reference| content.contains(&reference))
    {
        return Ok(());
    }
    Err(AppError::new(
        "persona_prep_citations_missing",
        "The generated prep brief did not cite any supplied source note.",
    ))
}

fn build_prep_brief_prompt(context: &PrepBriefContext) -> Result<String, AppError> {
    if context.expected_people.is_empty() {
        return Err(AppError::new(
            "persona_prep_context_invalid",
            "A prep brief needs at least one expected person.",
        ));
    }
    let mut seen_references = HashSet::new();
    let mut references = Vec::new();
    let notes = context
        .recent_notes
        .iter()
        .map(|note| {
            if note.note_id.trim().is_empty() {
                return Err(AppError::new(
                    "persona_prep_context_invalid",
                    "A prep source note has no id.",
                ));
            }
            let reference = note_reference(&note.note_id, &note.title);
            if seen_references.insert(reference.clone()) {
                references.push(reference.clone());
            }
            Ok(json!({
                "reference": reference,
                "content": note.content,
            }))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let value = json!({
        "expectedPeople": context.expected_people,
        "recentNotes": notes,
        "availableSourceReferences": references,
    });
    serde_json::to_string(&value)
        .map_err(|error| AppError::new("persona_prep_context_invalid", error.to_string()))
}

fn note_reference(note_id: &str, title: &str) -> String {
    let title = title
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .replace('"', "")
        .chars()
        .take(80)
        .collect::<String>();
    if title.is_empty() {
        format!("@note:{}", note_id.trim())
    } else {
        format!("@note:{} (\"{title}\")", note_id.trim())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::types::PersonaCommitmentDto;

    #[test]
    fn memory_prompt_whitelists_context_and_excludes_private_fields() {
        let private_embedding = "EMBEDDING_SENTINEL_9f5524";
        let private_audio = "/private/recordings/AUDIO_SENTINEL.wav";
        let generated_note = "GENERATED_NOTE_SENTINEL";
        let secret = "SECRET_SENTINEL_2bd61c";
        let prompt = build_persona_memory_prompt_from_value(&json!({
            "personaName": "Jun",
            "relationship": "Product lead",
            "dossier": "Prefers written proposals.",
            "dossierRevision": 4,
            "trustedTranscript": "Jun 0:00-0:05\nI will send the proposal Friday.",
            "commitments": [{
                "id": "commitment-1",
                "direction": "persona_to_user",
                "text": "Send the proposal",
                "due": "Friday",
                "status": "open",
                "sourceNoteId": "note-old",
                "embedding": private_embedding,
            }],
            "voiceprints": [private_embedding],
            "audioPath": private_audio,
            "generatedNote": generated_note,
            "providerSecret": secret,
            "sourceNoteId": format!("{private_audio}:{private_embedding}"),
        }))
        .expect("prompt");

        assert!(prompt.contains("Jun"));
        assert!(prompt.contains("Send the proposal"));
        assert!(prompt.contains("trustedTranscript"));
        for forbidden in [
            private_embedding,
            private_audio,
            generated_note,
            secret,
            "voiceprints",
        ] {
            assert!(!prompt.contains(forbidden), "prompt leaked {forbidden}");
        }
        assert!(!prompt.contains("sourceNoteId"));
    }

    #[test]
    fn parses_and_normalizes_strict_memory_json() {
        let update = parse_persona_dossier_update(
            r#"```json
            {
              "dossier": "  Product lead who prefers written proposals.  ",
              "newCommitments": [
                {"direction":"persona_to_user","text":"  Send proposal  ","due":" Friday "}
              ],
              "commitmentUpdates": [
                {"id":" existing-1 ","status":"done"}
              ]
            }
            ```"#,
        )
        .expect("valid update");
        let value = serde_json::to_value(update).expect("serialize update");

        assert_eq!(
            value["dossier"],
            "Product lead who prefers written proposals."
        );
        assert_eq!(value["newCommitments"][0]["text"], "Send proposal");
        assert_eq!(value["newCommitments"][0]["due"], "Friday");
        assert_eq!(value["commitmentUpdates"][0]["id"], "existing-1");
    }

    #[test]
    fn rejects_schema_creep_and_invalid_commitments() {
        let extra_type = parse_persona_dossier_update(
            r#"{"dossier":"x","newCommitments":[],"commitmentUpdates":[],"contacts":[]}"#,
        )
        .expect_err("second structured type must fail");
        assert_eq!(extra_type.code, "persona_memory_response_invalid");

        let invalid_direction = parse_persona_dossier_update(
            r#"{"dossier":"x","newCommitments":[{"direction":"someone_else","text":"Call","due":null}],"commitmentUpdates":[]}"#,
        )
        .expect_err("invalid direction must fail");
        assert_eq!(invalid_direction.code, "persona_memory_response_invalid");
    }

    #[test]
    fn converts_model_operations_without_model_owned_provenance() {
        let context = PersonaDossierJobContext {
            persona_name: "Jun".to_string(),
            relationship: Some("Product lead".to_string()),
            dossier: "Existing dossier".to_string(),
            dossier_revision: 7,
            commitments: vec![PersonaCommitmentDto {
                id: "existing-1".to_string(),
                persona_id: "persona-1".to_string(),
                direction: PersonaCommitmentDirection::PersonaOwesUser,
                text: "Send the proposal".to_string(),
                due_value: Some("Friday".to_string()),
                status: "open".to_string(),
                source_note_id: Some("source-old".to_string()),
                created_at: "2026-07-10T00:00:00Z".to_string(),
                updated_at: "2026-07-10T00:00:00Z".to_string(),
            }],
            trusted_transcript: "Jun: I sent the proposal.".to_string(),
            source_note_id: "source-new".to_string(),
        };
        let parsed = parse_persona_dossier_update(
            r#"{
              "dossier":"Updated dossier",
              "newCommitments":[{"direction":"user_to_persona","text":"Share feedback","due":null}],
              "commitmentUpdates":[{"id":"existing-1","status":"done"}]
            }"#,
        )
        .expect("parse");

        let update = repository_update(parsed, &context).expect("convert");
        assert_eq!(update.dossier, "Updated dossier");
        assert_eq!(update.new_commitments.len(), 1);
        assert!(matches!(
            update.new_commitments[0].direction,
            PersonaCommitmentDirection::UserOwesPersona
        ));
        assert!(update.new_commitments[0].item_key.starts_with("v1:"));
        assert_eq!(update.commitment_updates[0].status, "done");
        assert_eq!(update.commitment_updates[0].text, "Send the proposal");
        assert_eq!(update.commitment_updates[0].due.as_deref(), Some("Friday"));
    }

    #[test]
    fn failed_job_messages_are_bounded_and_do_not_contain_context() {
        let message = "provider unavailable ".repeat(200);
        let error = AppError::new("persona_memory_failed", message);
        let persisted = bounded_job_error(&error);

        assert!(persisted.chars().count() <= MAX_JOB_ERROR_CHARS);
        assert!(persisted.starts_with("persona_memory_failed:"));
        assert!(!persisted.contains("trustedTranscript"));
    }

    #[test]
    fn prep_prompt_uses_canonical_note_references() {
        let prompt = build_prep_brief_prompt(&PrepBriefContext {
            expected_people: vec![PrepPersonContext {
                name: "Jun".to_string(),
                relationship: Some("Product lead".to_string()),
                dossier: "Prefers concise updates.".to_string(),
                commitments: vec![],
            }],
            recent_notes: vec![PrepNoteContext {
                note_id: "note-1".to_string(),
                title: "  Weekly \"sync\"  ".to_string(),
                content: "Discussed the launch.".to_string(),
            }],
        })
        .expect("prompt");

        assert!(prompt.contains(r#"@note:note-1 (\"Weekly sync\")"#));
        assert!(prompt.contains("Product lead"));
    }

    #[test]
    fn prep_brief_requires_an_exact_supplied_note_reference() {
        let context = PrepBriefContext {
            expected_people: vec![PrepPersonContext {
                name: "Jun".into(),
                relationship: None,
                dossier: String::new(),
                commitments: Vec::new(),
            }],
            recent_notes: vec![PrepNoteContext {
                note_id: "note-1".into(),
                title: "Planning".into(),
                content: "Discussed launch timing.".into(),
            }],
        };

        assert!(validate_prep_brief_citations(
            "Last time: launch timing @note:note-1 (\"Planning\")",
            &context,
        )
        .is_ok());
        let error = validate_prep_brief_citations("Last time: launch timing", &context)
            .expect_err("missing citation must fail");
        assert_eq!(error.code, "persona_prep_citations_missing");
    }
}
