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
        XCTAssertEqual(credential.hash, decoded.map { Array(SHA256.hash(data: $0)) })
        XCTAssertNotEqual(credential.hash, decoded.map(Array.init))
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

    func testBuildHasNoBearerTokenConfiguration() {
        XCTAssertNil(Bundle.main.object(forInfoDictionaryKey: "CompanionLocalBearerToken"))
        XCTAssertNil(Bundle.main.object(forInfoDictionaryKey: "JUNE_ACCOUNTS_CLIENT_ID"))
    }

    func testDeviceOwnerAuthenticationSeamCanDenyUnlock() async throws {
        let unlocked = try await DeviceIdentityService.shared.unlock(authenticator: DenyingAuthenticator())
        XCTAssertFalse(unlocked)
    }
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
