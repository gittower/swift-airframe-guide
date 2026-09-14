---
title: "Object Wiring"
description: "Airframe has no dependency-injection container — and, outside a handful of external boundaries, no dependency injection at all. This subchapter covers the three ways an object gets its collaborators instead, why a shared instance is not a singleton, and when a seam is actually worth its indirection."
order: 2
subOrder: 5
---

Airframe has no dependency-injection container — and, outside a handful of external boundaries, no dependency injection at all. This subchapter covers the three ways an object gets its collaborators instead, why a shared instance is not a singleton, and when a seam is actually worth its indirection.

## Why there's no injection

That's a position, not an omission. An injected dependency is a seam: a point where behavior can vary. A seam earns its indirection when something real varies — a second storage backend that actually ships, a policy shared across subsystems, an external boundary like the network or the clock that a test can't control directly. Most dependencies never vary. Their protocol would mirror its single implementation one-to-one, every caller would thread them through constructors, and ownership — who builds this, who keeps it alive — would blur into whoever happened to wire the graph.

<div class="rule">
<span class="rule-label">The rule</span>

Inject only what varies in production. A dependency whose only second implementation is a test mock isn't a real variation point — it's an internal detail wearing a protocol, and the mock proves the mock. Start concrete; add a seam when a second real implementation arrives, not in case one might. Tests get their seams at the external boundaries instead — the HTTP layer, the store underneath — which is <a href="/guide/10-testing">Chapter 10</a>'s subject.

</div>

Instead, every object gets its collaborators one of three ways, and the choice is mechanical once you know which case you're in.

## Own it, build it

If a collaborator dies with its owner and nothing else needs the same instance, just construct it. Don't thread a protocol through the initializer for something that has exactly one implementation and one caller.

```swift
@MainActor
final class NotebookListController {
    private let formatter = RelativeDateFormatter()   // owned outright
}
```

## Shared, because it's genuinely shared

Serial queues, caches, and process-level resources are shared by construction — every caller wants the same instance, so reach for it directly rather than passing it around.

```swift
final class SyncQueue: OperationQueue {
    static let sharedInstance = SyncQueue()
}

// call site
SyncQueue.sharedInstance.addOperation(uploadOperation)
```

### A shared instance is not a singleton

"Shared" here means what it means throughout Cocoa — `UserDefaults.standard`, `FileManager.default`, `NotificationCenter.default`. The accessor names the one instance that matters at runtime; it doesn't seal the type. `UserDefaults(suiteName:)` sits right next to `.standard`, and a test that needs a scratch instance constructs one. That still-callable initializer is the built-in test seam — the reason none of these types ever needs to be injected — and it's the pattern to follow for shared types where an independent instance is coherent: a queue, a store, a formatter get `static let shared` <em>and</em> an ordinary initializer.

The exception is deliberate, not accidental: a manager's `init` is private (<a href="/guide/05-model-layer">Chapter 5</a>) because a second instance wouldn't be a test convenience — it would be a second write funnel, and the one-funnel guarantee is the manager's entire point. Tests reach a manager the same way production does, through `.shared`, with the seam pushed down to the boundary underneath it (<a href="/guide/10-testing">Chapter 10</a>). Both shapes are the same decision read off the type's semantics: keep the initializer callable when a second instance is valid, close it when a second instance is a bug.

## Configurable shared instance — the config is the global

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
- <strong>`configure` runs once, from an initializer</strong> — phase 1 of <a href="/guide/02-2-startup">Startup</a>, before anything downstream can read the stack.
- <strong>`shared` is force-unwrapped on purpose.</strong> If sync is essential to the app, reaching it before `configure` ran is a launch-ordering bug. It should crash loudly in development, not limp along silently. Reach for an optional only when "not configured yet" is a real, handleable state — not a bug you want surfaced immediately.
- <strong>No root object.</strong> A `SyncService.current` that merely holds `config`, `store`, and `manager` adds a layer without adding behavior — `SyncService.current.store` and `SyncStore.shared` both reach a global either way, so keep the flat, ergonomic accessor and drop the wrapper. Every component that would have hung off the root becomes its own shared instance reading the config directly. (The app delegate is the same trap with a platform face — see <a href="/guide/02-1-app-delegate">The App Delegate</a>.)
- <strong>Split by weight.</strong> The heavy mutator (`SyncManager` — network client, persistence, background work) and the pure model (`SyncStore` — data only) stay separate shared instances. Read-only consumers go to the store and never touch the manager. Neither is `@Observable` — see <a href="/guide/05-model-layer">Chapter 5</a>; the manager posts a notification after a write, and whatever view needs to react builds its own display object from it.
- <strong>Derived globals stay computed, not configured.</strong> Anything fully derivable from the config — a path layout built from the configured sync directory, say — is a computed property or factory over `SyncConfig.shared`. One configured global per module; everything else follows from it.

## When "shared" is per-notebook, not per-app

Some component families exist once per <em>key</em> rather than once per app — per notebook, per document, per account. The flat surface survives, keyed: `NoteStore.shared(for: notebook)`. Behind those accessors sits one internal context class per key — an implementation detail, never API — whose `private init` is the single place that notebook's component graph is decided: which stores share a serial runner because they write under the same directory, which manager owns its own queue. The components become long-lived per-key instances, which is exactly what lets a manager <em>own</em> a queue that must outlive any one operation. App-wide pieces stay plain shared statics; only the genuinely per-key components go through the context.
