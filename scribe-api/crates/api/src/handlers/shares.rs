use crate::{auth::authenticated_user, envelope::ApiResponse, error::ApiError, state::ApiState};
use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::Html,
};
use pulldown_cmark::{Event, Options, Parser, html};
use scribe_domain::{RevokeOutcome, ShareId, SharedNote};
use serde::{Deserialize, Serialize};

const JUNE_DOWNLOAD_URL: &str = "https://github.com/open-software-network/os-june-releases/releases/latest/download/June_aarch64.dmg";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateShareRequest {
    pub title: String,
    pub content: String,
    #[serde(default)]
    pub shared_by: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareResponse {
    pub id: String,
    pub url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevokeShareResponse {
    pub revoked: bool,
}

/// Publishes a note the user explicitly chose to share. The body is the only
/// user content this service ever stores; the bearer token names the owner.
pub(crate) async fn create(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(request): Json<CreateShareRequest>,
) -> Result<Json<ApiResponse<ShareResponse>>, ApiError> {
    let user_id = authenticated_user(&state, &headers).await?;
    let created = state
        .note_shares()
        .create(scribe_services::CreateShareParams {
            user_id,
            title: request.title,
            body_markdown: request.content,
            shared_by: request.shared_by,
            created_at: chrono::Utc::now().to_rfc3339(),
        })
        .await
        .map_err(ApiError::from)?;
    Ok(Json(ApiResponse::ok(ShareResponse {
        id: created.id.0,
        url: created.url,
    })))
}

pub(crate) async fn revoke(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(share_id): Path<String>,
) -> Result<Json<ApiResponse<RevokeShareResponse>>, ApiError> {
    let user_id = authenticated_user(&state, &headers).await?;
    let outcome = state
        .note_shares()
        .revoke(&ShareId(share_id), &user_id)
        .await
        .map_err(ApiError::from)?;
    match outcome {
        RevokeOutcome::Revoked => Ok(Json(ApiResponse::ok(RevokeShareResponse { revoked: true }))),
        RevokeOutcome::NotFound => Err(ApiError::not_found("share_not_found")),
    }
}

/// Public, no-account view of a shared note. HTML for humans, like /verify;
/// served from inside the TEE so the page is covered by the same attestation.
pub(crate) async fn view(
    State(state): State<ApiState>,
    Path(share_id): Path<String>,
) -> (StatusCode, Html<String>) {
    let share = match state.note_shares().get(&ShareId(share_id)).await {
        Ok(Some(share)) => share,
        Ok(None) => return (StatusCode::NOT_FOUND, Html(render_gone_page())),
        Err(error) => {
            tracing::error!(%error, "shared note lookup failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, Html(render_gone_page()));
        }
    };
    (StatusCode::OK, Html(render_share_page(&share)))
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

/// Markdown to HTML with raw HTML neutralized: pulldown-cmark passes
/// embedded HTML through verbatim, so every HTML event is re-emitted as
/// escaped text. A shared note must never be able to script its viewer.
fn render_markdown(markdown: &str) -> String {
    let parser = Parser::new_ext(
        markdown,
        Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH,
    )
    .map(|event| match event {
        Event::Html(raw) | Event::InlineHtml(raw) => Event::Text(raw),
        other => other,
    });
    let mut out = String::with_capacity(markdown.len() * 2);
    html::push_html(&mut out, parser);
    out
}

fn shared_date(created_at: &str) -> String {
    created_at
        .split('T')
        .next()
        .unwrap_or(created_at)
        .to_string()
}

fn render_share_page(share: &SharedNote) -> String {
    let title = if share.title.trim().is_empty() {
        "Shared note".to_string()
    } else {
        escape_html(share.title.trim())
    };
    let shared_by = escape_html(share.shared_by.trim());
    let byline = if shared_by.is_empty() {
        format!("Shared on {}", escape_html(&shared_date(&share.created_at)))
    } else {
        format!(
            "Shared by {} on {}",
            shared_by,
            escape_html(&shared_date(&share.created_at))
        )
    };
    let body = render_markdown(&share.body_markdown);
    let footer_attribution = if shared_by.is_empty() {
        "Notes by June.".to_string()
    } else {
        format!("Notes by June, shared by {shared_by}.")
    };
    SHARE_PAGE_TEMPLATE
        .replace("@TITLE@", &title)
        .replace("@BYLINE@", &byline)
        .replace("@BODY@", &body)
        .replace("@FOOTER_ATTRIBUTION@", &footer_attribution)
        .replace("@DOWNLOAD_URL@", JUNE_DOWNLOAD_URL)
}

fn render_gone_page() -> String {
    SHARE_PAGE_TEMPLATE
        .replace("@TITLE@", "This note is no longer shared")
        .replace("@BYLINE@", "")
        .replace(
            "@BODY@",
            "<p>The person who shared this note has stopped sharing it.</p>",
        )
        .replace("@FOOTER_ATTRIBUTION@", "Notes by June.")
        .replace("@DOWNLOAD_URL@", JUNE_DOWNLOAD_URL)
}

// Styling notes: system fonts, light/dark via color-scheme, content width for
// reading. The footer is the growth loop: attribution plus the line Granola
// cannot say, with the download CTA.
const SHARE_PAGE_TEMPLATE: &str = r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>@TITLE@</title>
<style>
  :root { color-scheme: light dark; --fg: #1c1b18; --bg: #fdfdfc; --muted: #6f6c64; --line: #e7e5e0; --accent: #b4540a; }
  @media (prefers-color-scheme: dark) { :root { --fg: #ece9e2; --bg: #161513; --muted: #97938a; --line: #2c2a26; --accent: #e8853d; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 17px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  main { max-width: 44rem; margin: 0 auto; padding: 3rem 1.25rem 2rem; }
  h1.share-title { font-size: 1.9rem; line-height: 1.25; margin: 0 0 0.4rem; }
  p.byline { color: var(--muted); margin: 0 0 2.2rem; font-size: 0.95rem; }
  article h1, article h2, article h3 { line-height: 1.3; }
  article pre { overflow-x: auto; background: color-mix(in srgb, var(--fg) 6%, transparent); padding: 0.8rem 1rem; border-radius: 8px; }
  article code { font-size: 0.92em; }
  article blockquote { margin: 0; padding-left: 1rem; border-left: 3px solid var(--line); color: var(--muted); }
  article table { border-collapse: collapse; } article td, article th { border: 1px solid var(--line); padding: 0.3rem 0.6rem; }
  footer { max-width: 44rem; margin: 0 auto; padding: 1.5rem 1.25rem 3rem; border-top: 1px solid var(--line); }
  footer p { margin: 0 0 0.6rem; color: var(--muted); font-size: 0.95rem; }
  footer .privacy { color: var(--fg); }
  footer a.cta { display: inline-block; margin-top: 0.4rem; color: var(--accent); font-weight: 600; text-decoration: none; }
  footer a.cta:hover { text-decoration: underline; }
</style>
</head>
<body>
<main>
  <h1 class="share-title">@TITLE@</h1>
  <p class="byline">@BYLINE@</p>
  <article>@BODY@</article>
</main>
<footer>
  <p class="privacy">@FOOTER_ATTRIBUTION@ Not by a bot in the call: June never saw this meeting's audio leave the Mac it ran on.</p>
  <p>June takes your meeting notes, dictates anywhere, and hands real work to a private agent on your Mac.</p>
  <a class="cta" href="@DOWNLOAD_URL@">Get June for your Mac</a>
</footer>
</body>
</html>
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use scribe_domain::UserId;

    fn share(body: &str) -> SharedNote {
        SharedNote {
            id: ShareId("abc".to_string()),
            user_id: UserId("usr_a".to_string()),
            title: "Weekly sync".to_string(),
            body_markdown: body.to_string(),
            shared_by: "Gaut".to_string(),
            created_at: "2026-06-11T17:00:00Z".to_string(),
        }
    }

    #[test]
    fn renders_markdown_and_footer() {
        let page = render_share_page(&share("# Decisions\n\nShip it."));
        assert!(page.contains("<h1>Decisions</h1>"));
        assert!(page.contains("Notes by June, shared by Gaut."));
        assert!(page.contains("never saw this meeting's audio leave the Mac"));
        assert!(page.contains("Get June for your Mac"));
        assert!(page.contains("Shared by Gaut on 2026-06-11"));
    }

    #[test]
    fn neutralizes_embedded_html_and_escapes_metadata() {
        let mut sneaky = share("hello <script>alert(1)</script> world");
        sneaky.title = "<img src=x onerror=alert(1)>".to_string();
        sneaky.shared_by = "<b>Eve</b>".to_string();
        let page = render_share_page(&sneaky);
        assert!(!page.contains("<script>"));
        assert!(!page.contains("<img src=x"));
        assert!(!page.contains("<b>Eve</b>"));
        assert!(page.contains("&lt;script&gt;"));
    }
}
