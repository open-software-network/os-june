use anyhow::{anyhow, Result};
use std::{ffi::OsString, os::windows::ffi::OsStringExt, thread, time::Duration};
use windows_sys::Win32::{
    Foundation::{HWND, LPARAM},
    UI::{
        Input::KeyboardAndMouse::{
            SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VK_CONTROL,
            VK_V,
        },
        WindowsAndMessaging::{
            EnumWindows, GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW,
            GetWindowThreadProcessId, IsWindow, IsWindowVisible, SetForegroundWindow,
        },
    },
};

const FOCUS_VERIFY_ATTEMPTS: usize = 10;
const FOCUS_VERIFY_DELAY: Duration = Duration::from_millis(35);

#[derive(Clone, Copy, Debug)]
pub struct PinnedTarget {
    hwnd: HWND,
    pid: u32,
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
        return first_visible_window();
    }
    Some(target_for_hwnd(hwnd))
}

pub fn verify_foreground(target: PinnedTarget) -> bool {
    if unsafe { IsWindow(target.hwnd) } == 0 {
        return false;
    }
    if is_process_restricted(target.pid) {
        return false;
    }
    unsafe { SetForegroundWindow(target.hwnd) };
    for _ in 0..FOCUS_VERIFY_ATTEMPTS {
        if unsafe { GetForegroundWindow() } == target.hwnd {
            return true;
        }
        thread::sleep(FOCUS_VERIFY_DELAY);
    }
    false
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
        let err = std::io::Error::last_os_error();
        if err.kind() == std::io::ErrorKind::PermissionDenied {
            return true;
        }
    } else {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(handle) };
    }
    false
}

pub fn send_ctrl_v() -> Result<()> {
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
    if sent != inputs.len() as u32 {
        return Err(anyhow!("SendInput sent {sent} of {} events", inputs.len()));
    }
    Ok(())
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

fn target_for_hwnd(hwnd: HWND) -> PinnedTarget {
    let mut pid = 0;
    unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
    PinnedTarget { hwnd, pid }
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

fn first_visible_window() -> Option<PinnedTarget> {
    unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> i32 {
        if IsWindowVisible(hwnd) != 0 && GetWindowTextLengthW(hwnd) > 0 {
            let slot = lparam as *mut HWND;
            *slot = hwnd;
            return 0;
        }
        1
    }

    let mut hwnd: HWND = std::ptr::null_mut();
    unsafe { EnumWindows(Some(enum_proc), &mut hwnd as *mut HWND as LPARAM) };
    if hwnd.is_null() {
        None
    } else {
        Some(target_for_hwnd(hwnd))
    }
}
