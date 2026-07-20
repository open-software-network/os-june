use std::collections::HashSet;

use crate::domain::types::AppError;

const MAX_REPOSITORY_PATH_BYTES: usize = 1_024;
const MAX_GIT_REF_BYTES: usize = 255;
const MAX_SEARCH_LITERAL_BYTES: usize = 256;
const MAX_LABEL_BYTES: usize = 50;
const MAX_LABELS: usize = 20;
const REDACTED: &str = "[REDACTED]";

#[derive(Clone, Debug, PartialEq, Eq)]
#[allow(dead_code)] // The endpoint modules in later plan tasks consume this staged contract.
pub(crate) struct GuardedText {
    pub text: String,
    pub truncated: bool,
    pub redactions_applied: bool,
}

#[allow(dead_code)] // The endpoint modules in later plan tasks consume this staged contract.
pub(crate) fn validate_repository_path(path: &str, allow_root: bool) -> Result<String, AppError> {
    if path.is_empty() {
        return if allow_root {
            Ok(String::new())
        } else {
            Err(github_input_invalid())
        };
    }
    if path.len() > MAX_REPOSITORY_PATH_BYTES
        || path.starts_with('/')
        || path.contains('\\')
        || path.chars().any(char::is_control)
        || path
            .split('/')
            .any(|segment| segment.is_empty() || matches!(segment, "." | ".."))
    {
        return Err(github_input_invalid());
    }
    Ok(path.to_owned())
}

#[allow(dead_code)] // The endpoint modules in later plan tasks consume this staged contract.
pub(crate) fn validate_git_ref(value: Option<&str>) -> Result<Option<String>, AppError> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.is_empty()
        || value.len() > MAX_GIT_REF_BYTES
        || value == "@"
        || value.starts_with('/')
        || value.ends_with('/')
        || value.ends_with('.')
        || value.contains("//")
        || value.contains("..")
        || value.contains("@{")
        || value
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
        || value.bytes().any(|byte| {
            matches!(
                byte,
                b'\\' | b'~' | b'^' | b':' | b'?' | b'*' | b'[' | b'"' | b'\''
            )
        })
        || value.split('/').any(|segment| {
            segment.is_empty()
                || matches!(segment, "." | "..")
                || segment.starts_with('.')
                || segment.ends_with(".lock")
        })
    {
        return Err(github_input_invalid());
    }
    Ok(Some(value.to_owned()))
}

#[allow(dead_code)] // The endpoint modules in later plan tasks consume this staged contract.
pub(crate) fn validate_search_literal(value: &str) -> Result<String, AppError> {
    if value.is_empty()
        || value.len() > MAX_SEARCH_LITERAL_BYTES
        || value.trim() != value
        || value
            .chars()
            .any(|character| character.is_control() || matches!(character, ':' | '\\' | '"' | '\''))
    {
        return Err(github_input_invalid());
    }
    Ok(value.to_owned())
}

#[allow(dead_code)] // The endpoint modules in later plan tasks consume this staged contract.
pub(crate) fn validate_labels(values: &[String]) -> Result<Vec<String>, AppError> {
    if values.len() > MAX_LABELS {
        return Err(github_input_invalid());
    }

    let mut seen = HashSet::with_capacity(values.len());
    let mut validated = Vec::with_capacity(values.len());
    for value in values {
        if value.is_empty()
            || value.len() > MAX_LABEL_BYTES
            || value.trim() != value
            || value.contains(',')
            || value.chars().any(char::is_control)
        {
            return Err(github_input_invalid());
        }
        if seen.insert(value.to_lowercase()) {
            validated.push(value.clone());
        }
    }
    Ok(validated)
}

#[allow(dead_code)] // The endpoint modules in later plan tasks consume this staged contract.
pub(crate) fn sensitive_path_blocked(path: &str) -> bool {
    let Some(file_name) = path.rsplit('/').next() else {
        return false;
    };
    let file_name = file_name.to_ascii_lowercase();
    if file_name == ".env" || file_name.starts_with(".env.") {
        return true;
    }
    if matches!(
        file_name.as_str(),
        "id_rsa" | "id_ed25519" | ".netrc" | ".git-credentials" | ".npmrc" | ".pypirc" | ".pgpass"
    ) {
        return true;
    }
    if [".pem", ".key", ".p12", ".pfx"]
        .iter()
        .any(|extension| file_name.ends_with(extension))
    {
        return true;
    }
    let Some(stem) = file_name.strip_suffix(".json") else {
        return false;
    };
    stem.split(['-', '_', '.'])
        .any(|part| matches!(part, "credential" | "credentials" | "secret" | "secrets"))
}

#[allow(dead_code)] // The endpoint modules in later plan tasks consume this staged contract.
pub(crate) fn normalize_untrusted_text(
    bytes: &[u8],
    max_bytes: usize,
    max_lines: usize,
) -> Result<GuardedText, AppError> {
    if max_bytes == 0 || max_lines == 0 {
        return Err(github_response_too_large());
    }
    let text = std::str::from_utf8(bytes).map_err(|_| github_binary_content())?;
    if text.contains('\0') || control_heavy(text) {
        return Err(github_binary_content());
    }

    let (redacted, redactions_applied) = redact_untrusted_text(text);
    let (line_end, line_truncated) = line_bounded_end(&redacted, max_lines);
    let line_bounded = &redacted[..line_end];
    let byte_end = utf8_bounded_end(line_bounded, max_bytes);

    Ok(GuardedText {
        text: line_bounded[..byte_end].to_owned(),
        truncated: line_truncated || byte_end < line_bounded.len(),
        redactions_applied,
    })
}

fn github_input_invalid() -> AppError {
    AppError::new("github_input_invalid", "GitHub input is invalid.")
}

fn github_binary_content() -> AppError {
    AppError::new(
        "github_binary_content",
        "GitHub content is not supported text.",
    )
}

fn github_response_too_large() -> AppError {
    AppError::new(
        "github_response_too_large",
        "GitHub content exceeds the response limit.",
    )
}

fn control_heavy(text: &str) -> bool {
    let mut total = 0_usize;
    let mut suspicious = 0_usize;
    for character in text.chars() {
        total += 1;
        if character.is_control() && !matches!(character, '\n' | '\r' | '\t') {
            suspicious += 1;
        }
    }
    suspicious > 0 && suspicious.saturating_mul(8) > total.max(1)
}

#[derive(Clone, Copy)]
struct PythonClassContext {
    header_indent: usize,
    body_indent: Option<usize>,
    triple_quote: Option<u8>,
}

