use chrono::{Duration, SecondsFormat, Utc};
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
async fn dictation_history_keeps_recent_items_and_prunes_old_items() {
    let repos = repos().await;
    let old_created_at =
        (Utc::now() - Duration::days(8)).to_rfc3339_opts(SecondsFormat::Millis, true);

    sqlx::query(
        "INSERT INTO dictation_history (id, text, language, provider, created_at)
         VALUES ('old', 'Old dictation', NULL, 'openai', ?)",
    )
    .bind(old_created_at)
    .execute(&repos.pool)
    .await
    .expect("insert old history item");

    let created = repos
        .create_dictation_history_item("  Recent dictation.  ", Some("en".to_string()), "openai")
        .await
        .expect("create history item")
        .expect("non-empty dictation should be stored");

    assert_eq!(created.text, "Recent dictation.");

    let history = repos
        .list_dictation_history(50)
        .await
        .expect("list history");
    assert_eq!(history.retention_days, 7);
    assert_eq!(history.items.len(), 1);
    assert_eq!(history.items[0].id, created.id);
    assert_eq!(history.items[0].language.as_deref(), Some("en"));
}

#[tokio::test]
async fn deletes_a_dictation_history_item() {
    let repos = repos().await;
    let keep = repos
        .create_dictation_history_item("Keep this one.", None, "openai")
        .await
        .expect("create keep item")
        .expect("non-empty dictation should be stored");
    let remove = repos
        .create_dictation_history_item("Remove this one.", None, "openai")
        .await
        .expect("create remove item")
        .expect("non-empty dictation should be stored");

    repos
        .delete_dictation_history_item(&remove.id)
        .await
        .expect("delete history item");

    let history = repos
        .list_dictation_history(50)
        .await
        .expect("list history after delete");
    assert_eq!(history.items.len(), 1);
    assert_eq!(history.items[0].id, keep.id);
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
