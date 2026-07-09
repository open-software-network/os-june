use chrono::{SecondsFormat, Utc};
use os_june_lib::db::{migrations::run_migrations, repositories::Repositories};
use sqlx::query::query;
use sqlx_sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use std::str::FromStr;
use tempfile::tempdir;

async fn test_repositories() -> Repositories {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .expect("in-memory sqlite should open");
    run_migrations(&pool).await.expect("migrations should run");
    Repositories::new(pool)
}

#[tokio::test]
async fn migrations_create_empty_store() {
    let repos = test_repositories().await;

    let folders = repos
        .list_folders("default")
        .await
        .expect("folders list should load");
    let notes = repos
        .list_notes("default", None, 50, None)
        .await
        .expect("notes list should load");

    assert!(folders.is_empty());
    assert!(notes.items.is_empty());
}

#[tokio::test]
async fn p3a_counters_increment_and_clear() {
    let repos = test_repositories().await;

    let first = repos
        .increment_p3a_counter("dictation.sessions", "2026-W28", 1)
        .await
        .expect("counter should increment");
    assert_eq!(first.raw_value, 1);
    assert_eq!(first.reported_value, 0);

    let second = repos
        .increment_p3a_counter("dictation.sessions", "2026-W28", 2)
        .await
        .expect("counter should increment again");
    assert_eq!(second.raw_value, 3);
    assert_eq!(second.reported_value, 0);

    assert_eq!(
        repos
            .p3a_counter_value("dictation.sessions", "2026-W28")
            .await
            .expect("counter should load"),
        Some(3),
    );
    repos
        .mark_p3a_events_reported("dictation.sessions", "2026-W28", 2)
        .await
        .expect("reported cursor should save");

    assert_eq!(
        repos
            .p3a_counter_state("dictation.sessions", "2026-W28")
            .await
            .expect("counter state should load")
            .map(|state| state.reported_value),
        Some(2),
    );
    let pending = repos
        .unreported_p3a_counters()
        .await
        .expect("pending counters should load");
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].question_id, "dictation.sessions");
    assert_eq!(pending[0].epoch, "2026-W28");
    assert_eq!(pending[0].raw_value, 3);
    assert_eq!(pending[0].reported_value, 2);

    repos
        .clear_p3a_counters()
        .await
        .expect("counters should clear");

    assert_eq!(
        repos
            .p3a_counter_value("dictation.sessions", "2026-W28")
            .await
            .expect("counter should load after clear"),
        None,
    );
}

#[tokio::test]
async fn migrations_tolerate_concurrent_startup() {
    let dir = tempdir().expect("tempdir");
    let database_path = dir.path().join("notes.sqlite3");
    let url = format!("sqlite://{}", database_path.display());
    let mut handles = Vec::new();

    for _ in 0..8 {
        let url = url.clone();
        handles.push(tokio::spawn(async move {
            let options = SqliteConnectOptions::from_str(&url)
                .expect("sqlite options")
                .create_if_missing(true);
            let pool = SqlitePoolOptions::new()
                .max_connections(2)
                .connect_with(options)
                .await
                .expect("sqlite file should open");
            run_migrations(&pool).await
        }));
    }

    for handle in handles {
        handle
            .await
            .expect("migration task should finish")
            .expect("concurrent migrations should be idempotent");
    }
}

#[tokio::test]
async fn notes_and_folders_are_partitioned_by_profile() {
    let repos = test_repositories().await;
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);

    let folder_a = repos
        .create_folder("a", "Profile A folder", None)
        .await
        .expect("profile a folder");
    let folder_b = repos
        .create_folder("b", "Profile B folder", None)
        .await
        .expect("profile b folder");
    let note_a = repos
        .create_note("a", Some(folder_a.id.clone()))
        .await
        .expect("profile a note");
    let note_b = repos
        .create_note("b", Some(folder_b.id.clone()))
        .await
        .expect("profile b note");

    query(
        "INSERT INTO folders (id, name, created_at, updated_at)
         VALUES ('legacy-folder', 'Legacy folder', ?, ?)",
    )
    .bind(&now)
    .bind(&now)
    .execute(&repos.pool)
    .await
    .expect("legacy folder insert without profile");
    query(
        "INSERT INTO notes (id, title, processing_status, created_at, updated_at)
         VALUES ('legacy-note', 'Legacy note', 'draft', ?, ?)",
    )
    .bind(&now)
    .bind(&now)
    .execute(&repos.pool)
    .await
    .expect("legacy note insert without profile");

    let folders_a = repos.list_folders("a").await.expect("profile a folders");
    let folders_b = repos.list_folders("b").await.expect("profile b folders");
    let default_folders = repos
        .list_folders("default")
        .await
        .expect("default folders");
    assert_eq!(
        folders_a
            .iter()
            .map(|folder| &folder.id)
            .collect::<Vec<_>>(),
        vec![&folder_a.id]
    );
    assert_eq!(
        folders_b
            .iter()
            .map(|folder| &folder.id)
            .collect::<Vec<_>>(),
        vec![&folder_b.id]
    );
    assert_eq!(
        default_folders
            .iter()
            .map(|folder| folder.id.as_str())
            .collect::<Vec<_>>(),
        vec!["legacy-folder"]
    );

    let notes_a = repos
        .list_notes("a", None, 50, None)
        .await
        .expect("profile a notes");
    let notes_b = repos
        .list_notes("b", None, 50, None)
        .await
        .expect("profile b notes");
    let default_notes = repos
        .list_notes("default", None, 50, None)
        .await
        .expect("default notes");
    assert_eq!(
        notes_a
            .items
            .iter()
            .map(|note| &note.id)
            .collect::<Vec<_>>(),
        vec![&note_a.id]
    );
    assert_eq!(
        notes_b
            .items
            .iter()
            .map(|note| &note.id)
            .collect::<Vec<_>>(),
        vec![&note_b.id]
    );
    assert_eq!(
        default_notes
            .items
            .iter()
            .map(|note| note.id.as_str())
            .collect::<Vec<_>>(),
        vec!["legacy-note"]
    );

    let folder_notes_a = repos
        .list_notes("a", Some(folder_a.id.clone()), 50, None)
        .await
        .expect("profile a folder notes");
    let folder_notes_b = repos
        .list_notes("b", Some(folder_a.id), 50, None)
        .await
        .expect("profile b folder notes");
    assert_eq!(
        folder_notes_a
            .items
            .iter()
            .map(|note| &note.id)
            .collect::<Vec<_>>(),
        vec![&note_a.id]
    );
    assert!(folder_notes_b.items.is_empty());
}

