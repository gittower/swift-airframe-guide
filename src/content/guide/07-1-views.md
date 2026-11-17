---
title: "Views"
description: "SwiftUI renders. AppKit controls. This subchapter states that split precisely, covers what a view component's interface looks like and how components compose, and lands on the three ways state reaches a SwiftUI view hosted inside AppKit — and the one way it silently goes stale."
order: 7
subOrder: 1
---

SwiftUI renders. AppKit controls. This subchapter states that split precisely, covers what a view component's interface looks like and how components compose, and lands on the three ways state reaches a SwiftUI view hosted inside AppKit — and the one way it silently goes stale.

## The stance

A SwiftUI view in Airframe is deliberately dumb: given state, it draws it and emits intents through closures, and nothing else. Window and tab structure, the responder chain, drag and drop, toolbar items, notification subscriptions, and navigation all stay in an AppKit view controller. SwiftUI is hosted <em>inside</em> that controller as a rendering layer, not the other way around.

<div class="rule">
<span class="rule-label">The rule</span>

Use `NSHostingController` when a view controller's entire content is SwiftUI and needs no custom lifecycle logic — it's less code and just works. Use a plain `NSViewController` hosting an `NSHostingView` as a subview whenever AppKit and SwiftUI need to mix, or the controller has real lifecycle work to do: `NSHostingController` creates its view eagerly inside its own `loadView`, so `viewDidLoad` on a subclass can fire earlier than expected. Never rely on it for critical setup.

</div>

## Four objects, one of them the view

Each meaningful piece of UI that loads its data is four objects. A <strong>view state controller</strong> loads and shapes model data, and writes it into a <strong>view state model</strong> — pure, semantic data. A <strong>view component</strong> renders that model. A <strong>view controller</strong> assembles the components, owns the state pair, observes, and coordinates. The first two are <a href="/guide/07-2-view-state">Chapter 7.2</a>, which also covers the screens where state takes another form — a form the user edits, a small value describing a running operation; the view controller is <a href="/guide/07-3-view-controllers">Chapter 7.3</a>. This subchapter is about the view.

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

    // Input — pushed in by the owner.
    var notebook: Notebook?

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
        let tags = notebook.map { Tag.all(in: $0) } ?? []
        menu.items = NSMenuItem.makeTagFilterItems(tags: tags) { [weak self] tag in
            self?.onSelectTag?(tag)
        }
    }
}
```

Note what's absent from the inputs: a manager. A shared instance is never threaded in as a property to push — that's the DI-container shape this app doesn't use, per <a href="/guide/02-5-object-wiring">Chapter 2.5</a>. The controller reads the model's queries directly and would reach for `NoteManager.shared(for: notebook)` wherever it needed a write; only genuinely owner-specific context — here the notebook, or a scoped identifier — is a property to push in.

Exposing the component as a property is one of two integration modes: a `make…()` method or a `let` component covers the common case where the controller creates the control, and an `attach(to:)` method covers a control that already exists — a toolbar item the window hands over, say. Either way the owner decides <em>where</em> the component goes; the component controller decides everything about how it behaves.

Not being an `NSViewController` is the point, not a shortcut. There's no view hierarchy to own and no containment lifecycle to participate in, so an `NSViewController` would be ceremony around an object that is really just coordination. What a component controller <em>does</em> share with any other controller is observation: it conforms to `StateObserving` when it reacts to state, its owner activates it on the owner's own scope — or lists it in `childStateObservers` and lets a container do it — exactly as <a href="/guide/07-4-state-observing">Chapter 7.4</a> describes.

<div class="rule">
<span class="rule-label">The rule</span>

A view component controller owns exactly one component and the behavior around it. The moment it starts assembling several components into a layout, it's becoming a view controller; the moment other objects start reading state off it, that state wants to be a view state model with a controller writing it. Both are signs to promote, not to grow.

</div>

The most common specialization is the menu controller — a component controller whose component is a menu (or a button-plus-menu pair) — which gets its own treatment in <a href="/guide/07-5-menus">Chapter 7.5</a>.

## Hosting SwiftUI: three ways in

A SwiftUI view hosted inside an AppKit view controller follows the same contract as an `NSView` component — state in, closures out. A dumb view can still react to live changes, and there are three supported ways for state to reach it. A screen may use more than one: one per piece of state, chosen by who writes it and how large it is — the table in <a href="/guide/07-2-view-state">Chapter 7.2</a>.

### An `@Observable` model by reference — collections and large state

The Observation framework does the work: any `@Observable` property read inside `body` is tracked, so the view re-renders when exactly that state changes, and nothing has to tell it to. `NSHostingView` and `NSHostingController` take part in that tracking, so it holds inside an AppKit view controller.

```swift
struct NoteListView: View {
    let list: NoteListState                  // by reference
    var onDelete: (NoteID) -> Void

