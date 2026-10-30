---
title: "Progress and Activities"
description: "A job that takes long enough to watch announces its runs, and what it announces them to is an activity: a row in the app's activity store, keyed by the run, written only from the job's main-actor handle and read by whichever screens care. This subchapter covers the activity store, the progress-reporting job and the run events the runner delivers to it, describing an activity next to the job, batching and coalescing streamed output, giving one screen its own progress without a callback, and the line between an activity and the Action that owns the operation."
order: 5
subOrder: 6
---

A job that takes long enough to watch announces its runs, and what it announces them to is an activity: a row in the app's activity store, keyed by the run, written only from the job's main-actor `handle` and read by whichever screens care. This subchapter covers the activity store, the progress-reporting job and the run events the runner delivers to it, describing an activity next to the job, batching and coalescing streamed output, giving one screen its own progress without a callback, and the line between an activity and the Action that owns the operation.

## The activity store

Progress goes to an <strong>activity</strong>: one row per run of an operation, holding what that run is doing right now. The rows live in one app-wide store. It is not on a notebook's environment, and nothing hands it to a job — like `SyncStore` in <a href="/guide/02-5-object-wiring">Chapter 2.5</a>, it is a plain shared instance that whoever needs it reaches directly:

```swift
// NotebookCore/Activities/ActivityStore.swift
/// Every run worth showing, app-wide. Written only from jobs' main-actor `handle`; screens observe.
@Observable @MainActor
final class ActivityStore {
    static let shared = ActivityStore()

    private(set) var activities: [Activity] = []

    func activities(in notebookID: NotebookID) -> [Activity] {
        activities.filter { $0.notebookID == notebookID }
    }

    func latest(named title: String, in notebookID: NotebookID) -> Activity? {
        activities(in: notebookID).last { $0.title == title }
    }

    func create(id: UUID, title: String, notebookID: NotebookID?) { … }
    func updateProgress(_ id: UUID, progress: ActivityProgress) { … }
    func appendText(_ id: UUID, _ delta: String) { … }
    func markFinished(_ id: UUID, output: String?) { … }
    func markFinished(_ id: UUID, error: Error) { … }
    func markCancelled(_ id: UUID) { … }

    /// What the stale-activity background controller calls — Chapter 4.
    func removeFinished(olderThan age: Duration) { … }
}

// NotebookCore/Activities/Activity.swift
struct Activity: Identifiable {
    enum State: Equatable {
        case running, finished(output: String?), failed(message: String), cancelled
    }

    let id: UUID                       // the run, not the job
    let title: String
    let notebookID: NotebookID?
    var progress: ActivityProgress?
    var text = ""                      // streamed output, appended raw
    var state: State = .running
    var endDate: Date?

    var isFinished: Bool { state != .running }
}

struct ActivityProgress: Equatable {
    var fraction: Double?              // nil while the work can't say how far it is
    var detail: String?
}
```

The store is `@Observable` for the same reason a settings object may be read directly in <a href="/guide/05-1-the-model">Chapter 5.1</a>: nothing ever touches it off the main actor. It is `@MainActor`, a job's `perform` is `nonisolated` and could reach it only through an explicit `await` a reviewer would flag, and the one method that writes it — the job's `handle`, below — runs on the main actor. That is what lets a window's sync badge render with a one-line tracked read of `ActivityStore.shared.activities(in: notebook.id)`, where a plain model value such as `SyncStore.shared.status` in <a href="/guide/07-3-view-controllers">Chapter 7.3</a> needs a notification bridged into tracked state first.

An activity is keyed by the <em>run</em>, and the run ID comes from the runner. A job never stores it: an ID on the job would make every job unequal and stop the coalescing in <a href="/guide/05-8-execution-strategies">Chapter 5.8</a> from ever matching. Callers that share one coalesced run share its ID, so they see one row.

## A job that reports progress

A job whose runs should be visible conforms to `ProgressReportingJob`. The runner then delivers each run's lifecycle to one main-actor method, `handle`, so the job never has to remember to open its activity when the work starts or settle it when the run ends:

