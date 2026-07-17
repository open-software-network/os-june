pub(crate) fn parse_provides_tools(manifest: &str) -> Result<Vec<String>, &'static str> {
    let lines: Vec<&str> = manifest.lines().collect();
    let blocks: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter_map(|(index, line)| {
            line.trim_start()
                .starts_with("provides_tools:")
                .then_some(index)
        })
        .collect();
    if blocks.len() != 1 || lines[blocks[0]] != "provides_tools:" {
        return Err("manifest must contain exactly one top-level provides_tools block");
    }

    let mut tools = Vec::new();
    for line in lines.iter().skip(blocks[0] + 1) {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(name) = line.strip_prefix("  - ") {
            if name.is_empty()
                || name.trim() != name
                || !name
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
            {
                return Err("provides_tools contains a non-canonical tool name");
            }
            tools.push(name.to_string());
            continue;
        }
        if line.as_bytes().first().is_some_and(u8::is_ascii_whitespace) {
            return Err("provides_tools contains ambiguous nested content");
        }
        break;
    }
    if tools.is_empty() {
        return Err("provides_tools block is empty");
    }
    Ok(tools)
}

#[cfg(test)]
mod tests {
    use super::parse_provides_tools;

    #[test]
    fn rejects_duplicate_top_level_provides_tools_blocks() {
        let manifest =
            "provides_tools:\n  - trusted\nkind: backend\nprovides_tools:\n  - attacker\n";
        assert!(parse_provides_tools(manifest).is_err());

        let inline_override =
            "provides_tools:\n  - trusted\nkind: backend\nprovides_tools: [attacker]\n";
        assert!(parse_provides_tools(inline_override).is_err());
    }

    #[test]
    fn rejects_indented_or_ambiguous_provides_tools_lists() {
        let indented = "plugin:\n  provides_tools:\n    - attacker\n";
        assert!(parse_provides_tools(indented).is_err());

        let ambiguous = "provides_tools:\n  - trusted\n  continuation:\n    - attacker\n";
        assert!(parse_provides_tools(ambiguous).is_err());
    }

    #[test]
    fn parses_one_canonical_top_level_provides_tools_block() {
        let manifest = "name: june_github\nprovides_tools:\n  - first\n  - second\nkind: backend\n";
        assert_eq!(
            parse_provides_tools(manifest).expect("canonical block"),
            vec!["first".to_string(), "second".to_string()]
        );
    }
}
