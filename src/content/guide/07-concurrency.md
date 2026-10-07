---
title: "Concurrency"
description: "Build manager operations with background jobs, declare which work can overlap, and report progress without moving application state off the main actor."
order: 7
---

Managers expose plain `async` operations. Inside a manager, jobs describe the work, the environment's runner orders it, and progress events keep the UI informed through activities the environment owns. This chapter extends the notebook example from <a href="/guide/05-model-layer">Chapter 5</a> using those APIs. The framework supplies their execution and delivery machinery.

## Choosing a runner

`@MainActor` protects synchronous access to application state, but another call can run while a method is suspended at an `await`. If a save must finish before the next edit loads its starting state, submit the whole operation through a runner.

Use `SerialTaskRunner` when all operations share one resource and must run one at a time. Use `GroupedTaskRunner` when independent resources can proceed together, or when reads of the same resource may overlap. Either way the runner belongs to the environment from Chapter 5 — one per notebook, shared by every manager in it — and no manager owns one privately. Two notebooks have two environments and two runners, so work on different notebooks never waits on each other.

## Writing a job

Conform to `BackgroundJob`, capture intent in immutable properties, and implement `perform(context:)` against the work context. When the operation changes model state, implement `handleResult(_:context:)` against the main context, for persistence and publication on the main actor. The manager's runner closure calls the supplied `execute(work:main:)`; app jobs do not implement it.

Here is an edit that preserves changes made by an earlier queued job:

```swift
struct RenameNoteJob: BackgroundJob {
    let noteID: NoteID
    let title: String

    nonisolated func perform(context: NoteWorkContext) async throws -> Note {
        // The current record when this job runs, not when it was submitted.
        var note = try await context.requireNote(noteID)
        note.title = title
        return note
    }

    @MainActor func handleResult(
        _ result: Result<Note, Error>, context: NoteMainContext
    ) async throws {
        try await context.store.merge([result.get()])
        context.notesDidChange()
    }
}
```

`Note` here is a `Sendable` value, not a managed object passed between database contexts. `NoteWorkContext` and `NoteMainContext` are the two contexts from Chapter 5, built once by the notebook's environment: the worker gets background-safe libraries, storage, and the baseline read `requireNote`; the handler gets the store, the activities, and the way to publish.

Capture the requested title and independent configuration before submission. Fetch and validate the current note inside `perform`, after earlier conflicting jobs have finished. Capturing an entire editable note at submission could overwrite an earlier job's changes; checking existence at execution also prevents a delayed edit from recreating a deleted note. That is why the baseline read lives on the work context and not on the job.

The complete operation includes `handleResult`: the next conflicting job waits until persistence, notifications, and activity updates finish. Keep these steps in the handler, and await any work they start. Do not move the save after the manager's `awaitCancellable` call or launch an unawaited task to finish it later — the manager never touches a job's result. A result handler receives failures too; it can settle progress state and rethrow. A job that only returns data can omit the handler.

## Letting independent work overlap

Add `TaskAccess` when the environment's runner is grouped. The app defines resource identities and chooses one access mode for all of a job's groups. The environment already scopes everything to one notebook, so the groups name resources <em>within</em> it:

