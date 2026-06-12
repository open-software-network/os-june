//! In-memory relay that lets a phone (controller) drive a desktop's June
//! (host) without either device accepting inbound connections. Both reach
//! scribe-api outbound; the relay pipes JSON frames between them.
//!
//! Trust model (deliberately phone-login-free, like the reference UX):
//! - The desktop is authenticated as an OS Accounts user and mints a pairing.
//!   That anchors the relay to a real identity on the host end.
//! - The pairing **code** is a capability: shown only on the trusted desktop,
//!   single-use, and short-lived. The phone exchanges it for a
//!   **controller token** scoped to exactly that one pairing, and never signs
//!   in. Whoever holds the code can drive that host until it is unpaired, so
//!   the code is treated like a password: short TTL, one claim, never logged.
//!
//! Nothing is persisted: a link is live WebSocket state and a pairing is a
//! few-minute handshake. A server restart drops both; devices reconnect and
//! re-pair. No user content is ever at rest here.

use rand::Rng;
use scribe_domain::UserId;
use std::collections::HashMap;
use std::sync::{
    Arc, Mutex, MutexGuard, PoisonError,
    atomic::{AtomicBool, Ordering},
};
use tokio::sync::mpsc;

/// How long a pairing code is claimable before it expires, in seconds.
pub(crate) const PAIRING_TTL_SECONDS: u64 = 180;

/// Locks a mutex, recovering from poisoning. A panic elsewhere can't corrupt
/// the relay's invariants (worst case a single frame is dropped), so taking
/// the inner value is safe and keeps the lints' no-`unwrap`/`expect` rule.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
/// Pairing code length. Crockford base32 (no ambiguous chars); 8 chars is
/// ~40 bits, unguessable within the TTL while typeable on a phone.
const CODE_LEN: usize = 8;
/// Controller-token length. Longer (the phone's standing credential for the
/// life of the link), still opaque base32.
const TOKEN_LEN: usize = 32;
const CODE_ALPHABET: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

pub(crate) type PairingId = String;

#[derive(Clone)]
struct Pairing {
    id: PairingId,
    code: String,
    user_id: UserId,
    expires_at_unix: u64,
    /// Set on claim: the controller token the phone presents on its WS.
    controller_token: Option<String>,
}

/// One paired conversation. Each role has a *current* inbox sender, replaced
/// on every (re)attach, so a reconnecting side gets a fresh channel and a
/// stale sender from a dropped peer simply has no receiver. Sending to the
/// peer is a hub lookup, never a captured sender, which is what makes
/// reconnection safe.
struct Link {
    host_inbox: Mutex<Option<mpsc::UnboundedSender<String>>>,
    controller_inbox: Mutex<Option<mpsc::UnboundedSender<String>>>,
    host_present: Arc<AtomicBool>,
    controller_present: Arc<AtomicBool>,
}

impl Link {
    fn inbox(&self, role: Role) -> &Mutex<Option<mpsc::UnboundedSender<String>>> {
        match role {
            Role::Host => &self.host_inbox,
            Role::Controller => &self.controller_inbox,
        }
    }

    fn present(&self, role: Role) -> &AtomicBool {
        match role {
            Role::Host => &self.host_present,
            Role::Controller => &self.controller_present,
        }
    }

    /// Best-effort send to `role`'s current connection. Returns false if that
    /// role is not attached (no inbox) or its receiver is gone.
    fn deliver(&self, role: Role, message: String) -> bool {
        lock(self.inbox(role))
            .as_ref()
            .is_some_and(|tx| tx.send(message).is_ok())
    }
}

