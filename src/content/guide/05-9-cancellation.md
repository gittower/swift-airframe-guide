---
title: "Cancellation"
description: "A caller cancels the Task it created around an async call, and the rest follows: through the manager's bridge, into the runner, into the job, down to the network request or the external process. This subchapter covers that one handle, what a cancelled job may and may not leave behind, the three scopes of cancellation, how it reaches a subprocess, how it meets each execution strategy, and when it is not worth wiring at all."
order: 5
subOrder: 9
---

A caller cancels the `Task` it created around an `async` call, and the rest follows: through the manager's bridge, into the runner, into the job, down to the network request or the external process. This subchapter covers that one handle, what a cancelled job may and may not leave behind, the three scopes of cancellation, how it reaches a subprocess, how it meets each execution strategy, and when it is not worth wiring at all.

## The caller owns the task

When non-async code — a button action, a view controller lifecycle method — invokes an `async` method, it creates a `Task`. That task is the cancellation handle. Managers do not return cancellation tokens, and jobs do not expose one: Swift concurrency propagates cancellation through the entire `await` chain on its own.

```swift
// In the preview sheet's view controller — the consumer of draftSummary() from Chapter 5.6
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
```

Only store the task when cancellation is a real requirement — a view dismissed mid-load, a newer request superseding an older one. A quick fire-and-forget call needs nothing beyond `Task { try? await … }`. An Action, per <a href="/guide/06-1-actions">Chapter 6.1</a>, owns its task the same way and exposes `cancel()` to the UI; a view state controller owns its `loadTask` the same way, per <a href="/guide/07-2-view-state">Chapter 7.2</a>.

## One handle, end to end

The manager's `awaitCancellable` bridge from <a href="/guide/05-3-the-manager">Chapter 5.3</a> is what turns the caller's task into the one handle for queued work: it awaits the runner's task under a cancellation handler that cancels it. Here is what `dismiss()` above actually does while a draft is being generated:

1. `loadingTask.cancel()` sets the flag on the caller's task.
1. The bridge's `onCancel` fires and cancels the runner's task for `DraftSummaryJob`.
1. If the job is still queued behind a conflicting write, the runner's `checkCancellation` bails before `execute` ever runs. The job never started and never touched its activity, so there is nothing to settle.
1. If the job is running, cancellation reaches the `await` inside `perform` — the assistant client's streaming request throws `CancellationError` — and `execute` catches it as the result.
1. `finalize` runs on the main actor with that failure, calls `finish()` on the activity, and rethrows.
1. The error unwinds through the bridge into the caller's task, whose `checkCancellation` after the await was never reached anyway.
1. The runner moves on to the next queued job. Cancelling one job never breaks the queue.

Nothing in that list needed a special API on the manager, the job or the client. The chain exists because every link awaited the next one.

## Two things every link must do

<strong>Never swallow `CancellationError`.</strong> A client that catches errors internally must re-throw cancellation rather than mapping it into a domain error — otherwise the caller's `cancel()` has no observable effect, and the operation reports a failure that never happened.

```swift
// ❌ Loses cancellation
func fetchNotes(in notebookID: NotebookID) async throws -> [Note] {
    do {
        return try await decode(session.data(for: request))
    } catch {
        throw SyncError.networkFailure     // CancellationError is gone
    }
}

// ✅ Preserves it
func fetchNotes(in notebookID: NotebookID) async throws -> [Note] {
    do {
        return try await decode(session.data(for: request))
    } catch is CancellationError {
        throw CancellationError()
    } catch {
        throw SyncError.networkFailure
    }
}
```

A domain-specific cancelled case — `SyncError.cancelled` — is fine as long as it propagates and the job's handler recognises it. What matters is that the caller learns the operation was cancelled, not that it "failed".

<strong>Check cancellation before writing state.</strong> After an `await`, before a result lands in state, check whether the task was cancelled. This is the `checkCancellation` line in every cancel-and-replace example in <a href="/guide/05-8-execution-strategies">Chapter 5.8</a>, and it is what keeps a superseded request from overwriting its replacement's result. Inside a job the same check sits between meaningful steps of `perform`, so work stops where it is still safe to stop.

## Cancellation is not rollback

<div class="rule">
<span class="rule-label">The rule</span>

A job may already have made a durable write when cancellation arrives. Its result handler must settle its activity and publish any committed partial state accurately, but it must never publish success for a failed save, and never let an old execution overwrite a successor's. Check cancellation before starting a write while it is still safe to stop; once a write has committed, publish that change even if cancellation arrived meanwhile. Finish that settlement before returning from `finalize`.

</div>

The design's biggest win is that for a job whose only write is in its handler, cancellation is atomic: `perform` throws, `result.get()` in the handler throws, and the store is never touched. The rule above is for jobs that persist along the way — a suggestion file written before the pipeline finished, a prompt saved before the answer streamed. Those writes are real and stay real; what the handler reports has to match what is on disk.

## Three scopes

<strong>One operation.</strong> The caller's own task, as above. This is the scope almost everything uses.

