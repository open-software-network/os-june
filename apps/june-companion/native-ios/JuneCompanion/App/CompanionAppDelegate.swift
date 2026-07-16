import UIKit
import UserNotifications

final class CompanionAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        Task { @MainActor in
            CompanionService.shared.registerPushToken(deviceToken)
        }
    }

    func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        Task { @MainActor in
            await CompanionService.shared.handleRemoteNotification()
            completionHandler(.newData)
        }
    }
}

enum PushAuthorization {
    static func requestIfNeeded() async {
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        guard settings.authorizationStatus == .notDetermined else {
            if settings.authorizationStatus == .authorized {
                await MainActor.run { UIApplication.shared.registerForRemoteNotifications() }
            }
            return
        }
        if (try? await center.requestAuthorization(options: [.alert, .badge, .sound])) == true {
            await MainActor.run { UIApplication.shared.registerForRemoteNotifications() }
        }
    }
}
