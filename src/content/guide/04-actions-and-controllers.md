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

The specific suffix is preferred over a generic `*Controller` or `*Observer` precisely because it makes the type's purpose legible at the call site without opening the file. Timer-driven controllers pause on system sleep and resume on wake — otherwise the app keeps waking the machine for a check the user never notices was worth it.

<div class="rule">
<span class="rule-label">The rule</span>

A background controller may read from managers and trigger reloads on them, and it may update its own published state. It must never show UI, never be invoked as part of a user gesture, and never be created per-window — that's a job for view state, not a background controller.

</div>

<div class="seealso">
<strong>Ahead in this guide</strong>
Validators — the precondition checks Action Controllers use to enable or disable UI, referenced above — get a full chapter next: <a href="/guide/05-action-validation">Chapter 5, Action Validation</a>. The serial runner and job structs used throughout this chapter and the last are covered properly in <a href="/guide/06-concurrency">Chapter 6, Concurrency</a>.
</div>
