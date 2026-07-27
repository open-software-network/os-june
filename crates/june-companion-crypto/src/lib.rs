//! Shared cryptographic state machine for desktop and iOS.
//!
//! Pairing uses Noise XX with a QR-delivered pre-shared key. Linked devices use
//! Noise KK, where both static Curve25519 public keys were authenticated by the
//! pairing transcript. A fresh handshake is required after the bounded
//! transport lifetime; there is no ad-hoc cipher construction in this crate.

#![deny(unsafe_op_in_unsafe_fn)]

use snow::{Builder, HandshakeState, TransportState, params::NoiseParams};
use std::{
    ptr, slice,
    time::{Duration, Instant},
};
use thiserror::Error;
use zeroize::Zeroizing;

pub const KEY_BYTES: usize = 32;
pub const MAX_NOISE_MESSAGE_BYTES: usize = 65_535;
pub const TRANSPORT_MESSAGE_LIMIT: u64 = 1 << 20;
pub const TRANSPORT_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);

const PAIRING_PATTERN: &str = "Noise_XXpsk3_25519_ChaChaPoly_BLAKE2s";
const LINKED_PATTERN: &str = "Noise_KK_25519_ChaChaPoly_BLAKE2s";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdentityKeypair {
    pub private: Zeroizing<Vec<u8>>,
    pub public: Vec<u8>,
}

pub fn generate_identity() -> Result<IdentityKeypair, CryptoError> {
    let params: NoiseParams = LINKED_PATTERN.parse().map_err(CryptoError::Noise)?;
    let pair = Builder::new(params)
        .generate_keypair()
        .map_err(CryptoError::Noise)?;
    Ok(IdentityKeypair {
        private: Zeroizing::new(pair.private),
        public: pair.public,
    })
}

enum State {
    Handshake(Option<HandshakeState>),
    Transport(TransportState),
}

pub struct Session {
    state: State,
    remote_static: Option<[u8; KEY_BYTES]>,
    transport_started_at: Option<Instant>,
    sent_messages: u64,
    received_messages: u64,
}

impl Session {
    pub fn pairing(
        initiator: bool,
        local_private: &[u8],
        pairing_secret: &[u8],
    ) -> Result<Self, CryptoError> {
        validate_key(local_private)?;
        validate_key(pairing_secret)?;
        let params: NoiseParams = PAIRING_PATTERN.parse().map_err(CryptoError::Noise)?;
        let pairing_secret: &[u8; KEY_BYTES] = pairing_secret
            .try_into()
            .map_err(|_| CryptoError::InvalidKey)?;
        let builder = Builder::new(params)
            .local_private_key(local_private)
            .map_err(CryptoError::Noise)?
            .psk(3, pairing_secret)
            .map_err(CryptoError::Noise)?;
        Self::handshake(builder, initiator)
    }

    pub fn linked(
        initiator: bool,
        local_private: &[u8],
        remote_public: &[u8],
    ) -> Result<Self, CryptoError> {
        validate_key(local_private)?;
        validate_key(remote_public)?;
        let params: NoiseParams = LINKED_PATTERN.parse().map_err(CryptoError::Noise)?;
        let builder = Builder::new(params)
            .local_private_key(local_private)
            .map_err(CryptoError::Noise)?
            .remote_public_key(remote_public)
            .map_err(CryptoError::Noise)?;
        Self::handshake(builder, initiator)
    }

    fn handshake(builder: Builder<'_>, initiator: bool) -> Result<Self, CryptoError> {
        let handshake = if initiator {
            builder.build_initiator()
        } else {
            builder.build_responder()
        }
        .map_err(CryptoError::Noise)?;
        Ok(Self {
            state: State::Handshake(Some(handshake)),
            remote_static: None,
            transport_started_at: None,
            sent_messages: 0,
            received_messages: 0,
        })
    }

    pub fn is_transport_ready(&self) -> bool {
        matches!(self.state, State::Transport(_))
    }

    pub fn remote_static(&self) -> Option<&[u8; KEY_BYTES]> {
        self.remote_static.as_ref()
    }

