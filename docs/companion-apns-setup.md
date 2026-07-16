# Companion APNs setup

1. Register `co.opensoftware.june.companion` in the Apple Developer portal and
   enable Push Notifications and Background Modes remote notifications.
2. Create an APNs token signing key and keep the `.p8` file server-side only.
3. Provision development/distribution profiles carrying `aps-environment`.
4. Set `JUNE__COMPANION__APNS_TEAM_ID`, `APNS_KEY_ID`,
   `APNS_PRIVATE_KEY_PEM`, `APNS_BUNDLE_ID`, and `APNS_PRODUCTION` on June API.
5. Use sandbox APNs for development builds and production APNs for TestFlight
   and App Store builds.

iOS registers the binary token natively and sends it only to the
device-credential-authenticated linked-device endpoint. The SwiftUI application
model never receives it. When an encrypted frame
targets an offline phone, the relay sends `{ "aps": { "content-available": 1
} }` with background push type and priority 5. There is no visible or sensitive
notification content. iOS may decline to wake the app; foreground reconnect and
resynchronization must still work.

Do not add PushKit, VoIP claims, background audio, notification content, or an
APNs key to the mobile bundle. Remove invalid/unregistered device tokens during
operations follow-up when Apple returns those statuses.
