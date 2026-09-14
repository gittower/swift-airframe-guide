---
title: "Actions"
description: "The Action is the unit of user intent — a live operation with its own lifecycle, progress, and cancellation. This subchapter covers what an Action carries, when a gesture earns one instead of a plain manager call, and the line between an Action and a manager function it calls into."
order: 4
subOrder: 1
---

The Action is the unit of user intent — a live operation with its own lifecycle, progress, and cancellation. This subchapter covers what an Action carries, when a gesture earns one instead of a plain manager call, and the line between an Action and a manager function it calls into.

## An Action is the thing in flight

An Action is `@Observable` and `@MainActor`, and it carries its own lifecycle — `title`, `status`, progress, and a `cancel()` that means it. The Action represents the live user operation: it spawns its own task in `main()` and stays alive until that task finishes. A manager job may also update shared activity state for a notebook, as shown in <a href="/guide/05-concurrency">Chapter 5</a>; that state lets multiple views observe progress without taking over execution or cancellation from the Action.

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

This is the same narrow exception <a href="/guide/03-model-layer">Chapter 3</a> makes for a settings object, for the same reason: an Action is never constructed or written to off the main actor, so `@Observable`'s guarantees are true of it and not just declared. Every model-layer type that has background work behind it — which is most of them, even the ones marked `@MainActor` — doesn't get the same pass, because that background work is exactly what `@Observable` can't honestly track.

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
- A manager growing `isSyncRunning`-style in-flight flags is duplicating what the Action layer already knows — the central manager enumerates running Actions. Track in-flight state on a manager only when a consumer that isn't an Action genuinely needs to query it; parallel bookkeeping drifts.

<div class="seealso">
<strong>Ahead in this guide</strong>
Action Controllers — the only coordination-layer type allowed to touch AppKit, and the background controllers that run with no gesture behind them at all — are next: <a href="/guide/04-2-action-controllers">Chapter 4.2, Action Controllers</a>.
</div>
