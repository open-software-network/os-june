use std::collections::HashSet;

use sqlx::query::query;
use sqlx::row::Row;
use sqlx_sqlite::{SqlitePool, SqliteTransaction};

const SCHEMA_MIGRATIONS_TABLE: &str = "schema_migrations";

#[derive(Clone, Copy)]
struct ColumnDefinition {
    name: &'static str,
    definition: &'static str,
}

#[derive(Clone, Copy)]
enum MigrationStep {
    Sql(&'static str),
    EnsureColumns {
        table: &'static str,
        columns: &'static [ColumnDefinition],
    },
    DropIndex(&'static str),
}

#[derive(Clone, Copy)]
enum SchemaRequirement {
    Table(&'static str),
    Index(&'static str),
    Column {
        table: &'static str,
        column: &'static str,
    },
    MissingIndex(&'static str),
}

struct Migration {
    version: i64,
    name: &'static str,
    requirements: &'static [SchemaRequirement],
    steps: &'static [MigrationStep],
}

const SOURCE_SESSION_COLUMNS: &[ColumnDefinition] = &[
    ColumnDefinition {
        name: "source_mode",
        definition: "TEXT NOT NULL DEFAULT 'microphone_only'",
    },
    ColumnDefinition {
        name: "permission_summary",
        definition: "TEXT",
    },
];
const SOURCE_ARTIFACT_COLUMNS: &[ColumnDefinition] = &[
    ColumnDefinition {
        name: "source",
        definition: "TEXT NOT NULL DEFAULT 'microphone'",
    },
    ColumnDefinition {
        name: "partial_path",
        definition: "TEXT",
    },
    ColumnDefinition {
        name: "status",
        definition: "TEXT NOT NULL DEFAULT 'valid'",
    },
    ColumnDefinition {
        name: "expected_duration_ms",
        definition: "INTEGER NOT NULL DEFAULT 0",
    },
    ColumnDefinition {
        name: "validation_summary",
        definition: "TEXT",
    },
    ColumnDefinition {
        name: "last_error",
        definition: "TEXT",
    },
];
const SOURCE_TRANSCRIPT_COLUMNS: &[ColumnDefinition] = &[
    ColumnDefinition {
        name: "recording_session_id",
        definition: "TEXT",
    },
    ColumnDefinition {
        name: "source_artifact_id",
        definition: "TEXT",
    },
    ColumnDefinition {
        name: "source",
        definition: "TEXT",
    },
    ColumnDefinition {
        name: "source_mode",
        definition: "TEXT NOT NULL DEFAULT 'microphone_only'",
    },
];
const SOURCE_CHECKPOINT_COLUMNS: &[ColumnDefinition] = &[
    ColumnDefinition {
        name: "source",
        definition: "TEXT",
    },
    ColumnDefinition {
        name: "source_artifact_id",
        definition: "TEXT",
    },
];
const TRANSCRIPT_TURN_COLUMNS: &[ColumnDefinition] = &[
    ColumnDefinition {
        name: "start_ms",
        definition: "INTEGER",
    },
    ColumnDefinition {
        name: "end_ms",
        definition: "INTEGER",
    },
    ColumnDefinition {
        name: "turn_index",
        definition: "INTEGER",
    },
];
const FOLDER_DESCRIPTION_COLUMN: &[ColumnDefinition] = &[ColumnDefinition {
    name: "description",
    definition: "TEXT",
}];
const AGENT_TASK_SESSION_COLUMN: &[ColumnDefinition] = &[ColumnDefinition {
    name: "hermes_session_id",
    definition: "TEXT",
}];
const AGENT_MESSAGE_IDENTITY_COLUMN: &[ColumnDefinition] = &[ColumnDefinition {
    name: "external_id",
    definition: "TEXT",
}];
const P3A_REPORTING_COLUMNS: &[ColumnDefinition] = &[
    ColumnDefinition {
        name: "reported_value",
        definition: "INTEGER NOT NULL DEFAULT 0",
    },
    ColumnDefinition {
        name: "reported_at",
        definition: "TEXT",
    },
];
const PROFILE_COLUMN: &[ColumnDefinition] = &[ColumnDefinition {
    name: "profile",
    definition: "TEXT NOT NULL DEFAULT 'default'",
}];
const ROUTINE_APPROVAL_COLUMN: &[ColumnDefinition] = &[ColumnDefinition {
    name: "approval_since",
    definition: "TEXT",
}];
const FOLDER_MEMORY_COLUMNS: &[ColumnDefinition] = &[
    ColumnDefinition {
        name: "instructions",
        definition: "TEXT",
    },
    ColumnDefinition {
        name: "memory_disabled",
        definition: "INTEGER NOT NULL DEFAULT 0",
    },
];
const TRANSCRIPT_SPAN_COLUMN: &[ColumnDefinition] = &[ColumnDefinition {
    name: "span_id",
    definition: "TEXT",
}];
const CONNECTOR_METADATA_COLUMN: &[ColumnDefinition] = &[ColumnDefinition {
    name: "metadata",
    definition: "TEXT NOT NULL DEFAULT '{}'",
}];
const NOTE_CALENDAR_COLUMNS: &[ColumnDefinition] = &[
    ColumnDefinition {
        name: "calendar_event_id",
        definition: "TEXT",
    },
    ColumnDefinition {
        name: "calendar_event_title",
        definition: "TEXT",
    },
    ColumnDefinition {
        name: "calendar_event_start_at",
        definition: "TEXT",
    },
    ColumnDefinition {
        name: "calendar_event_end_at",
        definition: "TEXT",
    },
    ColumnDefinition {
        name: "calendar_account_email",
        definition: "TEXT",
    },
];
const FOLDER_LOCAL_PATH_COLUMN: &[ColumnDefinition] = &[ColumnDefinition {
    name: "local_path",
    definition: "TEXT",
}];

// IMPORTANT: positions in this catalog are shipped schema versions. They must
// follow the order in which changes reached users, not SQL filename prefixes:
// parallel branches produced duplicate 014 files and later renumbered files
// without changing release chronology. The historical-prefix upgrade test
// models real vintages by slicing this catalog, so reordering an entry would
// invalidate both legacy detection and that test. Append at the end only.
//
// Fresh databases add columns in catalog order, while replay-era databases
// retain the old runner's physical order. In particular,
// transcripts.source_mode is cid 14 on fresh databases but cid 17 on upgraded
// databases; folders.profile precedes local_path when fresh but follows it when
// upgraded. All access must name columns explicitly; never rely on cid order,
// positional decoding, or SELECT *. The integration guard in
// tests/sql_query_guards.rs enforces the projection star-select rule for both
// affected tables, including qualified stars.
const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "initial_schema",
        requirements: &[
            SchemaRequirement::Table("folders"),
            SchemaRequirement::Table("notes"),
            SchemaRequirement::Table("note_folders"),
            SchemaRequirement::Table("recording_sessions"),
            SchemaRequirement::Table("recording_checkpoints"),
            SchemaRequirement::Table("audio_artifacts"),
            SchemaRequirement::Table("transcripts"),
            SchemaRequirement::Table("generation_results"),
            SchemaRequirement::Index("idx_notes_created_at"),
            SchemaRequirement::Index("idx_note_folders_folder"),
            SchemaRequirement::Index("idx_recording_sessions_note"),
            SchemaRequirement::Index("idx_recording_sessions_status"),
        ],
        steps: &[MigrationStep::Sql(include_str!(
            "../../migrations/001_init.sql"
        ))],
    },
    Migration {
        version: 2,
        name: "source_modes",
        requirements: &[
            SchemaRequirement::Column {
                table: "recording_sessions",
                column: "source_mode",
            },
            SchemaRequirement::Column {
                table: "recording_sessions",
                column: "permission_summary",
            },
            SchemaRequirement::Column {
                table: "audio_artifacts",
                column: "source",
            },
            SchemaRequirement::Column {
                table: "audio_artifacts",
                column: "partial_path",
            },
            SchemaRequirement::Column {
                table: "audio_artifacts",
                column: "status",
            },
            SchemaRequirement::Column {
                table: "audio_artifacts",
                column: "expected_duration_ms",
            },
            SchemaRequirement::Column {
                table: "audio_artifacts",
                column: "validation_summary",
            },
            SchemaRequirement::Column {
                table: "audio_artifacts",
                column: "last_error",
            },
            SchemaRequirement::Column {
                table: "transcripts",
                column: "recording_session_id",
            },
            SchemaRequirement::Column {
                table: "transcripts",
                column: "source_artifact_id",
            },
            SchemaRequirement::Column {
                table: "transcripts",
                column: "source",
            },
            SchemaRequirement::Column {
                table: "transcripts",
                column: "source_mode",
            },
            SchemaRequirement::Column {
                table: "recording_checkpoints",
                column: "source",
            },
            SchemaRequirement::Column {
                table: "recording_checkpoints",
                column: "source_artifact_id",
            },
            SchemaRequirement::Index("idx_audio_artifacts_session_source"),
            SchemaRequirement::Index("idx_transcripts_session_source"),
        ],
        steps: &[
            MigrationStep::EnsureColumns {
                table: "recording_sessions",
                columns: SOURCE_SESSION_COLUMNS,
            },
            MigrationStep::EnsureColumns {
                table: "audio_artifacts",
                columns: SOURCE_ARTIFACT_COLUMNS,
            },
            MigrationStep::EnsureColumns {
                table: "transcripts",
                columns: SOURCE_TRANSCRIPT_COLUMNS,
            },
            MigrationStep::EnsureColumns {
                table: "recording_checkpoints",
                columns: SOURCE_CHECKPOINT_COLUMNS,
            },
            MigrationStep::Sql(include_str!("../../migrations/002_source_modes.sql")),
        ],
    },
    Migration {
        version: 3,
        name: "transcript_turns",
        requirements: &[
            SchemaRequirement::Column {
                table: "transcripts",
                column: "start_ms",
            },
            SchemaRequirement::Column {
                table: "transcripts",
                column: "end_ms",
            },
            SchemaRequirement::Column {
                table: "transcripts",
                column: "turn_index",
            },
        ],
        steps: &[MigrationStep::EnsureColumns {
            table: "transcripts",
            columns: TRANSCRIPT_TURN_COLUMNS,
        }],
    },
    Migration {
        version: 4,
        name: "generation_blocks",
        requirements: &[
            SchemaRequirement::Table("note_generation_blocks"),
            SchemaRequirement::Index("idx_note_generation_blocks_session"),
            SchemaRequirement::Index("idx_note_generation_blocks_note_order"),
        ],
        steps: &[MigrationStep::Sql(include_str!(
            "../../migrations/003_generation_blocks.sql"
        ))],
    },
    Migration {
        version: 5,
        name: "folder_descriptions_and_duplicate_names",
        requirements: &[
            SchemaRequirement::Column {
                table: "folders",
                column: "description",
            },
            SchemaRequirement::MissingIndex("idx_folders_active_name"),
        ],
        steps: &[
            MigrationStep::EnsureColumns {
                table: "folders",
                columns: FOLDER_DESCRIPTION_COLUMN,
            },
            MigrationStep::DropIndex("idx_folders_active_name"),
        ],
    },
    Migration {
        version: 6,
        name: "dictionary",
        requirements: &[
            SchemaRequirement::Table("dictionary_entries"),
            SchemaRequirement::Index("idx_dictionary_entries_active_phrase"),
        ],
        steps: &[MigrationStep::Sql(include_str!(
            "../../migrations/004_dictionary.sql"
        ))],
    },
    Migration {
        version: 7,
        name: "dictation_history",
        requirements: &[
            SchemaRequirement::Table("dictation_history"),
            SchemaRequirement::Index("idx_dictation_history_created_at"),
        ],
        steps: &[MigrationStep::Sql(include_str!(
            "../../migrations/005_dictation_history.sql"
        ))],
    },
    Migration {
        version: 8,
        name: "transcript_turn_uniqueness",
        requirements: &[SchemaRequirement::Index(
            "idx_transcripts_session_source_turn",
        )],
        steps: &[MigrationStep::Sql(include_str!(
            "../../migrations/006_transcript_turn_uniqueness.sql"
        ))],
    },
    Migration {
        version: 9,
        name: "agent_workspace",
        requirements: &[
            SchemaRequirement::Table("agent_tasks"),
            SchemaRequirement::Table("agent_messages"),
            SchemaRequirement::Table("agent_tool_events"),
            SchemaRequirement::Index("idx_agent_tasks_updated_at"),
            SchemaRequirement::Index("idx_agent_tasks_status"),
            SchemaRequirement::Index("idx_agent_messages_task_created"),
            SchemaRequirement::Index("idx_agent_tool_events_task_created"),
        ],
        steps: &[MigrationStep::Sql(include_str!(
            "../../migrations/007_agent.sql"
        ))],
    },
    Migration {
        version: 10,
        name: "agent_task_session_identity",
        requirements: &[SchemaRequirement::Column {
            table: "agent_tasks",
            column: "hermes_session_id",
        }],
        steps: &[MigrationStep::EnsureColumns {
            table: "agent_tasks",
            columns: AGENT_TASK_SESSION_COLUMN,
        }],
    },
    Migration {
        version: 11,
        name: "agent_message_identity",
        requirements: &[
            SchemaRequirement::Column {
                table: "agent_messages",
                column: "external_id",
            },
            SchemaRequirement::Index("idx_agent_messages_task_external_id"),
        ],
        steps: &[
            MigrationStep::EnsureColumns {
                table: "agent_messages",
                columns: AGENT_MESSAGE_IDENTITY_COLUMN,
            },
            MigrationStep::Sql(include_str!(
                "../../migrations/008_agent_message_identity.sql"
            )),
        ],
    },
    Migration {
        version: 12,
        name: "session_folders",
        requirements: &[
            SchemaRequirement::Table("session_folders"),
            SchemaRequirement::Index("idx_session_folders_folder"),
        ],
        steps: &[MigrationStep::Sql(include_str!(
            "../../migrations/009_session_folders.sql"
        ))],
    },
    Migration {
        version: 13,
        name: "p3a_counters",
        requirements: &[
            SchemaRequirement::Table("p3a_counters"),
            SchemaRequirement::Column {
                table: "p3a_counters",
                column: "reported_value",
            },
            SchemaRequirement::Column {
                table: "p3a_counters",
                column: "reported_at",
            },
            SchemaRequirement::Index("idx_p3a_counters_epoch"),
        ],
        steps: &[
            MigrationStep::Sql(include_str!("../../migrations/010_p3a_counters.sql")),
            MigrationStep::EnsureColumns {
                table: "p3a_counters",
                columns: P3A_REPORTING_COLUMNS,
            },
        ],
    },
    Migration {
        version: 14,
        name: "connector_accounts",
        requirements: &[
            SchemaRequirement::Table("connector_accounts"),
            SchemaRequirement::Table("routine_trust"),
            SchemaRequirement::Table("connector_triggers"),
            SchemaRequirement::Table("trigger_cursors"),
            SchemaRequirement::Index("idx_connector_triggers_job_id"),
        ],
        steps: &[MigrationStep::Sql(include_str!(
            "../../migrations/011_connectors.sql"
        ))],
    },
    Migration {
        version: 15,
        name: "connector_grants",
        requirements: &[
            SchemaRequirement::Table("connector_grants"),
            SchemaRequirement::Index("idx_connector_grants_token"),
        ],
        steps: &[MigrationStep::Sql(include_str!(
            "../../migrations/012_connector_grants.sql"
        ))],
    },
    Migration {
        version: 16,
        name: "connector_credited_runs",
        requirements: &[
            SchemaRequirement::Table("connector_credited_runs"),
            SchemaRequirement::Column {
                table: "routine_trust",
                column: "approval_since",
            },
        ],
        steps: &[
            MigrationStep::Sql(include_str!(
                "../../migrations/013_connector_credited_runs.sql"
            )),
            MigrationStep::EnsureColumns {
                table: "routine_trust",
                columns: ROUTINE_APPROVAL_COLUMN,
            },
        ],
    },
    Migration {
        version: 17,
        name: "note_transcription_jobs",
        requirements: &[
            SchemaRequirement::Column {
                table: "transcripts",
                column: "span_id",
            },
            SchemaRequirement::Table("note_transcription_jobs"),
            SchemaRequirement::Index("idx_note_transcription_jobs_operation"),
            SchemaRequirement::Index("idx_note_transcription_jobs_session_status"),
            SchemaRequirement::Index("idx_note_transcription_jobs_pending"),
            SchemaRequirement::Index("idx_transcripts_span_id"),
        ],
        steps: &[
            MigrationStep::EnsureColumns {
                table: "transcripts",
                columns: TRANSCRIPT_SPAN_COLUMN,
            },
            MigrationStep::Sql(include_str!(
                "../../migrations/014_note_transcription_jobs.sql"
            )),
        ],
    },
    Migration {
        version: 18,
        name: "memories",
        requirements: &[
            SchemaRequirement::Column {
                table: "folders",
                column: "instructions",
            },
            SchemaRequirement::Column {
                table: "folders",
                column: "memory_disabled",
            },
            SchemaRequirement::Table("memories"),
            SchemaRequirement::Table("memory_tombstones"),
            SchemaRequirement::Index("idx_memories_folder_id"),
        ],
        steps: &[
            MigrationStep::EnsureColumns {
                table: "folders",
                columns: FOLDER_MEMORY_COLUMNS,
            },
            MigrationStep::Sql(include_str!("../../migrations/015_memories.sql")),
        ],
    },
    Migration {
        version: 19,
        name: "share_keys",
        requirements: &[
            SchemaRequirement::Table("share_keys"),
            SchemaRequirement::Table("share_invite_keys"),
            SchemaRequirement::Index("idx_share_keys_item"),
            SchemaRequirement::Index("idx_share_invite_keys_share"),
        ],
        steps: &[MigrationStep::Sql(include_str!(
            "../../migrations/014_share_keys.sql"
        ))],
    },
    Migration {
        version: 20,
        name: "linear_connector",
        requirements: &[
            SchemaRequirement::Column {
                table: "connector_accounts",
                column: "metadata",
            },
            SchemaRequirement::Table("connector_selected_teams"),
        ],
        steps: &[
            MigrationStep::EnsureColumns {
                table: "connector_accounts",
                columns: CONNECTOR_METADATA_COLUMN,
            },
            MigrationStep::Sql(include_str!("../../migrations/016_linear_connector.sql")),
        ],
    },
    Migration {
        version: 21,
        name: "connector_actions",
        requirements: &[SchemaRequirement::Table("connector_actions")],
        steps: &[MigrationStep::Sql(include_str!(
            "../../migrations/017_connector_actions.sql"
        ))],
    },
    Migration {
        version: 22,
        name: "profile_scoped_data",
        requirements: &[
            SchemaRequirement::Column {
                table: "notes",
                column: "profile",
            },
            SchemaRequirement::Column {
                table: "dictation_history",
                column: "profile",
            },
            SchemaRequirement::Column {
                table: "folders",
                column: "profile",
            },
            SchemaRequirement::Index("idx_notes_profile_created_at"),
        ],
        steps: &[
            MigrationStep::EnsureColumns {
                table: "notes",
                columns: PROFILE_COLUMN,
            },
            MigrationStep::EnsureColumns {
                table: "dictation_history",
                columns: PROFILE_COLUMN,
            },
            MigrationStep::EnsureColumns {
                table: "folders",
                columns: PROFILE_COLUMN,
            },
            MigrationStep::Sql(
                "CREATE INDEX IF NOT EXISTS idx_notes_profile_created_at
                 ON notes (profile, created_at DESC);",
            ),
        ],
    },
    Migration {
        version: 23,
        name: "session_profiles",
        requirements: &[SchemaRequirement::Table("session_profiles")],
        steps: &[MigrationStep::Sql(include_str!(
            "../../migrations/018_session_profiles.sql"
        ))],
    },
    Migration {
        version: 24,
        name: "memory_profiles",
        requirements: &[
            SchemaRequirement::Column {
                table: "memories",
                column: "profile",
            },
            SchemaRequirement::Index("idx_memories_profile_created_at"),
        ],
        steps: &[
            MigrationStep::EnsureColumns {
                table: "memories",
                columns: PROFILE_COLUMN,
            },
            MigrationStep::Sql(include_str!("../../migrations/019_memory_profiles.sql")),
        ],
    },
    Migration {
        version: 25,
        name: "completed_sessions",
        requirements: &[SchemaRequirement::Table("completed_sessions")],
        steps: &[MigrationStep::Sql(include_str!(
            "../../migrations/020_completed_sessions.sql"
        ))],
    },
    Migration {
        version: 26,
        name: "note_calendar_metadata",
        requirements: &[
            SchemaRequirement::Column {
                table: "notes",
                column: "calendar_event_id",
            },
            SchemaRequirement::Column {
                table: "notes",
                column: "calendar_event_title",
            },
            SchemaRequirement::Column {
                table: "notes",
                column: "calendar_event_start_at",
            },
            SchemaRequirement::Column {
                table: "notes",
                column: "calendar_event_end_at",
            },
            SchemaRequirement::Column {
                table: "notes",
                column: "calendar_account_email",
            },
        ],
        steps: &[MigrationStep::EnsureColumns {
            table: "notes",
            columns: NOTE_CALENDAR_COLUMNS,
        }],
    },
    Migration {
        version: 27,
        name: "routine_browser_grants",
        requirements: &[SchemaRequirement::Table("routine_browser_grants")],
        steps: &[MigrationStep::Sql(include_str!(
            "../../migrations/021_routine_browser_grants.sql"
        ))],
    },
    Migration {
        version: 28,
        name: "browser_outcome_ledger",
        requirements: &[
            SchemaRequirement::Table("browser_action_outcomes"),
            SchemaRequirement::Table("browser_approval_events"),
            SchemaRequirement::Index("idx_browser_action_outcomes_session"),
            SchemaRequirement::Index("idx_browser_approval_events_session"),
        ],
        steps: &[MigrationStep::Sql(include_str!(
            "../../migrations/022_browser_outcome_ledger.sql"
        ))],
    },
    Migration {
        version: 29,
        name: "folder_import_paths",
        requirements: &[
            SchemaRequirement::Column {
                table: "folders",
                column: "local_path",
            },
            SchemaRequirement::Index("idx_folders_active_local_path"),
        ],
        steps: &[
            MigrationStep::EnsureColumns {
                table: "folders",
                columns: FOLDER_LOCAL_PATH_COLUMN,
            },
            MigrationStep::Sql(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_active_local_path
                 ON folders (profile, local_path)
                 WHERE deleted_at IS NULL AND local_path IS NOT NULL;",
            ),
        ],
    },
];

struct AppliedMigration {
    version: i64,
    name: String,
}

#[derive(Default)]
struct SchemaSnapshot {
    tables: HashSet<String>,
    indexes: HashSet<String>,
    columns: HashSet<(String, String)>,
}

impl SchemaSnapshot {
    async fn load(transaction: &mut SqliteTransaction<'_>) -> Result<Self, sqlx::Error> {
        let object_rows = query(
            "SELECT type, name
             FROM sqlite_schema
             WHERE type IN ('table', 'index')",
        )
        .fetch_all(&mut **transaction)
        .await?;
        let column_rows = query(
            "SELECT schema.name AS table_name, column_info.name AS column_name
             FROM sqlite_schema AS schema
             JOIN pragma_table_info(schema.name) AS column_info
             WHERE schema.type = 'table'",
        )
        .fetch_all(&mut **transaction)
        .await?;

        let mut snapshot = Self::default();
        for row in object_rows {
            let object_type: String = row.get("type");
            let name: String = row.get("name");
            match object_type.as_str() {
                "table" => {
                    snapshot.tables.insert(name);
                }
                "index" => {
                    snapshot.indexes.insert(name);
                }
                _ => {}
            }
        }
        for row in column_rows {
            snapshot
                .columns
                .insert((row.get("table_name"), row.get("column_name")));
        }
        Ok(snapshot)
    }

    fn has_application_tables(&self) -> bool {
        self.tables
            .iter()
            .any(|table| table != SCHEMA_MIGRATIONS_TABLE && !table.starts_with("sqlite_"))
    }

    fn satisfies(&self, requirement: SchemaRequirement) -> bool {
        match requirement {
            SchemaRequirement::Table(table) => self.tables.contains(table),
            SchemaRequirement::Index(index) => self.indexes.contains(index),
            SchemaRequirement::Column { table, column } => self
                .columns
                .contains(&(table.to_string(), column.to_string())),
            SchemaRequirement::MissingIndex(index) => !self.indexes.contains(index),
        }
    }
}

pub async fn run_migrations(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    run_migration_catalog(pool, MIGRATIONS).await
}

async fn run_migration_catalog(
    pool: &SqlitePool,
    migrations: &[Migration],
) -> Result<(), sqlx::Error> {
    validate_catalog(migrations)?;

    if let Some(applied) = read_applied_migrations_from_pool(pool).await? {
        let current = validate_applied_migrations(&applied, migrations)?;
        if current == migrations.len() {
            return Ok(());
        }
    }

    // Serializing migration writers before inspecting the schema prevents two
    // processes from deriving and stamping the same unversioned database.
    let mut transaction = pool.begin_with("BEGIN IMMEDIATE").await?;
    let migration_result = migrate_locked(&mut transaction, migrations).await;
    match migration_result {
        Ok(()) => transaction.commit().await,
        Err(error) => match transaction.rollback().await {
            Ok(()) => Err(error),
            Err(rollback_error) => Err(sqlx::Error::Protocol(format!(
                "migration failed ({error}); rollback also failed ({rollback_error})"
            ))),
        },
    }
}

async fn migrate_locked(
    transaction: &mut SqliteTransaction<'_>,
    migrations: &[Migration],
) -> Result<(), sqlx::Error> {
    let applied = read_applied_migrations_from_transaction(transaction).await?;
    let current = match applied {
        Some(ref applied) if !applied.is_empty() => {
            validate_applied_migrations(applied, migrations)?
        }
        _ => {
            let snapshot = SchemaSnapshot::load(transaction).await?;
            let detected = detect_legacy_version(&snapshot, migrations)?;
            create_schema_migrations_table(transaction).await?;
            stamp_legacy_migrations(transaction, &migrations[..detected]).await?;
            detected
        }
    };

    for migration in &migrations[current..] {
        if let Err(error) = apply_migration(transaction, migration).await {
            return Err(sqlx::Error::Protocol(format!(
                "migration {} ({}) failed: {error}",
                migration.version, migration.name
            )));
        }
        query(
            "INSERT INTO schema_migrations (version, name)
             VALUES (?, ?)",
        )
        .bind(migration.version)
        .bind(migration.name)
        .execute(&mut **transaction)
        .await?;
    }

    Ok(())
}

fn validate_catalog(migrations: &[Migration]) -> Result<(), sqlx::Error> {
    for (index, migration) in migrations.iter().enumerate() {
        let expected_version = index as i64 + 1;
        if migration.version != expected_version || migration.name.is_empty() {
            return Err(sqlx::Error::Protocol(format!(
                "invalid migration catalog entry at position {expected_version}"
            )));
        }
        if migration.requirements.is_empty() {
            return Err(sqlx::Error::Protocol(format!(
                "migration {} ({}) has no schema requirements and cannot be safely detected on \
                 an unversioned database",
                migration.version, migration.name
            )));
        }
    }
    Ok(())
}

fn validate_applied_migrations(
    applied: &[AppliedMigration],
    migrations: &[Migration],
) -> Result<usize, sqlx::Error> {
    if applied.len() > migrations.len() {
        return Err(sqlx::Error::Protocol(
            "database schema is newer than this June build".to_string(),
        ));
    }
    for (index, applied_migration) in applied.iter().enumerate() {
        let expected = &migrations[index];
        // Names are persisted migration identity, not descriptive labels. A
        // rename makes every stamped install fail this check. Per ADR-0037,
        // existing version/name pairs are append-only and must never be edited.
        if applied_migration.version != expected.version || applied_migration.name != expected.name
        {
            return Err(sqlx::Error::Protocol(format!(
                "schema_migrations diverges at version {}: expected {}, found {} ({})",
                expected.version, expected.name, applied_migration.version, applied_migration.name
            )));
        }
    }
    Ok(applied.len())
}

fn detect_legacy_version(
    snapshot: &SchemaSnapshot,
    migrations: &[Migration],
) -> Result<usize, sqlx::Error> {
    if !snapshot.has_application_tables() {
        return Ok(0);
    }

    let mut detected = 0;
    let mut first_missing: Option<&Migration> = None;
    for migration in migrations {
        let applied = migration
            .requirements
            .iter()
            .copied()
            .all(|requirement| snapshot.satisfies(requirement));
        if applied {
            if let Some(missing) = first_missing {
                return Err(sqlx::Error::Protocol(format!(
                    "unversioned database has migration {} ({}) but is missing earlier migration {} ({})",
                    migration.version, migration.name, missing.version, missing.name
                )));
            }
            detected = migration.version as usize;
        } else if first_missing.is_none() {
            first_missing = Some(migration);
        }
    }

    if detected == 0 {
        return Err(sqlx::Error::Protocol(
            "unversioned database does not match a known June schema".to_string(),
        ));
    }
    Ok(detected)
}

async fn apply_migration(
    transaction: &mut SqliteTransaction<'_>,
    migration: &Migration,
) -> Result<(), sqlx::Error> {
    for step in migration.steps {
        match *step {
            MigrationStep::Sql(sql) => execute_sql_batch(transaction, sql).await?,
            MigrationStep::EnsureColumns { table, columns } => {
                ensure_columns(transaction, table, columns).await?
            }
            MigrationStep::DropIndex(index) => drop_index(transaction, index).await?,
        }
    }
    Ok(())
}

async fn execute_sql_batch(
    transaction: &mut SqliteTransaction<'_>,
    sql: &str,
) -> Result<(), sqlx::Error> {
    for statement in sql.split(';') {
        let statement = statement.trim();
        if !statement.is_empty() {
            query(statement).execute(&mut **transaction).await?;
        }
    }
    Ok(())
}

async fn ensure_columns(
    transaction: &mut SqliteTransaction<'_>,
    table: &str,
    columns: &[ColumnDefinition],
) -> Result<(), sqlx::Error> {
    let pragma = format!("PRAGMA table_info({})", quote_sqlite_identifier(table));
    let rows = query(&pragma).fetch_all(&mut **transaction).await?;
    let existing: HashSet<String> = rows.into_iter().map(|row| row.get("name")).collect();

    for column in columns {
        if existing.contains(column.name) {
            continue;
        }
        let alter = format!(
            "ALTER TABLE {} ADD COLUMN {} {}",
            quote_sqlite_identifier(table),
            quote_sqlite_identifier(column.name),
            column.definition
        );
        query(&alter).execute(&mut **transaction).await?;
    }
    Ok(())
}

async fn drop_index(
    transaction: &mut SqliteTransaction<'_>,
    index: &str,
) -> Result<(), sqlx::Error> {
    let sql = format!("DROP INDEX IF EXISTS {}", quote_sqlite_identifier(index));
    query(&sql).execute(&mut **transaction).await?;
    Ok(())
}

async fn create_schema_migrations_table(
    transaction: &mut SqliteTransaction<'_>,
) -> Result<(), sqlx::Error> {
    query(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY NOT NULL,
            name TEXT NOT NULL UNIQUE,
            applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )",
    )
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

async fn stamp_legacy_migrations(
    transaction: &mut SqliteTransaction<'_>,
    migrations: &[Migration],
) -> Result<(), sqlx::Error> {
    for migration in migrations {
        query(
            "INSERT INTO schema_migrations (version, name)
             VALUES (?, ?)",
        )
        .bind(migration.version)
        .bind(migration.name)
        .execute(&mut **transaction)
        .await?;
    }
    Ok(())
}

async fn read_applied_migrations_from_pool(
    pool: &SqlitePool,
) -> Result<Option<Vec<AppliedMigration>>, sqlx::Error> {
    let exists = query(
        "SELECT 1
         FROM sqlite_schema
         WHERE type = 'table' AND name = 'schema_migrations'",
    )
    .fetch_optional(pool)
    .await?
    .is_some();
    if !exists {
        return Ok(None);
    }
    let rows = query(
        "SELECT version, name
         FROM schema_migrations
         ORDER BY version",
    )
    .fetch_all(pool)
    .await?;
    Ok(Some(
        rows.into_iter()
            .map(|row| AppliedMigration {
                version: row.get("version"),
                name: row.get("name"),
            })
            .collect(),
    ))
}

async fn read_applied_migrations_from_transaction(
    transaction: &mut SqliteTransaction<'_>,
) -> Result<Option<Vec<AppliedMigration>>, sqlx::Error> {
    let exists = query(
        "SELECT 1
         FROM sqlite_schema
         WHERE type = 'table' AND name = 'schema_migrations'",
    )
    .fetch_optional(&mut **transaction)
    .await?
    .is_some();
    if !exists {
        return Ok(None);
    }
    let rows = query(
        "SELECT version, name
         FROM schema_migrations
         ORDER BY version",
    )
    .fetch_all(&mut **transaction)
    .await?;
    Ok(Some(
        rows.into_iter()
            .map(|row| AppliedMigration {
                version: row.get("version"),
                name: row.get("name"),
            })
            .collect(),
    ))
}

fn quote_sqlite_identifier(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx_sqlite::SqlitePoolOptions;

    const FAILING_MIGRATIONS: &[Migration] = &[
        Migration {
            version: 1,
            name: "transaction_existing",
            requirements: &[SchemaRequirement::Table("transaction_existing")],
            steps: &[MigrationStep::Sql(
                "CREATE TABLE transaction_existing (id INTEGER PRIMARY KEY);",
            )],
        },
        Migration {
            version: 2,
            name: "transaction_pending_success",
            requirements: &[SchemaRequirement::Table("transaction_pending_success")],
            steps: &[MigrationStep::Sql(
                "CREATE TABLE transaction_pending_success (id INTEGER PRIMARY KEY);",
            )],
        },
        Migration {
            version: 3,
            name: "transaction_failure",
            requirements: &[SchemaRequirement::Table("transaction_failure")],
            steps: &[MigrationStep::Sql(
                "CREATE TABLE transaction_failure (id INTEGER PRIMARY KEY);
                 INSERT INTO table_that_does_not_exist (id) VALUES (1);",
            )],
        },
    ];
    const EMPTY_REQUIREMENTS_MIGRATIONS: &[Migration] = &[Migration {
        version: 1,
        name: "missing_requirements",
        requirements: &[],
        steps: &[],
    }];

    async fn test_pool() -> SqlitePool {
        SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("in-memory SQLite")
    }

    async fn table_exists(pool: &SqlitePool, table: &str) -> bool {
        query(
            "SELECT 1
             FROM sqlite_schema
             WHERE type = 'table' AND name = ?",
        )
        .bind(table)
        .fetch_optional(pool)
        .await
        .expect("table lookup")
        .is_some()
    }

    async fn install_non_replay_guard(pool: &SqlitePool) {
        query(
            "INSERT INTO agent_tasks (
                id, title, prompt, status, safety_profile, created_at, updated_at
             ) VALUES ('task', 'title', 'prompt', 'completed', 'default', 'now', 'now')",
        )
        .execute(pool)
        .await
        .expect("agent task");
        for id in ["message-1", "message-2"] {
            query(
                "INSERT INTO agent_messages (
                    id, task_id, role, content, created_at, external_id
                 ) VALUES (?, 'task', 'assistant', 'same', 'now', NULL)",
            )
            .bind(id)
            .execute(pool)
            .await
            .expect("duplicate legacy message");
        }
        query(
            "CREATE TRIGGER reject_agent_message_replay
             BEFORE DELETE ON agent_messages
             BEGIN
               SELECT RAISE(ABORT, 'destructive migration replayed');
             END",
        )
        .execute(pool)
        .await
        .expect("delete guard");
    }

    async fn assert_latest_stamp(pool: &SqlitePool) {
        let row = query(
            "SELECT COUNT(*) AS count, MAX(version) AS version
             FROM schema_migrations",
        )
        .fetch_one(pool)
        .await
        .expect("migration stamp");
        assert_eq!(row.get::<i64, _>("count"), MIGRATIONS.len() as i64);
        assert_eq!(
            row.get::<i64, _>("version"),
            MIGRATIONS.last().expect("latest migration").version
        );
    }

    #[tokio::test]
    async fn fresh_database_runs_every_migration_and_stamps_latest() {
        let pool = test_pool().await;

        run_migrations(&pool).await.expect("fresh migrations");

        assert!(table_exists(&pool, "browser_action_outcomes").await);
        assert!(table_exists(&pool, "connector_actions").await);
        assert_latest_stamp(&pool).await;
    }

    #[test]
    fn catalog_rejects_migrations_without_legacy_requirements() {
        let error = validate_catalog(EMPTY_REQUIREMENTS_MIGRATIONS)
            .expect_err("empty requirements must fail catalog validation");

        assert!(error.to_string().contains("has no schema requirements"));
    }

    #[tokio::test]
    async fn current_replay_database_is_stamped_without_replaying_sql() {
        let pool = test_pool().await;
        run_migrations(&pool).await.expect("build current schema");
        install_non_replay_guard(&pool).await;
        query("DROP TABLE schema_migrations")
            .execute(&pool)
            .await
            .expect("remove version table");

        run_migrations(&pool)
            .await
            .expect("stamp current replay database");

        let count: i64 = query("SELECT COUNT(*) AS count FROM agent_messages")
            .fetch_one(&pool)
            .await
            .expect("agent messages")
            .get("count");
        assert_eq!(count, 2);
        assert_latest_stamp(&pool).await;
    }

    #[tokio::test]
    async fn unversioned_migration_15_database_upgrades_to_latest() {
        let pool = test_pool().await;
        run_migration_catalog(&pool, &MIGRATIONS[..15])
            .await
            .expect("migration 15 schema");
        install_non_replay_guard(&pool).await;
        query("DROP TABLE schema_migrations")
            .execute(&pool)
            .await
            .expect("remove version table");

        run_migrations(&pool)
            .await
            .expect("upgrade migration 15 database");

        assert!(table_exists(&pool, "connector_accounts").await);
        assert!(table_exists(&pool, "note_transcription_jobs").await);
        assert!(table_exists(&pool, "browser_action_outcomes").await);
        assert_latest_stamp(&pool).await;
    }

    #[tokio::test]
    async fn every_unversioned_historical_prefix_upgrades_to_latest() {
        for version in 1..MIGRATIONS.len() {
            let pool = test_pool().await;
            run_migration_catalog(&pool, &MIGRATIONS[..version])
                .await
                .unwrap_or_else(|error| panic!("build migration {version} schema: {error}"));
            query("DROP TABLE schema_migrations")
                .execute(&pool)
                .await
                .expect("remove version table");

            run_migrations(&pool)
                .await
                .unwrap_or_else(|error| panic!("upgrade migration {version} schema: {error}"));

            assert_latest_stamp(&pool).await;
        }
    }

    #[tokio::test]
    async fn failed_pending_migration_rolls_back_schema_and_version_stamp() {
        let pool = test_pool().await;
        run_migration_catalog(&pool, &FAILING_MIGRATIONS[..1])
            .await
            .expect("existing migration");

        run_migration_catalog(&pool, FAILING_MIGRATIONS)
            .await
            .expect_err("third migration must fail");

        let row = query(
            "SELECT COUNT(*) AS count, MAX(version) AS version
             FROM schema_migrations",
        )
        .fetch_one(&pool)
        .await
        .expect("preserved migration stamp");
        assert_eq!(row.get::<i64, _>("count"), 1);
        assert_eq!(row.get::<i64, _>("version"), 1);
        assert!(table_exists(&pool, "transaction_existing").await);
        assert!(!table_exists(&pool, "transaction_pending_success").await);
        assert!(!table_exists(&pool, "transaction_failure").await);
    }
}