    pub fn write(&mut self, plaintext: &[u8]) -> Result<Vec<u8>, CryptoError> {
        if plaintext.len() > MAX_NOISE_MESSAGE_BYTES - 48 {
            return Err(CryptoError::MessageTooLarge);
        }
        if matches!(self.state, State::Transport(_)) {
            self.ensure_transport_fresh(self.sent_messages)?;
        }
        match &mut self.state {
            State::Handshake(handshake) => {
                let state = handshake.as_mut().ok_or(CryptoError::InvalidState)?;
                let mut output = vec![0_u8; MAX_NOISE_MESSAGE_BYTES];
                let written = state
                    .write_message(plaintext, &mut output)
                    .map_err(CryptoError::Noise)?;
                output.truncate(written);
                self.finish_handshake_if_ready()?;
                Ok(output)
            }
            State::Transport(transport) => {
                let mut output = vec![0_u8; plaintext.len() + 16];
                let written = transport
                    .write_message(plaintext, &mut output)
                    .map_err(CryptoError::Noise)?;
                output.truncate(written);
                self.sent_messages = self.sent_messages.saturating_add(1);
                Ok(output)
            }
        }
    }

    pub fn read(&mut self, ciphertext: &[u8]) -> Result<Vec<u8>, CryptoError> {
        if ciphertext.len() > MAX_NOISE_MESSAGE_BYTES {
            return Err(CryptoError::MessageTooLarge);
        }
        if matches!(self.state, State::Transport(_)) {
            self.ensure_transport_fresh(self.received_messages)?;
        }
        match &mut self.state {
            State::Handshake(handshake) => {
                let state = handshake.as_mut().ok_or(CryptoError::InvalidState)?;
                let mut output = vec![0_u8; MAX_NOISE_MESSAGE_BYTES];
                let read = state
                    .read_message(ciphertext, &mut output)
                    .map_err(CryptoError::Noise)?;
                output.truncate(read);
                self.finish_handshake_if_ready()?;
                Ok(output)
            }
            State::Transport(transport) => {
                let mut output = vec![0_u8; ciphertext.len()];
                let read = transport
                    .read_message(ciphertext, &mut output)
                    .map_err(CryptoError::Noise)?;
                output.truncate(read);
                self.received_messages = self.received_messages.saturating_add(1);
                Ok(output)
            }
        }
    }

    fn ensure_transport_fresh(&self, messages: u64) -> Result<(), CryptoError> {
        if messages >= TRANSPORT_MESSAGE_LIMIT
            || self
                .transport_started_at
                .is_some_and(|at| at.elapsed() >= TRANSPORT_MAX_AGE)
        {
            return Err(CryptoError::RehandshakeRequired);
        }
        Ok(())
    }

    fn finish_handshake_if_ready(&mut self) -> Result<(), CryptoError> {
        let State::Handshake(handshake) = &mut self.state else {
            return Ok(());
        };
        if !handshake
            .as_ref()
            .ok_or(CryptoError::InvalidState)?
            .is_handshake_finished()
        {
            return Ok(());
        }
        let state = handshake.take().ok_or(CryptoError::InvalidState)?;
        if let Some(remote) = state.get_remote_static() {
            self.remote_static = Some(remote.try_into().map_err(|_| CryptoError::InvalidKey)?);
        }
        let transport = state.into_transport_mode().map_err(CryptoError::Noise)?;
        self.state = State::Transport(transport);
        self.transport_started_at = Some(Instant::now());
        Ok(())
    }
}

#[derive(Debug, Error)]
pub enum CryptoError {
    #[error("Noise operation failed: {0}")]
    Noise(snow::Error),
    #[error("key must be exactly 32 bytes")]
    InvalidKey,
    #[error("message is too large")]
    MessageTooLarge,
    #[error("session is in an invalid state")]
    InvalidState,
    #[error("a fresh linked-device handshake is required")]
    RehandshakeRequired,
}

fn validate_key(value: &[u8]) -> Result<(), CryptoError> {
    if value.len() == KEY_BYTES {
        Ok(())
    } else {
        Err(CryptoError::InvalidKey)
    }
}

/// Stable C ABI used by the Swift native module. Callers own identity bytes and
/// must keep private keys in Keychain; the opaque session owns only handshake
/// and transport state.
pub mod ffi {
    use super::*;