struct BraceDeclarationCandidate {
    field_depth: usize,
    eligible_lines: Vec<usize>,
    valid: bool,
}

#[derive(Default)]
struct BraceEligibilityScanner {
    brace_depth: usize,
    block_comment_depth: usize,
    candidate: Option<BraceDeclarationCandidate>,
    pending_header: bool,
}

impl BraceEligibilityScanner {
    fn observe_line(&mut self, line: &str, line_index: usize, eligible: &mut [bool]) {
        if private_key_boundary(line, "BEGIN") || private_key_boundary(line, "END") {
            if let Some(candidate) = self.candidate.as_mut() {
                candidate.valid = false;
            }
            self.pending_header = false;
            self.block_comment_depth = 0;
            return;
        }

        let mut expected_opening = None;
        let mut keep_pending = false;
        if self.candidate.is_none() && self.pending_header {
            let trimmed = line.trim_start();
            if trimmed.is_empty() || trimmed.starts_with("//") {
                keep_pending = true;
            } else {
                expected_opening = explicit_opening_brace(line);
                self.pending_header = false;
            }
        }
        if self.candidate.is_none() && expected_opening.is_none() && !keep_pending {
            expected_opening = declaration_opening_brace(line);
            if expected_opening.is_none() && declaration_header_waits_for_brace(line) {
                self.pending_header = true;
            }
        }

        if self.block_comment_depth == 0 {
            if let Some(candidate) = self.candidate.as_mut() {
                if self.brace_depth == candidate.field_depth {
                    candidate.eligible_lines.push(line_index);
                }
            }
        }

        let bytes = line.as_bytes();
        let mut cursor = 0_usize;
        while cursor < bytes.len() {
            if self.block_comment_depth > 0 {
                if bytes[cursor..].starts_with(b"/*") {
                    self.block_comment_depth += 1;
                    cursor += 2;
                } else if bytes[cursor..].starts_with(b"*/") {
                    self.block_comment_depth -= 1;
                    cursor += 2;
                } else {
                    cursor += 1;
                }
                continue;
            }
            if bytes[cursor..].starts_with(b"//") {
                break;
            }
            if bytes[cursor..].starts_with(b"/*") {
                self.block_comment_depth += 1;
                cursor += 2;
                continue;
            }
            if rust_raw_string_start(bytes, cursor)
                || matches!(bytes[cursor], b'`' | b'%')
                || bytes[cursor] == b'/'
            {
                self.invalidate_candidate();
                self.pending_header = false;
                break;
            }
            if bytes[cursor] == b'\'' && apostrophe_starts_lifetime(bytes, cursor) {
                cursor += 1;
                continue;
            }
            if matches!(bytes[cursor], b'\'' | b'"') {
                let Some(end) = quoted_string_end(bytes, cursor, bytes[cursor]) else {
                    self.invalidate_candidate();
                    self.pending_header = false;
                    break;
                };
                cursor = end;
                continue;
            }

            match bytes[cursor] {
                b'{' => {
                    self.brace_depth += 1;
                    if Some(cursor) == expected_opening && self.candidate.is_none() {
                        self.candidate = Some(BraceDeclarationCandidate {
                            field_depth: self.brace_depth,
                            eligible_lines: Vec::new(),
                            valid: true,
                        });
                        self.pending_header = false;
                    }
                }
                b'}' => {
                    self.brace_depth = self.brace_depth.saturating_sub(1);
                    let closes_candidate = self
                        .candidate
                        .as_ref()
                        .is_some_and(|candidate| self.brace_depth < candidate.field_depth);
                    if closes_candidate {
                        let candidate = self.candidate.take().expect("candidate exists");
                        if candidate.valid {
                            for candidate_line in candidate.eligible_lines {
                                eligible[candidate_line] = true;
                            }
                        }
                    }
                }
                _ => {}
            }
            cursor += 1;
        }
    }

    fn invalidate_candidate(&mut self) {
        if let Some(candidate) = self.candidate.as_mut() {
            candidate.valid = false;
        }
    }
}

fn typed_field_eligible_lines(text: &str) -> Vec<bool> {
    let lines: Vec<&str> = text
        .split_inclusive('\n')
        .map(|line| split_line_ending(line).0)
        .collect();
    let mut eligible = vec![false; lines.len()];
    let mut brace_scanner = BraceEligibilityScanner::default();
    let mut python_class: Option<PythonClassContext> = None;

    for (line_index, line) in lines.iter().copied().enumerate() {
        if private_key_boundary(line, "BEGIN") || private_key_boundary(line, "END") {
            python_class = None;
        } else {
            if let Some(mut context) = python_class.take() {
                if let Some(quote) = context.triple_quote {
                    if contains_unescaped_python_triple_delimiter(line, quote) {
                        context.triple_quote = None;
                    }
                    python_class = Some(context);
                } else {
                    let trimmed = line.trim();
                    if trimmed.is_empty() || trimmed.starts_with('#') {
                        python_class = Some(context);
                    } else {
                        let indentation = leading_indentation(line);
                        if indentation > context.header_indent {
                            let body_indent = *context.body_indent.get_or_insert(indentation);
                            if indentation == body_indent {
                                if let Some((quote, opening_end)) = python_triple_quote_start(line)
                                {
                                    let content = line.trim_start();
                                    if !contains_unescaped_python_triple_delimiter(
                                        &content[opening_end..],
                                        quote,
                                    ) {
                                        context.triple_quote = Some(quote);
                                    }
                                } else {
                                    eligible[line_index] = true;
                                }
                            }
                            python_class = Some(context);
                        }
                    }
                }
            }
            if let Some(header_indent) = python_class_header(line) {
                python_class = Some(PythonClassContext {
                    header_indent,
                    body_indent: None,
                    triple_quote: None,
                });
            }
        }
        brace_scanner.observe_line(line, line_index, &mut eligible);
    }

    eligible
}

fn leading_indentation(line: &str) -> usize {
    line.len() - line.trim_start_matches([' ', '\t']).len()
}

fn declaration_opening_brace(line: &str) -> Option<usize> {
    let opening = line.find('{')?;
    recognized_declaration_header(&line[..opening]).then_some(opening)
}

fn declaration_header_waits_for_brace(line: &str) -> bool {
    !line.contains('{') && recognized_declaration_header(line)
}

fn explicit_opening_brace(line: &str) -> Option<usize> {
    let opening = line.find(|character: char| !character.is_ascii_whitespace())?;
    if line.as_bytes()[opening] != b'{' {
        return None;
    }
    let remainder = line[opening + 1..].trim_start();
    (remainder.is_empty() || remainder.starts_with("//") || remainder.starts_with("/*"))
        .then_some(opening)
}

