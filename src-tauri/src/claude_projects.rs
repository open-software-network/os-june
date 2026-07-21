use crate::domain::types::ClaudeProjectCandidateDto;
use chrono::{DateTime, Utc};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

const MAX_JSONL_LINES: usize = 200;
const MAX_CONFIG_BYTES: u64 = 10 * 1024 * 1024;
const MAX_HISTORY_BYTES: u64 = 512 * 1024;

pub fn discover(home: &Path, already_added: &HashSet<PathBuf>) -> Vec<ClaudeProjectCandidateDto> {
    let mut discovered: BTreeMap<PathBuf, Option<SystemTime>> = BTreeMap::new();
    discover_from_config(home, &mut discovered);
    discover_from_session_history(home, &mut discovered);

    let mut canonical_discovered: BTreeMap<PathBuf, Option<SystemTime>> = BTreeMap::new();
    for (path, last_used) in discovered {
        if let Some(path) = eligible_project_path(home, &path) {
            remember(&mut canonical_discovered, path, last_used);
        }
    }

    let mut candidates = canonical_discovered
        .into_iter()
        .filter_map(|(path, last_used)| {
            let name = path.file_name()?.to_string_lossy().trim().to_string();
            if name.is_empty() {
                return None;
            }
            Some(ClaudeProjectCandidateDto {
                name,
                path: path.to_string_lossy().into_owned(),
                last_used_at: last_used.map(|value| DateTime::<Utc>::from(value).to_rfc3339()),
                already_added: already_added.contains(&path),
            })
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        right
            .last_used_at
            .cmp(&left.last_used_at)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
            .then_with(|| left.path.cmp(&right.path))
    });
    candidates
}

pub fn validate_import_path(home: &Path, path: &str) -> Option<PathBuf> {
    eligible_project_path(home, Path::new(path))
}

fn discover_from_config(home: &Path, discovered: &mut BTreeMap<PathBuf, Option<SystemTime>>) {
    let config_path = home.join(".claude.json");
    let Ok(metadata) = fs::metadata(&config_path) else {
        return;
    };
    if metadata.len() > MAX_CONFIG_BYTES {
        return;
    }
    let Ok(bytes) = fs::read(&config_path) else {
        return;
    };
    let Ok(config) = serde_json::from_slice::<Value>(&bytes) else {
        return;
    };
    let Some(projects) = config.get("projects").and_then(Value::as_object) else {
        return;
    };
    for path in projects.keys() {
        remember(discovered, PathBuf::from(path), None);
    }
}

fn discover_from_session_history(
    home: &Path,
    discovered: &mut BTreeMap<PathBuf, Option<SystemTime>>,
) {
    let projects_dir = home.join(".claude").join("projects");
    let Ok(project_dirs) = fs::read_dir(projects_dir) else {
        return;
    };
    for project_dir in project_dirs.flatten() {
        let Ok(file_type) = project_dir.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let Ok(entries) = fs::read_dir(project_dir.path()) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
                continue;
            }
            let modified = entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .ok();
            let Ok(file) = File::open(path) else {
                continue;
            };
            for line in BufReader::new(file)
                .take(MAX_HISTORY_BYTES)
                .lines()
                .take(MAX_JSONL_LINES)
                .flatten()
            {
                let Ok(value) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                let Some(cwd) = value.get("cwd").and_then(Value::as_str) else {
                    continue;
                };
                remember(discovered, PathBuf::from(cwd), modified);
                break;
            }
        }
    }
}

fn remember(
    discovered: &mut BTreeMap<PathBuf, Option<SystemTime>>,
    path: PathBuf,
    last_used: Option<SystemTime>,
) {
    discovered
        .entry(path)
        .and_modify(|current| {
            if last_used > *current {
                *current = last_used;
            }
        })
        .or_insert(last_used);
}

fn eligible_project_path(home: &Path, path: &Path) -> Option<PathBuf> {
    if !path.is_absolute() {
        return None;
    }
    let canonical_home = home.canonicalize().ok()?;
    let canonical = path.canonicalize().ok()?;
    if !canonical.is_dir() || canonical == canonical_home || canonical.parent().is_none() {
        return None;
    }
    if canonical.starts_with(canonical_home.join(".claude")) {
        return None;
    }
    Some(canonical)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn discovers_config_and_history_paths_and_deduplicates_them() {
        let temp = tempfile::tempdir().expect("tempdir");
        let home = temp.path();
        let alpha = home.join("code").join("alpha");
        let beta = home.join("code").join("beta");
        fs::create_dir_all(&alpha).expect("alpha");
        fs::create_dir_all(&beta).expect("beta");
        fs::write(
            home.join(".claude.json"),
            serde_json::json!({ "projects": { alpha.to_string_lossy(): {} } }).to_string(),
        )
        .expect("config");

        let history_dir = home.join(".claude").join("projects").join("encoded-beta");
        fs::create_dir_all(&history_dir).expect("history dir");
        let mut history = File::create(history_dir.join("session.jsonl")).expect("history");
        writeln!(
            history,
            "{{\"type\":\"user\",\"cwd\":{:?}}}",
            beta.to_string_lossy()
        )
        .expect("history line");
        writeln!(history, "{{\"cwd\":{:?}}}", alpha.to_string_lossy()).expect("duplicate line");

        let candidates = discover(home, &HashSet::new());
        let paths = candidates
            .iter()
            .map(|candidate| candidate.path.as_str())
            .collect::<HashSet<_>>();
        let alpha = alpha.canonicalize().expect("canonical alpha");
        let beta = beta.canonicalize().expect("canonical beta");
        assert_eq!(paths.len(), 2);
        assert!(paths.contains(alpha.to_string_lossy().as_ref()));
        assert!(paths.contains(beta.to_string_lossy().as_ref()));
        assert!(candidates
            .iter()
            .find(|candidate| candidate.path == alpha.to_string_lossy())
            .expect("alpha candidate")
            .last_used_at
            .is_none());
        assert!(candidates
            .iter()
            .find(|candidate| candidate.path == beta.to_string_lossy())
            .expect("beta candidate")
            .last_used_at
            .is_some());
    }

    #[test]
    fn excludes_missing_home_root_and_claude_state_paths() {
        let temp = tempfile::tempdir().expect("tempdir");
        let home = temp.path();
        let claude_state = home.join(".claude").join("plugins");
        fs::create_dir_all(&claude_state).expect("claude state");
        fs::write(
            home.join(".claude.json"),
            serde_json::json!({
                "projects": {
                    home.to_string_lossy(): {},
                    claude_state.to_string_lossy(): {},
                    home.join("missing").to_string_lossy(): {}
                }
            })
            .to_string(),
        )
        .expect("config");

        assert!(discover(home, &HashSet::new()).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn deduplicates_project_aliases_after_canonicalizing() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().expect("tempdir");
        let home = temp.path();
        let project = home.join("code").join("project");
        let alias = home.join("project-alias");
        fs::create_dir_all(&project).expect("project");
        symlink(&project, &alias).expect("project alias");
        fs::write(
            home.join(".claude.json"),
            serde_json::json!({
                "projects": {
                    project.to_string_lossy(): {},
                    alias.to_string_lossy(): {}
                }
            })
            .to_string(),
        )
        .expect("config");

        let candidates = discover(home, &HashSet::new());

        assert_eq!(candidates.len(), 1);
        assert_eq!(
            candidates[0].path,
            project
                .canonicalize()
                .expect("canonical project")
                .to_string_lossy()
        );
    }
}
