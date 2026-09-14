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

### Configurable shared instance — the config is the global

Some shared instances can't be built from nothing — they need a URL, a machine identity, product metadata known only at launch. The tempting shape is a root "service" object built at launch, holding the config and every component of the subsystem behind it. Resist it: make the <em>config itself</em> the configured global, and let each component be its own flat shared instance that reads it.

```swift
public struct SyncConfig: Sendable {
    // base URL, account identity, local sync directory …

    public private(set) static var shared: SyncConfig!

    /// Call once at launch, from an app initializer, before anything reads the stack.
    public static func configure(_ config: SyncConfig) {
        shared = config
    }
}

@MainActor
public final class SyncStore {
    public static let shared = SyncStore()       // pure model — data only, not @Observable
}

@MainActor
public final class SyncManager {
    public static let shared = SyncManager()     // heavy mutator — reads SyncConfig.shared
}
```

The details that make this shape work:

- <strong>One config value, not a pile of injected dependencies.</strong> `SyncConfig` is a plain `Sendable` struct of values. When the subsystem lives in a package, the config can also carry closures for the questions only the host app can answer — an optional closure doubling as "capability absent" — so the package reads no other globals and hard-codes no paths, without needing a protocol to stay decoupled.
- <strong>`configure` runs once, from an initializer</strong> — phase 1, before anything downstream can read the stack.
- <strong>`shared` is force-unwrapped on purpose.</strong> If sync is essential to the app, reaching it before `configure` ran is a launch-ordering bug. It should crash loudly in development, not limp along silently. Reach for an optional only when "not configured yet" is a real, handleable state — not a bug you want surfaced immediately.
- <strong>No root object.</strong> A `SyncService.current` that merely holds `config`, `store`, and `manager` adds a layer without adding behavior — `SyncService.current.store` and `SyncStore.shared` both reach a global either way, so keep the flat, ergonomic accessor and drop the wrapper. Every component that would have hung off the root becomes its own shared instance reading the config directly.
- <strong>Split by weight.</strong> The heavy mutator (`SyncManager` — network client, persistence, background work) and the pure model (`SyncStore` — data only) stay separate shared instances. Read-only consumers go to the store and never touch the manager. Neither is `@Observable` — see <a href="/guide/03-model-layer">Chapter 3</a>; the manager posts a notification after a write, and whatever view needs to react builds its own display object from it.
- <strong>Derived globals stay computed, not configured.</strong> Anything fully derivable from the config — a path layout built from the configured sync directory, say — is a computed property or factory over `SyncConfig.shared`. One configured global per module; everything else follows from it.

### When "shared" is per-notebook, not per-app

Some component families exist once per <em>key</em> rather than once per app — per notebook, per document, per account. The flat surface survives, keyed: `NoteStore.shared(for: notebook)`. Behind those accessors sits one internal context class per key — an implementation detail, never API — whose `private init` is the single place that notebook's component graph is decided: which stores share a serial runner because they write under the same directory, which manager owns its own queue. The components become long-lived per-key instances, which is exactly what lets a manager <em>own</em> a queue that must outlive any one operation. App-wide pieces stay plain shared statics; only the genuinely per-key components go through the context.

<div class="seealso">
<strong>Ahead in this guide</strong>
The manager/store split introduced here runs through <a href="/guide/03-model-layer">Chapter 3</a>, where the persisted, database-backed model shape is built on exactly that pair. Background controllers — the long-lived objects <em>started</em> in phase 4 — are covered in <a href="/guide/04-2-action-controllers">Chapter 4.2</a>.
</div>