```swift
// AirframeFoundation — what a run looks like from the job's side
public enum JobRunEvent<Progress: Sendable, Output: Sendable>: Sendable {
    case started
    case progress(Progress)
    case ended(Result<Output, Error>)
}

public protocol ProgressReportingJob: BackgroundJob {
    associatedtype Progress: Sendable = Never
    nonisolated static var progressDeliveryInterval: Duration { get }                                  // default .zero
    nonisolated static func coalesceProgress(_ previous: Progress, _ next: Progress) -> Progress?      // default nil

    nonisolated func perform(progress: JobProgressReporter<Progress>) async throws -> Output
    @MainActor func handle(_ event: JobRunEvent<Progress, Output>, run: UUID)
}
```

What the runner guarantees:

- <strong>`run` identifies the run, not the job.</strong> It is a fresh `UUID` per run, created by `execute`. Callers that share a coalesced run share its ID and see one start and one end.
- <strong>`.started` is delivered by the runner</strong>, awaited on the main actor after the cancellation check and right before `perform`. It arrives exactly when the work is about to run, never late because of a delivery interval.
- <strong>`.progress` is what `perform` reports</strong>, in reported order, merged by the coalescer where it allows. Every event accepted before `perform` ended is delivered before `finalize` — on failure and cancellation too — and a report after that is dropped, so a late callback cannot revive a settled run.
- <strong>`.ended` comes after `finalize`</strong>, with the result the caller sees — including an error `finalize` threw.
- <strong>Every `.started` gets exactly one `.ended`, and there is no `.ended` without a `.started`.</strong> A job skipped while queued, or cancelled before `perform`, gets no events and no row; it is still finalized once.

Conform on the type's declaration, as with `BackgroundJob`, so the `execute` that delivers the events is the one the runner calls. A job that only wants its runs announced keeps `Progress` at `Never`, implements `perform(progress:)` and ignores the reporter. There is deliberately no default that forwards `perform(progress:)` to `perform()`: the framework already supplies `perform()` for a progress-reporting job — it runs `perform(progress:)` with reporting disabled, which is what a worker-only test calls — and the two defaults together would compile into infinite recursion for a job that implements neither.

## Describing an activity

`handle` is the one place a run's activity changes. Most jobs change it the same way, so the notebook app writes that once, in a protocol of its own, and each job describes its activity with pure static functions next to its type:

```swift
// NotebookCore/Activities/ActivityDescribing.swift
protocol ActivityDescribing: ProgressReportingJob, NoteJob {
    static var activityName: String { get }
    static func activityOutput(for output: Output) -> String?
    static func activityProgress(for progress: Progress) -> ActivityProgress
}

extension ActivityDescribing {
    static func activityOutput(for output: Output) -> String? { nil }

    @MainActor
    func handle(_ event: JobRunEvent<Progress, Output>, run: UUID) {
        let activities = ActivityStore.shared
        switch event {
        case .started:
            activities.create(id: run, title: Self.activityName, notebookID: notebookID)
        case .progress(let progress):
            activities.updateProgress(run, progress: Self.activityProgress(for: progress))
        case .ended(.success(let output)):
            activities.markFinished(run, output: Self.activityOutput(for: output))
        case .ended(.failure(let error)) where error is CancellationError:
            activities.markCancelled(run)
        case .ended(.failure(let error)):
            activities.markFinished(run, error: error)
        }
    }
}

extension ActivityDescribing where Progress == Never {
    static func activityProgress(for progress: Never) -> ActivityProgress { switch progress {} }
}
```

The pull from <a href="/guide/05-4-jobs">Chapter 5.4</a>, now visible. Its worker reports facts — which page it is on, how many notes it is about to hand back — and never display strings; `activityProgress(for:)` maps the facts to a fraction and a description, and lets two steps share one bar:

