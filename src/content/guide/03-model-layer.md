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

Ordinary display reads skip the manager: query the model directly. A read that must wait for an ongoing write to finish belongs to a coordinated workflow instead; it can go through a manager as a read job, as shown in <a href="/guide/05-concurrency">Chapter 5</a>. For plain lookups, the model exposes static queries:

```swift
// Avoid — the manager has nothing to contribute to a read
NoteManager.shared.note(id: id, in: notebook)

// Prefer — the model reads itself
Note.note(id: id, in: notebook)
```

Whatever the model needs to query — a database context, or a `*Store` for anything else (`NoteStore`) — stays an implementation detail behind the model, never something a caller reaches for directly. The store itself stays generic: `all()`, `find(id:)`, insert and remove — the small set of accessors every query builds on. Filtering logic lives one layer up, in a `Model+Queries.swift` extension, so the store never grows a bespoke method per filter:

```swift
// Note+Queries.swift
extension Note {
    static func note(id: NoteID, in notebook: Notebook) -> Note? {
        notebook.notes.note(id: id)
    }

    static func notes(taggedWith tag: Tag, in notebook: Notebook) -> [Note] {
        notebook.notes.all().filter { $0.tags.contains(tag) }
    }

    static func all(in notebook: Notebook) -> [Note] {
        notebook.notes.all()
    }
}
```

Singular name and return type for a single lookup, plural for a collection; the first argument label names what's being filtered on (`taggedWith:`) rather than a generic `where:`, so the call site reads like the question being asked out loud.

These queries always answer with current state — `Note.all(in: notebook)` recomputes from whatever `notebook.notes` holds right now, never a result cached from an earlier call. That's what makes it safe to just call the query again after a change notification fires, rather than reasoning about whether the old result is still good: nothing about the query itself can be stale. If a particular query is expensive enough to want caching, the cache lives on the store, kept live by the same funnel that writes through it — never as a memo hidden inside the query function, guessing when to invalidate itself.

<div class="rule">
<span class="rule-label">The rule</span>

The Model layer is always <strong>entered</strong> on the main actor. Jobs carry `Sendable` intent and stable identifiers; their work context supplies background-safe dependencies and storage access. Their result handler applies main-actor state and publishes completed writes. Workers never reach back into a manager or view. Progress follows the same boundary through typed events, covered in <a href="/guide/05-concurrency">Chapter 5</a>.

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

Take the notebook app's `Note` type: it's edited locally, synced from a server in the background, and must survive a relaunch. The shape has three parts — narrow <strong>work and result contexts</strong>, one <strong>job</strong> per operation, and a <strong>manager</strong> that owns a serial runner and turns public calls into enqueued jobs.

```swift
// Only background-safe dependencies cross into `perform`.
struct SyncWorkContext: Sendable {
    let client: SyncClient
    let storage: NoteStorage
}
```

```swift
@MainActor
struct SyncResultContext: Sendable {
    let store: NoteStore
    let publishNotesDidChange: @MainActor @Sendable (NotebookID) -> Void
}

// One job, one operation. Intent is `let` — frozen at submission.
struct PullNotesJob: BackgroundJob {
    let notebookID: NotebookID

    nonisolated func perform(context: SyncWorkContext) async throws -> [Note] {
        try await context.client.fetchNotes(in: notebookID)
    }

    @MainActor
    func handleResult(_ result: Result<[Note], Error>, context: SyncResultContext) async throws {
        try await context.store.merge(result.get(), into: notebookID)
        context.publishNotesDidChange(notebookID)
    }
}
```

```swift
@MainActor
final class NoteManager {
    static let shared = NoteManager(runner: SerialTaskRunner(), client: .shared, store: .shared)

    private let runner: SerialTaskRunner
    private let client: SyncClient
    private let store: NoteStore

    // Private — NoteManager builds its own dependencies once, at `shared`.
    // Nothing outside ever constructs one; there's no seam to inject through.
    private init(runner: SerialTaskRunner, client: SyncClient, store: NoteStore) {
        self.runner = runner
        self.client = client
        self.store = store
    }

    func pull(notebookID: NotebookID) async throws {
        _ = try await awaitCancellable(enqueue(PullNotesJob(notebookID: notebookID)))
    }

    // Private plumbing — synchronous, hands back a raw `Task`. Never exposed past
    // this point; every public method bridges it through `awaitCancellable` below.
    private func enqueue<J: BackgroundJob>(_ job: J) throws -> Task<J.Output, Error>
    where J.Context == SyncWorkContext, J.ResultContext == SyncResultContext {
        try Task.checkCancellation()
        let work = SyncWorkContext(client: client, storage: store.storage)
        let result = SyncResultContext(store: store, publishNotesDidChange: { id in
            Note.notifications.postDidChange(in: id)
        })
        return runner.run { try await job.execute(context: work, resultContext: result) }
    }

    private func awaitCancellable<T: Sendable>(_ task: Task<T, Error>) async throws -> T {
        try await withTaskCancellationHandler {
            try await task.value
        } onCancel: {
            task.cancel()
        }
    }
}
```

