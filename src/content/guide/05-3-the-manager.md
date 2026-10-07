---
title: "The Manager"
description: "A manager is the entry point to the model layer for one group of related operations: it turns public async calls into enqueued jobs on its environment's runner and nothing else. This subchapter covers the one shape every public method takes, the private plumbing underneath it, the compile-time fence on that plumbing, the rule that managers never call each other, and the two things a manager is tempted to keep but must not."
order: 5
subOrder: 3
---

A manager is the entry point to the model layer for one group of related operations: it turns public `async` calls into enqueued jobs on its environment's runner and nothing else. This subchapter covers the one shape every public method takes, the private plumbing underneath it, the compile-time fence on that plumbing, the rule that managers never call each other, and the two things a manager is tempted to keep but must not.

## One shape for every public entry point

A manager's public surface — every method a controller, an Action or a background controller calls — is `async`, returning the actual result. The function completes when the work settles. The <em>caller</em> wraps it in a `Task` if it wants a cancellation handle. No raw `Task` return type, ever, at that boundary.

```swift
// ✅ Public API — plain async, returns the result
func pull() async throws { /* … */ }

// ❌ Public API — synchronous, hands back a raw Task
func pull() -> Task<Void, Error> { /* … */ }

// ❌ The hybrid — worst of both
func pull() async -> Task<Void, Error> { /* … */ }
```

Both banned forms fail for different reasons. The hybrid makes the caller await setup before it even receives a handle, and splits cancellation across two objects — the caller's own task for the setup, the returned task for the work — so neither alone cancels the whole operation. Plain synchronous `-> Task<...>` looks safer but fails the identical way the moment the method needs to `await` anything before it can return a handle, and in the meantime it leaks an implementation detail — there happens to be a queue under here — straight into the public API, handing callers a `Task` whose lifetime they did not design.

The synchronous, `Task`-returning shape <em>is</em> correct in exactly two places: the runner primitive itself, and the manager's own private `enqueue` helper that wraps it. Neither is ever exposed past the manager.

## The class

```swift
// NotebookCore/Notes/NoteManager.swift
@MainActor
final class NoteManager {
    let environment: NotebookEnvironment   // strong — the environment keeps its managers, and they keep it

    init(environment: NotebookEnvironment) {
        self.environment = environment
    }

    func pull() async throws {
        _ = try await awaitCancellable(enqueue(PullNotesJob()))
    }

    func rename(noteID: NoteID, to title: String) async throws {
        _ = try await awaitCancellable(enqueue(RenameNoteJob(noteID: noteID, title: title)))
    }

    func export() async throws -> Data {
        try await awaitCancellable(enqueue(ExportNotebookJob()))
    }

    // MARK: - Private plumbing

    /// Synchronous, hands back a raw `Task` — and stays private for exactly that reason.
    /// Nothing outside the manager ever sees this shape; every public method wraps it below.
    private func enqueue<J: BackgroundJob>(_ job: J) throws -> Task<J.Output, Error>
    where J.WorkContext == NoteWorkContext, J.MainContext == NoteMainContext {
        try Task.checkCancellation()
        let work = environment.workContext, main = environment.mainContext
        return environment.runner.run { try await job.execute(work: work, main: main) }
    }

    /// The bridge from the synchronous primitive to the `async` surface: await the runner's task under
    /// a cancellation handler, so the caller's own task is the one handle for the whole operation.
    private func awaitCancellable<T: Sendable>(_ task: Task<T, Error>) async throws -> T {
        try await withTaskCancellationHandler {
            try await task.value
        } onCancel: {
            task.cancel()
        }
    }
}
```

Three things to notice. Every public method is one line: build the job, enqueue it, await it through the bridge. The manager does nothing with the result — persisting, publishing and settling progress are the job's, inside its main-actor handler, before the runner lets the next conflicting job start. `export` returns the data because its job returns data; `pull` discards a `Void`.

`enqueue` stays `private` on purpose: it is the plumbing the public methods wrap, never something a caller sees. Its two `where` clauses are a compile-time fence — a job whose contexts belong to another domain's family cannot be enqueued here, because the constraint fails. Each domain enforces its own boundary this way, and the `checkCancellation` at the top means a caller cancelled during its own setup never submits at all.

The manager owns nothing but its environment: no stored client, no stored store, no private runner. Two managers in one environment share one queue, so a pull and a tag-index rebuild on the same notebook can never interleave, and neither has to know the other exists. Both the initializer and the `environment` property are internal — the package boundary hides them from the app, so a caller can neither build a second manager nor reach the environment through the one it has.

## Factoring the plumbing

`enqueue` and `awaitCancellable` are boilerplate every manager in a domain repeats verbatim. Once the domain has a second manager — `TagManager` here — move both into a protocol extension keyed on the environment:

