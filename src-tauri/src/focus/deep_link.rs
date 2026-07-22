use super::repository::{
    MAX_BREAK_MINUTES, MAX_FOCUS_INTENTION_CHARS, MAX_FOCUS_INTERVALS, MAX_FOCUS_MINUTES,
};
use super::types::StartFocusRequest;

const MAX_PROJECT_ID_CHARS: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FocusDeepLinkAction {
    Open,
    Start(StartFocusRequest),
    Pause,
    Resume,
    StartBreak,
    Finish,
    Abandon,
}

pub fn parse_focus_deep_link(value: &str) -> Option<FocusDeepLinkAction> {
    let url = reqwest::Url::parse(value).ok()?;
    if url.scheme() != "osjune" || url.host_str() != Some("focus") {
        return None;
    }
    let path = url.path();
    if path != "/start" && url.query().is_some() {
        return None;
    }
    match path {
        "" | "/" | "/open" => Some(FocusDeepLinkAction::Open),
        "/pause" => Some(FocusDeepLinkAction::Pause),
        "/resume" => Some(FocusDeepLinkAction::Resume),
        "/break" => Some(FocusDeepLinkAction::StartBreak),
        "/finish" => Some(FocusDeepLinkAction::Finish),
        "/abandon" => Some(FocusDeepLinkAction::Abandon),
        "/start" => parse_start(&url),
        _ => None,
    }
}

fn parse_start(url: &reqwest::Url) -> Option<FocusDeepLinkAction> {
    let mut intention = None;
    let mut project_id = None;
    let mut duration_minutes = None;
    let mut interval_count = None;
    let mut break_duration_minutes = None;
    let mut long_break_duration_minutes = None;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "intention" if intention.is_none() => {
                let value = value.into_owned();
                if value.chars().count() > MAX_FOCUS_INTENTION_CHARS {
                    return None;
                }
                intention = Some(value);
            }
            "project_id" if project_id.is_none() => {
                let value = value.into_owned();
                if value.is_empty() || value.chars().count() > MAX_PROJECT_ID_CHARS {
                    return None;
                }
                project_id = Some(value);
            }
            "minutes" if duration_minutes.is_none() => {
                duration_minutes = Some(parse_bounded(&value, MAX_FOCUS_MINUTES)?)
            }
            "intervals" if interval_count.is_none() => {
                interval_count = Some(parse_bounded(&value, MAX_FOCUS_INTERVALS)?)
            }
            "break_minutes" if break_duration_minutes.is_none() => {
                break_duration_minutes = Some(parse_bounded(&value, MAX_BREAK_MINUTES)?)
            }
            "long_break_minutes" if long_break_duration_minutes.is_none() => {
                long_break_duration_minutes = Some(parse_bounded(&value, MAX_BREAK_MINUTES)?)
            }
            _ => return None,
        }
    }
    Some(FocusDeepLinkAction::Start(StartFocusRequest {
        intention,
        project_id,
        duration_minutes,
        interval_count,
        break_duration_minutes,
        long_break_duration_minutes,
        ..StartFocusRequest::default()
    }))
}

fn parse_bounded(value: &str, maximum: u32) -> Option<u32> {
    let value = value.parse::<u32>().ok()?;
    (1..=maximum).contains(&value).then_some(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_bounded_start_fields() {
        let action = parse_focus_deep_link(
            "osjune://focus/start?minutes=45&intention=Ship%20it&project_id=project-1",
        )
        .expect("valid focus link");
        let FocusDeepLinkAction::Start(request) = action else {
            panic!("expected start action");
        };
        assert_eq!(request.duration_minutes, Some(45));
        assert_eq!(request.intention.as_deref(), Some("Ship it"));
        assert_eq!(request.project_id.as_deref(), Some("project-1"));
    }

    #[test]
    fn parses_interval_shortcut_fields() {
        let action = parse_focus_deep_link(
            "osjune://focus/start?minutes=25&intervals=4&break_minutes=5&long_break_minutes=15",
        )
        .expect("valid interval focus link");
        let FocusDeepLinkAction::Start(request) = action else {
            panic!("expected start action");
        };
        assert_eq!(request.interval_count, Some(4));
        assert_eq!(request.break_duration_minutes, Some(5));
        assert_eq!(request.long_break_duration_minutes, Some(15));
    }

    #[test]
    fn rejects_prefix_paths_unknown_fields_and_duplicate_fields() {
        for value in [
            "osjune://focus/start-extra?minutes=25",
            "osjune://focus/start?minutes=25&unexpected=true",
            "osjune://focus/start?minutes=25&minutes=30",
            "osjune://focus/start?minutes=0",
            "osjune://focus/start?minutes=721",
            "osjune://focus/start?intervals=13",
            "osjune://focus/start?break_minutes=121",
            "osjune://focus/start?project_id=",
            "osjune://focus/pause?session_id=surprise",
            "osjune://auth/callback?code=value",
        ] {
            assert_eq!(parse_focus_deep_link(value), None, "{value}");
        }
    }
}
