---
title: "Runners and Scheduling"
description: "@MainActor protects a synchronous read, not an operation that suspends halfway through. This subchapter covers the runner that closes that gap — the serial runner and why it is a struct and not an actor, the grouped runner that lets reads overlap, how a job declares what it touches, the enqueue helper that adopts it, and how deleting something with work in flight becomes one submission instead of a race."
order: 5
subOrder: 5
---

`@MainActor` protects a synchronous read, not an operation that suspends halfway through. This subchapter covers the runner that closes that gap — the serial runner and why it is a struct and not an actor, the grouped runner that lets reads overlap, how a job declares what it touches, the enqueue helper that adopts it, and how deleting something with work in flight becomes one submission instead of a race.

## The gap a runner closes

`@MainActor` serialises access to state, but another call can run while a method is suspended at an `await`. A save that reads the current note, awaits the network, and writes the result back has a hole in the middle: a second save can read the same starting state during that `await`, and whichever finishes last silently wins. If a save must finish before the next edit loads its starting state, the whole operation — not just its synchronous parts — has to run one at a time.

<div class="table-wrap">
<table>
<thead><tr><th>Need</th><th>An actor alone</th><th>A runner</th></tr></thead>
<tbody>
<tr><td>One-at-a-time access to state, no <code>await</code> inside</td><td>Yes</td><td>Not needed</td></tr>
<tr><td>One-at-a-time across <code>await</code>s — a transaction</td><td>No</td><td>Yes</td></tr>
<tr><td>Strict first-in, first-out ordering</td><td>No</td><td>Yes</td></tr>
<tr><td>Synchronous enqueue from <code>@MainActor</code></td><td>No</td><td>Yes</td></tr>
</tbody>
</table>
</div>

The runner belongs to the environment from <a href="/guide/05-2-the-environment">Chapter 5.2</a> — one per notebook, shared by every manager in it — and no manager owns one privately. Two notebooks have two environments and two runners, so work on different notebooks never waits on each other.

## The serial runner

`SerialTaskRunner` runs async closures one at a time, in strict FIFO order, off the main thread, with synchronous enqueue. It is small enough to read in full:

```swift
// Packages/Concurrency/SerialTaskRunner.swift
struct SerialTaskRunner: Sendable {
    private let state = State()

    private final class State: @unchecked Sendable {
        let lock = NSLock()
        var previous: Task<Void, Never>?
    }

    @discardableResult
    func run<T: Sendable>(
        priority: TaskPriority? = nil,
        _ operation: @Sendable @escaping () async throws -> T
    ) -> Task<T, Error> {
        state.lock.lock()
        let prev = state.previous
        state.lock.unlock()

        let task = Task.detached(priority: priority) {
            _ = await prev?.value            // wait for the predecessor
            try Task.checkCancellation()     // bail if cancelled while queued
            return try await operation()
        }

        state.lock.lock()
        state.previous = Task.detached { _ = try? await task.value }
        state.lock.unlock()

        return task
    }

    func cancelAll() {
        state.lock.lock()
        let prev = state.previous
        state.previous = nil
        state.lock.unlock()
        prev?.cancel()
    }
}
```

Each piece is there for a reason:

- <strong>A struct over a reference-typed `State`.</strong> Cheap to copy, and every copy coordinates through the same chain — which is what lets several managers share one runner by value.
- <strong>`Task.detached`.</strong> A plain `Task { }` inherits the caller's actor; called from a `@MainActor` manager it would run on the main thread and defeat the purpose.
- <strong>Two tasks per call.</strong> The returned task carries `T` and `Error`. The chain task is uniformly `Task<Void, Never>` so heterogeneous return types still link: `run { String }` can follow `run { Int }`.
- <strong>`checkCancellation` before the operation.</strong> A task cancelled while waiting its turn never starts its work.
- <strong>A lock, held only across a pointer swap.</strong> Never `await` while holding it.

Why not an actor? Calling an actor method is itself an `await`, so enqueueing from `@MainActor` would suspend just to submit — and between any pre-enqueue check and that suspension, state can change. Actor re-entrancy also weakens FIFO: the `await prev?.value` inside an actor method is a suspension point that opens the door to reordering. The struct keeps enqueue synchronous and the chain tight.

