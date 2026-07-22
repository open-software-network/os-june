use std::{
    ffi::OsString,
    fmt,
    os::windows::ffi::OsStringExt,
    thread,
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::HWND,
    UI::{
        Input::KeyboardAndMouse::{
            GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT,
            KEYEVENTF_KEYUP, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT, VK_V,
        },
        WindowsAndMessaging::{
            GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
            IsWindow, SetForegroundWindow,
        },
    },
};

const ACTIVATION_TIMEOUT: Duration = Duration::from_secs(1);
const ACTIVATION_POLL_INTERVAL: Duration = Duration::from_millis(20);
const ACTIVATION_SETTLE_DELAY: Duration = Duration::from_millis(180);
const CTRL_V_EVENT_COUNT: u32 = 4;

#[derive(Clone, Copy, Debug)]
pub struct PinnedTarget {
    hwnd: HWND,
    pid: u32,
}

#[derive(Debug, PartialEq, Eq)]
pub enum FocusError {
    TargetUnavailable(&'static str),
    Restricted(String),
    IncompleteSubmission { events_submitted: u32 },
}

impl FocusError {
    pub fn is_target_unavailable(&self) -> bool {
        matches!(self, Self::TargetUnavailable(_))
    }

    pub fn is_incomplete_submission(&self) -> bool {
        matches!(self, Self::IncompleteSubmission { .. })
    }
}

impl fmt::Display for FocusError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TargetUnavailable(message) => formatter.write_str(message),
            Self::Restricted(message) => formatter.write_str(message),
            Self::IncompleteSubmission { events_submitted } => write!(
                formatter,
                "SendInput accepted {events_submitted} of {CTRL_V_EVENT_COUNT} events."
            ),
        }
    }
}

impl std::error::Error for FocusError {}

#[derive(Debug, PartialEq, Eq)]
enum TargetObservation {
    Missing,
    WrongProcess,
    NotForeground,
    Foreground,
}

#[derive(Default)]
struct ReadinessTracker {
    foreground_since: Option<Duration>,
}

