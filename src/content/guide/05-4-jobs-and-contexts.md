---
title: "Jobs and Contexts"
description: "A job is one operation as a value: its intent frozen at submission, its background work confined to a work context, its result settled on the main actor against a main context. This subchapter covers why a struct and not a closure, the protocol and its ordering guarantee, the two contexts and why they are two types, a complete job, the three things a job can do with its result, and the one deadlock to never write."
order: 5
subOrder: 4
---

A job is one operation as a value: its intent frozen at submission, its background work confined to a work context, its result settled on the main actor against a main context. This subchapter covers why a struct and not a closure, the protocol and its ordering guarantee, the two contexts and why they are two types, a complete job, the three things a job can do with its result, and the one deadlock to never write.

## Why a struct and not a closure

A closure captures whatever is in scope. It is easy to grab `self.environment.store` or another main-actor reference by accident, and the compiler lets it through only to fail at runtime or, worse, silently race. A struct forces every input to be declared as a stored property, and `Sendable` conformance makes the compiler check each one.

```swift
// ❌ Closure — reaches main-actor state from the thread pool, and the capture list won't tell you
environment.runner.run {
    let notes = try await client.fetchNotes(in: notebook.id)
    try await self.environment.store.merge(notes)       // compiles, breaks isolation
}

// ✅ Struct — the inputs are declared, the compiler enforces Sendable, the store is unreachable
struct PullNotesJob: BackgroundJob {
    nonisolated func perform(context: NoteWorkContext) async throws -> [Note] {
        try await context.client.fetchNotes(in: context.notebookID)
    }
}
```

The struct boundary is the point. It describes and enforces the inputs and the result type, so the contract between the manager and the background work is explicit and compiler-checked. It also survives re-entrancy: other main-actor code may run between `await`s, but nothing can mutate a job's `let` properties after it was built.

## The protocol

When work goes through a runner it crosses the actor boundary, and a job has three responsibilities in a fixed order: <strong>perform</strong> the background work, off the main actor, confined to what its work context provides; optionally <strong>report progress</strong>, delivered on the main actor; and <strong>finalize</strong>, on the main actor — save, apply to model state, post the notification, settle an activity. The job owns that last step. The manager that enqueued it does not.

```swift
// Packages/Concurrency — the job protocol the runner executes
protocol BackgroundJob: Sendable {
    associatedtype WorkContext: Sendable
    associatedtype MainContext = Void
    associatedtype Output: Sendable

    /// Off the main actor. Sees only the work context.
    nonisolated func perform(context: WorkContext) async throws -> Output

    /// On the main actor, after `perform` has returned or thrown. Sees only the main context.
    @MainActor func finalize(_ result: Result<Output, Error>, context: MainContext) async throws

    /// What the manager's runner closure calls. A requirement rather than an extension-only method,
    /// so a generic `enqueue` dispatches a progress-reporting job's extra lifecycle too.
    nonisolated func execute(work: WorkContext, main: MainContext) async throws -> Output
}

extension BackgroundJob {
    nonisolated func execute(work: WorkContext, main: MainContext) async throws -> Output {
        let result: Result<Output, Error>
        do {
            try Task.checkCancellation()
            result = .success(try await perform(context: work))
        } catch {
            result = .failure(error)
        }
        try await finalize(result, context: main)
        return try result.get()
    }

    @MainActor func finalize(_ result: Result<Output, Error>, context: MainContext) {}
}
```

App jobs never implement `execute`. What matters is that the runner's reservation covers the whole of it: a conflicting successor waits until `finalize` has saved, published and settled. That single fact is why a manager can be one line per method — nothing has to happen "after the job returns", because by the time it returns, everything already has.

The name is deliberate. `finalize` says what the phase is <em>for</em> — settling the operation, once, before the runner releases it — where `handleProgress` says what arrives, many times. The two are not symmetric, and their names do not pretend to be.

## Two contexts, and why not one

A job sees two different values on the two sides of the actor boundary, and they are two types so the boundary is enforced rather than hoped for:

```swift
// NotebookCore/Notes/NoteWorkContext.swift
/// Only background-safe dependencies cross into `perform`. No store, no activities, no managers, no closures.
struct NoteWorkContext: Sendable {
    let notebookID: NotebookID
    let storage: NoteStorage          // the database's background face
    let files: NotebookFiles          // the notebook folder, for the file-backed shape in Chapter 5.7
    let client: SyncClient            // the network boundary
    let assistant: AssistantClient    // the summarisation and suggestion boundary

    /// The current record when the job runs — after earlier queued writes, not at submission.
    func requireNote(_ id: NoteID) async throws -> Note {
        guard let note = try await storage.note(id: id, in: notebookID) else { throw NoteError.notFound }
        try Task.checkCancellation()
        return note
    }
}
```