```swift
enum NoteJobGroup: Hashable, Sendable {
    case notes            // the notebook's whole collection
    case note(NoteID)     // one note
    case draft            // the summary draft — see "Progress for one screen"
}

extension RenameNoteJob: TaskAccess {
    var groups: Set<NoteJobGroup> { [.notes, .note(noteID)] }
    var access: TaskAccessMode { .write }
}

// PullNotesJob is defined in Chapter 5.
extension PullNotesJob: TaskAccess {
    var groups: Set<NoteJobGroup> { [.notes] }
    var access: TaskAccessMode { .write }
}

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

Two jobs conflict when their groups overlap and at least one is a writer. In this example:

- Two exports of the same notebook can run together.
- A rename or pull waits for earlier exports and writes on that notebook. Later exports wait for that write, even while it is queued.
- Work on another notebook proceeds independently regardless — it has its own environment and its own runner.

Declaring the `.notes` group on every rename also serializes edits to different notes in the notebook. Choose this when edits must exclude a collection-wide sync. Group names have no implicit hierarchy: a job declaring only `.note(id)` does not conflict with a job declaring only `.notes`. Include every resource whose access needs coordination. If the operation writes any declared resource, use `.write`.

To adopt this in Chapter 5's example, change the environment's runner to `GroupedTaskRunner<NoteJobGroup>()`, then replace the manager's enqueue helper with:

```swift
private func enqueue<J: BackgroundJob & TaskAccess>(
    _ job: J,
    cancelling groups: Set<NoteJobGroup> = []
) throws -> Task<J.Output, Error>
where J.WorkContext == NoteWorkContext,
      J.MainContext == NoteMainContext,
      J.Group == NoteJobGroup {
    try Task.checkCancellation()
    let work = environment.workContext, main = environment.mainContext
    return environment.runner.run(
        groups: job.groups, access: job.access, cancelling: groups
    ) {
        try await job.execute(work: work, main: main)
    }
}

func rename(noteID: NoteID, to title: String) async throws {
    _ = try await awaitCancellable(enqueue(RenameNoteJob(noteID: noteID, title: title)))
}
```

`ExportNotebookJob` names its `MainContext` to use this helper, even though it does not use that context; without the type alias, a job with no result handler defaults to `Void`. The context and group constraints catch accidental submissions from another job family. `TagManager` shares the environment and so shares this exact helper — it is the one piece of boilerplate worth factoring into a protocol extension over `environment` once a domain has a second manager.

Do not enqueue and await another conflicting job from inside `perform` or `handleResult`: that job would wait for the operation awaiting it. Compose related steps inside one job using its work context. The same deadlock is why a manager never calls another manager on the same runner — Chapter 5's rule.

### Deleting a note with ongoing work

Make deletion a writer for the collection and the note, and request cancellation through the same enqueue call:

```swift
struct DeleteNoteJob: BackgroundJob, TaskAccess {
    let noteID: NoteID
    var groups: Set<NoteJobGroup> { [.notes, .note(noteID)] }
    let access: TaskAccessMode = .write

    nonisolated func perform(context: NoteWorkContext) async throws {
        try Task.checkCancellation()
        try await context.storage.deleteNote(id: noteID, in: context.notebookID)
    }

    @MainActor func handleResult(
        _ result: Result<Void, Error>, context: NoteMainContext
    ) throws {
        try result.get()
        context.notesDidChange()
    }
}

// In NoteManager:
func delete(noteID: NoteID) async throws {
    try await awaitCancellable(enqueue(
        DeleteNoteJob(noteID: noteID),
        cancelling: [.note(noteID)]
    ))
}
```

This cancels existing work declaring that note group and waits for conflicting work to finish before deleting. It also waits for collection-wide work, such as a pull, without cancelling that broader operation. Later conflicting jobs wait for deletion, then validate that their target still exists. Make deletion reset any activity that was tracking the deleted note in its result handler.

The cancellation groups must be a subset of the delete job's groups, and the job must be a writer. Use this combined submission for deletion rather than a separate cancel-then-delete sequence that leaves room for new work between the two calls.

## Adding live progress

Progress goes to an <strong>activity</strong>: an `@Observable @MainActor` object that holds the live state of one kind of operation, written only by jobs' main-actor handlers and read by whichever screens care. The environment owns every activity for its notebook, in the `activities` collection Chapter 5's main context already carries, so a job reaches its activity through the context and no manager has to create one before enqueueing:

```swift
// NotebookCore/Notes/NoteActivities.swift
/// Every progress sink for one notebook. Jobs write from their main-actor handlers; screens observe.
@MainActor
final class NoteActivities {
    let pull = SyncActivity()
    let draft = DraftActivity()
}

