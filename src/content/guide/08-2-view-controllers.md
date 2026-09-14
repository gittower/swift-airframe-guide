---
title: "View Controllers"
description: "A view controller does four jobs — assemble, wire, map, and coordinate — always through the same override point, loadView(). This subchapter covers how a programmatic view controller is structured, and when a piece of UI has earned one of its own rather than staying embedded in its parent's."
order: 8
subOrder: 2
---

A view controller does four jobs — assemble, wire, map, and coordinate — always through the same override point, `loadView()`. This subchapter covers how a programmatic view controller is structured, and when a piece of UI has earned one of its own rather than staying embedded in its parent's. It builds on the view components from <a href="/guide/08-1-views">Chapter 8.1</a> — read that first if you haven't; this chapter doesn't re-explain what a view component is or how one composes.

## The four jobs

<div class="table-wrap">
<table>
<thead><tr><th>Job</th><th>Where</th><th>Does</th></tr></thead>
<tbody>
<tr><td><strong>Assemble</strong></td><td><code>loadView()</code></td><td>Create the root view and every top-level component, and lay them out.</td></tr>
<tr><td><strong>Wire</strong></td><td><code>loadView()</code>, <code>observeState()</code></td><td>Connect action closures and targets where a component is built; declare every subscription the controller reacts to.</td></tr>
<tr><td><strong>Map</strong></td><td>A tracked updater</td><td>Push current state into each component — one line per component, nothing more.</td></tr>
<tr><td><strong>Coordinate</strong></td><td>Action handlers</td><td>Handle a component's outcome and hand off to whatever should happen next — trigger a load, dispatch an Action.</td></tr>
</tbody>
</table>
</div>

A programmatic view controller overrides `loadView()` to build a root `NSView`, assemble its components into it, and assign the result to `self.view` — never calling `super.loadView()`, which would try to load a XIB that doesn't exist. The root view is a plain `NSView`, not a custom subclass; anything that needs its own drawing or behavior belongs on one of the components inside it, not on the root.

<div class="rule">
<span class="rule-label">The rule</span>

`loadView()` is the designated override point for building the view hierarchy — never `viewDidLoad()`. AppKit guarantees the hierarchy is complete by the time `viewDidLoad()` runs, so creating views there instead works by accident more than by design, and invites a second, competing place to look for how the controller is put together.

</div>

The controller references its components, never their leaf controls — it never reaches into a banner's internal label or a button's internal image well. Every state-to-view mapping is one line per component, assigning to a property the component exposes; anything more belongs inside the component itself.

Here's a sync-status view controller in full: a banner showing the current sync state, a button to trigger a sync, and a re-check whenever the notebook's sync settings change.

```swift
// MARK: - View Hierarchy
//
// SyncStatusViewController
// └─ root (NSView)
//    ├─ statusView (SyncStatusView)
//    └─ syncNowButton (NSButton)

@StateObserving
final class SyncStatusViewController: NSViewController {
    let notebook: Notebook   // owner-specific context, pushed in at init

    private let statusView = SyncStatusView()
    private let syncNowButton = NSButton(title: "Sync Now", target: nil, action: nil)

    @Tracked private var syncStatus: SyncState.Status = .idle
    @Tracked private var syncIsConfigured = false

    init(notebook: Notebook) {
        self.notebook = notebook
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    // MARK: Assemble + Wire

    override func loadView() {
        let root = NSView()
        root.addSubview(statusView)
        root.addSubview(syncNowButton)
        // …layout constraints…

        statusView.onRetry = { [weak self] in self?.syncNow() }
        syncNowButton.target = self
        syncNowButton.action = #selector(syncNowTapped)

        self.view = root
    }

    override func viewWillAppear() {
        super.viewWillAppear()
        activateObservation()
    }

    override func viewWillDisappear() {
        super.viewWillDisappear()
        deactivateObservation()
    }

    func observeState() {
        // Bridge — SyncStore isn't `@Observable`, so its manager's change
        // notification is the only way to know its status moved.
        observations.observe(NotificationCenter.default.publisher(for: .syncStatusDidChange)) { [weak self] _ in
            self?.recheckSyncStatus()
        }
        recheckSyncStatus()

        // Bridge — whether this notebook has a sync target configured can
        // change independently, from its own notification.
        observations.observe(NotificationCenter.default.publisher(for: .notebookSyncTargetDidChange)) { [weak self] _ in
            self?.recheckSyncConfiguration()
        }
        recheckSyncConfiguration()

        // Track — renders both bridged values; neither component is touched anywhere else.
        observations.track { [weak self] in self?.updateComponents() }
    }

    private func recheckSyncStatus() {
        syncStatus = SyncStore.shared.status
    }

    private func recheckSyncConfiguration() {
        syncIsConfigured = notebook.hasSyncTarget
    }

    // MARK: Map

    private func updateComponents() {
        statusView.status = syncStatus
        syncNowButton.isEnabled = syncIsConfigured && syncStatus != .syncing
    }

    // MARK: Coordinate

    @objc private func syncNowTapped(_ sender: Any?) {
        syncNow()
    }

    private func syncNow() {
        // Hands off to coordination — an Action Controller builds and
        // dispatches a SyncNotebookAction from here.
    }
}
```

