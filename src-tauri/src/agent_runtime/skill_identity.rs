use std::{
    collections::BTreeSet,
    fs, io,
    path::{Path, PathBuf},
};

pub const CLOVY_OBSIDIAN_SKILL_ID: &str = "clovy-obsidian";
pub const LEGACY_OBSIDIAN_SKILL_ID: &str = "june-obsidian";
pub const CLOVY_OBSIDIAN_SKILL_DESCRIPTION: &str =
    "Work with the Obsidian vault currently selected in Clovy.";
pub const LEGACY_OBSIDIAN_SKILL_DESCRIPTION: &str =
    "Work with the Obsidian vault currently selected in June.";

pub fn canonical_skill_id(skill_id: &str) -> &str {
    if skill_id == LEGACY_OBSIDIAN_SKILL_ID {
        CLOVY_OBSIDIAN_SKILL_ID
    } else {
        skill_id
    }
}

pub fn canonical_skill_ids<'a>(skill_ids: impl IntoIterator<Item = &'a str>) -> BTreeSet<String> {
    skill_ids
        .into_iter()
        .map(canonical_skill_id)
        .map(str::to_string)
        .collect()
}

pub fn compatible_skill_ids<'a>(skill_ids: impl IntoIterator<Item = &'a str>) -> BTreeSet<String> {
    let canonical = canonical_skill_ids(skill_ids);
    let mut compatible = canonical.clone();
    if canonical.contains(CLOVY_OBSIDIAN_SKILL_ID) {
        compatible.insert(LEGACY_OBSIDIAN_SKILL_ID.to_string());
    }
    compatible
}

pub fn read_skill_ids(skill_id: &str) -> Vec<&str> {
    let canonical = canonical_skill_id(skill_id);
    if canonical == CLOVY_OBSIDIAN_SKILL_ID {
        vec![CLOVY_OBSIDIAN_SKILL_ID, LEGACY_OBSIDIAN_SKILL_ID]
    } else {
        vec![canonical]
    }
}

pub fn write_skill_ids(skill_id: &str) -> Vec<&str> {
    let canonical = canonical_skill_id(skill_id);
    if canonical == CLOVY_OBSIDIAN_SKILL_ID {
        vec![LEGACY_OBSIDIAN_SKILL_ID, CLOVY_OBSIDIAN_SKILL_ID]
    } else {
        vec![canonical]
    }
}

pub fn skill_file(root: &Path, skill_id: &str) -> PathBuf {
    root.join(skill_id).join("SKILL.md")
}

/// Reconciles the managed Obsidian skill before the bundled resource is seeded.
///
/// The legacy path is rollback-readable, so it wins whenever both copies exist.
/// Clovy writes that path first and the canonical path second; a legacy-only
/// change therefore means either an upgrade from June or an edit made after a
/// rollback. A canonical-only copy is mirrored back so an older app can still
/// load the skill.
pub fn reconcile_managed_obsidian_skill(root: &Path) -> io::Result<()> {
    let canonical = skill_file(root, CLOVY_OBSIDIAN_SKILL_ID);
    let legacy = skill_file(root, LEGACY_OBSIDIAN_SKILL_ID);
    if legacy.is_file() {
        let content = migrate_known_legacy_obsidian_presentation(&fs::read_to_string(&legacy)?);
        write_skill_file(&legacy, &content, LEGACY_OBSIDIAN_SKILL_ID)?;
        write_skill_file(&canonical, &content, CLOVY_OBSIDIAN_SKILL_ID)
    } else if canonical.is_file() {
        let content = migrate_known_legacy_obsidian_presentation(&fs::read_to_string(&canonical)?);
        write_skill_file(&canonical, &content, CLOVY_OBSIDIAN_SKILL_ID)?;
        write_skill_file(&legacy, &content, LEGACY_OBSIDIAN_SKILL_ID)
    } else {
        Ok(())
    }
}

