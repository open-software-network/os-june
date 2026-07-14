//! Public-web-only URL policy for the managed browser (JUN-289).
//!
//! Per ADR 0017 and its 2026-07-13 addendum, the Rust broker is the only
//! enforcement point for browser policy. This module is the single source of
//! truth for which destinations the managed transport may reach: a scheme and
//! host check for a pre-navigation refusal, an address-class check that names
//! every blocked range once, and a resolve-then-validate step that the pinning
//! proxy (`super::proxy`) runs on every connection so a hostname cannot pass
//! the check publicly and then re-resolve to a private address when the browser
//! connects (DNS rebinding).
//!
//! ## Privacy
//!
//! Violation messages name the address class only. They never carry the URL,
//! the hostname, or any resolved IP: a browsing session's destinations are
//! exactly the material the user is trusting June with, and an error string is
//! a copy of it outside that boundary.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

use url::Url;

use crate::browser::BoxFuture;

/// Policy knobs for the managed transport.
///
/// `allow_loopback` exists ONLY so tests and the env-gated E2E harness can
/// point the browser at loopback fixtures. Production always uses
/// [`PolicyConfig::default`], which blocks loopback like every other
/// non-public range.
#[derive(Debug, Clone, Default)]
pub struct PolicyConfig {
    /// Admit loopback destinations (127.0.0.0/8 and ::1). Never set in
    /// production; the derived default is false, so loopback is blocked.
    pub allow_loopback: bool,
}

/// The class of a blocked address, used to name a refusal without leaking the
/// address itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AddressClass {
    /// 127.0.0.0/8 or ::1.
    Loopback,
    /// 169.254.0.0/16 or fe80::/10.
    LinkLocal,
    /// 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16.
    Private,
    /// 100.64.0.0/10 (carrier-grade NAT).
    CarrierGradeNat,
    /// fc00::/7 (IPv6 unique local).
    UniqueLocal,
    /// 224.0.0.0/4 or ff00::/8.
    Multicast,
    /// 0.0.0.0/8 or the unspecified IPv6 address.
    Unspecified,
    /// 240.0.0.0/4 (IPv4 reserved).
    Reserved,
    /// 255.255.255.255 (limited broadcast).
    Broadcast,
    /// An IANA special-purpose range that is not globally routable but is not
    /// one of the classes above: IPv4 protocol assignments (192.0.0.0/24),
    /// benchmarking (198.18.0.0/15), the documentation nets, the deprecated
    /// 6to4 relay anycast block, and their IPv6 counterparts (Teredo,
    /// documentation, 6to4, ORCHIDv2). These are reachable inside VPNs and
    /// appliance networks, so "not on my hand-written denylist" must not mean
    /// "public".
    SpecialPurpose,
}

impl AddressClass {
    /// A model-facing noun phrase for the class. Never contains an address.
    fn phrase(self) -> &'static str {
        match self {
            AddressClass::Loopback => "a loopback address",
            AddressClass::LinkLocal => "a link-local address",
            AddressClass::Private => "a private address",
            AddressClass::CarrierGradeNat => "a carrier-grade NAT address",
            AddressClass::UniqueLocal => "a unique local address",
            AddressClass::Multicast => "a multicast address",
            AddressClass::Unspecified => "an unspecified address",
            AddressClass::Reserved => "a reserved address",
            AddressClass::Broadcast => "a broadcast address",
            AddressClass::SpecialPurpose => "a special-purpose, non-public address",
        }
    }
}

/// Why a destination was refused. Rendered to the model via [`Display`]; the
/// text names the failure class only, never the destination.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PolicyViolation {
    /// The URL scheme is not http or https.
    NonHttpScheme,
    /// The URL parsed with no host, or a host that is not usable.
    MissingHost,
    /// DNS resolution failed or returned no addresses.
    ResolutionFailure,
    /// The destination resolves to a non-public address of the named class.
    BlockedAddress(AddressClass),
}

