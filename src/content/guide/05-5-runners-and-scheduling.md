---
title: "Runners and Scheduling"
description: "@MainActor protects a synchronous read, not an operation that suspends halfway through. This subchapter covers the runner that closes that gap — the serial runner's API and why it is a struct and not an actor, the grouped runner that lets reads overlap, how a job declares what it touches, the enqueuing protocol that adopts it, how a reload that is already queued is shared instead of run twice, and how deleting something with work in flight becomes one submission instead of a race."
order: 5
subOrder: 5
---

`@MainActor` protects a synchronous read, not an operation that suspends halfway through. This subchapter covers the runner that closes that gap — the serial runner's API and why it is a struct and not an actor, the grouped runner that lets reads overlap, how a job declares what it touches, the enqueuing protocol that adopts it, how a reload that is already queued is shared instead of run twice, and how deleting something with work in flight becomes one submission instead of a race.

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

`SerialTaskRunner` runs async closures one at a time, in strict FIFO order, off the main thread, with synchronous enqueue. It ships in `AirframeFoundation`, and its whole surface is four members:

```swift
// AirframeFoundation — SerialTaskRunner
public struct SerialTaskRunner: Sendable {
    public init()

    /// Adds `operation` to the end of the queue. It starts once every operation added before it has ended,
    /// even one that was cancelled, so two operations never run at the same time.
    @discardableResult
    public func run<T: Sendable>(
        priority: TaskPriority? = nil,
        _ operation: @Sendable @escaping () async throws -> T
    ) -> Task<T, Error>

    /// As `run(priority:_:)`, unless an operation with an equal `key` is still waiting at the end of the
    /// queue: then the returned task is that operation's.
    @discardableResult
    public func run<T: Sendable>(
        coalescing key: some Hashable & Sendable,
        priority: TaskPriority? = nil,
        _ operation: @Sendable @escaping () async throws -> T
    ) -> Task<T, Error>

    /// Cancels the running operation and every queued one. The running one stops at its next cancellation
    /// check; queued ones never start. An operation added afterwards still waits until the cancelled ones have ended.
    public func cancelAll()
}
```

What the API promises, and why each promise matters:

- <strong>Strict FIFO, one at a time.</strong> An operation starts only after every operation added before it has ended, whichever way it ended. That is the transaction the table above asks for.
- <strong>Synchronous enqueue.</strong> `run` returns before anything runs, so a `@MainActor` manager can check state and submit in one synchronous step with no suspension in between.
- <strong>Off the main thread.</strong> The operation runs on the cooperative pool with no inherited isolation; a job's `finalize` and `handle` are `@MainActor` and hop back explicitly — <a href="/guide/05-4-jobs">Chapter 5.4</a>.
- <strong>A typed task per call.</strong> The returned `Task<T, Error>` carries the operation's own result type, so `run { String }` and `run { Int }` sit in one queue.
- <strong>Cancellation while queued bails before the operation runs.</strong> A task cancelled while waiting its turn never starts its work, and cancelling it never breaks the chain for the operations behind it.
- <strong>A value type over shared state.</strong> Copies of a runner coordinate through the same queue, which is what lets several managers share one by value.
- <strong>A coalescing key.</strong> A second overload, covered below once the grouped runner is in place, because the two runners differ in exactly one detail there.

Why a struct and not an actor? Calling an actor method is itself an `await`, so enqueueing from `@MainActor` would suspend just to submit — and between any pre-enqueue check and that suspension, state can change. Actor re-entrancy also weakens FIFO: the wait for the predecessor inside an actor method is a suspension point that opens the door to reordering. The struct keeps enqueue synchronous and the chain tight, with a lock held only across the bookkeeping and never across an `await`.

`run` is synchronous and returns a raw `Task`, and that is correct <em>for `run` itself</em>: it is the primitive a manager's `async` method wraps, never the shape the manager presents to its own callers. The enqueuing protocol a manager adopts in <a href="/guide/05-3-the-manager">Chapter 5.3</a> is the bridge. The same goes for `cancelAll()`: it exists on the primitive, and no caller of the model layer calls it — cancellation arrives through the callers' own tasks, as <a href="/guide/05-9-cancellation">Chapter 5.9</a> lays out.

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

Neither runner publishes anything about the work it runs. It schedules, and that is all: a job whose run should be visible announces it through its run events (<a href="/guide/05-6-progress-and-activities">Chapter 5.6</a>), and what a job changed is announced by its own `finalize`.

## Letting independent work overlap

With a grouped runner, each job declares the resources it touches and whether it reads or writes them. The app defines the resource identities, and the environment already scopes everything to one notebook, so the groups name resources <em>within</em> it. The notebook's family protocol carries the declaration, so every job a notebook's managers enqueue has one:

