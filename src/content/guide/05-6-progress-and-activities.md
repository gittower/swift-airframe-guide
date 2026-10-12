---
title: "Progress and Activities"
description: "A job that takes long enough to watch reports progress, and the thing it reports to is an activity: a small @Observable object the environment owns, written only from a job's main-actor handlers and read by whichever screens care. This subchapter covers the activity, the progress-reporting job, batching and coalescing streamed output, giving one screen its own activity instead of a callback, and the line between an activity and the Action that owns the operation."
order: 5
subOrder: 6
---

A job that takes long enough to watch reports progress, and the thing it reports to is an activity: a small `@Observable` object the environment owns, written only from a job's main-actor handlers and read by whichever screens care. This subchapter covers the activity, the progress-reporting job, batching and coalescing streamed output, giving one screen its own activity instead of a callback, and the line between an activity and the Action that owns the operation.

## Activities

Progress goes to an <strong>activity</strong>: an `@Observable @MainActor` object that holds the live state of one kind of operation. The environment owns every activity for its notebook, in the `activities` collection the main context from <a href="/guide/05-4-jobs-and-contexts">Chapter 5.4</a> already carries, so a job reaches its activity through the context and no manager has to create one before enqueueing:

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

An activity is `@Observable` for the same reason a settings object may be read directly in <a href="/guide/05-1-the-model">Chapter 5.1</a>: nothing ever touches it off the main actor. A job's `perform` cannot see it — the work context does not carry activities — and its handlers run on the main actor. That is what lets a screen render an activity with a one-line tracked read, where a plain model value such as `SyncStore.shared.status` in <a href="/guide/07-3-view-controllers">Chapter 7.3</a> needs a notification bridged into tracked state first.

## A job that reports progress

Conform to `ProgressReportingJob` when a job needs progress. Implement the `perform(context:progress:)` overload and `handleProgress(_:context:)`, and keep the same result handler pattern. The framework supplies the ordinary `perform(context:)` overload with reporting disabled, which is what a worker-only test calls.

```swift
// Packages/Concurrency — the progress extension of the job protocol
protocol ProgressReportingJob: BackgroundJob {
    associatedtype Progress: Sendable
    nonisolated static var progressDeliveryInterval: Duration { get }                                  // default .zero
    nonisolated static func coalesceProgress(_ previous: Progress, _ next: Progress) -> Progress?      // default nil

    nonisolated func perform(context: WorkContext, progress: JobProgressReporter<Progress>) async throws -> Output
    @MainActor func handleProgress(_ progress: Progress, context: MainContext)
}
```

```swift
// NotebookCore/Notes/Jobs/PullNotesJob.swift — the pull from Chapter 5.4, now reporting.
// Its TaskAccess conformance from Chapter 5.5 stays exactly as it was.
struct PullNotesJob: ProgressReportingJob {
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

    @MainActor
    func handleProgress(_ progress: Progress, context: NoteMainContext) {
        switch progress {
        case .started: context.activities.pull.begin()
        case .downloaded(let count): context.activities.pull.updateStage("Saving \(count) notes")
        }
    }

    @MainActor
    func finalize(_ result: Result<[Note], Error>, context: NoteMainContext) async throws {
        let activity = context.activities.pull
        do {
            try await context.store.merge(result.get())
            context.notesDidChange()
            activity.finish(.idle)
        } catch {
            activity.finish(error is CancellationError ? .cancelled : .failed(message: error.localizedDescription))
            throw error
        }
    }
}
```

The worker only calls `progress.report`. Events reach `handleProgress` on the main actor in reported order, and every accepted event is delivered before `finalize`, including on failure or cancellation. Late callbacks after the work has settled cannot revive a finished operation. When forwarding a library's own callbacks, preserve their logical order; do not start a separate `Task` per event.

A downloaded count describes progress, not a successful save. Publish success only after persistence succeeds, and settle the activity on error as well — the handler receives the failure precisely so it can. Views observe the activity through `NoteActivities.shared(for: notebook)` and the state-observation pattern from <a href="/guide/07-4-state-observing">Chapter 7.4</a>; opening or closing a view does not own the underlying operation.

Progress reporting is main-actor only on purpose. The objects that display progress live on the main actor and nowhere else, so delivering every event there means neither they nor the activity need to be thread-safe. The same reasoning puts result handling there: the work comes back to the main actor once, and everything that happens to it — the save, the notification, the activity — happens where its consumers are.

