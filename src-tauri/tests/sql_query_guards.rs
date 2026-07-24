use std::{
    fs,
    path::{Path, PathBuf},
};

const COLUMN_ORDER_DIVERGENT_TABLES: &[&str] = &["transcripts", "folders"];

#[test]
fn column_order_divergent_tables_never_use_unqualified_star_selects() {
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
            if has_unqualified_star_select(&tokens, table) {
                let relative_path = path.strip_prefix(&source_root).unwrap_or(&path).display();
                violations.push(format!("{relative_path}: SELECT * FROM {table}"));
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
fn star_select_guard_is_case_and_whitespace_insensitive() {
    let tokens = sql_tokens("SeLeCt\n  *\tFROM\ntranscripts");
    assert!(has_unqualified_star_select(&tokens, "transcripts"));

    let tokens = sql_tokens("SELECT id, text FROM transcripts");
    assert!(!has_unqualified_star_select(&tokens, "transcripts"));
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
        if character == '*' {
            tokens.push("*".to_string());
        }
    }
    if !word.is_empty() {
        tokens.push(word);
    }
    tokens
}

fn has_unqualified_star_select(tokens: &[String], table: &str) -> bool {
    tokens.windows(4).any(|window| {
        window[0] == "select" && window[1] == "*" && window[2] == "from" && window[3] == table
    })
}