impl ReadinessTracker {
    fn observe(
        &mut self,
        observation: TargetObservation,
        elapsed: Duration,
    ) -> Result<bool, FocusError> {
        match observation {
            TargetObservation::Missing => Err(FocusError::TargetUnavailable(
                "The pinned paste target no longer exists.",
            )),
            TargetObservation::WrongProcess => Err(FocusError::TargetUnavailable(
                "The pinned paste target window handle was reused by another process.",
            )),
            TargetObservation::NotForeground if self.foreground_since.is_some() => {
                Err(FocusError::Restricted(
                    "The paste target lost focus while activation settled.".into(),
                ))
            }
            TargetObservation::NotForeground if elapsed >= ACTIVATION_TIMEOUT => {
                Err(FocusError::Restricted(
                    "The paste target did not become foreground in time.".into(),
                ))
            }
            TargetObservation::NotForeground => Ok(false),
            TargetObservation::Foreground
                if self.foreground_since.is_none() && elapsed >= ACTIVATION_TIMEOUT =>
            {
                Err(FocusError::Restricted(
                    "The paste target did not become foreground in time.".into(),
                ))
            }
            TargetObservation::Foreground => {
                let foreground_since = *self.foreground_since.get_or_insert(elapsed);
                Ok(elapsed.saturating_sub(foreground_since) >= ACTIVATION_SETTLE_DELAY)
            }
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct InputSubmission {
    pub events_submitted: u32,
}

impl PinnedTarget {
    pub fn hwnd_value(self) -> isize {
        self.hwnd as isize
    }

    pub fn pid(self) -> u32 {
        self.pid
    }

    pub fn title(self) -> String {
        window_title(self.hwnd)
    }
}

pub fn pin_foreground_window() -> Option<PinnedTarget> {
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.is_null() || unsafe { IsWindow(hwnd) } == 0 {
        return None;
    }
    target_for_hwnd(hwnd)
}

pub fn activate_and_settle(target: PinnedTarget) -> Result<(), FocusError> {
    require_available_target(target)?;
    if is_process_restricted(target.pid) {
        return Err(FocusError::Restricted(
            "The paste target is elevated or restricted.".into(),
        ));
    }
    if unsafe { SetForegroundWindow(target.hwnd) } == 0 {
        return Err(FocusError::Restricted(
            "Windows refused to activate the paste target.".into(),
        ));
    }

    let started_at = Instant::now();
    let mut readiness = ReadinessTracker::default();
    loop {
        if readiness.observe(target_observation(target), started_at.elapsed())? {
            return Ok(());
        }
        thread::sleep(ACTIVATION_POLL_INTERVAL);
    }
}

fn is_process_restricted(pid: u32) -> bool {
    let handle = unsafe {
        windows_sys::Win32::System::Threading::OpenProcess(
            windows_sys::Win32::System::Threading::PROCESS_QUERY_INFORMATION,
            0,
            pid,
        )
    };
    if handle.is_null() {
        const ERROR_ACCESS_DENIED: i32 = 5;
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(ERROR_ACCESS_DENIED) {
            return true;
        }
    } else {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(handle) };
    }
    false
}

pub fn submit_ctrl_v_if_foreground(target: PinnedTarget) -> Result<InputSubmission, FocusError> {
    if is_process_restricted(target.pid) {
        return Err(FocusError::Restricted(
            "The paste target became elevated or restricted.".into(),
        ));
    }
    if conflicting_key_is_down() {
        return Err(FocusError::Restricted(
            "A modifier or paste key was held during input submission.".into(),
        ));
    }
    match target_observation(target) {
        TargetObservation::Missing => {
            return Err(FocusError::TargetUnavailable(
                "The pinned paste target no longer exists.",
            ));
        }
        TargetObservation::WrongProcess => {
            return Err(FocusError::TargetUnavailable(
                "The pinned paste target window handle was reused by another process.",
            ));
        }
        TargetObservation::NotForeground => {
            return Err(FocusError::Restricted(
                "The paste target lost focus before input submission.".into(),
            ));
        }
        TargetObservation::Foreground => {}
    }

    let mut inputs = [
        keyboard_input(VK_CONTROL, 0),
        keyboard_input(VK_V, 0),
        keyboard_input(VK_V, KEYEVENTF_KEYUP),
        keyboard_input(VK_CONTROL, KEYEVENTF_KEYUP),
    ];
    let sent = unsafe {
        SendInput(
            inputs.len() as u32,
            inputs.as_mut_ptr(),
            std::mem::size_of::<INPUT>() as i32,
        )
    };
    validate_submission_count(sent)
}

fn validate_submission_count(sent: u32) -> Result<InputSubmission, FocusError> {
    if sent != CTRL_V_EVENT_COUNT {
        return Err(FocusError::IncompleteSubmission {
            events_submitted: sent,
        });
    }
    Ok(InputSubmission {
        events_submitted: sent,
    })
}

fn conflicting_key_is_down() -> bool {
    [VK_CONTROL, VK_MENU, VK_SHIFT, VK_LWIN, VK_RWIN, VK_V]
        .into_iter()
        .any(|key| unsafe { GetAsyncKeyState(key as i32) } < 0)
}

fn keyboard_input(vk: u16, flags: u32) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: 0,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn target_for_hwnd(hwnd: HWND) -> Option<PinnedTarget> {
    let mut pid = 0;
    let thread_id = unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
    (thread_id != 0 && pid != 0).then_some(PinnedTarget { hwnd, pid })
}

fn require_available_target(target: PinnedTarget) -> Result<(), FocusError> {
    match target_observation(target) {
        TargetObservation::Missing => Err(FocusError::TargetUnavailable(
            "The pinned paste target no longer exists.",
        )),
        TargetObservation::WrongProcess => Err(FocusError::TargetUnavailable(
            "The pinned paste target window handle was reused by another process.",
        )),
        TargetObservation::NotForeground | TargetObservation::Foreground => Ok(()),
    }
}

fn target_observation(target: PinnedTarget) -> TargetObservation {
    if unsafe { IsWindow(target.hwnd) } == 0 {
        return TargetObservation::Missing;
    }
    let mut current_pid = 0;
    if unsafe { GetWindowThreadProcessId(target.hwnd, &mut current_pid) } == 0 {
        return TargetObservation::Missing;
    }
    if current_pid != target.pid {
        return TargetObservation::WrongProcess;
    }
    if unsafe { GetForegroundWindow() } == target.hwnd {
        TargetObservation::Foreground
    } else {
        TargetObservation::NotForeground
    }
}

fn window_title(hwnd: HWND) -> String {
    let len = unsafe { GetWindowTextLengthW(hwnd) };
    if len <= 0 {
        return String::new();
    }
    let mut buffer = vec![0u16; len as usize + 1];
    let copied = unsafe { GetWindowTextW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32) };
    if copied <= 0 {
        return String::new();
    }
    OsString::from_wide(&buffer[..copied as usize])
        .to_string_lossy()
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn already_foreground_waits_for_the_full_settle_interval() {
        let mut tracker = ReadinessTracker::default();
        assert!(!tracker
            .observe(TargetObservation::Foreground, Duration::ZERO)
            .unwrap());
        assert!(!tracker
            .observe(TargetObservation::Foreground, Duration::from_millis(179))
            .unwrap());
        assert!(tracker
            .observe(TargetObservation::Foreground, Duration::from_millis(180))
            .unwrap());
    }

    #[test]
    fn delayed_activation_starts_settling_only_when_target_is_foreground() {
        let mut tracker = ReadinessTracker::default();
        assert!(!tracker
            .observe(TargetObservation::NotForeground, Duration::from_millis(100))
            .unwrap());
        assert!(!tracker
            .observe(TargetObservation::Foreground, Duration::from_millis(200))
            .unwrap());
        assert!(!tracker
            .observe(TargetObservation::Foreground, Duration::from_millis(379))
            .unwrap());
        assert!(tracker
            .observe(TargetObservation::Foreground, Duration::from_millis(380))
            .unwrap());
    }

    #[test]
    fn foreground_drift_during_settle_fails_closed() {
        let mut tracker = ReadinessTracker::default();
        tracker
            .observe(TargetObservation::Foreground, Duration::from_millis(20))
            .unwrap();
        assert!(matches!(
            tracker.observe(TargetObservation::NotForeground, Duration::from_millis(40)),
            Err(FocusError::Restricted(_))
        ));
    }

    #[test]
    fn activation_times_out_without_foreground_target() {
        let mut tracker = ReadinessTracker::default();
        assert!(matches!(
            tracker.observe(TargetObservation::NotForeground, ACTIVATION_TIMEOUT),
            Err(FocusError::Restricted(_))
        ));
        assert!(matches!(
            ReadinessTracker::default().observe(TargetObservation::Foreground, ACTIVATION_TIMEOUT),
            Err(FocusError::Restricted(_))
        ));
    }

    #[test]
    fn destroyed_and_reused_targets_are_unavailable() {
        for observation in [TargetObservation::Missing, TargetObservation::WrongProcess] {
            let error = ReadinessTracker::default()
                .observe(observation, Duration::ZERO)
                .unwrap_err();
            assert!(error.is_target_unavailable());
        }
    }

    #[test]
    fn partial_input_submission_is_not_success() {
        for sent in 0..CTRL_V_EVENT_COUNT {
            assert!(matches!(
                validate_submission_count(sent),
                Err(FocusError::IncompleteSubmission {
                    events_submitted
                }) if events_submitted == sent
            ));
        }
    }

    #[test]
    fn full_input_submission_reports_only_accepted_events() {
        assert_eq!(
            validate_submission_count(CTRL_V_EVENT_COUNT).unwrap(),
            InputSubmission {
                events_submitted: CTRL_V_EVENT_COUNT
            }
        );
    }
}