```swift
// NotebookCore/Notes/NoteJobGroup.swift
enum NoteJobGroup: Hashable, Sendable {
    case notes            // the notebook's whole note collection
    case note(NoteID)     // one note
    case draft            // the summary draft — Chapter 5.6
    case suggestions      // the suggestion files — Chapter 5.7
}

// NotebookCore/Notes/NoteJob.swift
/// Every job a notebook's managers enqueue: the notebook it works on, and what it touches there.
protocol NoteJob: BackgroundJob, TaskAccess where Group == NoteJobGroup {
    var notebookID: NotebookID { get }
}

// In RenameNoteJob — beside `perform`, because what the work writes is a fact about the work
var groups: Set<NoteJobGroup> { [.notes, .note(noteID)] }
let access: TaskAccessMode = .write

// In PullNotesJob
var groups: Set<NoteJobGroup> { [.notes] }
let access: TaskAccessMode = .write

// A read job: the one case Chapter 5.1 lets through a manager, because it must see completed writes.
struct ExportNotebookJob: NoteJob {
    let notebookID: NotebookID

    var groups: Set<NoteJobGroup> { [.notes] }
    let access: TaskAccessMode = .read

    nonisolated func perform() async throws -> Data {
        try await NoteStorage.shared.exportNotebook(id: notebookID)
    }
    // No model changes: the default, empty `finalize` is sufficient.
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

### Why on the job

The groups and the access mode are declared by the job, never passed where it is enqueued:

- <strong>Same job, same groups.</strong> Coalescing, below, shares a queued run only with a request whose key, groups and access are all equal. With the groups on the job, two call sites enqueuing an equal job can never disagree about what it touches.
- <strong>The job knows what it writes.</strong> Whether a step writes the note collection is a fact about the step, not about who asked for it. Kept next to `perform`, the declaration stays in sync when the work changes.
- <strong>Per-call choices stay at the call site.</strong> What a caller decides — whether to cancel the conflicting work queued in some groups first — is an argument to `enqueue`, not a property of the job. The delete at the end of this subchapter is that case.

## Adopting the grouped runner

The grouped runner ships beside the serial one in `AirframeFoundation`. Its surface is the serial runner's, with the declarations added to `run` and one more way to cancel:

```swift
// AirframeFoundation — GroupedTaskRunner, and what a job declares for it
public struct GroupedTaskRunner<Group: Hashable & Sendable>: Sendable {
    public init()

    /// Adds `operation` behind every queued or running operation it conflicts with — one whose groups overlap
    /// `groups` where either side writes — and cancels the ones whose groups contain a member of `cancelling`,
    /// which must be a subset of `groups`, on a writer.
    @discardableResult
    public func run<Output: Sendable>(
        groups: Set<Group>,
        access: TaskAccessMode,
        cancelling: Set<Group> = [],
        priority: TaskPriority? = nil,
        _ operation: @Sendable @escaping () async throws -> Output
    ) -> Task<Output, Error>

    /// As above, unless a submission with an equal `key`, the same groups and the same access is still
    /// waiting with no overlapping writer behind it: then the returned task is that submission's.
    @discardableResult
    public func run<Output: Sendable>(
        groups: Set<Group>,
        access: TaskAccessMode,
        coalescing key: some Hashable & Sendable,
        priority: TaskPriority? = nil,
        _ operation: @Sendable @escaping () async throws -> Output
    ) -> Task<Output, Error>

    // Both again, taking a `TaskAccess` value in place of `groups:` and `access:`.

    /// Cancels every queued or running operation whose groups contain `group`.
    public func cancel(group: Group)
    public func cancelAll()
}

public enum TaskAccessMode: Sendable { case read, write }

public protocol TaskAccess: Sendable {
    associatedtype Group: Hashable & Sendable
    var groups: Set<Group> { get }
    var access: TaskAccessMode { get }
}
```

Change the environment's runner to `GroupedTaskRunner<NoteJobGroup>()`, and the one protocol every manager in the environment adopts from `BackgroundJobEnqueuing` to its grouped counterpart. The managers themselves don't change:

```swift
// NotebookCore/Environment/NotebookManaging.swift
@MainActor
protocol NotebookManaging: GroupedBackgroundJobEnqueuing where Group == NoteJobGroup {
    var environment: NotebookEnvironment { get }
}

