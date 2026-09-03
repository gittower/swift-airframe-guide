---
title: "The Model Layer"
description: "The Model is the source of truth, and it stays trustworthy because of one rule applied without exception: every mutation, from every source, funnels through a single manager. This chapter explains why that funnel matters, where the main thread fits, and how to pick the right shape for a given piece of state."
order: 3
---

The Model is the source of truth, and it stays trustworthy because of one rule applied without exception: every mutation, from every source, funnels through a single manager. This chapter explains why that funnel matters, where the main thread fits, and how to pick the right shape for a given piece of state.

## The underlying principle

Views read from the Model. They never write to it directly — every write, whether it originates from a button click, a background sync, or an automated process, converges on the same manager before it touches state.

That convergence is what makes the rest of the architecture possible:

- It doesn't matter <em>where</em> a change came from. Ordering, validation, persistence, and notification all have exactly one place to live, so adding a new source of mutation never reopens those questions.
- Views can stay naive. They read current state, render it, and react to change notifications — they never need to reason about who else might be writing at the same time.

A manager always exists, even when it looks trivial. Sometimes it's a dedicated class; sometimes the model class acts as its own manager, when the mutation logic is simple enough that a wrapper would add nothing — a settings object's own setters, as in <a href="/guide/02-initializing">Chapter 2</a>, <em>are</em> the funnel.

<div class="rule">
<span class="rule-label">The rule</span>

The Model layer is always <strong>entered</strong> from the main thread. When work has to cross onto a background thread, it goes one of three ways: as a `Sendable` value snapshot the background work can't affect the main thread through; as a stable identifier a background context re-fetches its own copy from; or as a request the background work makes <em>of</em> the main thread via `await`, never touching main-actor state directly. The background work always returns a value; the manager is what applies it, on the main thread.

</div>

## Choosing a shape

Not every piece of state needs the same machinery. Six axes decide the shape: does it persist, does it load or mutate in the background, does the whole collection get replaced at once or do individual entries change, and how long does it live. Most of a model's design falls out of answering those questions rather than being decided from scratch.

<div class="table-wrap">
<table>
<thead><tr><th>Shape</th><th>Persists?</th><th>Background work</th><th>Use when</th></tr></thead>
<tbody>
<tr><td><strong>Synced, database-backed</strong></td><td>Yes</td><td>Background sync against an external source</td><td>State mirrors something outside the app — a server, another process — and must survive relaunch.</td></tr>
<tr><td><strong>Persisted, main-thread only</strong></td><td>Yes</td><td>None</td><td>User-edited records with no external sync — small, infrequent, main-thread writes are enough.</td></tr>
<tr><td><strong>Structured + async sources</strong></td><td>Yes (flat files)</td><td>Yes, mixed sources</td><td>Multiple asynchronous writers — a user and a background pipeline both append to the same collection.</td></tr>
<tr><td><strong>In-memory, replaced wholesale</strong></td><td>No</td><td>Load only</td><td>Data reloaded fresh each session, not user-editable in place.</td></tr>
<tr><td><strong>Preference-backed settings</strong></td><td>Yes (key-value)</td><td>None</td><td>User preferences — see <a href="/guide/02-initializing">Chapter 2</a>.</td></tr>
<tr><td><strong>In-memory app state</strong></td><td>No</td><td>None</td><td>Transient flags with no persistence and no cross-source coordination.</td></tr>
</tbody>
</table>
</div>

Two deep dives below cover the two ends of that spectrum — a synced, database-backed model, and the settings shape already introduced. The others follow the same funnel principle with less machinery.

## Deep dive: synced, database-backed state

Take the notebook app's `Note` type: it's edited locally, synced from a server in the background, and must survive a relaunch. The shape has three parts — a small <strong>context struct</strong> bundling what background jobs need, one <strong>job</strong> per operation, and a <strong>manager</strong> that owns a serial runner and turns public calls into enqueued jobs.

```swift
// The dependencies every job in this family needs. Sendable so it
// can cross from the main actor into background work.
struct SyncContext: Sendable {
    let client: SyncClient
    let store: NoteStore
}
```

