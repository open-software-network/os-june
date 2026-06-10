use os_scribe_lib::db::{migrations::run_migrations, repositories::Repositories};
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
async fn allows_duplicate_folder_names_with_distinct_ids() {
    let repos = repos().await;
    let first = repos
        .create_folder("Ideas", None)
        .await
        .expect("first folder");
    let second = repos
        .create_folder("Ideas", None)
        .await
        .expect("second folder allowed");

    assert_ne!(first.id, second.id);
    let listed = repos.list_folders().await.expect("list");
    let ideas: Vec<_> = listed
        .into_iter()
        .filter(|folder| folder.name == "Ideas")
        .collect();
    assert_eq!(ideas.len(), 2);
}

#[tokio::test]
async fn assigning_and_removing_folder_keeps_note_in_all_notes() {
    let repos = repos().await;
    let note = repos.create_note(None).await.expect("note");
    let folder = repos.create_folder("Work", None).await.expect("folder");

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

#[tokio::test]
async fn deleting_folder_without_notes_keeps_associated_notes() {
    let repos = repos().await;
    let folder = repos.create_folder("Work", None).await.expect("folder");
    let note = repos
        .create_note(Some(folder.id.clone()))
        .await
        .expect("note");

    repos
        .delete_folder(&folder.id, false)
        .await
        .expect("delete folder");

    let folders = repos.list_folders().await.expect("folders");
    assert!(folders.is_empty());

    let all_notes = repos.list_notes(None, 50, None).await.expect("all notes");
    assert_eq!(all_notes.items.len(), 1);
    assert_eq!(all_notes.items[0].id, note.id);
    assert!(all_notes.items[0].folder_ids.is_empty());
}

#[tokio::test]
async fn deleting_folder_with_notes_removes_associated_notes() {
    let repos = repos().await;
    let folder = repos.create_folder("Work", None).await.expect("folder");
    repos
        .create_note(Some(folder.id.clone()))
        .await
        .expect("note");

    repos
        .delete_folder(&folder.id, true)
        .await
        .expect("delete folder and notes");

    let folders = repos.list_folders().await.expect("folders");
    assert!(folders.is_empty());

    let all_notes = repos.list_notes(None, 50, None).await.expect("all notes");
    assert!(all_notes.items.is_empty());
}

#[tokio::test]
async fn renaming_missing_folder_returns_descriptive_error() {
    let repos = repos().await;
    let error = repos
        .rename_folder("missing-folder", "Renamed", None)
        .await
        .expect_err("missing folder should fail");

    assert_eq!(error.code, "folder_not_found");
    assert_eq!(
        error.message,
        "Folder was not found or has already been deleted."
    );
}

#[tokio::test]
async fn assigning_and_removing_session_folders_round_trips() {
    let repos = repos().await;
    let folder = repos.create_folder("Launch", None).await.expect("folder");

    repos
        .assign_session_to_folder("hermes-session-1", &folder.id)
        .await
        .expect("assign session");
    // Re-assigning is a no-op rather than an error.
    repos
        .assign_session_to_folder("hermes-session-1", &folder.id)
        .await
        .expect("assign session twice");

    let assignments = repos.list_session_folders().await.expect("list");
    assert_eq!(assignments.len(), 1);
    assert_eq!(assignments[0].session_id, "hermes-session-1");
    assert_eq!(assignments[0].folder_id, folder.id);

    repos
        .remove_session_from_folder("hermes-session-1", &folder.id)
        .await
        .expect("remove session");
    assert!(repos
        .list_session_folders()
        .await
        .expect("list after remove")
        .is_empty());
}

#[tokio::test]
async fn deleting_folder_drops_its_session_assignments() {
    let repos = repos().await;
    let folder = repos.create_folder("Launch", None).await.expect("folder");
    repos
        .assign_session_to_folder("hermes-session-1", &folder.id)
        .await
        .expect("assign session");

    repos
        .delete_folder(&folder.id, false)
        .await
        .expect("delete folder");

    assert!(repos
        .list_session_folders()
        .await
        .expect("list after folder delete")
        .is_empty());
}
