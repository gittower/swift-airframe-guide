---
title: "Jobs"
description: "A job is one operation as a value: its intent frozen at submission, its background work performed off the main actor, its result settled on the main actor before the runner lets the next conflicting job start. This subchapter covers why a struct and not a closure, the protocol and its ordering guarantee, why a job carries only its intent and reaches everything else itself, a complete job, the three things a job can do with its result, where a failure is recorded, and the one deadlock to never write."
order: 5
subOrder: 4
---

A job is one operation as a value: its intent frozen at submission, its background work performed off the main actor, its result settled on the main actor before the runner lets the next conflicting job start. This subchapter covers why a struct and not a closure, the protocol and its ordering guarantee, why a job carries only its intent and reaches everything else itself, a complete job, the three things a job can do with its result, where a failure is recorded, and the one deadlock to never write.

## Why a struct and not a closure

A closure captures whatever is in scope. It is easy to grab `self.environment.store` or another main-actor reference by accident, and the compiler lets it through only to fail at runtime or, worse, silently race. A struct forces every input to be declared as a stored property, and `Sendable` conformance makes the compiler check each one.

```swift
// ❌ Closure — reaches main-actor state from the thread pool, and the capture list won't tell you
environment.runner.run {
    let notes = try await client.fetchNotes(in: notebook.id)
    try await self.environment.store.merge(notes)       // compiles, breaks isolation
}

// ✅ Struct — the inputs are declared, the compiler enforces Sendable
struct PullNotesJob: NoteJob {
    let notebookID: NotebookID

    nonisolated func perform() async throws -> [Note] {
        try await SyncClient(config: .shared).fetchNotes(in: notebookID)
    }
}
```

The struct boundary is the point. It describes and enforces the inputs and the result type, so the contract between the manager and the background work is explicit and compiler-checked. It also survives re-entrancy: other main-actor code may run between `await`s, but nothing can mutate a job's `let` properties after it was built.

## The protocol

When work goes through a runner it crosses the actor boundary, and a job has up to three responsibilities in a fixed order: <strong>perform</strong> the background work, off the main actor; optionally <strong>report progress</strong>, delivered on the main actor so the objects that display it need no thread safety; and <strong>finalize</strong>, on the main actor — apply to model state, record what a failure means, publish. The job owns that last step. The manager that enqueued it does not.

```swift
// AirframeFoundation — the job protocol a runner executes
public protocol BackgroundJob: Sendable {
    associatedtype Output: Sendable

    /// Off the main actor.
    nonisolated func perform() async throws -> Output

    /// On the main actor, once per run: with what `perform` returned or threw, or with `CancellationError`
    /// when the job was cancelled before `perform` ran. Defaults to doing nothing.
    @MainActor func finalize(_ result: Result<Output, Error>) async throws

    /// What a runner calls. A requirement rather than an extension-only method, so a generic `enqueue`
    /// dispatches the run lifecycle of a progress-reporting job too.
    nonisolated func execute() async throws -> Output
}
```

App jobs never implement `execute`. What matters is that the runner's reservation covers the whole of it: a conflicting successor waits until `finalize` has applied, recorded and published. That single fact is why a manager can be one line per method — nothing has to happen "after the job returns", because by the time it returns, everything already has. And every enqueued job is finalized exactly once: by `execute` after `perform`, by `execute` with `CancellationError` when the job was cancelled before it ran, or by the enqueue call when the runner skipped the job while it was still queued.

Every job a notebook's managers enqueue belongs to one family, and the family protocol is where the key it works on is declared:

```swift
// NotebookCore/Notes/NoteJob.swift
/// Every job a notebook's managers enqueue. The notebook it works on is part of its intent.
protocol NoteJob: BackgroundJob {
    var notebookID: NotebookID { get }
}
```

<a href="/guide/05-5-runners-and-scheduling">Chapter 5.5</a> adds `TaskAccess` to it once the notebook's runner lets reads overlap, so every notebook job also declares the groups it touches.

## Intent in, everything else reached directly

A job's stored properties are its <strong>intent</strong>, all `let`, frozen at submission: the notebook it works on, a note identifier, a new title, a forced-pull flag. Everything else the job needs, it reaches itself from that intent — a sync client built from the shared config, the storage's background face, the notebook's main-actor store when it finalizes. Nothing is handed to the job besides its intent.

```swift
// NotebookCore/Notes/Jobs/PullNotesJob.swift
struct PullNotesJob: NoteJob, Hashable {
    let notebookID: NotebookID

    nonisolated func perform() async throws -> [Note] {
        let client = SyncClient(config: .shared)            // the network boundary, built where it is used
        let notes = try await client.fetchNotes(in: notebookID)
        try Task.checkCancellation()
        return notes
    }

    @MainActor
    func finalize(_ result: Result<[Note], Error>) async throws {
        try await NoteStore.shared(for: notebookID).merge(result.get())
        Notebook.notesDidChange(in: notebookID)
    }
}
```