@Observable @MainActor
final class SyncActivity {
    enum State: Equatable {
        case idle, running(stage: String?), cancelled, failed(message: String)
    }
    private(set) var state: State = .idle

    func begin() { state = .running(stage: nil) }
    func updateStage(_ text: String) {
        guard case .running = state else { return }
        state = .running(stage: text)
    }
    func finish(_ state: State) { self.state = state }
}
```

Conform directly to `ProgressReportingJob` when a job needs progress. Implement the `perform(context:progress:)` overload and `handleProgress(_:context:)`; keep the same result handler pattern. The framework supplies the ordinary `perform(context:)` overload for calls that do not need live progress.

```swift
struct PullNotesWithProgressJob: ProgressReportingJob, TaskAccess {
    var groups: Set<NoteJobGroup> { [.notes] }
    let access: TaskAccessMode = .write

    enum Progress: Sendable {
        case started
        case downloaded(noteCount: Int)
    }

    nonisolated func perform(
        context: NoteWorkContext, progress: JobProgressReporter<Progress>
    ) async throws -> [Note] {
        progress.report(.started)
        let notes = try await context.client.fetchNotes(in: context.notebookID)
        try Task.checkCancellation()
        progress.report(.downloaded(noteCount: notes.count))
        return notes
    }

    @MainActor func handleProgress(
        _ progress: Progress, context: NoteMainContext
    ) {
        switch progress {
        case .started: context.activities.pull.begin()
        case .downloaded(let count): context.activities.pull.updateStage("Saving \(count) notes")
        }
    }

    @MainActor func handleResult(
        _ result: Result<[Note], Error>, context: NoteMainContext
    ) async throws {
        let activity = context.activities.pull
        do {
            try await context.store.merge(result.get())
            context.notesDidChange()
            activity.finish(.idle)
        } catch {
            activity.finish(error is CancellationError
                ? .cancelled : .failed(message: error.localizedDescription))
            throw error
        }
    }
}
```

The worker only calls `progress.report`. Events reach `handleProgress` on the main actor in reported order, and accepted progress is delivered before `handleResult`, including on failure or cancellation. Late callbacks after work ends cannot update a completed operation. Preserve the source's logical order when forwarding library callbacks; do not start a separate `Task` for each event.

A downloaded count describes progress, not a successful save. Publish success only after persistence succeeds, and settle the activity on error as well. Views observe the activity through `NoteActivities.shared(for: notebook)` and the app's state-observation pattern; opening or closing a view does not own the underlying operation. The activity is progress state, while the calling Action or background controller owns execution and cancellation.

Progress reporting is main-actor only on purpose. The objects that display progress live on the main actor and nowhere else, so delivering every event there means neither they nor the activity need to be thread-safe. The same reasoning puts result handling there: the work comes back to the main actor once, and everything that happens to it — the save, the notification, the activity — happens where its consumers are.

### Controlling frequent updates

For streaming output, choose a delivery interval and merge only events that are safe to combine. These are optional members on the job; by default the interval is zero and events are not coalesced.

For example, a `DraftSummaryJob: ProgressReportingJob` that streams a notebook summary can declare:

```swift
enum Progress: Sendable, Equatable {
    case started
    case text(String)
    case stage(String)
}

static let progressDeliveryInterval: Duration = .milliseconds(50)

