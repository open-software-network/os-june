import SwiftUI

@main
@MainActor
struct JuneCompanionApp: App {
    @UIApplicationDelegateAdaptor(CompanionAppDelegate.self) private var appDelegate
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView(model: model)
                .task { await model.bootstrap() }
        }
    }
}
