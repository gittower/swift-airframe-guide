---
title: "Views"
description: "SwiftUI renders. AppKit controls. This subchapter states that split precisely, covers what a view component's interface looks like and how components compose, and lands on the one rule that makes a SwiftUI view hosted inside AppKit stay reactive instead of silently going stale."
order: 8
subOrder: 1
---

SwiftUI renders. AppKit controls. This subchapter states that split precisely, covers what a view component's interface looks like and how components compose, and lands on the one rule that makes a SwiftUI view hosted inside AppKit stay reactive instead of silently going stale.

## The stance

A SwiftUI view in Airframe is deliberately dumb: given state, it draws it and emits intents through closures, and nothing else. Window and tab structure, the responder chain, drag and drop, toolbar items, notification subscriptions, and navigation all stay in an AppKit view controller. SwiftUI is hosted <em>inside</em> that controller as a rendering layer, not the other way around.

<div class="rule">
<span class="rule-label">The rule</span>

Use `NSHostingController` when a view controller's entire content is SwiftUI and needs no custom lifecycle logic — it's less code and just works. Use a plain `NSViewController` hosting an `NSHostingView` as a subview whenever AppKit and SwiftUI need to mix, or the controller has real lifecycle work to do: `NSHostingController` creates its view eagerly inside its own `loadView`, so `viewDidLoad` on a subclass can fire earlier than expected. Never rely on it for critical setup.

</div>

## Four objects, one of them the view

Each meaningful piece of UI is four objects. A <strong>view state controller</strong> subscribes, loads, and shapes model data, and writes it into a <strong>view state model</strong> — pure, semantic data. A <strong>view component</strong> renders that model. A <strong>view controller</strong> assembles the components, owns the state pair, and coordinates. The first two are <a href="/guide/08-2-view-state">Chapter 8.2</a>; the view controller is <a href="/guide/08-3-view-controllers">Chapter 8.3</a>. This subchapter is about the view.

A view's interface has two halves and a private middle: semantic data in, intents out, and the mapping from one to pixels kept inside. It knows nothing about where its data came from or what happens after an intent leaves.

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

## View component controllers

Sometimes the behavior around a <em>single</em> component outgrows the view controller hosting it: a popover button whose menu is generated from current state, a toolbar item whose badge tracks activity, a segmented control with non-trivial mode logic. The component itself must stay dumb — that's the three-layer split — but the coordination has to live somewhere, and folding it into the view controller is how a controller quietly picks up a second concern.

The extraction point is a <strong>view component controller</strong>: a plain `NSObject`, not an `NSViewController`, that owns one component and everything behavioral about it. It builds the component (or attaches to an existing one), acts as its target and delegate, holds whatever state the interaction needs, and reports outcomes to its owner through closures — or dispatches nil-targeted actions through the responder chain, picking up <a href="/guide/06-3-action-validation">Chapter 6.3</a>'s validation for free. The owning view controller just places the component in its layout, pushes inputs in, and reacts:

```swift
@StateObserving
final class TagFilterButtonController: NSObject, NSMenuDelegate {
    // The component — built and owned here, placed by the owner.
    let button = NSPopUpButton()

    // Outcomes — reported back.
    var onSelectTag: ((Tag?) -> Void)?

    override init() {
        super.init()
        button.menu = NSMenu()
        button.menu?.delegate = self
    }

    func observeState() {
        // e.g. keep the button's title showing the active filter
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let tags = NoteManager.shared.allTags
        menu.items = NSMenuItem.makeTagFilterItems(tags: tags) { [weak self] tag in
            self?.onSelectTag?(tag)
        }
    }
}
```

Note what's absent from the inputs: `NoteManager` itself. A shared instance is never threaded in as a property to push — that's the DI-container shape this app doesn't use, per <a href="/guide/02-5-object-wiring">Chapter 2.5</a>. The controller just reaches for `NoteManager.shared` wherever it needs it; only genuinely owner-specific context (a selected notebook, a scoped identifier) is a property to push in.

