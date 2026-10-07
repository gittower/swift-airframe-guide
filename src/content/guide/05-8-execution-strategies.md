---
title: "Execution Strategies"
description: "The runner solves ordering. It does not decide what correct means when the same operation is triggered twice before the first finishes — that is a separate choice, made per call site. This subchapter covers the four strategies with a notebook example for each: cancel-and-replace for a search field, serial for every save, coalesce for a pull two callers want at once, and the gate for an operation that must not run twice."
order: 5
subOrder: 8
---

The runner solves ordering. It does not decide what correct means when the same operation is triggered twice before the first finishes — that is a separate choice, made per call site. This subchapter covers the four strategies with a notebook example for each: cancel-and-replace for a search field, serial for every save, coalesce for a pull two callers want at once, and the gate for an operation that must not run twice.

## The problem is the `await`

<a href="/guide/01-getting-started">Chapter 1</a> left one hazard open. `@MainActor` is the lock, but a method that reads state, awaits, and writes state has let go of the lock in the middle: another call to the same method can run while the first is suspended, and both will write. "It works in tests but occasionally fails in production" is the classic symptom of a method like that with no strategy chosen. Four strategies cover every case, and the right one depends on what the second call <em>means</em>.

## Cancel-and-replace

Only the latest call matters. Cancel the previous execution, and make sure a superseded result can never land.

```swift
// UI/Screens/Search/NoteSearchController.swift — a view state controller, Chapter 7.2
@MainActor
final class NoteSearchController {
    let notebook: Notebook
    let state = NoteSearchState()
    private var runningTask: Task<Void, Error>?

    init(notebook: Notebook) { self.notebook = notebook }

    func search(query: String) {
        runningTask?.cancel()
        runningTask = Task {
            let found = try await NoteManager.shared(for: notebook).search(query)
            try Task.checkCancellation()   // a newer search may have superseded us
            state.results = found
        }
    }
}
```

The `checkCancellation` immediately before the write is the critical line. If a newer `search` has already cancelled this task, it throws instead of overwriting the replacement's results with stale ones. `NoteDetailStateController.reload()` in <a href="/guide/07-2-view-state">Chapter 7.2</a> is the same strategy with a different payload — a reload for a newly selected note supersedes the one in flight.

<strong>Use when</strong> the latest request invalidates the previous ones: search-as-you-type, loading data for a newly selected item, refreshing a view. It is the default strategy for a view state controller. Its analogs elsewhere are SwiftUI's `.task(id:)` and Combine's `switchToLatest`.

## Serial

Every call carries real work that must not be lost. The second call waits for the first to finish; nothing is dropped and order is preserved.

Inside a manager this strategy is never hand-rolled — the environment's runner from <a href="/guide/05-5-runners-and-scheduling">Chapter 5.5</a> <em>is</em> the serial strategy, applied to every job on the notebook. The editor's autosave is the everyday case: each save must land, in the order the edits were made.

```swift
// NotebookCore/Notes/Jobs/SaveNoteJob.swift
struct SaveNoteJob: BackgroundJob, TaskAccess {
    let noteID: NoteID
    let body: String                       // the text as the editor had it when it asked — intent

    var groups: Set<NoteJobGroup> { [.note(noteID)] }
    let access: TaskAccessMode = .write

    nonisolated func perform(context: NoteWorkContext) async throws -> Note {
        var note = try await context.requireNote(noteID)   // the baseline, read after the previous save finished
        note.body = body
        note.modifiedAt = .now
        return note
    }

    @MainActor
    func finalize(_ result: Result<Note, Error>, context: NoteMainContext) async throws {
        try await context.store.merge([result.get()])
        context.notesDidChange()
    }
}

// In NoteManager:
func save(noteID: NoteID, body: String) async throws {
    _ = try await awaitCancellable(enqueue(SaveNoteJob(noteID: noteID, body: body)))
}
```

Two saves of the same note queue; a save of a different note runs alongside. The detail that makes serial correct is <em>when the baseline is read</em>: `requireNote` runs inside `perform`, after the previous job has finished, so the second save sees the state the first one left. A snapshot taken at submission would capture stale state and the first save's title change would vanish.

If you ever need the strategy outside a manager, this is what the runner does for you, reduced to one property:

```swift
private var previous: Task<Void, Never>?

func enqueue(_ work: @escaping @Sendable () async -> Void) {
    let predecessor = previous
    previous = Task {
        _ = await predecessor?.value     // wait for the previous call to finish
        await work()                     // and only now read the state it left behind
    }
}
```

<strong>Use when</strong> every request must complete: saves, sequential mutations, anything where order matters. <strong>Default when unsure</strong> — no work is lost and nothing fails silently.

## Coalesce

Concurrent callers want the same result. Instead of starting a second identical operation, the later caller piggybacks on the one in flight.