fn recognized_declaration_header(header: &str) -> bool {
    let mut header = header.trim();
    if header.is_empty()
        || header.starts_with("//")
        || header.starts_with('#')
        || header
            .bytes()
            .any(|byte| matches!(byte, b'"' | b'`' | b'/' | b'%' | b';'))
        || !header_has_valid_lifetimes(header)
    {
        return false;
    }

    loop {
        let previous = header;
        for modifier in ["export ", "default ", "declare ", "abstract ", "pub "] {
            if let Some(remainder) = header.strip_prefix(modifier) {
                header = remainder.trim_start();
                break;
            }
        }
        if let Some(visibility) = header.strip_prefix("pub(") {
            if let Some((_, remainder)) = visibility.split_once(')') {
                header = remainder.trim_start();
            }
        }
        if header == previous {
            break;
        }
    }

    for keyword in ["struct ", "enum ", "interface ", "class "] {
        if let Some(remainder) = header.strip_prefix(keyword) {
            let Some(after_name) = declaration_name_remainder(remainder) else {
                return false;
            };
            return after_name.is_empty()
                || after_name.starts_with('<')
                || after_name.starts_with('(')
                || after_name.starts_with("where ")
                || after_name.starts_with("extends ")
                || after_name.starts_with("implements ");
        }
    }
    let Some(remainder) = header.strip_prefix("type ") else {
        return false;
    };
    declaration_name_remainder(remainder).is_some_and(|after_name| {
        after_name.starts_with('=') || (after_name.starts_with('<') && after_name.contains('='))
    })
}

fn declaration_name_remainder(value: &str) -> Option<&str> {
    let bytes = value.as_bytes();
    if bytes
        .first()
        .map_or(true, |byte| !is_identifier_start(*byte))
    {
        return None;
    }
    let mut cursor = 1_usize;
    while cursor < bytes.len() && is_identifier_continue(bytes[cursor]) {
        cursor += 1;
    }
    Some(value[cursor..].trim_start())
}

fn quoted_string_end(bytes: &[u8], opening: usize, quote: u8) -> Option<usize> {
    let mut cursor = opening + 1;
    let mut escaped = false;
    while cursor < bytes.len() {
        if !escaped && bytes[cursor] == quote {
            return Some(cursor + 1);
        }
        escaped = !escaped && bytes[cursor] == b'\\';
        cursor += 1;
    }
    None
}

fn rust_raw_string_start(bytes: &[u8], cursor: usize) -> bool {
    if cursor > 0 && is_identifier_continue(bytes[cursor - 1]) {
        return false;
    }
    let mut marker = cursor;
    if bytes.get(marker) == Some(&b'b') && bytes.get(marker + 1) == Some(&b'r') {
        marker += 1;
    }
    if bytes.get(marker) != Some(&b'r') {
        return false;
    }
    marker += 1;
    while bytes.get(marker) == Some(&b'#') {
        marker += 1;
    }
    bytes.get(marker) == Some(&b'"')
}

fn apostrophe_starts_lifetime(bytes: &[u8], apostrophe: usize) -> bool {
    let Some(previous) = bytes[..apostrophe]
        .iter()
        .rev()
        .find(|byte| !byte.is_ascii_whitespace())
    else {
        return false;
    };
    if !matches!(*previous, b'<' | b',' | b'+' | b'&') {
        return false;
    }
    let Some(first) = bytes.get(apostrophe + 1) else {
        return false;
    };
    if !is_identifier_start(*first) {
        return false;
    }
    let mut cursor = apostrophe + 2;
    while cursor < bytes.len() && is_identifier_continue(bytes[cursor]) {
        cursor += 1;
    }
    let next = bytes[cursor..]
        .iter()
        .find(|byte| !byte.is_ascii_whitespace())
        .copied();
    if *previous == b'&' {
        return next.is_some();
    }
    next.is_some_and(|byte| matches!(byte, b',' | b'>' | b'+' | b':' | b'='))
}

fn header_has_valid_lifetimes(header: &str) -> bool {
    header
        .bytes()
        .enumerate()
        .all(|(index, byte)| byte != b'\'' || apostrophe_starts_lifetime(header.as_bytes(), index))
}

fn python_triple_quote_start(line: &str) -> Option<(u8, usize)> {
    let content = line.trim_start().as_bytes();
    for prefix_len in [0, 1, 2] {
        let Some(prefix) = content.get(..prefix_len) else {
            continue;
        };
        if !valid_python_string_prefix(prefix) {
            continue;
        }
        let Some(suffix) = content.get(prefix_len..) else {
            continue;
        };
        if suffix.starts_with(b"\"\"\"") {
            return Some((b'"', prefix_len + 3));
        }
        if suffix.starts_with(b"'''") {
            return Some((b'\'', prefix_len + 3));
        }
    }
    None
}

fn valid_python_string_prefix(prefix: &[u8]) -> bool {
    matches!(
        prefix,
        [] | [b'r' | b'R' | b'u' | b'U' | b'b' | b'B' | b'f' | b'F']
    ) || matches!(
        prefix,
        [b'b' | b'B', b'r' | b'R']
            | [b'r' | b'R', b'b' | b'B']
            | [b'f' | b'F', b'r' | b'R']
            | [b'r' | b'R', b'f' | b'F']
    )
}

fn contains_unescaped_python_triple_delimiter(line: &str, quote: u8) -> bool {
    let bytes = line.as_bytes();
    let mut cursor = 0_usize;
    while cursor + 3 <= bytes.len() {
        if bytes[cursor..].starts_with(&[quote; 3]) {
            let backslashes = bytes[..cursor]
                .iter()
                .rev()
                .take_while(|byte| **byte == b'\\')
                .count();
            if backslashes % 2 == 0 {
                return true;
            }
        }
        cursor += 1;
    }
    false
}

fn python_class_header(line: &str) -> Option<usize> {
    let indentation = leading_indentation(line);
    let trimmed = line[indentation..].trim_end();
    let code = trimmed
        .split_once('#')
        .map_or(trimmed, |(before_comment, _)| before_comment.trim_end());
    let declaration = code.strip_prefix("class ")?.strip_suffix(':')?.trim_end();
    let bytes = declaration.as_bytes();
    if bytes.is_empty() || !is_identifier_start(bytes[0]) {
        return None;
    }
    let name_end = bytes
        .iter()
        .position(|byte| !is_identifier_continue(*byte))
        .unwrap_or(bytes.len());
    let remainder = declaration[name_end..].trim();
    (remainder.is_empty() || (remainder.starts_with('(') && remainder.ends_with(')')))
        .then_some(indentation)
}