`pull` is `async`, not a function that hands back a `Task` — that's the only sanctioned shape for a manager's public surface, covered in full in <a href="/guide/05-concurrency">Chapter 5</a>. `enqueue` stays `private` on purpose: it's the plumbing `pull` wraps, never something a caller sees directly. `init` is private for the same reason `shared` is the only way to reach a `SyncStore` or `SyncManager` in <a href="/guide/02-initializing">Chapter 2</a>: this app doesn't wire dependencies through a DI container or an injected initializer — a manager builds its own collaborators once, at its own `shared`, and every caller reaches for that.

What happens at runtime when a caller does `try await NoteManager.shared.pull(notebookID: id)`:

1. `pull` hands the job to `enqueue`, which builds its contexts and returns immediately with a `Task` — then `awaitCancellable` suspends on that task. The caller's own `await` is the one thing waiting; nothing about the queue underneath is visible from outside the manager.
1. The runner schedules the job behind whatever else is already queued for this manager, so a pull and a save on the same notebook never interleave.
1. The job runs on the cooperative thread pool, fetches from the network, and returns its result. Its final handler resumes on the main actor to merge, persist, and publish the change.
1. The store's write lands in the database; the database's own change tracking merges it back onto the main context automatically.
1. Presentation, still on the read path from <a href="/guide/01-getting-started">Chapter 1</a>, refreshes from that main-actor notification without knowing a sync ever happened.

The same three-part skeleton supports multiple sync sources and independently testable jobs. The cancellation bridge forwards the caller's cancellation to queued work; the job and its dependencies must cooperate with it. Keep persistence and publication inside `handleResult`, so the next conflicting job cannot start before they finish. <a href="/guide/05-concurrency">Chapter 5</a> extends this example with grouped scheduling and live progress.

### What happens after the job returns

`PullNotesJob` shows one of three patterns for how a job's result lands, and the choice is made per operation. A main-actor result handler can await storage that performs the actual I/O in the background; it does not make database work run synchronously on the UI thread.

<div class="table-wrap">
<table>
<thead><tr><th>Pattern</th><th>Job returns</th><th>Who applies</th></tr></thead>
<tbody>
<tr><td><strong>Result handler persists, database merges</strong></td><td>Typed data</td><td>The job's main-actor result handler writes through the store, then publishes only after the save succeeds. The pattern above — the default for persisted state.</td></tr>
<tr><td><strong>Return data to the caller</strong></td><td>Typed data</td><td>The manager's <code>async</code> method returns the value directly — no <code>.value</code> to unwrap — and nothing touches model state at all.</td></tr>
<tr><td><strong>Result handler applies main-actor state</strong></td><td>Typed data</td><td>The job's dedicated result handler writes the result into in-memory model state on the main thread.</td></tr>
</tbody>
</table>
</div>

Some operations also need intermediate persistence in `perform`, such as saving a user's prompt before generating a summary. Report a saved acknowledgement only after that write succeeds, and publish the committed change even if generation later fails or is cancelled. The final result handler still owns completion and any remaining writes; cancellation does not undo earlier saves.

The second pattern is bounded by transience: nothing about that returned value is stored anywhere the model can hand back out again. The moment some other consumer needs to ask for the same answer later — not just once, in response to this call — the data has become state, and state belongs in the model layer under one of the shapes from earlier in this chapter, read back through a query like the ones that opened it. A private cache tucked inside the manager to avoid re-fetching is the tell that this line got crossed without actually moving the data where it belongs.

The third pattern carries its own rule: the result handler calls a <strong>dedicated `@MainActor` apply method on the model object</strong> — never inline mutation buried in a runner closure. The mutation logic stays testable and co-located with the state it modifies, and there's exactly one place to look when asking "what can change this?"

