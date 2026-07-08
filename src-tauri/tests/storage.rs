use os_june_lib::db::{migrations::run_migrations, repositories::Repositories};
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
        .list_folders()
        .await
        .expect("folders list should load");
    let notes = repos
        .list_notes(None, 50, None)
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
    assert_eq!(first.reported_bucket, None);

    let second = repos
        .increment_p3a_counter("dictation.sessions", "2026-W28", 2)
        .await
        .expect("counter should increment again");
    assert_eq!(second.raw_value, 3);
    assert_eq!(second.reported_bucket, None);

    assert_eq!(
        repos
            .p3a_counter_value("dictation.sessions", "2026-W28")
            .await
            .expect("counter should load"),
        Some(3),
    );
    repos
        .mark_p3a_reported("dictation.sessions", "2026-W28", 1)
        .await
        .expect("reported bucket should save");

    assert_eq!(
        repos
            .p3a_counter_state("dictation.sessions", "2026-W28")
            .await
            .expect("counter state should load")
            .map(|state| state.reported_bucket),
        Some(Some(1)),
    );
    repos
        .increment_p3a_counter("agent.sessions", "2026-W27", 1)
        .await
        .expect("older counter should increment");
    let pending = repos
        .unreported_p3a_counters_before("2026-W28")
        .await
        .expect("pending counters should load");
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].question_id, "agent.sessions");
    assert_eq!(pending[0].epoch, "2026-W27");

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
async fn creates_notes_in_reverse_chronological_order() {
    let repos = test_repositories().await;

    let first = repos.create_note(None).await.expect("first note");
    let second = repos.create_note(None).await.expect("second note");

    let notes = repos
        .list_notes(None, 50, None)
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
        .create_folder("Field Notes", None)
        .await
        .expect("folder should be created");
    let note = repos
        .create_note(Some(folder.id.clone()))
        .await
        .expect("note should be created");

    let all_notes = repos
        .list_notes(None, 50, None)
        .await
        .expect("all notes should load");
    let folder_notes = repos
        .list_notes(Some(folder.id.clone()), 50, None)
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
    let folder = repos.create_folder("Calls", None).await.expect("folder");
    let note = repos
        .create_note(Some(folder.id.clone()))
        .await
        .expect("note");

    repos.delete_note(&note.id).await.expect("delete note");

    let all_notes = repos
        .list_notes(None, 50, None)
        .await
        .expect("all notes should load");
    let folder_notes = repos
        .list_notes(Some(folder.id), 50, None)
        .await
        .expect("folder notes should load");

    assert!(all_notes.items.is_empty());
    assert!(folder_notes.items.is_empty());
}