    var body: some View {
        List(list.notes) { note in           // read inside body — tracked
            NoteRow(note: note)
        }
    }
}
```

<div class="rule">
<span class="rule-label">The rule</span>

Hand a SwiftUI view the `@Observable` <strong>view state model</strong> — never the controller that writes it, even though the controller is the object you already hold — <strong>by reference</strong>, and read its properties <strong>inside `body`</strong>. Reading it outside `body` and passing the result down detaches it.

</div>

### A value the view controller assigns — small read-only state

For a small `Equatable` value — an activity, a status, a few flags — the view declares a plain `var`, and the view controller assigns it in place on the hosted root view, from a tracked updater:

```swift
struct SyncAccountFormView: View {
    @Bindable var form: SyncAccountForm
    var verification: SyncAccountVerification   // a plain value
    // …
}

// In the view controller's observeState()
observations.track { [weak self] in self?.updateVerification() }

private func updateVerification() {
    hostingView.rootView.verification = verificationController.verification
}
```

SwiftUI treats the assignment as an update of the same view, so focus and field contents survive. The view cannot mutate the value, and a preview passes it directly. This is the same pattern as an AppKit view whose properties the view controller sets, and it is the default for small state; use an `@Observable` model when the state is a collection, is expensive to compare, or has several pieces that change independently.

### An `@Observable` object the user edits — two-way state

Text fields, toggles, pickers and selection bind to an `@Observable` object: `@Bindable var form` and `$form.server`. The user is its writer. When the view controller must react to an edit, it observes the object — `observations.observe({ read }, perform:)` from <a href="/guide/07-4-state-observing">Chapter 7.4</a>; the view does not report edits through closures. The one binding that bypasses a screen-owned object is a `Toggle` on a flat settings object, which is its own manager — <a href="/guide/02-4-settings">Chapter 2.4</a>.

### The failure mode, and the anti-pattern that hides it

A `let content: SomeStruct` snapshot passed at construction and never assigned again is a detached copy — even if it came off an observable object. Mutating the source later does nothing to it. This is the single most common way a hosted SwiftUI view goes silently stale.

The usual patch is worse than the problem: the view controller rebuilds the whole root view on every change — `hostingView.rootView = NoteDetailView(newValue)` — and keeps a `lastValue` guard to avoid redundant rebuilds. That is change detection written by hand, and a view rebuilt instead of updated. Moving the input to an `@Observable` model, or to a value assigned from a tracked updater, deletes all of it.

Assigning one property in place from a tracked updater is <em>not</em> that anti-pattern. Nothing is compared by hand — the updater runs because tracked state changed — and the view is updated, not rebuilt.

## Layout and styling as local concerns

Constraints are built where the view is built — a component's own `loadSubviews()`, a controller's own `loadView()` — never through a shared layout helper that hides what `NSLayoutConstraint` is actually doing. Colors, images, and fonts follow the same instinct: define them as close to their one usage as possible, using the platform's own type-safe asset accessors directly. Promote something to a shared extension only once a second, unrelated view genuinely needs the same value — a global styles singleton accumulates exactly the stale, nobody-owns-this cruft that scoping avoids.

## Naming and composition, briefly

A <strong>Screen</strong> (or the AppKit view controller playing that role) owns the screen's state and whatever controllers write it, hands the state down, and wires up loading; a <strong>Page</strong> is one step within a Screen's multi-step flow; a <strong>View</strong> is pure rendering, previewable in every state because it depends on nothing but the state handed to it. In SwiftUI composition, reach for a <strong>ViewModifier</strong> to restyle an existing view, a <strong>ViewBuilder container</strong> for a reusable layout shape with swappable content, and a <strong>custom View struct</strong> for a complete, semantically named component — and avoid `@ViewBuilder` computed properties entirely; they recompute on every render, can't hold state, and are a strong signal the content wants to be its own View struct instead.

<div class="seealso">
<strong>Ahead in this guide</strong>
What a view is given — the state objects a screen needs, and the controllers that write them — is next: <a href="/guide/07-2-view-state">Chapter 7.2</a>. The view controller that assembles views and owns that pair is <a href="/guide/07-3-view-controllers">Chapter 7.3</a>; the activation lifecycle behind <code>observeState()</code> and <code>@Tracked</code> is <a href="/guide/07-4-state-observing">Chapter 7.4</a>; menus — themselves just view components wired to Actions — are <a href="/guide/07-5-menus">Chapter 7.5</a>; the settings window, where all of it comes together in one place, is <a href="/guide/07-6-settings-window">Chapter 7.6</a>; the recurring shapes of a screen, each built end to end, are <a href="/guide/07-7-screen-examples">Chapter 7.7</a>. Moving between screens without one view holding a reference to another is <a href="/guide/08-navigation">Chapter 8</a>.
</div>
