---
title: "Concurrency"
description: "Build manager operations with background jobs, declare which work can overlap, and report progress without moving application state off the main actor."
order: 6
---

Managers expose plain `async` operations. Inside a manager, jobs describe the work, runners order it, and progress events keep the UI informed. This chapter extends the notebook example from <a href="/guide/04-model-layer">Chapter 4</a> using those APIs. The framework supplies their execution and delivery machinery.

## Choosing a runner

`@MainActor` protects synchronous access to application state, but another call can run while a method is suspended at an `await`. If a save must finish before the next edit loads its starting state, submit the whole operation through a runner.

Use `SerialTaskRunner` when all operations share one resource and must run one at a time. Use `GroupedTaskRunner` when independent resources can proceed together, or when reads of the same resource may overlap. Managers coordinating access to the same resources must share the same runner instance.

## Writing a job

Conform to `BackgroundJob`, capture intent in immutable properties, and implement `perform(context:)`. When the operation changes model state, implement `handleResult(_:context:)` for persistence and publication on the main actor. Call the supplied `execute(context:resultContext:)` from the manager's runner closure; app jobs do not implement it.

Here is an edit that preserves changes made by an earlier queued job:

```swift
struct RenameNoteJob: BackgroundJob {
    let notebookID: NotebookID
    let noteID: NoteID
    let title: String

    nonisolated func perform(context: SyncWorkContext) async throws -> Note {
        // Load the current record when this job runs, not when it is submitted.
        guard var note = try await context.storage.note(
            id: noteID, in: notebookID
        ) else {
            throw NoteError.notFound
        }
        try Task.checkCancellation()
        note.title = title
        return note
    }

    @MainActor func handleResult(
        _ result: Result<Note, Error>, context: SyncResultContext
    ) async throws {
        let note = try result.get()
        try await context.store.merge([note], into: notebookID)
        context.publishNotesDidChange(notebookID)
    }
}
```

`Note` here is a `Sendable` value, not a managed object passed between database contexts. `SyncWorkContext` and `SyncResultContext` are the app-defined contexts from Chapter 4: the worker gets background-safe libraries and storage; the result handler gets the store and main-actor publication operations.

Capture the requested title and independent configuration before submission. Fetch and validate the current note inside `perform`, after earlier conflicting jobs have finished. Capturing an entire editable note at submission could overwrite an earlier job's changes; checking existence at execution also prevents a delayed edit from recreating a deleted note.

The complete operation includes `handleResult`: the next conflicting job waits until persistence, notifications, and activity updates finish. Keep these steps in the handler, and await any work they start. Do not move the save after the manager's `awaitCancellable` call or launch an unawaited task to finish it later. A result handler receives failures too; it can settle progress state and rethrow. A job that only returns data can omit the handler.

## Letting independent work overlap

Add `TaskAccess` when a job uses a grouped runner. The app defines resource identities and chooses one access mode for all of a job's groups:

```swift
enum NoteJobGroup: Hashable, Sendable {
    case notebook(NotebookID)
    case note(NoteID)
}

extension RenameNoteJob: TaskAccess {
    var groups: Set<NoteJobGroup> {
        [.notebook(notebookID), .note(noteID)]
    }
    var access: TaskAccessMode { .write }
}

// PullNotesJob is defined in Chapter 4.
extension PullNotesJob: TaskAccess {
    var groups: Set<NoteJobGroup> { [.notebook(notebookID)] }
    var access: TaskAccessMode { .write }
}

struct ExportNotebookJob: BackgroundJob, TaskAccess {
    typealias ResultContext = SyncResultContext
    let notebookID: NotebookID
    var groups: Set<NoteJobGroup> { [.notebook(notebookID)] }
    let access: TaskAccessMode = .read

    nonisolated func perform(context: SyncWorkContext) async throws -> Data {
        try await context.storage.exportNotebook(id: notebookID)
    }
    // No model changes: the default result handler is sufficient.
}
```

