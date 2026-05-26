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
async fn creates_updates_and_soft_deletes_dictionary_entries() {
    let repos = repos().await;
    let created = repos
        .create_dictionary_entry("  Junho Hong  ")
        .await
        .expect("create dictionary entry");

    assert_eq!(created.phrase, "Junho Hong");

    let updated = repos
        .update_dictionary_entry(&created.id, "OpenAI")
        .await
        .expect("update dictionary entry");
    assert_eq!(updated.phrase, "OpenAI");

    let listed = repos
        .list_dictionary_entries()
        .await
        .expect("list dictionary");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, created.id);

    repos
        .delete_dictionary_entry(&created.id)
        .await
        .expect("delete dictionary entry");
    let listed = repos
        .list_dictionary_entries()
        .await
        .expect("list dictionary after delete");
    assert!(listed.is_empty());
}
