use std::{
    collections::{BTreeSet, HashMap, HashSet},
    fs, io,
    path::{Path, PathBuf},
};

use serde_json::Value;

pub const CLOVY_OBSIDIAN_SKILL_ID: &str = "clovy-obsidian";
pub const LEGACY_OBSIDIAN_SKILL_ID: &str = "june-obsidian";
pub const CLOVY_OBSIDIAN_SKILL_DESCRIPTION: &str =
    "Work with the Obsidian vault currently selected in Clovy.";
pub const LEGACY_OBSIDIAN_SKILL_DESCRIPTION: &str =
    "Work with the Obsidian vault currently selected in June.";
const BUNDLED_CLOVY_OBSIDIAN_SKILL: &str =
    include_str!("../../resources/agent-skills/clovy-obsidian/SKILL.md");
const RELEASED_LEGACY_OBSIDIAN_SKILL_V1: &str = include_str!("fixtures/legacy-obsidian-v1.md");

pub fn canonical_skill_id(skill_id: &str) -> &str {
    if skill_id == LEGACY_OBSIDIAN_SKILL_ID {
        CLOVY_OBSIDIAN_SKILL_ID
    } else {
        skill_id
    }
}

pub(crate) fn canonicalize_load_skill_arguments(arguments: &mut Value) -> bool {
    let Some(arguments) = arguments.as_object_mut() else {
        return false;
    };
    if arguments.get("name").and_then(Value::as_str) != Some(LEGACY_OBSIDIAN_SKILL_ID) {
        return false;
    }
    arguments.insert("name".into(), Value::String(CLOVY_OBSIDIAN_SKILL_ID.into()));
    true
}

pub(crate) fn migrate_load_skill_result(
    result: &mut Value,
    managed_skill_root: Option<&Path>,
) -> bool {
    if !is_managed_obsidian_skill_result(result, managed_skill_root) {
        return false;
    }
    let Some(result) = result.as_object_mut() else {
        return false;
    };
    let path = result
        .get("path")
        .and_then(Value::as_str)
        .expect("managed skill result path")
        .to_string();
    let canonical_path = canonical_managed_load_skill_path(
        &path,
        managed_skill_root.expect("managed skill result root"),
    )
    .expect("managed skill result canonical path");
    let mut changed = false;
    if result.get("name").and_then(Value::as_str) == Some(LEGACY_OBSIDIAN_SKILL_ID) {
        result.insert("name".into(), Value::String(CLOVY_OBSIDIAN_SKILL_ID.into()));
        changed = true;
    }
    if let Some(content) = result.get_mut("content") {
        if let Some(value) = content.as_str() {
            let canonical_legacy =
                skill_content_for_id(RELEASED_LEGACY_OBSIDIAN_SKILL_V1, CLOVY_OBSIDIAN_SKILL_ID);
            if value == RELEASED_LEGACY_OBSIDIAN_SKILL_V1 || value == canonical_legacy {
                *content = Value::String(BUNDLED_CLOVY_OBSIDIAN_SKILL.into());
                changed = true;
            }
        }
    }
    if canonical_path != path {
        result.insert("path".into(), Value::String(canonical_path));
        changed = true;
    }
    changed
}

pub(crate) fn is_managed_obsidian_skill_result(
    result: &Value,
    managed_skill_root: Option<&Path>,
) -> bool {
    let Some(result) = result.as_object() else {
        return false;
    };
    if !matches!(
        result.get("name").and_then(Value::as_str),
        Some(LEGACY_OBSIDIAN_SKILL_ID | CLOVY_OBSIDIAN_SKILL_ID)
    ) {
        return false;
    }
    let (Some(path), Some(managed_skill_root)) = (
        result.get("path").and_then(Value::as_str),
        managed_skill_root,
    ) else {
        return false;
    };
    canonical_managed_load_skill_path(path, managed_skill_root).is_some()
}

pub(crate) fn migrate_resumable_skill_state(
    serialized_state: &str,
    managed_skill_root: Option<&Path>,
) -> String {
    let Ok(mut outer) = serde_json::from_str::<Value>(serialized_state) else {
        return serialized_state.to_string();
    };
    if let Some(sdk_state) = outer
        .get("sdkState")
        .and_then(Value::as_str)
        .map(str::to_string)
    {
        let migrated = migrate_sdk_state(&sdk_state, managed_skill_root);
        if migrated == sdk_state {
            return serialized_state.to_string();
        }
        outer["sdkState"] = Value::String(migrated);
    } else if !migrate_sdk_state_value(&mut outer, managed_skill_root) {
        return serialized_state.to_string();
    }
    serde_json::to_string(&outer).unwrap_or_else(|_| serialized_state.to_string())
}