`NoteStore.shared(for:)` is the find-only accessor from <a href="/guide/05-2-the-environment">Chapter 5.2</a>: it forwards into the registry and returns the store of a notebook whose environment exists — which it always does by the time one of its jobs finalizes. `Notebook.notesDidChange(in:)` is the notebook's change announcement from <a href="/guide/05-1-the-model">Chapter 5.1</a>; the job never names the notification transport behind it.

Why the job is not handed its dependencies — a "work context" with the client and the storage for `perform`, a "main context" with the store for `finalize`:

- <strong>They turn into bags.</strong> A per-domain context collects every service any job of the family might need. A job's real dependencies are then hidden behind `context.`, and the context has to be built, kept and passed along by the environment and every manager.
- <strong>They hide the hops.</strong> A context method that opens the storage and runs one line of model code is a wrapper around a hop. Written in the job, the hop is visible where it happens, and the model work stays on members that know nothing about threads.
- <strong>The actor boundary doesn't need them.</strong> `perform` is `nonisolated`; `finalize` is `@MainActor`. Anything `perform` touches on the main actor needs an explicit `await`, which is exactly what a reviewer looks for. A job's intent is a `Sendable` value, so the compiler still enforces what crosses.
- <strong>Equality stays meaningful.</strong> With only intent stored, a job is trivially constructible in tests and comparable by value — which is what lets a job be its own coalescing key in <a href="/guide/05-8-execution-strategies">Chapter 5.8</a>. Every `PullNotesJob(notebookID:)` for one notebook equals every other.

Four rules follow:

- <strong>Store intent, not dependencies.</strong> A `let client`, `let store` or `let activities` on a job is a dependency in disguise, and it breaks equality. Store the key the dependency is found by.
- <strong>Read the baseline in `perform`.</strong> Read the current record when the job runs, not when it was submitted, so an edit queued behind another edit sees the earlier one's result, and a delayed edit cannot recreate a deleted note.
- <strong>Name every hop where it happens.</strong> Each step of `perform` names what it talks to — `SyncClient(config: .shared)`, `NoteStorage.shared` — on the line that uses it. No helper that decides for the caller where a step runs (`performInBackground { … }`), and no helper whose whole content is one call for one call site. A resolve helper that takes what the caller names as a parameter is fine; <a href="/guide/05-1-the-model">Chapter 5.1</a> lists the few statics a model type carries.
- <strong>No closures in the intent.</strong> A per-execution callback — "call me when the draft is saved", "send progress to this sheet" — is a smell. Progress goes to an activity through the job's run events (<a href="/guide/05-6-progress-and-activities">Chapter 5.6</a>); results go through `finalize` or the return value.

## A complete job

Here is an edit that preserves changes made by an earlier queued job:

```swift
// NotebookCore/Notes/Jobs/RenameNoteJob.swift
struct RenameNoteJob: NoteJob {
    let notebookID: NotebookID   // intent — `let`, frozen at submission
    let noteID: NoteID
    let title: String

    nonisolated func perform() async throws -> Note {
        // The baseline: the current record when this job runs, after earlier conflicting jobs.
        guard var note = try await NoteStorage.shared.note(id: noteID, in: notebookID) else {
            throw NoteError.notFound
        }
        try Task.checkCancellation()
        note.title = title
        note.modifiedAt = .now
        return note
    }

    @MainActor
    func finalize(_ result: Result<Note, Error>) async throws {
        try await NoteStore.shared(for: notebookID).merge([result.get()])
        Notebook.notesDidChange(in: notebookID)
    }
}
```

Capture the requested title at submission, because that is the user's intent. Fetch the current note inside `perform`, after earlier conflicting jobs have finished, because that is the baseline the edit applies to. Capturing an entire editable note at submission could overwrite an earlier job's changes; checking existence at execution also prevents a delayed edit from recreating a deleted note.

The complete operation includes `finalize`. Keep the save and the announcement there, and await any work they start. Do not move the save after the manager's `enqueue` call returns, or launch an unawaited task to finish it later — the next conflicting job waits for `finalize`, and only for `finalize`. A job that only returns data omits it entirely and keeps the default, empty one.

## What a job does with its result

`RenameNoteJob` shows one of three patterns, and the choice is made per operation. A main-actor `finalize` can await storage that performs the actual I/O in the background; it does not make database work run synchronously on the UI thread.

