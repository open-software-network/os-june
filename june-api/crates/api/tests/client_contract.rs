//! Client compatibility contract suite.
//!
//! Older stable desktop builds keep calling the production `/v1` API long
//! after main moves on, with their request shapes and response expectations
//! baked in at release time. Each directory under
//! `tests/fixtures/client-contract/` snapshots the wire contract one shipped
//! stable app version depends on: the exact requests it sends and the
//! response fields its DTOs require. These tests replay every snapshot
//! against the current router, so a change that would break an older shipped
//! client fails CI (and the production promote gate) instead of production.
//!
//! If a change here is the only thing failing your PR, you are about to
//! break a shipped app version. Do not edit a fixture to make it pass; see
//! docs/adr/0019-june-api-v1-compatibility-policy.md for the rules and for
//! how fixture versions are added and retired.

use pretty_assertions::assert_eq;
use serde::Deserialize;
use std::{collections::BTreeMap, error::Error, fs, path::Path};

mod support;
use support::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Fixture {
    /// What client call this pins; shown in failure output.
    description: String,
    /// Path plus query string, e.g. `/v1/models?type=text`.
    endpoint: String,
    /// Send the standard bearer token (default) or no Authorization header.
    #[serde(default = "default_true")]
    auth: bool,
    /// JSON POST body. Mutually exclusive with `multipart`; neither = GET.
    #[serde(default)]
    body: Option<serde_json::Value>,
    /// Multipart POST form. Parts with a `filename` are file parts.
    #[serde(default)]
    multipart: Option<Vec<FixturePart>>,
    expect: Expect,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FixturePart {
    name: String,
    /// Text value, or file bytes as a UTF-8 string when `filename` is set.
    value: String,
    #[serde(default)]
    filename: Option<String>,
    #[serde(default)]
    content_type: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Expect {
    /// Response is the standard `ApiResponse` envelope (default). `false`
    /// for opaque proxy responses where the client only reads the status.
    #[serde(default = "default_true")]
    envelope: bool,
    /// For proxy responses (`envelope: false`): the exact JSON body the
    /// route must return for this request. Pins passthrough behavior; a
    /// route that starts wrapping or reshaping the upstream body fails.
    #[serde(default)]
    raw_json: Option<serde_json::Value>,
    /// Response arrives as SSE; the envelope is the `result` event payload.
    #[serde(default)]
    sse: bool,
    /// Fields the pinned client version deserializes from `data` as
    /// required (non-`Option`), as `"name"` or `"name:type"` where type is
    /// one of string, number, boolean, array, object. Must be present,
    /// non-null, and of the pinned type.
    #[serde(default)]
    required_data_fields: Vec<String>,
    /// When the required-item checks apply to `data[itemsField]` instead of
    /// `data` itself.
    #[serde(default)]
    items_field: Option<String>,
    /// Required fields of each element of the checked array, which must be
    /// non-empty so the checks actually run.
    #[serde(default)]
    required_item_fields: Vec<String>,
}

fn default_true() -> bool {
    true
}

fn fixtures_root() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/client-contract")
}

/// Version directories (`v0.0.33`, ...), oldest first.
fn version_dirs() -> Result<Vec<std::path::PathBuf>, Box<dyn Error>> {
    let mut dirs = Vec::new();
    for entry in fs::read_dir(fixtures_root())? {
        let path = entry?.path();
        if path.is_dir() {
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default();
            assert!(
                name.starts_with('v') && name[1..].split('.').count() == 3,
                "client-contract directory {name:?} is not a vX.Y.Z app version"
            );
            dirs.push(path);
        }
    }
    dirs.sort();
    assert!(
        !dirs.is_empty(),
        "no pinned client versions under tests/fixtures/client-contract"
    );
    Ok(dirs)
}

#[tokio::test]
async fn pinned_client_requests_are_still_accepted() -> Result<(), Box<dyn Error>> {
    for dir in version_dirs()? {
        let mut fixture_paths: Vec<_> = fs::read_dir(&dir)?
            .map(|entry| entry.map(|entry| entry.path()))
            .collect::<Result<_, _>>()?;
        fixture_paths.retain(|path| path.extension().is_some_and(|ext| ext == "json"));
        fixture_paths.sort();
        assert!(
            !fixture_paths.is_empty(),
            "no fixtures in {}",
            dir.display()
        );
        let app_version = dir
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| name.strip_prefix('v'))
            .ok_or_else(|| format!("bad version directory {}", dir.display()))?
            .to_string();
        for path in fixture_paths {
            let fixture: Fixture = serde_json::from_str(&fs::read_to_string(&path)?)
                .map_err(|error| format!("{}: {error}", path.display()))?;
            let label = format!("{} ({})", path.display(), fixture.description);
            check_fixture(&fixture, &app_version, &label).await?;
        }
    }
    Ok(())
}

