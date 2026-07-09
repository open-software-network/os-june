use anyhow::{anyhow, Result};
use std::{thread, time::Duration};
use windows_sys::Win32::{
    Foundation::{GlobalFree, HWND},
    System::{
        DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData},
        Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE, GMEM_ZEROINIT},
    },
};

const CLIPBOARD_RETRY_ATTEMPTS: usize = 12;
const CLIPBOARD_RETRY_DELAY: Duration = Duration::from_millis(25);
const CF_UNICODETEXT: u32 = 13;

pub fn set_text(text: &str) -> Result<()> {
    let mut opened = false;
    for attempt in 0..CLIPBOARD_RETRY_ATTEMPTS {
        if unsafe { OpenClipboard(0 as HWND) } != 0 {
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

    let result = set_open_clipboard_text(text);
    unsafe { CloseClipboard() };
    result
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