Two jobs conflict when their groups overlap and at least one is a writer. In this example:

- Two exports of the same notebook can run together.
- A rename or pull waits for earlier exports and writes on that notebook. Later exports wait for that write, even while it is queued.
- Work on another notebook can proceed independently.

Declaring the notebook group on every rename also serializes edits to different notes in that notebook. Choose this when edits must exclude a collection-wide sync. Group names have no implicit hierarchy: a job declaring only `.note(id)` does not conflict with a job declaring only `.notebook(id)`. Include every resource whose access needs coordination. If the operation writes any declared resource, use `.write`.

To adopt this in Chapter 4's manager, change its runner property and construction to `GroupedTaskRunner<NoteJobGroup>`, then replace its enqueue helper with:

```swift
private func enqueue<J: BackgroundJob & TaskAccess>(
    _ job: J,
    cancelling groups: Set<NoteJobGroup> = []
) throws -> Task<J.Output, Error>
where J.Context == SyncWorkContext,
      J.ResultContext == SyncResultContext,
      J.Group == NoteJobGroup {
    try Task.checkCancellation()
    let work = SyncWorkContext(client: client, storage: store.storage)
    let result = SyncResultContext(store: store, publishNotesDidChange: { id in
        Note.notifications.postDidChange(in: id)
    })
    return runner.run(
        groups: job.groups, access: job.access, cancelling: groups
    ) {
        try await job.execute(context: work, resultContext: result)
    }
}

func rename(noteID: NoteID, in notebookID: NotebookID, to title: String) async throws {
    _ = try await awaitCancellable(enqueue(
        RenameNoteJob(notebookID: notebookID, noteID: noteID, title: title)
    ))
}
```

`ExportNotebookJob` names its `ResultContext` to use this helper, even though it does not use that context; without the type alias, a job with no result handler defaults to `Void`. The context and group constraints catch accidental submissions from another job family.

Do not enqueue and await another conflicting job from inside `perform` or `handleResult`: that job would wait for the operation awaiting it. Compose related steps inside one job using its work context.

### Deleting a note with ongoing work

Make deletion a writer for the notebook and note, and request cancellation through the same enqueue call:

```swift
struct DeleteNoteJob: BackgroundJob, TaskAccess {
    let notebookID: NotebookID
    let noteID: NoteID
    var groups: Set<NoteJobGroup> {
        [.notebook(notebookID), .note(noteID)]
    }
    let access: TaskAccessMode = .write

    nonisolated func perform(context: SyncWorkContext) async throws {
        try Task.checkCancellation()
        try await context.storage.deleteNote(id: noteID, in: notebookID)
    }

    @MainActor func handleResult(
        _ result: Result<Void, Error>, context: SyncResultContext
    ) throws {
        try result.get()
        context.publishNotesDidChange(notebookID)
    }
}

// In NoteManager:
func delete(noteID: NoteID, in notebookID: NotebookID) async throws {
    try await awaitCancellable(enqueue(
        DeleteNoteJob(notebookID: notebookID, noteID: noteID),
        cancelling: [.note(noteID)]
    ))
}
```

This cancels existing work declaring that note group and waits for conflicting work to finish before deleting. It also waits for notebook-wide work, such as a pull, without cancelling that broader operation. Later conflicting jobs wait for deletion, then validate that their target still exists. Make deletion remove associated progress state in its result handler if the app keeps any.

The cancellation groups must be a subset of the delete job's groups, and the job must be a writer. Use this combined submission for deletion rather than a separate cancel-then-delete sequence that leaves room for new work between the two calls.

## Adding live progress

Conform directly to `ProgressReportingJob` when a job needs progress. Implement the `perform(context:progress:)` overload and `handleProgress(_:context:)`; keep the same result handler pattern. The framework supplies the ordinary `perform(context:)` overload for calls that do not need live progress.

