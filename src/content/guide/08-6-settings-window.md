---
title: "The Settings Window"
description: "The settings window is the first complete window most apps build after the main one, and it exercises the whole view layer at once: an app-level window controller, an AppKit tab controller with toolbar tabs, SwiftUI panes hosted as ordinary content views, and the settings objects from Chapter 2.4 behind them. This subchapter builds the notebook app's settings window end to end — window, tabs, panes, sections, and the two-column form they share."
order: 8
subOrder: 6
---

The settings window is the first complete window most apps build after the main one, and it exercises the whole view layer at once: an app-level window controller, an AppKit tab controller with toolbar tabs, SwiftUI panes hosted as ordinary content views, and the settings objects from <a href="/guide/02-4-settings">Chapter 2.4</a> behind them. This subchapter builds the notebook app's settings window end to end — window, tabs, panes, sections, and the two-column form they share. It assumes the view contract from <a href="/guide/08-1-views">Chapter 8.1</a> and the state pair from <a href="/guide/08-2-view-state">Chapter 8.2</a>; neither is re-explained here.

## The shape

The window is the System Settings shape: a row of toolbar tabs, one pane per tab, the window titled after the selected pane. Nothing about it is custom — AppKit's `NSTabViewController` in its toolbar style produces exactly that window, manages the toolbar and the title, and hosts each pane as a plain child view controller. Every pane is SwiftUI, hosted once in an `NSHostingController` and never re-hosted. Inside a pane, the content is a stack of independent <em>sections</em>, each rendering one group of related settings.

<div class="table-wrap">
<table>
<thead><tr><th>Object</th><th>Kind</th><th>Does</th></tr></thead>
<tbody>
<tr><td><strong>SettingsWindowController</strong></td><td><code>NSWindowController</code>, shared</td><td>Owns the one settings window. Shows it, optionally on a given tab.</td></tr>
<tr><td><strong>SettingsTabViewController</strong></td><td><code>NSTabViewController</code>, toolbar style</td><td>One tab per pane. Hosts each pane's SwiftUI Screen, holds every pane to one size.</td></tr>
<tr><td><strong>&lt;Pane&gt;SettingsScreen</strong></td><td>SwiftUI <code>Screen</code></td><td>The pane's root. Owns one controller per section and stacks the section views. Plays the view-controller role for the pane.</td></tr>
<tr><td><strong>&lt;Section&gt;SectionView</strong></td><td>SwiftUI <code>View</code></td><td>Renders one section from a plain content value; emits every edit as an action. Previewable with a literal.</td></tr>
<tr><td><strong>&lt;Section&gt;SectionController</strong></td><td><code>@MainActor</code> class</td><td>Shapes the section's content from the settings objects and applies the section's actions to them.</td></tr>
<tr><td><strong>Settings objects</strong></td><td><code>@Observable</code>, from <a href="/guide/02-4-settings">2.4</a></td><td>The model. The only thing any section controller writes.</td></tr>
</tbody>
</table>
</div>

The notebook app's window has two panes. <strong>General</strong> holds an Editor section (font size, line numbers — the `EditorSettings` object from Chapter 2.4) and a Sync section (whether to sync automatically, and how often). <strong>Appearance</strong> holds a single section choosing between automatic, light and dark. Two panes, three sections, two of the three shapes a section can take.

## The window and its tabs

One window, reached through a shared instance like every other app-level object in <a href="/guide/02-5-object-wiring">Chapter 2.5</a>. The app menu's "Settings…" item is a nil-targeted `showSettings:` action; the app delegate answers it the way <a href="/guide/02-1-app-delegate">Chapter 2.1</a> answers everything — by forwarding to the object that owns the domain, never by owning the window itself:

```swift
// AppDelegate
@objc func showSettings(_ sender: Any?) {
    SettingsWindowController.shared.show(sender: sender)
}
```

```swift
// UI/Screens/Settings/SettingsWindowController.swift

@MainActor
final class SettingsWindowController: NSWindowController {
    static let shared = SettingsWindowController()

    private let tabs: SettingsTabViewController

    private init() {
        let tabs = SettingsTabViewController()
        self.tabs = tabs

        let window = NSWindow(contentViewController: tabs)
        window.styleMask = [.titled, .closable]
        window.toolbarStyle = .preference
        // Size before centring. Until the first layout pass the window still has
        // NSTabViewController's default 500×500 content size, so centring first would
        // centre the wrong rectangle and leave the window visibly off once it resizes.
        window.setContentSize(SettingsTabViewController.contentSize)
        window.center()

        super.init(window: window)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    /// Shows the window, switched to `tab` — the one entry point for a menu item,
    /// a "Configure sync…" button, or a URL.
    func show(_ tab: SettingsTab = .general, sender: Any? = nil) {
        tabs.select(tab)
        showWindow(sender)
    }
}
```

