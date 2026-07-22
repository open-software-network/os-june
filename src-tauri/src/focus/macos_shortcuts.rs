use crate::domain::types::AppError;
use std::process::{Command, Stdio};
#[cfg(target_os = "macos")]
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const SHORTCUTS_PATH: &str = "/usr/bin/shortcuts";
pub const FOCUS_SHORTCUT_ERROR_EVENT: &str = "june:focus:shortcut-error";

pub async fn list() -> Result<Vec<String>, AppError> {
    #[cfg(not(target_os = "macos"))]
    {
        Ok(Vec::new())
    }

    #[cfg(target_os = "macos")]
    {
        let output_task = tokio::task::spawn_blocking(|| {
            Command::new(SHORTCUTS_PATH)
                .arg("list")
                .stdin(Stdio::null())
                .output()
        });
        let output = tokio::time::timeout(Duration::from_secs(10), output_task)
            .await
            .map_err(|_| shortcuts_unavailable())?
            .map_err(|_| shortcuts_unavailable())?
            .map_err(|_| shortcuts_unavailable())?;

        if !output.status.success() {
            return Err(shortcuts_unavailable());
        }
        let stdout = String::from_utf8(output.stdout).map_err(|_| shortcuts_unavailable())?;
        Ok(parse_shortcut_list(&stdout))
    }
}

pub fn launch_start_shortcut(app: &AppHandle, name: Option<&str>) {
    #[cfg(not(target_os = "macos"))]
    let _ = (app, name);

    #[cfg(target_os = "macos")]
    if let Some(name) = name {
        let name = name.to_owned();
        let mut command = shortcut_run_command(&name);
        match command.spawn() {
            Ok(mut child) => {
                let app = app.clone();
                tauri::async_runtime::spawn_blocking(move || match child.wait() {
                    Ok(status) if status.success() => {}
                    Ok(_) | Err(_) => emit_launch_error(&app, &name),
                });
            }
            Err(_) => emit_launch_error(app, &name),
        }
    }
}

fn parse_shortcut_list(stdout: &str) -> Vec<String> {
    let mut names = stdout
        .lines()
        .map(|line| line.trim_end_matches('\r'))
        .filter(|line| !line.is_empty())
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    names.sort_by_key(|name| name.to_lowercase());
    names.dedup();
    names
}

fn shortcut_run_command(name: &str) -> Command {
    let mut command = Command::new(SHORTCUTS_PATH);
    command
        .arg("run")
        .arg("--")
        .arg(name)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
}

fn shortcuts_unavailable() -> AppError {
    AppError::new(
        "focus_shortcuts_unavailable",
        "June could not load macOS Shortcuts. Open the Shortcuts app once, then try again.",
    )
}

fn emit_launch_error(app: &AppHandle, name: &str) {
    let mut error = AppError::new(
        "focus_start_shortcut_failed",
        "Focus started, but the selected macOS Shortcut did not run successfully. Open Shortcuts and run it once to check its permissions.",
    );
    error.details = Some(serde_json::json!({ "shortcutName": name }));
    let _ = app.emit(FOCUS_SHORTCUT_ERROR_EVENT, error);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_sorts_and_deduplicates_shortcut_names() {
        assert_eq!(
            parse_shortcut_list("Writing Focus\r\nAdmin\n\nWriting Focus\n"),
            vec!["Admin", "Writing Focus"]
        );
    }

    #[test]
    fn shortcut_name_is_one_argument_after_option_terminator() {
        let command = shortcut_run_command("Focus; touch /tmp/not-a-command");
        let args = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();

        assert_eq!(command.get_program(), SHORTCUTS_PATH);
        assert_eq!(args, vec!["run", "--", "Focus; touch /tmp/not-a-command"]);
    }
}
