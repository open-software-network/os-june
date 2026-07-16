import SwiftUI

enum JuneMotion {
  enum Style {
    case feedback
    case content
    case response
    case control
    case presentation
  }

  static func animation(_ style: Style, reduceMotion: Bool) -> Animation? {
    guard !reduceMotion else { return nil }
    return switch style {
    case .feedback: Animation.spring(duration: 0.14, bounce: 0)
    case .content: Animation.spring(duration: 0.22, bounce: 0)
    case .response: Animation.spring(duration: 0.28, bounce: 0.02)
    case .control: Animation.spring(duration: 0.20, bounce: 0)
    case .presentation: Animation.spring(duration: 0.36, bounce: 0.04)
    }
  }
}

extension View {
  func juneAnimation<Value: Equatable>(
    _ style: JuneMotion.Style,
    value: Value,
    reduceMotion: Bool
  ) -> some View {
    animation(JuneMotion.animation(style, reduceMotion: reduceMotion), value: value)
  }
}