#[tokio::test]
async fn dictation_history_is_partitioned_by_profile() {
    let repos = test_repositories().await;
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);

    let item_a = repos
        .create_dictation_history_item("a", "Profile A dictation.", None, "openai")
        .await
        .expect("profile a history create")
        .expect("profile a history item");
    let item_b = repos
        .create_dictation_history_item("b", "Profile B dictation.", None, "openai")
        .await
        .expect("profile b history create")
        .expect("profile b history item");
    query(
        "INSERT INTO dictation_history (id, text, language, provider, created_at)
         VALUES ('legacy-dictation', 'Legacy dictation.', NULL, 'openai', ?)",
    )
    .bind(&now)
    .execute(&repos.pool)
    .await
    .expect("legacy dictation insert without profile");

    let history_a = repos
        .list_dictation_history("a", 50)
        .await
        .expect("profile a history");
    let history_b = repos
        .list_dictation_history("b", 50)
        .await
        .expect("profile b history");
    let default_history = repos
        .list_dictation_history("default", 50)
        .await
        .expect("default history");

    assert_eq!(
        history_a
            .items
            .iter()
            .map(|item| &item.id)
            .collect::<Vec<_>>(),
        vec![&item_a.id]
    );
    assert_eq!(
        history_b
            .items
            .iter()
            .map(|item| &item.id)
            .collect::<Vec<_>>(),
        vec![&item_b.id]
    );
    assert_eq!(
        default_history
            .items
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>(),
        vec!["legacy-dictation"]
    );
}

#[tokio::test]
async fn creates_notes_in_reverse_chronological_order() {
    let repos = test_repositories().await;

    let first = repos
        .create_note("default", None)
        .await
        .expect("first note");
    let second = repos
        .create_note("default", None)
        .await
        .expect("second note");

    let notes = repos
        .list_notes("default", None, 50, None)
        .await
        .expect("notes list should load");

    assert_eq!(notes.items.len(), 2);
    assert_eq!(notes.items[0].id, second.id);
    assert_eq!(notes.items[1].id, first.id);
}

#[tokio::test]
async fn creates_folders_and_assigns_notes_without_removing_all_notes_visibility() {
    let repos = test_repositories().await;
    let folder = repos
        .create_folder("default", "Field Notes", None)
        .await
        .expect("folder should be created");
    let note = repos
        .create_note("default", Some(folder.id.clone()))
        .await
        .expect("note should be created");

    let all_notes = repos
        .list_notes("default", None, 50, None)
        .await
        .expect("all notes should load");
    let folder_notes = repos
        .list_notes("default", Some(folder.id.clone()), 50, None)
        .await
        .expect("folder notes should load");

    assert_eq!(
        all_notes
            .items
            .iter()
            .map(|item| &item.id)
            .collect::<Vec<_>>(),
        vec![&note.id]
    );
    assert_eq!(
        folder_notes
            .items
            .iter()
            .map(|item| &item.id)
            .collect::<Vec<_>>(),
        vec![&note.id]
    );
    assert_eq!(folder_notes.items[0].folder_ids, vec![folder.id]);
}

#[tokio::test]
async fn deletes_note_and_removes_folder_assignment() {
    let repos = test_repositories().await;
    let folder = repos
        .create_folder("default", "Calls", None)
        .await
        .expect("folder");
    let note = repos
        .create_note("default", Some(folder.id.clone()))
        .await
        .expect("note");

    repos.delete_note(&note.id).await.expect("delete note");

    let all_notes = repos
        .list_notes("default", None, 50, None)
        .await
        .expect("all notes should load");
    let folder_notes = repos
        .list_notes("default", Some(folder.id), 50, None)
        .await
        .expect("folder notes should load");

    assert!(all_notes.items.is_empty());
    assert!(folder_notes.items.is_empty());
}
