---
title: "Views"
description: "SwiftUI renders. AppKit controls. This chapter states that split precisely, covers the three-layer shape every piece of UI follows, and lands on the one rule that makes a SwiftUI view hosted inside AppKit stay reactive instead of silently going stale."
order: 7
---

SwiftUI renders. AppKit controls. This chapter states that split precisely, covers the three-layer shape every piece of UI follows, and lands on the one rule that makes a SwiftUI view hosted inside AppKit stay reactive instead of silently going stale.

## The stance

A SwiftUI view in Airframe is deliberately dumb: given state, it draws it and emits intents through closures, and nothing else. Window and tab structure, the responder chain, drag and drop, toolbar items, notification subscriptions, and navigation all stay in an AppKit view controller. SwiftUI is hosted <em>inside</em> that controller as a rendering layer, not the other way around.

<div class="rule">
<span class="rule-label">The rule</span>

Use `NSHostingController` when a view controller's entire content is SwiftUI and needs no custom lifecycle logic — it's less code and just works. Use a plain `NSViewController` hosting an `NSHostingView` as a subview whenever AppKit and SwiftUI need to mix, or the controller has real lifecycle work to do: `NSHostingController` creates its view eagerly inside its own `loadView`, so `viewDidLoad` on a subclass can fire earlier than expected. Never rely on it for critical setup.

</div>

## Three layers, every time

Each meaningful piece of UI splits the same way: what's happening, how it looks, and when things happen.

<div class="table-wrap">
<table>
<thead><tr><th>Layer</th><th>Concern</th><th>Knows about</th></tr></thead>
<tbody>
<tr><td><strong>State object</strong></td><td>What's happening — modes, loaded data, flags</td><td>Domain/model types only. Never a display string, image, or color.</td></tr>
<tr><td><strong>View component</strong></td><td>How it looks — strings, images, layout, color</td><td>Semantic data from state, plus AppKit or SwiftUI itself.</td></tr>
<tr><td><strong>View controller</strong></td><td>When things happen — lifecycle, coordination, actions</td><td>State and views. Wires them together; formats nothing.</td></tr>
</tbody>
</table>
</div>

A state object exposes an enum like `.syncing` or `.conflict(count: 3)` — never the string "3 conflicting notes" that a view renders from it. That boundary is what keeps state testable by asserting cases, not strings, and lets two different views present the same state differently.

```swift
final class SyncStatusView: NSView {
    // Data interface — public, semantic
    var status: SyncState.Status = .idle {
        didSet { guard status != oldValue else { return }; apply() }
    }

    // Action interface — public
    var onRetry: (() -> Void)?

    // Presentation mapping — private
    private func apply() {
        label.stringValue = title(for: status)   // status → string happens here, nowhere else
        spinner.isHidden = status != .syncing
    }
}
```

## Composing and swapping without the parent knowing internals

Both a view and its owning controller swap subviews, but for different reasons, and mixing them up is the most common way this pattern erodes.

<div class="table-wrap">
<table>
<thead><tr><th>Question</th><th>Who swaps</th></tr></thead>
<tbody>
<tr><td>Same data interface, different visual state (loading vs. loaded)?</td><td>The view — toggle internally, the parent's contract never changes.</td></tr>
<tr><td>Different data, different interactions, a different component entirely?</td><td>The controller — this is a coordination decision, not a presentation one.</td></tr>
</tbody>
</table>
</div>

Rule of thumb: if the controller would have to change what properties it sets or what closures it wires, it's a controller-level swap. If the public interface stays identical, the view handles it alone.

## Observable state objects: the seam between model and a dumb view

A controller has exactly two mechanisms for responding to state, and conflating them is the second most common way this pattern erodes.

