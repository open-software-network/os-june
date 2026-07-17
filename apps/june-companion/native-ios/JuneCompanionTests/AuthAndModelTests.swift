import CryptoKit
import Foundation
import XCTest
@testable import June_Companion

@MainActor
final class AuthAndModelTests: XCTestCase {
    func testPairingProofIsDeterministicAndDoesNotExposeSecret() {
        let secret = Data((0..<32).map(UInt8.init))
        let proof = PairingProof.make(secret: secret)

        XCTAssertEqual(proof.count, 32)
        XCTAssertNotEqual(proof, Array(secret))
        XCTAssertEqual(proof, PairingProof.make(secret: secret))
    }

    func testDeviceCredentialIsGeneratedOnDeviceAndRepresentedByItsHash() throws {
        let credential = try DeviceCredential.generate()
        var encoded = credential.value
          .replacingOccurrences(of: "-", with: "+")
          .replacingOccurrences(of: "_", with: "/")
        encoded += String(repeating: "=", count: (4 - encoded.count % 4) % 4)
        let decoded = Data(base64Encoded: encoded)

        XCTAssertEqual(decoded?.count, 32)
        XCTAssertEqual(credential.hash.count, 32)
        XCTAssertEqual(
          credential.hash,
          Array(SHA256.hash(data: Data(credential.value.utf8)))
        )
        XCTAssertNotEqual(credential.hash, decoded.map { Array(SHA256.hash(data: $0)) })
        XCTAssertNotEqual(credential.hash, decoded.map(Array.init))
    }

    func testPairingPayloadRejectsExpiredAndMalformedSecretsWithoutEchoingThem() throws {
        let secret = Data(repeating: 7, count: 32).base64EncodedString()
          .replacingOccurrences(of: "+", with: "-")
          .replacingOccurrences(of: "/", with: "_")
          .replacingOccurrences(of: "=", with: "")
        let expired = #"{"version":1,"pairingId":"00000000-0000-0000-0000-000000000001","pairingSecret":"\#(secret)","relayUrl":"wss://api.example.test/v1/companion/relay","expiresAtMs":999}"#

        XCTAssertThrowsError(try PairingPayloadValidation.decode(expired, now: 1_000)) { error in
            XCTAssertFalse(error.localizedDescription.contains(secret))
        }

        let malformed = #"{"version":1,"pairingId":"00000000-0000-0000-0000-000000000001","pairingSecret":"sensitive-invalid-secret","relayUrl":"wss://api.example.test/v1/companion/relay","expiresAtMs":2000}"#
        XCTAssertThrowsError(try PairingPayloadValidation.decode(malformed, now: 1_000)) { error in
            XCTAssertFalse(error.localizedDescription.contains("sensitive-invalid-secret"))
        }
    }

    func testManualPairingCodeDecodesTheSameBootstrapPayloadAsTheQRCode() throws {
        let secret = Data(repeating: 9, count: 32).base64EncodedString()
          .replacingOccurrences(of: "+", with: "-")
          .replacingOccurrences(of: "/", with: "_")
          .replacingOccurrences(of: "=", with: "")
        let payloadJSON = #"{"version":1,"pairingId":"00000000-0000-0000-0000-000000000002","pairingSecret":"\#(secret)","relayUrl":"wss://api.example.test/v1/companion/relay","expiresAtMs":2000}"#
        let pairingCode = Data(payloadJSON.utf8).base64EncodedString()
          .replacingOccurrences(of: "+", with: "-")
          .replacingOccurrences(of: "/", with: "_")
          .replacingOccurrences(of: "=", with: "")

        let scanned = try PairingPayloadValidation.decode(payloadJSON, now: 1_000)
        let entered = try PairingPayloadValidation.decode("  \n\(pairingCode)\n  ", now: 1_000)

        XCTAssertEqual(entered.payload.version, scanned.payload.version)
        XCTAssertEqual(entered.payload.pairingId, scanned.payload.pairingId)
        XCTAssertEqual(entered.payload.relayUrl, scanned.payload.relayUrl)
        XCTAssertEqual(entered.payload.expiresAtMs, scanned.payload.expiresAtMs)
        XCTAssertEqual(entered.secret, scanned.secret)
    }

    func testSecureStoreRoundTripAndDeletionUseAnIsolatedAccount() throws {
        let account = "test.\(UUID().uuidString)"
        let value = Data("secret".utf8)
        defer { SecureStore.shared.delete(account: account) }

        try SecureStore.shared.save(value, account: account)
        XCTAssertEqual(try SecureStore.shared.read(account: account), value)
        let replacement = Data("replacement".utf8)
        try SecureStore.shared.save(replacement, account: account)
        XCTAssertEqual(try SecureStore.shared.read(account: account), replacement)
        SecureStore.shared.delete(account: account)
        XCTAssertNil(try SecureStore.shared.read(account: account))
    }