nonisolated static func coalesceProgress(
    _ previous: Progress, _ next: Progress
) -> Progress? {
    guard case .text(let first) = previous,
          case .text(let second) = next else { return nil }
    return .text(first + second)
}
```

The interval batches delivery; it does not discard events. The coalescer combines adjacent pending text deltas in order: `"Hello"` followed by `" world"` becomes `"Hello world"`. Returning `nil` preserves both events, so a stage change or saved-record acknowledgement remains a boundary. The coalescer must be a pure value transformation with no UI or other side effects. Append raw text in `handleProgress`; transform it for display after accumulation so chunk boundaries cannot alter the content.

### Progress for one screen

A preview sheet generating a draft has a different lifetime from shared sync, and it is tempting to hand the job a closure so only that sheet hears about it. Don't: a per-execution callback on the main context is the smell Chapter 5 names, and the job already has what it needs. The sheet gets its own activity, `draft`, exactly like `pull`:

```swift
@Observable @MainActor
final class DraftActivity {
    private(set) var isGenerating = false
    private(set) var stage: String?
    private(set) var text = ""

    func begin() { isGenerating = true; stage = nil; text = "" }
    func append(_ delta: String) { text += delta }
    func updateStage(_ value: String) { stage = value }
    func finish() { isGenerating = false }
}

// In DraftSummaryJob:
var groups: Set<NoteJobGroup> { [.draft] }
let access: TaskAccessMode = .write

@MainActor func handleProgress(_ progress: Progress, context: NoteMainContext) {
    let draft = context.activities.draft
    switch progress {
    case .started: draft.begin()
    case .text(let delta): draft.append(delta)
    case .stage(let value): draft.updateStage(value)
    }
}

@MainActor func handleResult(_ result: Result<String, Error>, context: NoteMainContext) throws {
    context.activities.draft.finish()
    try result.get()
}
```

The manager's public method still returns the actual draft:

```swift
func draftSummary() async throws -> String {
    try await awaitCancellable(enqueue(DraftSummaryJob()))
}
```

`DraftSummaryJob` returns a transient `String`, forwards its summarization client's events through the reporter, and writes to one activity. Declaring `.draft` as a <em>write</em> group is what keeps that activity coherent: a second request queues behind the first, a cancelled queued request never starts, and a cancelled running one settles — its accepted progress delivered, its handler's `finish()` run — before the next `begin()`. The sheet observes a clean sequence without any request bookkeeping. Adopting and saving the draft is a separate operation.

## Execution strategies: avoiding races by construction

The runner solves ordering. It doesn't decide what "correct" means when the same operation is triggered twice before the first finishes — that's a separate choice, made per call site.

<div class="table-wrap">
<table>
<thead><tr><th>Strategy</th><th>Use when</th></tr></thead>
<tbody>
<tr><td><strong>Cancel-and-replace</strong></td><td>Only the latest call matters — search-as-you-type, loading data for a newly selected item.</td></tr>
<tr><td><strong>Serial (enqueue)</strong></td><td>Every call carries real work that must not be lost — saves, sequential mutations. <strong>Default when unsure.</strong></td></tr>
<tr><td><strong>Coalesce</strong></td><td>Concurrent callers want the same result — piggyback on the in-flight request instead of starting a second one.</td></tr>
<tr><td><strong>Gate (reject)</strong></td><td>A second call is genuinely invalid while the first runs — a non-repeatable operation. Use sparingly; the caller must see the rejection.</td></tr>
</tbody>
</table>
</div>

```swift
@MainActor
final class NoteSearchController {
    let notebook: Notebook
    private(set) var results: [Note] = []
    private var runningTask: Task<Void, Error>?

    init(notebook: Notebook) { self.notebook = notebook }

    func search(query: String) {
        runningTask?.cancel()
        runningTask = Task {
            let found = try await NoteManager.shared(for: notebook).search(query)
            try Task.checkCancellation()   // a newer search may have superseded us
            self.results = found
        }
    }
}
```

For replaceable UI loads, check cancellation immediately before assigning the result so a superseded request cannot overwrite its replacement. Durable writes have a different contract, described below.

## Cancellation as part of a task's contract

A caller uses the `Task` it creates around an `async` call as its cancellation handle. The manager's cancellation bridge forwards cancellation to the runner's task; awaiting an unstructured task's value alone does not do that. Workers and external libraries must still cooperate with cancellation.

### One shape for every public entry point: plain `async`

A manager's public surface — every method a controller, an Action, or a background controller calls — is `async`, returning the actual result. `NoteManager.pull` from <a href="/guide/05-model-layer">Chapter 5</a> is the model: no raw `Task` return type, ever, at that boundary.

```swift
// ✅ Public API — plain async, returns the result
func pull() async throws { /* … */ }

