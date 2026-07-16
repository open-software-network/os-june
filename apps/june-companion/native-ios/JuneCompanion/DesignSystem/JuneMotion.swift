import SwiftUI

enum JuneMotion {
    static let state = Animation.easeInOut(duration: 0.18)
    static let presentation = Animation.easeInOut(duration: 0.24)
    static let transition = Animation.easeInOut(duration: 0.32)
}

extension View {
    @ViewBuilder
    func juneAnimation<Value: Equatable>(
        _ animation: Animation,
        value: Value,
        reduceMotion: Bool
    ) -> some View {
        if reduceMotion {
            self.animation(nil, value: value)
        } else {
            self.animation(animation, value: value)
        }
    }
}
