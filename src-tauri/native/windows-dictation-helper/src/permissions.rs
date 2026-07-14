use windows_sys::Win32::System::Ole::{OleInitialize, OleUninitialize};

pub struct ComApartment {
    initialized: bool,
}

impl ComApartment {
    pub fn init_sta() -> Self {
        let hr = unsafe { OleInitialize(std::ptr::null_mut()) };
        Self {
            initialized: hr >= 0,
        }
    }
}

impl Drop for ComApartment {
    fn drop(&mut self) {
        if self.initialized {
            unsafe { OleUninitialize() };
        }
    }
}
