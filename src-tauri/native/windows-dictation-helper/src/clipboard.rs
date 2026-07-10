use anyhow::{anyhow, Result};
use std::{thread, time::Duration};
use windows_sys::Win32::{
    Foundation::{GlobalFree, HANDLE, HWND},
    System::{
        DataExchange::{
            CloseClipboard, EmptyClipboard, EnumClipboardFormats, GetClipboardData,
            IsClipboardFormatAvailable, OpenClipboard, SetClipboardData,
        },
        Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE, GMEM_ZEROINIT},
    },
};

const CLIPBOARD_RETRY_ATTEMPTS: usize = 12;
const CLIPBOARD_RETRY_DELAY: Duration = Duration::from_millis(25);
const CF_UNICODETEXT: u32 = 13;

pub struct ClipboardBackup {
    original_text: String,
}

pub fn replace_text(text: &str) -> Result<Option<ClipboardBackup>> {
    with_open_clipboard(|| {
        let mut format = 0;
        let mut has_non_text = false;
        loop {
            format = unsafe { EnumClipboardFormats(format) };
            if format == 0 {
                break;
            }
            if format != CF_UNICODETEXT && format != 1 && format != 7 {
                has_non_text = true;
                break;
            }
        }
        if has_non_text {
            set_open_clipboard_text(text)?;
            return Ok(None);
        }

        let original_text = match read_open_clipboard_text()? {
            Some(t) => t,
            None => {
                set_open_clipboard_text(text)?;
                return Ok(None);
            }
        };

        set_open_clipboard_text(text)?;
        Ok(Some(ClipboardBackup { original_text }))
    })
}

pub fn restore_clipboard_if_unchanged(expected: &str, backup: ClipboardBackup) -> Result<()> {
    with_open_clipboard(|| {
        if read_open_clipboard_text()?.as_deref() != Some(expected) {
            return Ok(());
        }
        set_open_clipboard_text(&backup.original_text)
    })
}

struct ClipboardGuard;

impl Drop for ClipboardGuard {
    fn drop(&mut self) {
        unsafe { CloseClipboard() };
    }
}

fn with_open_clipboard<T>(operation: impl FnOnce() -> Result<T>) -> Result<T> {
    let mut opened = false;
    for attempt in 0..CLIPBOARD_RETRY_ATTEMPTS {
        if unsafe { OpenClipboard(std::ptr::null_mut() as HWND) } != 0 {
            opened = true;
            break;
        }
        if attempt + 1 < CLIPBOARD_RETRY_ATTEMPTS {
            thread::sleep(CLIPBOARD_RETRY_DELAY);
        }
    }
    if !opened {
        return Err(anyhow!("clipboard is busy"));
    }

    let _guard = ClipboardGuard;
    operation()
}

fn read_open_clipboard_text() -> Result<Option<String>> {
    if unsafe { IsClipboardFormatAvailable(CF_UNICODETEXT) } == 0 {
        return Ok(None);
    }
    let handle = unsafe { GetClipboardData(CF_UNICODETEXT) };
    if handle.is_null() {
        return Err(anyhow!("GetClipboardData failed"));
    }
    let size = unsafe { GlobalSize(handle as HANDLE) };
    if size == 0 {
        return Ok(Some(String::new()));
    }
    let locked = unsafe { GlobalLock(handle as HANDLE) } as *const u16;
    if locked.is_null() {
        return Err(anyhow!("GlobalLock failed"));
    }
    let units = unsafe { std::slice::from_raw_parts(locked, size / std::mem::size_of::<u16>()) };
    let end = units
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(units.len());
    let text = String::from_utf16_lossy(&units[..end]);
    unsafe { GlobalUnlock(handle as HANDLE) };
    Ok(Some(text))
}

fn set_open_clipboard_text(text: &str) -> Result<()> {
    let mut wide: Vec<u16> = text.encode_utf16().collect();
    wide.push(0);
    let bytes = wide.len() * std::mem::size_of::<u16>();

    unsafe {
        let handle = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, bytes);
        if handle.is_null() {
            return Err(anyhow!("GlobalAlloc failed"));
        }

        let locked = GlobalLock(handle) as *mut u16;
        if locked.is_null() {
            GlobalFree(handle);
            return Err(anyhow!("GlobalLock failed"));
        }
        std::ptr::copy_nonoverlapping(wide.as_ptr(), locked, wide.len());
        GlobalUnlock(handle);

        if EmptyClipboard() == 0 {
            GlobalFree(handle);
            return Err(anyhow!("EmptyClipboard failed"));
        }
        if SetClipboardData(CF_UNICODETEXT, handle).is_null() {
            GlobalFree(handle);
            return Err(anyhow!("SetClipboardData failed"));
        }
    }

    Ok(())
}
