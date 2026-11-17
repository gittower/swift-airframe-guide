---
title: "View State"
description: "A screen has no single view state object. It has one object per writer: what the user edits, what a controller loads, how a running operation is going, what the view controller derives. This subchapter is the entry point for structuring a screen — which state objects it needs, what kind each one is, which controller writes it, how it reaches the view and what the view reports back — with the loaded-data pair, the most common shape, worked through in full."
order: 7
subOrder: 2
---

A screen has no single view state object. It has one object per writer: what the user edits, what a controller loads, how a running operation is going, what the view controller derives. This subchapter is the entry point for structuring a screen — which state objects it needs, what kind each one is, which controller writes it, how it reaches the view and what the view reports back — with the loaded-data pair, the most common shape, worked through in full. The other shapes are built end to end in <a href="/guide/07-7-screen-examples">Chapter 7.7</a>.

## What never changes

Every screen has the same three parts, whatever it does:

- <strong>The view controller coordinates.</strong> It owns the state and the controllers, decides when things load or run, receives what the user wants, and presents alerts and sheets. It is the only part that knows all the others.
- <strong>The view renders and reports.</strong> It receives state and closures, nothing else. It never calls a manager, builds an Action, or holds a controller.
- <strong>State sits between them.</strong> How many objects it is, and what they are called, depends on the screen.

Everything below is about the third part.

## One object per writer

Structuring a screen's state is seven decisions, in this order:

1. <strong>Does anything change after the view appears?</strong> If not, there is no state object. The view controller passes plain values to the view once.
2. <strong>List what the view needs, and for each piece name who writes it.</strong> The writer is the user (through the view), a controller that loads or runs something, or the view controller itself.
3. <strong>Give each writer its own object.</strong> Don't merge pieces with different writers into one object so the view gets a single parameter, and don't let one state object hold a reference to another. Pieces with the same writer that change together stay together.
4. <strong>Choose the kind of each piece</strong> from the first table below.
5. <strong>Choose the controller, if a piece needs one</strong>, from the second.
6. <strong>Decide what the view reports back:</strong> closures for what the user wants done, bindings for what the user edits.
7. <strong>Find the screen's shape</strong> in the table at the end of this subchapter and follow that example.

<div class="rule">
<span class="rule-label">The rule</span>

One object per writer. A state object never has two writers and never holds a reference to another state object; where two of them have to meet, the view controller routes between them.

</div>

## Kinds of state

<div class="table-wrap">
<table>
<thead><tr><th>Kind</th><th>Who writes it</th><th>What holds it</th><th>How it reaches the view</th></tr></thead>
<tbody>
<tr><td><strong>Fixed input</strong></td><td>Nobody, after creation</td><td>A plain <code>let</code> on the view controller or the view</td><td>Passed once.</td></tr>
<tr><td><strong>State the user edits</strong> — text, toggles, pickers, selection</td><td>The user, through the view</td><td>An <code>@Observable</code> class</td><td>By reference; <code>@Bindable</code> in SwiftUI.</td></tr>
<tr><td><strong>State the view only reads, small</strong> — an activity, a status, a few flags</td><td>One controller, or the view controller</td><td>A value type that carries its own rules, held by its writer as a <code>@Tracked private(set)</code> property</td><td>The view controller sets it on the view from a tracked updater.</td></tr>
<tr><td><strong>State the view only reads, large</strong> — collections, loaded documents, several pieces that change independently</td><td>One loader</td><td>An <code>@Observable</code> class with <code>fileprivate(set)</code> setters, in the loader's file</td><td>SwiftUI: by reference, read in <code>body</code>. AppKit: tracked updaters set view properties.</td></tr>
</tbody>
</table>
</div>

Two properties hold for every row:

- <strong>The view cannot change what it only reads.</strong> A value type set on the view is read-only by nature. An `@Observable` model protects itself with `fileprivate(set)`. A struct held as `private(set)` on its writer cannot be mutated by anyone else, because a mutating call needs the setter.
- <strong>State is creatable in any state without its writer.</strong> A preview or a test constructs it directly. If a preview needs a controller, the view is holding the wrong object.

State holds semantic values — enums, counts, model values — never display strings, images or colors. A sync status is `.syncing` or `.conflict(count: 3)`, never the string "3 conflicting notes" that a view renders from it. That boundary keeps state testable by asserting cases, not strings, and lets two views present the same state differently.

<strong>Small or large?</strong> Set values on the view by default. Pass an `@Observable` model by reference when the state is a collection the view lists, when it is large enough that comparing it on every change is wasteful, or when several pieces change independently and each should re-render only what reads it.

## Kinds of controllers

