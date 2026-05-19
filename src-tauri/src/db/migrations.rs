use sqlx::SqlitePool;

pub async fn run_migrations(_pool: &SqlitePool) -> Result<(), sqlx::migrate::MigrateError> {
    for statement in include_str!("../../migrations/001_init.sql").split(';') {
        let statement = statement.trim();
        if !statement.is_empty() {
            sqlx::query(statement)
                .execute(_pool)
                .await
                .map_err(sqlx::migrate::MigrateError::Execute)?;
        }
    }
    Ok(())
}