`statusView` is the exact `SyncStatusView` component from <a href="/guide/08-1-views">Chapter 8.1</a> — this controller doesn't rebuild it, it composes it. Both `SyncStore.shared.status` and the notebook's sync target are plain, non-`@Observable` model state, per <a href="/guide/05-model-layer">Chapter 5</a>'s signalling table — so both need a notification bridged into a `@Tracked` property before a tracked updater can render them. Two independent bridges, one tracked updater: each signal gets exactly the subscription it needs, and `updateComponents()` stays a dumb application of whatever the two bridges most recently decided.

## Scoping: when a piece of UI earns its own view controller

The guiding principle is that one view controller covers one logical concern — a self-contained piece of UI you could describe, build, and test in isolation from its siblings. Four questions decide when a piece of UI has outgrown its parent and earned a controller of its own:

<div class="table-wrap">
<table>
<thead><tr><th>Question</th><th>If yes</th></tr></thead>
<tbody>
<tr><td>Does it need its own data source or state?</td><td>Separate view controller, with its own state object.</td></tr>
<tr><td>Could it appear in a different context — a different pane, a different window?</td><td>Separate view controller, so it can be reused.</td></tr>
<tr><td>Does it have its own lifecycle needs — appear/disappear timing, its own subscriptions?</td><td>Separate view controller.</td></tr>
<tr><td>Would embedding it make the parent's <code>loadView()</code> or tracked updater span two unrelated concerns?</td><td>Split it out.</td></tr>
</tbody>
</table>
</div>

Embedding is fine the other way — simple, tightly-coupled elements that serve the very same concern as their parent stay inline: a row of filter buttons inside a bottom bar, a label-plus-icon header, visibility that depends only on a mode the view itself already renders. None of those needs its own lifecycle, its own state, or a life outside the parent that hosts it.

The naming threshold makes the call concrete: if a view controller's purpose fits a single short phrase — "sidebar bottom bar," "sync status banner" — it's scoped right. The moment describing it needs an "and," it's covering two concerns and wants to split.

Take a notebook sidebar with a bottom bar of filter and settings buttons, and a separate area showing live sync activity. That's three sibling view controllers under the sidebar: a content controller for the notebook list itself, plus two accessory controllers — one for the bottom bar, one for the activity area — each independently shown or hidden, each with whatever state it actually needs. Folding the activity area into the bottom-bar controller would coordinate two things that have nothing to do with each other: a `loadView()` that assembles unrelated components, and a tracked updater that renders unrelated state, both because they happened to live in the same corner of the screen.

A well-scoped view controller shows up as a focused `loadView()` — one that reads clearly because it only ever had one concern to assemble. Child-view-controller nesting is how scoped controllers compose into a screen, the same containment idea <a href="/guide/08-1-views">Chapter 8.1</a> covers for view components one level down. And the same instinct that says "two pieces of UI needing different state belong in different view controllers" applies again inside a single controller, to its components: a component that needs its own state and its own lifecycle is a candidate to become its own view component controller, not a widening of the one it's currently attached to.

<div class="seealso">
<strong>Ahead in this guide</strong>
The activation lifecycle behind <code>observeState()</code> and <code>@Tracked</code>, worked through in full, is next: <a href="/guide/08-3-state-observing">Chapter 8.3, State Observing</a>.
</div>