impl std::fmt::Display for PolicyViolation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Every branch ends with the same public-web reminder; none names the
        // offending host, path, or IP.
        match self {
            PolicyViolation::NonHttpScheme => write!(
                f,
                "Navigation blocked: only http and https addresses are reachable. The managed browser reaches only the public web."
            ),
            PolicyViolation::MissingHost => write!(
                f,
                "Navigation blocked: the address is missing a valid host. The managed browser reaches only the public web."
            ),
            PolicyViolation::ResolutionFailure => write!(
                f,
                "Navigation blocked: the destination could not be resolved. The managed browser reaches only the public web."
            ),
            PolicyViolation::BlockedAddress(class) => write!(
                f,
                "Navigation blocked: the destination resolves to {}. The managed browser reaches only the public web.",
                class.phrase()
            ),
        }
    }
}

impl std::error::Error for PolicyViolation {}

/// A URL that passed the scheme, host, and (for IP literals) address checks.
/// Exposes exactly what the transport needs to resolve and connect.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedUrl {
    url: Url,
    host: String,
    port: u16,
}

impl ValidatedUrl {
    /// The parsed URL.
    pub fn url(&self) -> &Url {
        &self.url
    }

    /// The host, exactly as it must be handed to the resolver (IPv6 literals
    /// keep their brackets so `host:port` stays parseable).
    pub fn host(&self) -> &str {
        &self.host
    }

    /// The effective port, defaulting to the scheme's well-known port.
    pub fn port(&self) -> u16 {
        self.port
    }
}

/// Validate a raw URL for a pre-navigation refusal: the scheme must be exactly
/// http or https, a host is required, and an IP-literal host is address-checked
/// here (with loopback blocked, as in production). Hostnames are only resolved
/// later, at connection time, by [`resolve_validated`].
pub fn validate_public_http_url(raw: &str) -> Result<ValidatedUrl, PolicyViolation> {
    let url = Url::parse(raw).map_err(|_| PolicyViolation::MissingHost)?;

    match url.scheme() {
        "http" | "https" => {}
        _ => return Err(PolicyViolation::NonHttpScheme),
    }

    let host = url
        .host_str()
        .ok_or(PolicyViolation::MissingHost)?
        .to_string();
    let port = url
        .port_or_known_default()
        .ok_or(PolicyViolation::MissingHost)?;

    // An IP-literal host is a destination we can decide on now. Use the
    // production config: a loopback literal is refused pre-navigation, so
    // loopback fixtures reach the transport as hostnames, never literals.
    if let Some(parsed_host) = url.host() {
        match parsed_host {
            url::Host::Ipv4(v4) => {
                if let Some(violation) = address_violation(IpAddr::V4(v4), &PolicyConfig::default())
                {
                    return Err(violation);
                }
            }
            url::Host::Ipv6(v6) => {
                if let Some(violation) = address_violation(IpAddr::V6(v6), &PolicyConfig::default())
                {
                    return Err(violation);
                }
            }
            url::Host::Domain(_) => {}
        }
    }

    Ok(ValidatedUrl { url, host, port })
}

/// The single source of truth for blocked address ranges. Returns the class of
/// the first rule the address trips, or `None` if the address is public.
///
/// IPv6 addresses that embed an IPv4 address (IPv4-mapped, IPv4-compatible, and
/// the NAT64 well-known prefix 64:ff9b::/96) are normalized to their embedded
/// IPv4 and re-checked, so `::ffff:10.0.0.1` cannot smuggle a private v4 target
/// through the v6 path.
pub fn address_violation(ip: IpAddr, config: &PolicyConfig) -> Option<PolicyViolation> {
    match ip {
        IpAddr::V4(v4) => ipv4_violation(v4, config),
        IpAddr::V6(v6) => {
            if let Some(embedded) = embedded_ipv4(v6) {
                return ipv4_violation(embedded, config);
            }
            ipv6_violation(v6, config)
        }
    }
}