A controller exists when a piece of state needs work to produce it. It is the read path's coordination object from <a href="/guide/03-the-controller-layer">Chapter 3</a> — the view state controller — and it comes in two kinds. Neither is ever handed to the view.

<div class="table-wrap">
<table>
<thead><tr><th></th><th>Loader</th><th>Flow controller</th></tr></thead>
<tbody>
<tr><td><strong>Does</strong></td><td>Reads from the model layer and shapes the result for one presentation</td><td>Runs one user-started operation through its steps — network, an external tool, several awaits</td></tr>
<tr><td><strong>Triggered by</strong></td><td><code>reload()</code>, called by the view controller when an input or the model changed</td><td>One <code>async</code> method, called by the view controller when the user asks</td></tr>
<tr><td><strong>Overlapping calls</strong></td><td>A new reload replaces the running one</td><td>A second run is refused while one runs</td></tr>
<tr><td><strong>Owns the <code>Task</code></strong></td><td>Yes: <code>reload()</code> cancels the previous task and starts a new one</td><td>No: the method is plain <code>async</code>; the view controller owns the task and cancels it</td></tr>
<tr><td><strong>Its state</strong></td><td>An <code>@Observable</code> model, or a tracked value if small</td><td>A value type with the steps as mutating transitions</td></tr>
<tr><td><strong>Result</strong></td><td>Written into its state</td><td>What the view shows goes into its state; what the view controller must act on is the return value</td></tr>
<tr><td><strong>Tested</strong></td><td>Yes: set inputs, <code>await load()</code>, assert on the state</td><td>No. It only sequences. Every decision is a transition on its state or a function on a model type, and those are tested</td></tr>
<tr><td><strong>Foundation-only</strong></td><td>Yes</td><td>Yes</td></tr>
</tbody>
</table>
</div>

Neither kind subscribes to anything. The view controller observes every signal that makes the screen stale and calls the controller — <em>Who observes</em>, below.

A controller that is hard to test because it talks to a network or an external process must not contain decisions. Move each decision into the value it writes — is this a failure the user can answer? does this result belong to the expected account? — and let the controller only call them in order.

A flow controller is not a small Action. It fits an operation that belongs to one window: closing the window stops it, and no other part of the app shows it. The moment other surfaces must see or cancel the operation, or it must outlive the window, it is an Action from <a href="/guide/06-1-actions">Chapter 6.1</a>, observed through its activity — <a href="/guide/05-6-progress-and-activities">Chapter 5.6</a>.

## Loaded data: the pair in code

The common case is one loader, one model, one view, one view controller. The note detail screen shows the shape in full. Both halves share one file, named for the controller:

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

    func cancel() {
        loadTask?.cancel()
    }

    // One load. `reload()` runs it in a task; tests await it directly.
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
        detail.cancel()         // nobody is looking; a load in flight has no reader
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


The two consumption mechanisms in that example — `observations.track` to render, `observations.observe` to react — are <a href="/guide/07-4-state-observing">Chapter 7.4</a>. What the example settles is where they live: both of them on the view controller, none on the state controller.

### Why two objects

One object that both loads and gets rendered ends up in the view's hands, because it is the only `@Observable` thing around. Three things then go wrong:

- <strong>The view can reach past its contract.</strong> `reload()`, `cancel()`, a manager read through the controller — each one accidental call away, and the dumb-view rule becomes a convention instead of a type.
- <strong>Previews need a live controller</strong>, with live collaborators behind it. There is no dummy object.
- <strong>Mid-operation states become unreachable.</strong> `isLoading`, an operation in flight, a failure — none can be shown or tested without running the operation.

With the split, a preview or a test constructs the model directly in any state, and the controller is tested on the model it produces — <a href="/guide/09-6-testing-each-layer">Chapter 9.6</a>.

### One writer, any state

The split only pays off if the view genuinely cannot get at the controller, and if a preview or a test can build the model without one. Both follow from where the two types live. Put them in one file, give the model `fileprivate(set)` setters and a memberwise `init` with defaults. Only the controller — same file — can assign to it after construction; anything else that needs a `NoteDetailState` in a particular state constructs one:

```swift
#Preview("Loading") {
    NoteDetailView(state: NoteDetailState(isLoading: true), onSave: { })
}

#Preview("Loaded") {
    NoteDetailView(state: NoteDetailState(title: "Groceries", body: "Milk, eggs"), onSave: { })
}
```


Two previews, no controller, no manager, no running app. The same construction is how a test checks the view's rendering of a state the app only reaches mid-operation — a spinner, a failure banner — without running the operation.

## Who observes

A controller never subscribes and never observes — loader or flow controller alike. It has no `observeState()` and no activation lifecycle; a loader has `reload()`, a flow controller has its one `async` method, and its owner calls them. Every signal that makes the screen stale — the note changing in the model, the window becoming main — is declared in the view controller's `observeState()`, and the handler is one line that reloads the controller concerned.