A pull is the notebook app's case: `SyncUpdater`, a timer-driven background controller from <a href="/guide/04-background-controllers">Chapter 4</a>, pulls every notebook on an interval, and the user can press Sync Now at any moment. With a serial runner alone, the second pull would queue and run a redundant fetch the instant the first finished. Coalescing makes both callers wait on one:

```swift
// In NoteManager — replaces the one-line pull() from Chapter 5.3. A pull already in flight is the result every caller wants.
private var inFlightPull: Task<[Note], Error>?

func pull() async throws {
    if let inFlight = inFlightPull {
        _ = try await inFlight.value          // piggyback — no second fetch
        return
    }
    let task = try enqueue(PullNotesJob())
    inFlightPull = task
    defer { inFlightPull = nil }
    _ = try await task.value
}
```

There is no suspension between checking `inFlightPull` and setting it, so two callers arriving together cannot both start work — `@MainActor` is still the lock for the synchronous part. The `defer` clears the handle whichever way the owning call ends.

Notice what is missing: the cancellation bridge. Cancelling one caller must not cancel work another caller is waiting on, so neither the owner nor the piggybacker forwards cancellation to the shared task. A pull runs to completion once started — it is a mutation that must land, exactly the category <a href="/guide/05-9-cancellation">Chapter 5.9</a> says is not worth cancelling. A caller that needs to bail early checks cancellation after the await, before using the result.

This is also the one legitimate reason for a manager to hold in-flight state: deduplication inside its own method. It is private, it is a handle rather than a flag, and nothing outside the manager reads it — the `isPullRunning` smell in <a href="/guide/05-3-the-manager">Chapter 5.3</a> is a different thing.

<strong>Use when</strong> the result is the same regardless of who triggered the request: expensive reads or idempotent refreshes that several UI paths can request at once.

## Gate

A second call is genuinely invalid while the first runs. Reject it with an error, so the caller knows and can decide what to do.

```swift
// NotebookCore/Sync/SyncManager.swift — app-wide, Chapter 2.5
@MainActor
public final class SyncManager {
    public static let shared = SyncManager()
    private var isSigningIn = false

    public func signIn(with credentials: Credentials) async throws {
        guard !isSigningIn else { throw SyncError.signInAlreadyInProgress }
        isSigningIn = true
        defer { isSigningIn = false }

        let session = try await client.signIn(credentials)       // network
        SyncStore.shared.applySession(session)                    // back on the main actor
        SyncStore.notifications.postAccountDidChange()
    }
}
```

Signing in twice concurrently is not two pieces of work to order; it is a mistake, and the sign-in sheet's action controller should hear about it rather than have a second sign-in silently queue behind the first. The gate must throw. A gate that swallows the second call turns a user's click into nothing with no explanation.

<strong>Use sparingly.</strong> Before reaching for a gate, ask whether serial is what you actually want: if the second call represents legitimate work that should eventually complete, enqueue it, don't reject it. A gate is for operations that are non-repeatable while running — sign-in, a one-time migration, an upgrade.

## Choosing a strategy

<div class="table-wrap">
<table>
<thead><tr><th>Situation</th><th>Strategy</th><th>Why</th></tr></thead>
<tbody>
<tr><td>Only the latest result matters</td><td><strong>Cancel-and-replace</strong></td><td>Previous work is obsolete; a stale result must not land</td></tr>
<tr><td>Every request must complete</td><td><strong>Serial</strong> — <em>default when unsure</em></td><td>No work lost, order preserved</td></tr>
<tr><td>Same result, several triggers</td><td><strong>Coalesce</strong></td><td>Avoid redundant work; everyone waits on one</td></tr>
<tr><td>A concurrent call is an error</td><td><strong>Gate</strong></td><td>The caller must know it was rejected</td></tr>
<tr><td>Independent operations, no shared state</td><td>None</td><td>A direct <code>await</code> is fine</td></tr>
</tbody>
</table>
</div>

The strategy is chosen per call site, not per type, and the layers have defaults. A view state controller cancels and replaces, because its job is to show the current selection. A manager is serial, because the runner makes it so for free. Coalescing appears where a timer and a gesture can fire the same operation. The gate appears rarely, and always throws.

<div class="rule">
<span class="rule-label">The rule</span>

Every method that reads state, suspends, and writes state has chosen a strategy, and the choice is visible in the code: a stored task that gets cancelled, a job on the runner, an in-flight handle, or a guard that throws. A method with none of those is a re-entrancy bug waiting for production traffic.

</div>

<div class="seealso">
<strong>Ahead in this chapter</strong>
Each strategy meets cancellation differently — and a cancelled operation is not a rolled-back one. Both, with how cancellation flows from a caller's task through the bridge into a job and out to an external process, are next: <a href="/guide/05-9-cancellation">Chapter 5.9, Cancellation</a>.
</div>