fn ipv4_violation(ip: Ipv4Addr, config: &PolicyConfig) -> Option<PolicyViolation> {
    let octets = ip.octets();

    // 0.0.0.0/8 (this-network / unspecified).
    if octets[0] == 0 {
        return Some(PolicyViolation::BlockedAddress(AddressClass::Unspecified));
    }
    // 127.0.0.0/8.
    if ip.is_loopback() {
        return if config.allow_loopback {
            None
        } else {
            Some(PolicyViolation::BlockedAddress(AddressClass::Loopback))
        };
    }
    // 169.254.0.0/16.
    if ip.is_link_local() {
        return Some(PolicyViolation::BlockedAddress(AddressClass::LinkLocal));
    }
    // 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16.
    if ip.is_private() {
        return Some(PolicyViolation::BlockedAddress(AddressClass::Private));
    }
    // 100.64.0.0/10 (carrier-grade NAT): first octet 100, second octet 64..=127.
    if octets[0] == 100 && (octets[1] & 0xc0) == 0x40 {
        return Some(PolicyViolation::BlockedAddress(
            AddressClass::CarrierGradeNat,
        ));
    }
    // 255.255.255.255 (checked before the 240/4 reserved sweep it falls under).
    if ip.is_broadcast() {
        return Some(PolicyViolation::BlockedAddress(AddressClass::Broadcast));
    }
    // 224.0.0.0/4.
    if ip.is_multicast() {
        return Some(PolicyViolation::BlockedAddress(AddressClass::Multicast));
    }
    // 240.0.0.0/4 (reserved, future use).
    if octets[0] >= 240 {
        return Some(PolicyViolation::BlockedAddress(AddressClass::Reserved));
    }
    // The remaining IANA IPv4 special-purpose ranges. These are NOT globally
    // routable, and several (notably 198.18.0.0/15, benchmarking) are routed
    // inside real VPN and appliance networks, so omitting them would let a
    // hostname resolve to a reachable non-public service and still pass.
    let special = [
        // 192.0.0.0/24 IETF protocol assignments.
        (octets[0] == 192 && octets[1] == 0 && octets[2] == 0),
        // 192.0.2.0/24 TEST-NET-1.
        (octets[0] == 192 && octets[1] == 0 && octets[2] == 2),
        // 198.51.100.0/24 TEST-NET-2.
        (octets[0] == 198 && octets[1] == 51 && octets[2] == 100),
        // 203.0.113.0/24 TEST-NET-3.
        (octets[0] == 203 && octets[1] == 0 && octets[2] == 113),
        // 198.18.0.0/15 benchmarking.
        (octets[0] == 198 && (octets[1] & 0xfe) == 18),
        // 192.88.99.0/24 deprecated 6to4 relay anycast.
        (octets[0] == 192 && octets[1] == 88 && octets[2] == 99),
    ];
    if special.into_iter().any(|hit| hit) {
        return Some(PolicyViolation::BlockedAddress(
            AddressClass::SpecialPurpose,
        ));
    }
    None
}

fn ipv6_violation(ip: Ipv6Addr, config: &PolicyConfig) -> Option<PolicyViolation> {
    if ip.is_unspecified() {
        return Some(PolicyViolation::BlockedAddress(AddressClass::Unspecified));
    }
    if ip.is_loopback() {
        return if config.allow_loopback {
            None
        } else {
            Some(PolicyViolation::BlockedAddress(AddressClass::Loopback))
        };
    }

    let first = ip.segments()[0];
    // fe80::/10 (link-local unicast). The is_unicast_link_local method is still
    // unstable, so match the prefix by hand.
    if (first & 0xffc0) == 0xfe80 {
        return Some(PolicyViolation::BlockedAddress(AddressClass::LinkLocal));
    }
    // fc00::/7 (unique local). is_unique_local is likewise unstable.
    if (first & 0xfe00) == 0xfc00 {
        return Some(PolicyViolation::BlockedAddress(AddressClass::UniqueLocal));
    }
    // ff00::/8 (multicast).
    if ip.is_multicast() {
        return Some(PolicyViolation::BlockedAddress(AddressClass::Multicast));
    }

    let segments = ip.segments();
    // 2001:db8::/32 (documentation).
    if segments[0] == 0x2001 && segments[1] == 0x0db8 {
        return Some(PolicyViolation::BlockedAddress(
            AddressClass::SpecialPurpose,
        ));
    }
    // 2001::/23 (IETF protocol assignments), which contains Teredo
    // (2001::/32) and ORCHIDv2. Teredo addresses embed an IPv4 address, so
    // leaving the block open would be a tunnel to a target the v4 rules
    // already refuse.
    if segments[0] == 0x2001 && (segments[1] & 0xfe00) == 0x0000 {
        return Some(PolicyViolation::BlockedAddress(
            AddressClass::SpecialPurpose,
        ));
    }
    // 2002::/16 (6to4): the next 32 bits ARE an IPv4 address, so 6to4 is a
    // direct route to a private v4 destination if left open.
    if segments[0] == 0x2002 {
        return Some(PolicyViolation::BlockedAddress(
            AddressClass::SpecialPurpose,
        ));
    }
    None
}