fn redact_untrusted_text(text: &str) -> (String, bool) {
    let mut output = String::with_capacity(text.len());
    let mut redactions_applied = false;
    let mut inside_private_key = false;
    let typed_field_lines = typed_field_eligible_lines(text);

    for (line_index, line) in text.split_inclusive('\n').enumerate() {
        let (content, ending) = split_line_ending(line);
        let private_key_start = private_key_boundary(content, "BEGIN");
        let private_key_end = private_key_boundary(content, "END");

        if inside_private_key || private_key_start {
            output.push_str(REDACTED);
            output.push_str(ending);
            redactions_applied = true;
            inside_private_key = !private_key_end;
            continue;
        }

        let allow_typed_fields = typed_field_lines.get(line_index).copied().unwrap_or(false);
        let (assignments_redacted, assignment_redacted) =
            redact_assignment_values(content, allow_typed_fields);
        let (tokens_redacted, token_redacted) = redact_github_tokens(&assignments_redacted);
        output.push_str(&tokens_redacted);
        output.push_str(ending);
        redactions_applied |= assignment_redacted || token_redacted;
    }

    (output, redactions_applied)
}

fn split_line_ending(line: &str) -> (&str, &str) {
    if let Some(content) = line.strip_suffix("\r\n") {
        (content, "\r\n")
    } else if let Some(content) = line.strip_suffix('\n') {
        (content, "\n")
    } else {
        (line, "")
    }
}

fn private_key_boundary(line: &str, kind: &str) -> bool {
    let marker = line.trim().to_ascii_uppercase();
    marker.starts_with(&format!("-----{kind} ")) && marker.ends_with(" PRIVATE KEY-----")
}

fn redact_assignment_values(line: &str, allow_typed_fields: bool) -> (String, bool) {
    let mut output = String::with_capacity(line.len());
    let mut copied_through = 0_usize;
    let mut cursor = 0_usize;
    let mut redacted = false;

    while let Some((value_start, value_end)) =
        next_assignment_value(line, cursor, allow_typed_fields)
    {
        output.push_str(&line[copied_through..value_start]);
        output.push_str(REDACTED);
        copied_through = value_end;
        cursor = value_end;
        redacted = true;
    }
    output.push_str(&line[copied_through..]);
    (output, redacted)
}

fn next_assignment_value(
    line: &str,
    from: usize,
    allow_typed_fields: bool,
) -> Option<(usize, usize)> {
    let bytes = line.as_bytes();
    let mut cursor = from;

    while cursor < bytes.len() {
        if !is_identifier_start(bytes[cursor])
            || (cursor > 0 && is_identifier_continue(bytes[cursor - 1]))
        {
            cursor += 1;
            continue;
        }

        let key_start = cursor;
        cursor += 1;
        while cursor < bytes.len() && is_identifier_continue(bytes[cursor]) {
            cursor += 1;
        }
        let key_end = cursor;
        let key = &line[key_start..key_end];
        if !sensitive_assignment_key(key) {
            continue;
        }

        let key_quote = key_start
            .checked_sub(1)
            .and_then(|index| matches!(bytes[index], b'"' | b'\'').then_some(bytes[index]));
        if let Some(quote) = key_quote {
            if cursor >= bytes.len() || bytes[cursor] != quote {
                continue;
            }
            cursor += 1;
        }

        let mut delimiter = cursor;
        while delimiter < bytes.len() && bytes[delimiter].is_ascii_whitespace() {
            delimiter += 1;
        }
        if delimiter >= bytes.len() {
            continue;
        }
        let is_equals = bytes[delimiter] == b'='
            && bytes
                .get(delimiter + 1)
                .map_or(true, |next| !matches!(*next, b'=' | b'>'));
        let is_colon =
            bytes[delimiter] == b':' && colon_is_assignment(line, key_start, key_quote.is_some());
        if !is_equals && !is_colon {
            cursor = key_end;
            continue;
        }

        let mut value_start = delimiter + 1;
        while value_start < bytes.len() && bytes[value_start].is_ascii_whitespace() {
            value_start += 1;
        }
        if value_start >= bytes.len()
            || bytes[value_start] == b'#'
            || bytes[value_start..].starts_with(b"//")
        {
            cursor = value_start;
            continue;
        }
        if is_colon
            && key_quote.is_none()
            && allow_typed_fields
            && looks_like_structural_typed_field(&line[value_start..])
        {
            cursor = value_start;
            continue;
        }

        if matches!(bytes[value_start], b'"' | b'\'') {
            let quote = bytes[value_start];
            let content_start = value_start + 1;
            let mut content_end = content_start;
            let mut escaped = false;
            while content_end < bytes.len() {
                if !escaped && bytes[content_end] == quote {
                    break;
                }
                escaped = !escaped && bytes[content_end] == b'\\';
                content_end += 1;
            }
            if content_end > content_start {
                return Some((content_start, content_end));
            }
            cursor = content_end.saturating_add(1);
            continue;
        }

        let mut value_end = bytes.len();
        while value_end > value_start && bytes[value_end - 1].is_ascii_whitespace() {
            value_end -= 1;
        }
        if value_end > value_start {
            return Some((value_start, value_end));
        }
        cursor = value_start;
    }
    None
}

fn colon_is_assignment(line: &str, key_start: usize, quoted_key: bool) -> bool {
    if quoted_key || line[..key_start].trim().is_empty() {
        return true;
    }
    line[..key_start]
        .trim_end()
        .bytes()
        .next_back()
        .is_some_and(|byte| matches!(byte, b'{' | b','))
}