fn migrate_sdk_state(sdk_state: &str, managed_skill_root: Option<&Path>) -> String {
    let Ok(mut state) = serde_json::from_str::<Value>(sdk_state) else {
        return sdk_state.to_string();
    };
    if !migrate_sdk_state_value(&mut state, managed_skill_root) {
        return sdk_state.to_string();
    }
    serde_json::to_string(&state).unwrap_or_else(|_| sdk_state.to_string())
}

fn migrate_sdk_state_value(state: &mut Value, managed_skill_root: Option<&Path>) -> bool {
    let mut load_skill_results = HashMap::new();
    collect_load_skill_result_provenance(state, managed_skill_root, &mut load_skill_results);
    let managed_load_skill_call_ids = load_skill_results
        .into_iter()
        .filter_map(|(call_id, (all_results, managed_results, malformed))| {
            (!malformed && all_results.len() == 1 && managed_results == all_results)
                .then_some(call_id)
        })
        .collect();
    migrate_sdk_value(state, &managed_load_skill_call_ids, managed_skill_root)
}

fn collect_load_skill_result_provenance(
    value: &Value,
    managed_skill_root: Option<&Path>,
    results: &mut HashMap<String, (HashSet<String>, HashSet<String>, bool)>,
) {
    match value {
        Value::Array(values) => {
            for value in values {
                collect_load_skill_result_provenance(value, managed_skill_root, results);
            }
        }
        Value::Object(object) => {
            if object.get("type").and_then(Value::as_str) == Some("function_call_result")
                && object.get("name").and_then(Value::as_str) == Some("load_skill")
            {
                if let (Some(call_id), Some(output)) = (
                    object.get("callId").and_then(Value::as_str),
                    object.get("output"),
                ) {
                    let entry = results.entry(call_id.to_string()).or_default();
                    if let Some(result) = load_skill_result_value(output) {
                        if let Ok(fingerprint) = serde_json::to_string(&result) {
                            entry.0.insert(fingerprint.clone());
                            if is_managed_obsidian_skill_result(&result, managed_skill_root) {
                                entry.1.insert(fingerprint);
                            }
                        } else {
                            entry.2 = true;
                        }
                    } else {
                        entry.2 = true;
                    }
                } else if let Some(call_id) = object.get("callId").and_then(Value::as_str) {
                    results.entry(call_id.to_string()).or_default().2 = true;
                }
            }
            for value in object.values() {
                collect_load_skill_result_provenance(value, managed_skill_root, results);
            }
        }
        _ => {}
    }
}

fn migrate_sdk_value(
    value: &mut Value,
    load_skill_call_ids: &HashSet<String>,
    managed_skill_root: Option<&Path>,
) -> bool {
    let mut changed = false;
    match value {
        Value::Array(values) => {
            for value in values {
                changed |= migrate_sdk_value(value, load_skill_call_ids, managed_skill_root);
            }
        }
        Value::Object(object) => {
            let item_type = object
                .get("type")
                .and_then(Value::as_str)
                .map(str::to_string);
            let name = object
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_string);
            let call_id = object
                .get("callId")
                .and_then(Value::as_str)
                .map(str::to_string);
            let managed_call_id = call_id
                .as_deref()
                .is_some_and(|call_id| load_skill_call_ids.contains(call_id));
            let load_skill_call = item_type.as_deref() == Some("function_call")
                && name.as_deref() == Some("load_skill")
                && managed_call_id;
            let load_skill_result =
                item_type.as_deref() == Some("function_call_result") && managed_call_id;

            if load_skill_call {
                if let Some(arguments) = object.get_mut("arguments") {
                    changed |= migrate_json_arguments(arguments);
                }
            }
            if load_skill_result {
                if let Some(output) = object.get_mut("output") {
                    changed |= migrate_load_skill_output(output, managed_skill_root);
                }
            }
            if item_type.as_deref() == Some("tool_call_output_item") {
                let wrapped_result = object.get("rawItem").and_then(Value::as_object);
                let wrapped_name = wrapped_result
                    .and_then(|raw| raw.get("name"))
                    .and_then(Value::as_str);
                let wrapped_call_id = wrapped_result
                    .and_then(|raw| raw.get("callId"))
                    .and_then(Value::as_str);
                if wrapped_name == Some("load_skill")
                    && wrapped_call_id.is_some_and(|call_id| load_skill_call_ids.contains(call_id))
                {
                    if let Some(output) = object.get_mut("output") {
                        changed |= migrate_load_skill_output(output, managed_skill_root);
                    }
                }
            }
            for value in object.values_mut() {
                changed |= migrate_sdk_value(value, load_skill_call_ids, managed_skill_root);
            }
        }
        _ => {}
    }
    changed
}