The alternative is tempting, because a loader knows what it loaded and so seems the natural place to watch for it changing. It costs three things:

- <strong>Two inventories instead of one.</strong> A controller is Foundation-only, so it cannot see the window becoming main. The view controller has to observe that and call `reload()` regardless — and once it does, "what makes this screen reload?" is answered in two files if the controller subscribes as well.
- <strong>No one to route.</strong> A view controller with several controllers needs to say which signal reloads which of them. Controllers that subscribe for themselves each reload on their own, and the owner can neither group them nor leave one out.
- <strong>A lifecycle with nothing behind it.</strong> A controller that observes has to be activated, deactivated, and listed as its owner's child, for subscriptions that all end in `reload()`. One that doesn't is tested by setting its input, awaiting `load()`, and asserting on `state` — <a href="/guide/09-6-testing-each-layer">Chapter 9.6</a>.

What stays on the loader is everything that isn't observation: its inputs, whose `didSet` reloads because the owner assigned a property, and the task it loads in, which a newer `reload()` cancels — so two signals arriving together cost one load, not two.

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

A controller loads or sequences; it never observes. No `observeState()`, no `@StateObserving`, no subscription of any kind. The view controller owns every observation on the screen and calls the controller.

</div>

## How state reaches the view

Each kind of state has one way in, and a screen with several pieces uses several:

<div class="table-wrap">
<table>
<thead><tr><th>View and state</th><th>How</th></tr></thead>
<tbody>
<tr><td><strong>AppKit view</strong></td><td>The view exposes semantic properties; the view controller sets them from tracked updaters, as <code>updateFields()</code> does above.</td></tr>
<tr><td><strong>SwiftUI view, a small read-only value</strong></td><td>The view declares a plain <code>var</code>; the view controller assigns it in place on the hosted root view from a tracked updater.</td></tr>
<tr><td><strong>SwiftUI view, an observable model</strong></td><td>The view holds the model by reference (<code>let state</code>) and reads it inside <code>body</code>.</td></tr>
<tr><td><strong>SwiftUI view, state the user edits</strong></td><td><code>@Bindable var form</code>, with <code>$form.field</code> bindings.</td></tr>
</tbody>
</table>
</div>

Below the root view, subviews take plain values. Only the root needs the reference or the assigned property. The SwiftUI mechanics behind the middle two rows — why an in-place assignment keeps focus and field contents, and why reading a model outside `body` detaches it — are <a href="/guide/07-1-views">Chapter 7.1</a>.

## What the view reports back

- <strong>A closure is an intent</strong> — something the user wants done: `onSubmit`, `onCancel`, `onDelete`. The view controller decides what it means. One Cancel button is one `onCancel`; whether that stops running work or closes the window is decided by the view controller from state.
- <strong>An edit is not an intent.</strong> The user changing a field, a toggle or a selection is a write to the editable state object. The view has no `onSomethingChanged` closure and no `.onChange` that calls out.
- <strong>When the view controller must react to an edit</strong>, it observes the state it already holds and calls a method named for what should happen:

```swift
observations.observe({ [weak self] in self?.form.server }, perform: { [weak self] in
    self?.verificationController.reset()   // a failure shown for the old server no longer applies
})
```


<div class="rule">
<span class="rule-label">The rule</span>

A view takes exactly two things: state and closures for its intents. State is a model the view reads, a value the view controller sets on it, or an object the user edits through bindings. Never the controller that writes it, never a manager, never an Action. A view emits an intent and reacts to state — it does not handle the action itself; the view controller receives the intent and dispatches it. The only exceptions have no coordination in them at all: a static info sheet, or a `Toggle` bound straight to a flat settings object as `EditorSectionView` does in <a href="/guide/02-4-settings">Chapter 2.4</a>, where the settings object is its own manager and there is no controller to go around — and <a href="/guide/07-6-settings-window">Chapter 7.6</a> marks exactly where that exception ends. This is the single most important thing to check on any view: does it take anything other than state and closures?

</div>

## Rules that need two objects

One object per writer means some rules span two of them. Where such a rule lives depends on what it is for:

- <strong>For display</strong> — is the button enabled? — it is a private computed property on the view that reads both:

  ```swift
  private var canSubmit: Bool {
      form.isComplete && !verification.isRunning
  }
  ```

- <strong>With real logic worth testing</strong>, it is a function on one of the objects that takes the other's value as an argument.
- <strong>Moving values between objects</strong> is the view controller's job. It reads from one and passes the values as arguments to the other. A controller receives what it needs per call; it does not hold the form.
- <strong>Only the writer mutates.</strong> The view controller does not call transitions on a controller's state. It calls the controller — `cancel()`, `reset()` — and the names say what the view controller wants, not which transition that is.

