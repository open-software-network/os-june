pub fn normalize_peak(sample: i16) -> f32 {
    (sample as f32 / i16::MAX as f32).abs()
}
