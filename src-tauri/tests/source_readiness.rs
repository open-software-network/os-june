use os_june_lib::{
    audio::system_audio::system_audio_readiness,
    domain::types::RecordingSource,
};

#[test]
fn system_audio_readiness_reports_system_source() {
    let readiness = system_audio_readiness();

    assert_eq!(readiness.source, RecordingSource::System);
    assert!(readiness.required);
}
