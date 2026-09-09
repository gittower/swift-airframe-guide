---
title: "Actions and Controllers"
description: "Not every write deserves ceremony. This chapter covers the Action as the unit of user intent, when a gesture earns one, the line between an Action and a plain manager call, and the background controllers that keep the app current without any user gesture at all."
order: 4
---

Not every write deserves ceremony. This chapter covers the Action as the unit of user intent, when a gesture earns one, the line between an Action and a plain manager call, and the background controllers that keep the app current without any user gesture at all.

## An Action is the thing in flight

An Action is `@Observable` and `@MainActor`, and it carries its own lifecycle — `title`, `status`, progress, and a `cancel()` that means it. There's no separate "activity" type representing the live operation, because the Action <em>is</em> the live operation: it spawns its own task in `main()` and stays alive until that task finishes.

```swift
@Observable @MainActor
class Action: Identifiable {
    let id: ActionID
    let title: String
    let scope: ActionScope

    private(set) var status: ActionStatus = .queued
    private var task: Task<Void, Never>?

    /// Subclasses override. Call `Task.checkCancellation()` at
    /// checkpoints and report progress via `updateProgress(_:)`.
    func main() async throws { fatalError("Subclasses must override main()") }

    func cancel() { task?.cancel() }
}

enum ActionStatus {
    case queued
    case running(progress: Double)   // .nan = indeterminate
    case completed
    case failed(any Error)
    case cancelled
}
```

Because state and only state needs to be reactive — not the imperative `cancel()` or `main()` calls themselves — `@Observable` is the cheapest way to let several independent UI surfaces (a progress window, an activity list, a status badge) bind to the same live value without any subscription ceremony.

### Conflicts are declared, not checked ad hoc

Each Action declares a `scope`, and a central manager enforces conflicts from it — a scope tied to one document blocks another Action with the same scope; scopes tied to different documents never block each other; some scopes never block anything. That single declaration replaces scattered "is something already running?" checks sprinkled through validators and controllers.

## Does this gesture need an Action?

The Action layer has real overhead — registration, conflict checks, a place to render progress. That cost is worth paying for something the user perceives as <em>an operation</em>; it's friction for an instant, local edit. The deciding question isn't "does this write persistent state?" — it's whether the user experiences it as something they're waiting for, tracking, or might want to undo.

<div class="table-wrap">
<table>
<thead><tr><th>Gesture</th><th>Direct call or Action?</th><th>Why</th></tr></thead>
<tbody>
<tr><td>Toggle a note's pinned flag</td><td><span class="pill">Direct call</span></td><td>Instant, local, no failure mode the user needs to see or act on.</td></tr>
<tr><td>Reorder notebooks in the sidebar</td><td><span class="pill">Direct call</span></td><td>Sub-100ms, no cross-flow coordination, nothing worth showing in an activity list.</td></tr>
<tr><td>Sync a notebook</td><td><span class="pill">Action</span></td><td>Runs over the network, can fail in ways the user must see, has identity — the user thinks "I synced this."</td></tr>
<tr><td>Delete a notebook</td><td><span class="pill">Action</span></td><td>Can cascade (unsynced notes, shared collaborators), benefits from undo, worth tracking if slow.</td></tr>
</tbody>
</table>
</div>

One grey zone is worth naming: a gesture that's a trivial local edit today can pick up a networked failure surface later — a note edit that starts syncing to a shared notebook, say. Promote it to an Action when the <em>durability of its failure modes</em> changes, whether or not its perceived latency does. Duration alone doesn't move the needle; what can now go wrong does.

## Manager function or Action?

A second, related line runs between the Model layer's manager functions and the Action layer sitting above them. The test is one question:

<div class="rule">
<span class="rule-label">The test</span>

<strong>Would two different Actions reasonably call this from inside their own `main()`?</strong> If yes, it's a manager function — an atomic, reusable domain operation, even if it makes several calls under the hood. If no — if this is specifically the choreography of one particular user intent — it's an Action.

