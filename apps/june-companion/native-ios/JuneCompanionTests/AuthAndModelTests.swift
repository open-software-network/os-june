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

@MainActor
private struct DenyingAuthenticator: DeviceOwnerAuthenticating {
    let canAuthenticate = true

    func authenticate(reason: String) async throws -> Bool {
        false
    }
}
