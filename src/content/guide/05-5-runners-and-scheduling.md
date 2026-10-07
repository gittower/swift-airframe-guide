---
title: "Runners and Scheduling"
description: "@MainActor protects a synchronous read, not an operation that suspends halfway through. This subchapter covers the runner that closes that gap — the serial runner's API and why it is a struct and not an actor, the grouped runner that lets reads overlap, how a job declares what it touches, the enqueue helper that adopts it, how a reload that is already queued is shared instead of run twice, and how deleting something with work in flight becomes one submission instead of a race."
order: 5
subOrder: 5
---

`@MainActor` protects a synchronous read, not an operation that suspends halfway through. This subchapter covers the runner that closes that gap — the serial runner's API and why it is a struct and not an actor, the grouped runner that lets reads overlap, how a job declares what it touches, the enqueue helper that adopts it, how a reload that is already queued is shared instead of run twice, and how deleting something with work in flight becomes one submission instead of a race.

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

`SerialTaskRunner` runs async closures one at a time, in strict FIFO order, off the main thread, with synchronous enqueue. Its whole surface is three members:

```swift
// Packages/Concurrency/SerialTaskRunner.swift
struct SerialTaskRunner: Sendable {
    init()

    /// Adds `operation` to the end of the queue. It starts once every operation added before it has ended,
    /// even one that was cancelled, so two operations never run at the same time. With a `key`, an operation
    /// equal to one still waiting at the end of the queue is not added — the returned task is that operation's.
    @discardableResult
    func run<T: Sendable>(
        coalescing key: AnyHashable? = nil,
        priority: TaskPriority? = nil,
        _ operation: @Sendable @escaping () async throws -> T
    ) -> Task<T, Error>

    /// Cancels the running operation and every queued one. The running one stops at its next cancellation
    /// check; queued ones never start. An operation added afterwards still waits until the cancelled ones have ended.
    func cancelAll()
}
```

What the API promises, and why each promise matters:

- <strong>Strict FIFO, one at a time.</strong> An operation starts only after every operation added before it has ended, whichever way it ended. That is the transaction the table above asks for.
- <strong>Synchronous enqueue.</strong> `run` returns before anything runs, so a `@MainActor` manager can check state and submit in one synchronous step with no suspension in between.
- <strong>Off the main thread.</strong> The operation runs on the cooperative pool with no inherited isolation; a job's main-actor handlers hop back explicitly — <a href="/guide/05-4-jobs-and-contexts">Chapter 5.4</a>.
- <strong>A typed task per call.</strong> The returned `Task<T, Error>` carries the operation's own result type, so `run { String }` and `run { Int }` sit in one queue.
- <strong>Cancellation while queued bails before the operation runs.</strong> A task cancelled while waiting its turn never starts its work, and cancelling it never breaks the chain for the operations behind it.
- <strong>A value type over shared state.</strong> Copies of a runner coordinate through the same queue, which is what lets several managers share one by value.
- <strong>A coalescing key.</strong> Covered below, once the grouped runner is in place, because the two runners differ in exactly one detail there.

Why a struct and not an actor? Calling an actor method is itself an `await`, so enqueueing from `@MainActor` would suspend just to submit — and between any pre-enqueue check and that suspension, state can change. Actor re-entrancy also weakens FIFO: the wait for the predecessor inside an actor method is a suspension point that opens the door to reordering. The struct keeps enqueue synchronous and the chain tight, with a lock held only across the bookkeeping and never across an `await`.

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
<tr><td><strong>A queued reload is shared until</strong></td><td>anything is enqueued behind it</td><td>an overlapping write is enqueued behind it</td></tr>
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

The grouped runner's surface is the serial runner's, with the declarations added to `run` and one more way to cancel:

```swift
// Packages/Concurrency/GroupedTaskRunner.swift
struct GroupedTaskRunner<Group: Hashable & Sendable>: Sendable {
    init()

    /// Adds `operation` behind every queued or running operation it conflicts with — one whose groups overlap
    /// `groups` where either side writes — and cancels the ones whose groups contain a member of `cancelling`.
    /// With a `key`, an operation equal to one still waiting with no overlapping write behind it is not added.
    @discardableResult
    func run<T: Sendable>(
        groups: Set<Group>,
        access: TaskAccessMode,
        cancelling: Set<Group> = [],
        coalescing key: AnyHashable? = nil,
        priority: TaskPriority? = nil,
        _ operation: @Sendable @escaping () async throws -> T
    ) -> Task<T, Error>

    /// Cancels every queued or running operation whose groups contain `group`.
    func cancel(group: Group)
    func cancelAll()
}

enum TaskAccessMode: Sendable { case read, write }

/// What a job declares so the manager's helper can pass it to `run`.
protocol TaskAccess {
    associatedtype Group: Hashable & Sendable
    var groups: Set<Group> { get }
    var access: TaskAccessMode { get }
}
```

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

## Coalescing a queued reload

A pull asked for while a pull is still waiting in the queue should not run twice. The runner is the right owner of that decision because it alone knows the two facts it depends on: when a queued operation <em>starts</em>, and what was enqueued <em>behind</em> it. That is what the `coalescing:` key on both `run` methods is for. With a key, an operation equal to one that is still waiting is not added at all — the caller gets the waiting operation's task. The moment that operation starts, its key is spent, because it may read the source before a later request arrives. And the moment something that can change state is enqueued behind it, its key is spent too, because a later request wants state from after that change. Here the two runners differ, and it is the only place they do:

<div class="table-wrap">
<table>
<thead><tr><th>Runner</th><th>A queued operation stays shareable until…</th></tr></thead>
<tbody>
<tr><td><code>SerialTaskRunner</code></td><td>anything is enqueued behind it — every operation counts as a writer</td></tr>
<tr><td><code>GroupedTaskRunner</code></td><td>a <strong>writer</strong> whose groups overlap its own is enqueued behind it — a read behind it, or a write to disjoint groups, changes nothing</td></tr>
</tbody>
</table>
</div>

The key is the job itself. Jobs are structs of `let` inputs, so `Hashable` is synthesised for free, and "two equal jobs coalesce" is the right rule: every `PullNotesJob()` equals every other, while a `ReloadNoteJob(noteID:)` equals only a reload of the same note. `AnyHashable` includes the type, so two job types with equal fields never collide, and anything that must not be shared — a `force` flag — goes into the job and therefore into the key.

The manager adopts the key through a second helper next to `enqueue`, and a second bridge, because a shared task has several waiters and none of them may cancel it:

```swift
extension NotebookManaging {
    /// Like `enqueue`, but a job equal to one still waiting in the queue is not added — the returned task is that job's.
    func enqueueCoalescing<J: BackgroundJob & TaskAccess & Hashable>(_ job: J) throws -> Task<J.Output, Error>
    where J.WorkContext == NoteWorkContext, J.MainContext == NoteMainContext, J.Group == NoteJobGroup {
        try Task.checkCancellation()
        let work = environment.workContext, main = environment.mainContext
        return environment.runner.run(groups: job.groups, access: job.access, coalescing: job) {
            try await job.execute(work: work, main: main)
        }
    }

    /// Coalesced work is shared with other callers, so this caller's cancellation must not reach it.
    func awaitShared<T: Sendable>(_ task: Task<T, Error>) async throws -> T {
        let value = try await task.value
        try Task.checkCancellation()
        return value
    }
}
```

Which jobs may coalesce, what a caller is promised, and the scenarios that follow from the rule are the subject of <a href="/guide/05-8-execution-strategies">Chapter 5.8</a>, where `pull()` becomes one line again.

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