```swift
// In LoadTagIndexJob's @MainActor result handler:
@MainActor
func handleResult(_ result: Result<[TagCount], Error>, context: TagIndexResultContext) throws {
    try context.notebook.applyTagIndexUpdate(result.get())
}

// On Notebook — the one place this state mutates
@MainActor
func applyTagIndexUpdate(_ incoming: [TagCount]) {
    let changes = tagIndex.changeset(against: incoming)
    tagIndex.apply(changes)
    if !changes.isEmpty { postTagIndexDidChangeNotification(changes) }
}
```

Here `TagIndexResultContext` is a main-actor context containing the target `notebook`. The apply method runs inside `handleResult`; no extra actor hop or manager callback is needed.

<div class="rule">
<span class="rule-label">Sub-decision</span>

Within this shape there's a genuine open choice: model entities as immutable structs that get replaced wholesale, or as plain reference classes that get mutated in place. Choose classes when identity across a mutation matters — a detail view holding a direct reference to a note should see an in-place edit without re-resolving it. Choose structs when Codable simplicity and value semantics matter more than identity — small entities nobody holds a long-lived reference to. Neither option is `@Observable` — identity preservation is about reference vs. value semantics, not reactivity; the notification below is what tells a consumer to re-read, either way.

</div>

## Six cases for signalling a change

However the state is shaped, it has to tell interested views when it changes. The load-bearing question isn't whether the source happens to be a plain Swift object — it's <strong>whether the state is model layer, or view/window layer</strong>.

<div class="table-wrap">
<table>
<thead><tr><th>Source</th><th>Signal</th></tr></thead>
<tbody>
<tr><td>View/window-owned display or loader state, built by a controller from whatever model data it needs — not the model itself</td><td><code>@Observable</code> — consumers read a property, re-render when it changes. See <a href="/guide/06-views">Chapter 6</a>.</td></tr>
<tr><td>Flat, ambient, app-wide settings or state with no per-view projection to make — the one narrow exception</td><td><code>@Observable</code>, read directly, as in <a href="/guide/02-initializing">Chapter 2</a>.</td></tr>
<tr><td>Any other model-layer state — in-memory domain data or database-backed</td><td>The manager posts a <code>Notification</code> after the write lands; consumers subscribe and re-read.</td></tr>
<tr><td>Platform / framework events</td><td>Subscribe to the framework's own notification directly.</td></tr>
</tbody>
</table>
</div>

A model itself is <code>@Observable</code> only in that one narrow case — a value flat enough that every consumer wants it verbatim, with no shape or subset to decide on. Anything else stays off-limits: binding a view straight to a model couples the view's whole contract to the model (and is a non-starter for a database-backed model to begin with — its runtime-synthesized accessors leave nothing for the Observation macro to rewrite), and a view driven straight off model mutations reacts to every intermediate step of a multi-field change instead of rendering one settled state. The moment a settings-shaped value needs to be derived, combined, or filtered for a particular view, it has graduated to needing its own display object like everything else in the row above it.

There's a mechanical reason underneath that design one, and it's what actually draws the line: `@Observable`'s guarantees only mean something for state that's exclusively touched on the main actor. A settings object like `SyncStore` from <a href="/guide/02-initializing">Chapter 2</a> qualifies because nothing ever writes to it from a background job — every other model-layer shape in this chapter, however trivial it looks today, has background work funneling through its manager, and that's disqualifying even when the model type itself carries a `@MainActor` annotation. The one other place this guide reaches for `@Observable` outside a view is the Action — see <a href="/guide/04-1-actions">Chapter 4.1</a> — for the identical reason: an Action is never constructed or touched off the main actor, full stop.

When a notification-based source has more than one consumer that wants to observe it reactively, the recipe is to bridge it once: a single handler copies the value into an `@Observable` object that everyone else reads, rather than every consumer subscribing to the raw notification independently.

<div class="seealso">
<strong>Ahead in this guide</strong>
View-side consumption of all three signals — the `observations.track` / `observations.observe` mechanics — is <a href="/guide/06-views">Chapter 6</a>, with the full activation lifecycle in <a href="/guide/07-state-observing">Chapter 7</a>. What actually calls into the manager, and how a write earns the overhead of a full Action, is <a href="/guide/04-1-actions">Chapter 4.1</a>, next.
</div>
