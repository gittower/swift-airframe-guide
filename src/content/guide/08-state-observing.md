---
title: "State Observing"
description: "Chapter 7 named `observeState()` and `activateObservation()` without explaining them. This chapter does: the activation lifecycle that drives StateObserving, worked through as a view controller, a self-rendering view, and a container that activates a whole subtree of subcontrollers at once — plus the edge cases that separate a correct `observeState()` from one that quietly goes stale."
order: 8
---

Chapter 7 named `observeState()` and `activateObservation()` without explaining them. This chapter does: the activation lifecycle that drives StateObserving, worked through as a view controller, a self-rendering view, and a container that activates a whole subtree of subcontrollers at once — plus the edge cases that separate a correct `observeState()` from one that quietly goes stale.

## Why this pattern exists

AppKit has no built-in answer to "keep this view a function of current state." What it offers instead is a pile of independent mechanisms — KVO, notifications, delegate callbacks — each installed in a different place and torn down (or forgotten) in another. The failure modes are familiar: subscriptions scattered across a class that no one can audit, a teardown path that misses one, a view showing stale content after time offscreen, a handler still bound to a source that was replaced. StateObserving turns each of those into a structural impossibility rather than a code-review catch: one method is the auditable inventory, re-armable activation re-subscribes and re-seeds from whatever is current, and explicit deactivation means a background window genuinely stops reacting.

### Compared to SwiftUI

SwiftUI views get all of this for free — which is exactly the standard this pattern holds AppKit code to. The observable object is identical in both worlds; only the consumption layer differs:

<div class="table-wrap">
<table>
<thead><tr><th>SwiftUI</th><th>StateObserving</th></tr></thead>
<tbody>
<tr><td><code>body</code></td><td><code>observations.track { render() }</code></td></tr>
<tr><td><code>.onChange(of:)</code></td><td><code>observations.observe({ read }, perform:)</code></td></tr>
<tr><td><code>.task(id:)</code></td><td><code>observations.observe({ input }) { loader.reload() }</code> — trigger half only</td></tr>
<tr><td><code>.task</code> (no id)</td><td><code>reload()</code> at the activation call site</td></tr>
<tr><td><code>.onReceive(publisher)</code></td><td><code>observations.observe(publisher) { … }</code></td></tr>
<tr><td><code>.onAppear</code> / <code>.onDisappear</code></td><td><code>activateObservation()</code> / <code>deactivateObservation()</code></td></tr>
</tbody>
</table>
</div>

These rows are analogies, not 1:1 equivalents. `.onChange(of:)` is the closest match — both watch a value and fire a closure on change only, which either updates state or performs a side effect. `.task(id:)` bundles the change trigger together with automatic task management (cancel the running task, start a fresh one); the observation replicates only the trigger half, and supersession of in-flight work is the loader's job — see <a href="/guide/06-concurrency">Chapter 6</a>. And where SwiftUI re-evaluates `body` and diffs a view tree, StateObserving re-runs small imperative updaters against long-lived views — which is why updaters must stay idempotent applications of current state.

## One method is the whole inventory

Any class — view controller, view, or plain object — can conform to `StateObserving` (from the local `StateObserving` package). The `@StateObserving` macro adds an `observations` property, a private `updateStateObservation()` reconciliation method, and the protocol conformance; the conformer writes exactly one method, `observeState()`, and that method is the complete list of everything the object reacts to.

```swift
@StateObserving
final class NoteListViewController: NSViewController {
    func observeState() {
        // the complete inventory of everything this object reacts to
    }
}
```

Nothing subscribes outside `observeState()`. A subscription installed anywhere else silently disappears the next time the object re-arms, because re-arming rebuilds only what's declared here — the rule the rest of this chapter leans on.

## The activation lifecycle

The protocol supplies four calls; conformers never override any of them:

<div class="table-wrap">
<table>
<thead><tr><th>Call</th><th>Effect</th></tr></thead>
<tbody>
<tr><td><code>activateObservation()</code></td><td>Runs <code>observeState()</code> — subscribes and seeds from the current state. A no-op when already active.</td></tr>
<tr><td><code>deactivateObservation()</code></td><td>Tears every subscription and tracked updater down. A no-op when already inactive.</td></tr>
<tr><td><code>isActive</code></td><td>Whether the object is currently observing.</td></tr>
<tr><td><code>updateStateObservation()</code></td><td>Macro-generated <strong>private</strong> member, not protocol API: reconciles the installed observations with the current state — cancels and re-runs <code>observeState()</code> while active, does nothing while inactive. Only the conformer itself can call it; the sanctioned call site is a source property's <code>didSet</code> (see the re-arm below).</td></tr>
</tbody>
</table>
</div>