`show(_:sender:)` is the deep link. Every place in the app that wants to open settings on a particular pane — a "Configure sync…" button beside a disabled sync badge, a navigation URL from <a href="/guide/09-navigation">Chapter 9</a> — calls this one method with a `SettingsTab` case, and never reaches into the tab controller.

The tab controller adds one tab per pane, hosts each pane's Screen, and holds every pane to one size:

```swift
// UI/Screens/Settings/SettingsTabViewController.swift

enum SettingsTab: String, CaseIterable {
    case general, appearance

    var label: String {
        switch self {
        case .general: "General"
        case .appearance: "Appearance"
        }
    }

    var symbolName: String {
        switch self {
        case .general: "gearshape"
        case .appearance: "paintbrush"
        }
    }
}

@MainActor
final class SettingsTabViewController: NSTabViewController {

    /// Every pane is held to this size, and so is the window. Fixed rather than derived
    /// from each pane's content, so the window doesn't jump as the user switches tabs.
    /// A pane shorter than this simply leaves the remaining height unused.
    static let contentSize = NSSize(width: 680, height: 400)

    init() {
        super.init(nibName: nil, bundle: nil)
        tabStyle = .toolbar
        addPane(.general, content: GeneralSettingsScreen())
        addPane(.appearance, content: AppearanceSettingsScreen())
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func select(_ tab: SettingsTab) {
        guard let index = tabViewItems.firstIndex(where: { $0.identifier as? String == tab.rawValue }) else { return }
        selectedTabViewItemIndex = index
    }

    private func addPane<Content: View>(_ tab: SettingsTab, content: Content) {
        // Top-aligned in the fixed box, so a pane with less content than the window is
        // tall stops at its natural height instead of stretching to the bottom.
        let pane = content.frame(
            width: Self.contentSize.width,
            height: Self.contentSize.height,
            alignment: .top
        )
        let host = NSHostingController(rootView: pane)
        // NSTabViewController sizes the window from each pane's preferredContentSize and
        // consults nothing else — not the fitting size, not the intrinsic content size.
        // Without this the window keeps the tab controller's own 500×500 default.
        host.preferredContentSize = Self.contentSize

        let item = NSTabViewItem(viewController: host)
        item.identifier = tab.rawValue
        item.label = tab.label
        item.image = NSImage(systemSymbolName: tab.symbolName, accessibilityDescription: tab.label)
        addTabViewItem(item)
    }
}
```

`NSHostingController` is the right host here by <a href="/guide/08-1-views">Chapter 8.1</a>'s rule: a pane's entire content is SwiftUI and the controller has no lifecycle work of its own, so there's nothing for a custom `NSViewController` to do. The tab controller does the rest — it builds the toolbar from the tab items, switches panes, and retitles the window after the selected pane's label, which is why the window is titled "General", not "Settings", exactly as System Settings is.

Two sizing facts cost most first implementations an afternoon, and both are in the comments above. `preferredContentSize` is the <em>only</em> size the tab controller reads from a pane, so a hosted SwiftUI view's fitting size is ignored no matter how carefully it's framed. And the window has to be sized before it's centred, because until the first layout pass it's still the tab controller's default size. Holding every pane to one fixed size is the simple choice and the one made here. The alternative — a different `preferredContentSize` per pane, with the tab controller resizing the window on every switch — is what System Settings does, and works, at the cost of a visible relayout unless the transition is animated by hand.

## A pane is a Screen of sections

A pane's root is a SwiftUI <strong>Screen</strong> in <a href="/guide/08-1-views">Chapter 8.1</a>'s naming: it owns the controllers, hands each view what it renders, and routes each view's intents back — the view-controller role, in the only place this guide lets SwiftUI play it, because a pane has no AppKit chrome of its own to coordinate. The Screen is a thin composition root and nothing else:

