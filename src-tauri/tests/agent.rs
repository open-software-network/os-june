use os_scribe_lib::{
    db::{migrations::run_migrations, repositories::Repositories},
    domain::types::{AgentSafetyProfile, AgentTaskStatus, AgentToolEventStatus},
};
use sqlx::sqlite::SqlitePoolOptions;

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
async fn creates_agent_task_with_message_and_tool_events() {
    let repos = test_repositories().await;

    let task = repos
        .create_agent_task(
            "Summarize my open desktop windows",
            None,
            AgentSafetyProfile::AutonomousPrivate,
        )
        .await
        .expect("task should be created");
    repos
        .add_agent_tool_event(
            &task.id,
            "local_tool_policy",
            AgentToolEventStatus::Completed,
            "Autonomous private mode is active.",
            None,
            None,
            true,
        )
        .await
        .expect("tool event should be created");

    let loaded = repos
        .get_agent_task(&task.id)
        .await
        .expect("task should load");

    assert_eq!(loaded.status, AgentTaskStatus::Queued);
    assert_eq!(loaded.messages.len(), 1);
    assert_eq!(
        loaded.messages[0].content,
        "Summarize my open desktop windows"
    );
    assert_eq!(loaded.tool_events.len(), 1);
    assert_eq!(loaded.tool_events[0].tool_name, "local_tool_policy");
    assert!(loaded.tool_events[0].redacted);
}

#[tokio::test]
async fn pauses_active_agent_tasks_on_launch() {
    let repos = test_repositories().await;
    let task = repos
        .create_agent_task(
            "Book time to review the design",
            None,
            AgentSafetyProfile::default(),
        )
        .await
        .expect("task should be created");
    repos
        .update_agent_task_status(&task.id, AgentTaskStatus::Running, Some("Working"), None)
        .await
        .expect("task should run");

    repos
        .pause_running_agent_tasks_on_launch()
        .await
        .expect("launch recovery should succeed");

    let loaded = repos
        .get_agent_task(&task.id)
        .await
        .expect("task should load");
    assert_eq!(loaded.status, AgentTaskStatus::Paused);
    assert_eq!(
        loaded.progress_summary.as_deref(),
        Some("Paused when OS Scribe restarted.")
    );
}