```swift
// NotebookCore/Notes/Jobs/PullNotesJob.swift — its finalize and its TaskAccess from Chapter 5.5 stay as they were.
struct PullNotesJob: ActivityDescribing, Hashable {
    enum Progress: Sendable {
        case downloading(page: Int, of: Int)
        case saving(count: Int)
    }

    let notebookID: NotebookID

    static let activityName = "Pulling notes"

    static func activityProgress(for progress: Progress) -> ActivityProgress {
        switch progress {
        case .downloading(let page, let pages):
            ActivityProgress(fraction: 0.8 * Double(page) / Double(pages), detail: "Downloading page \(page) of \(pages)")
        case .saving(let count):
            ActivityProgress(fraction: 0.8, detail: "Saving \(count) notes")
        }
    }

    nonisolated func perform(progress: JobProgressReporter<Progress>) async throws -> [Note] {
        let client = SyncClient(config: .shared)
        var notes: [Note] = []
        var page = 1
        var pageCount = 1
        repeat {
            let result = try await client.fetchNotes(in: notebookID, page: page)
            notes += result.notes
            pageCount = result.pageCount
            progress.report(.downloading(page: page, of: pageCount))
            page += 1
            try Task.checkCancellation()
        } while page <= pageCount
        progress.report(.saving(count: notes.count))
        return notes
    }
}
```

The worker only calls `progress.report`. When forwarding a library's own callbacks, preserve their logical order; do not start a separate `Task` per event. A saving count describes progress, not a successful save: the row turns finished only on `.ended(.success)`, which the runner delivers after `finalize` has merged and announced — and on failure the same `.ended` settles the row as failed, without the job doing anything. Views observe the store through the state-observation pattern from <a href="/guide/07-4-state-observing">Chapter 7.4</a>; opening or closing a view does not own the underlying operation.

Progress reporting is main-actor only on purpose. The objects that display progress live on the main actor and nowhere else, so delivering every event there means neither they nor the store need to be thread-safe. The same reasoning puts result handling there: the work comes back to the main actor once, and everything that happens to it — the save, the announcement, the row — happens where its consumers are.

## Controlling frequent updates

For streaming output, choose a delivery interval and merge only events that are safe to combine. Both are optional static members on the job; by default the interval is zero and events are not coalesced.

```swift
// In DraftSummaryJob: ProgressReportingJob — streams a notebook summary from the assistant
enum Progress: Sendable, Equatable {
    case text(String)
    case stage(String)
}

static let progressDeliveryInterval: Duration = .milliseconds(50)

nonisolated static func coalesceProgress(_ previous: Progress, _ next: Progress) -> Progress? {
    guard case .text(let first) = previous, case .text(let second) = next else { return nil }
    return .text(first + second)
}
```

The interval batches delivery; it does not discard events. The coalescer combines adjacent pending text deltas in order — `"Hello"` followed by `" world"` becomes `"Hello world"` — and returning `nil` preserves both events, so a stage change remains a boundary. The coalescer must be a pure value merge with no UI or other side effects; it runs under the transport's lock. Append raw text in `handle`; transform it for display after accumulation, so chunk boundaries cannot alter the content. The coalescer is also a small, directly testable function — <a href="/guide/09-6-testing-each-layer">Chapter 9.6</a> shows the assertions that pin it.

## Progress for one screen

A preview sheet generating a draft has a different lifetime from shared sync, and it is tempting to hand the job a closure so only that sheet hears about it. Don't: a closure in the intent is the smell <a href="/guide/05-4-jobs">Chapter 5.4</a> names. The draft's run gets a row like any other, and the sheet reads that row. `DraftSummaryJob` writes its own `handle` instead of taking the default, because its progress is text to append rather than a fraction to show:

