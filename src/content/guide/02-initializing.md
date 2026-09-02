---
title: "Initializing"
description: "Launch is the one moment in an app's life where the ordinary rules bend: nothing has state yet, nothing can be presumed configured, and getting the order wrong fails silently until it doesn't. This chapter covers the four phases of startup, where configuration lives, and how objects get wired together at boot."
order: 2
---

Launch is the one moment in an app's life where the ordinary rules bend: nothing has state yet, nothing can be presumed configured, and getting the order wrong fails silently until it doesn't. This chapter covers the four phases of startup, where configuration lives, and how objects get wired together at boot.

## Four phases, in order

Startup runs on top of the platform's own application lifecycle (`applicationWillFinishLaunching`, window restoration, `applicationDidFinishLaunching`), and Airframe layers four phases across it:

<div class="table-wrap">
<table>
<thead><tr><th>Phase</th><th>What runs</th><th>What must not happen</th></tr></thead>
<tbody>
<tr><td><strong>1. Initialize</strong></td><td>A fixed sequence of initializers configure essential subsystems — persistence, the sync client, feature flags.</td><td>No expensive reloads. No controller starts here.</td></tr>
<tr><td><strong>2. Startup gates</strong></td><td>Modal states that must resolve before the app is usable: onboarding, an expired trial, a revoked license.</td><td>No window opens behind the gate. The app is not yet "launched."</td></tr>
<tr><td><strong>3. Restore windows</strong></td><td>The platform hands back windows from the last session. If a gate is showing, restoration is held and replayed after.</td><td>Restored windows must never appear behind or before a gate — ordering is enforced, not assumed.</td></tr>
<tr><td><strong>4. Launch</strong></td><td>Deferred windows appear, a default window opens if none were restored, background controllers start, cleanup and update tasks run.</td><td>Nothing in this phase blocks — by now the user is looking at a window.</td></tr>
</tbody>
</table>
</div>

<div class="rule">
<span class="rule-label">The rule</span>

Initializers only call into the Model layer. They never start a controller and never show UI — controllers are written assuming the subsystems they depend on are already configured, and some are allowed to show alerts, which is exactly what must not happen before the user has passed the startup gates.

</div>

### Why restoration needs a coordinator

The platform triggers window restoration between <em>will</em>-finish-launching and <em>did</em>-finish-launching — before phase 2 has had a chance to decide whether a gate needs to show. A restored window can't simply appear the moment the platform hands it back, or it would appear behind (or before) an onboarding screen that hasn't been decided yet. A restoration coordinator resolves this: it holds each restored window until the startup-gate decision is final, then either shows it immediately or replays it once the gate clears.

```swift
static func restoreWindow(
    withIdentifier identifier: NSUserInterfaceItemIdentifier,
    state: NSCoder,
    completionHandler: @escaping (NSWindow?, Error?) -> Void
) {
    guard let window = window(for: identifier, state: state) else {
        completionHandler(nil, nil)
        return
    }

    if AppStatus.shared.startupMode == .normal {
        completionHandler(window, nil)   // no gate pending — show it now
    } else {
        // hold until the gate resolves, then replay
        shared.store(RestoredWindow(window: window, completionHandler: completionHandler))
    }
}
```

## Configuration: settings objects

User-facing configuration — preferences, feature toggles, anything the user changes and expects to persist — lives in a settings object backed by a key-value store. The settings object <em>is</em> its own manager: there's no separate persistence layer to coordinate, so a setter that writes straight through is the whole implementation.

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

Settings get their own full treatment as one shape in the Model layer's pattern catalog — see <a href="/guide/03-model-layer">Chapter 3</a>.

## Object wiring: construct what you own, reach for shared when you don't

Airframe doesn't use a dependency-injection container. Every object gets its collaborators one of three ways, and the choice is mechanical once you know which case you're in.

### Own it, build it

If a collaborator dies with its owner and nothing else needs the same instance, just construct it. Don't thread a protocol through the initializer for something that has exactly one implementation and one caller.

```swift
@MainActor
final class NotebookListController {
    private let formatter = RelativeDateFormatter()   // owned outright
}
```

### Shared, because it's genuinely shared

Serial queues, caches, and process-level resources are shared by construction — every caller wants the same instance, so reach for it directly rather than passing it around.

```swift
final class SyncQueue: OperationQueue {
    static let sharedInstance = SyncQueue()
}

// call site
SyncQueue.sharedInstance.addOperation(uploadOperation)
```

### Configurable shared instance

Some shared instances can't be built from nothing — they need a URL, a machine identity, product metadata known only at launch. The shape is a private setter, a one-time `configure(_:)` called from an initializer, and everything downstream reading the shared instance without ever mentioning how it was built.

```swift
@MainActor
public final class SyncService {
    public static private(set) var current: SyncService!

    public let config: SyncConfig
    public let store: SyncStore

    public init(config: SyncConfig) {
        self.config = config
        self.store = SyncStore()
    }

    public static func configure(config: SyncConfig) {
        current = SyncService(config: config)
    }
}
```

Three details make this shape work:

- <strong>One config value, not a pile of injected dependencies.</strong> `SyncConfig` is a plain `Sendable` struct — base URL, account identity, nothing else. The app builds it once, at launch, from whatever product-level configuration it already has.
- <strong>`configure` runs once, from an initializer</strong> — phase 1, before anything downstream can read the stack.
- <strong>`current` is force-unwrapped on purpose.</strong> If sync is essential to the app, reaching it before `configure` ran is a launch-ordering bug. It should crash loudly in development, not limp along silently. Reach for an optional only when "not configured yet" is a real, handleable state — not a bug you want surfaced immediately.

<div class="seealso">
<strong>Ahead in this guide</strong>
`SyncService` reappears in <a href="/guide/03-model-layer">Chapter 3</a> as the background-sync half of a persisted, database-backed model. Background controllers — the long-lived objects <em>started</em> in phase 4 — are covered in <a href="/guide/04-actions-and-controllers">Chapter 4</a>.
</div>