    pub const OK: i32 = 0;
    pub const INVALID_ARGUMENT: i32 = 1;
    pub const CRYPTO_FAILURE: i32 = 2;
    pub const BUFFER_TOO_SMALL: i32 = 3;
    pub const REHANDSHAKE_REQUIRED: i32 = 4;

    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn june_crypto_generate_identity(
        private_out: *mut u8,
        public_out: *mut u8,
    ) -> i32 {
        if private_out.is_null() || public_out.is_null() {
            return INVALID_ARGUMENT;
        }
        let Ok(identity) = generate_identity() else {
            return CRYPTO_FAILURE;
        };
        // SAFETY: the ABI contract requires both output pointers to address
        // writable KEY_BYTES buffers and null was rejected above.
        unsafe {
            ptr::copy_nonoverlapping(identity.private.as_ptr(), private_out, KEY_BYTES);
            ptr::copy_nonoverlapping(identity.public.as_ptr(), public_out, KEY_BYTES);
        }
        OK
    }

    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn june_crypto_pairing_session_new(
        initiator: bool,
        local_private: *const u8,
        pairing_secret: *const u8,
    ) -> *mut Session {
        let (Some(local_private), Some(pairing_secret)) = (
            // SAFETY: each pointer was supplied with the fixed ABI length.
            unsafe { fixed_input(local_private) },
            unsafe { fixed_input(pairing_secret) },
        ) else {
            return ptr::null_mut();
        };
        Session::pairing(initiator, local_private, pairing_secret)
            .map(|session| Box::into_raw(Box::new(session)))
            .unwrap_or(ptr::null_mut())
    }

    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn june_crypto_linked_session_new(
        initiator: bool,
        local_private: *const u8,
        remote_public: *const u8,
    ) -> *mut Session {
        let (Some(local_private), Some(remote_public)) = (
            // SAFETY: each pointer was supplied with the fixed ABI length.
            unsafe { fixed_input(local_private) },
            unsafe { fixed_input(remote_public) },
        ) else {
            return ptr::null_mut();
        };
        Session::linked(initiator, local_private, remote_public)
            .map(|session| Box::into_raw(Box::new(session)))
            .unwrap_or(ptr::null_mut())
    }

    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn june_crypto_session_write(
        session: *mut Session,
        input: *const u8,
        input_len: usize,
        output: *mut u8,
        output_capacity: usize,
        output_len: *mut usize,
    ) -> i32 {
        // SAFETY: validated and converted by the shared ABI helper.
        unsafe {
            session_operation(
                session,
                input,
                input_len,
                output,
                output_capacity,
                output_len,
                true,
            )
        }
    }

    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn june_crypto_session_read(
        session: *mut Session,
        input: *const u8,
        input_len: usize,
        output: *mut u8,
        output_capacity: usize,
        output_len: *mut usize,
    ) -> i32 {
        // SAFETY: validated and converted by the shared ABI helper.
        unsafe {
            session_operation(
                session,
                input,
                input_len,
                output,
                output_capacity,
                output_len,
                false,
            )
        }
    }

    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn june_crypto_session_is_ready(session: *const Session) -> bool {
        // SAFETY: callers pass an opaque handle returned by this library.
        unsafe { session.as_ref() }.is_some_and(Session::is_transport_ready)
    }

    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn june_crypto_session_remote_static(
        session: *const Session,
        output: *mut u8,
    ) -> i32 {
        if output.is_null() {
            return INVALID_ARGUMENT;
        }
        // SAFETY: callers pass an opaque handle returned by this library.
        let Some(remote) = (unsafe { session.as_ref() }).and_then(Session::remote_static) else {
            return CRYPTO_FAILURE;
        };
        // SAFETY: the ABI contract requires output to address KEY_BYTES bytes.
        unsafe { ptr::copy_nonoverlapping(remote.as_ptr(), output, KEY_BYTES) };
        OK
    }

    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn june_crypto_session_free(session: *mut Session) {
        if !session.is_null() {
            // SAFETY: handles are returned by Box::into_raw above and must be
            // released exactly once by the owner.
            drop(unsafe { Box::from_raw(session) });
        }
    }

    unsafe fn fixed_input<'a>(input: *const u8) -> Option<&'a [u8]> {
        if input.is_null() {
            None
        } else {
            // SAFETY: the caller promises a readable KEY_BYTES buffer.
            Some(unsafe { slice::from_raw_parts(input, KEY_BYTES) })
        }
    }