// ❌ Public API — synchronous, hands back a raw Task
func pull() -> Task<Void, Error> { /* … */ }

// ❌ The hybrid — worst of both
func pull() async -> Task<Void, Error> { /* … */ }
```

Both banned forms fail for different reasons. The hybrid makes the caller await setup before it even receives a handle, splitting cancellation across two objects — the caller's own task for the setup, the returned task for the work — and neither alone cancels the whole operation. Plain synchronous `-> Task<...>` looks safer but fails the identical way the moment the method needs to `await` anything before it can return a handle, and in the meantime it leaks an implementation detail — there happens to be a queue under here — straight into the public API.

The runner returns a `Task`, as does the manager's private `enqueue` helper. The manager wraps both behind its `async` operations, so callers never handle the runner task directly.

### Wiring cancellation once

Use Chapter 5's `awaitCancellable` helper around every enqueued operation. It awaits the runner task under a cancellation handler and forwards the caller's cancellation. Check cancellation before submission too, especially after asynchronous setup such as loading configuration.

```swift
// In the preview sheet's @MainActor view controller:
private var loadingTask: Task<Void, Error>?

func loadSummary() {
    loadingTask?.cancel()
    state.summary = nil
    loadingTask = Task {
        let summary = try await NoteManager.shared(for: notebook).draftSummary()
        try Task.checkCancellation()   // a replacement request may have superseded us
        state.summary = summary
    }
}

func dismiss() {
    loadingTask?.cancel()
}

func observeState() {
    // RENDER — the live draft, straight off the activity the job writes to.
    let draft = NoteActivities.shared(for: notebook).draft
    observations.track { [weak self] in
        self?.previewView.text = draft.text
        self?.previewView.stage = draft.isGenerating ? draft.stage ?? "Generating" : nil
    }
}
```

A cancelled queued job does not start its worker. Running cancellation is cooperative, and conflicting successors still wait for the job's result handling and cleanup to finish — which is why the sheet needs no request identity: the `.draft` write group guarantees the old execution has settled on the activity before the new one begins, and the `checkCancellation` guard is all that protects the final assignment.

<div class="rule">
<span class="rule-label">The rule</span>

A service that catches errors internally must re-throw `CancellationError` rather than mapping it into a domain error — otherwise the caller's `cancel()` has no observable effect. Cancellation is not rollback: a job may already have made a durable write when cancellation arrives. Its result handler must settle activity and publish any committed partial state accurately, but it must never publish success for a failed save or let an old execution overwrite a successor. Finish that settlement before returning from `handleResult`. Check cancellation before starting a write when it is still safe to stop; once a write has committed, publish that change even if cancellation arrived meanwhile.

</div>

Only store the caller's `Task` when cancellation is a real requirement — a view dismissed mid-load, a newer request superseding an older one. A quick fire-and-forget call needs nothing beyond `Task { try? await … }`. And when async work shells out to an external process rather than another `await` chain, cancellation still flows the same way in — it just terminates at a system signal instead of a thrown error, via `withTaskCancellationHandler`'s `onCancel`.

<div class="seealso">
<strong>Ahead in this guide</strong>
How a screen's view state controller owns and cancels its loading `Task` — the consumer side of everything in this chapter — is <a href="/guide/08-2-view-state">Chapter 8.2</a>. Testing async, job-based code through its application behavior is <a href="/guide/10-6-testing-each-layer">Chapter 10.6</a>.
</div>