```swift
// UI/Screens/Settings/General/GeneralSettingsScreen.swift

/// The root of the General pane. Owns one controller per section, hands each section
/// view its content, and forwards each section's actions to the matching controller.
/// Sections stay dumb and self-contained; this Screen is the only place they're wired.
struct GeneralSettingsScreen: View {
    @State private var sync = SyncSectionController()

    var body: some View {
        VStack(spacing: 0) {
            EditorSectionView(settings: EditorSettings.shared)
            Divider()
                .padding(.horizontal, 20)
            SyncSectionView(content: sync.content, perform: sync.handle)
        }
    }
}
```

Two sections, wired two different ways, and the difference is the subject of the next two sections of this chapter. As the pane grows it gains more lines here — one section view and, where needed, one controller each — and the Screen stays a list.

## A section that binds directly

The Editor section is the `EditorSettings` object from <a href="/guide/02-4-settings">Chapter 2.4</a>, edited in place. Every control maps one-to-one onto a property of the settings object; nothing is derived, filtered, or validated; writing the property <em>is</em> the whole effect. That is the one exception <a href="/guide/08-2-view-state">Chapter 8.2</a> grants to the model-and-closures rule — a flat settings object is its own manager, so there is no controller to go around — and the section takes the settings object by reference and binds to it:

```swift
// UI/Screens/Settings/General/EditorSectionView.swift

struct EditorSectionView: View {
    @Bindable var settings: EditorSettings

    var body: some View {
        SettingsForm {
            SettingsRow(label: "Font size") {
                Stepper("\(settings.fontSize) pt", value: $settings.fontSize, in: 10...24)
            }
            SettingsRow {
                Toggle("Show line numbers", isOn: $settings.showLineNumbers)
            }
        }
    }
}
```

Reactivity is free: the properties are read inside `body`, the object is `@Observable`, and a change from anywhere — this window, a menu item, a script — re-renders the section. It is also as far as this shape goes. The moment a section needs to do anything but read and write flat values, it graduates.

## A section with a controller

The Sync section has one wrinkle: the interval picker is only meaningful while automatic sync is on. That's a value <em>derived</em> from a setting, not a setting — and per <a href="/guide/05-model-layer">Chapter 5</a>, the moment a screen derives, combines, or filters what a settings object holds, it has graduated to needing its own display object like everything else. A section that also validates a selection, computes the list of options offered, or triggers an effect beyond the write itself graduates for the same reason.

The section becomes four types in two files: what the view renders, what the view can ask for, the controller that connects both to the settings object, and the view.

```swift
// UI/Screens/Settings/General/SyncSectionController.swift

/// What the Sync section renders. Pure data, constructable in any state.
struct SyncSectionContent: Equatable {
    var syncsAutomatically: Bool
    var interval: SyncInterval
    var intervals: [SyncInterval]
    var canEditInterval: Bool
}

/// What the Sync section can ask for. The view never writes a setting itself — it
/// sends one of these to `perform`, and the controller makes the change.
enum SyncSectionAction: Equatable {
    case setSyncsAutomatically(Bool)
    case selectInterval(SyncInterval)
}

/// Shapes the section's content from the settings object, and applies the section's
/// actions to it. Reaches the shared settings object directly, like any controller
/// in Chapter 2.5 — nothing is injected.
@MainActor
final class SyncSectionController {

    var content: SyncSectionContent {
        let settings = SyncSettings.shared
        return SyncSectionContent(
            syncsAutomatically: settings.syncsAutomatically,
            interval: settings.interval,
            intervals: SyncInterval.allCases,
            canEditInterval: settings.syncsAutomatically
        )
    }

    func handle(_ action: SyncSectionAction) {
        switch action {
        case .setSyncsAutomatically(let enabled):
            SyncSettings.shared.syncsAutomatically = enabled
        case .selectInterval(let interval):
            SyncSettings.shared.interval = interval
        }
    }
}
```

`content` is computed, not stored, and the controller is not `@Observable` — deliberately. The settings object it reads <em>is</em> observable, and the Screen reads `sync.content` inside its own `body`, so every settings property the computation touches is tracked right there. A write from `handle`, from another window, or from outside the app re-renders the section with no seeding, no copies, and no subscription to keep current. That is what an `@Observable` settings object buys; a controller in front of a settings store that <em>isn't</em> observable would have to seed private copies from it and re-read after every write, and would still miss changes made anywhere else.