</div>

"Atomic" here is about conceptual unity, not call count. Syncing a notebook makes several network calls but is one cohesive operation — a manager function. Moving a note between notebooks also makes several calls, but it's specifically the sequence of unlinking, relinking, and re-indexing that one gesture needs — an Action.

```swift
final class MoveNoteAction: Action {
    let noteID: NoteID
    let destination: NotebookID

    override func main() async throws {
        updateProgress(0.2)
        try await NoteManager.shared.unlink(noteID, from: sourceNotebookID)
        updateProgress(0.6)
        try await NoteManager.shared.link(noteID, to: destination)
        updateProgress(1.0)
    }
}
```

No composite "activity" type wraps the two manager calls. Cancelling the outer task cascades into whichever `await` is currently in flight, and progress reports through the same `status` every other Action uses.

### Smell checks

- A manager function that posts a user-visible notification or registers undo has drifted into Action territory — post the notification and register undo in the Action, after the manager call returns.
- An Action that issues raw I/O instead of calling a manager function has drifted the other way — push that work down.
- An Action that bypasses its manager to read or write state directly breaks the single-funnel rule from <a href="/guide/03-model-layer">Chapter 3</a>. Go through the manager, always.

## Action Controllers: the only AppKit-side bridge

An Action Controller is the one coordination-layer type allowed to touch AppKit — it presents a dialog, collects the user's input, builds an Action from it, and dispatches it. Everything downstream of that dispatch, per the boundary in <a href="/guide/01-getting-started">Chapter 1</a>, is Foundation-only again.

A common shape opens a result window immediately, before the Action has finished: a loading view binds to `action.status`, and once it flips to `.completed`, the controller fetches the result from the domain manager and swaps the content in. Results live on the manager, not on the Action itself — the Action stays focused on lifecycle, and a background-triggered run of the same work (no Action wrapper at all) can produce and cache a result the same way.

## Background controllers

Some work isn't triggered by a gesture at all — a periodic refresh, a reaction to the system waking from sleep, a value derived continuously from the Model. That's a background controller: a long-lived, app- or document-lifetime object, Foundation-only, that never shows UI and is never invoked as part of a user gesture.

```swift
protocol BackgroundController: AnyObject {
    func startRunningInBackground()
    func stopRunningInBackground()
}
```

Conforming controllers start in phase 4 of launch — see <a href="/guide/02-initializing">Chapter 2</a> — never earlier: initializers must stay fast, and a controller may assume the subsystems below it are already configured.

Reach for one when work has no gesture behind it: refreshing data on an interval, reacting to system events that can happen at any time, maintaining state derived from model changes, cleaning up stale data periodically, recording events for telemetry. And know the three cases that look like one but aren't: a one-shot user-initiated operation is an Action (this chapter); work that needs progress reporting and user cancellation is a long-running Action — the Action <em>is</em> the live operation, per the top of this chapter; window-scoped state belongs to a view state object — <a href="/guide/07-views">Chapter 7</a>.

<div class="table-wrap">
<table>
<thead><tr><th>Suffix</th><th>Driving signal</th><th>Does</th></tr></thead>
<tbody>
<tr><td class="pill">*Updater</td><td>Timer</td><td>Periodically refreshes data into local state.</td></tr>
<tr><td class="pill">*Watchdog</td><td>Timer</td><td>Checks for stalled or bad state and corrects it.</td></tr>
<tr><td class="pill">*Reaper</td><td>Timer</td><td>Periodically removes stale or expired data.</td></tr>
<tr><td class="pill">*Tracker</td><td>Event</td><td>Records observed events for later use.</td></tr>
<tr><td class="pill">*Projector</td><td>Event</td><td>Derives and publishes state from observed model changes.</td></tr>
</tbody>
</table>
</div>