fn looks_like_structural_typed_field(value: &str) -> bool {
    let value = value.trim();
    let candidate = value.strip_suffix([',', ';']).map_or(value, str::trim_end);
    if candidate.is_empty() {
        return false;
    }

    let bytes = candidate.as_bytes();
    let mut cursor = 0_usize;
    let mut angle_depth = 0_usize;
    let mut square_depth = 0_usize;
    let mut paren_depth = 0_usize;
    let mut has_type_signal = false;

    while cursor < bytes.len() {
        let byte = bytes[cursor];
        if byte.is_ascii_whitespace() {
            cursor += 1;
            continue;
        }
        if is_identifier_start(byte) {
            let start = cursor;
            cursor += 1;
            while cursor < bytes.len() && is_identifier_continue(bytes[cursor]) {
                cursor += 1;
            }
            let identifier = &candidate[start..cursor];
            has_type_signal |= identifier
                .bytes()
                .next()
                .is_some_and(|first| first.is_ascii_uppercase())
                || is_builtin_type_identifier(identifier);
            continue;
        }
        if byte.is_ascii_digit() {
            if angle_depth == 0 && square_depth == 0 && paren_depth == 0 {
                return false;
            }
            cursor += 1;
            while cursor < bytes.len() && (bytes[cursor].is_ascii_digit() || bytes[cursor] == b'_')
            {
                cursor += 1;
            }
            continue;
        }

        match byte {
            b'<' => angle_depth += 1,
            b'>' if angle_depth > 0 => angle_depth -= 1,
            b'[' => square_depth += 1,
            b']' if square_depth > 0 => square_depth -= 1,
            b'(' => paren_depth += 1,
            b')' if paren_depth > 0 => paren_depth -= 1,
            b':' if bytes.get(cursor + 1) == Some(&b':') => cursor += 1,
            b',' if angle_depth > 0 || square_depth > 0 || paren_depth > 0 => {}
            b';' if square_depth > 0 => {}
            b'.' | b'|' | b'&' | b'*' | b'?' | b'+' | b'\'' => {}
            _ => return false,
        }
        cursor += 1;
    }

    has_type_signal && angle_depth == 0 && square_depth == 0 && paren_depth == 0
}

fn is_builtin_type_identifier(identifier: &str) -> bool {
    matches!(
        identifier,
        "str"
            | "string"
            | "bool"
            | "boolean"
            | "char"
            | "byte"
            | "bytes"
            | "int"
            | "float"
            | "double"
            | "number"
            | "usize"
            | "isize"
            | "u8"
            | "u16"
            | "u32"
            | "u64"
            | "u128"
            | "i8"
            | "i16"
            | "i32"
            | "i64"
            | "i128"
            | "f32"
            | "f64"
            | "list"
            | "dict"
            | "tuple"
            | "set"
            | "frozenset"
            | "object"
            | "Any"
            | "unknown"
            | "never"
            | "void"
    )
}

fn sensitive_assignment_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    ["token", "secret", "password", "api_key"]
        .iter()
        .any(|suffix| key == *suffix || key.ends_with(&format!("_{suffix}")))
}

fn is_identifier_start(byte: u8) -> bool {
    byte.is_ascii_alphabetic() || byte == b'_'
}

