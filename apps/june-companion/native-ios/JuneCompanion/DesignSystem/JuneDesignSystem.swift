import SwiftUI

enum JuneAppearance: String, CaseIterable, Identifiable {
  case system
  case light
  case dark

  var id: String { rawValue }

  var title: String {
    switch self {
    case .system: "System"
    case .light: "Light"
    case .dark: "Dark"
    }
  }

  var colorScheme: ColorScheme? {
    switch self {
    case .system: nil
    case .light: .light
    case .dark: .dark
    }
  }
}

enum JuneFont {
  static let regularName = "ABCDiatype-Regular"
  static let mediumName = "ABCDiatype-Medium"
  static let monoName = "BerkeleyMono-Regular"

  static var hero: Font { .custom(mediumName, size: 36, relativeTo: .largeTitle) }
  static var title: Font { .custom(mediumName, size: 20, relativeTo: .title3) }
  static var headline: Font { .custom(mediumName, size: 17, relativeTo: .headline) }
  static var body: Font { .custom(regularName, size: 17, relativeTo: .body) }
  static var subheadline: Font { .custom(regularName, size: 15, relativeTo: .subheadline) }
  static var footnote: Font { .custom(regularName, size: 13, relativeTo: .footnote) }
  static var caption: Font { .custom(regularName, size: 12, relativeTo: .caption) }
  static var mono: Font { .custom(monoName, size: 12, relativeTo: .caption) }
}

enum JuneMetrics {
  static let minimumTapTarget: CGFloat = 44
  static let compactRadius: CGFloat = 12
  static let controlRadius: CGFloat = 18
  static let composerRadius: CGFloat = 32
  static let sheetRadius: CGFloat = 30
  static let readableWidth: CGFloat = 720
}

struct JuneBrandMark: View {
  var size: CGFloat = 32

  var body: some View {
    Text("os")
      .font(.custom(JuneFont.mediumName, size: size * 0.43, relativeTo: .caption))
      .tracking(-size * 0.035)
      .foregroundStyle(Color(.systemBackground))
      .frame(width: size, height: size)
      .background(
        Color.primary,
        in: RoundedRectangle(cornerRadius: size * 0.29, style: .continuous)
      )
      .accessibilityHidden(true)
  }
}

struct JuneBrandLockup: View {
  var compact = false

  var body: some View {
    HStack(spacing: compact ? 8 : 11) {
      JuneBrandMark(size: compact ? 25 : 34)

      if compact {
        Text("June")
          .font(JuneFont.headline)
      } else {
        VStack(alignment: .leading, spacing: 0) {
          Text("June")
            .font(JuneFont.headline)
          Text("Open Software")
            .font(JuneFont.caption)
            .tracking(1.15)
            .foregroundStyle(.secondary)
        }
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("June by Open Software")
  }
}

struct JunePrimaryButtonLabel: View {
  let title: String
  var systemImage: String?

  var body: some View {
    HStack(spacing: 8) {
      if let systemImage {
        Image(systemName: systemImage)
          .accessibilityHidden(true)
      }
      Text(title)
        .font(JuneFont.headline)
    }
    .frame(maxWidth: .infinity, minHeight: 48)
  }
}

struct JuneSolidButtonStyle: ButtonStyle {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.isEnabled) private var isEnabled

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .foregroundStyle(isEnabled ? Color(.systemBackground) : Color(.secondaryLabel))
      .background(
        isEnabled ? Color(.label) : Color(.tertiarySystemFill),
        in: RoundedRectangle(cornerRadius: JuneMetrics.controlRadius, style: .continuous)
      )
      .opacity(configuration.isPressed && isEnabled ? 0.82 : 1)
      .scaleEffect(configuration.isPressed && isEnabled && !reduceMotion ? 0.985 : 1)
      .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
  }
}

struct JuneSecondaryButtonStyle: ButtonStyle {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(JuneFont.headline)
      .foregroundStyle(.primary)
      .frame(maxWidth: .infinity, minHeight: 48)
      .background(
        Color(.secondarySystemFill),
        in: RoundedRectangle(cornerRadius: JuneMetrics.controlRadius, style: .continuous)
      )
      .opacity(configuration.isPressed ? 0.72 : 1)
      .scaleEffect(configuration.isPressed && !reduceMotion ? 0.985 : 1)
  }
}

struct JunePressButtonStyle: ButtonStyle {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .scaleEffect(configuration.isPressed && !reduceMotion ? 0.985 : 1)
      .opacity(configuration.isPressed ? 0.72 : 1)
      .animation(
        JuneMotion.animation(.feedback, reduceMotion: reduceMotion),
        value: configuration.isPressed
      )
  }
}

struct JuneStaticButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View { configuration.label }
}

struct ConnectionLabel: View {
  let state: ConnectionState

  var body: some View {
    HStack(spacing: 6) {
      Image(systemName: state.systemImage)
        .imageScale(.small)
        .accessibilityHidden(true)
      Text(state.title)
        .font(JuneFont.footnote)
        .lineLimit(1)
    }
    .foregroundStyle(.secondary)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Mac status: \(state.title)")
  }
}

extension View {
  @ViewBuilder
  func juneGlassSurface(cornerRadius: CGFloat = JuneMetrics.composerRadius) -> some View {
    if #available(iOS 26.0, *) {
      glassEffect(.regular, in: .rect(cornerRadius: cornerRadius))
    } else {
      background(
        .regularMaterial,
        in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
      )
      .overlay {
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
          .strokeBorder(Color.primary.opacity(0.08), lineWidth: 0.5)
      }
      .shadow(color: .black.opacity(0.08), radius: 18, y: 7)
    }
  }

  func juneReadableColumn() -> some View {
    frame(maxWidth: JuneMetrics.readableWidth)
      .frame(maxWidth: .infinity)
  }

  func juneComposerSurface() -> some View {
    juneGlassSurface()
  }
}