This is <a href="/guide/08-2-view-state">Chapter 8.2</a>'s pair with its model collapsed to a value: `SyncSectionController` is the writer, `SyncSectionContent` is the state, and the view never sees the controller. The one difference from a state controller in an AppKit screen is that there is nothing to load and nothing to subscribe to, so the controller carries no `Task` and no `observeState()`. If a section ever needs either — an options list fetched from a server, say — it grows into a full state controller writing an `@Observable` model, and the Screen hands that model down by reference instead. The view is the same either way:

```swift
// UI/Screens/Settings/General/SyncSectionView.swift

/// The Sync section: the automatic-sync toggle and the interval picker.
///
/// A dumb view — it renders a `SyncSectionContent` and routes every interaction back
/// through `perform`. It owns no model, so every state is one literal away in a preview.
struct SyncSectionView: View {
    let content: SyncSectionContent
    let perform: (SyncSectionAction) -> Void

    var body: some View {
        SettingsForm {
            SettingsRow {
                Toggle("Sync automatically", isOn: syncsAutomatically)
            }
            SettingsRow(label: "Every") {
                Picker("", selection: interval) {
                    ForEach(content.intervals, id: \.self) { interval in
                        Text(title(for: interval)).tag(interval)
                    }
                }
                .labelsHidden()
                .fixedSize()
                .disabled(!content.canEditInterval)
            }
        }
    }

    // Bindings turn a control's edit into an action; every read comes from `content`.

    private var syncsAutomatically: Binding<Bool> {
        Binding(get: { content.syncsAutomatically }, set: { perform(.setSyncsAutomatically($0)) })
    }

    private var interval: Binding<SyncInterval> {
        Binding(get: { content.interval }, set: { perform(.selectInterval($0)) })
    }

    // Presentation — the interval → string mapping lives here, nowhere else.
    private func title(for interval: SyncInterval) -> String {
        switch interval {
        case .fiveMinutes: "5 minutes"
        case .fifteenMinutes: "15 minutes"
        case .hourly: "Hour"
        }
    }
}

#Preview("Automatic sync on") {
    SyncSectionView(
        content: SyncSectionContent(
            syncsAutomatically: true, interval: .fifteenMinutes,
            intervals: SyncInterval.allCases, canEditInterval: true
        ),
        perform: { _ in }
    )
    .frame(width: 680)
}

#Preview("Automatic sync off") {
    SyncSectionView(
        content: SyncSectionContent(
            syncsAutomatically: false, interval: .fifteenMinutes,
            intervals: SyncInterval.allCases, canEditInterval: false
        ),
        perform: { _ in }
    )
    .frame(width: 680)
}
```

A `Binding` is how a SwiftUI control edits something, and a dumb view has nothing to edit — so each binding's getter reads `content` and its setter emits an action. The view's interface is still exactly two things: a value in, one closure out. One `perform` closure taking an enum, rather than one closure per control, keeps that interface the same size however many controls the section grows, and gives a test a single seam to assert on: "toggling this control emits `.setSyncsAutomatically(false)`."

<div class="rule">
<span class="rule-label">The rule</span>

A section binds straight to a settings object only when every control is a flat property of it and writing the property is the whole effect. The moment a control's state is <em>derived</em> from a setting, a selection needs validating or falling back, the options offered are computed, or the write has to trigger something beyond itself, the section gets a controller — and the view goes back to taking content and a `perform` closure, and nothing else.

</div>

## A section whose write has an effect

The Appearance pane's one section chooses between automatic, light and dark. Selecting a mode has to change the whole app's appearance — and that effect does <em>not</em> belong in the section controller. The controller writes the setting, full stop:

```swift
// UI/Screens/Settings/Appearance/AppearanceSectionController.swift

struct AppearanceSectionContent: Equatable {
    var modes: [AppearanceMode]
    var selected: AppearanceMode
}

enum AppearanceSectionAction: Equatable {
    case select(AppearanceMode)
}

@MainActor
final class AppearanceSectionController {
    var content: AppearanceSectionContent {
        AppearanceSectionContent(modes: AppearanceMode.allCases, selected: AppearanceSettings.shared.mode)
    }

    func handle(_ action: AppearanceSectionAction) {
        switch action {
        case .select(let mode):
            AppearanceSettings.shared.mode = mode
        }
    }
}
```

