use crate::ServiceError;
use june_domain::{P3aReport, P3aSink};
use std::sync::Arc;

const P3A_SCHEMA_VERSION: u32 = 1;
const P3A_PRODUCT_SLUG: &str = "june";

pub struct P3aReportService {
    sink: Arc<dyn P3aSink>,
}

pub struct P3aReportServiceDeps {
    pub sink: Arc<dyn P3aSink>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct P3aReportParams {
    pub schema: u32,
    pub question_id: String,
    pub epoch: String,
    pub platform: String,
    pub version_series: String,
    pub bucket: u8,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct P3aQuestionDef {
    id: &'static str,
    bucket_count: u8,
}

const P3A_QUESTIONS: &[P3aQuestionDef] = &[
    P3aQuestionDef {
        id: "general.active-days",
        bucket_count: 5,
    },
    P3aQuestionDef {
        id: "notes.meetings-recorded",
        bucket_count: 1,
    },
    P3aQuestionDef {
        id: "notes.audio-source",
        bucket_count: 3,
    },
    P3aQuestionDef {
        id: "dictation.sessions",
        bucket_count: 1,
    },
    P3aQuestionDef {
        id: "agent.sessions",
        bucket_count: 1,
    },
    P3aQuestionDef {
        id: "agent.privacy-guard",
        bucket_count: 2,
    },
    P3aQuestionDef {
        id: "models.privacy-mode",
        bucket_count: 3,
    },
    P3aQuestionDef {
        id: "onboarding.completed",
        bucket_count: 1,
    },
    P3aQuestionDef {
        id: "onboarding.use-case.work",
        bucket_count: 1,
    },
    P3aQuestionDef {
        id: "onboarding.use-case.personal",
        bucket_count: 1,
    },
    P3aQuestionDef {
        id: "onboarding.use-case.school",
        bucket_count: 1,
    },
    P3aQuestionDef {
        id: "onboarding.use-case.creative",
        bucket_count: 1,
    },
    P3aQuestionDef {
        id: "onboarding.use-case.coding",
        bucket_count: 1,
    },
    P3aQuestionDef {
        id: "onboarding.use-case.meetings",
        bucket_count: 1,
    },
    P3aQuestionDef {
        id: "onboarding.use-case.other",
        bucket_count: 1,
    },
    P3aQuestionDef {
        id: "onboarding.use-case.not-sure",
        bucket_count: 1,
    },
];

impl P3aReportService {
    pub fn new(deps: P3aReportServiceDeps) -> Self {
        Self { sink: deps.sink }
    }

    pub async fn record(&self, params: P3aReportParams) -> Result<(), ServiceError> {
        validate_schema(params.schema)?;
        let question = question_definition(&params.question_id)?;
        validate_epoch(&params.epoch)?;
        validate_platform(&params.platform)?;
        validate_version_series(&params.version_series)?;
        if params.bucket >= question.bucket_count {
            return Err(ServiceError::InvalidInput {
                reason: "bucket is outside the question catalog range".to_string(),
            });
        }

        self.sink
            .submit(P3aReport {
                product_slug: P3A_PRODUCT_SLUG.to_string(),
                question_id: params.question_id,
                epoch: params.epoch,
                platform: params.platform,
                version_series: params.version_series,
                bucket: params.bucket,
            })
            .await
            .map_err(ServiceError::from)
    }
}

fn validate_schema(schema: u32) -> Result<(), ServiceError> {
    if schema == P3A_SCHEMA_VERSION {
        Ok(())
    } else {
        Err(ServiceError::InvalidInput {
            reason: "schema must be 1".to_string(),
        })
    }
}

fn question_definition(question_id: &str) -> Result<P3aQuestionDef, ServiceError> {
    P3A_QUESTIONS
        .iter()
        .copied()
        .find(|definition| definition.id == question_id)
        .ok_or_else(|| ServiceError::InvalidInput {
            reason: "unknown telemetry question".to_string(),
        })
}

fn validate_epoch(epoch: &str) -> Result<(), ServiceError> {
    let Some((year, week)) = epoch.split_once("-W") else {
        return Err(ServiceError::InvalidInput {
            reason: "epoch must use YYYY-Www".to_string(),
        });
    };
    if year.len() != 4 || !year.chars().all(|character| character.is_ascii_digit()) {
        return Err(ServiceError::InvalidInput {
            reason: "epoch must use YYYY-Www".to_string(),
        });
    }
    let week = week.parse::<u8>().map_err(|_| ServiceError::InvalidInput {
        reason: "epoch week must be in 01..=53".to_string(),
    })?;
    if !(1..=53).contains(&week) {
        return Err(ServiceError::InvalidInput {
            reason: "epoch week must be in 01..=53".to_string(),
        });
    }
    Ok(())
}

fn validate_platform(platform: &str) -> Result<(), ServiceError> {
    if matches!(platform, "macos" | "windows" | "linux") {
        Ok(())
    } else {
        Err(ServiceError::InvalidInput {
            reason: "platform must be macos, windows, or linux".to_string(),
        })
    }
}

fn validate_version_series(version_series: &str) -> Result<(), ServiceError> {
    if (1..=32).contains(&version_series.len())
        && version_series.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '+' | '-')
        })
    {
        Ok(())
    } else {
        Err(ServiceError::InvalidInput {
            reason: "version_series must be 1..=32 ASCII version characters".to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{P3aReportParams, P3aReportService, P3aReportServiceDeps};
    use async_trait::async_trait;
    use june_domain::{DomainError, P3aReport, P3aSink};
    use pretty_assertions::assert_eq;
    use rstest::rstest;
    use std::sync::{Arc, Mutex};

    #[tokio::test]
    async fn accepts_known_question_and_forwards_product_scoped_report() {
        let sink = Arc::new(RecordingP3aSink::default());
        let service = P3aReportService::new(P3aReportServiceDeps { sink: sink.clone() });

        service
            .record(P3aReportParams {
                schema: 1,
                question_id: "dictation.sessions".to_string(),
                epoch: "2026-W28".to_string(),
                platform: "macos".to_string(),
                version_series: "0.0.x".to_string(),
                bucket: 0,
            })
            .await
            .expect("report accepted");

        assert_eq!(
            sink.reports(),
            vec![P3aReport {
                product_slug: "june".to_string(),
                question_id: "dictation.sessions".to_string(),
                epoch: "2026-W28".to_string(),
                platform: "macos".to_string(),
                version_series: "0.0.x".to_string(),
                bucket: 0,
            }]
        );
    }

    #[tokio::test]
    async fn rejects_bucket_outside_question_catalog() {
        let service = P3aReportService::new(P3aReportServiceDeps {
            sink: Arc::new(RecordingP3aSink::default()),
        });

        let result = service
            .record(P3aReportParams {
                schema: 1,
                question_id: "onboarding.completed".to_string(),
                epoch: "2026-W28".to_string(),
                platform: "macos".to_string(),
                version_series: "0.0.x".to_string(),
                bucket: 1,
            })
            .await;

        assert!(result.is_err());
    }

    #[rstest]
    #[case("onboarding.use-case.work")]
    #[case("onboarding.use-case.personal")]
    #[case("onboarding.use-case.school")]
    #[case("onboarding.use-case.creative")]
    #[case("onboarding.use-case.coding")]
    #[case("onboarding.use-case.meetings")]
    #[case("onboarding.use-case.other")]
    #[case("onboarding.use-case.not-sure")]
    #[tokio::test]
    async fn accepts_onboarding_use_case_questions(#[case] question_id: &str) {
        let sink = Arc::new(RecordingP3aSink::default());
        let service = P3aReportService::new(P3aReportServiceDeps { sink: sink.clone() });

        service
            .record(P3aReportParams {
                schema: 1,
                question_id: question_id.to_string(),
                epoch: "2026-W29".to_string(),
                platform: "macos".to_string(),
                version_series: "0.0.x".to_string(),
                bucket: 0,
            })
            .await
            .expect("onboarding use case report accepted");

        assert_eq!(sink.reports()[0].question_id, question_id);
    }

    #[derive(Default)]
    struct RecordingP3aSink {
        reports: Mutex<Vec<P3aReport>>,
    }

    impl RecordingP3aSink {
        fn reports(&self) -> Vec<P3aReport> {
            self.reports.lock().expect("reports lock").clone()
        }
    }

    #[async_trait]
    impl P3aSink for RecordingP3aSink {
        async fn submit(&self, report: P3aReport) -> Result<(), DomainError> {
            self.reports.lock().expect("reports lock").push(report);
            Ok(())
        }
    }
}