<div class="table-wrap">
<table>
<thead><tr><th>Mechanism</th><th>Purpose</th></tr></thead>
<tbody>
<tr><td>`observations.track { }`</td><td><strong>Render.</strong> Every view change — labels, visibility, swapped content, layout — belongs in a tracked updater and nowhere else. Runs automatically whenever an `@Observable` (or `@Tracked`) property read inside it changes.</td></tr>
<tr><td>`observations.observe { }`</td><td><strong>React.</strong> Side effects that are <em>not</em> a view change — triggering a reload when an input changes, responding to a notification. Never touches a view directly.</td></tr>
</tbody>
</table>
</div>

```swift
@StateObserving
final class NoteDetailViewController: NSViewController {
    let state = NoteDetailState()

    override func viewWillAppear() {
        super.viewWillAppear()
        activateObservation()
        state.reload()      // initial load, and catch-up after inactivity
    }

    override func viewWillDisappear() {
        super.viewWillDisappear()
        deactivateObservation()
    }

    func observeState() {
        observations.observe({ self.state.noteID }) { [weak self] in self?.state.reload() }
        observations.track { [weak self] in self?.updateFields() }
    }

    private func updateFields() {
        titleField.stringValue = state.title
        bodyView.isHidden = state.isLoading
    }
}
```

Both mechanisms are declared in one place — `observeState()`, the complete inventory of everything the controller reacts to — and wired up by an activation lifecycle (`activateObservation()` / `deactivateObservation()`) rather than by hand. That lifecycle, plus a parent controller that activates a whole tree of children at once, gets its own chapter next: <a href="/guide/08-state-observing">Chapter 8</a>.

Hosting a SwiftUI view inside that same controller works the same way — the Observation framework tracks any `@Observable` property read inside a view's `body`, so a hosted SwiftUI view stays reactive to exactly the state it reads.

<div class="rule">
<span class="rule-label">The rule</span>

Hand a SwiftUI view the `@Observable` object <strong>by reference</strong>, and read its properties <strong>inside `body`</strong>. A snapshot — a plain value struct captured once at construction, even if it came off an observable object — is a detached copy. Mutating the source later does nothing to it. This is the single most common way a hosted SwiftUI view goes silently stale, and the tell is a controller doing `hostingView.rootView = NewView(value)` by hand on every change instead of just mutating the model and letting the view follow.

</div>

## Layout and styling as local concerns

Constraints are built where the view is built — a component's own `loadSubviews()`, a controller's own `loadView()` — never through a shared layout helper that hides what `NSLayoutConstraint` is actually doing. Colors, images, and fonts follow the same instinct: define them as close to their one usage as possible, using the platform's own type-safe asset accessors directly. Promote something to a shared extension only once a second, unrelated view genuinely needs the same value — a global styles singleton accumulates exactly the stale, nobody-owns-this cruft that scoping avoids.

## Naming and composition, briefly

A <strong>Screen</strong> (or the AppKit view controller playing that role) owns a view model and wires up loading; a <strong>Page</strong> is one step within a Screen's multi-step flow; a <strong>View</strong> is pure rendering, previewable in every state because it depends on nothing but the state handed to it. In SwiftUI composition, reach for a <strong>ViewModifier</strong> to restyle an existing view, a <strong>ViewBuilder container</strong> for a reusable layout shape with swappable content, and a <strong>custom View struct</strong> for a complete, semantically named component — and avoid `@ViewBuilder` computed properties entirely; they recompute on every render, can't hold state, and are a strong signal the content wants to be its own View struct instead.

<div class="seealso">
<strong>Ahead in this guide</strong>
The activation lifecycle behind `observeState()`, `@Tracked`, and `StateObservingContainer` for a parent with subcontrollers get their own chapter next: <a href="/guide/08-state-observing">Chapter 8</a>. Menus — which are themselves just view components wired to Actions — follow after that: <a href="/guide/09-menus">Chapter 9</a>. Moving between screens without one view holding a reference to another is <a href="/guide/10-navigation">Chapter 10</a>.
</div>