fn migrate_json_arguments(arguments: &mut Value) -> bool {
    if let Some(value) = arguments.as_str() {
        let Ok(mut parsed) = serde_json::from_str::<Value>(value) else {
            return false;
        };
        if !canonicalize_load_skill_arguments(&mut parsed) {
            return false;
        }
        if let Ok(serialized) = serde_json::to_string(&parsed) {
            *arguments = Value::String(serialized);
            return true;
        }
        return false;
    }
    canonicalize_load_skill_arguments(arguments)
}

fn migrate_load_skill_output(output: &mut Value, managed_skill_root: Option<&Path>) -> bool {
    if let Some(value) = output.as_str() {
        let Ok(mut parsed) = serde_json::from_str::<Value>(value) else {
            return false;
        };
        if !migrate_load_skill_result(&mut parsed, managed_skill_root) {
            return false;
        }
        if let Ok(serialized) = serde_json::to_string(&parsed) {
            *output = Value::String(serialized);
            return true;
        }
        return false;
    }
    if output.get("type").and_then(Value::as_str) == Some("text") {
        return output
            .get_mut("text")
            .is_some_and(|text| migrate_load_skill_output(text, managed_skill_root));
    }
    migrate_load_skill_result(output, managed_skill_root)
}

fn load_skill_result_value(output: &Value) -> Option<Value> {
    if let Some(value) = output.as_str() {
        return serde_json::from_str(value).ok();
    }
    if output.get("type").and_then(Value::as_str) == Some("text") {
        return output.get("text").and_then(load_skill_result_value);
    }
    output.is_object().then(|| output.clone())
}

fn canonical_managed_load_skill_path(path: &str, managed_skill_root: &Path) -> Option<String> {
    let root = managed_skill_root.to_string_lossy();
    let root = root.trim_end_matches(['/', '\\']);
    for (separator, legacy_suffix) in [
        ('/', "/june-obsidian/SKILL.md"),
        ('\\', "\\june-obsidian\\SKILL.md"),
    ] {
        let legacy_path = format!("{root}{legacy_suffix}");
        if path == legacy_path {
            return Some(format!(
                "{root}{separator}{CLOVY_OBSIDIAN_SKILL_ID}{separator}SKILL.md"
            ));
        }
        let canonical_path =
            format!("{root}{separator}{CLOVY_OBSIDIAN_SKILL_ID}{separator}SKILL.md");
        if path == canonical_path {
            return Some(canonical_path);
        }
    }
    None
}

pub fn canonical_skill_ids<'a>(skill_ids: impl IntoIterator<Item = &'a str>) -> BTreeSet<String> {
    skill_ids
        .into_iter()
        .map(canonical_skill_id)
        .map(str::to_string)
        .collect()
}

pub fn compatible_skill_ids<'a>(skill_ids: impl IntoIterator<Item = &'a str>) -> BTreeSet<String> {
    let canonical = canonical_skill_ids(skill_ids);
    let mut compatible = canonical.clone();
    if canonical.contains(CLOVY_OBSIDIAN_SKILL_ID) {
        compatible.insert(LEGACY_OBSIDIAN_SKILL_ID.to_string());
    }
    compatible
}

pub fn read_skill_ids(skill_id: &str) -> Vec<&str> {
    let canonical = canonical_skill_id(skill_id);
    if canonical == CLOVY_OBSIDIAN_SKILL_ID {
        vec![CLOVY_OBSIDIAN_SKILL_ID, LEGACY_OBSIDIAN_SKILL_ID]
    } else {
        vec![canonical]
    }
}

