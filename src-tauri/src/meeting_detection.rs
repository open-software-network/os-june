use std::collections::BTreeSet;

const CLEAR_AFTER_INACTIVE_POLLS: u8 = 2;
const HEARTBEAT_EVERY_ACTIVE_POLLS: u8 = 5;

pub fn setup(_app: &mut tauri::App) {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum MeetingDetectionEvent {
    Detected,
    Cleared,
}

#[derive(Debug, Default)]
pub(crate) struct MeetingDetectionState {
    active: bool,
    inactive_polls: u8,
    active_polls_since_emit: u8,
}

impl MeetingDetectionState {
    pub(crate) fn update(
        &mut self,
        active_external_input: bool,
        os_scribe_capture_active: bool,
    ) -> Option<MeetingDetectionEvent> {
        let should_be_active = active_external_input && !os_scribe_capture_active;
        if should_be_active {
            self.inactive_polls = 0;
            if !self.active {
                self.active = true;
                self.active_polls_since_emit = 0;
                return Some(MeetingDetectionEvent::Detected);
            }

            self.active_polls_since_emit = self.active_polls_since_emit.saturating_add(1);
            if self.active_polls_since_emit >= HEARTBEAT_EVERY_ACTIVE_POLLS {
                self.active_polls_since_emit = 0;
                return Some(MeetingDetectionEvent::Detected);
            }
            return None;
        }

        self.active_polls_since_emit = 0;
        if !self.active {
            self.inactive_polls = 0;
            return None;
        }

        self.inactive_polls = self.inactive_polls.saturating_add(1);
        if self.inactive_polls >= CLEAR_AFTER_INACTIVE_POLLS {
            self.active = false;
            self.inactive_polls = 0;
            return Some(MeetingDetectionEvent::Cleared);
        }

        None
    }
}

pub(crate) fn active_external_pids(
    active_input_pids: &[u32],
    owned_pids: &BTreeSet<u32>,
) -> Vec<u32> {
    active_input_pids
        .iter()
        .copied()
        .filter(|pid| *pid != 0 && !owned_pids.contains(pid))
        .collect()
}

#[cfg(target_os = "macos")]
pub(crate) use macos::active_input_process_pids;

#[cfg(not(target_os = "macos"))]
pub(crate) fn active_input_process_pids() -> Result<Vec<u32>, ProbeError> {
    Ok(Vec::new())
}

#[derive(Debug)]
pub(crate) struct ProbeError {
    operation: &'static str,
    status: i32,
}

impl ProbeError {
    fn new(operation: &'static str, status: i32) -> Self {
        Self { operation, status }
    }
}

impl std::fmt::Display for ProbeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "{} failed with OSStatus {}",
            self.operation, self.status
        )
    }
}

impl std::error::Error for ProbeError {}

#[cfg(target_os = "macos")]
mod macos {
    use super::ProbeError;
    use std::{ffi::c_void, mem, ptr};

    type AudioObjectId = u32;
    type AudioObjectPropertySelector = u32;
    type AudioObjectPropertyScope = u32;
    type AudioObjectPropertyElement = u32;
    type OsStatus = i32;

    const AUDIO_OBJECT_SYSTEM_OBJECT: AudioObjectId = 1;
    const AUDIO_OBJECT_UNKNOWN: AudioObjectId = 0;
    const AUDIO_OBJECT_PROPERTY_SCOPE_GLOBAL: AudioObjectPropertyScope = four_cc(*b"glob");
    const AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN: AudioObjectPropertyElement = 0;
    const AUDIO_HARDWARE_PROPERTY_PROCESS_OBJECT_LIST: AudioObjectPropertySelector =
        four_cc(*b"prs#");
    const AUDIO_PROCESS_PROPERTY_PID: AudioObjectPropertySelector = four_cc(*b"ppid");
    const AUDIO_PROCESS_PROPERTY_IS_RUNNING_INPUT: AudioObjectPropertySelector =
        four_cc(*b"piri");

    #[repr(C)]
    struct AudioObjectPropertyAddress {
        selector: AudioObjectPropertySelector,
        scope: AudioObjectPropertyScope,
        element: AudioObjectPropertyElement,
    }

    #[link(name = "CoreAudio", kind = "framework")]
    extern "C" {
        fn AudioObjectGetPropertyDataSize(
            object_id: AudioObjectId,
            address: *const AudioObjectPropertyAddress,
            qualifier_data_size: u32,
            qualifier_data: *const c_void,
            data_size: *mut u32,
        ) -> OsStatus;

        fn AudioObjectGetPropertyData(
            object_id: AudioObjectId,
            address: *const AudioObjectPropertyAddress,
            qualifier_data_size: u32,
            qualifier_data: *const c_void,
            data_size: *mut u32,
            data: *mut c_void,
        ) -> OsStatus;
    }

    pub(crate) fn active_input_process_pids() -> Result<Vec<u32>, ProbeError> {
        let mut pids = Vec::new();
        for process_object in process_objects()? {
            if process_object == AUDIO_OBJECT_UNKNOWN {
                continue;
            }
            let running_input = read_u32_property(
                process_object,
                AUDIO_PROCESS_PROPERTY_IS_RUNNING_INPUT,
                "read process input state",
            )
            .unwrap_or_default();
            if running_input == 0 {
                continue;
            }
            if let Ok(Some(pid)) = read_process_pid(process_object) {
                pids.push(pid);
            }
        }
        pids.sort_unstable();
        pids.dedup();
        Ok(pids)
    }