extension NotebookManaging {
    var runner: GroupedTaskRunner<NoteJobGroup> { environment.runner }
}
```

`GroupedBackgroundJobEnqueuing` supplies `enqueue(_:cancelling:)` and `enqueue(_:coalescing:)`. It reads each job's groups and access off the job and hands them to the runner, so no public method changes: `try await enqueue(RenameNoteJob(…))` reads exactly as it did on the serial runner. It takes only jobs that declare `TaskAccess` with the runner's own group type, and that is the compile-time fence — a job declaring another domain's groups cannot be scheduled here.

## Coalescing a queued reload

A pull asked for while a pull is still waiting in the queue should not run twice. The runner is the right owner of that decision because it alone knows the two facts it depends on: when a queued operation <em>starts</em>, and what was enqueued <em>behind</em> it. That is what the `coalescing:` overload of both runners' `run` is for. With a key, an operation equal to one that is still waiting is not added at all — the caller gets the waiting operation's task. On the grouped runner, "equal" means the same key, the same groups and the same access. The moment that operation starts, its key is spent, because it may read the source before a later request arrives. And the moment something that can change state is enqueued behind it, its key is spent too, because a later request wants state from after that change. Here the two runners differ, and it is the only place they do:

<div class="table-wrap">
<table>
<thead><tr><th>Runner</th><th>A queued operation stays shareable until…</th></tr></thead>
<tbody>
<tr><td><code>SerialTaskRunner</code></td><td>anything is enqueued behind it — every operation counts as a writer</td></tr>
<tr><td><code>GroupedTaskRunner</code></td><td>a <strong>writer</strong> whose groups overlap its own is enqueued behind it — a read behind it, or a write to disjoint groups, changes nothing</td></tr>
</tbody>
</table>
</div>

The key is the job itself. A job's stored properties are its intent and nothing else, so `Hashable` is synthesised for free, and "two equal jobs coalesce" is the right rule: every `PullNotesJob(notebookID:)` for one notebook equals every other, while a `ReloadNoteJob(notebookID:noteID:)` equals only a reload of the same note. Two job types with equal fields never collide, because the runner compares keys of different types as unequal, and anything that must not be shared — a `force` flag — goes into the job and therefore into the key. Nothing that belongs to one run goes there: a run ID or a handle stored on the job would make every job unequal, and nothing would ever coalesce.

The manager adopts the key through the second method its enqueuing protocol supplies:

```swift
// AirframeFoundation — beside enqueue(_:cancelling:) on GroupedBackgroundJobEnqueuing
public func enqueue<J: BackgroundJob & TaskAccess>(
    _ job: J,
    coalescing key: some Hashable & Sendable
) async throws -> J.Output where J.Group == Group
```

It shares a queued run instead of adding one, and still finalizes the job exactly once — a call that joins a run finalizes nothing. A shared run belongs to every caller waiting on it, so one caller's cancellation does not reach it: a caller cancelled while it waits throws `CancellationError` once the run has ended, and the others keep the output. The run itself is cancelled only through the runner — `cancel(group:)` or `cancelAll()` — which ends it for every caller. There is no `cancelling:` argument here, because a request that joins a waiting run adds no work and has nothing to cancel conflicting work for.

### Why not share a running job

The runner never lets a request join a run that has already started. That run may have read the sync service before the request was made, so a Sync Now pressed mid-pull would be answered with data fetched before the change the user is waiting for. Where freshness within the call's duration genuinely does not matter, a queued run is almost always there to share anyway — the second caller simply waits one run longer.

Which jobs may coalesce, what a caller is promised, and the scenarios that follow from the rule are the subject of <a href="/guide/05-8-execution-strategies">Chapter 5.8</a>, where `pull()` becomes one line again.

## Deleting a note with ongoing work

Deletion is where ordering and cancellation meet. Make the delete a writer for the collection and the note, and request cancellation of the note's other work through the same submission:

```swift
// NotebookCore/Notes/Jobs/DeleteNoteJob.swift
struct DeleteNoteJob: NoteJob {
    let notebookID: NotebookID
    let noteID: NoteID

    var groups: Set<NoteJobGroup> { [.notes, .note(noteID)] }
    let access: TaskAccessMode = .write

    nonisolated func perform() async throws {
        try Task.checkCancellation()
        try await NoteStorage.shared.deleteNote(id: noteID, in: notebookID)
    }

    @MainActor
    func finalize(_ result: Result<Void, Error>) throws {
        try result.get()
        Notebook.notesDidChange(in: notebookID)
    }
}

// In NoteManager:
func delete(noteID: NoteID) async throws {
    try await enqueue(DeleteNoteJob(notebookID: environment.notebook.id, noteID: noteID), cancelling: [.note(noteID)])
}
```

This cancels existing work declaring that note's group, and waits for every conflicting job to finish before deleting. It also waits for collection-wide work such as a pull — without cancelling that broader operation. Later conflicting jobs wait for the deletion and then validate that their target still exists, which is what the baseline read in <a href="/guide/05-4-jobs">Chapter 5.4</a> is for. A cancelled job settles its own activity: its run ends with the cancellation, and its `handle` marks the row cancelled (<a href="/guide/05-6-progress-and-activities">Chapter 5.6</a>), so the delete has nothing to clean up after it.

The cancellation groups must be a subset of the delete job's own groups, and the job must be a writer. Use this combined submission rather than a separate cancel-then-delete sequence, which leaves room for new work to slip in between the two calls.

<div class="rule">
<span class="rule-label">The rule</span>

Every job on a notebook goes through that notebook's one runner, reached only through a manager's enqueuing protocol. A job declares every resource it touches and one access mode for all of them, on itself, never at the call site. A queued run is shared only with an equal job, and a running one never. Never schedule a conflicting job from inside a running one, and never coordinate the same resource with two runners.

</div>

<div class="seealso">
<strong>Ahead in this chapter</strong>
Keeping the UI informed while a job runs — activities, typed progress events, and streaming output — is next: <a href="/guide/05-6-progress-and-activities">Chapter 5.6, Progress and Activities</a>. The tests that exercise group declarations through the manager's entry point are in <a href="/guide/09-6-testing-each-layer">Chapter 9.6</a>.
</div>