```swift
// NotebookCore/Environment/NotebookManaging.swift
@MainActor
protocol NotebookManaging: AnyObject {
    var environment: NotebookEnvironment { get }
}

extension NotebookManaging {
    func enqueue<J: BackgroundJob>(_ job: J) throws -> Task<J.Output, Error>
    where J.WorkContext == NoteWorkContext, J.MainContext == NoteMainContext { /* as above */ }

    func awaitCancellable<T: Sendable>(_ task: Task<T, Error>) async throws -> T { /* as above */ }
}

// Every manager in the notebook's environment conforms and keeps its one-line methods.
// TagManager and SuggestionManager declare the conformance where they are defined — Chapter 5.7.
extension NoteManager: NotebookManaging {}
```

The helpers are internal to the package rather than `private`, which is as far as a protocol extension can hide them — and far enough, since nothing outside `NotebookCore` can name them. <a href="/guide/05-5-runners-and-scheduling">Chapter 5.5</a> replaces `enqueue`'s body once with the grouped form and every manager picks it up.

## Managers never call each other

<div class="rule">
<span class="rule-label">The rule</span>

A manager groups related functions that perform model-layer work. <strong>It never calls another manager.</strong> Composing manager functions is reserved for the layer above — an Action's `main()` awaiting two managers in sequence, as `MoveNoteAction` does in <a href="/guide/06-1-actions">Chapter 6.1</a>, or a background controller calling one on a timer.

</div>

Two reasons. A manager that calls a sibling on the same runner enqueues a conflicting job and waits for it from inside its own reservation — the deadlock <a href="/guide/05-4-jobs-and-contexts">Chapter 5.4</a> forbids for jobs, one level up. And the dependency graph between managers would be invisible at the call site: an Action that unlinks a note through one notebook's manager and links it through another's shows the choreography; a `move` that did both internally hides it. If two managers keep needing the same step, that step is a job both can enqueue, or a function on a library below the model — not a call across managers.

The related line — whether a piece of work is a manager function at all, or the choreography of one user intent that belongs in an Action — is Chapter 6.1's test: would two different Actions reasonably call this from inside their own `main()`? If yes, it is a manager function, even if it makes several calls under the hood. A manager function that posts a user-visible notification, registers undo, or sequences several atomic operations has drifted into Action territory.

## Two things a manager must not keep

<strong>A result it loaded.</strong> Some manager calls do not touch a model entity at all — they fetch a piece of data and hand it back: `export()` above, or `draftSummary()` in <a href="/guide/05-6-progress-and-activities">Chapter 5.6</a>. These are bounded by transience: nothing about the returned value is stored anywhere the model can hand back out again. The moment some other consumer needs to ask for the same answer later — not just once, in response to this call — the data has become state, and state belongs in the model under one of the shapes in <a href="/guide/05-7-model-shapes">Chapter 5.7</a>, read back through a query. A private cache tucked inside a manager to avoid re-fetching is the tell that this line got crossed without actually moving the data where it belongs. The one exception is a read-side manager whose cache holds content-addressed, immutable results — a rendered note body keyed by the content's hash — because that cache can never go stale.

<strong>In-flight flags.</strong> A manager growing `isPullRunning`-style properties is duplicating what the layer above already knows: the Action manager enumerates running Actions, and structured concurrency handles cancellation. Track in-flight state on the model side only when a consumer that is <em>not</em> an Action genuinely needs to query it — a sync badge every window shows, a row annotating notes currently being summarised — and then it lives in the environment's activities, written by jobs' main-actor handlers, not in ad-hoc flags on the manager. Chapter 5.6 builds those.

## Red flags

- A public method returning `Task<...>`, with or without `async` — the one-shape rule above.
- A public method that calls `enqueue` or the runner without going through `awaitCancellable`: the caller's task stops being the one cancellation handle.
- A method that persists or publishes a job's result itself after `awaitCancellable` returns — the next conflicting job has already started by then. That work belongs in the job's `finalize`.
- A manager with its own `static let shared` and a private runner in a domain that has an environment — two queues over one resource.
- A manager calling another manager, or a manager method that reads state, `await`s, and writes state with no strategy chosen — <a href="/guide/05-8-execution-strategies">Chapter 5.8</a>.
- An `enqueue` helper without `where` constraints on both contexts, or one mega-context shared by every domain in the app — either collapses the compile-time family boundary the contexts exist to enforce.

<div class="seealso">
<strong>Ahead in this chapter</strong>
The jobs a manager enqueues — the struct, the two contexts it sees, and what happens to its result — are next: <a href="/guide/05-4-jobs-and-contexts">Chapter 5.4, Jobs and Contexts</a>.
</div>