```swift
// NotebookCore/Notes/NoteMainContext.swift
/// What a job's main-actor handlers see: the model to apply to, the activities to settle, the way to publish.
@MainActor
struct NoteMainContext {
    let notebook: Notebook
    let store: NoteStore
    let activities: NoteActivities

    func notesDidChange() { Note.notifications.postDidChange(in: notebook.id) }
    func suggestionsDidChange() { Suggestion.notifications.postDidChange(in: notebook.id) }
}
```

A single struct could hold both, because a `@MainActor` class is `Sendable`. But then `perform` could reach the store and the activities with an explicit `await`, and confinement would be a review convention rather than something the type ensures. Two types make it impossible: the worker physically cannot see a manager, an activity or a notification. The main context is not a "result" context either — progress handlers and the result handler both receive it, and it is a plain, immutable view of the main-actor resources.

Why a context at all, rather than dependencies as stored properties on each job? A job could carry `let client` and `let storage` itself, and structs would still work. What the context buys is the boundary. With instance variables, the set of resources a worker may touch is declared per job, and a job that adds `let activities` to reach a main-actor object off-main is caught by nobody. With a context, that set is declared once per family and the manager's `where J.WorkContext == …` clause is the fence. The job's stored properties are then exactly its <strong>intent</strong>, frozen at submission — a note identifier, a new title — which is what makes jobs trivially constructible in tests and comparable by value.

Four rules hold for both contexts:

- <strong>The environment builds them once</strong>, in its `init`, and every manager hands the same two values to every job. No per-enqueue construction, no factory.
- <strong>No closures on either.</strong> A per-execution callback — "call me when the draft is saved", "send progress to this sheet" — is a smell, because the job already has everything it needs through the context. Progress and acknowledgements go to an activity the interested screen observes; <a href="/guide/05-6-progress-and-activities">Chapter 5.6</a>.
- <strong>Baseline reads live on the work context.</strong> `requireNote` reads the current record when the job runs, not when it was submitted, so an edit queued behind another edit sees the earlier one's result, and a delayed edit cannot recreate a deleted note.
- <strong>One family, one pair.</strong> Each domain declares its own two contexts. A mega-context shared by every domain defeats the compile-time guard and makes job dependencies opaque.

## A complete job

Here is an edit that preserves changes made by an earlier queued job:

```swift
// NotebookCore/Notes/Jobs/RenameNoteJob.swift
struct RenameNoteJob: BackgroundJob {
    let noteID: NoteID          // intent — `let`, frozen at submission
    let title: String

    nonisolated func perform(context: NoteWorkContext) async throws -> Note {
        var note = try await context.requireNote(noteID)   // the current record when this job runs
        note.title = title
        note.modifiedAt = .now
        return note
    }

    @MainActor
    func finalize(_ result: Result<Note, Error>, context: NoteMainContext) async throws {
        try await context.store.merge([result.get()])
        context.notesDidChange()
    }
}
```

Capture the requested title at submission, because that is the user's intent. Fetch the current note inside `perform`, after earlier conflicting jobs have finished, because that is the baseline the edit applies to. Capturing an entire editable note at submission could overwrite an earlier job's changes; checking existence at execution also prevents a delayed edit from recreating a deleted note. That is why the baseline read lives on the work context and not on the job.

The complete operation includes `finalize`. Keep the save and the notification there, and await any work they start. Do not move the save after the manager's `awaitCancellable` call or launch an unawaited task to finish it later — the next conflicting job waits for this handler, and only for this handler. A handler receives failures too; it can settle progress state and rethrow. A job that only returns data omits it entirely and keeps the default, empty one.

## What a job does with its result

`RenameNoteJob` shows one of three patterns, and the choice is made per operation. A main-actor result handler can await storage that performs the actual I/O in the background; it does not make database work run synchronously on the UI thread.

