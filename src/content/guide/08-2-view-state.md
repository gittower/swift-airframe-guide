---
title: "View State: Controller and Model"
description: "The read path of a screen is two objects, not one: a view state controller that loads and shapes, and the `@Observable` view state model it writes — which is all a view ever receives. This subchapter covers the pair: why it's two objects, why the view controller does all the observing, the single-writer mechanics that keep a view previewable in any state, and the rule that a view takes a model and closures and nothing else."
order: 8
subOrder: 2
---

The read path of a screen is two objects, not one: a view state controller that loads and shapes, and the `@Observable` view state model it writes — which is all a view ever receives. This subchapter covers the pair: why it's two objects, why the view controller does all the observing, the single-writer mechanics that keep a view previewable in any state, and the rule that a view takes a model and closures and nothing else.

## Four objects, two of them for state

Each meaningful piece of UI splits the same way: what's happening, how it looks, and when things happen. The first concern is two objects, not one — the controller that produces state and the model that holds it — and that split is what keeps a view previewable and testable in every state.

<div class="table-wrap">
<table>
<thead><tr><th>Layer</th><th>Concern</th><th>Knows about</th></tr></thead>
<tbody>
<tr><td><strong>View state controller</strong></td><td>Where state comes from — loads and shapes when asked to reload, writes the model</td><td>Managers and the model it writes.</td></tr>
<tr><td><strong>View state model</strong></td><td>What's happening — modes, loaded data, flags</td><td>Domain/model types only. Never a display string, image, or color. Never who fills it.</td></tr>
<tr><td><strong>View component</strong></td><td>How it looks — strings, images, layout, color</td><td>The view state model, closures for its intents, and AppKit or SwiftUI itself. Nothing else.</td></tr>
<tr><td><strong>View controller</strong></td><td>When things happen — lifecycle, observation, coordination, actions</td><td>Controller, model, and views. Wires them together; formats nothing.</td></tr>
</tbody>
</table>
</div>

A view state model exposes an enum like `.syncing` or `.conflict(count: 3)` — never the string "3 conflicting notes" that a view renders from it. That boundary is what keeps state testable by asserting cases, not strings, and lets two different views present the same state differently. The controller that writes the model is the read path's coordination object from <a href="/guide/03-the-controller-layer">Chapter 3</a>, Foundation-only and tested on the model it produces; the model is what the view gets, and all it gets.

## Why two objects

One object that both loads and gets rendered ends up in the view's hands, because it is the only `@Observable` thing around. Three things then go wrong:

- <strong>The view can reach past its contract.</strong> `reload()`, `cancel()`, a manager read through the controller — each one accidental call away, and the dumb-view rule becomes a convention instead of a type.
- <strong>Previews need a live controller</strong>, with live collaborators behind it. There is no dummy object.
- <strong>Mid-operation states become unreachable.</strong> `isLoading`, an operation in flight, a failure — none can be shown or tested without running the operation.

With the split, a preview or a test constructs the model directly in any state, and the controller is tested on the model it produces — <a href="/guide/10-6-testing-each-layer">Chapter 10.6</a>.

## The pair in code

The note detail screen shows the shape in full. Both halves share one file, named for the controller:

```swift
// NoteDetailStateController.swift

/// What the view renders. Pure data, constructable in any state.
/// fileprivate(set) makes the controller below its only writer.
@Observable @MainActor
final class NoteDetailState {
    fileprivate(set) var title: String
    fileprivate(set) var body: String
    fileprivate(set) var isLoading: Bool

    init(title: String = "", body: String = "", isLoading: Bool = false) {
        self.title = title
        self.body = body
        self.isLoading = isLoading
    }
}

/// Where the state comes from. Foundation-only, never handed to a view.
/// It observes nothing: its owner decides when to reload, this decides what loading means.
@MainActor
final class NoteDetailStateController {
    let state = NoteDetailState()
    var noteID: NoteID? { didSet { reload() } }   // input, set by the owner
    private var loadTask: Task<Void, Never>?

    func reload() {
        loadTask?.cancel()   // a newer reload supersedes the one in flight
        loadTask = Task { await load() }
    }

    func load() async {
        guard let noteID else { return }
        state.isLoading = true
        defer { state.isLoading = false }
        guard let note = Note.note(id: noteID), !Task.isCancelled else { return }
        state.title = note.title
        state.body = note.body
    }
}
```