fn migrate_known_legacy_obsidian_presentation(content: &str) -> String {
    content
        .replace(
            LEGACY_OBSIDIAN_SKILL_DESCRIPTION,
            CLOVY_OBSIDIAN_SKILL_DESCRIPTION,
        )
        .replace("# June Obsidian vault", "# Clovy Obsidian vault")
        .replace(
            "no Obsidian vault is connected in\n  June. Do not guess a default path.",
            "no Obsidian vault is connected in\n  Clovy. Do not guess a default path.",
        )
}

pub fn skill_content_for_id(content: &str, skill_id: &str) -> String {
    let mut lines = content.split_inclusive('\n').peekable();
    let Some(first) = lines.next() else {
        return format!("---\nname: {skill_id}\n---\n");
    };
    if first.trim_end_matches(['\r', '\n']) != "---" {
        return format!("---\nname: {skill_id}\n---\n\n{content}");
    }

    let newline = if first.ends_with("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let mut output = first.to_string();
    let mut found_name = false;
    let mut closed_frontmatter = false;
    for line in lines {
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if !closed_frontmatter && trimmed.trim() == "---" {
            if !found_name {
                output.push_str(&format!("name: {skill_id}{newline}"));
            }
            output.push_str(line);
            closed_frontmatter = true;
            continue;
        }
        if !closed_frontmatter
            && trimmed
                .split_once(':')
                .is_some_and(|(key, _)| key.trim() == "name")
        {
            let indentation = &trimmed[..trimmed.len() - trimmed.trim_start().len()];
            output.push_str(indentation);
            output.push_str("name: ");
            output.push_str(skill_id);
            if line.ends_with("\r\n") {
                output.push_str("\r\n");
            } else if line.ends_with('\n') {
                output.push('\n');
            }
            found_name = true;
        } else {
            output.push_str(line);
        }
    }
    output
}

fn write_skill_file(destination: &Path, content: &str, skill_id: &str) -> io::Result<()> {
    let content = skill_content_for_id(content, skill_id);
    if fs::read_to_string(destination).ok().as_deref() == Some(content.as_str()) {
        return Ok(());
    }
    let parent = destination.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "skill path has no parent directory",
        )
    })?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(".SKILL.md.clovy-identity.tmp");
    fs::write(&temporary, content)?;
    if let Err(error) = fs::rename(&temporary, destination) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn released_obsidian_presentation_is_migrated_without_touching_custom_june_text() {
        let root = tempfile::tempdir().expect("managed skill root");
        let legacy = skill_file(root.path(), LEGACY_OBSIDIAN_SKILL_ID);
        fs::create_dir_all(legacy.parent().expect("legacy parent")).expect("legacy directory");
        fs::write(
            &legacy,
            format!(
                "---\nname: june-obsidian\ndescription: {LEGACY_OBSIDIAN_SKILL_DESCRIPTION}\n---\n\n# June Obsidian vault\n\nIf no Obsidian vault is connected in\n  June. Do not guess a default path.\n\nKeep the note about June Carter.\n"
            ),
        )
        .expect("legacy skill");

        reconcile_managed_obsidian_skill(root.path()).expect("migrate legacy presentation");

        let canonical = fs::read_to_string(skill_file(root.path(), CLOVY_OBSIDIAN_SKILL_ID))
            .expect("canonical skill");
        let legacy = fs::read_to_string(legacy).expect("legacy skill remains");
        for content in [canonical, legacy] {
            assert!(content.contains(CLOVY_OBSIDIAN_SKILL_DESCRIPTION));
            assert!(content.contains("# Clovy Obsidian vault"));
            assert!(content.contains("connected in\n  Clovy. Do not guess"));
            assert!(content.contains("June Carter"));
            assert!(!content.contains(LEGACY_OBSIDIAN_SKILL_DESCRIPTION));
            assert!(!content.contains("# June Obsidian vault"));
        }
    }

    #[test]
    fn legacy_managed_edits_are_promoted_and_remain_rollback_readable() {
        let root = tempfile::tempdir().expect("managed skill root");
        let legacy = skill_file(root.path(), LEGACY_OBSIDIAN_SKILL_ID);
        fs::create_dir_all(legacy.parent().expect("legacy parent")).expect("legacy directory");
        fs::write(
            &legacy,
            "---\nname: june-obsidian\ndescription: User description\ncustom: keep-me\n---\n\nUser-edited body\n",
        )
        .expect("legacy skill");

        reconcile_managed_obsidian_skill(root.path()).expect("promote legacy skill");

        let canonical = fs::read_to_string(skill_file(root.path(), CLOVY_OBSIDIAN_SKILL_ID))
            .expect("canonical skill");
        let legacy = fs::read_to_string(legacy).expect("legacy skill remains");
        assert!(canonical.contains("name: clovy-obsidian"));
        assert!(legacy.contains("name: june-obsidian"));
        for content in [canonical, legacy] {
            assert!(content.contains("description: User description"));
            assert!(content.contains("custom: keep-me"));
            assert!(content.ends_with("User-edited body\n"));
        }
    }

    #[test]
    fn legacy_copy_wins_after_a_rollback_edit() {
        let root = tempfile::tempdir().expect("managed skill root");
        let canonical = skill_file(root.path(), CLOVY_OBSIDIAN_SKILL_ID);
        let legacy = skill_file(root.path(), LEGACY_OBSIDIAN_SKILL_ID);
        fs::create_dir_all(canonical.parent().expect("canonical parent"))
            .expect("canonical directory");
        fs::create_dir_all(legacy.parent().expect("legacy parent")).expect("legacy directory");
        fs::write(
            &canonical,
            "---\nname: clovy-obsidian\n---\n\nstale canonical instructions",
        )
        .expect("canonical skill");
        fs::write(
            &legacy,
            "---\nname: june-obsidian\n---\n\nedited after rollback",
        )
        .expect("legacy skill");

        reconcile_managed_obsidian_skill(root.path()).expect("reconcile rollback edit");

        assert_eq!(
            fs::read_to_string(canonical).expect("canonical skill"),
            "---\nname: clovy-obsidian\n---\n\nedited after rollback"
        );
        assert_eq!(
            fs::read_to_string(legacy).expect("legacy skill"),
            "---\nname: june-obsidian\n---\n\nedited after rollback"
        );
    }

    #[test]
    fn canonical_only_skill_is_mirrored_for_rollback() {
        let root = tempfile::tempdir().expect("managed skill root");
        let canonical = skill_file(root.path(), CLOVY_OBSIDIAN_SKILL_ID);
        fs::create_dir_all(canonical.parent().expect("canonical parent"))
            .expect("canonical directory");
        fs::write(
            &canonical,
            "---\nname: clovy-obsidian\n---\n\ncanonical instructions",
        )
        .expect("canonical skill");

        reconcile_managed_obsidian_skill(root.path()).expect("mirror canonical skill");

        assert_eq!(
            fs::read_to_string(skill_file(root.path(), LEGACY_OBSIDIAN_SKILL_ID))
                .expect("legacy alias"),
            "---\nname: june-obsidian\n---\n\ncanonical instructions"
        );
    }

    #[test]
    fn persisted_ids_are_canonical_in_memory_and_additive_on_disk() {
        let legacy = [LEGACY_OBSIDIAN_SKILL_ID, "research"];
        assert_eq!(
            canonical_skill_ids(legacy),
            BTreeSet::from([CLOVY_OBSIDIAN_SKILL_ID.to_string(), "research".to_string()])
        );
        assert_eq!(
            compatible_skill_ids(legacy),
            BTreeSet::from([
                CLOVY_OBSIDIAN_SKILL_ID.to_string(),
                LEGACY_OBSIDIAN_SKILL_ID.to_string(),
                "research".to_string()
            ])
        );
    }
}