```swift
// One job, one operation. Inputs are `let` — frozen at init,
// immune to being mutated mid-flight.
struct PullNotesJob: BackgroundJob {
    let notebookID: NotebookID

    func execute(context: SyncContext) async throws {
        let remote = try await context.client.fetchNotes(in: notebookID)
        try await context.store.merge(remote, into: notebookID)   // writes + notifies
    }
}
```

```swift
@MainActor
final class NoteManager {
    private let runner: SerialTaskRunner
    private let client: SyncClient
    private let store: NoteStore

    init(runner: SerialTaskRunner, client: SyncClient, store: NoteStore) {
        self.runner = runner
        self.client = client
        self.store = store
    }

    @discardableResult
    func pull(notebookID: NotebookID) -> Task<Void, Error> {
        enqueue(PullNotesJob(notebookID: notebookID))
    }

    private func enqueue<J: BackgroundJob>(_ job: J) -> Task<J.Output, Error>
    where J.Context == SyncContext {
        let context = SyncContext(client: client, store: store)
        return runner.run { try await job.execute(context: context) }
    }
}
```

What happens at runtime when a caller does `try await NoteManager.shared.pull(notebookID: id).value`:

1. The manager builds a fresh `SyncContext` and hands the job to the runner, which returns immediately with a `Task`.
1. The runner schedules the job behind whatever else is already queued for this manager, so a pull and a save on the same notebook never interleave.
1. The job runs on the cooperative thread pool, fetches from the network, and asks the store to merge and persist the result.
1. The store's write lands in the database; the database's own change tracking merges it back onto the main context automatically.
1. The store posts a change notification on the main thread. Presentation, still on the read path from <a href="/guide/01-getting-started">Chapter 1</a>, refreshes without knowing a sync ever happened.

The same three-part skeleton — context, job, manager — is what makes cancellation, testing, and multiple sync sources all fall out for free: jobs are plain `Sendable` structs with no shared mutable state, so they're trivial to construct and test in isolation, and cancelling the outer `Task` cascades through every `await` the job made. The runner and job protocol themselves get a full chapter — see <a href="/guide/06-concurrency">Chapter 6</a>.

<div class="rule">
<span class="rule-label">Sub-decision</span>

Within this shape there's a genuine open choice: model entities as immutable structs that get replaced wholesale, or as `@Observable` classes that get mutated in place. Choose classes when identity across a mutation matters — a detail view holding a direct reference to a note should see an in-place edit without re-resolving it. Choose structs when Codable simplicity and value semantics matter more than identity — small entities nobody holds a long-lived reference to.

</div>

## Six cases for signalling a change

However the state is shaped, it has to tell interested views when it changes. The signalling mechanism follows directly from one question: <strong>do you own the source as a plain Swift, main-thread object?</strong>

<div class="table-wrap">
<table>
<thead><tr><th>Source</th><th>Signal</th></tr></thead>
<tbody>
<tr><td>Shared app-wide state, scoped state, an in-memory domain manager, transient loaded data</td><td><code>@Observable</code> — consumers read a property, re-render when it changes.</td></tr>
<tr><td>Database-backed model</td><td>The manager posts a <code>Notification</code> after the write lands; consumers subscribe and re-read.</td></tr>
<tr><td>Platform / framework events</td><td>Subscribe to the framework's own notification directly.</td></tr>
</tbody>
</table>
</div>

When a notification-based source has more than one consumer that wants to observe it reactively, the recipe is to bridge it once: a single handler copies the value into an `@Observable` object that everyone else reads, rather than every consumer subscribing to the raw notification independently.

<div class="seealso">
<strong>Ahead in this guide</strong>
View-side consumption of all three signals — the `observations.track` / `observations.observe` mechanics — is <a href="/guide/07-views">Chapter 7</a>, with the full activation lifecycle in <a href="/guide/08-state-observing">Chapter 8</a>. What actually calls into the manager, and how a write earns the overhead of a full Action, is <a href="/guide/04-actions-and-controllers">Chapter 4</a>, next.
</div>