pub fn write_skill_ids(skill_id: &str) -> Vec<&str> {
    let canonical = canonical_skill_id(skill_id);
    if canonical == CLOVY_OBSIDIAN_SKILL_ID {
        vec![LEGACY_OBSIDIAN_SKILL_ID, CLOVY_OBSIDIAN_SKILL_ID]
    } else {
        vec![canonical]
    }
}

pub fn skill_file(root: &Path, skill_id: &str) -> PathBuf {
    root.join(skill_id).join("SKILL.md")
}

/// Reconciles the managed Obsidian skill before the bundled resource is seeded.
///
/// The legacy path is rollback-readable, so it wins whenever both copies exist.
/// Clovy writes that path first and the canonical path second; a legacy-only
/// change therefore means either an upgrade from June or an edit made after a
/// rollback. A canonical-only copy is mirrored back so an older app can still
/// load the skill.
pub fn reconcile_managed_obsidian_skill(root: &Path) -> io::Result<()> {
    let canonical = skill_file(root, CLOVY_OBSIDIAN_SKILL_ID);
    let legacy = skill_file(root, LEGACY_OBSIDIAN_SKILL_ID);
    if legacy.is_file() {
        let content = migrate_known_legacy_obsidian_presentation(&fs::read_to_string(&legacy)?);
        write_skill_file(&legacy, &content, LEGACY_OBSIDIAN_SKILL_ID)?;
        write_skill_file(&canonical, &content, CLOVY_OBSIDIAN_SKILL_ID)
    } else if canonical.is_file() {
        let content = migrate_known_legacy_obsidian_presentation(&fs::read_to_string(&canonical)?);
        write_skill_file(&canonical, &content, CLOVY_OBSIDIAN_SKILL_ID)?;
        write_skill_file(&legacy, &content, LEGACY_OBSIDIAN_SKILL_ID)
    } else {
        Ok(())
    }
}

fn migrate_known_legacy_obsidian_presentation(content: &str) -> String {
    let matches_released_content = content == RELEASED_LEGACY_OBSIDIAN_SKILL_V1
        || content
            == skill_content_for_id(RELEASED_LEGACY_OBSIDIAN_SKILL_V1, CLOVY_OBSIDIAN_SKILL_ID);
    if matches_released_content {
        BUNDLED_CLOVY_OBSIDIAN_SKILL.to_string()
    } else {
        content.to_string()
    }
}