<div class="table-wrap">
<table>
<thead><tr><th>Pattern</th><th>Job returns</th><th>Who applies</th></tr></thead>
<tbody>
<tr><td><strong>Finalize persists, database merges</strong></td><td>Typed data</td><td><code>finalize</code> writes through the store, then announces only after the save succeeded. The pattern above — the default for persisted state.</td></tr>
<tr><td><strong>Return data to the caller</strong></td><td>Typed data</td><td>The job keeps the default, empty <code>finalize</code>; the manager's <code>async</code> method returns the value directly, and nothing touches model state. For transient data only — <a href="/guide/05-3-the-manager">Chapter 5.3</a> draws that line.</td></tr>
<tr><td><strong>Finalize applies main-actor state</strong></td><td>Typed data</td><td><code>finalize</code> writes the result into in-memory model state on the main thread, through a dedicated apply method on the model, then announces.</td></tr>
</tbody>
</table>
</div>

The third pattern carries its own rule: `finalize` calls a <strong>dedicated `@MainActor` apply method on the model</strong> — never inline mutation buried in the job. The mutation logic stays testable and co-located with the state it modifies, and there is exactly one place to look when asking "what can change this?" `LoadTagIndexJob` in <a href="/guide/05-7-model-shapes">Chapter 5.7</a> shows both ends: the job's `finalize` and the apply method it calls. The apply runs inside `finalize`; no extra actor hop or manager callback is needed.

Some operations also need intermediate persistence in `perform` — writing a suggestion to disk before `finalize` appends it to memory, saving a user's prompt before generating the answer. Publish a committed write even if the rest of the job later fails or is cancelled: `finalize` must never announce success for a failure, and once a write has committed it announces that write even if cancellation arrived meanwhile. Cancellation does not undo earlier saves; <a href="/guide/05-9-cancellation">Chapter 5.9</a> covers what a cancelled job may leave behind.

## Recording a failure

`finalize` receives failures too, and it is where a failure's consequences are recorded: the account marked signed out after the server rejected the session, a suggestion marked failed after the assistant gave up. `perform` throws the original error. It does not catch it to record something and rethrow it wrapped in a job-specific error type — `finalize` does the recording on the main actor and announces when that changed something, and the caller sees the error `perform` threw:

```swift
// PullNotesJob's finalize, with the failure that has a consequence
@MainActor
func finalize(_ result: Result<[Note], Error>) async throws {
    switch result {
    case .success(let notes):
        try await NoteStore.shared(for: notebookID).merge(notes)
        Notebook.notesDidChange(in: notebookID)
    case .failure(SyncError.sessionExpired):
        if SyncStore.shared.markSessionExpired() {      // true when it changed something
            SyncStore.statusDidChange()
        }
    case .failure:
        break
    }
}
```

The error still reaches the caller: `execute` returns `result.get()` after `finalize` has run, so the Action that started the pull sees `SyncError.sessionExpired` and can offer to sign in again, while every other window learns that the sync status changed from the announcement.

<div class="rule">
<span class="rule-label">The rule</span>

Do not enqueue and await another conflicting job from inside `perform` or `finalize`: that job would wait for the operation awaiting it, and the runner cannot tell. Compose related steps inside one job. The same deadlock is why a manager never calls another manager on the same runner.

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
<tr><td>Work dispatched through the environment's runner</td><td>A <code>NoteJob</code> struct: intent as <code>let</code>, <code>perform</code>, <code>finalize</code></td></tr>
<tr><td>…whose run should be visible</td><td><code>ProgressReportingJob</code>, its activity changed in <code>handle</code> — <a href="/guide/05-6-progress-and-activities">Chapter 5.6</a></td></tr>
<tr><td>Async work with no shared resource, no runner</td><td><code>@MainActor</code> command struct</td></tr>
<tr><td>One or two inputs, no composition</td><td>A static function</td></tr>
</tbody>
</table>
</div>

## Red flags

- A job storing a dependency — a client, a store, an activity — instead of the key it is found by.
- A job storing a run or activity ID. The run ID comes from the runner, per run.
- `perform` reaching main-actor state through `await MainActor.run` instead of returning the data for `finalize`.
- `perform` catching an error to record its consequences and rethrowing it wrapped. Record it in `finalize` and let the original error through.
- A hop helper that decides for the caller where a step runs, or that wraps one call for one call site.
- A job reporting its own "started" progress event, or settling its activity in `finalize`. The runner delivers the start and the end to `handle`.
- A closure passed to the job so one caller can receive progress — use an activity.
- A job capturing an editable record at submission instead of reading its baseline in `perform`.
- Finalization done by the manager after the job returns — it belongs in `finalize`, inside the reservation.
- A command struct that captures `self` or a mutable reference instead of snapshotting values at init.

<div class="seealso">
<strong>Ahead in this chapter</strong>
What the runner actually guarantees, and how to let independent work overlap without giving that up, is next: <a href="/guide/05-5-runners-and-scheduling">Chapter 5.5, Runners and Scheduling</a>.
</div>