    #[allow(clippy::too_many_arguments)]
    unsafe fn session_operation(
        session: *mut Session,
        input: *const u8,
        input_len: usize,
        output: *mut u8,
        output_capacity: usize,
        output_len: *mut usize,
        write: bool,
    ) -> i32 {
        if session.is_null() || input.is_null() || output.is_null() || output_len.is_null() {
            return INVALID_ARGUMENT;
        }
        // SAFETY: pointers are checked above and governed by the ABI contract.
        let session = unsafe { &mut *session };
        // SAFETY: input_len is supplied by the caller for this readable buffer.
        let input = unsafe { slice::from_raw_parts(input, input_len) };
        let result = if write {
            session.write(input)
        } else {
            session.read(input)
        };
        let bytes = match result {
            Ok(bytes) => bytes,
            Err(CryptoError::RehandshakeRequired) => return REHANDSHAKE_REQUIRED,
            Err(_) => return CRYPTO_FAILURE,
        };
        if bytes.len() > output_capacity {
            // SAFETY: output_len is a valid writable pointer by contract.
            unsafe { *output_len = bytes.len() };
            return BUFFER_TOO_SMALL;
        }
        // SAFETY: output_capacity was checked against the result length.
        unsafe {
            ptr::copy_nonoverlapping(bytes.as_ptr(), output, bytes.len());
            *output_len = bytes.len();
        }
        OK
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn complete_pairing(initiator: &mut Session, responder: &mut Session) {
        let first = initiator.write(b"").unwrap();
        assert_eq!(responder.read(&first).unwrap(), b"");
        let second = responder.write(b"").unwrap();
        assert_eq!(initiator.read(&second).unwrap(), b"");
        let third = initiator.write(b"").unwrap();
        assert_eq!(responder.read(&third).unwrap(), b"");
        assert!(initiator.is_transport_ready());
        assert!(responder.is_transport_ready());
    }

    fn complete_linked(initiator: &mut Session, responder: &mut Session) {
        let first = initiator.write(b"").unwrap();
        assert_eq!(responder.read(&first).unwrap(), b"");
        let second = responder.write(b"").unwrap();
        assert_eq!(initiator.read(&second).unwrap(), b"");
        assert!(initiator.is_transport_ready());
        assert!(responder.is_transport_ready());
    }

    #[test]
    fn qr_secret_authenticates_pairing_and_exposes_static_identities() {
        let alice = generate_identity().unwrap();
        let bob = generate_identity().unwrap();
        let secret = [7_u8; KEY_BYTES];
        let mut initiator = Session::pairing(true, &alice.private, &secret).unwrap();
        let mut responder = Session::pairing(false, &bob.private, &secret).unwrap();
        complete_pairing(&mut initiator, &mut responder);
        assert_eq!(initiator.remote_static().unwrap(), bob.public.as_slice());
        assert_eq!(responder.remote_static().unwrap(), alice.public.as_slice());
    }

    #[test]
    fn linked_transport_is_bidirectional_and_rejects_tampering_and_replay() {
        let alice = generate_identity().unwrap();
        let bob = generate_identity().unwrap();
        let mut initiator = Session::linked(true, &alice.private, &bob.public).unwrap();
        let mut responder = Session::linked(false, &bob.private, &alice.public).unwrap();
        complete_linked(&mut initiator, &mut responder);

        let ciphertext = initiator.write(b"private note").unwrap();
        assert_eq!(responder.read(&ciphertext).unwrap(), b"private note");
        assert!(
            responder.read(&ciphertext).is_err(),
            "nonce replay must fail"
        );

        let mut tampered = initiator.write(b"second").unwrap();
        tampered[0] ^= 1;
        assert!(
            responder.read(&tampered).is_err(),
            "authentication must fail"
        );
    }

    #[test]
    fn wrong_pairing_secret_cannot_finish_the_handshake() {
        let alice = generate_identity().unwrap();
        let bob = generate_identity().unwrap();
        let mut initiator = Session::pairing(true, &alice.private, &[1; KEY_BYTES]).unwrap();
        let mut responder = Session::pairing(false, &bob.private, &[2; KEY_BYTES]).unwrap();
        let first = initiator.write(b"").unwrap();
        responder.read(&first).unwrap();
        let second = responder.write(b"").unwrap();
        initiator.read(&second).unwrap();
        let third = initiator.write(b"").unwrap();
        assert!(responder.read(&third).is_err());
    }
}