The view controller owns the controller, observes on its behalf, and reads the model:

```swift
@StateObserving
final class NoteDetailViewController: NSViewController {
    let detail = NoteDetailStateController()

    override func viewWillAppear() {
        super.viewWillAppear()
        activateObservation()   // arms this controller — `detail` has nothing to arm
        detail.reload()         // initial load, and catch-up after inactivity
    }

    override func viewWillDisappear() {
        super.viewWillDisappear()
        deactivateObservation()
    }

    func observeState() {
        // REACT — every signal that makes the detail stale, model-layer and UI-level alike.
        observations.observe(NotificationCenter.default.publisher(for: .noteDidChange)) { [weak self] _ in
            self?.detail.reload()   // the note changed underneath us
        }
        observations.observe(
            NotificationCenter.default.publisher(for: NSWindow.didBecomeMainNotification, object: view.window)
        ) { [weak self] _ in
            self?.detail.reload()   // it may have changed while another window was main
        }
        // RENDER — a pure function of the model.
        observations.track { [weak self] in self?.updateFields() }
    }

    private func updateFields() {
        titleField.stringValue = detail.state.title
        bodyView.isHidden = detail.state.isLoading
    }
}
```


The two consumption mechanisms in that example — `observations.track` to render, `observations.observe` to react — are <a href="/guide/08-4-state-observing">Chapter 8.4</a>. What the example settles is where they live: both of them on the view controller, none on the state controller.

## Who observes

A view state controller never subscribes and never observes. It has no `observeState()` and no activation lifecycle; it has `reload()`, and its owner calls it. Every signal that makes the screen stale — the note changing in the model, the window becoming main — is declared in the view controller's `observeState()`, and the handler is one line that reloads the controller concerned.

The alternative is tempting, because the state controller knows what it loaded and so seems the natural place to watch for it changing. It costs three things:

- <strong>Two inventories instead of one.</strong> A state controller is Foundation-only, so it cannot see the window becoming main. The view controller has to observe that and call `reload()` regardless — and once it does, "what makes this screen reload?" is answered in two files if the state controller subscribes as well.
- <strong>No one to route.</strong> A view controller with several state controllers needs to say which signal reloads which of them. Controllers that subscribe for themselves each reload on their own, and the owner can neither group them nor leave one out.
- <strong>A lifecycle with nothing behind it.</strong> A state controller that observes has to be activated, deactivated, and listed as its owner's child, for subscriptions that all end in `reload()`. One that doesn't is tested by setting its input, awaiting `load()`, and asserting on `state` — <a href="/guide/10-6-testing-each-layer">Chapter 10.6</a>.

What stays on the state controller is everything that isn't observation: its inputs, whose `didSet` reloads because the owner assigned a property, and the task it loads in, which a newer `reload()` cancels — so two signals arriving together cost one load, not two.

With more than one pair, the view controller's `observeState()` reads as the routing table for the screen. The note list shows its notes and the progress of a sync; each has its own pair, and each signal reloads only what it stales:

```swift
@StateObserving
final class NoteListViewController: NSViewController {
    let list = NoteListStateController()               // writes NoteListState
    let syncProgress = SyncProgressStateController()   // writes SyncProgressState

    func observeState() {
        let center = NotificationCenter.default

        // REACT — each signal reloads the controllers it stales, and only those.
        observations.observe(center.publisher(for: .noteDidChange)) { [weak self] _ in
            self?.list.reload()
        }
        observations.observe(center.publisher(for: .syncStatusDidChange)) { [weak self] _ in
            self?.syncProgress.reload()
        }
        observations.observe(
            center.publisher(for: NSWindow.didBecomeMainNotification, object: view.window)
        ) { [weak self] _ in
            self?.reloadAll()
        }

        // RENDER — one updater per model.
        observations.track { [weak self] in self?.updateTable() }
        observations.track { [weak self] in self?.updateSyncBadge() }
    }

    private func reloadAll() {
        list.reload()
        syncProgress.reload()
    }
}
```