For a pull with progress, extend Chapter 4's `SyncResultContext` with an `activities: SyncActivities` property and pass the manager's shared activity collection when constructing that context in `enqueue`. This app-defined collection holds stable progress state keyed by notebook. The manager ensures the activity exists before enqueueing; the job updates it once work starts.

```swift
struct PullNotesWithProgressJob: ProgressReportingJob, TaskAccess {
    let notebookID: NotebookID
    var groups: Set<NoteJobGroup> { [.notebook(notebookID)] }
    let access: TaskAccessMode = .write

    enum Progress: Sendable {
        case started
        case downloaded(noteCount: Int)
    }

    nonisolated func perform(
        context: SyncWorkContext, progress: JobProgressReporter<Progress>
    ) async throws -> [Note] {
        progress.report(.started)
        let notes = try await context.client.fetchNotes(in: notebookID)
        try Task.checkCancellation()
        progress.report(.downloaded(noteCount: notes.count))
        return notes
    }

    @MainActor func handleProgress(
        _ progress: Progress, context: SyncResultContext
    ) {
        guard let activity = context.activities.activity(for: notebookID) else { return }
        switch progress {
        case .started: activity.begin()
        case .downloaded(let count): activity.updateStage("Saving \(count) notes")
        }
    }

    @MainActor func handleResult(
        _ result: Result<[Note], Error>, context: SyncResultContext
    ) async throws {
        let activity = context.activities.activity(for: notebookID)
        do {
            try await context.store.merge(result.get(), into: notebookID)
            context.publishNotesDidChange(notebookID)
            activity?.finish(.idle)
        } catch {
            activity?.finish(error is CancellationError
                ? .cancelled : .failed(message: error.localizedDescription))
            throw error
        }
    }
}
```

The worker only calls `progress.report`. Events reach `handleProgress` on the main actor in reported order, and accepted progress is delivered before `handleResult`, including on failure or cancellation. Late callbacks after work ends cannot update a completed operation. Preserve the source's logical order when forwarding library callbacks; do not start a separate `Task` for each event.

A downloaded count describes progress, not a successful save. Publish success only after persistence succeeds, and settle the activity on error as well. Views observe the shared activity through the app's state-observation pattern; opening or closing a view does not own the underlying operation. The activity is progress state, while the calling Action or background controller owns execution and cancellation.

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

### Progress for one caller

A preview sheet generating a draft has a different lifetime from shared sync. Give each invocation its own result context with a main-actor callback:

```swift
@MainActor
struct DraftResultContext: Sendable {
    let onProgress: (@MainActor @Sendable (DraftSummaryJob.Progress) -> Void)?
}

// In DraftSummaryJob:
@MainActor func handleProgress(_ progress: Progress, context: DraftResultContext) {
    context.onProgress?(progress)
}
```

The manager's public method still returns the actual draft:

```swift
func draftSummary(
    notebookID: NotebookID,
    progress: (@MainActor @Sendable (DraftSummaryJob.Progress) -> Void)? = nil
) async throws -> String {
    try Task.checkCancellation()
    let job = DraftSummaryJob(notebookID: notebookID)
    let work = SyncWorkContext(client: client, storage: store.storage)
    let result = DraftResultContext(onProgress: progress)
    let task = runner.run(job) {
        try await job.execute(context: work, resultContext: result)
    }
    return try await awaitCancellable(task)
}
```

Here `DraftSummaryJob` also conforms to `TaskAccess`, declares the notebook group with `.read`, returns a transient `String`, and forwards its summarization client's events through the reporter. Adopting and saving the draft is a separate operation.

