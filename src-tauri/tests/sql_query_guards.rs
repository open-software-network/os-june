use std::{
    fs,
    path::{Path, PathBuf},
};

const COLUMN_ORDER_DIVERGENT_TABLES: &[&str] = &["transcripts", "folders"];

#[test]
fn column_order_divergent_tables_never_use_projection_star_selects() {
    let source_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut source_files = Vec::new();
    collect_source_files(&source_root, &mut source_files);
    source_files.sort();

    let mut violations = Vec::new();
    for path in source_files {
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
        let tokens = sql_tokens(&source);
        for table in COLUMN_ORDER_DIVERGENT_TABLES {
            if has_projection_star_select_from_table(&tokens, table) {
                let relative_path = path.strip_prefix(&source_root).unwrap_or(&path).display();
                violations.push(format!("{relative_path}: projection star from {table}"));
            }
        }
    }

    assert!(
        violations.is_empty(),
        "fresh and upgraded databases have different physical column order; \
         name every selected column for transcripts and folders:\n{}",
        violations.join("\n")
    );
}

#[test]
fn star_select_guard_detects_projection_star_shapes() {
    for (query, table) in [
        ("SeLeCt\n  *\tFROM\ntranscripts", "transcripts"),
        ("SELECT t.* FROM transcripts t", "transcripts"),
        ("SELECT transcripts.* FROM transcripts", "transcripts"),
        ("SELECT *, extra FROM folders", "folders"),
    ] {
        let tokens = sql_tokens(query);
        assert!(
            has_projection_star_select_from_table(&tokens, table),
            "star projection should be rejected: {query}"
        );
    }

    let tokens = sql_tokens("SELECT id, text FROM transcripts");
    assert!(!has_projection_star_select_from_table(
        &tokens,
        "transcripts"
    ));

    let tokens = sql_tokens("SELECT COUNT(*) AS count FROM transcripts");
    assert!(!has_projection_star_select_from_table(
        &tokens,
        "transcripts"
    ));
}

fn collect_source_files(directory: &Path, files: &mut Vec<PathBuf>) {
    let entries = fs::read_dir(directory)
        .unwrap_or_else(|error| panic!("read source directory {}: {error}", directory.display()));
    for entry in entries {
        let entry = entry.unwrap_or_else(|error| panic!("read source directory entry: {error}"));
        let path = entry.path();
        if path.is_dir() {
            collect_source_files(&path, files);
        } else if matches!(
            path.extension().and_then(|extension| extension.to_str()),
            Some("rs" | "py")
        ) {
            files.push(path);
        }
    }
}

fn sql_tokens(source: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut word = String::new();
    for character in source.chars() {
        if character.is_ascii_alphanumeric() || character == '_' {
            word.push(character.to_ascii_lowercase());
            continue;
        }

        if !word.is_empty() {
            tokens.push(std::mem::take(&mut word));
        }
        if matches!(character, '*' | '(' | ')' | '.' | ';') {
            tokens.push(character.to_string());
        }
    }
    if !word.is_empty() {
        tokens.push(word);
    }
    tokens
}

fn has_projection_star_select_from_table(tokens: &[String], table: &str) -> bool {
    for select_index in tokens
        .iter()
        .enumerate()
        .filter_map(|(index, token)| (token == "select").then_some(index))
    {
        let mut parenthesis_depth = 0_u32;
        let mut has_projection_star = false;
        for (index, token) in tokens.iter().enumerate().skip(select_index + 1) {
            match token.as_str() {
                "(" => parenthesis_depth += 1,
                ")" if parenthesis_depth == 0 => break,
                ")" => parenthesis_depth -= 1,
                "*" if parenthesis_depth == 0 => has_projection_star = true,
                "from" if parenthesis_depth == 0 => {
                    if has_projection_star && from_targets_table(tokens, index, table) {
                        return true;
                    }
                    break;
                }
                "select" | ";" if parenthesis_depth == 0 => break,
                _ => {}
            }
        }
    }
    false
}

fn from_targets_table(tokens: &[String], from_index: usize, table: &str) -> bool {
    tokens
        .get(from_index + 1)
        .is_some_and(|token| token == table)
        || (tokens.get(from_index + 2).is_some_and(|token| token == ".")
            && tokens
                .get(from_index + 3)
                .is_some_and(|token| token == table))
}