/// If `ip` embeds an IPv4 address in a form an attacker could use to reach a
/// private v4 target through the v6 path, return that embedded address.
fn embedded_ipv4(ip: Ipv6Addr) -> Option<Ipv4Addr> {
    let octets = ip.octets();
    let embedded = Ipv4Addr::new(octets[12], octets[13], octets[14], octets[15]);

    // IPv4-mapped ::ffff:0:0/96.
    if octets[..10].iter().all(|b| *b == 0) && octets[10] == 0xff && octets[11] == 0xff {
        return Some(embedded);
    }
    // NAT64 well-known prefix 64:ff9b::/96.
    if octets[0] == 0x00
        && octets[1] == 0x64
        && octets[2] == 0xff
        && octets[3] == 0x9b
        && octets[4..12].iter().all(|b| *b == 0)
    {
        return Some(embedded);
    }
    // IPv4-compatible ::/96 (deprecated), excluding :: and ::1 which are the
    // unspecified and loopback addresses, not embedded IPv4.
    if octets[..12].iter().all(|b| *b == 0)
        && !(octets[12] == 0 && octets[13] == 0 && octets[14] == 0 && octets[15] <= 1)
    {
        return Some(embedded);
    }
    None
}

/// Resolves `(host, port)` and returns a boxed, `Send` future so the trait
/// stays object-safe behind `Arc<dyn Resolver>`.
pub trait Resolver: Send + Sync {
    /// Resolve a host and port to candidate socket addresses.
    fn resolve<'a>(
        &'a self,
        host: &'a str,
        port: u16,
    ) -> BoxFuture<'a, std::io::Result<Vec<SocketAddr>>>;
}

/// The production resolver: the operating system's DNS via `lookup_host`.
pub struct SystemResolver;

impl Resolver for SystemResolver {
    fn resolve<'a>(
        &'a self,
        host: &'a str,
        port: u16,
    ) -> BoxFuture<'a, std::io::Result<Vec<SocketAddr>>> {
        // Own the target so the future borrows nothing.
        let target = format!("{host}:{port}");
        Box::pin(async move {
            let addrs = tokio::net::lookup_host(target).await?;
            Ok(addrs.collect())
        })
    }
}

