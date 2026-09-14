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
@Observable @MainActor
final class EditorSettings {
    static let shared = EditorSettings()

    @UserDefault("editorFontSize", defaultValue: 13)
    var fontSize: Int

    @UserDefault("showLineNumbers", defaultValue: true)
    var showLineNumbers: Bool

    private init() { }
}
```

A view reads it directly — no injection, no protocol, just the shared instance:

```swift
struct PreferencesView: View {
    let settings = EditorSettings.shared

    var body: some View {
        Stepper("Font size: \(settings.fontSize)",
                value: Bindable(settings).fontSize, in: 10...24)
    }
}
```

Two boundaries keep this shape honest. It's `@Observable` only because nothing ever writes to it from a background job — the moment background work funnels through a settings object, it stops qualifying and becomes a regular manager-fronted model; <a href="/guide/05-model-layer">Chapter 5</a> draws that line precisely. And it holds <em>user</em> configuration, not launch configuration — the values a subsystem needs before it can start at all are a `configure(_:)`d struct, covered in <a href="/guide/02-5-object-wiring">Object Wiring</a>.

Settings get their own full treatment as one shape in the Model layer's pattern catalog — see <a href="/guide/05-model-layer">Chapter 5</a>.