    func testTransportLifecycleRejectsThePreviousConnectionAfterReconnect() {
        var lifecycle = TransportLifecycle()
        let first = lifecycle.begin()
        XCTAssertTrue(lifecycle.isCurrent(first))

        let second = lifecycle.begin()
        XCTAssertFalse(lifecycle.isCurrent(first))
        XCTAssertTrue(lifecycle.isCurrent(second))

        lifecycle.disconnect()
        XCTAssertFalse(lifecycle.isCurrent(second))
        XCTAssertNil(lifecycle.connectionID)
    }

    func testTransportDiagnosticsContainNoSecretsOrPayloads() throws {
        let credential = "device-credential-that-must-not-be-logged"
        let note = "private note content that must not be logged"
        let event = CompanionTransportDiagnostic.event(revoked: false)
        let encoded = try JSONSerialization.data(withJSONObject: event)
        let diagnostic = try XCTUnwrap(String(data: encoded, encoding: .utf8))

        XCTAssertFalse(diagnostic.contains(credential))
        XCTAssertFalse(diagnostic.contains(note))
        XCTAssertEqual(event["type"] as? String, "transportError")
    }

    func testInboundFrameValidationRejectsReplayExpiryAndCapabilityConfusion() throws {
        let now: UInt64 = 1_000_000
        let valid = try inboundFrame(
          sequence: 2,
          issuedAt: now,
          expiresAt: now + 30_000,
          capability: "notesRead",
          responseCapability: "notesRead"
        )
        let frame = try CompanionWireValidation.frame(valid, after: 1, now: now)
        XCTAssertEqual(frame.sequence, 2)
        XCTAssertEqual(frame.capability, "notesRead")
        XCTAssertThrowsError(try CompanionWireValidation.frame(valid, after: 2, now: now))

        let expired = try inboundFrame(
          sequence: 3,
          issuedAt: now - 31_000,
          expiresAt: now - 1_000,
          capability: "notesRead",
          responseCapability: "notesRead"
        )
        XCTAssertThrowsError(try CompanionWireValidation.frame(expired, after: 2, now: now))

        let futureDated = try inboundFrame(
          sequence: 3,
          issuedAt: now + 31_000,
          expiresAt: now + 61_000,
          capability: "notesRead",
          responseCapability: "notesRead"
        )
        XCTAssertThrowsError(try CompanionWireValidation.frame(futureDated, after: 2, now: now))

        let confused = try inboundFrame(
          sequence: 3,
          issuedAt: now,
          expiresAt: now + 30_000,
          capability: "agentChat",
          responseCapability: "notesRead"
        )
        XCTAssertThrowsError(try CompanionWireValidation.frame(confused, after: 2, now: now))
    }

    func testAmbiguousMutationRetriesKeepTheSameOperationID() throws {
        let firstBody: [String: Any] = [
          "type": "agentSend",
          "data": ["storedSessionId": "stored-1", "message": "Plan the week"],
        ]
        let sameBodyDifferentOrder: [String: Any] = [
          "data": ["message": "Plan the week", "storedSessionId": "stored-1"],
          "type": "agentSend",
        ]
        let firstKey = try MutationOperationIdentity.digest(
          capability: "agentChat",
          body: firstBody
        )
        let retryKey = try MutationOperationIdentity.digest(
          capability: "agentChat",
          body: sameBodyDifferentOrder
        )
        var pending: [String: PendingMutation] = [:]
        let first = MutationOperationIdentity.operationID(for: firstKey, pending: &pending)
        let retry = MutationOperationIdentity.operationID(for: retryKey, pending: &pending)

        XCTAssertEqual(firstKey, retryKey)
        XCTAssertEqual(first, retry)
        pending.removeValue(forKey: firstKey)
        XCTAssertNotEqual(
          first,
          MutationOperationIdentity.operationID(for: firstKey, pending: &pending)
        )
        XCTAssertFalse(
          MutationOperationIdentity.shouldResolve(resultType: "error", retryable: true)
        )
        XCTAssertTrue(
          MutationOperationIdentity.shouldResolve(resultType: "error", retryable: false)
        )
        XCTAssertTrue(
          MutationOperationIdentity.shouldResolve(resultType: "accepted", retryable: false)
        )
    }