The specific suffix is preferred over a generic `*Controller` or `*Observer` precisely because it makes the type's purpose legible at the call site without opening the file. A hybrid — a timer that also adjusts its cadence on events — is named for the primary signal, the one that defines its purpose.

Here's a timer-driven one in full. `StaleDraftReaper` deletes autosaved note drafts past their keep-window, and shows every lifecycle rule in one place:

```swift
final class StaleDraftReaper: BackgroundController {
    private var timer: Timer?
    private var cancellables = Set<AnyCancellable>()

    func startRunningInBackground() {
        startTimer()

        // Pause on sleep, resume on wake — otherwise the app keeps waking
        // the machine for a cleanup nobody is awake to benefit from.
        NSWorkspace.shared.notificationCenter
            .publisher(for: NSWorkspace.willSleepNotification)
            .sink { [weak self] _ in self?.timer?.invalidate() }
            .store(in: &cancellables)

        NSWorkspace.shared.notificationCenter
            .publisher(for: NSWorkspace.didWakeNotification)
            .sink { [weak self] _ in self?.startTimer() }
            .store(in: &cancellables)
    }

    func stopRunningInBackground() {
        timer?.invalidate()
        timer = nil
        cancellables.removeAll()
    }

    deinit {
        timer?.invalidate()
    }

    private func startTimer() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 60 * 30, repeats: true) { [weak self] _ in
            self?.reap()
        }
    }

    private func reap() {
        let cutoff = Date().addingTimeInterval(-30 * 24 * 3600)
        NoteManager.shared.deleteDrafts(olderThan: cutoff)
    }
}
```

The lifecycle rules the example encodes:

- <strong>Subscribe and start timers in `startRunningInBackground()`, never in `init`.</strong> The instance may be created during app setup, but nothing may fire before phase 4 — creation and starting are separate on purpose.
- <strong>A scheduled repeating `Timer` lives until it's invalidated.</strong> The run loop holds it strongly, so without an explicit `invalidate()` it keeps firing forever — and with the target/selector API it would additionally retain its target. The `weak self` in the block keeps the timer from pinning the controller; invalidation in stop <em>and</em> `deinit` keeps an orphaned timer from firing into nothing.
- <strong>Cancellables empty in stop.</strong> Block-based `NotificationCenter` observers added without Combine additionally need their token held and `removeObserver` called — they don't clean themselves up.

An event-driven controller is the same skeleton with a subscription in place of the timer: a `TagUsageProjector` subscribes to the note-changed notification, recomputes tag usage counts, and publishes the result. Which brings up the one design decision every background controller makes — <strong>where its output goes</strong>. Pick exactly one channel per piece of state:

<div class="table-wrap">
<table>
<thead><tr><th>Channel</th><th>When</th></tr></thead>
<tbody>
<tr><td>An <code>@Observable</code> property on the controller</td><td>Views and state objects consume it by tracking — <a href="/guide/08-state-observing">Chapter 8</a>.</td></tr>
<tr><td>A posted notification</td><td>Broad fan-out to consumers that don't hold a reference.</td></tr>
<tr><td>A write into a manager</td><td>The controller's whole job is refreshing data the manager already owns.</td></tr>
</tbody>
</table>
</div>

Publishing the same state through two channels means consumers never know which one to trust — one place to look, always.

<div class="rule">
<span class="rule-label">The rule</span>

A background controller may read from managers and trigger reloads on them, and it may update its own published state — delivered on the main thread, even if its work runs elsewhere. It must never show UI, never be invoked as part of a user gesture, and never be created per-window — that's a job for view state, not a background controller.

</div>

<div class="seealso">
<strong>Ahead in this guide</strong>
Validators — the precondition checks Action Controllers use to enable or disable UI, referenced above — get a full chapter next: <a href="/guide/05-action-validation">Chapter 5, Action Validation</a>. The serial runner and job structs used throughout this chapter and the last are covered properly in <a href="/guide/06-concurrency">Chapter 6, Concurrency</a>.
</div>