<strong>Everything in flight for one notebook.</strong> There is no back door to the runner for this — the environment that owns it is invisible outside the model package, per <a href="/guide/05-2-the-environment">Chapter 5.2</a>. Instead the owners of the tasks cancel them, which is the same rule applied at scale. Every Action declares a scope, and the Action manager from <a href="/guide/06-1-actions">Chapter 6.1</a> enumerates running Actions, so "cancel everything on this notebook" is one call there: cancel every Action whose scope is the notebook. A background controller cancels the tasks it stored. Each cancelled caller's task reaches its own job through the bridge, queued jobs never start, running jobs settle their activities, and the runner moves on. Reach for this on an event that invalidates every pending operation at once — signing out of the account the notebook syncs with.

<strong>Replace in flight, by key.</strong> When one controller drives the same operation for several keys, track the tasks by key and cancel the previous one for that key when a new one starts. The controller is the boundary that creates and stores the tasks, because the manager method is `async` and returns nothing to hold:

```swift
// In the sidebar's view state controller — refreshing whichever notebook the user just expanded
private var refreshTasks: [NotebookID: Task<Void, Error>] = [:]

func refresh(_ notebook: Notebook) {
    refreshTasks[notebook.id]?.cancel()
    refreshTasks[notebook.id] = Task { [weak self] in
        defer { self?.refreshTasks[notebook.id] = nil }
        try await TagManager.shared(for: notebook).rebuildIndex()
    }
}
```

## Reaching an external process

When a job shells out to a `Process` — exporting a notebook through an external converter, say — cancellation still flows in the same way; it just terminates at a signal instead of a thrown error. `withTaskCancellationHandler`'s `onCancel` is the hook:

```swift
// Packages/NotebookExport/ExportProcess.swift — a library below the model, Chapter 1.1
struct ExportProcess: Sendable {
    let executableURL: URL

    func run(_ arguments: [String]) async throws -> Data {
        let process = Process()
        process.executableURL = executableURL
        process.arguments = arguments
        let output = Pipe()
        process.standardOutput = output

        return try await withTaskCancellationHandler {
            try Task.checkCancellation()                       // cancelled before launch: never start it
            return try await withCheckedThrowingContinuation { continuation in
                process.terminationHandler = { finished in
                    if finished.terminationReason == .uncaughtSignal {
                        continuation.resume(throwing: CancellationError())
                        return
                    }
                    let data = (try? output.fileHandleForReading.readToEnd()) ?? Data()
                    continuation.resume(returning: data)
                }
                do { try process.run() } catch { continuation.resume(throwing: error) }
            }
        } onCancel: {
            process.terminate()                                // SIGTERM
        }
    }
}
```

The termination handler maps a signal death to `CancellationError`, so the job above it sees exactly what it would have seen from a cancelled network request. If the tool ignores SIGTERM, layer SIGKILL behind a short grace period inside `onCancel`. Subprocesses are in fact the easy case: the kernel's signal is the cancellation primitive, and forwarding it is one line. A library called in-process has to cooperate instead, polling `Task.isCancelled` between its own steps — which is why a long-running job checks cancellation between meaningful steps of `perform` rather than only at the top.

## How cancellation meets each strategy

<div class="table-wrap">
<table>
<thead><tr><th>Strategy</th><th>What <code>cancel()</code> does</th></tr></thead>
<tbody>
<tr><td><strong>Cancel-and-replace</strong></td><td>Built in: the previous task is cancelled when a new one starts. The caller never cancels by hand; the <code>checkCancellation</code> before the write is what keeps the superseded result out.</td></tr>
<tr><td><strong>Serial</strong></td><td>Cancels the one caller's job, queued or running. Later jobs in the queue are unaffected and run when their turn comes.</td></tr>
<tr><td><strong>Coalesce</strong></td><td>Does <em>not</em> cancel the shared work — other callers still want it. Coalesced methods await through <code>awaitShared</code>, which has no bridge and checks cancellation after the await instead, so a cancelled caller bails without touching the shared job.</td></tr>
<tr><td><strong>Gate</strong></td><td>Cancels through the outer task like any operation. The <code>defer</code> that re-opens the gate still runs, so the next attempt is allowed.</td></tr>
</tbody>
</table>
</div>

## When cancellation matters

Worth wiring: a view dismissed while loading; a newer request replacing an older one; a long-running operation the user is watching and may abandon.

Not worth it: a fast fire-and-forget call that completes in milliseconds; a mutation that must complete — a save, a decision already written, anything already committed on a server; and an operation where stopping halfway is more dangerous than finishing, which should simply be allowed to finish. The pull in Chapter 5.8's coalescing example is all three of the last kind at once, and that is why it has no bridge.

<div class="seealso">
<strong>Ahead in this guide</strong>
That completes the Model layer. What actually calls into a manager — and how a write earns the overhead of a full Action — is <a href="/guide/06-actions-and-controllers">Chapter 6</a>, next. The view state controller that owns and cancels its loading task, the consumer side of everything above, is <a href="/guide/07-2-view-state">Chapter 7.2</a>; testing async, job-based code through its application behavior is <a href="/guide/09-6-testing-each-layer">Chapter 9.6</a>.
</div>