pub fn skill_content_for_id(content: &str, skill_id: &str) -> String {
    let mut lines = content.split_inclusive('\n').peekable();
    let Some(first) = lines.next() else {
        return format!("---\nname: {skill_id}\n---\n");
    };
    if first.trim_end_matches(['\r', '\n']) != "---" {
        return format!("---\nname: {skill_id}\n---\n\n{content}");
    }

    let newline = if first.ends_with("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let mut output = first.to_string();
    let mut found_name = false;
    let mut closed_frontmatter = false;
    for line in lines {
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if !closed_frontmatter && trimmed.trim() == "---" {
            if !found_name {
                output.push_str(&format!("name: {skill_id}{newline}"));
            }
            output.push_str(line);
            closed_frontmatter = true;
            continue;
        }
        if !closed_frontmatter
            && trimmed
                .split_once(':')
                .is_some_and(|(key, _)| key.trim() == "name")
        {
            let indentation = &trimmed[..trimmed.len() - trimmed.trim_start().len()];
            output.push_str(indentation);
            output.push_str("name: ");
            output.push_str(skill_id);
            if line.ends_with("\r\n") {
                output.push_str("\r\n");
            } else if line.ends_with('\n') {
                output.push('\n');
            }
            found_name = true;
        } else {
            output.push_str(line);
        }
    }
    output
}

fn write_skill_file(destination: &Path, content: &str, skill_id: &str) -> io::Result<()> {
    let content = skill_content_for_id(content, skill_id);
    if fs::read_to_string(destination).ok().as_deref() == Some(content.as_str()) {
        return Ok(());
    }
    let parent = destination.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "skill path has no parent directory",
        )
    })?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(".SKILL.md.clovy-identity.tmp");
    fs::write(&temporary, content)?;
    if let Err(error) = fs::rename(&temporary, destination) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn released_skill_result(path: &str) -> Value {
        serde_json::json!({
            "name": LEGACY_OBSIDIAN_SKILL_ID,
            "content": RELEASED_LEGACY_OBSIDIAN_SKILL_V1,
            "path": path
        })
    }

    #[test]
    fn resumable_load_skill_state_migrates_only_correlated_app_owned_payloads() {
        let released_output = serde_json::to_string(&released_skill_result(
            "/Library/June/agents/skills/june-obsidian/SKILL.md",
        ))
        .expect("released output");
        let edited_content = "User-edited instructions about June Carter.";
        let edited_output = serde_json::to_string(&serde_json::json!({
            "name": LEGACY_OBSIDIAN_SKILL_ID,
            "content": edited_content,
            "path": "/Library/June/agents/skills/june-obsidian/SKILL.md"
        }))
        .expect("edited output");
        let custom_output = serde_json::to_string(&serde_json::json!({
            "name": LEGACY_OBSIDIAN_SKILL_ID,
            "content": RELEASED_LEGACY_OBSIDIAN_SKILL_V1,
            "path": "/Library/June/agents/skills/june-obsidian/SKILL.md"
        }))
        .expect("custom output");
        let copied_output = serde_json::to_string(&serde_json::json!({
            "name": "copied-reference",
            "content": RELEASED_LEGACY_OBSIDIAN_SKILL_V1,
            "path": "/Users/me/.agents/skills/copied-reference/SKILL.md"
        }))
        .expect("copied output");
        let user_global_output = serde_json::to_string(&serde_json::json!({
            "name": LEGACY_OBSIDIAN_SKILL_ID,
            "content": edited_content,
            "path": "/Users/me/.agents/skills/june-obsidian/SKILL.md"
        }))
        .expect("user-global output");
        let sdk_state = serde_json::json!({
            "modelResponses": [{
                "output": [{
                    "type": "function_call",
                    "callId": "call-released",
                    "name": "load_skill",
                    "arguments": "{\"name\":\"june-obsidian\"}"
                }]
            }],
            "generatedItems": [
                {
                    "type": "tool_call_item",
                    "rawItem": {
                        "type": "function_call",
                        "callId": "call-released",
                        "name": "load_skill",
                        "arguments": "{\"name\":\"june-obsidian\"}"
                    }
                },
                {
                    "type": "tool_call_output_item",
                    "rawItem": {
                        "type": "function_call_result",
                        "name": "load_skill",
                        "callId": "call-released",
                        "output": { "type": "text", "text": released_output }
                    },
                    "output": released_output
                },
                {
                    "type": "tool_call_item",
                    "rawItem": {
                        "type": "function_call",
                        "callId": "call-edited",
                        "name": "load_skill",
                        "arguments": "{\"name\":\"june-obsidian\"}"
                    }
                },
                {
                    "type": "tool_call_output_item",
                    "rawItem": {
                        "type": "function_call_result",
                        "name": "load_skill",
                        "callId": "call-edited",
                        "output": { "type": "text", "text": edited_output }
                    },
                    "output": edited_output
                },
                {
                    "type": "tool_call_output_item",
                    "rawItem": {
                        "type": "function_call_result",
                        "name": "mcp_custom",
                        "callId": "call-custom",
                        "output": { "type": "text", "text": custom_output }
                    },
                    "output": custom_output
                },
                {
                    "type": "tool_call_item",
                    "rawItem": {
                        "type": "function_call",
                        "callId": "call-copied",
                        "name": "load_skill",
                        "arguments": "{\"name\":\"copied-reference\"}"
                    }
                },
                {
                    "type": "tool_call_output_item",
                    "rawItem": {
                        "type": "function_call_result",
                        "name": "load_skill",
                        "callId": "call-copied",
                        "output": { "type": "text", "text": copied_output }
                    },
                    "output": copied_output
                },
                {
                    "type": "tool_call_item",
                    "rawItem": {
                        "type": "function_call",
                        "callId": "call-user-global",
                        "name": "load_skill",
                        "arguments": "{\"name\":\"june-obsidian\"}"
                    }
                },
                {
                    "type": "tool_call_output_item",
                    "rawItem": {
                        "type": "function_call_result",
                        "name": "load_skill",
                        "callId": "call-user-global",
                        "output": { "type": "text", "text": user_global_output }
                    },
                    "output": user_global_output
                }
            ]
        });
        let envelope = serde_json::json!({
            "juneVersion": 1,
            "sdkState": serde_json::to_string(&sdk_state).expect("SDK state")
        });

        let managed_root = Path::new("/Library/June/agents/skills");
        let migrated = migrate_resumable_skill_state(
            &serde_json::to_string(&envelope).expect("serialized envelope"),
            Some(managed_root),
        );
        let migrated_envelope: Value = serde_json::from_str(&migrated).expect("migrated envelope");
        let migrated_state: Value = serde_json::from_str(
            migrated_envelope["sdkState"]
                .as_str()
                .expect("migrated SDK state"),
        )
        .expect("migrated SDK JSON");

        assert_eq!(
            migrated_state["modelResponses"][0]["output"][0]["arguments"],
            r#"{"name":"clovy-obsidian"}"#
        );
        assert_eq!(
            migrated_state["generatedItems"][0]["rawItem"]["arguments"],
            r#"{"name":"clovy-obsidian"}"#
        );
        for path in [
            &migrated_state["generatedItems"][1]["rawItem"]["output"]["text"],
            &migrated_state["generatedItems"][1]["output"],
        ] {
            let payload: Value = serde_json::from_str(path.as_str().expect("released payload"))
                .expect("released payload JSON");
            assert_eq!(payload["name"], CLOVY_OBSIDIAN_SKILL_ID);
            assert_eq!(payload["content"], BUNDLED_CLOVY_OBSIDIAN_SKILL);
            assert_eq!(
                payload["path"],
                "/Library/June/agents/skills/clovy-obsidian/SKILL.md"
            );
        }
        for path in [
            &migrated_state["generatedItems"][3]["rawItem"]["output"]["text"],
            &migrated_state["generatedItems"][3]["output"],
        ] {
            let payload: Value = serde_json::from_str(path.as_str().expect("edited payload"))
                .expect("edited payload JSON");
            assert_eq!(payload["name"], CLOVY_OBSIDIAN_SKILL_ID);
            assert_eq!(payload["content"], edited_content);
            assert_eq!(
                payload["path"],
                "/Library/June/agents/skills/clovy-obsidian/SKILL.md"
            );
        }
        assert_eq!(migrated_state["generatedItems"][4]["output"], custom_output);
        assert_eq!(migrated_state["generatedItems"][6]["output"], copied_output);
        assert_eq!(
            migrated_state["generatedItems"][6]["rawItem"]["output"]["text"],
            copied_output
        );
        assert_eq!(
            migrated_state["generatedItems"][7]["rawItem"]["arguments"],
            r#"{"name":"june-obsidian"}"#
        );
        assert_eq!(
            migrated_state["generatedItems"][8]["output"],
            user_global_output
        );
        assert_eq!(
            migrated_state["generatedItems"][8]["rawItem"]["output"]["text"],
            user_global_output
        );
    }

    #[test]
    fn ambiguous_sdk_call_ids_preserve_managed_and_user_global_skill_records() {
        let managed_output = serde_json::to_string(&released_skill_result(
            "/Library/June/agents/skills/june-obsidian/SKILL.md",
        ))
        .expect("managed output");
        let user_global_output = serde_json::to_string(&serde_json::json!({
            "name": LEGACY_OBSIDIAN_SKILL_ID,
            "content": "Keep June Carter research",
            "path": "/Users/me/.agents/skills/june-obsidian/SKILL.md"
        }))
        .expect("user-global output");
        let state = serde_json::json!({
            "generatedItems": [
                {
                    "type": "tool_call_item",
                    "rawItem": {
                        "type": "function_call",
                        "callId": "duplicate-id",
                        "name": "load_skill",
                        "arguments": "{\"name\":\"june-obsidian\"}"
                    }
                },
                {
                    "type": "tool_call_output_item",
                    "rawItem": {
                        "type": "function_call_result",
                        "name": "load_skill",
                        "callId": "duplicate-id",
                        "output": { "type": "text", "text": user_global_output }
                    },
                    "output": user_global_output
                },
                {
                    "type": "tool_call_item",
                    "rawItem": {
                        "type": "function_call",
                        "callId": "duplicate-id",
                        "name": "load_skill",
                        "arguments": "{\"name\":\"june-obsidian\"}"
                    }
                },
                {
                    "type": "tool_call_output_item",
                    "rawItem": {
                        "type": "function_call_result",
                        "name": "load_skill",
                        "callId": "duplicate-id",
                        "output": { "type": "text", "text": managed_output }
                    },
                    "output": managed_output
                }
            ]
        });
        let raw = serde_json::to_string(&state).expect("raw state");
        let envelope = serde_json::to_string(&serde_json::json!({
            "juneVersion": 1,
            "sdkState": raw
        }))
        .expect("state envelope");
        let managed_root = Path::new("/Library/June/agents/skills");

        assert_eq!(migrate_resumable_skill_state(&raw, Some(managed_root)), raw);
        assert_eq!(
            migrate_resumable_skill_state(&envelope, Some(managed_root)),
            envelope
        );
    }

    #[test]
    fn malformed_same_id_sdk_results_preserve_the_entire_ambiguous_group() {
        let managed_output = serde_json::to_string(&released_skill_result(
            "/Library/June/agents/skills/june-obsidian/SKILL.md",
        ))
        .expect("managed output");
        let state = serde_json::json!({
            "generatedItems": [
                {
                    "type": "function_call",
                    "callId": "duplicate-id",
                    "name": "load_skill",
                    "arguments": "{\"name\":\"june-obsidian\"}"
                },
                {
                    "type": "function_call_result",
                    "name": "load_skill",
                    "callId": "duplicate-id",
                    "output": managed_output
                },
                {
                    "type": "function_call_result",
                    "name": "load_skill",
                    "callId": "duplicate-id",
                    "output": "not-json"
                }
            ]
        });
        let raw = serde_json::to_string(&state).expect("raw state");
        let envelope = serde_json::to_string(&serde_json::json!({
            "juneVersion": 1,
            "sdkState": raw
        }))
        .expect("state envelope");
        let managed_root = Path::new("/Library/June/agents/skills");

        assert_eq!(migrate_resumable_skill_state(&raw, Some(managed_root)), raw);
        assert_eq!(
            migrate_resumable_skill_state(&envelope, Some(managed_root)),
            envelope
        );
    }

    #[test]
    fn released_obsidian_presentation_is_migrated_without_touching_custom_june_text() {
        let root = tempfile::tempdir().expect("managed skill root");
        let legacy = skill_file(root.path(), LEGACY_OBSIDIAN_SKILL_ID);
        fs::create_dir_all(legacy.parent().expect("legacy parent")).expect("legacy directory");
        fs::write(&legacy, RELEASED_LEGACY_OBSIDIAN_SKILL_V1).expect("legacy skill");

        reconcile_managed_obsidian_skill(root.path()).expect("migrate legacy presentation");

        let canonical = fs::read_to_string(skill_file(root.path(), CLOVY_OBSIDIAN_SKILL_ID))
            .expect("canonical skill");
        let legacy = fs::read_to_string(legacy).expect("legacy skill remains");
        for content in [canonical, legacy] {
            assert!(content.contains(CLOVY_OBSIDIAN_SKILL_DESCRIPTION));
            assert!(content.contains("# Clovy Obsidian vault"));
            assert!(content.contains("connected in\n  Clovy. Do not guess"));
            assert!(!content.contains(LEGACY_OBSIDIAN_SKILL_DESCRIPTION));
            assert!(!content.contains("# June Obsidian vault"));
        }
    }

    #[test]
    fn user_edited_legacy_presentation_phrases_are_preserved() {
        let root = tempfile::tempdir().expect("managed skill root");
        let legacy = skill_file(root.path(), LEGACY_OBSIDIAN_SKILL_ID);
        fs::create_dir_all(legacy.parent().expect("legacy parent")).expect("legacy directory");
        let edited = format!(
            "---\nname: june-obsidian\ndescription: {LEGACY_OBSIDIAN_SKILL_DESCRIPTION}\n---\n\n# June Obsidian vault\n\nUser-edited instructions about June Carter.\n"
        );
        fs::write(&legacy, &edited).expect("edited legacy skill");

        reconcile_managed_obsidian_skill(root.path()).expect("preserve user edit");

        assert_eq!(
            fs::read_to_string(&legacy).expect("legacy skill remains"),
            edited
        );
        let canonical = fs::read_to_string(skill_file(root.path(), CLOVY_OBSIDIAN_SKILL_ID))
            .expect("canonical skill");
        assert_eq!(
            canonical,
            edited.replace("name: june-obsidian", "name: clovy-obsidian")
        );
    }

    #[test]
    fn legacy_managed_edits_are_promoted_and_remain_rollback_readable() {
        let root = tempfile::tempdir().expect("managed skill root");
        let legacy = skill_file(root.path(), LEGACY_OBSIDIAN_SKILL_ID);
        fs::create_dir_all(legacy.parent().expect("legacy parent")).expect("legacy directory");
        fs::write(
            &legacy,
            "---\nname: june-obsidian\ndescription: User description\ncustom: keep-me\n---\n\nUser-edited body\n",
        )
        .expect("legacy skill");

        reconcile_managed_obsidian_skill(root.path()).expect("promote legacy skill");

        let canonical = fs::read_to_string(skill_file(root.path(), CLOVY_OBSIDIAN_SKILL_ID))
            .expect("canonical skill");
        let legacy = fs::read_to_string(legacy).expect("legacy skill remains");
        assert!(canonical.contains("name: clovy-obsidian"));
        assert!(legacy.contains("name: june-obsidian"));
        for content in [canonical, legacy] {
            assert!(content.contains("description: User description"));
            assert!(content.contains("custom: keep-me"));
            assert!(content.ends_with("User-edited body\n"));
        }
    }

    #[test]
    fn legacy_copy_wins_after_a_rollback_edit() {
        let root = tempfile::tempdir().expect("managed skill root");
        let canonical = skill_file(root.path(), CLOVY_OBSIDIAN_SKILL_ID);
        let legacy = skill_file(root.path(), LEGACY_OBSIDIAN_SKILL_ID);
        fs::create_dir_all(canonical.parent().expect("canonical parent"))
            .expect("canonical directory");
        fs::create_dir_all(legacy.parent().expect("legacy parent")).expect("legacy directory");
        fs::write(
            &canonical,
            "---\nname: clovy-obsidian\n---\n\nstale canonical instructions",
        )
        .expect("canonical skill");
        fs::write(
            &legacy,
            "---\nname: june-obsidian\n---\n\nedited after rollback",
        )
        .expect("legacy skill");

        reconcile_managed_obsidian_skill(root.path()).expect("reconcile rollback edit");

        assert_eq!(
            fs::read_to_string(canonical).expect("canonical skill"),
            "---\nname: clovy-obsidian\n---\n\nedited after rollback"
        );
        assert_eq!(
            fs::read_to_string(legacy).expect("legacy skill"),
            "---\nname: june-obsidian\n---\n\nedited after rollback"
        );
    }

    #[test]
    fn canonical_only_skill_is_mirrored_for_rollback() {
        let root = tempfile::tempdir().expect("managed skill root");
        let canonical = skill_file(root.path(), CLOVY_OBSIDIAN_SKILL_ID);
        fs::create_dir_all(canonical.parent().expect("canonical parent"))
            .expect("canonical directory");
        fs::write(
            &canonical,
            "---\nname: clovy-obsidian\n---\n\ncanonical instructions",
        )
        .expect("canonical skill");

        reconcile_managed_obsidian_skill(root.path()).expect("mirror canonical skill");

        assert_eq!(
            fs::read_to_string(skill_file(root.path(), LEGACY_OBSIDIAN_SKILL_ID))
                .expect("legacy alias"),
            "---\nname: june-obsidian\n---\n\ncanonical instructions"
        );
    }

    #[test]
    fn persisted_ids_are_canonical_in_memory_and_additive_on_disk() {
        let legacy = [LEGACY_OBSIDIAN_SKILL_ID, "research"];
        assert_eq!(
            canonical_skill_ids(legacy),
            BTreeSet::from([CLOVY_OBSIDIAN_SKILL_ID.to_string(), "research".to_string()])
        );
        assert_eq!(
            compatible_skill_ids(legacy),
            BTreeSet::from([
                CLOVY_OBSIDIAN_SKILL_ID.to_string(),
                LEGACY_OBSIDIAN_SKILL_ID.to_string(),
                "research".to_string()
            ])
        );
    }
}
