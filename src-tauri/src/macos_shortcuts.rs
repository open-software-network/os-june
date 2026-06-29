//! macOS driver for the dictation shortcut state machine.
//!
//! Wires the platform event sources to [`crate::dictation_shortcuts`] inside the
//! *main* June process (so the global `flagsChanged` monitor's Accessibility
//! grant belongs to June.app, not the helper):
//!
//! - **Carbon hot keys** (`RegisterEventHotKey`) for key-chord shortcuts —
//!   permission-free pressed/released edges.
//! - **`NSEvent` global monitor** for `flagsChanged` — modifier-only chords
//!   (bare Fn / double-tap). Needs the Accessibility grant.
//! - **Timers** (background thread + generation guard, hopped back to the main
//!   thread) for the hold threshold and capture debounce.
//!
//! Everything touches the driver on the main thread: the Carbon callback and
//! NSEvent block already fire there, timers hop back via `run_on_main_thread`,
//! and Tauri commands hop via `run_on_main_thread` too. So the driver lives in a
//! main-thread `thread_local`, no locking required.

#![cfg(target_os = "macos")]

use crate::dictation_shortcuts::{
    Action, HotKeyChord, Input, MonitoredShortcut, ShortcutKind, ShortcutModifiers, ShortcutMonitor,
};
use std::cell::RefCell;
use std::collections::HashMap;
use std::ffi::c_void;
use std::ptr::NonNull;
use std::time::Instant;
use tauri::AppHandle;

// --- Carbon FFI ----------------------------------------------------------
type OSStatus = i32;
type OSType = u32;
type EventRef = *mut c_void;
type EventTargetRef = *mut c_void;
type EventHandlerRef = *mut c_void;
type EventHandlerCallRef = *mut c_void;
type EventHotKeyRef = *mut c_void;

#[repr(C)]
#[derive(Clone, Copy)]
struct EventHotKeyID {
    signature: OSType,
    id: u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct EventTypeSpec {
    event_class: OSType,
    event_kind: u32,
}

type EventHandlerUPP =
    extern "C" fn(EventHandlerCallRef, EventRef, *mut c_void) -> OSStatus;

const EVENT_CLASS_KEYBOARD: OSType = 0x6b65_7962; // 'keyb'
const EVENT_HOTKEY_PRESSED: u32 = 5;
const EVENT_HOTKEY_RELEASED: u32 = 6;
const EVENT_PARAM_DIRECT_OBJECT: OSType = 0x2d2d_2d2d; // '----'
const TYPE_EVENT_HOTKEY_ID: OSType = 0x686b_6964; // 'hkid'
const HOTKEY_SIGNATURE: OSType = 0x4a44_484b; // 'JDHK'

#[link(name = "Carbon", kind = "framework")]
extern "C" {
    fn GetEventDispatcherTarget() -> EventTargetRef;
    fn InstallEventHandler(
        target: EventTargetRef,
        handler: EventHandlerUPP,
        num_types: usize,
        list: *const EventTypeSpec,
        user_data: *mut c_void,
        out_ref: *mut EventHandlerRef,
    ) -> OSStatus;
    fn RegisterEventHotKey(
        key_code: u32,
        modifiers: u32,
        hotkey_id: EventHotKeyID,
        target: EventTargetRef,
        options: u32,
        out_ref: *mut EventHotKeyRef,
    ) -> OSStatus;
    fn UnregisterEventHotKey(hotkey: EventHotKeyRef) -> OSStatus;
    fn GetEventKind(event: EventRef) -> u32;
    fn GetEventParameter(
        event: EventRef,
        name: OSType,
        param_type: OSType,
        out_actual_type: *mut OSType,
        buffer_size: usize,
        out_actual_size: *mut usize,
        out_data: *mut c_void,
    ) -> OSStatus;
}

// --- driver --------------------------------------------------------------

/// Events the driver surfaces to the rest of the app (wired to dictation).
#[derive(Clone, Debug)]
pub enum DriverEvent {
    ShortcutDown(ShortcutKind),
    ShortcutUp(ShortcutKind),
    Captured(MonitoredShortcut),
    CaptureStarted,
    CaptureCancelled,
    FnUnavailable(String),
}

struct Registered {
    id: u32,
    hotkey: EventHotKeyRef,
}

struct Driver {
    app: AppHandle,
    monitor: ShortcutMonitor,
    on_event: Box<dyn Fn(DriverEvent)>,
    base: Instant,
    handler_installed: bool,
    /// NSEvent global monitor token. Held for the driver's (app) lifetime; only
    /// needed if we ever call `removeMonitor:`. Never read otherwise.
    #[allow(dead_code)]
    flags_monitor: Option<objc2::rc::Retained<objc2::runtime::AnyObject>>,
    hotkeys: Vec<Registered>,
    next_hotkey_id: u32,
    hold_generation: u64,
    capture_generation: u64,
    by_id: HashMap<u32, crate::dictation_shortcuts::ShortcutIdentity>,
}

thread_local! {
    static DRIVER: RefCell<Option<Driver>> = const { RefCell::new(None) };
}

impl Driver {
    fn now_ms(&self) -> u64 {
        self.base.elapsed().as_millis() as u64
    }

