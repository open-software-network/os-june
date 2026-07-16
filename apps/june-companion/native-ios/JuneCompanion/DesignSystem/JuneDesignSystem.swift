import SwiftUI

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
    static let space1: CGFloat = 4
    static let space2: CGFloat = 8
    static let space3: CGFloat = 16
    static let space4: CGFloat = 24
    static let space5: CGFloat = 32
    static let minimumTapTarget: CGFloat = 44
    static let compactRadius: CGFloat = 12
    static let controlRadius: CGFloat = 18
    static let composerRadius: CGFloat = 32
    static let sheetRadius: CGFloat = 30
    static let readableWidth: CGFloat = 720
}

struct JuneBrandLockup: View {
    var compact = false

    var body: some View {
        HStack(spacing: compact ? 8 : 11) {
            Text("j")
                .font(.custom(JuneFont.mediumName, size: compact ? 17 : 22, relativeTo: .headline))
                .foregroundStyle(Color(.systemBackground))
                .frame(width: compact ? 26 : 34, height: compact ? 26 : 34)
                .background(Color.primary, in: RoundedRectangle(cornerRadius: compact ? 8 : 10, style: .continuous))
                .accessibilityHidden(true)

            Text("June")
                .font(compact ? JuneFont.headline : JuneFont.title)
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
            Text(title)
            if let systemImage {
                Image(systemName: systemImage)
                    .accessibilityHidden(true)
            }
        }
        .font(JuneFont.headline)
        .frame(maxWidth: .infinity, minHeight: 52)
    }
}

struct JuneSolidButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(Color(.systemBackground))
            .background(Color.primary.opacity(configuration.isPressed ? 0.78 : 1))
            .clipShape(RoundedRectangle(cornerRadius: JuneMetrics.controlRadius, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: JuneMetrics.controlRadius, style: .continuous))
    }
}

struct JuneSecondaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(JuneFont.headline)
            .foregroundStyle(.primary)
            .frame(maxWidth: .infinity, minHeight: 52)
            .background(
                Color(.secondarySystemBackground).opacity(configuration.isPressed ? 0.7 : 1),
                in: RoundedRectangle(cornerRadius: JuneMetrics.controlRadius, style: .continuous)
            )
    }
}

struct ConnectionLabel: View {
    let state: ConnectionState

    var body: some View {
        Label(state.title, systemImage: state.systemImage)
            .font(JuneFont.footnote)
            .foregroundStyle(state == .ready ? .primary : .secondary)
            .accessibilityLabel("Mac status: \(state.title)")
    }
}

extension View {
    func juneReadableColumn() -> some View {
        frame(maxWidth: JuneMetrics.readableWidth)
            .frame(maxWidth: .infinity)
    }

    @ViewBuilder
    func juneComposerSurface() -> some View {
        if #available(iOS 26.0, *) {
            glassEffect(.regular, in: .rect(cornerRadius: JuneMetrics.composerRadius))
        } else {
            background(.regularMaterial, in: RoundedRectangle(cornerRadius: JuneMetrics.composerRadius, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: JuneMetrics.composerRadius, style: .continuous)
                        .strokeBorder(Color.primary.opacity(0.08), lineWidth: 0.5)
                }
                .shadow(color: .black.opacity(0.08), radius: 18, y: 7)
        }
    }
}