    func testSnapshotDecodesCompanionProtocolContract() throws {
        let json = #"""
        {
          "connection":"ready",
          "notes":[{"id":"note-1","title":"Plan","preview":"Next steps","revision":2,"updatedAt":"2026-07-16T10:00:00Z"}],
          "agentSessions":[{"id":"session-1","title":"Review","status":"running","updatedAt":"2026-07-16T10:01:00Z"}],
          "safeSettings":{"dictationStyle":"formal","imageSafeMode":true},
          "device":{"deviceId":"device-1","displayName":"iPhone","linkedAt":"2026-07-16T09:00:00Z","lastSeenAt":null,"revokedAt":null}
        }
        """#

        let snapshot = try JSONDecoder().decode(CompanionSnapshotModel.self, from: Data(json.utf8))
        XCTAssertEqual(snapshot.connection, .ready)
        XCTAssertEqual(snapshot.notes.first?.revision, 2)
        XCTAssertEqual(snapshot.agentSessions.first?.status, .running)
        XCTAssertEqual(snapshot.safeSettings, SafeSettingsModel(dictationStyle: "formal", imageSafeMode: true))
    }

    func testCachedSnapshotPreservesUInt64NoteRevisions() throws {
        let revision: UInt64 = 9_007_199_254_740_993
        let json = """
        {
          "connection":"locked",
          "notes":[{"id":"note-1","title":"Plan","preview":"Next steps","revision":\(revision),"updatedAt":"2026-07-16T10:00:00Z"}],
          "agentSessions":[]
        }
        """

        let cached = try JSONDecoder().decode(Snapshot.self, from: Data(json.utf8))
        let restored = try JSONDecoder().decode(
            CompanionSnapshotModel.self,
            from: JSONEncoder().encode(cached)
        )

        XCTAssertEqual(restored.notes.first?.revision, revision)
    }

    func testBuildHasNoBearerTokenConfiguration() {
        XCTAssertNil(Bundle.main.object(forInfoDictionaryKey: "CompanionLocalBearerToken"))
        XCTAssertNil(Bundle.main.object(forInfoDictionaryKey: "OS_ACCOUNTS_APP_API_KEY"))
        XCTAssertNil(Bundle.main.object(forInfoDictionaryKey: "JUNE_ACCOUNTS_CLIENT_ID"))
        XCTAssertNil(Bundle.main.object(forInfoDictionaryKey: "JUNE_COMPANION_ACCOUNTS_CLIENT_ID"))
        XCTAssertNil(Bundle.main.object(forInfoDictionaryKey: "JUNE_COMPANION_ACCOUNTS_REDIRECT_URI"))
    }

    func testAgentEventsAreBufferedUntilANewSessionIsAccepted() throws {
        let model = AppModel()
        model.receive(
            type: "protocolEvent",
            payload: try agentEvent(
                type: "agentDelta",
                storedSessionID: "session-new",
                text: "Hello"
            )
        )
        model.receive(
            type: "protocolEvent",
            payload: try agentEvent(
                type: "agentStatus",
                storedSessionID: "session-new",
                status: "completed"
            )
        )

        model.acceptAgentSession("session-new", fallbackTitle: "Plan the week")

        XCTAssertEqual(model.selectedStoredSessionID, "session-new")
        XCTAssertEqual(model.snapshot.agentSessions.first?.status, .completed)
        XCTAssertEqual(model.messages.last?.text, "Hello")
        XCTAssertEqual(model.messages.last?.streaming, false)
    }

    func testAgentStreamTextIsUtf8Bounded() {
        let bounded = AppModel.boundedAgentText(String(repeating: "é", count: 20_000))

        XCTAssertLessThanOrEqual(bounded.utf8.count, 30 * 1024)
        XCTAssertTrue(bounded.hasSuffix("[Response truncated on companion]"))
    }

    func testAgentAcknowledgementDoesNotReopenACompletedSession() throws {
        let model = AppModel()
        model.acceptAgentSession("session-existing", fallbackTitle: "Existing chat")
        model.receive(
            type: "protocolEvent",
            payload: try agentEvent(
                type: "agentStatus",
                storedSessionID: "session-existing",
                status: "completed"
            )
        )

        model.acceptAgentSession("session-existing", fallbackTitle: "Existing chat")

        XCTAssertEqual(model.snapshot.agentSessions.first?.status, .completed)
    }

    func testDeviceOwnerAuthenticationSeamCanDenyUnlock() async throws {
        let unlocked = try await DeviceIdentityService.shared.unlock(authenticator: DenyingAuthenticator())
        XCTAssertFalse(unlocked)
    }
}

private func agentEvent(
    type: String,
    storedSessionID: String,
    text: String? = nil,
    status: String? = nil
) throws -> String {
    var data: [String: Any] = ["storedSessionId": storedSessionID]
    if let text { data["text"] = text }
    if let status { data["status"] = status }
    let payload: [String: Any] = [
        "body": [
            "type": "event",
            "data": ["type": type, "data": data],
        ],
    ]
    let encoded = try JSONSerialization.data(withJSONObject: payload)
    return try XCTUnwrap(String(data: encoded, encoding: .utf8))
}

private func inboundFrame(
  sequence: UInt64,
  issuedAt: UInt64,
  expiresAt: UInt64,
  capability: String,
  responseCapability: String
) throws -> Data {
    try JSONSerialization.data(withJSONObject: [
      "version": 1,
      "operationId": UUID().uuidString,
      "sequence": sequence,
      "issuedAtMs": issuedAt,
      "expiresAtMs": expiresAt,
      "capability": capability,
      "body": [
        "type": "response",
        "data": [
          "capability": responseCapability,
          "result": ["type": "accepted"],
        ],
      ],
    ])
}

@MainActor
private struct DenyingAuthenticator: DeviceOwnerAuthenticating {
    let canAuthenticate = true

    func authenticate(reason: String) async throws -> Bool {
        false
    }
}
