# Companion TestFlight and App Store readiness

- Register the unique bundle id. The companion has no mobile OAuth client or
  callback because the signed-in desktop authorizes it during pairing.
- Add development and distribution signing teams/profiles and verify the APNs
  entitlement in the archived app.
- Supply complete AppIcon assets, screenshots for supported iPhone/iPad sizes,
  privacy labels, support/privacy URLs, age rating, and export-compliance answer.
- Verify `PrivacyInfo.xcprivacy`, camera explanation, notification prompt timing,
  disconnect behavior, self-revocation, and account deletion policy links.
- Run Release builds with an empty environment audit and scan the archive for
  `osk_`, provider keys, APNs `.p8`, bearer tokens, `.env`, note text, and
  debug endpoints.
- Exercise Dynamic Type, VoiceOver, Reduce Motion, dark/light appearance,
  keyboard, pointer, split view, rotation, offline/reconnect, memory pressure,
  and background termination on current iPhone and iPad hardware.
- Test TestFlight against production pairing, relay DNS/TLS, Postgres, APNs, and
  a single-replica June API deployment. Confirm older desktop/API contracts
  remain additive and keep horizontal scale disabled until ADR 0032's shared
  routing prerequisites ship.
- Attach the independent security review and penetration-test disposition.
