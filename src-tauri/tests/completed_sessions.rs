use os_june_lib::db::{migrations::run_migrations, repositories::Repositories};
use sqlx_sqlite::SqlitePoolOptions;

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
async fn marking_session_complete_lists_it_with_a_timestamp() {
    let repos = repos().await;

    repos
        .set_session_completed("hermes-session-1", true)
        .await
        .expect("mark complete");

    let completed = repos.list_completed_sessions().await.expect("list");
    assert_eq!(completed.len(), 1);
    assert_eq!(completed[0].session_id, "hermes-session-1");
    assert!(!completed[0].completed_at.is_empty());
}

#[tokio::test]
async fn marking_session_incomplete_removes_it() {
    let repos = repos().await;
    repos
        .set_session_completed("hermes-session-1", true)
        .await
        .expect("mark complete");

    repos
        .set_session_completed("hermes-session-1", false)
        .await
        .expect("mark incomplete");

    assert!(repos
        .list_completed_sessions()
        .await
        .expect("list after removal")
        .is_empty());
}

#[tokio::test]
async fn marking_same_session_complete_twice_is_idempotent() {
    let repos = repos().await;

    repos
        .set_session_completed("hermes-session-1", true)
        .await
        .expect("mark complete");
    let first = repos.list_completed_sessions().await.expect("list");
    let first_completed_at = first[0].completed_at.clone();

    repos
        .set_session_completed("hermes-session-1", true)
        .await
        .expect("mark complete twice");

    let completed = repos.list_completed_sessions().await.expect("list");
    assert_eq!(completed.len(), 1);
    assert_eq!(completed[0].session_id, "hermes-session-1");
    // Re-marking preserves the original completion time (does not re-sort).
    assert_eq!(completed[0].completed_at, first_completed_at);
}