fn is_identifier_continue(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

fn redact_github_tokens(line: &str) -> (String, bool) {
    const PREFIXES: [&str; 6] = ["github_pat_", "ghp_", "gho_", "ghu_", "ghs_", "ghr_"];

    let bytes = line.as_bytes();
    let mut output = String::with_capacity(line.len());
    let mut copied_through = 0_usize;
    let mut cursor = 0_usize;
    let mut redacted = false;

    while cursor < bytes.len() {
        let Some(prefix) = PREFIXES
            .iter()
            .find(|prefix| bytes[cursor..].starts_with(prefix.as_bytes()))
        else {
            cursor += 1;
            continue;
        };
        if cursor > 0 && is_identifier_continue(bytes[cursor - 1]) {
            cursor += 1;
            continue;
        }
        let token_start = cursor;
        let mut token_end = cursor + prefix.len();
        while token_end < bytes.len() && is_identifier_continue(bytes[token_end]) {
            token_end += 1;
        }
        if token_end - (cursor + prefix.len()) < 16 {
            cursor = token_end;
            continue;
        }
        output.push_str(&line[copied_through..token_start]);
        output.push_str(REDACTED);
        copied_through = token_end;
        cursor = token_end;
        redacted = true;
    }
    output.push_str(&line[copied_through..]);
    (output, redacted)
}

fn line_bounded_end(text: &str, max_lines: usize) -> (usize, bool) {
    let mut lines = 0_usize;
    for (index, byte) in text.bytes().enumerate() {
        if byte == b'\n' {
            lines += 1;
            let end = index + 1;
            if lines == max_lines && end < text.len() {
                return (end, true);
            }
        }
    }
    (text.len(), false)
}

fn utf8_bounded_end(text: &str, max_bytes: usize) -> usize {
    let mut end = text.len().min(max_bytes);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    end
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_error_code<T>(result: Result<T, crate::domain::types::AppError>, code: &str) {
        let error = result.err().expect("expected validation to fail");
        assert_eq!(error.code, code);
    }

    #[test]
    fn accepts_repository_paths_and_git_refs() {
        assert_eq!(validate_repository_path("", true).unwrap(), "");
        assert_eq!(
            validate_repository_path("src/components", false).unwrap(),
            "src/components"
        );
        assert_eq!(
            validate_repository_path("src/lib.rs", false).unwrap(),
            "src/lib.rs"
        );

        assert_eq!(validate_git_ref(None).unwrap(), None);
        assert_eq!(
            validate_git_ref(Some("main")).unwrap(),
            Some("main".to_owned())
        );
        assert_eq!(
            validate_git_ref(Some("feature/github-reads")).unwrap(),
            Some("feature/github-reads".to_owned())
        );
        assert_eq!(
            validate_git_ref(Some("refs/tags/v1.2.3")).unwrap(),
            Some("refs/tags/v1.2.3".to_owned())
        );
    }

    #[test]
    fn rejects_invalid_and_overlength_repository_paths() {
        for path in [
            "",
            "/src/lib.rs",
            "src\\lib.rs",
            "src\0lib.rs",
            "src/./lib.rs",
            "src/../lib.rs",
            "src//lib.rs",
            "src/lib.rs/",
            "src/\u{0001}lib.rs",
        ] {
            assert_error_code(
                validate_repository_path(path, false),
                "github_input_invalid",
            );
        }

        assert_error_code(
            validate_repository_path(&"a".repeat(1_025), false),
            "github_input_invalid",
        );
        assert_eq!(validate_repository_path("", true).unwrap(), "");
    }

    #[test]
    fn rejects_invalid_and_overlength_git_refs() {
        for git_ref in [
            "",
            "/main",
            "main/",
            "main//topic",
            ".",
            "..",
            "../main",
            "main/../secret",
            "main\\topic",
            "main\0topic",
            "main\u{0001}topic",
            "main..topic",
            "main@{topic",
            "main.lock",
        ] {
            assert_error_code(validate_git_ref(Some(git_ref)), "github_input_invalid");
        }

        assert_error_code(
            validate_git_ref(Some(&"a".repeat(256))),
            "github_input_invalid",
        );
    }

    #[test]
    fn validates_search_literals_and_rejects_qualifier_injection() {
        assert_eq!(
            validate_search_literal("content guard").unwrap(),
            "content guard"
        );

        for query in [
            "",
            "repo:someone/else",
            "language:rust",
            "a \\\"quoted\\\" value",
            "path\\escape",
            "line\0break",
            "line\u{0001}break",
        ] {
            assert_error_code(validate_search_literal(query), "github_input_invalid");
        }

        assert_error_code(
            validate_search_literal(&"q".repeat(257)),
            "github_input_invalid",
        );
    }

    #[test]
    fn validates_deduplicates_and_bounds_labels() {
        let labels = vec!["bug".to_owned(), "Bug".to_owned(), "help wanted".to_owned()];
        assert_eq!(
            validate_labels(&labels).unwrap(),
            vec!["bug".to_owned(), "help wanted".to_owned()]
        );

        for label in [
            "",
            "  ",
            " leading",
            "trailing ",
            "bad\0label",
            "bad\u{0001}label",
        ] {
            assert_error_code(validate_labels(&[label.to_owned()]), "github_input_invalid");
        }
        assert_error_code(validate_labels(&["a".repeat(51)]), "github_input_invalid");
        assert_error_code(
            validate_labels(
                &(0..21)
                    .map(|index| format!("label-{index}"))
                    .collect::<Vec<_>>(),
            ),
            "github_input_invalid",
        );
    }

    #[test]
    fn blocks_sensitive_repository_paths_case_insensitively() {
        for path in [
            ".env",
            ".env.local",
            "config/.ENV.PRODUCTION",
            "id_rsa",
            "keys/ID_ED25519",
            "certs/server.pem",
            "certs/server.KEY",
            "certs/client.p12",
            "certs/client.PFX",
            ".netrc",
            ".git-credentials",
            ".npmrc",
            ".pypirc",
            ".pgpass",
            "config/credentials.json",
            "config/CLIENT_SECRETS.JSON",
            "config/service-account-credential.json",
        ] {
            assert!(
                sensitive_path_blocked(path),
                "expected blocked path: {path}"
            );
        }

        for path in [
            "src/lib.rs",
            "docs/password-policy.md",
            "config/public.json",
            "keys/id_rsa.pub",
            "src/monkey.rs",
        ] {
            assert!(!sensitive_path_blocked(path), "expected safe path: {path}");
        }
    }

    #[test]
    fn rejects_invalid_utf8_nul_and_control_heavy_buffers() {
        assert_error_code(
            normalize_untrusted_text(&[0xff, 0xfe, 0xfd], 1_024, 100),
            "github_binary_content",
        );
        assert_error_code(
            normalize_untrusted_text(b"public\0private", 1_024, 100),
            "github_binary_content",
        );
        assert_error_code(
            normalize_untrusted_text(b"\x01\x02\x03\x04\x05ordinary", 1_024, 100),
            "github_binary_content",
        );
        assert_error_code(
            normalize_untrusted_text(b"ordinary", 0, 100),
            "github_response_too_large",
        );
        assert_error_code(
            normalize_untrusted_text(b"ordinary", 1_024, 0),
            "github_response_too_large",
        );
    }

    #[test]
    fn truncates_by_lines_and_bytes_without_splitting_unicode() {
        let by_lines = normalize_untrusted_text("one\néclair\nthree\n".as_bytes(), 1_024, 2)
            .expect("line-bounded text");
        assert_eq!(by_lines.text, "one\néclair\n");
        assert!(by_lines.truncated);
        assert!(!by_lines.redactions_applied);

        let by_bytes =
            normalize_untrusted_text("abéz".as_bytes(), 3, 100).expect("byte-bounded text");
        assert_eq!(by_bytes.text, "ab");
        assert!(by_bytes.truncated);
        assert!(by_bytes.text.is_char_boundary(by_bytes.text.len()));

        let exact =
            normalize_untrusted_text("é\n".as_bytes(), 3, 1).expect("exact byte and line ceiling");
        assert_eq!(exact.text, "é\n");
        assert!(!exact.truncated);
    }

    #[test]
    fn redacts_private_keys_github_tokens_and_secret_assignments() {
        let input = concat!(
            "token = abc123\n",
            "SECRET: \"shh\"\n",
            "password='hunter2'\n",
            "api_key = sk-live-value\n",
            "github = ghp_abcdefghijklmnopqrstuvwxyz1234567890\n",
            // Keep the synthetic marker split so repository hygiene does not
            // mistake this redaction fixture for committed key material.
            "-----BEGIN ",
            "OPENSSH PRIVATE KEY-----\n",
            "cHJpdmF0ZSBrZXkgbWF0ZXJpYWw=\n",
            "-----END ",
            "OPENSSH PRIVATE KEY-----\n",
        );

        let guarded = normalize_untrusted_text(input.as_bytes(), 4_096, 100)
            .expect("redacted repository text");

        assert!(guarded.redactions_applied);
        assert!(!guarded.truncated);
        assert_eq!(
            guarded.text.matches('\n').count(),
            input.matches('\n').count()
        );
        assert!(guarded.text.contains("token = [REDACTED]"));
        assert!(guarded.text.contains("SECRET: \"[REDACTED]\""));
        assert!(guarded.text.contains("password='[REDACTED]'"));
        assert!(guarded.text.contains("api_key = [REDACTED]"));
        assert!(guarded.text.contains("github = [REDACTED]"));
        assert!(!guarded.text.contains("abc123"));
        assert!(!guarded.text.contains("hunter2"));
        assert!(!guarded.text.contains("ghp_"));
        assert!(!guarded.text.contains("PRIVATE KEY"));
        assert!(!guarded.text.contains("cHJpdmF0"));
    }

    #[test]
    fn redacts_complete_unquoted_secret_values_with_punctuation() {
        let input = concat!("password: alpha,beta\n", "api_key = sk-live;still-secret\n",);

        let guarded = normalize_untrusted_text(input.as_bytes(), 4_096, 100)
            .expect("redacted punctuation-bearing secrets");

        assert_eq!(guarded.text, "password: [REDACTED]\napi_key = [REDACTED]\n");
        assert!(guarded.redactions_applied);
        assert!(!guarded.truncated);
        for leaked in ["alpha", "beta", "sk-live", "still-secret"] {
            assert!(
                !guarded.text.contains(leaked),
                "leaked secret fragment: {leaked}"
            );
        }
    }

    #[test]
    fn preserves_ordinary_public_prose_and_source_code() {
        let input = concat!(
            "Our password policy requires a long passphrase.\n",
            "const SECRET_LENGTH: usize = 32;\n",
            "if secret.is_empty() { return None; }\n",
            "fn token_count(source: &str) -> usize { source.len() }\n",
            "token => handler,\n",
        );

        let guarded = normalize_untrusted_text(input.as_bytes(), 4_096, 100)
            .expect("ordinary repository text");

        assert_eq!(guarded.text, input);
        assert!(!guarded.truncated);
        assert!(!guarded.redactions_applied);
    }

    #[test]
    fn preserves_structural_typed_fields_across_source_languages() {
        let input = concat!(
            "#[derive(Debug)]\n",
            "struct Credentials {\n",
            "    token: CancellationToken,\n",
            "    secret: SecretString,\n",
            "    password: String,\n",
            "    api_key: Option<crate::types::ApiKey>,\n",
            "}\n",
            "export interface Credentials {\n",
            "    password: string;\n",
            "    secret: Credential.Secret | null;\n",
            "    api_key: ReadonlyArray<string>;\n",
            "    token: string[];\n",
            "}\n",
            "class Credentials:\n",
            "    password: str\n",
            "    secret: SecretString | None\n",
            "    api_key: list[typing.Optional[str]]\n",
        );

        let guarded = normalize_untrusted_text(input.as_bytes(), 8_192, 100)
            .expect("ordinary typed source fields");

        assert_eq!(guarded.text, input);
        assert!(!guarded.truncated);
        assert!(!guarded.redactions_applied);
    }

    #[test]
    fn redacts_yaml_values_that_resemble_source_types() {
        let input = concat!(
            "credentials:\n",
            "  password: CorrectHorseBatteryStaple\n",
            "  api_key: SECRETKEY\n",
            "  token: string\n",
            "  secret: AB+CD\n",
        );

        let guarded = normalize_untrusted_text(input.as_bytes(), 4_096, 100)
            .expect("type-shaped YAML secret values");

        assert_eq!(
            guarded.text,
            concat!(
                "credentials:\n",
                "  password: [REDACTED]\n",
                "  api_key: [REDACTED]\n",
                "  token: [REDACTED]\n",
                "  secret: [REDACTED]\n",
            )
        );
        assert!(guarded.redactions_applied);
        assert!(!guarded.truncated);
    }

    #[test]
    fn source_context_does_not_escape_past_string_braces() {
        let input = concat!(
            "class Credentials {\n",
            "    marker = 'foo {';\n",
            "}\n",
            "password: string\n",
        );

        let guarded = normalize_untrusted_text(input.as_bytes(), 4_096, 100)
            .expect("source followed by an ambiguous scalar");

        assert_eq!(
            guarded.text,
            concat!(
                "class Credentials {\n",
                "    marker = 'foo {';\n",
                "}\n",
                "password: [REDACTED]\n",
            )
        );
        assert!(guarded.redactions_applied);
    }

    #[test]
    fn source_context_does_not_escape_past_comment_braces() {
        let input = concat!(
            "interface Credentials {\n",
            "    /* { */\n",
            "}\n",
            "token: string\n",
        );

        let guarded = normalize_untrusted_text(input.as_bytes(), 4_096, 100)
            .expect("source comment followed by an ambiguous scalar");

        assert_eq!(
            guarded.text,
            concat!(
                "interface Credentials {\n",
                "    /* { */\n",
                "}\n",
                "token: [REDACTED]\n",
            )
        );
        assert!(guarded.redactions_applied);
    }

    #[test]
    fn source_context_does_not_escape_past_untrusted_literal_syntax() {
        let cases = [
            ("template literal", "    marker = `value {`;\n"),
            ("regular expression", "    marker = /\\{/;\n"),
            ("Rust raw string", "    marker = r#\"value {\"#;\n"),
            ("unknown percent literal", "    marker = %q(value {);\n"),
        ];
        let mut failures = Vec::new();

        for (name, marker) in cases {
            let input = format!("class Credentials {{\n{marker}}}\npassword: string\n");
            let expected = format!("class Credentials {{\n{marker}}}\npassword: [REDACTED]\n");
            let guarded = normalize_untrusted_text(input.as_bytes(), 4_096, 100)
                .expect("source literal followed by an ambiguous scalar");
            if guarded.text != expected || !guarded.redactions_applied {
                failures.push((name, guarded.text));
            }
        }

        assert!(
            failures.is_empty(),
            "literal syntax escaped context: {failures:?}"
        );
    }

    #[test]
    fn nested_block_comments_do_not_change_source_brace_trust() {
        let input = concat!(
            "struct Credentials {\n",
            "    /* outer /* inner */ { outer */\n",
            "}\n",
            "secret: SecretString\n",
        );

        let guarded = normalize_untrusted_text(input.as_bytes(), 4_096, 100)
            .expect("nested comment followed by an ambiguous scalar");

        assert_eq!(
            guarded.text,
            concat!(
                "struct Credentials {\n",
                "    /* outer /* inner */ { outer */\n",
                "}\n",
                "secret: [REDACTED]\n",
            )
        );
        assert!(guarded.redactions_applied);
    }

    #[test]
    fn unclosed_brace_declarations_fail_closed_through_eof() {
        let input = concat!(
            "interface Credentials {\n",
            "    password: string;\n",
            "    token: ReadonlyArray<string>;\n",
        );

        let guarded = normalize_untrusted_text(input.as_bytes(), 4_096, 100)
            .expect("truncated source declaration");

        assert_eq!(
            guarded.text,
            concat!(
                "interface Credentials {\n",
                "    password: [REDACTED]\n",
                "    token: [REDACTED]\n",
            )
        );
        assert!(guarded.redactions_applied);
    }

    #[test]
    fn preserves_typed_fields_when_declaration_brace_is_on_the_next_line() {
        let input = concat!(
            "export interface Credentials\n",
            "{\n",
            "    password: string;\n",
            "    token: ReadonlyArray<string>;\n",
            "}\n",
            "struct Secrets\n",
            "{\n",
            "    secret: SecretString,\n",
            "    api_key: Option<ApiKey>,\n",
            "}\n",
        );

        let guarded = normalize_untrusted_text(input.as_bytes(), 4_096, 100)
            .expect("multiline source declaration headers");

        assert_eq!(guarded.text, input);
        assert!(!guarded.redactions_applied);
    }

    #[test]
    fn preserves_python_class_annotations_with_a_trailing_comment() {
        let input = concat!(
            "class Credentials:  # stored account fields\n",
            "    password: str\n",
            "    token: list[str]\n",
        );

        let guarded = normalize_untrusted_text(input.as_bytes(), 4_096, 100)
            .expect("commented Python class header");

        assert_eq!(guarded.text, input);
        assert!(!guarded.redactions_applied);
    }

    #[test]
    fn python_class_docstrings_disable_typed_field_eligibility() {
        let mut failures = Vec::new();
        for delimiter in ["\"\"\"", "'''"] {
            let input = format!(
                "class Credentials:\n    {delimiter}\n    password: CorrectHorseBatteryStaple\n    token: string\n    {delimiter}\n    password: str\n    token: list[str]\n"
            );
            let expected = format!(
                "class Credentials:\n    {delimiter}\n    password: [REDACTED]\n    token: [REDACTED]\n    {delimiter}\n    password: str\n    token: list[str]\n"
            );
            let guarded = normalize_untrusted_text(input.as_bytes(), 4_096, 100)
                .expect("Python class with a closed docstring");
            if guarded.text != expected || !guarded.redactions_applied {
                failures.push((delimiter, guarded.text));
            }
        }

        assert!(
            failures.is_empty(),
            "docstring contents escaped redaction: {failures:?}"
        );
    }

    #[test]
    fn unclosed_python_class_docstrings_fail_closed() {
        let mut failures = Vec::new();
        for delimiter in ["\"\"\"", "'''"] {
            let input = format!(
                "class Credentials:\n    {delimiter}\n    password: CorrectHorseBatteryStaple\n    token: string\n"
            );
            let expected = format!(
                "class Credentials:\n    {delimiter}\n    password: [REDACTED]\n    token: [REDACTED]\n"
            );
            let guarded = normalize_untrusted_text(input.as_bytes(), 4_096, 100)
                .expect("Python class with a truncated docstring");
            if guarded.text != expected || !guarded.redactions_applied {
                failures.push((delimiter, guarded.text));
            }
        }

        assert!(
            failures.is_empty(),
            "unclosed docstring contents escaped redaction: {failures:?}"
        );
    }

    #[test]
    fn prefixed_python_triple_strings_disable_typed_field_eligibility() {
        let prefixes = [
            "r", "R", "u", "U", "b", "B", "f", "F", "br", "BR", "bR", "Br", "rb", "RB", "rB", "Rb",
            "fr", "FR", "fR", "Fr", "rf", "RF", "rF", "Rf",
        ];
        let mut failures = Vec::new();

        for prefix in prefixes {
            for delimiter in ["\"\"\"", "'''"] {
                let input = format!(
                    "class Credentials:\n    {prefix}{delimiter}\n    password: CorrectHorseBatteryStaple\n    token: string\n    {delimiter}\n    password: str\n"
                );
                let expected = format!(
                    "class Credentials:\n    {prefix}{delimiter}\n    password: [REDACTED]\n    token: [REDACTED]\n    {delimiter}\n    password: str\n"
                );
                let guarded = normalize_untrusted_text(input.as_bytes(), 4_096, 100)
                    .expect("prefixed Python triple string");
                if guarded.text != expected || !guarded.redactions_applied {
                    failures.push((prefix, delimiter, guarded.text));
                }
            }
        }

        assert!(
            failures.is_empty(),
            "prefixed triple strings escaped redaction: {failures:?}"
        );
    }

    #[test]
    fn escaped_triple_delimiters_close_only_at_even_backslash_parity() {
        let mut failures = Vec::new();
        for delimiter in ["\"\"\"", "'''"] {
            let input = format!(
                "class Credentials:\n    {delimiter}\n    password: CorrectHorseBatteryStaple\n    \\{delimiter}\n    token: string\n    \\\\{delimiter}\n    password: str\n"
            );
            let expected = format!(
                "class Credentials:\n    {delimiter}\n    password: [REDACTED]\n    \\{delimiter}\n    token: [REDACTED]\n    \\\\{delimiter}\n    password: str\n"
            );
            let guarded = normalize_untrusted_text(input.as_bytes(), 4_096, 100)
                .expect("escaped Python triple delimiters");
            if guarded.text != expected || !guarded.redactions_applied {
                failures.push((delimiter, guarded.text));
            }
        }

        assert!(
            failures.is_empty(),
            "escaped delimiter closed a triple string: {failures:?}"
        );
    }

    #[test]
    fn invalid_or_detached_prefixes_do_not_open_python_triple_strings() {
        for opener in ["x\"\"\"", "r \"\"\"", "x'''", "f '''"] {
            let input = format!("class Credentials:\n    {opener}\n    password: str\n");
            let guarded = normalize_untrusted_text(input.as_bytes(), 4_096, 100)
                .expect("invalid Python string prefix");

            assert_eq!(guarded.text, input, "unexpected opener: {opener}");
            assert!(!guarded.redactions_applied, "unexpected opener: {opener}");
        }
    }

    #[test]
    fn preserves_rust_typed_fields_in_valid_lifetime_declarations_only() {
        let valid = concat!(
            "struct Credentials<'a> {\n",
            "    password: &'a str,\n",
            "    token: TokenRef<'a>,\n",
            "}\n",
            "struct Pair<'a, 'b> {\n",
            "    secret: SecretPair<'a, 'b>,\n",
            "    api_key: &'b str,\n",
            "}\n",
        );
        let invalid = concat!(
            "struct Credentials<'quoted text'> {\n",
            "    password: string,\n",
            "}\n",
        );

        let valid_guarded = normalize_untrusted_text(valid.as_bytes(), 4_096, 100)
            .expect("valid Rust lifetime declarations");
        let invalid_guarded = normalize_untrusted_text(invalid.as_bytes(), 4_096, 100)
            .expect("invalid quoted declaration header");

        assert_eq!(valid_guarded.text, valid);
        assert!(!valid_guarded.redactions_applied);
        assert_eq!(
            invalid_guarded.text,
            concat!(
                "struct Credentials<'quoted text'> {\n",
                "    password: [REDACTED]\n",
                "}\n",
            )
        );
        assert!(invalid_guarded.redactions_applied);
    }

    #[test]
    fn redacts_assignment_values_that_only_resemble_type_syntax() {
        let input = concat!(
            "password: alpha\n",
            "secret: hunter2;\n",
            "token: v1.2.3\n",
            "api_key: abc123[]\n",
            "password: String,\n",
            "\"password\": \"String\"\n",
        );

        let guarded = normalize_untrusted_text(input.as_bytes(), 4_096, 100)
            .expect("value-shaped secret assignments");

        assert_eq!(
            guarded.text,
            concat!(
                "password: [REDACTED]\n",
                "secret: [REDACTED]\n",
                "token: [REDACTED]\n",
                "api_key: [REDACTED]\n",
                "password: [REDACTED]\n",
                "\"password\": \"[REDACTED]\"\n",
            )
        );
        assert!(guarded.redactions_applied);
        assert!(!guarded.truncated);
    }
}