## Controlling frequent updates

For streaming output, choose a delivery interval and merge only events that are safe to combine. Both are optional static members on the job; by default the interval is zero and events are not coalesced.

```swift
// In DraftSummaryJob: ProgressReportingJob — streams a notebook summary from the assistant
enum Progress: Sendable, Equatable {
    case started
    case text(String)
    case stage(String)
}

static let progressDeliveryInterval: Duration = .milliseconds(50)

nonisolated static func coalesceProgress(_ previous: Progress, _ next: Progress) -> Progress? {
    guard case .text(let first) = previous, case .text(let second) = next else { return nil }
    return .text(first + second)
}
```

The interval batches delivery; it does not discard events. The coalescer combines adjacent pending text deltas in order — `"Hello"` followed by `" world"` becomes `"Hello world"` — and returning `nil` preserves both events, so a stage change or a saved-record acknowledgement remains a boundary. The coalescer must be a pure value transformation with no UI or other side effects. Append raw text in `handleProgress`; transform it for display after accumulation, so chunk boundaries cannot alter the content. The coalescer is also a small, directly testable function — <a href="/guide/09-6-testing-each-layer">Chapter 9.6</a> shows the three assertions that pin it.

## Progress for one screen

A preview sheet generating a draft has a different lifetime from shared sync, and it is tempting to hand the job a closure so only that sheet hears about it. Don't: a per-execution callback on the main context is the smell Chapter 5.4 names, and the job already has what it needs. The sheet gets its own activity, `draft`, exactly like `pull`:

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

@MainActor
func handleProgress(_ progress: Progress, context: NoteMainContext) {
    let draft = context.activities.draft
    switch progress {
    case .started: draft.begin()
    case .text(let delta): draft.append(delta)
    case .stage(let value): draft.updateStage(value)
    }
}

@MainActor
func finalize(_ result: Result<String, Error>, context: NoteMainContext) throws {
    context.activities.draft.finish()
    try result.get()
}
```

The manager's public method still returns the actual draft, because the draft is transient data for whoever asked:

```swift
// In NoteManager:
func draftSummary() async throws -> String {
    try await awaitCancellable(enqueue(DraftSummaryJob()))
}
```

Declaring `.draft` as a <em>write</em> group is what keeps that activity coherent: a second request queues behind the first, a cancelled queued request never starts, and a cancelled running one settles — its accepted progress delivered, its handler's `finish()` run — before the next `begin()`. The sheet observes a clean sequence without any request bookkeeping. Adopting and saving the draft is a separate operation.

The sheet's view controller reads the activity like any other state, and owns the request through the task it created around the manager call — the consumer side that <a href="/guide/05-9-cancellation">Chapter 5.9</a> completes:

```swift
// In the preview sheet's view controller:
func observeState() {
    // RENDER — the live draft, straight off the activity the job writes to.
    let draft = NoteActivities.shared(for: notebook).draft
    observations.track { [weak self] in
        self?.previewView.text = draft.text
        self?.previewView.stage = draft.isGenerating ? draft.stage ?? "Generating" : nil
    }
}
```

## Two layers of in-flight state

An activity is progress state. It is not the operation. The Action from <a href="/guide/06-1-actions">Chapter 6.1</a> — or the view controller's task, or the background controller that fired on a timer — owns execution and cancellation; the activity only says what is happening to the notebook right now, for anyone who cares to look. An Action's own `status` already drives the progress window of the gesture that started it. An activity exists for the consumers that <em>aren't</em> that Action: a sync badge in every window, a row indicating its note is being summarised, a debug view of everything in flight.

So the default is not to have one. Add an activity when a non-Action consumer needs to observe an operation's progress, and never grow per-manager `isPullRunning` flags in its place — <a href="/guide/05-3-the-manager">Chapter 5.3</a>.

<div class="rule">
<span class="rule-label">The rule</span>

Progress is typed events, reported by the worker and delivered on the main actor in order, every accepted event before the result. An activity is written only by a job's main-actor handlers and settled in `finalize` on every path — success, failure and cancellation. No closure ever carries progress to one caller; a screen that wants progress for itself observes an activity of its own.

</div>

<div class="seealso">
<strong>Ahead in this chapter</strong>
With the machinery in place, the catalog of what to build with it — six shapes a piece of state can take, with a notebook example for each — is next: <a href="/guide/05-7-model-shapes">Chapter 5.7, Model Shapes</a>.
</div>
