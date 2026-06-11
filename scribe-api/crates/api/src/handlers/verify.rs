use axum::{extract::State, response::Html};

use crate::state::{ApiState, AttestationInfo};

/// Human-facing attestation walkthrough. Served from inside the TEE so the
/// page itself is covered by the same attestation it explains. Public and
/// unauthenticated like the health probes, and deliberately HTML rather than
/// the `ApiResponse` envelope — the audience is a person, not a client.
pub(crate) async fn verify(State(state): State<ApiState>) -> Html<String> {
    Html(render_page(state.attestation()))
}

/// First seven characters of the commit, only when it looks like a real git
/// sha. Anything else (empty, placeholder text) renders as "not stamped".
fn short_commit(commit: &str) -> Option<&str> {
    let trimmed = commit.trim();
    let looks_like_sha = trimmed.len() >= 7 && trimmed.chars().all(|c| c.is_ascii_hexdigit());
    looks_like_sha.then(|| &trimmed[..7])
}

fn escape_html(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#39;"),
            other => escaped.push(other),
        }
    }
    escaped
}

fn render_page(info: &AttestationInfo) -> String {
    let repo_url = escape_html(&info.source_repo_url);
    let image_repo = escape_html(&info.image_repo);
    let trust_center_url = escape_html(&info.trust_center_url);

    let (commit_value, short_sha) = match short_commit(&info.source_commit) {
        Some(short) => {
            let full = escape_html(info.source_commit.trim());
            let short = escape_html(short);
            (
                format!(
                    "<a href=\"{repo_url}/commit/{full}\"><code>{short}</code></a> \
                     <span class=\"muted\"><code>{full}</code></span>"
                ),
                short,
            )
        }
        None => (
            "<em>not stamped (local or development build)</em>".to_string(),
            "&lt;short-sha&gt;".to_string(),
        ),
    };

    PAGE_TEMPLATE
        .replace("@SERVICE@", env!("CARGO_PKG_NAME"))
        .replace("@VERSION@", env!("CARGO_PKG_VERSION"))
        .replace("@COMMIT_VALUE@", &commit_value)
        .replace("@SHORT_SHA@", &short_sha)
        .replace("@REPO_URL@", &repo_url)
        .replace("@IMAGE_REPO@", &image_repo)
        .replace("@TRUST_CENTER_URL@", &trust_center_url)
}

const PAGE_TEMPLATE: &str = r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Verify this server · @SERVICE@</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #fdfdfc;
    --fg: #1c1b18;
    --muted: #6f6c64;
    --border: #e6e4de;
    --surface: #f4f3ef;
    --accent: #1f6f4a;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #161513;
      --fg: #e9e7e1;
      --muted: #9b988f;
      --border: #2c2a26;
      --surface: #201f1c;
      --accent: #6fbf95;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0 auto;
    padding: 3.5rem 1.25rem 5rem;
    max-width: 42rem;
    background: var(--bg);
    color: var(--fg);
    font: 16px/1.65 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  h1, h2 {
    font-family: ui-serif, Georgia, "Times New Roman", serif;
    font-weight: 400;
    line-height: 1.2;
  }
  h1 { font-size: 2.1rem; margin: 0 0 0.5rem; }
  h2 { font-size: 1.35rem; margin: 2.75rem 0 0.75rem; }
  p { margin: 0.75rem 0; }
  a { color: var(--accent); }
  .lede { color: var(--muted); margin: 0 0 2rem; }
  .muted { color: var(--muted); }
  code {
    font: 0.875em ui-monospace, SFMono-Regular, Menlo, monospace;
    background: var(--surface);
    border-radius: 4px;
    padding: 0.1em 0.35em;
    overflow-wrap: anywhere;
  }
  pre {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.85rem 1rem;
    overflow-x: auto;
  }
  pre code { background: none; padding: 0; }
  dl.facts {
    margin: 0;
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
  }
  dl.facts > div {
    display: grid;
    grid-template-columns: 9.5rem 1fr;
    gap: 1rem;
    padding: 0.7rem 1rem;
  }
  dl.facts > div + div { border-top: 1px solid var(--border); }
  dl.facts dt { margin: 0; color: var(--muted); }
  dl.facts dd { margin: 0; overflow-wrap: anywhere; }
  ol.steps { padding-left: 1.25rem; }
  ol.steps > li { margin: 1.1rem 0; }
  ol.steps > li::marker { color: var(--muted); }
  .badge {
    display: inline-block;
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 0.1rem 0.7rem;
    font-size: 0.8rem;
    color: var(--muted);
    margin-bottom: 1.25rem;
  }
  footer {
    margin-top: 3.5rem;
    padding-top: 1.25rem;
    border-top: 1px solid var(--border);
    color: var(--muted);
    font-size: 0.875rem;
  }
</style>
</head>
<body>
<header>
  <span class="badge">Intel TDX · Phala Cloud</span>
  <h1>Verify this server</h1>
  <p class="lede">@SERVICE@ runs inside an Intel TDX confidential VM. This page is
  served from inside that VM and explains how to check, without trusting us,
  that the code running here is exactly the public source code.</p>
</header>