Exposing the component as a property is one of two integration modes: a `make…()` method or a `let` component covers the common case where the controller creates the control, and an `attach(to:)` method covers a control that already exists — a toolbar item the window hands over, say. Either way the owner decides <em>where</em> the component goes; the component controller decides everything about how it behaves.

Not being an `NSViewController` is the point, not a shortcut. There's no view hierarchy to own and no containment lifecycle to participate in, so an `NSViewController` would be ceremony around an object that is really just coordination. What a component controller <em>does</em> share with any other controller is observation: it conforms to `StateObserving` when it reacts to state, its owner activates it on the owner's own scope — or lists it in `childStateObservers` and lets a container do it — exactly as <a href="/guide/08-4-state-observing">Chapter 8.4</a> describes.

<div class="rule">
<span class="rule-label">The rule</span>

A view component controller owns exactly one component and the behavior around it. The moment it starts assembling several components into a layout, it's becoming a view controller; the moment other objects start reading state off it, that state wants to be a view state model with a controller writing it. Both are signs to promote, not to grow.

</div>

The most common specialization is the menu controller — a component controller whose component is a menu (or a button-plus-menu pair) — which gets its own treatment in <a href="/guide/08-5-menus">Chapter 8.5</a>.

## Hosting SwiftUI: read the model inside `body`

A SwiftUI view hosted inside an AppKit view controller follows the same contract as an `NSView` component — a view state model in, closures out — and gets its reactivity from the Observation framework: any `@Observable` property read inside `body` is tracked, so the view re-renders when exactly that state changes, and nothing has to tell it to.

<div class="rule">
<span class="rule-label">The rule</span>

Hand a SwiftUI view the `@Observable` <strong>view state model</strong> — never the controller that writes it, even though the controller is the object you already hold — <strong>by reference</strong>, and read its properties <strong>inside `body`</strong>. A snapshot — a plain value struct captured once at construction, even if it came off an observable object — is a detached copy. Mutating the source later does nothing to it. This is the single most common way a hosted SwiftUI view goes silently stale, and the tell is a controller doing `hostingView.rootView = NewView(value)` by hand on every change instead of just mutating the model and letting the view follow.

</div>

## Layout and styling as local concerns

Constraints are built where the view is built — a component's own `loadSubviews()`, a controller's own `loadView()` — never through a shared layout helper that hides what `NSLayoutConstraint` is actually doing. Colors, images, and fonts follow the same instinct: define them as close to their one usage as possible, using the platform's own type-safe asset accessors directly. Promote something to a shared extension only once a second, unrelated view genuinely needs the same value — a global styles singleton accumulates exactly the stale, nobody-owns-this cruft that scoping avoids.

## Naming and composition, briefly

A <strong>Screen</strong> (or the AppKit view controller playing that role) owns a view state controller, hands its model down, and wires up loading; a <strong>Page</strong> is one step within a Screen's multi-step flow; a <strong>View</strong> is pure rendering, previewable in every state because it depends on nothing but the state handed to it. In SwiftUI composition, reach for a <strong>ViewModifier</strong> to restyle an existing view, a <strong>ViewBuilder container</strong> for a reusable layout shape with swappable content, and a <strong>custom View struct</strong> for a complete, semantically named component — and avoid `@ViewBuilder` computed properties entirely; they recompute on every render, can't hold state, and are a strong signal the content wants to be its own View struct instead.

<div class="seealso">
<strong>Ahead in this guide</strong>
What a view is given — the view state controller and the model it writes — is next: <a href="/guide/08-2-view-state">Chapter 8.2</a>. The view controller that assembles views and owns that pair is <a href="/guide/08-3-view-controllers">Chapter 8.3</a>; the activation lifecycle behind `observeState()` and `@Tracked` is <a href="/guide/08-4-state-observing">Chapter 8.4</a>; menus — themselves just view components wired to Actions — are <a href="/guide/08-5-menus">Chapter 8.5</a>. Moving between screens without one view holding a reference to another is <a href="/guide/09-navigation">Chapter 9</a>.
</div>
