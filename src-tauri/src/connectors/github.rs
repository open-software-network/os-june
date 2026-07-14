use crate::domain::types::AppError;

const GITHUB_APP_CLIENT_ID_ENV: &str = "GITHUB_APP_CLIENT_ID";
const GITHUB_APP_SLUG_ENV: &str = "GITHUB_APP_SLUG";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GitHubAppConfig {
    pub client_id: String,
    pub slug: String,
}

impl GitHubAppConfig {
    pub fn installation_url(&self) -> String {
        format!("https://github.com/apps/{}/installations/new", self.slug)
    }
}

fn config_from_values(client_id: String, slug: String) -> Result<GitHubAppConfig, AppError> {
    let client_id = client_id.trim();
    let slug = slug.trim();
    let valid_client_id = (8..=128).contains(&client_id.len())
        && client_id.bytes().all(|byte| byte.is_ascii_alphanumeric());
    let valid_slug = (1..=100).contains(&slug.len())
        && slug
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        && !slug.starts_with('-')
        && !slug.ends_with('-');
    if !valid_client_id || !valid_slug {
        return Err(AppError::new(
            "github_not_configured",
            "GitHub is not configured for this build.",
        ));
    }
    Ok(GitHubAppConfig {
        client_id: client_id.to_owned(),
        slug: slug.to_owned(),
    })
}

pub fn github_app_config() -> Result<GitHubAppConfig, AppError> {
    crate::os_accounts::load_local_env();
    config_from_values(
        super::env_or_build_trimmed(
            GITHUB_APP_CLIENT_ID_ENV,
            option_env!("GITHUB_APP_CLIENT_ID"),
        ),
        super::env_or_build_trimmed(GITHUB_APP_SLUG_ENV, option_env!("GITHUB_APP_SLUG")),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_requires_both_public_identifiers() {
        assert_eq!(
            config_from_values("".into(), "june-staging".into())
                .unwrap_err()
                .code,
            "github_not_configured"
        );
        assert_eq!(
            config_from_values("Iv23example".into(), "".into())
                .unwrap_err()
                .code,
            "github_not_configured"
        );
    }

    #[test]
    fn config_builds_installation_url_from_slug() {
        let config =
            config_from_values("Iv23lihKGi1yIb8QZm9L".into(), "june-staging".into()).unwrap();
        assert_eq!(
            config.installation_url(),
            "https://github.com/apps/june-staging/installations/new"
        );
    }

    #[test]
    fn config_rejects_values_that_can_change_the_github_origin_or_path() {
        assert!(config_from_values("bad client".into(), "june-staging".into()).is_err());
        assert!(config_from_values("Iv23example".into(), "../login".into()).is_err());
        assert!(config_from_values("Iv23example".into(), "-june".into()).is_err());
    }
}