`run` is synchronous and returns a raw `Task`, and that is correct <em>for `run` itself</em>: it is the primitive a manager's `async` method wraps, never the shape the manager presents to its own callers. <a href="/guide/05-3-the-manager">Chapter 5.3</a> has the bridge. The same goes for `cancelAll()`: it exists on the primitive, and nothing outside the package can reach the runner to call it — cancellation arrives through the callers' own tasks, as <a href="/guide/05-9-cancellation">Chapter 5.9</a> lays out.

## Choosing a runner

Use `SerialTaskRunner` when all operations share one resource and must run one at a time. That is the right default and the simplest mental model. Use `GroupedTaskRunner` when strict-serial is too coarse: when reads of the same resource may overlap, or when independent parts of the resource can proceed together.

<div class="table-wrap">
<table>
<thead><tr><th></th><th><code>SerialTaskRunner</code></th><th><code>GroupedTaskRunner</code></th></tr></thead>
<tbody>
<tr><td><strong>Concurrency</strong></td><td>None — strict FIFO</td><td>Reads overlap within a group; writes serialise; disjoint groups run in parallel</td></tr>
<tr><td><strong>What a job declares</strong></td><td>Nothing</td><td>Its groups and an access mode</td></tr>
<tr><td><strong>Use when</strong></td><td>One logical resource, no read parallelism wanted — <strong>default when unsure</strong></td><td>One resource with semi-independent areas, or frequent reads that should not wait on each other</td></tr>
<tr><td><strong>Cancellation</strong></td><td>Per task, or everything</td><td>Per task, by group, or everything</td></tr>
</tbody>
</table>
</div>

The serial runner is the grouped runner's degenerate case: one group, every job a writer. Everything above it in the manager — the bridge, the one-line methods, the job's lifecycle — is identical for both, which is why the notebook app can start serial and adopt groups later without touching a job's `perform` or `finalize`.

## Letting independent work overlap

With a grouped runner, each job declares the resources it touches and whether it reads or writes them. The app defines the resource identities, and the environment already scopes everything to one notebook, so the groups name resources <em>within</em> it:

```swift
// NotebookCore/Notes/NoteJobGroup.swift
enum NoteJobGroup: Hashable, Sendable {
    case notes            // the notebook's whole note collection
    case note(NoteID)     // one note
    case draft            // the summary draft — Chapter 5.6
    case suggestions      // the suggestion files — Chapter 5.7
}

extension RenameNoteJob: TaskAccess {
    var groups: Set<NoteJobGroup> { [.notes, .note(noteID)] }
    var access: TaskAccessMode { .write }
}

extension PullNotesJob: TaskAccess {
    var groups: Set<NoteJobGroup> { [.notes] }
    var access: TaskAccessMode { .write }
}

// A read job: the one case Chapter 5.1 lets through a manager, because it must see completed writes.
struct ExportNotebookJob: BackgroundJob, TaskAccess {
    typealias MainContext = NoteMainContext
    var groups: Set<NoteJobGroup> { [.notes] }
    let access: TaskAccessMode = .read

    nonisolated func perform(context: NoteWorkContext) async throws -> Data {
        try await context.storage.exportNotebook(id: context.notebookID)
    }
    // No model changes: the default result handler is sufficient.
}
```

Two jobs conflict when their groups overlap and at least one is a writer:

<div class="table-wrap">
<table>
<thead><tr><th>A new job that…</th><th>Waits for</th></tr></thead>
<tbody>
<tr><td><strong>reads</strong></td><td>every in-flight <strong>write</strong> whose groups overlap its own</td></tr>
<tr><td><strong>writes</strong></td><td>every in-flight <strong>write and read</strong> whose groups overlap its own</td></tr>
</tbody>
</table>
</div>

In the example above:

- Two exports of the same notebook run together.
- A rename or a pull waits for earlier exports and writes on that notebook. Later exports wait for that write, even while it is still queued.
- Work on another notebook proceeds independently regardless — it has its own environment and its own runner.