<div class="rule">
<span class="rule-label">The rule</span>

A state controller reloads and shapes; it never observes. No `observeState()`, no `@StateObserving`, no subscription of any kind. The view controller owns every observation on the screen and calls `reload()`.

</div>

## One writer, any state

The split only pays off if the view genuinely cannot get at the controller, and if a preview or a test can build the model without one. Both follow from where the two types live. Put them in one file, give the model `fileprivate(set)` setters and a memberwise `init` with defaults. Only the controller — same file — can assign to it after construction; anything else that needs a `NoteDetailState` in a particular state constructs one:

```swift
#Preview("Loading") {
    NoteDetailView(state: NoteDetailState(isLoading: true), onSave: { })
}

#Preview("Loaded") {
    NoteDetailView(state: NoteDetailState(title: "Groceries", body: "Milk, eggs"), onSave: { })
}
```


Two previews, no controller, no manager, no running app. The same construction is how a test checks the view's rendering of a state the app only reaches mid-operation — a spinner, a failure banner — without running the operation. If a preview needs a controller to exist, the view is holding the wrong object.

<div class="rule">
<span class="rule-label">The rule</span>

A view takes exactly two things: a view state model, by reference, and closures for its intents. Never the controller that writes the model, never a manager, never an Action. A view emits an intent and reacts to state — it does not handle the action itself; the view controller receives the intent and dispatches it. The only exceptions have no coordination in them at all: a static info sheet, or a `Toggle` bound straight to a flat settings object as `EditorSectionView` does in <a href="/guide/02-4-settings">Chapter 2.4</a>, where the settings object is its own manager and there is no controller to go around — and <a href="/guide/08-6-settings-window">Chapter 8.6</a> marks exactly where that exception ends. This is the single most important thing to check on any view: does it take anything other than a model and closures?

</div>

## Naming, inputs, and where it lives

- <strong>Naming.</strong> `<Screen>StateController` writes `<Screen>State` — `NoteDetailStateController` and `NoteDetailState`, `NoteListStateController` and `NoteListState`. A controller whose whole job is loading one list may be called a `*Loader`; it still writes a separate model.
- <strong>Inputs live on the controller.</strong> A selected note, a scoped identifier — the owner sets a plain property, and its `didSet` invalidates and reloads. The model never has inputs; it has results.
- <strong>One pair per concern.</strong> A view controller may own several pairs for independent concerns, route its signals to their `reload()`s, and read all their models in its updaters. Concerns that cascade — one input invalidating another's data — belong in the same pair.
- <strong>One file, next to the screen.</strong> `UI/Screens/NoteDetail/NoteDetailStateController.swift`, per <a href="/guide/01-1-project-layout">Chapter 1.1</a>. The controller is Foundation-only, so it stays testable without a window; it lives in the app target rather than a package because it belongs to exactly one screen.
- <strong>When there is no controller.</strong> A model whose writer is the view controller itself is fine when nothing is loaded to fill it — navigation state in <a href="/guide/09-navigation">Chapter 9</a> is the standing example. The moment loading or shaping appears, the writer becomes a state controller.

<div class="seealso">
<strong>Ahead in this guide</strong>
The view controller that owns the pair, assembles the components, and coordinates is next: <a href="/guide/08-3-view-controllers">Chapter 8.3</a>. The activation lifecycle behind the view controller's `observeState()` — and `@Tracked`, for the values a controller renders itself without a pair — is <a href="/guide/08-4-state-observing">Chapter 8.4</a>. Testing a state controller on the model it writes is <a href="/guide/10-6-testing-each-layer">Chapter 10.6</a>.
</div>