    fn run(&mut self, actions: Vec<Action>) {
        for action in actions {
            self.apply(action);
        }
    }

    fn apply(&mut self, action: Action) {
        match action {
            Action::ShortcutDown { kind, .. } => (self.on_event)(DriverEvent::ShortcutDown(kind)),
            Action::ShortcutUp { kind, .. } => (self.on_event)(DriverEvent::ShortcutUp(kind)),
            Action::Captured { shortcut } => (self.on_event)(DriverEvent::Captured(shortcut)),
            Action::CaptureStarted => (self.on_event)(DriverEvent::CaptureStarted),
            Action::CaptureCancelled => (self.on_event)(DriverEvent::CaptureCancelled),
            Action::FnUnavailable { message } => (self.on_event)(DriverEvent::FnUnavailable(message)),
            Action::ScheduleHoldTimer { delay_ms } => self.schedule_timer(TimerKind::Hold, delay_ms),
            Action::CancelHoldTimer => self.hold_generation += 1,
            Action::ScheduleCaptureTimer { modifiers, delay_ms } => {
                self.schedule_capture_timer(modifiers, delay_ms)
            }
            Action::CancelCaptureTimer => self.capture_generation += 1,
            Action::RegisterHotKeys { chords } => self.register_hotkeys(chords),
            Action::UnregisterHotKeys => self.unregister_hotkeys(),
        }
    }

    fn schedule_timer(&mut self, kind: TimerKind, delay_ms: u64) {
        self.hold_generation += 1;
        let generation = self.hold_generation;
        let app = self.app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(delay_ms));
            let _ = app.run_on_main_thread(move || {
                with_driver(|driver| {
                    if matches!(kind, TimerKind::Hold) && driver.hold_generation == generation {
                        let actions = driver.monitor.handle(Input::HoldTimerFired);
                        driver.run(actions);
                    }
                });
            });
        });
    }

    fn schedule_capture_timer(&mut self, modifiers: ShortcutModifiers, delay_ms: u64) {
        self.capture_generation += 1;
        let generation = self.capture_generation;
        let app = self.app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(delay_ms));
            let _ = app.run_on_main_thread(move || {
                with_driver(|driver| {
                    if driver.capture_generation == generation {
                        let actions =
                            driver.monitor.handle(Input::CaptureTimerFired { modifiers });
                        driver.run(actions);
                    }
                });
            });
        });
    }

    fn register_hotkeys(&mut self, chords: Vec<HotKeyChord>) {
        self.unregister_hotkeys();
        self.ensure_handler();
        // SAFETY: standard Carbon hot-key registration against the dispatcher
        // target; each ref is stored and unregistered later.
        unsafe {
            let target = GetEventDispatcherTarget();
            for chord in chords {
                let id = self.next_hotkey_id;
                self.next_hotkey_id += 1;
                let hotkey_id = EventHotKeyID {
                    signature: HOTKEY_SIGNATURE,
                    id,
                };
                let mut out: EventHotKeyRef = std::ptr::null_mut();
                let status = RegisterEventHotKey(
                    chord.key_code as u32,
                    chord.carbon_modifiers,
                    hotkey_id,
                    target,
                    0,
                    &mut out,
                );
                if status == 0 && !out.is_null() {
                    self.by_id.insert(id, chord.identity);
                    self.hotkeys.push(Registered { id, hotkey: out });
                }
            }
        }
    }

    fn unregister_hotkeys(&mut self) {
        // SAFETY: every ref came from RegisterEventHotKey and is unregistered once.
        unsafe {
            for registered in self.hotkeys.drain(..) {
                UnregisterEventHotKey(registered.hotkey);
                self.by_id.remove(&registered.id);
            }
        }
    }

    fn ensure_handler(&mut self) {
        if self.handler_installed {
            return;
        }
        let specs = [
            EventTypeSpec {
                event_class: EVENT_CLASS_KEYBOARD,
                event_kind: EVENT_HOTKEY_PRESSED,
            },
            EventTypeSpec {
                event_class: EVENT_CLASS_KEYBOARD,
                event_kind: EVENT_HOTKEY_RELEASED,
            },
        ];
        // SAFETY: installs our extern "C" callback for the two hot-key events.
        unsafe {
            let mut handler_ref: EventHandlerRef = std::ptr::null_mut();
            let status = InstallEventHandler(
                GetEventDispatcherTarget(),
                carbon_hotkey_callback,
                specs.len(),
                specs.as_ptr(),
                std::ptr::null_mut(),
                &mut handler_ref,
            );
            self.handler_installed = status == 0;
        }
    }

    fn on_carbon(&mut self, id: u32, pressed: bool) {
        let Some(identity) = self.by_id.get(&id).cloned() else {
            return;
        };
        let now_ms = self.now_ms();
        let actions = self.monitor.handle(Input::CarbonHotKey {
            identity,
            pressed,
            now_ms,
        });
        self.run(actions);
    }

    fn on_flags_changed(&mut self, modifiers: ShortcutModifiers, changed_key_code: u16) {
        let now_ms = self.now_ms();
        let actions = self.monitor.handle(Input::FlagsChanged {
            modifiers,
            changed_key_code,
            now_ms,
        });
        self.run(actions);
    }
}