Declaring the `.notes` group on every rename also serialises edits to different notes in the notebook. Choose this when edits must exclude a collection-wide sync; drop `.notes` and keep only `.note(noteID)` when edits to different notes may overlap. Group names have no implicit hierarchy: a job declaring only `.note(id)` does not conflict with a job declaring only `.notes`. Include every resource whose access needs coordination, and if the operation writes any declared resource, use `.write` — a job has one access mode for all of its groups.

`ExportNotebookJob` names its `MainContext` to use the manager's helper even though it never uses that context; without the type alias, a job with no result handler defaults to `Void` and the `where` clause rejects it.

## Adopting the grouped runner

Change the environment's runner to `GroupedTaskRunner<NoteJobGroup>()`, then replace the body of `enqueue` in the `NotebookManaging` extension from Chapter 5.3:

```swift
extension NotebookManaging {
    func enqueue<J: BackgroundJob & TaskAccess>(
        _ job: J,
        cancelling groups: Set<NoteJobGroup> = []
    ) throws -> Task<J.Output, Error>
    where J.WorkContext == NoteWorkContext,
          J.MainContext == NoteMainContext,
          J.Group == NoteJobGroup {
        try Task.checkCancellation()
        let work = environment.workContext, main = environment.mainContext
        return environment.runner.run(groups: job.groups, access: job.access, cancelling: groups) {
            try await job.execute(work: work, main: main)
        }
    }
}
```

Every manager in the environment picks up the new helper, and no public method changes. The third `where` clause joins the first two as a compile-time fence: a job declaring another domain's groups cannot be scheduled here.

Mode and groups live on the job rather than at the call site because for these jobs they never vary — a rename is always a write to its note. If a job's locking genuinely differed per call, the groups would be an `enqueue` argument instead, and the job would stay pure work.

## Deleting a note with ongoing work

Deletion is where ordering and cancellation meet. Make the delete a writer for the collection and the note, and request cancellation of the note's other work through the same submission:

```swift
// NotebookCore/Notes/Jobs/DeleteNoteJob.swift
struct DeleteNoteJob: BackgroundJob, TaskAccess {
    let noteID: NoteID
    var groups: Set<NoteJobGroup> { [.notes, .note(noteID)] }
    let access: TaskAccessMode = .write

    nonisolated func perform(context: NoteWorkContext) async throws {
        try Task.checkCancellation()
        try await context.storage.deleteNote(id: noteID, in: context.notebookID)
    }

    @MainActor
    func finalize(_ result: Result<Void, Error>, context: NoteMainContext) throws {
        try result.get()
        context.notesDidChange()
    }
}

// In NoteManager:
func delete(noteID: NoteID) async throws {
    try await awaitCancellable(enqueue(DeleteNoteJob(noteID: noteID), cancelling: [.note(noteID)]))
}
```

This cancels existing work declaring that note's group, and waits for every conflicting job to finish before deleting. It also waits for collection-wide work such as a pull — without cancelling that broader operation. Later conflicting jobs wait for the deletion and then validate that their target still exists, which is what the baseline read in <a href="/guide/05-4-jobs-and-contexts">Chapter 5.4</a> is for. If an activity was tracking the deleted note, the delete's handler resets it.

The cancellation groups must be a subset of the delete job's own groups, and the job must be a writer. Use this combined submission rather than a separate cancel-then-delete sequence, which leaves room for new work to slip in between the two calls.

<div class="rule">
<span class="rule-label">The rule</span>

Every job on a notebook goes through that notebook's one runner, reached only through a manager's private `enqueue`. A job declares every resource it touches and one access mode for all of them. Never schedule a conflicting job from inside a running one, and never coordinate the same resource with two runners.

</div>

<div class="seealso">
<strong>Ahead in this chapter</strong>
Keeping the UI informed while a job runs — activities, typed progress events, and streaming output — is next: <a href="/guide/05-6-progress-and-activities">Chapter 5.6, Progress and Activities</a>. The tests that exercise group declarations through the manager's entry point are in <a href="/guide/09-6-testing-each-layer">Chapter 9.6</a>.
</div>