```swift
// NotebookCore/Notes/Jobs/DraftSummaryJob.swift — Progress, the interval and the coalescer as above
struct DraftSummaryJob: ProgressReportingJob, NoteJob {
    let notebookID: NotebookID

    static let activityName = "Drafting summary"

    var groups: Set<NoteJobGroup> { [.draft] }
    let access: TaskAccessMode = .write

    nonisolated func perform(progress: JobProgressReporter<Progress>) async throws -> String {
        let notes = try await NoteStorage.shared.notes(in: notebookID)
        progress.report(.stage("Reading \(notes.count) notes"))
        var draft = ""
        for try await delta in AssistantClient(config: .shared).summarize(notes) {
            progress.report(.text(delta))
            draft += delta
        }
        return draft
    }

    @MainActor
    func handle(_ event: JobRunEvent<Progress, String>, run: UUID) {
        let activities = ActivityStore.shared
        switch event {
        case .started:
            activities.create(id: run, title: Self.activityName, notebookID: notebookID)
        case .progress(.text(let delta)):
            activities.appendText(run, delta)
        case .progress(.stage(let stage)):
            activities.updateProgress(run, progress: ActivityProgress(fraction: nil, detail: stage))
        case .ended(.success):
            activities.markFinished(run, output: nil)
        case .ended(.failure(let error)) where error is CancellationError:
            activities.markCancelled(run)
        case .ended(.failure(let error)):
            activities.markFinished(run, error: error)
        }
    }
}
```

The manager's public method still returns the actual draft, because the draft is transient data for whoever asked:

```swift
// In NoteManager:
func draftSummary() async throws -> String {
    try await enqueue(DraftSummaryJob(notebookID: environment.notebook.id))
}
```

Declaring `.draft` as a <em>write</em> group is what keeps the sheet's view coherent: a second request queues behind the first; a cancelled queued request never starts, so it never gets a row; and a cancelled running one settles — its accepted progress delivered, its `.ended` marking the row cancelled — before the next run's `.started` creates a fresh row. The sheet always reads the newest draft row of its notebook and observes a clean sequence without any request bookkeeping. Adopting and saving the draft is a separate operation.

The sheet's view controller reads the row like any other state, and owns the request through the task it created around the manager call — the consumer side that <a href="/guide/05-9-cancellation">Chapter 5.9</a> completes:

```swift
// In the preview sheet's view controller:
func observeState() {
    // RENDER — the live draft, straight off the row the job's handle writes.
    observations.track { [weak self] in
        guard let self else { return }
        let draft = ActivityStore.shared.latest(named: DraftSummaryJob.activityName, in: notebook.id)
        previewView.text = draft?.text ?? ""
        previewView.stage = draft?.state == .running ? draft?.progress?.detail ?? "Generating" : nil
    }
}
```

## Two layers of in-flight state

An activity is progress state. It is not the operation. The Action from <a href="/guide/06-1-actions">Chapter 6.1</a> — or the view controller's task, or the background controller that fired on a timer — owns execution and cancellation; the activity only says what is happening right now, for anyone who cares to look. An Action's own `status` already drives the progress window of the gesture that started it. Activities exist for the consumers that <em>aren't</em> that Action: a sync badge in every window, a row indicating its note is being summarised, an activity list of everything in flight.

So the default is not to make a job visible. Conform to `ProgressReportingJob` when a non-Action consumer needs to observe an operation's runs, and never grow per-manager `isPullRunning` flags in its place — <a href="/guide/05-3-the-manager">Chapter 5.3</a>.

<div class="rule">
<span class="rule-label">The rule</span>

Progress is typed facts, reported by the worker and delivered on the main actor in order, every accepted event before the result. The runner delivers each run's start and end to the job's `handle`, the one place its activity changes: a job never reports its own start and never settles its activity in `finalize`. Activities live in the app's activity store, keyed by the run, which the runner owns and the job never stores. No closure ever carries progress to one caller; a screen that wants progress for itself observes its row.

</div>

<div class="seealso">
<strong>Ahead in this chapter</strong>
With the machinery in place, the catalog of what to build with it — six shapes a piece of state can take, with a notebook example for each — is next: <a href="/guide/05-7-model-shapes">Chapter 5.7, Model Shapes</a>.
</div>