enum TimerKind {
    Hold,
}

fn with_driver<R>(f: impl FnOnce(&mut Driver) -> R) -> Option<R> {
    DRIVER.with(|cell| cell.borrow_mut().as_mut().map(f))
}

extern "C" fn carbon_hotkey_callback(
    _next: EventHandlerCallRef,
    event: EventRef,
    _user: *mut c_void,
) -> OSStatus {
    // SAFETY: reads the EventHotKeyID parameter from a keyboard hot-key event.
    let mut hotkey_id = EventHotKeyID {
        signature: 0,
        id: 0,
    };
    let status = unsafe {
        GetEventParameter(
            event,
            EVENT_PARAM_DIRECT_OBJECT,
            TYPE_EVENT_HOTKEY_ID,
            std::ptr::null_mut(),
            std::mem::size_of::<EventHotKeyID>(),
            std::ptr::null_mut(),
            &mut hotkey_id as *mut _ as *mut c_void,
        )
    };
    if status != 0 {
        return status;
    }
    let pressed = unsafe { GetEventKind(event) } == EVENT_HOTKEY_PRESSED;
    with_driver(|driver| driver.on_carbon(hotkey_id.id, pressed));
    0
}

fn modifiers_from_event(flags: objc2_app_kit::NSEventModifierFlags) -> ShortcutModifiers {
    use objc2_app_kit::NSEventModifierFlags;
    ShortcutModifiers {
        command: flags.contains(NSEventModifierFlags::Command),
        control: flags.contains(NSEventModifierFlags::Control),
        option: flags.contains(NSEventModifierFlags::Option),
        shift: flags.contains(NSEventModifierFlags::Shift),
        function: flags.contains(NSEventModifierFlags::Function),
    }
}

fn install_flags_monitor() -> Option<objc2::rc::Retained<objc2::runtime::AnyObject>> {
    use block2::RcBlock;
    use objc2_app_kit::{NSEvent, NSEventMask};

    let block = RcBlock::new(|event: NonNull<objc2_app_kit::NSEvent>| {
        // SAFETY: the global monitor hands us a live NSEvent on the main thread.
        let event = unsafe { event.as_ref() };
        let flags = event.modifierFlags();
        let key_code = event.keyCode();
        let modifiers = modifiers_from_event(flags);
        with_driver(|driver| driver.on_flags_changed(modifiers, key_code));
    });
    // Registering a global flagsChanged monitor; the returned token is retained
    // for the lifetime of the driver.
    NSEvent::addGlobalMonitorForEventsMatchingMask_handler(NSEventMask::FlagsChanged, &block)
}

/// Start the shortcut driver on the main thread. Installs the global monitor +
/// the initial Carbon hot keys and begins delivering `on_event`. Also prompts
/// for Accessibility so June.app registers in the list.
pub fn start(app: AppHandle, on_event: impl Fn(DriverEvent) + Send + 'static) {
    let driver_app = app.clone();
    let _ = app.run_on_main_thread(move || {
        // Register June.app for Accessibility (and surface the prompt).
        crate::macos_accessibility::prompt_and_check();
        let flags_monitor = install_flags_monitor();
        let mut driver = Driver {
            app: driver_app,
            monitor: ShortcutMonitor::new(),
            on_event: Box::new(on_event),
            base: Instant::now(),
            handler_installed: false,
            flags_monitor,
            hotkeys: Vec::new(),
            next_hotkey_id: 1,
            hold_generation: 0,
            capture_generation: 0,
            by_id: HashMap::new(),
        };
        let initial = driver.monitor.initial_hotkeys();
        driver.run(initial);
        DRIVER.with(|cell| *cell.borrow_mut() = Some(driver));
    });
}

/// Apply a new shortcut binding (hops to the main thread).
pub fn set_shortcut(app: &AppHandle, shortcut: MonitoredShortcut, kind: ShortcutKind) {
    let _ = app.run_on_main_thread(move || {
        with_driver(|driver| {
            let actions = driver.monitor.set_shortcut(shortcut, kind);
            driver.run(actions);
        });
    });
}

/// Begin capturing a modifier-only chord (hops to the main thread).
pub fn start_capture(app: &AppHandle, press_count: u8) {
    let _ = app.run_on_main_thread(move || {
        with_driver(|driver| {
            let actions = driver.monitor.start_capture(press_count);
            driver.run(actions);
        });
    });
}

/// Cancel an in-progress capture (hops to the main thread).
pub fn cancel_capture(app: &AppHandle) {
    let _ = app.run_on_main_thread(move || {
        with_driver(|driver| {
            let actions = driver.monitor.cancel_capture();
            driver.run(actions);
        });
    });
}
