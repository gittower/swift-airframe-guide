---
title: "Settings"
description: "User-facing configuration — preferences, feature toggles, anything the user changes and expects to persist — lives in a settings object backed by a key-value store. This subchapter covers that shape: the one model simple enough to be its own manager."
order: 2
subOrder: 4
---

User-facing configuration — preferences, feature toggles, anything the user changes and expects to persist — lives in a settings object backed by a key-value store. This subchapter covers that shape: the one model simple enough to be its own manager.

## Settings objects

The settings object <em>is</em> its own manager: there's no separate persistence layer to coordinate, so a setter that writes straight through is the whole implementation.

```swift
@MainActor
final class EditorSettings {
    static let shared = EditorSettings()

    @UserDefault(key: .editorFontSize)
    var fontSize = 13

    @UserDefault(key: .showLineNumbers)
    var showLineNumbers = true

    private init() { }
}

fileprivate extension UserDefaultsKey {
    static let editorFontSize: Self = "EditorFontSize"
    static let showLineNumbers: Self = "ShowLineNumbers"
}
```

The class is `@MainActor` and deliberately <em>not</em> `@Observable`. Tracking already happens one property at a time: the `@UserDefault` wrapper registers every read with Observation and notifies on every change to its key — through this object, another window, or a `defaults write` from outside the app. Putting the macro on the class would add nothing but the `Observable` conformance, and would cost an `@ObservationIgnored` on every wrapped property, because the macro can't rewrite a property a wrapper has already turned into a computed one. Keys are dot-free: the wrapper watches its key through KVO, which reads a dot as a key path.

A view reads it directly — no injection, no protocol, just the shared instance:

```swift
struct EditorSectionView: View {
    var body: some View {
        Stepper("Font size: \(EditorSettings.shared.fontSize) pt", value: fontSize, in: 10...24)
        Toggle("Show line numbers", isOn: showLineNumbers)
    }

    // A control edits through a Binding: the getter reads the setting, the setter writes it.
    private var fontSize: Binding<Int> {
        Binding(get: { EditorSettings.shared.fontSize }, set: { EditorSettings.shared.fontSize = $0 })
    }

    private var showLineNumbers: Binding<Bool> {
        Binding(get: { EditorSettings.shared.showLineNumbers }, set: { EditorSettings.shared.showLineNumbers = $0 })
    }
}
```

Reading a setting inside `body` is what keeps the view live, and `observations.track` in an AppKit view controller picks it up the same way. `$settings.fontSize`-style bindings would need `@Bindable`, which needs the `Observable` conformance the class doesn't carry; a view that genuinely can't do without it is the one reason to add the macro back, with a comment saying so.

That view is one section of the app's settings window; <a href="/guide/07-6-settings-window">Chapter 7.6</a> builds the window around it, and covers the point at which a section outgrows a direct binding like this one and needs a controller in between.

Two boundaries keep this shape honest. Views may read it directly only because nothing ever writes to it from a background job — the moment background work funnels through a settings object, it stops qualifying and becomes a regular manager-fronted model; <a href="/guide/05-1-the-model">Chapter 5.1</a> draws that line precisely. And it holds <em>user</em> configuration, not launch configuration — the values a subsystem needs before it can start at all are a `configure(_:)`d struct, covered in <a href="/guide/02-5-object-wiring">Object Wiring</a>.

One more distinction decides where a settings object <em>lives</em>. `EditorSettings` is app configuration: the user sets it once and every window honors it, so it sits in the app environment — `App/Settings/` in the tree from <a href="/guide/01-1-project-layout">Chapter 1.1</a>. A sort order, a collapsed section, a column width that one screen remembers about itself is <em>view</em> settings: the same `@UserDefault` shape, but it belongs to the screen and nothing outside the screen reads it, so it lives next to that screen's view controller. The test is who reads it, not how it's stored.

Settings get their own full treatment as one shape in the Model layer's catalog — see <a href="/guide/05-7-model-shapes">Chapter 5.7</a>.
