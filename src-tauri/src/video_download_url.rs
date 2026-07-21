use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs},
    ops::RangeInclusive,
};

const CGNAT_IPV4_SECOND_OCTET: RangeInclusive<u8> = 64..=127;

pub fn validate_video_download_url(url: &str) -> Result<(reqwest::Url, Vec<SocketAddr>), String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| "video download URL is invalid")?;
    if parsed.scheme() != "https" {
        return Err("video download URL must use https".to_string());
    }

    let host = parsed
        .host_str()
        .ok_or_else(|| "video download URL must include a host".to_string())?;
    if let Ok(ip) = host.parse::<IpAddr>() {
        reject_non_public_ip(ip)?;
    }

    let port = parsed
        .port_or_known_default()
        .ok_or_else(|| "video download URL must include a resolvable port".to_string())?;
    let addrs: Vec<_> = (host, port)
        .to_socket_addrs()
        .map_err(|_| "video download URL host could not be resolved".to_string())?
        .collect();
    if addrs.is_empty() {
        return Err("video download URL host did not resolve".to_string());
    }

    for addr in &addrs {
        reject_non_public_ip(addr.ip())?;
    }

    Ok((parsed, addrs))
}

pub fn video_download_client_builder(
    parsed: &reqwest::Url,
    validated_addrs: &[SocketAddr],
) -> Result<reqwest::ClientBuilder, String> {
    let host = parsed
        .host_str()
        .ok_or_else(|| "video download URL must include a host".to_string())?;
    if validated_addrs.is_empty() {
        return Err("video download URL host did not resolve".to_string());
    }

    // Venice pre-signed video URLs are direct GETs. If a provider later needs
    // CDN redirects, add a custom policy that validates and pins every hop.
    Ok(reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .resolve_to_addrs(host, validated_addrs))
}

fn reject_non_public_ip(ip: IpAddr) -> Result<(), String> {
    if is_non_public_ip(ip) {
        return Err("video download URL host resolved to a non-public address".to_string());
    }
    Ok(())
}

fn is_non_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ipv4) => is_non_public_ipv4(ipv4),
        IpAddr::V6(ipv6) => is_non_public_ipv6(ipv6),
    }
}

fn is_non_public_ipv4(ip: Ipv4Addr) -> bool {
    ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || ip.is_multicast()
        || is_cgnat_ipv4(ip)
}

fn is_cgnat_ipv4(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    octets[0] == 100 && CGNAT_IPV4_SECOND_OCTET.contains(&octets[1])
}

fn is_non_public_ipv6(ip: Ipv6Addr) -> bool {
    if ip.is_loopback() || ip.is_unspecified() || ip.is_multicast() {
        return true;
    }

    let octets = ip.octets();
    if matches!(octets[0], 0xfc | 0xfd) {
        return true;
    }
    if octets[0] == 0xfe && (octets[1] & 0xc0) == 0x80 {
        return true;
    }

    if let Some(ipv4) = embedded_ipv4(octets) {
        return is_non_public_ipv4(ipv4);
    }

    false
}

fn embedded_ipv4(octets: [u8; 16]) -> Option<Ipv4Addr> {
    let prefix_is_zero = octets[..10].iter().all(|octet| *octet == 0);
    let is_mapped = prefix_is_zero && octets[10] == 0xff && octets[11] == 0xff;
    let is_compatible = octets[..12].iter().all(|octet| *octet == 0);
    if is_mapped || is_compatible {
        return Some(Ipv4Addr::new(
            octets[12], octets[13], octets[14], octets[15],
        ));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        },
        time::{Duration, Instant},
    };

    #[test]
    fn public_ipv4_and_ipv6_are_allowed() {
        assert!(!is_non_public_ip(IpAddr::V4(Ipv4Addr::new(
            93, 184, 216, 34
        ))));
        assert!(!is_non_public_ip(IpAddr::V6(
            "2606:2800:220:1:248:1893:25c8:1946".parse().unwrap()
        )));
    }

    #[test]
    fn rejects_non_https_urls() {
        assert!(validate_video_download_url("http://example.com/video.mp4").is_err());
        assert!(validate_video_download_url("file:///tmp/video.mp4").is_err());
        assert!(validate_video_download_url("data:text/plain,video").is_err());
    }

    #[test]
    fn rejects_non_public_ip_literals() {
        for url in [
            "https://127.0.0.1/video.mp4",
            "https://10.0.0.5/video.mp4",
            "https://192.168.1.1/video.mp4",
            "https://169.254.169.254/latest/meta-data",
            "https://100.64.0.1/video.mp4",
            "https://100.127.255.255/video.mp4",
            "https://[::1]/video.mp4",
            "https://[fd00::1]/video.mp4",
            "https://[fe80::1]/video.mp4",
            "https://[::ffff:127.0.0.1]/video.mp4",
            "https://[::ffff:10.0.0.5]/video.mp4",
        ] {
            assert!(validate_video_download_url(url).is_err(), "{url}");
        }
    }

    #[test]
    fn allows_public_ip_literal() {
        let (_parsed, addrs) =
            validate_video_download_url("https://93.184.216.34/video.mp4").unwrap();

        assert_eq!(addrs, vec![SocketAddr::from(([93, 184, 216, 34], 443))]);
    }

    #[tokio::test]
    async fn pinned_video_download_client_does_not_follow_redirect_to_loopback() {
        let target_hit = Arc::new(AtomicBool::new(false));
        let (target_addr, target_thread) =
            spawn_one_response_server("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nvideo", {
                let target_hit = Arc::clone(&target_hit);
                move || target_hit.store(true, Ordering::SeqCst)
            });
        let redirect_response = format!(
            "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{}/video.mp4\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            target_addr.port()
        );
        let (redirect_addr, redirect_thread) = spawn_one_response_server(&redirect_response, || {});
        let url = format!("http://example.com:{}/video.mp4", redirect_addr.port());
        let parsed = reqwest::Url::parse(&url).unwrap();
        let client = video_download_client_builder(&parsed, &[redirect_addr])
            .unwrap()
            .build()
            .unwrap();

        let response = client.get(parsed).send().await.unwrap();

        assert_eq!(response.status(), reqwest::StatusCode::FOUND);
        redirect_thread.join().unwrap();
        assert!(!target_hit.load(Ordering::SeqCst));
        target_thread.join().unwrap();
    }

    fn spawn_one_response_server(
        response: &str,
        on_request: impl FnOnce() + Send + 'static,
    ) -> (SocketAddr, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let addr = listener.local_addr().unwrap();
        let response = response.to_string();
        let handle = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(2);
            let (mut stream, _) = loop {
                match listener.accept() {
                    Ok(accepted) => break accepted,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        if Instant::now() >= deadline {
                            return;
                        }
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    Err(error) => panic!("test server accept failed: {error}"),
                }
            };
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0_u8; 1024];
            while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                let read = stream.read(&mut buffer).unwrap();
                assert!(
                    read > 0,
                    "test client closed before sending request headers"
                );
                request.extend_from_slice(&buffer[..read]);
            }
            on_request();
            stream.write_all(response.as_bytes()).unwrap();
            stream.flush().unwrap();
        });
        (addr, handle)
    }
}
