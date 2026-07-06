#![cfg_attr(test, allow(clippy::expect_used, clippy::unwrap_used, clippy::panic))]

pub mod audio_probe;
pub mod http;
pub mod issue_reports;
pub mod jwks;
pub mod local_dev;
pub mod m4a_probe;
pub mod openai;
pub mod os_accounts;
pub mod routing;
pub mod venice;
pub mod venice_augment;
pub mod venice_image;
pub mod venice_image_edit;
pub mod venice_video;
pub mod wav_probe;

mod retry;
mod transcription;

pub use audio_probe::MultiFormatDurationProbe;
pub use http::{client_with_timeout, default_client, jwks_client};
pub use issue_reports::{LogIssueReportSink, OsPlatformIssueReportSink};
pub use jwks::{JwksTokenVerifier, JwksTokenVerifierParams};
pub use local_dev::{LocalDevOsAccountsClient, LocalDevTokenVerifier};
pub use m4a_probe::{M4aDurationProbe, M4aProbeError};
pub use openai::OpenAiTranscriber;
pub use os_accounts::OsAccountsHttpClient;
pub use routing::RoutingTranscriber;
pub use venice::{
    VeniceAgentChat, VeniceCleaner, VeniceGenerator, VeniceModelCatalog, VeniceTranscriber,
};
pub use venice_augment::VeniceAugment;
pub use venice_image::VeniceImageGenerator;
pub use venice_image_edit::VeniceImageEditor;
pub use venice_video::VeniceVideoProvider;
pub use wav_probe::{ProbeError, WavDurationProbe};