## Naming, inputs, and where it lives

- <strong>Naming.</strong> Name each object for what it represents: `SyncAccountForm` for what the user fills in, `SyncAccountVerification` for how verifying is going, `NotebookExport` for how an export is going, a `*Loader` for a controller whose whole job is loading. `<Screen>StateController` writing `<Screen>State` — `NoteDetailStateController` and `NoteDetailState` — is the fallback when nothing more specific fits, not a required suffix.
- <strong>Inputs live on the controller.</strong> A selected note, a scoped identifier — the owner sets a plain property, and its `didSet` invalidates and reloads. The state never has inputs; it has results.
- <strong>One object per concern, one writer per object.</strong> A view controller may own several loaders and flow controllers for independent concerns, route its signals to them, and read all their state in its updaters. Concerns that cascade — one input invalidating another's data — belong in the same pair. Pieces with different writers never do.
- <strong>One file, next to the screen.</strong> `UI/Screens/NoteDetail/NoteDetailStateController.swift`, per <a href="/guide/01-1-project-layout">Chapter 1.1</a>. The controller is Foundation-only, so it stays testable without a window; it lives in the app target rather than a package because it belongs to exactly one screen.
- <strong>When there is no controller.</strong> State whose writer is the view controller itself is fine when nothing is loaded or run to fill it — a `@Tracked` value it derives from the model, or the navigation state in <a href="/guide/08-navigation">Chapter 8</a>. The moment loading or sequencing appears, the writer becomes a controller.

## What gets tests

- <strong>Yes:</strong> value types with rules and transitions; the editable state object's rules — is it complete, what does it produce; loaders.
- <strong>No:</strong> flow controllers, view controllers, views, and a one-line combination of two values in a view.

If something untested contains a decision, the design is wrong, not the test coverage: move the decision into a value. <a href="/guide/09-6-testing-each-layer">Chapter 9.6</a> shows both kinds of test.

## Which shape for which screen

<div class="table-wrap">
<table>
<thead><tr><th>The screen</th><th>Shape</th><th>Worked example</th></tr></thead>
<tbody>
<tr><td>Fixed inputs, nothing changes</td><td>No state object</td><td>—</td></tr>
<tr><td>Shows values derived from the model, recomputed on notifications, nothing async</td><td>A value with an <code>init</code> from the model, <code>@Tracked</code> on the view controller</td><td><a href="/guide/07-7-screen-examples">Chapter 7.7</a>, <em>Derived values</em></td></tr>
<tr><td>Shows loaded data, reloaded when inputs or the model change</td><td>Loader and its model</td><td>This subchapter, <em>Loaded data</em></td></tr>
<tr><td>The user fills in fields and submits; submitting is async and can fail</td><td>Editable form, flow controller, value for the activity</td><td><a href="/guide/07-7-screen-examples">Chapter 7.7</a>, <em>A form with an async submit</em></td></tr>
<tr><td>A long-running operation with progress and cancel, no fields</td><td>Flow controller and its value</td><td><a href="/guide/07-7-screen-examples">Chapter 7.7</a>, <em>A long-running operation</em></td></tr>
<tr><td>Several of the above on one screen</td><td>One object per writer; the view controller routes</td><td><a href="/guide/07-7-screen-examples">Chapter 7.7</a>, <em>Several concerns on one screen</em></td></tr>
<tr><td>A parent picks a child or passes a selection down</td><td>Plain inputs on the child view controller</td><td><a href="/guide/07-7-screen-examples">Chapter 7.7</a>, <em>Parent and child view controllers</em></td></tr>
</tbody>
</table>
</div>

## Check before you finish

- Does the view take anything other than state and closures?
- Does any state object hold a reference to another, or have two writers?
- Can every preview be written without a controller?
- Does the view have a closure that reports a change instead of an intent?
- Does the view controller read state after an `await` to learn how a flow ended, instead of using its return value?
- Does anything untested decide something?

<div class="seealso">
<strong>Ahead in this guide</strong>
The view controller that owns the state, assembles the components, and coordinates is next: <a href="/guide/07-3-view-controllers">Chapter 7.3</a>. The activation lifecycle behind the view controller's <code>observeState()</code> — and which of <code>@StateObserving</code>, <code>@Tracked</code> and <code>@Observable</code> goes on which type — is <a href="/guide/07-4-state-observing">Chapter 7.4</a>. The shapes other than loaded data, each built end to end, are <a href="/guide/07-7-screen-examples">Chapter 7.7</a>. Testing a loader on the model it writes, and a value on its transitions, is <a href="/guide/09-6-testing-each-layer">Chapter 9.6</a>.
</div>
