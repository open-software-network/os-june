use async_trait::async_trait;
use june_domain::{DomainError, P3aReport, P3aSink};

pub struct LogP3aSink;

#[async_trait]
impl P3aSink for LogP3aSink {
    async fn submit(&self, report: P3aReport) -> Result<(), DomainError> {
        tracing::info!(
            product_slug = %report.product_slug,
            question_id = %report.question_id,
            epoch = %report.epoch,
            platform = %report.platform,
            version_series = %report.version_series,
            bucket = report.bucket,
            "P3A report accepted by log sink"
        );
        Ok(())
    }
}