Applying the mode to `NSApp.appearance` is work with no gesture behind it — it has to happen at launch, when the setting changes from this window, and when it changes from anywhere else — which makes it a background controller from <a href="/guide/04-background-controllers">Chapter 4</a>, started in the launch phase, tracking the setting the same way a view controller tracks its state:

```swift
// BackgroundControllers/AppearanceApplier.swift

@MainActor @StateObserving
final class AppearanceApplier: BackgroundController {
    func startRunningInBackground() { activateObservation() }
    func stopRunningInBackground() { deactivateObservation() }

    func observeState() {
        observations.track {
            NSApp.appearance = Self.appearance(for: AppearanceSettings.shared.mode)
        }
    }

    private static func appearance(for mode: AppearanceMode) -> NSAppearance? {
        switch mode {
        case .automatic: nil
        case .light: NSAppearance(named: .aqua)
        case .dark: NSAppearance(named: .darkAqua)
        }
    }
}
```

The settings object is the funnel, and everything that cares about the value reacts to the settings object — never to the section controller that happened to write it. That is the same single-writer, many-readers shape as every manager in <a href="/guide/05-model-layer">Chapter 5</a>; the section controller is one writer among several possible ones, not the owner of what happens next.

## The form

Every section renders through the same two-column form: a right-aligned label column and a control column, split 38/62, labels ending in a colon, each label lined up on the first text baseline of the control column so a label sits level with the first of several stacked checkboxes. It's the classic Mac preferences layout, and since SwiftUI's `Form` sizes its columns to content rather than proportionally, it's a small custom `Layout` — the one piece of this chapter worth lifting verbatim:

```swift
// UI/Screens/Settings/SettingsForm.swift

/// The default layout for a settings section: right-aligned labels, controls beside them.
///
///     SettingsForm {
///         SettingsRow(label: "Every") { Picker(…) }
///         SettingsRow { Toggle(…) }        // labelless: a column of checkboxes needs none
///     }
struct SettingsForm<Content: View>: View {
    private let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            content
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .top)
    }
}

/// How a row's label lines up with its control.
enum SettingsRowAlignment: Equatable {
    /// The label's baseline meets the first text baseline in the control column. Right for
    /// rows of text-bearing controls — pickers, checkboxes — which is most of them.
    case firstBaseline
    /// The label's top meets the control's top, dropped by `padding`. Right for rows whose
    /// control leads with artwork rather than text — baseline alignment would hunt for the
    /// first text in the column and drag the label down to a caption underneath.
    case top(padding: CGFloat)

    static var top: SettingsRowAlignment { .top(padding: 0) }
}

/// One row: an optional label in the 38% column, a control in the 62% column.
struct SettingsRow<Control: View>: View {
    private let label: String?
    private let alignment: SettingsRowAlignment
    private let control: Control

    init(label: String, alignment: SettingsRowAlignment = .firstBaseline, @ViewBuilder control: () -> Control) {
        self.label = label
        self.alignment = alignment
        self.control = control()
    }

    /// A row without a label. The control still takes the control column, so it stays
    /// aligned with the labelled rows around it.
    init(alignment: SettingsRowAlignment = .firstBaseline, @ViewBuilder control: () -> Control) {
        self.label = nil
        self.alignment = alignment
        self.control = control()
    }

    var body: some View {
        ProportionalColumns(labelFraction: 0.38, alignment: alignment) {
            if let label {
                Text("\(label):")
                    .frame(maxWidth: .infinity, alignment: .trailing)
            } else {
                Color.clear.frame(width: 0, height: 0)
            }
            control
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// Two columns split by a fixed fraction, independent of what's in them — a `Grid`
/// would size its columns to content. Exactly two subviews: the label, then the control.
private struct ProportionalColumns: Layout {
    let labelFraction: CGFloat
    let alignment: SettingsRowAlignment
    private let spacing: CGFloat = 10

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        // Falling back to the columns' own ideal width is what lets a form size itself
        // to its content when nothing proposes a width.
        let width = proposal.width ?? idealWidth(for: subviews)
        let placements = placements(for: subviews, widths: columnWidths(for: width), height: proposal.height)
        let height = placements.map { $0.offset + $0.height }.max() ?? 0
        return CGSize(width: width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard subviews.count == 2 else { return }
        let widths = columnWidths(for: bounds.width)
        let placements = placements(for: subviews, widths: widths, height: bounds.height)
        var x = bounds.minX
        for (index, subview) in subviews.enumerated() {
            subview.place(
                at: CGPoint(x: x, y: bounds.minY + placements[index].offset),
                anchor: .topLeading,
                proposal: .init(width: widths[index], height: bounds.height)
            )
            x += widths[index] + spacing
        }
    }

    /// The narrowest total width at which neither column has to compress.
    private func idealWidth(for subviews: Subviews) -> CGFloat {
        guard subviews.count == 2 else { return 0 }
        let labelIdeal = subviews[0].sizeThatFits(.unspecified).width / labelFraction
        let controlIdeal = subviews[1].sizeThatFits(.unspecified).width / (1 - labelFraction)
        return max(labelIdeal, controlIdeal) + spacing
    }

    /// Offsets each column down so the row's alignment lines up. For `.firstBaseline`,
    /// each column drops until its first text baseline meets the lowest one across the
    /// row. For `.top`, only the label moves, and only by the padding the row asked for.
    private func placements(for subviews: Subviews, widths: [CGFloat], height: CGFloat?) -> [(offset: CGFloat, height: CGFloat)] {
        let dimensions = zip(subviews, widths).map { subview, width in
            subview.dimensions(in: .init(width: width, height: height))
        }
        switch alignment {
        case .top(let padding):
            return dimensions.enumerated().map { index, dimension in
                (offset: index == 0 ? padding : 0, height: dimension.height)
            }
        case .firstBaseline:
            let baselines = dimensions.map { $0[.firstTextBaseline] }
            let lowest = baselines.max() ?? 0
            return zip(dimensions, baselines).map { dimension, baseline in
                (offset: lowest - baseline, height: dimension.height)
            }
        }
    }

    private func columnWidths(for totalWidth: CGFloat) -> [CGFloat] {
        let available = max(0, totalWidth - spacing)
        let labelWidth = available * labelFraction
        return [labelWidth, available - labelWidth]
    }
}
```