<h2>This deployment</h2>
<dl class="facts">
  <div><dt>Service</dt><dd><code>@SERVICE@</code> v@VERSION@</dd></div>
  <div><dt>Source commit</dt><dd>@COMMIT_VALUE@</dd></div>
  <div><dt>Source code</dt><dd><a href="@REPO_URL@">@REPO_URL@</a></dd></div>
  <div><dt>Image</dt><dd><code>@IMAGE_REPO@:@SHORT_SHA@</code></dd></div>
  <div><dt>Attestation</dt><dd><a href="@TRUST_CENTER_URL@">Phala Trust Center report</a></dd></div>
</dl>

<h2>Why this matters</h2>
<p>Audio, transcripts, and notes pass through this server. Because the running
image is remotely attested, neither Phala (the platform) nor Open Software (us)
can quietly swap it for one that reads your data. Any change to the running
code is visible in the chain below.</p>
<p>The chain has three links: <strong>source</strong> (a public git commit),
<strong>image</strong> (a container image our CI builds from that commit, published
with a content digest), and <strong>attestation</strong> (third-party-verifiable
proof that the image with that digest is what is actually executing inside a
genuine Intel TDX VM).</p>

<h2>Check it yourself</h2>
<ol class="steps">
  <li>
    <p>Open the <a href="@TRUST_CENTER_URL@">Trust Center report</a>. Confirm the
    attestation verifies, then find the image reference pinned in the attested
    compose file. It should be:</p>
    <pre><code>@IMAGE_REPO@:@SHORT_SHA@</code></pre>
  </li>
  <li>
    <p>Resolve that tag to its content digest in the public registry:</p>
    <pre><code>docker buildx imagetools inspect @IMAGE_REPO@:@SHORT_SHA@ \
  --format '{{.Manifest.Digest}}'</code></pre>
  </li>
  <li>
    <p>Compare against the digest our CI recorded in the repository at deploy
    time, as an immutable <code>deploy/&lt;env&gt;/&lt;sha&gt;</code> git tag:</p>
    <pre><code>git clone @REPO_URL@ &amp;&amp; cd os-scribe
git tag -l 'deploy/*/@SHORT_SHA@' -n3</code></pre>
    <p>The tag message states which image digest commit <code>@SHORT_SHA@</code>
    deployed. It must match the digest from step 2.</p>
  </li>
  <li>
    <p>Read the source at that commit. The commit linked above is the exact tree
    the image was built from. The build stamps it into the image itself.</p>
  </li>
</ol>
<p class="muted">This proves the running digest is the one our public CI built
and recorded for that commit. Bit-for-bit reproducible rebuilds (regenerating
the digest yourself instead of trusting our CI) are in progress; see
<a href="@REPO_URL@/blob/main/docs/reproducible-builds.md">docs/reproducible-builds.md</a>.</p>

<h2>What this does not cover</h2>
<p>The chain verifies the <strong>code</strong> running in the confidential VM,
not what upstream providers do. Everything leaving the TEE for model inference
(audio for transcription, prompts and context for note generation and the
agent) goes through Venice. By default it runs on Venice private models: zero
data retention, no training. If you select an anonymized model not run by
Venice, the request is still routed and anonymized by Venice, but the
underlying model provider may retain data under its own privacy policy.
End-to-end private inference is a separate workstream.</p>

<footer>
  <p>Open Software · <a href="@REPO_URL@">source</a> · <a href="@TRUST_CENTER_URL@">attestation</a></p>
</footer>
</body>
</html>
"#;

#[cfg(test)]
mod tests {
    use super::{AttestationInfo, escape_html, render_page, short_commit};
    use pretty_assertions::assert_eq;

    fn info() -> AttestationInfo {
        AttestationInfo {
            source_commit: "0123abc4567890def0123abc4567890def012345".to_string(),
            source_repo_url: "https://github.com/open-software-network/os-scribe".to_string(),
            image_repo: "ghcr.io/open-software-network/scribe-api".to_string(),
            trust_center_url: "https://trust.phala.com/app/15f8d2fd".to_string(),
        }
    }

    #[test]
    fn short_commit_accepts_full_sha() {
        assert_eq!(
            short_commit("0123abc4567890def0123abc4567890def012345"),
            Some("0123abc")
        );
    }

    #[test]
    fn short_commit_rejects_non_sha_values() {
        assert_eq!(short_commit(""), None);
        assert_eq!(short_commit("unknown"), None);
        assert_eq!(short_commit("abc"), None);
    }

    #[test]
    fn escape_html_neutralizes_markup() {
        assert_eq!(
            escape_html("<script>\"&'"),
            "&lt;script&gt;&quot;&amp;&#39;"
        );
    }

    #[test]
    fn render_links_commit_and_attestation() {
        let html = render_page(&info());
        assert!(html.contains(
            "https://github.com/open-software-network/os-scribe/commit/0123abc4567890def0123abc4567890def012345"
        ));
        assert!(html.contains("ghcr.io/open-software-network/scribe-api:0123abc"));
        assert!(html.contains("https://trust.phala.com/app/15f8d2fd"));
        assert!(!html.contains("@SHORT_SHA@"));
    }

    #[test]
    fn render_without_commit_says_not_stamped() {
        let mut info = info();
        info.source_commit = String::new();
        let html = render_page(&info);
        assert!(html.contains("not stamped"));
        assert!(html.contains("&lt;short-sha&gt;"));
    }

    #[test]
    fn render_escapes_configured_values() {
        let mut info = info();
        info.image_repo = "ghcr.io/<evil>".to_string();
        let html = render_page(&info);
        assert!(!html.contains("ghcr.io/<evil>"));
        assert!(html.contains("ghcr.io/&lt;evil&gt;"));
    }
}