Activation is <strong>re-armable</strong>: activating again after a deactivation behaves exactly like the first activation, because it re-subscribes and re-seeds from whatever is current. That rules out two bug classes by construction — a stale subscription to a source that's since been replaced, and stale content left on screen after a period of inactivity, since the next activation's seed reads the true current state.

Lifecycle calls are never hidden inside the macro — the owner always writes the activate/deactivate pair itself, mapped onto whatever scope the object actually lives on:

<div class="table-wrap">
<table>
<thead><tr><th>Scope</th><th>Activate</th><th>Deactivate</th></tr></thead>
<tbody>
<tr><td>Visible view controller</td><td><code>viewWillAppear</code></td><td><code>viewWillDisappear</code></td></tr>
<tr><td>View in a window</td><td><code>viewDidMoveToWindow</code>, window non-nil</td><td><code>viewDidMoveToWindow</code>, window nil</td></tr>
<tr><td>Object lifetime</td><td>once, in init or setup</td><td>never</td></tr>
</tbody>
</table>
</div>

Only `activateObservation()` can begin observation — the private reconciliation is a no-op before activation, so `isActive` stays truthful by construction.

## Subscribe, seed, track — in that order

`observeState()` reads in three blocks, always in this order:

```swift
func observeState() {
    // 1. SUBSCRIBE — install every bridge and reaction first
    observations.observe(NotificationCenter.default.publisher(for: .noteDidChange)) { [weak self] _ in
        self?.updateNoteState()
    }

    // 2. SEED — read the current state, through the same funnel the handler calls
    updateNoteState()

    // 3. TRACK — register updaters last; their immediate run renders the seeded state
    observations.track { [weak self] in self?.updateNote() }
}
```

Subscribing first matters because seeding isn't guaranteed to be a passive read — a getter that lazily loads or refreshes a cache can synchronously trigger the very change it's about to report. Seeding before tracking matters because `track` runs its updater immediately: seeded first, that first run renders the true current state in one pass; tracked first, it renders defaults and a second, coalesced pass follows a turn later.

Three kinds of statement can appear in `observeState()`:

<div class="table-wrap">
<table>
<thead><tr><th>Role</th><th>API</th><th>Purpose</th></tr></thead>
<tbody>
<tr><td>Bridge</td><td><code>observations.observe(publisher) { state = … }</code></td><td>Copy an external signal into tracked state.</td></tr>
<tr><td>React</td><td><code>observations.observe({ read }) { … }</code></td><td>Run a side effect — not a view change — when something changes.</td></tr>
<tr><td>Track</td><td><code>observations.track { render() }</code></td><td>Keep a render method applied to current state.</td></tr>
</tbody>
</table>
</div>

`observations.observe({ read }, perform:)` runs `read` immediately to register what to watch, then calls `perform` only on a later change — never on the first pass. `observations.track` runs its updater immediately and re-runs it whenever any observable property it read last time changes; multiple changes within one runloop turn coalesce into a single re-run, and delivery always lands one main-queue turn after the mutation that caused it.

## Under the hood

The tracking half rides on the Observation framework (macOS 14+) — the same machinery behind SwiftUI's `body`. When `observations.track` runs an updater, every `@Observable`/`@Tracked` property read during that run is registered as a dependency; mutating any of them schedules a re-run, and the read set is re-gathered on every pass, so conditional reads stay correct. Delivery is always asynchronous — one main-queue turn after the mutation, with all changes in a turn coalesced into a single pass. Never write code that needs a handler to run synchronously with the change; when a one-turn deferral is exactly what a re-entrancy-sensitive AppKit API needs, this is it, for free. External signals enter through Combine: `observations.observe(publisher)` subscribes with delivery hopped to the main queue, including any value the publisher replays on subscription.

### `@Tracked`

`@Tracked` makes a single property on an otherwise plain class participate in observation tracking, exactly as a property on an `@Observable` object would: reading it inside a `track` or `observe(read:perform:)` scope registers it, assigning it triggers the observers. It also de-dupes — the value must be `Equatable`, and the setter swallows an assignment of an equal value, so observers only ever fire for real changes and call sites need no `guard changed` of their own. It doesn't apply to `weak` properties or properties exposed to Objective-C.