fn peer_of(role: Role) -> Role {
    match role {
        Role::Host => Role::Controller,
        Role::Controller => Role::Host,
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Role {
    Host,
    Controller,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum AttachError {
    UnknownPairing,
    RoleTaken,
}

pub(crate) struct ClaimedPairing {
    pub pairing_id: PairingId,
    pub controller_token: String,
}

/// What a connected side holds. `recv` yields frames from its peer (and
/// hub-injected presence frames); `send_to_peer` relays a frame to whoever is
/// currently attached as the peer. Dropping it frees the role and notifies
/// the peer (see `PresenceGuard`).
pub(crate) struct LinkHandle {
    link: Arc<Link>,
    role: Role,
    inbound: mpsc::UnboundedReceiver<String>,
    _presence: PresenceGuard,
}

impl LinkHandle {
    pub(crate) async fn recv(&mut self) -> Option<String> {
        self.inbound.recv().await
    }

    /// Relays a frame to the peer. False if the peer is not attached.
    pub(crate) fn send_to_peer(&self, message: String) -> bool {
        self.link.deliver(peer_of(self.role), message)
    }
}

struct PresenceGuard {
    link: Arc<Link>,
    role: Role,
    leave_frame: &'static str,
}

impl Drop for PresenceGuard {
    fn drop(&mut self) {
        self.link.present(self.role).store(false, Ordering::SeqCst);
        // Clear our inbox so a stale peer send can't queue into a dead socket.
        *lock(self.link.inbox(self.role)) = None;
        // Tell the peer we left.
        self.link
            .deliver(peer_of(self.role), self.leave_frame.to_string());
    }
}

#[derive(Default)]
pub(crate) struct RemoteHub {
    pairings: Mutex<HashMap<PairingId, Pairing>>,
    links: Mutex<HashMap<PairingId, Arc<Link>>>,
}

impl RemoteHub {
    /// Mints a pairing for the authenticated desktop user. `now_unix`/`new_id`
    /// are injected so the hub is a pure, testable unit.
    pub(crate) fn create_pairing(
        &self,
        user: UserId,
        now_unix: u64,
        new_id: PairingId,
    ) -> (PairingId, String) {
        self.prune(now_unix);
        let pairing = Pairing {
            id: new_id,
            code: random_token(CODE_LEN),
            user_id: user,
            expires_at_unix: now_unix + PAIRING_TTL_SECONDS,
            controller_token: None,
        };
        let result = (pairing.id.clone(), pairing.code.clone());
        lock(&self.pairings).insert(pairing.id.clone(), pairing);
        result
    }

    /// Claims a pairing by code (no auth: the code IS the capability). Returns
    /// the pairing id and a freshly minted controller token. Single-use: a
    /// claimed or expired code yields nothing.
    pub(crate) fn claim_pairing(&self, code: &str, now_unix: u64) -> Option<ClaimedPairing> {
        let code = code.trim().to_ascii_uppercase();
        let mut pairings = lock(&self.pairings);
        let entry = pairings.values_mut().find(|p| p.code == code)?;
        if entry.controller_token.is_some() || entry.expires_at_unix <= now_unix {
            return None;
        }
        let token = random_token(TOKEN_LEN);
        entry.controller_token = Some(token.clone());
        Some(ClaimedPairing {
            pairing_id: entry.id.clone(),
            controller_token: token,
        })
    }

    /// Host attach: the desktop authenticated as `user`; the pairing must be
    /// its own and already claimed by a phone.
    pub(crate) fn attach_host(
        &self,
        pairing: &PairingId,
        user: &UserId,
    ) -> Result<LinkHandle, AttachError> {
        {
            let pairings = lock(&self.pairings);
            let ok = pairings
                .get(pairing)
                .is_some_and(|p| &p.user_id == user && p.controller_token.is_some());
            if !ok {
                return Err(AttachError::UnknownPairing);
            }
        }
        self.attach(pairing, Role::Host)
    }

    /// Controller attach: the phone presents its controller token, which the
    /// hub resolves to a pairing. No OS Accounts identity needed.
    pub(crate) fn attach_controller(
        &self,
        controller_token: &str,
    ) -> Result<(PairingId, LinkHandle), AttachError> {
        let pairing_id = {
            let pairings = lock(&self.pairings);
            pairings
                .values()
                .find(|p| p.controller_token.as_deref() == Some(controller_token))
                .map(|p| p.id.clone())
                .ok_or(AttachError::UnknownPairing)?
        };
        let handle = self.attach(&pairing_id, Role::Controller)?;
        Ok((pairing_id, handle))
    }

    fn attach(&self, pairing: &PairingId, role: Role) -> Result<LinkHandle, AttachError> {
        let mut links = lock(&self.links);
        let link = links
            .entry(pairing.clone())
            .or_insert_with(|| {
                Arc::new(Link {
                    host_inbox: Mutex::new(None),
                    controller_inbox: Mutex::new(None),
                    host_present: Arc::new(AtomicBool::new(false)),
                    controller_present: Arc::new(AtomicBool::new(false)),
                })
            })
            .clone();

        // Claim the role; a live connection for it is refused.
        if link.present(role).swap(true, Ordering::SeqCst) {
            return Err(AttachError::RoleTaken);
        }
        // Fresh inbox every attach, so a reconnecting side starts clean.
        let (inbox_tx, inbox_rx) = mpsc::unbounded_channel();
        *lock(link.inbox(role)) = Some(inbox_tx);

        let leave_frame = match role {
            Role::Host => PEER_LEFT_HOST,
            Role::Controller => PEER_LEFT_CONTROLLER,
        };
        Ok(LinkHandle {
            link: link.clone(),
            role,
            inbound: inbox_rx,
            _presence: PresenceGuard {
                link,
                role,
                leave_frame,
            },
        })
    }

    pub(crate) fn peer_present(&self, pairing: &PairingId, role: Role) -> bool {
        let links = lock(&self.links);
        let Some(link) = links.get(pairing) else {
            return false;
        };
        link.present(peer_of(role)).load(Ordering::SeqCst)
    }

    pub(crate) fn release_if_idle(&self, pairing: &PairingId) {
        let mut links = lock(&self.links);
        let idle = links.get(pairing).is_some_and(|link| {
            !link.host_present.load(Ordering::SeqCst)
                && !link.controller_present.load(Ordering::SeqCst)
        });
        if idle {
            links.remove(pairing);
        }
    }

    fn prune(&self, now_unix: u64) {
        lock(&self.pairings)
            .retain(|_, p| p.expires_at_unix > now_unix || p.controller_token.is_some());
    }
}

pub(crate) const PEER_LEFT_HOST: &str = r#"{"type":"peer_left","peer":"host"}"#;
pub(crate) const PEER_LEFT_CONTROLLER: &str = r#"{"type":"peer_left","peer":"controller"}"#;
pub(crate) const PEER_HERE_HOST: &str = r#"{"type":"peer_here","peer":"host"}"#;
pub(crate) const PEER_HERE_CONTROLLER: &str = r#"{"type":"peer_here","peer":"controller"}"#;

/// Current wall-clock seconds. The one spot the relay needs real time; the
/// hub stays clock-free for testing.
pub(crate) fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// A fresh opaque pairing id (lowercase base36, distinct from the uppercase
/// human-typed code).
pub(crate) fn new_pairing_id() -> String {
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let mut rng = rand::thread_rng();
    (0..24)
        .map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char)
        .collect()
}

fn random_token(len: usize) -> String {
    let mut rng = rand::thread_rng();
    (0..len)
        .map(|_| CODE_ALPHABET[rng.gen_range(0..CODE_ALPHABET.len())] as char)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user(id: &str) -> UserId {
        UserId(id.to_string())
    }

    #[test]
    fn pairing_claim_is_single_use_and_case_insensitive() {
        let hub = RemoteHub::default();
        let (id, code) = hub.create_pairing(user("usr_a"), 1000, "pair-1".into());
        assert_eq!(code.len(), CODE_LEN);

        let claim = hub
            .claim_pairing(&code.to_ascii_lowercase(), 1001)
            .expect("claim");
        assert_eq!(claim.pairing_id, id);
        assert_eq!(claim.controller_token.len(), TOKEN_LEN);
        // Second claim of the same code fails.
        assert!(hub.claim_pairing(&code, 1002).is_none());
    }

    #[test]
    fn expired_code_cannot_be_claimed() {
        let hub = RemoteHub::default();
        let (_, code) = hub.create_pairing(user("usr_a"), 1000, "pair-1".into());
        let after = 1000 + PAIRING_TTL_SECONDS + 1;
        assert!(hub.claim_pairing(&code, after).is_none());
    }

    #[test]
    fn host_attach_requires_own_claimed_pairing() {
        let hub = RemoteHub::default();
        let (id, code) = hub.create_pairing(user("usr_a"), 1000, "pair-1".into());

        // Not claimed yet: host attach refused.
        assert_eq!(
            hub.attach_host(&id, &user("usr_a")).err(),
            Some(AttachError::UnknownPairing)
        );
        hub.claim_pairing(&code, 1001);
        // Wrong user: refused.
        assert_eq!(
            hub.attach_host(&id, &user("usr_b")).err(),
            Some(AttachError::UnknownPairing)
        );
        // Owner: ok, and a second host is refused WHILE the first is alive.
        let first = hub.attach_host(&id, &user("usr_a")).expect("first host");
        assert_eq!(
            hub.attach_host(&id, &user("usr_a")).err(),
            Some(AttachError::RoleTaken)
        );
        // Dropping it frees the role: a reconnect succeeds (no panic).
        drop(first);
        assert!(hub.attach_host(&id, &user("usr_a")).is_ok());
    }

    #[test]
    fn controller_attaches_by_token_only() {
        let hub = RemoteHub::default();
        let (id, code) = hub.create_pairing(user("usr_a"), 1000, "pair-1".into());
        let claim = hub.claim_pairing(&code, 1001).expect("claim");

        assert_eq!(
            hub.attach_controller("wrong-token").err(),
            Some(AttachError::UnknownPairing)
        );
        let (resolved, _handle) = hub
            .attach_controller(&claim.controller_token)
            .expect("controller attaches");
        assert_eq!(resolved, id);
    }

    #[tokio::test]
    async fn frames_relay_and_disconnect_notifies_peer() {
        let hub = RemoteHub::default();
        let (id, code) = hub.create_pairing(user("usr_a"), 1000, "pair-1".into());
        let claim = hub.claim_pairing(&code, 1001).expect("claim");

        let mut host = hub.attach_host(&id, &user("usr_a")).expect("host");
        let (_, mut controller) = hub
            .attach_controller(&claim.controller_token)
            .expect("controller");

        assert!(controller.send_to_peer("prompt".into()));
        assert_eq!(host.recv().await.as_deref(), Some("prompt"));
        assert!(host.send_to_peer("delta".into()));
        assert_eq!(controller.recv().await.as_deref(), Some("delta"));

        drop(host);
        assert_eq!(controller.recv().await.as_deref(), Some(PEER_LEFT_HOST));
    }

    #[test]
    fn peer_present_tracks_attach_and_release() {
        let hub = RemoteHub::default();
        let (id, code) = hub.create_pairing(user("usr_a"), 1000, "pair-1".into());
        let claim = hub.claim_pairing(&code, 1001).expect("claim");

        let host = hub.attach_host(&id, &user("usr_a")).expect("host");
        assert!(!hub.peer_present(&id, Role::Host));
        let (_, controller) = hub
            .attach_controller(&claim.controller_token)
            .expect("ctrl");
        assert!(hub.peer_present(&id, Role::Host));

        drop(controller);
        assert!(!hub.peer_present(&id, Role::Host));
        drop(host);
        hub.release_if_idle(&id);
    }
}