<div class="table-wrap">
<table>
<thead><tr><th>Pattern</th><th>Job returns</th><th>Who applies</th></tr></thead>
<tbody>
<tr><td><strong>Handler persists, database merges</strong></td><td>Typed data</td><td>The main-actor handler writes through the store, then publishes only after the save succeeds. The pattern above — the default for persisted state.</td></tr>
<tr><td><strong>Return data to the caller</strong></td><td>Typed data</td><td>The job keeps the default, empty handler; the manager's <code>async</code> method returns the value directly, and nothing touches model state. For transient data only — <a href="/guide/05-3-the-manager">Chapter 5.3</a> draws that line.</td></tr>
<tr><td><strong>Handler applies main-actor state</strong></td><td>Typed data</td><td>The handler writes the result into in-memory model state on the main thread, through a dedicated apply method on the model.</td></tr>
</tbody>
</table>
</div>

The third pattern carries its own rule: the handler calls a <strong>dedicated `@MainActor` apply method on the model object</strong> — never inline mutation buried in a handler. The mutation logic stays testable and co-located with the state it modifies, and there is exactly one place to look when asking "what can change this?"

```swift
// LoadTagIndexJob's handler — TagManager shares NoteManager's environment, so it shares the same two contexts
@MainActor
func finalize(_ result: Result<[TagCount], Error>, context: NoteMainContext) throws {
    context.notebook.applyTagIndexUpdate(try result.get())
}
```

<a href="/guide/05-7-model-shapes">Chapter 5.7</a> shows the apply method on the other end. The apply runs inside `finalize`; no extra actor hop or manager callback is needed.

Some operations also need intermediate persistence in `perform` — writing a suggestion to disk before the handler appends it to memory, saving a user's prompt before generating the answer. Report a saved acknowledgement only after that write succeeds, and publish the committed change even if the rest of the job later fails or is cancelled. The final result handler still owns completion and any remaining writes; cancellation does not undo earlier saves.

<div class="rule">
<span class="rule-label">The rule</span>

Do not enqueue and await another conflicting job from inside `perform` or `finalize`: that job would wait for the operation awaiting it, and the runner cannot tell. Compose related steps inside one job, using its work context. The same deadlock is why a manager never calls another manager on the same runner.

</div>

## When work doesn't need a runner

Not every piece of async work is a job. Work that never touches a shared resource — shaping a note body for display, resolving the titles a view state controller needs — does not go through the runner, and does not need `Sendable` isolation either. Freeze its inputs in a `@MainActor` struct instead:

```swift
// UI/Screens/NoteDetail — built by the state controller, awaited once
@MainActor
struct RenderNoteWork {
    let body: String
    let knownTitles: [NoteID: String]     // snapshotted on the main actor at init

    func execute() async throws -> AttributedString {
        try await MarkdownRenderer.render(body, resolvingLinks: knownTitles)   // off main
    }
}
```

The struct's own code resumes on the main actor between `await`s; the awaited work runs on the thread pool as usual. Its properties can hold anything that lives on the main actor, and re-entrancy cannot corrupt them because they are `let`. For one or two inputs with nothing to compose, a static function achieves the same isolation. The rule for both: no heavy synchronous work between `await`s — it runs on the main thread.

<div class="table-wrap">
<table>
<thead><tr><th>Scenario</th><th>Shape</th></tr></thead>
<tbody>
<tr><td>Work dispatched through the environment's runner</td><td><code>BackgroundJob</code> struct with the domain's two contexts</td></tr>
<tr><td>…that must show progress</td><td><code>ProgressReportingJob</code> writing to an activity — <a href="/guide/05-6-progress-and-activities">Chapter 5.6</a></td></tr>
<tr><td>Async work with no shared resource, no runner</td><td><code>@MainActor</code> command struct</td></tr>
<tr><td>One or two inputs, no composition</td><td>A static function</td></tr>
</tbody>
</table>
</div>

## Red flags

- A job's `perform` reaching main-actor state — a manager, an activity, a store — instead of working through its work context.
- A job carrying its dependencies as stored properties instead of receiving them through the context.
- A closure stored on the main context, or passed to the job, so one caller can receive progress — use an activity.
- A job capturing an editable record at submission instead of reading its baseline in `perform`.
- Result handling done by the manager after the job returns — it belongs in `finalize`, inside the reservation.
- A command struct that captures `self` or a mutable reference instead of snapshotting values at init.

<div class="seealso">
<strong>Ahead in this chapter</strong>
What the runner actually guarantees, and how to let independent work overlap without giving that up, is next: <a href="/guide/05-5-runners-and-scheduling">Chapter 5.5, Runners and Scheduling</a>.
</div>