async fn check_fixture(
    fixture: &Fixture,
    app_version: &str,
    label: &str,
) -> Result<(), Box<dyn Error>> {
    let authorization = fixture.auth.then_some(AUTHORIZATION);
    let mut request = match (&fixture.body, &fixture.multipart) {
        (Some(body), None) => json_request(&fixture.endpoint, body, authorization)?,
        (None, Some(parts)) => {
            let parts = parts.iter().map(|part| match &part.filename {
                Some(filename) => typed_file_part(
                    part.name.clone(),
                    filename.clone(),
                    part.content_type.clone().unwrap_or_default(),
                    part.value.clone().into_bytes(),
                ),
                None => text_part(part.name.clone(), part.value.clone()),
            });
            multipart_request_with_auth(
                &fixture.endpoint,
                multipart_body(parts.collect::<Vec<_>>()),
                authorization,
            )?
        }
        (None, None) => get_request_with_auth(&fixture.endpoint, authorization)?,
        (Some(_), Some(_)) => return Err(format!("{label}: both body and multipart set").into()),
    };
    // The shipped client stamps its real version on every request.
    request
        .headers_mut()
        .insert(june_api::JUNE_APP_VERSION_HEADER, app_version.parse()?);

    let response = send(request).await;
    let status = response.status();
    assert!(
        status.is_success(),
        "{label}: expected success, got {status}: {}",
        response_text(response).await?
    );
    if !fixture.expect.envelope {
        if let Some(expected) = &fixture.expect.raw_json {
            let body = response_json(response).await?;
            assert_eq!(&body, expected, "{label}: proxied body changed");
        }
        return Ok(());
    }

    let envelope = if fixture.expect.sse {
        serde_json::from_str(&sse_event_data(&response_text(response).await?, "result")?)?
    } else {
        response_json(response).await?
    };
    assert_eq!(
        envelope["success"],
        serde_json::Value::Bool(true),
        "{label}: envelope success"
    );
    let data = &envelope["data"];
    assert!(!data.is_null(), "{label}: envelope data is null");
    for spec in &fixture.expect.required_data_fields {
        check_required_field(data, spec, label, "data")?;
    }
    if !fixture.expect.required_item_fields.is_empty() {
        let items = match &fixture.expect.items_field {
            Some(field) => &data[field.as_str()],
            None => data,
        };
        let Some(items) = items.as_array() else {
            return Err(format!("{label}: checked value is not an array: {items}").into());
        };
        assert!(!items.is_empty(), "{label}: checked array is empty");
        for item in items {
            for spec in &fixture.expect.required_item_fields {
                check_required_field(item, spec, label, "item")?;
            }
        }
    }
    Ok(())
}

/// Checks one `"name"` / `"name:type"` field spec. The pinned client's serde
/// needs the field present, non-null, and of the shipped JSON type; a type
/// change (say `provider` becoming a number) breaks its deserialization just
/// as hard as a removal.
fn check_required_field(
    container: &serde_json::Value,
    spec: &str,
    label: &str,
    scope: &str,
) -> Result<(), Box<dyn Error>> {
    let (field, kind) = match spec.split_once(':') {
        Some((field, kind)) => (field, Some(kind)),
        None => (spec, None),
    };
    let Some(value) = container.get(field).filter(|value| !value.is_null()) else {
        return Err(format!(
            "{label}: {scope}.{field} is missing or null; the pinned client requires it: {container}"
        )
        .into());
    };
    if let Some(kind) = kind {
        let matches = match kind {
            "string" => value.is_string(),
            "number" => value.is_number(),
            "boolean" => value.is_boolean(),
            "array" => value.is_array(),
            "object" => value.is_object(),
            other => {
                return Err(
                    format!("{label}: unknown type {other:?} in field spec {spec:?}").into(),
                );
            }
        };
        if !matches {
            return Err(format!(
                "{label}: {scope}.{field} must be a JSON {kind} for the pinned client, got: {value}"
            )
            .into());
        }
    }
    Ok(())
}

/// The client hardcodes error-code numbers (insufficient credits, expired
/// token) and every shipped build keeps its copy forever. The registry
/// fixture pins the numbers; this test links them to the server constants so
/// a renumbering fails here instead of misrouting old clients' error
/// handling.
#[test]
fn error_code_registry_is_stable() -> Result<(), Box<dyn Error>> {
    let pinned: BTreeMap<String, i32> = serde_json::from_str(&fs::read_to_string(
        fixtures_root().join("error-codes.json"),
    )?)?;
    let current = BTreeMap::from(
        [
            ("badRequest", june_api::ERR_BAD_REQUEST),
            ("unauthorized", june_api::ERR_UNAUTHORIZED),
            ("unprocessable", june_api::ERR_UNPROCESSABLE),
            ("notFound", june_api::ERR_NOT_FOUND),
            ("insufficientCredits", june_api::ERR_INSUFFICIENT_CREDITS),
            ("payloadTooLarge", june_api::ERR_PAYLOAD_TOO_LARGE),
            ("authorizationDenied", june_api::ERR_AUTHORIZATION_DENIED),
            ("internal", june_api::ERR_INTERNAL),
            ("upstream", june_api::ERR_UPSTREAM),
            ("metering", june_api::ERR_METERING),
            ("timeout", june_api::ERR_TIMEOUT),
        ]
        .map(|(name, code)| (name.to_string(), code)),
    );
    assert_eq!(pinned, current, "error codes are part of the wire contract");
    Ok(())
}

/// Every shipped client parses errors through the same envelope struct:
/// `success`, optional `error_code`, optional `message`, optional `data`.
#[tokio::test]
async fn error_envelope_shape_is_stable() -> Result<(), Box<dyn Error>> {
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

    assert_eq!(response.status().as_u16(), 401);
    let body = response_json(response).await?;
    assert_eq!(body["success"], serde_json::Value::Bool(false));
    assert_eq!(
        body["error_code"],
        serde_json::json!(june_api::ERR_UNAUTHORIZED)
    );
    assert!(body["message"].is_string(), "message must be a string");
    Ok(())
}