The `.top(padding:)` alignment exists for the Appearance section: its control is a row of swatches captioned underneath, and first-baseline alignment would find that caption and drag the "Appearance:" label down to it. A few points of top padding puts the label level with the swatches' optical centre instead. Everything else in the window is text-first and uses the default.

## Where it lives, and how it's tested

The settings <em>objects</em> are model — `App/Settings/` in <a href="/guide/01-1-project-layout">Chapter 1.1</a>'s tree, next to the app environment they belong to. Everything in this chapter is one screen, and lives with it:

```
UI/Screens/Settings/
├── SettingsWindowController.swift
├── SettingsTabViewController.swift      SettingsTab
├── SettingsForm.swift                   SettingsForm, SettingsRow, SettingsRowAlignment
├── General/
│   ├── GeneralSettingsScreen.swift
│   ├── EditorSectionView.swift
│   ├── SyncSectionController.swift      SyncSectionContent, SyncSectionAction, SyncSectionController
│   └── SyncSectionView.swift
└── Appearance/
    ├── AppearanceSettingsScreen.swift
    ├── AppearanceSectionController.swift
    └── AppearanceSectionView.swift
```

Naming follows what the user sees: the pane is named after its tab, the section after its heading, and each section's four types share the section's name with a `Content`, `Action`, `Controller`, or `View` suffix — never `Settings`, which is the model's word. `SyncSettings` is the object in `App/Settings/`; `SyncSection…` is the UI that edits it.

Testing splits the same way. The settings objects are tested as models — <a href="/guide/10-6-testing-each-layer">Chapter 10.6</a> — against the isolated `UserDefaults` suite that <a href="/guide/10-5-inside-a-test-class">Chapter 10.5</a>'s test base class installs. A section controller is tested like any view state controller, on the content it produces: construct it, call `handle`, and assert on `content` — `handle(.setSyncsAutomatically(false))` leaves `content.canEditInterval` false. The views are covered by their previews, one per state, and are not unit-tested; the window and tab controllers are wiring, and aren't either.

<div class="seealso">
<strong>Ahead in this guide</strong>
Opening the window on a given pane from a URL is one use of the navigation stack in <a href="/guide/09-navigation">Chapter 9</a>. Testing the settings objects and section controllers built here is <a href="/guide/10-6-testing-each-layer">Chapter 10.6</a>.
</div>