`@Observable` classes get the same deduplication from the framework itself: the macro's generated setter routes through `shouldNotifyObservers()`, whose `Equatable` overload compares old and new value, so equal assignments of `Equatable` properties never notify — no extra guard is needed in a state object. The gate only exists where a comparison exists, though: non-`Equatable` value properties always notify, and reference-typed ones compare by identity — give hot properties an `Equatable` type if dedupe matters.

Use `@Tracked` for state a controller or view hosts and renders itself; state that is shared, loads asynchronously, or cascades belongs in a dedicated `@Observable` state object — see <a href="/guide/07-views">Chapter 7</a>.

## Example: a view controller

```swift
@StateObserving
final class NoteListViewController: NSViewController {
    let loader = NoteListLoader()      // @Observable state object

    override func viewWillAppear() {
        super.viewWillAppear()
        activateObservation()
        loader.reload()                // initial load, and catch-up after inactivity
    }

    override func viewWillDisappear() {
        super.viewWillDisappear()
        deactivateObservation()
    }

    func observeState() {
        // REACT — the list may have changed while another window was main.
        observations.observe(
            NotificationCenter.default.publisher(for: NSWindow.didBecomeMainNotification, object: view.window)
        ) { [weak self] _ in
            self?.loader.reload()
        }

        // TRACK — render the loader's state.
        observations.track { [weak self] in self?.updateSpinner() }
        observations.track { [weak self] in self?.updateTable() }
    }

    private func updateSpinner() { /* read loader.isLoading, show or hide */ }
    private func updateTable() { /* read loader.notes, apply a snapshot */ }
}
```

The async work lives on the loader, exactly as in <a href="/guide/07-views">Chapter 7</a>; the controller only decides <em>when</em> (activation, the notification) and <em>how it looks</em> (the two updaters). Registering one `observations.track` call per updater, rather than one giant updater, is deliberate — their read sets are allowed to overlap freely, and each stays a small, single-purpose render pass.

## Example: a self-rendering view

A view is typically its own state source: `@Tracked` properties form its data interface, the owner assigns them, and the view renders itself.

```swift
@StateObserving
final class UnsyncedBadgeView: NSView {
    // Data interface — set by the owner.
    @Tracked var count = 0
    @Tracked var isHighlighted = false

    private let countLabel = NSTextField(labelWithString: "")

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window != nil {
            activateObservation()
        } else {
            deactivateObservation()
        }
    }

    func observeState() {
        observations.track { [weak self] in self?.updateBadge() }
    }

    private func updateBadge() {
        countLabel.stringValue = String(count)
        alphaValue = isHighlighted ? 1.0 : 0.6
    }
}
```

The owner just assigns — `badge.count = notebook.unsyncedNoteCount` — and `@Tracked` does the rest: it dedupes equal assignments, so an assignment that doesn't actually change the value never triggers a render, and multiple assignments in one turn coalesce into one. This earns its keep once a view coalesces several signals or reads other observable objects; a view whose properties are set individually and that observes nothing else is just as correct with a plain `didSet { apply() }`, as `SyncStatusView` back in <a href="/guide/07-views">Chapter 7</a> already does.

## Example: a container with a subcontroller

A parent whose children live on <strong>exactly its own activation scope</strong> conforms to `StateObservingContainer` instead of hand-writing an activate/deactivate `forEach` for each child:

```swift
@StateObserving
final class NotebookSidebarController: NSObject, StateObservingContainer {
    private let notebooksSection = NotebooksSectionController()
    private let tagsSection = TagsSectionController()

    var childStateObservers: [any StateObserving] {
        [notebooksSection, tagsSection]
    }

    func observeState() {
        // the parent's own observations, if any
    }
}
```

One call — `sidebar.activateObservation()` — arms the whole subtree; deactivation walks the children first, then the parent. Without the container, every parent hand-writes that traversal, and sooner or later one path forgets a child — usually the deactivate path, which is how a background window keeps reacting to notifications nobody's looking at anymore.

<div class="rule">
<span class="rule-label">The rule</span>

A container lists only the children on its own scope. A child that lives on a different scope — a window-lifetime object hanging off a controller that's only active while key/main, say — is driven by its owner directly; a parent with mixed-scope children isn't a container.

</div>

## Edge cases

### Inputs set from outside: the `didSet` re-arm

Sometimes the observed <em>source itself</em> is a property that gets replaced from outside — and may be nil when the object first activates. Two small pieces cover every variant:

```swift
@StateObserving
final class NotebookDetailViewController: NSViewController {
    weak var notebook: Notebook? {
        // Rebinds the subscription to the new notebook and reflects it.
        // A no-op while inactive — activation will seed from the current
        // notebook.
        didSet { updateStateObservation() }
    }

    func observeState() {
        guard let notebook else { return }   // no source yet — observe nothing

        observations.observe(notebook.didChangePublisher) { [weak self] _ in self?.updateNoteState() }
        updateNoteState()
        observations.track { [weak self] in self?.updateFields() }
    }
}
```

- <strong>Set while inactive</strong> — the common startup order: the reconciliation is a no-op; the eventual `activateObservation()` subscribes to whatever notebook is current by then and seeds from it.
- <strong>Swapped while active</strong> — `updateStateObservation()` cancels everything, including the old notebook's subscription, then re-runs `observeState()` against the new one and re-seeds. Teardown and rebuild are the same code path as first activation.
- <strong>Set to nil while active</strong> — the same re-arm; the `guard let` installs nothing. If nil needs a rendered empty state, seed before the guard.

This `didSet` is the sanctioned call site for `updateStateObservation()` — and since the macro generates it as a private member, outside callers can't reach it at all. It's a different move from a parent just <em>forwarding</em> a new input to a child (`detail.notebookID = navigation.selectedNotebookID`, from <a href="/guide/10-navigation">Chapter 10</a>) — forwarding hands a plain value down and lets the child's own tracking pick it up; re-arming is specifically for when the property <em>is</em> the thing being observed.

### Seeding when nothing replays

Not every source hands back its current value on subscription, so the seed strategy has to match the source:

- A <strong>self-seeding source</strong> — a KVO publisher with `[.initial]`, a `CurrentValueSubject` — replays its current value the moment something subscribes, and that replay <em>is</em> the seed. No manual seed line is needed; a comment noting that the replay covers it helps whoever reads this next.
- A <strong>silent source</strong> — `NotificationCenter` posts replay nothing — needs an explicit seed after the subscribe, through the same funnel method the handler calls:

  ```swift
  func observeState() {
      observations.observe(NotificationCenter.default.publisher(for: .noteDidChange)) { [weak self] _ in
          self?.updateNoteState()
      }
      updateNoteState()   // no replay to lean on — seed explicitly
      observations.track { [weak self] in self?.updateNote() }
  }
  ```

- A replay is not a substitute for a render seed even when one exists: it also arrives a main-queue turn late, <em>after</em> `track`'s immediate run. It's a catch-up mechanism for "changed while deactivated," not the first render — if the very first render has to be correct, seed synchronously regardless, and `@Tracked`'s equality guard swallows the redundant replay for free.
- A value read <strong>before</strong> activation (a delegate asking for a title during setup, say) needs its own seed line in `init`, in addition to the full seed inside `observeState()` — activation has to stay self-sufficient for the re-arm case on its own.

`observations.observe({ read }, perform:)` never calls `perform` on its first pass — if a reaction has to run once for the initial state too, call its target method directly in the seed block, the same way `reload()` is called at the activation call site.

### A simple struct as the tracked state

When a controller or view renders several values that several noisy signals can touch, tracking each value one by one invites drift between which handler updates which field. Capture <em>everything the object renders</em> as one `Equatable` snapshot instead, and funnel every signal through one method that rebuilds it:

```swift
private struct NoteRowState: Equatable {
    let title: String
    let isPinned: Bool

    @MainActor
    init(note: Note?) {
        title = note?.title ?? ""
        isPinned = note?.isPinned ?? false
    }
}

@Tracked private var rowState = NoteRowState(note: nil)

private func updateRowState() {
    rowState = NoteRowState(note: note)   // every signal funnels here
}
```

Every subscription in `observeState()` calls `updateRowState()`, however often the underlying signals fire; `@Tracked`'s equality guard means the render updater re-runs only when the snapshot actually changed. Anything derived for display — a formatted date, a computed title — lives as a property on the snapshot itself, so the updater stays a dumb application of already-decided state. Keep supporting value types like the snapshot at file scope (`fileprivate`), above the class, so the class body leads with its actual state. Reach for this over a plain `@Observable` state object once the values are ones the object renders itself and nothing else needs to share or await; a state object earns its place instead once loading, cascading, or another consumer enters the picture — see <a href="/guide/07-views">Chapter 7</a>.

<div class="seealso">
<strong>Ahead in this guide</strong>
Menus — themselves just view components wired to Actions — are next: <a href="/guide/09-menus">Chapter 9</a>. Navigation state, which a parent pushes into its children as a plain input rather than something they observe directly, is <a href="/guide/10-navigation">Chapter 10</a>.
</div>
