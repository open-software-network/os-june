use os_june_lib::db::{migrations::run_migrations, repositories::Repositories};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
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