/// Resolve a host and validate every resolved address atomically, so the caller
/// can pin the connection to the returned addresses. An empty result or a
/// resolver error is a violation. If ANY resolved address is blocked the whole
/// set is refused: a mixed public/private answer is an attack shape (DNS
/// rebinding), not a partial success.
pub async fn resolve_validated(
    host: &str,
    port: u16,
    resolver: &dyn Resolver,
    config: &PolicyConfig,
) -> Result<Vec<SocketAddr>, PolicyViolation> {
    let addrs = resolver
        .resolve(host, port)
        .await
        .map_err(|_| PolicyViolation::ResolutionFailure)?;

    if addrs.is_empty() {
        return Err(PolicyViolation::ResolutionFailure);
    }

    for addr in &addrs {
        if let Some(violation) = address_violation(addr.ip(), config) {
            return Err(violation);
        }
    }

    Ok(addrs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::SocketAddr;

    /// A resolver that returns a fixed address set regardless of input, for
    /// exercising mixed and blocked answers deterministically.
    struct FixedResolver(Vec<SocketAddr>);

    impl Resolver for FixedResolver {
        fn resolve<'a>(
            &'a self,
            _host: &'a str,
            _port: u16,
        ) -> BoxFuture<'a, std::io::Result<Vec<SocketAddr>>> {
            let addrs = self.0.clone();
            Box::pin(async move { Ok(addrs) })
        }
    }

    struct FailingResolver;

    impl Resolver for FailingResolver {
        fn resolve<'a>(
            &'a self,
            _host: &'a str,
            _port: u16,
        ) -> BoxFuture<'a, std::io::Result<Vec<SocketAddr>>> {
            Box::pin(async move {
                Err(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "no such host",
                ))
            })
        }
    }

    fn class_of(ip: &str) -> Option<AddressClass> {
        let addr: IpAddr = ip.parse().expect("valid IP");
        match address_violation(addr, &PolicyConfig::default()) {
            Some(PolicyViolation::BlockedAddress(class)) => Some(class),
            Some(other) => panic!("unexpected violation kind: {other:?}"),
            None => None,
        }
    }

    #[test]
    fn blocked_address_table_covers_every_class_v4_and_v6() {
        let cases: &[(&str, Option<AddressClass>)] = &[
            // IPv4 blocked classes.
            ("0.0.0.0", Some(AddressClass::Unspecified)),
            ("0.1.2.3", Some(AddressClass::Unspecified)),
            ("127.0.0.1", Some(AddressClass::Loopback)),
            ("127.255.255.254", Some(AddressClass::Loopback)),
            ("169.254.10.10", Some(AddressClass::LinkLocal)),
            ("10.0.0.1", Some(AddressClass::Private)),
            ("172.16.5.4", Some(AddressClass::Private)),
            ("192.168.1.1", Some(AddressClass::Private)),
            ("100.64.0.1", Some(AddressClass::CarrierGradeNat)),
            ("100.127.255.255", Some(AddressClass::CarrierGradeNat)),
            ("224.0.0.1", Some(AddressClass::Multicast)),
            ("239.255.255.255", Some(AddressClass::Multicast)),
            ("240.0.0.1", Some(AddressClass::Reserved)),
            ("255.255.255.255", Some(AddressClass::Broadcast)),
            // IPv4 public.
            ("93.184.216.34", None),
            ("8.8.8.8", None),
            ("100.63.255.255", None), // just below carrier-grade NAT
            ("100.128.0.1", None),    // just above carrier-grade NAT
            // IPv6 blocked classes.
            ("::", Some(AddressClass::Unspecified)),
            ("::1", Some(AddressClass::Loopback)),
            ("fe80::1", Some(AddressClass::LinkLocal)),
            ("fc00::1", Some(AddressClass::UniqueLocal)),
            ("fd12:3456::1", Some(AddressClass::UniqueLocal)),
            ("ff02::1", Some(AddressClass::Multicast)),
            // IPv6 embedding a private IPv4 must be normalized and re-checked.
            ("::ffff:10.0.0.1", Some(AddressClass::Private)),
            ("::ffff:127.0.0.1", Some(AddressClass::Loopback)),
            ("64:ff9b::10.0.0.1", Some(AddressClass::Private)),
            ("::0.0.0.10", Some(AddressClass::Unspecified)), // IPv4-compatible 0.0.0.10 -> 0/8
            ("::ffff:8.8.8.8", None),                        // mapped public v4 is fine
            // IPv6 public.
            ("2606:4700::1111", None),
            ("2001:4860:4860::8888", None),
        ];

        for (ip, expected) in cases {
            assert_eq!(class_of(ip), *expected, "address {ip}");
        }
    }

    #[test]
    fn iana_special_purpose_ranges_are_not_treated_as_public() {
        // "Not on my hand-written denylist" must not mean "public". These
        // ranges are not globally routable, and several are routed for real
        // inside VPN and appliance networks (198.18.0.0/15 especially), so a
        // hostname resolving here would otherwise reach a non-public service.
        let cases = [
            "198.18.0.1",        // benchmarking
            "198.19.255.255",    // benchmarking, upper half
            "192.0.0.1",         // IETF protocol assignments
            "192.0.2.5",         // TEST-NET-1
            "198.51.100.5",      // TEST-NET-2
            "203.0.113.5",       // TEST-NET-3
            "192.88.99.1",       // deprecated 6to4 relay anycast
            "2001:db8::1",       // IPv6 documentation
            "2001::1",           // Teredo (embeds IPv4)
            "2002:0a00:0001::1", // 6to4 (embeds 10.0.0.1)
        ];
        for ip in cases {
            assert_eq!(
                class_of(ip),
                Some(AddressClass::SpecialPurpose),
                "address {ip} must not be treated as public"
            );
        }

        // The neighbours of the benchmarking block stay public, so the mask is
        // not over-broad.
        assert_eq!(class_of("198.17.255.255"), None);
        assert_eq!(class_of("198.20.0.1"), None);
    }

    #[test]
    fn allow_loopback_admits_loopback_but_not_private() {
        let cfg = PolicyConfig {
            allow_loopback: true,
        };
        assert_eq!(address_violation("127.0.0.1".parse().unwrap(), &cfg), None);
        assert_eq!(address_violation("::1".parse().unwrap(), &cfg), None);
        // Loopback is the only concession; private stays blocked.
        assert_eq!(
            address_violation("10.0.0.1".parse().unwrap(), &cfg),
            Some(PolicyViolation::BlockedAddress(AddressClass::Private))
        );
    }

    #[test]
    fn scheme_refusals_and_acceptances() {
        for raw in [
            "file:///etc/passwd",
            "chrome://settings",
            "ftp://example.com/file",
            "javascript:alert(1)",
            "data:text/html,hi",
            "ws://example.com/socket",
        ] {
            assert_eq!(
                validate_public_http_url(raw),
                Err(PolicyViolation::NonHttpScheme),
                "scheme should be refused: {raw}"
            );
        }

        assert!(validate_public_http_url("http://example.com/").is_ok());
        assert!(validate_public_http_url("https://example.com/path?q=1").is_ok());
    }

    #[test]
    fn ip_literal_hosts_are_validated_at_parse_time() {
        assert_eq!(
            validate_public_http_url("http://127.0.0.1/"),
            Err(PolicyViolation::BlockedAddress(AddressClass::Loopback))
        );
        assert_eq!(
            validate_public_http_url("http://10.0.0.1/"),
            Err(PolicyViolation::BlockedAddress(AddressClass::Private))
        );
        assert_eq!(
            validate_public_http_url("http://[::1]/"),
            Err(PolicyViolation::BlockedAddress(AddressClass::Loopback))
        );
        // A public literal is admitted.
        assert!(validate_public_http_url("http://93.184.216.34/").is_ok());
    }

    #[test]
    fn effective_port_defaults_to_scheme() {
        let http = validate_public_http_url("http://example.com/").unwrap();
        assert_eq!(http.port(), 80);
        let https = validate_public_http_url("https://example.com/").unwrap();
        assert_eq!(https.port(), 443);
        let explicit = validate_public_http_url("http://example.com:8080/").unwrap();
        assert_eq!(explicit.port(), 8080);
    }

    #[tokio::test]
    async fn mixed_public_and_private_resolution_is_refused() {
        let resolver = FixedResolver(vec![
            "93.184.216.34:443".parse::<SocketAddr>().unwrap(),
            "10.0.0.1:443".parse::<SocketAddr>().unwrap(),
        ]);
        let result =
            resolve_validated("example.com", 443, &resolver, &PolicyConfig::default()).await;
        assert_eq!(
            result,
            Err(PolicyViolation::BlockedAddress(AddressClass::Private))
        );
    }

    #[tokio::test]
    async fn all_public_resolution_is_admitted() {
        let addrs = vec![
            "93.184.216.34:443".parse::<SocketAddr>().unwrap(),
            "8.8.8.8:443".parse::<SocketAddr>().unwrap(),
        ];
        let resolver = FixedResolver(addrs.clone());
        let result = resolve_validated("example.com", 443, &resolver, &PolicyConfig::default())
            .await
            .unwrap();
        assert_eq!(result, addrs);
    }

    #[tokio::test]
    async fn empty_and_failed_resolution_are_violations() {
        let empty = FixedResolver(vec![]);
        assert_eq!(
            resolve_validated("example.com", 443, &empty, &PolicyConfig::default()).await,
            Err(PolicyViolation::ResolutionFailure)
        );
        assert_eq!(
            resolve_validated(
                "example.com",
                443,
                &FailingResolver,
                &PolicyConfig::default()
            )
            .await,
            Err(PolicyViolation::ResolutionFailure)
        );
    }

    #[test]
    fn violation_messages_never_contain_the_destination() {
        // A blocked private literal: the message must not echo the IP.
        let private = validate_public_http_url("http://10.0.0.1/").unwrap_err();
        let text = private.to_string();
        assert!(!text.contains("10.0.0.1"), "leaked IP: {text}");

        let loopback = address_violation("127.0.0.1".parse().unwrap(), &PolicyConfig::default())
            .unwrap()
            .to_string();
        assert!(!loopback.contains("127"), "leaked IP: {loopback}");

        // Every rendered violation stays on the public-web message.
        for violation in [
            PolicyViolation::NonHttpScheme,
            PolicyViolation::MissingHost,
            PolicyViolation::ResolutionFailure,
            PolicyViolation::BlockedAddress(AddressClass::Private),
        ] {
            assert!(violation.to_string().contains("public web"));
        }
    }
}