    fn process_objects() -> Result<Vec<AudioObjectId>, ProbeError> {
        let address = property_address(AUDIO_HARDWARE_PROPERTY_PROCESS_OBJECT_LIST);
        let mut data_size = 0_u32;
        status_result(
            "read process object list size",
            unsafe {
                AudioObjectGetPropertyDataSize(
                    AUDIO_OBJECT_SYSTEM_OBJECT,
                    &address,
                    0,
                    ptr::null(),
                    &mut data_size,
                )
            },
        )?;

        if data_size == 0 {
            return Ok(Vec::new());
        }

        let object_count = data_size as usize / mem::size_of::<AudioObjectId>();
        let mut objects = vec![AUDIO_OBJECT_UNKNOWN; object_count];
        status_result(
            "read process object list",
            unsafe {
                AudioObjectGetPropertyData(
                    AUDIO_OBJECT_SYSTEM_OBJECT,
                    &address,
                    0,
                    ptr::null(),
                    &mut data_size,
                    objects.as_mut_ptr().cast(),
                )
            },
        )?;

        let actual_count = data_size as usize / mem::size_of::<AudioObjectId>();
        objects.truncate(actual_count);
        Ok(objects)
    }

    fn read_process_pid(process_object: AudioObjectId) -> Result<Option<u32>, ProbeError> {
        let pid = read_i32_property(process_object, AUDIO_PROCESS_PROPERTY_PID, "read process pid")?;
        if pid <= 0 {
            Ok(None)
        } else {
            Ok(Some(pid as u32))
        }
    }

    fn read_i32_property(
        object_id: AudioObjectId,
        selector: AudioObjectPropertySelector,
        operation: &'static str,
    ) -> Result<i32, ProbeError> {
        let mut value = 0_i32;
        read_scalar_property(object_id, selector, operation, &mut value)?;
        Ok(value)
    }

    fn read_u32_property(
        object_id: AudioObjectId,
        selector: AudioObjectPropertySelector,
        operation: &'static str,
    ) -> Result<u32, ProbeError> {
        let mut value = 0_u32;
        read_scalar_property(object_id, selector, operation, &mut value)?;
        Ok(value)
    }

    fn read_scalar_property<T>(
        object_id: AudioObjectId,
        selector: AudioObjectPropertySelector,
        operation: &'static str,
        value: &mut T,
    ) -> Result<(), ProbeError> {
        let address = property_address(selector);
        let mut data_size = mem::size_of::<T>() as u32;
        status_result(
            operation,
            unsafe {
                AudioObjectGetPropertyData(
                    object_id,
                    &address,
                    0,
                    ptr::null(),
                    &mut data_size,
                    (value as *mut T).cast(),
                )
            },
        )
    }

    fn property_address(selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress {
            selector,
            scope: AUDIO_OBJECT_PROPERTY_SCOPE_GLOBAL,
            element: AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN,
        }
    }

    fn status_result(operation: &'static str, status: OsStatus) -> Result<(), ProbeError> {
        if status == 0 {
            Ok(())
        } else {
            Err(ProbeError::new(operation, status))
        }
    }

    const fn four_cc(value: [u8; 4]) -> u32 {
        ((value[0] as u32) << 24)
            | ((value[1] as u32) << 16)
            | ((value[2] as u32) << 8)
            | value[3] as u32
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn four_cc_matches_core_audio_constants() {
            assert_eq!(AUDIO_HARDWARE_PROPERTY_PROCESS_OBJECT_LIST, 0x7072_7323);
            assert_eq!(AUDIO_PROCESS_PROPERTY_PID, 0x7070_6964);
            assert_eq!(AUDIO_PROCESS_PROPERTY_IS_RUNNING_INPUT, 0x7069_7269);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_external_pids_excludes_owned_processes() {
        let owned = BTreeSet::from([10, 20]);

        assert_eq!(active_external_pids(&[0, 10, 30, 20, 40], &owned), vec![
            30, 40
        ]);
    }

    #[test]
    fn detector_shows_when_external_input_starts() {
        let mut state = MeetingDetectionState::default();

        assert_eq!(
            state.update(true, false),
            Some(MeetingDetectionEvent::Detected)
        );
        assert_eq!(state.update(true, false), None);
    }

    #[test]
    fn detector_suppresses_while_os_scribe_capture_is_active() {
        let mut state = MeetingDetectionState::default();

        assert_eq!(state.update(true, true), None);
        assert_eq!(
            state.update(true, false),
            Some(MeetingDetectionEvent::Detected)
        );
    }

    #[test]
    fn detector_clears_after_inactive_debounce() {
        let mut state = MeetingDetectionState::default();
        assert_eq!(
            state.update(true, false),
            Some(MeetingDetectionEvent::Detected)
        );

        assert_eq!(state.update(false, false), None);
        assert_eq!(
            state.update(false, false),
            Some(MeetingDetectionEvent::Cleared)
        );
        assert_eq!(state.update(false, false), None);
    }

    #[test]
    fn detector_emits_heartbeat_while_active() {
        let mut state = MeetingDetectionState::default();
        assert_eq!(
            state.update(true, false),
            Some(MeetingDetectionEvent::Detected)
        );

        for _ in 0..(HEARTBEAT_EVERY_ACTIVE_POLLS - 1) {
            assert_eq!(state.update(true, false), None);
        }
        assert_eq!(
            state.update(true, false),
            Some(MeetingDetectionEvent::Detected)
        );
    }

    #[test]
    fn detector_clears_when_os_scribe_capture_starts() {
        let mut state = MeetingDetectionState::default();
        assert_eq!(
            state.update(true, false),
            Some(MeetingDetectionEvent::Detected)
        );

        assert_eq!(state.update(true, true), None);
        assert_eq!(
            state.update(true, true),
            Some(MeetingDetectionEvent::Cleared)
        );
    }
}