Create the result context locally for each request; never store the latest callback on the shared manager. The sheet owns the calling task and cancels it on dismissal or replacement. Guard both its progress callback and its final UI assignment with the current request identity, because already accepted progress can still arrive while cancellation finishes.

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
    private(set) var results: [Note] = []
    private var runningTask: Task<Void, Error>?

    func search(query: String) {
        runningTask?.cancel()
        runningTask = Task {
            let found = try await NoteManager.shared.search(query)
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

A manager's public surface — every method a controller, an Action, or another manager calls — is `async`, returning the actual result. `NoteManager.pull` from <a href="/guide/04-model-layer">Chapter 4</a> is the model: no raw `Task` return type, ever, at that boundary.

```swift
// ✅ Public API — plain async, returns the result
func pull(notebookID: NotebookID) async throws { /* … */ }

// ❌ Public API — synchronous, hands back a raw Task
func pull(notebookID: NotebookID) -> Task<Void, Error> { /* … */ }

// ❌ The hybrid — worst of both
func pull(notebookID: NotebookID) async -> Task<Void, Error> { /* … */ }
```

Both banned forms fail for different reasons. The hybrid makes the caller await setup before it even receives a handle, splitting cancellation across two objects — the caller's own task for the setup, the returned task for the work — and neither alone cancels the whole operation. Plain synchronous `-> Task<...>` looks safer but fails the identical way the moment the method needs to `await` anything before it can return a handle, and in the meantime it leaks an implementation detail — there happens to be a queue under here — straight into the public API.

The runner returns a `Task`, as does the manager's private `enqueue` helper. The manager wraps both behind its `async` operations, so callers never handle the runner task directly.

### Wiring cancellation once

Use Chapter 4's `awaitCancellable` helper around every enqueued operation. It awaits the runner task under a cancellation handler and forwards the caller's cancellation. Check cancellation before submission too, especially after asynchronous setup such as loading configuration.

```swift
// In a @MainActor preview controller:
private var loadingTask: Task<Void, Error>?
private var requestID: UUID?

func loadSummary(for notebookID: NotebookID) {
    loadingTask?.cancel()
    let id = UUID()
    requestID = id
    state.preview = ""
    loadingTask = Task {
        let summary = try await NoteManager.shared.draftSummary(
            notebookID: notebookID,
            progress: { [weak self] event in
                guard let self, self.requestID == id else { return }
                switch event {
                case .started: self.state.stage = "Generating"
                case .text(let text): self.state.preview += text
                case .stage(let text): self.state.stage = text
                }
            }
        )
        try Task.checkCancellation()
        guard requestID == id else { return }
        state.summary = summary
    }
}

func dismiss() {
    requestID = nil
    loadingTask?.cancel()
}
```

A cancelled queued job does not start its worker. Running cancellation is cooperative, and conflicting successors still wait for the job's result handling and cleanup to finish.

<div class="rule">
<span class="rule-label">The rule</span>

A service that catches errors internally must re-throw `CancellationError` rather than mapping it into a domain error — otherwise the caller's `cancel()` has no observable effect. Cancellation is not rollback: a job may already have made a durable write when cancellation arrives. Its result handler must settle activity and publish any committed partial state accurately, but it must never publish success for a failed save or let an old execution overwrite a successor. Finish that settlement before returning from `handleResult`. Check cancellation before starting a write when it is still safe to stop; once a write has committed, publish that change even if cancellation arrived meanwhile.

</div>

Only store the caller's `Task` when cancellation is a real requirement — a view dismissed mid-load, a newer request superseding an older one. A quick fire-and-forget call needs nothing beyond `Task { try? await … }`. And when async work shells out to an external process rather than another `await` chain, cancellation still flows the same way in — it just terminates at a system signal instead of a thrown error, via `withTaskCancellationHandler`'s `onCancel`.

<div class="seealso">
<strong>Ahead in this guide</strong>
How a view's own state object owns and cancels its loading `Task` — the consumer side of everything in this chapter — is <a href="/guide/07-1-views">Chapter 7.1</a>. Testing async, job-based code through its application behavior is <a href="/guide/09-testing">Chapter 9</a>.
</div>
