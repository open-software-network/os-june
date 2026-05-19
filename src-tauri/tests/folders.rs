use os_notetaker_lib::db::{migrations::run_migrations, repositories::Repositories};
use sqlx::sqlite::SqlitePoolOptions;

async fn repos() -> Repositories {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .expect("sqlite memory");
    run_migrations(&pool).await.expect("migrations");
    Repositories::new(pool)
}

#[tokio::test]
async fn rejects_duplicate_active_folder_names() {
    let repos = repos().await;
    repos.create_folder("Ideas").await.expect("first folder");

    let duplicate = repos.create_folder("Ideas").await;

    assert!(duplicate.is_err());
}

#[tokio::test]
async fn assigning_and_removing_folder_keeps_note_in_all_notes() {
    let repos = repos().await;
    let note = repos.create_note(None).await.expect("note");
    let folder = repos.create_folder("Work").await.expect("folder");

    let assigned = repos
        .assign_note_to_folder(&note.id, &folder.id)
        .await
        .expect("assign");
    assert_eq!(assigned.folder_ids, vec![folder.id.clone()]);

    let removed = repos
        .remove_note_from_folder(&note.id, &folder.id)
        .await
        .expect("remove");
    assert!(removed.folder_ids.is_empty());

    let all_notes = repos.list_notes(None, 50, None).await.expect("all notes");
    assert_eq!(all_notes.items.len(), 1);
    assert_eq!(all_notes.items[0].id, note.id);
}
