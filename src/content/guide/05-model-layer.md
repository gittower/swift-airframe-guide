---
title: "The Model Layer"
description: "The Model is the source of truth, and it stays trustworthy because of one rule applied without exception: every mutation, from every source, funnels through a single manager. This chapter explains why that funnel matters, the environment a domain's managers and jobs share, where the main thread fits, and how to pick the right shape for a given piece of state."
order: 5
---

The Model is the source of truth, and it stays trustworthy because of one rule applied without exception: every mutation, from every source, funnels through a single manager. This chapter explains why that funnel matters, the environment a domain's managers and jobs share, where the main thread fits, and how to pick the right shape for a given piece of state.

## The underlying principle

Views read from the Model. They never write to it directly — every write, whether it originates from a button click, a background sync, or an automated process, converges on the same manager before it touches state.

That convergence is what makes the rest of the architecture possible:

- It doesn't matter <em>where</em> a change came from. Ordering, validation, persistence, and notification all have exactly one place to live, so adding a new source of mutation never reopens those questions.
- Views can stay naive. They read current state, render it, and react to change notifications — they never need to reason about who else might be writing at the same time.

A manager always exists, even when it looks trivial. Sometimes it's a dedicated class; sometimes the model class acts as its own manager, when the mutation logic is simple enough that a wrapper would add nothing — a settings object's own setters, as in <a href="/guide/02-4-settings">Chapter 2.4</a>, <em>are</em> the funnel.

Ordinary display reads skip the manager: query the model directly. A read that must wait for an ongoing write to finish belongs to a coordinated workflow instead; it can go through a manager as a read job, as shown in <a href="/guide/07-concurrency">Chapter 7</a>. For plain lookups, the model exposes static queries:

```swift
// Avoid — the manager has nothing to contribute to a read
NoteManager.shared(for: notebook).note(id: id)

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

The Model layer is always <strong>entered</strong> on the main actor. Jobs carry `Sendable` intent and stable identifiers; their work context supplies background-safe dependencies and storage access, and nothing else. Their main-actor handlers apply state, settle progress, and publish completed writes through a main context. Workers never reach back into a manager or view. Progress follows the same boundary through typed events, covered in <a href="/guide/07-concurrency">Chapter 7</a>.

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
<tr><td><strong>Preference-backed settings</strong></td><td>Yes (key-value)</td><td>None</td><td>User preferences — see <a href="/guide/02-4-settings">Chapter 2.4</a>.</td></tr>
<tr><td><strong>In-memory app state</strong></td><td>No</td><td>None</td><td>Transient flags with no persistence and no cross-source coordination.</td></tr>
</tbody>
</table>
</div>

Two deep dives below cover the two ends of that spectrum — a synced, database-backed model, and the settings shape already introduced. The others follow the same funnel principle with less machinery. Before the first deep dive, one object has to exist for any shape with background work behind it: the environment its managers and jobs share.

## The environment

A domain whose managers and jobs share resources — a runner that orders their work, a store they write into, the progress state they report to — has one root object that owns those resources: the domain's <strong>environment</strong>. It exists once per app when the resources are app-wide, and once per <em>key</em> when they aren't. In the notebook app the key is the notebook: every notebook has its own storage, its own queue of pending work, and its own sync progress, so every notebook has its own `NotebookEnvironment`, and the flat accessor from <a href="/guide/02-5-object-wiring">Chapter 2.5</a> takes the key — `NoteManager.shared(for: notebook)`.

Two things an environment is not. It is not a wrapper: a root object that merely holds a config, a store, and a manager and forwards to them is the shape Chapter 2.5 bans, because it adds a layer without adding behavior. An environment earns its place by owning resources that several managers and every job genuinely share. And it is not a worker: it provides, it never performs. The only functions on it manage the objects it holds. A method on the environment that fetches notes or saves one is a manager function in the wrong place.

```swift
// NotebookCore/Environment/NotebookEnvironment.swift
@MainActor
final class NotebookEnvironment {
    let notebook: Notebook
    let runner = SerialTaskRunner()        // one per notebook, shared by every manager in it
    let store: NoteStore                   // the main-actor model the queries above read
    let activities = NoteActivities()      // every progress sink for this notebook — Chapter 7
    let workContext: NoteWorkContext       // what a job's perform() sees — built once
    let mainContext: NoteMainContext       // what its main-actor handlers see — built once

    lazy var noteManager = NoteManager(environment: self)
    lazy var tagManager = TagManager(environment: self)

    // Internal, not private: a test builds one over its own notebook and never touches the registry.
    init(notebook: Notebook, client: SyncClient) {
        self.notebook = notebook
        self.store = notebook.notes
        self.workContext = NoteWorkContext(notebookID: notebook.id, storage: notebook.notes.storage, client: client)
        self.mainContext = NoteMainContext(notebook: notebook, store: notebook.notes, activities: activities)
    }
}
```

The `init` is the one place the notebook's graph is decided: which managers share the runner, what the jobs may see, where the store writes. Managers hold the environment strongly and reach everything through it. Nothing outside constructs a manager — the environment builds its managers and keeps them, which makes the graph a reference cycle by design. That is fine, because an environment is never torn down once created: in production the registry holds it for the life of the process, in a test it lives until the test ends.

The registry and the public surface live in a second file, so the class file is exactly what a test constructs and the extension file is exactly what production reaches:

```swift
// NotebookCore/Environment/NotebookEnvironment+Shared.swift

// MARK: - The production registry, one environment per notebook for the life of the process

extension NotebookEnvironment {
    private static var environments: [NotebookID: NotebookEnvironment] = [:]

    static func shared(for notebook: Notebook) -> NotebookEnvironment {
        if let existing = environments[notebook.id] { return existing }
        let environment = NotebookEnvironment(notebook: notebook, client: SyncClient(config: .shared))
        environments[notebook.id] = environment
        return environment
    }
}

// MARK: - The public surface, one-liners forwarding into the registry

extension NoteManager {
    /// Production: the one manager for this notebook.
    static func shared(for notebook: Notebook) -> NoteManager {
        NotebookEnvironment.shared(for: notebook).noteManager
    }

    /// Standalone: a manager over its own private environment, for tests and tools.
    /// The client is the one external boundary a test swaps; the notebook's store is the other.
    static func standalone(notebook: Notebook, client: SyncClient = SyncClient(config: .shared)) -> NoteManager {
        NotebookEnvironment(notebook: notebook, client: client).noteManager
    }
}

extension TagManager {
    static func shared(for notebook: Notebook) -> TagManager {
        NotebookEnvironment.shared(for: notebook).tagManager
    }
}

extension NoteActivities {
    static func shared(for notebook: Notebook) -> NoteActivities {
        NotebookEnvironment.shared(for: notebook).activities
    }
}
```

`standalone` is a static factory and not a convenience initializer, on purpose. An initializer can only produce a new instance, so the environment's own `noteManager` would be a second write funnel beside it; the factory returns the environment's manager. A test that needs the sibling manager reaches `manager.environment.tagManager` rather than building a second graph — <a href="/guide/10-6-testing-each-layer">Chapter 10.6</a> shows the test side.

App-wide pieces stay plain shared statics. `SyncConfig`, `SyncStore` and `SyncManager` from Chapter 2.5 describe the account — signed in or not, the last sync, the base URL — and there is one account, so they are reached as `.shared`. Only the genuinely per-notebook components go through the environment.

<div class="rule">
<span class="rule-label">The rule</span>

The environment provides; it never performs. It owns the runner, the store, the activities and the two job contexts, builds its managers and keeps them, and exposes nothing that does work. Its `init` is internal and is the only place the domain's graph is decided; its registry lives in an extension and is the only thing production touches.

</div>

## Deep dive: synced, database-backed state

Take the notebook app's `Note` type: it's edited locally, synced from a server in the background, and must survive a relaunch. The shape has three parts — the two <strong>contexts</strong> a job receives, one <strong>job</strong> per operation, and a thin <strong>manager</strong> that turns public calls into enqueued jobs on the environment's runner.

A job sees two different values on the two sides of the actor boundary, and they are two types so the boundary is enforced rather than hoped for:

```swift
// NotebookCore/Notes/NoteWorkContext.swift
/// Only background-safe dependencies cross into `perform`. No store, no activities, no managers.
struct NoteWorkContext: Sendable {
    let notebookID: NotebookID
    let storage: NoteStorage
    let client: SyncClient

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

    func notesDidChange() {
        Note.notifications.postDidChange(in: notebook.id)
    }
}
```

A single struct could hold both, because a `@MainActor` class is `Sendable`. But then `perform` could reach the store and the activities with an explicit `await`, and confinement would be a review convention rather than something the type ensures. Two types make it impossible: the worker physically cannot see a manager, an activity, or a notification. Neither context carries a closure. A per-execution callback — "call me when the question is saved", "send progress to this sheet" — is a smell, because the job already has everything it needs through the context; progress goes to an activity in `activities`, and the interested screen observes that. Both values are built once, in the environment's `init`.

```swift
// NotebookCore/Notes/Jobs/PullNotesJob.swift
/// One job, one operation. Intent is `let` — frozen at submission. This one has none:
/// the notebook comes from the context, and a pull takes no other input.
struct PullNotesJob: BackgroundJob {
    nonisolated func perform(context: NoteWorkContext) async throws -> [Note] {
        try await context.client.fetchNotes(in: context.notebookID)
    }

    @MainActor
    func handleResult(_ result: Result<[Note], Error>, context: NoteMainContext) async throws {
        try await context.store.merge(result.get())
        context.notesDidChange()
    }
}
```

The job owns its whole lifecycle: the background work in `perform`, and what happens to the result in `handleResult`, on the main actor, before the runner lets the next conflicting job start. The manager that enqueued it does nothing with the result.

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

    // Private plumbing — synchronous, hands back a raw `Task`. Never exposed past
    // this point; every public method bridges it through `awaitCancellable` below.
    private func enqueue<J: BackgroundJob>(_ job: J) throws -> Task<J.Output, Error>
    where J.WorkContext == NoteWorkContext, J.MainContext == NoteMainContext {
        try Task.checkCancellation()
        let work = environment.workContext, main = environment.mainContext
        return environment.runner.run { try await job.execute(work: work, main: main) }
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

`pull` is `async`, not a function that hands back a `Task` — that's the only sanctioned shape for a manager's public surface, covered in full in <a href="/guide/07-concurrency">Chapter 7</a>. `enqueue` stays `private` on purpose: it's the plumbing `pull` wraps, never something a caller sees directly, and its two `where` clauses are a compile-time fence — a job from another domain's family cannot be enqueued here. The manager owns nothing but its environment: no stored client, no stored store, no private runner. Two managers in one environment share one queue, so a pull and a tag-index rebuild on the same notebook can never interleave, and neither of them has to know the other exists.

<div class="rule">
<span class="rule-label">The rule</span>

A manager groups related functions that perform model-layer work. <strong>It never calls another manager.</strong> Composing manager functions is reserved for the layer above — an Action's `main()` awaiting two managers in sequence, as `MoveNoteAction` does in <a href="/guide/06-1-actions">Chapter 6.1</a>, or a background controller calling one on a timer. A manager that calls a sibling on the same runner enqueues a conflicting job and waits for it from inside its own reservation, and it hides the choreography the Action exists to show. If two managers keep needing the same step, that step is a job both can enqueue, not a call across managers.

</div>

What happens at runtime when a caller does `try await NoteManager.shared(for: notebook).pull()`:

1. `shared(for:)` finds the notebook's environment in the registry, or builds it on first use, and returns its manager.
1. `pull` hands the job to `enqueue`, which reads the two contexts off the environment and returns immediately with a `Task` — then `awaitCancellable` suspends on that task. The caller's own `await` is the one thing waiting; nothing about the queue underneath is visible from outside the manager.
1. The runner schedules the job behind whatever else is already queued for this notebook, so a pull and a save on the same notebook never interleave.
1. The job runs on the cooperative thread pool, fetches from the network, and returns its result. Its result handler resumes on the main actor to merge, persist, and publish the change.
1. The store's write lands in the database; the database's own change tracking merges it back onto the main context automatically.
1. Presentation, still on the read path from <a href="/guide/01-getting-started">Chapter 1</a>, refreshes from that main-actor notification without knowing a sync ever happened.

The same skeleton supports multiple sync sources and independently testable jobs. The cancellation bridge forwards the caller's cancellation to queued work; the job and its dependencies must cooperate with it. Keep persistence and publication inside `handleResult`, so the next conflicting job cannot start before they finish. <a href="/guide/07-concurrency">Chapter 7</a> extends this example with grouped scheduling and live progress.

### What happens after the job returns

`PullNotesJob` shows one of three patterns for how a job's result lands, and the choice is made per operation. A main-actor result handler can await storage that performs the actual I/O in the background; it does not make database work run synchronously on the UI thread.

<div class="table-wrap">
<table>
<thead><tr><th>Pattern</th><th>Job returns</th><th>Who applies</th></tr></thead>
<tbody>
<tr><td><strong>Result handler persists, database merges</strong></td><td>Typed data</td><td>The job's main-actor result handler writes through the store, then publishes only after the save succeeds. The pattern above — the default for persisted state.</td></tr>
<tr><td><strong>Return data to the caller</strong></td><td>Typed data</td><td>The job keeps the default, empty handler; the manager's <code>async</code> method returns the value directly — no <code>.value</code> to unwrap — and nothing touches model state at all.</td></tr>
<tr><td><strong>Result handler applies main-actor state</strong></td><td>Typed data</td><td>The job's result handler writes the result into in-memory model state on the main thread.</td></tr>
</tbody>
</table>
</div>

Some operations also need intermediate persistence in `perform`, such as saving a user's prompt before generating a summary. Report a saved acknowledgement only after that write succeeds, and publish the committed change even if generation later fails or is cancelled. The final result handler still owns completion and any remaining writes; cancellation does not undo earlier saves.

The second pattern is bounded by transience: nothing about that returned value is stored anywhere the model can hand back out again. The moment some other consumer needs to ask for the same answer later — not just once, in response to this call — the data has become state, and state belongs in the model layer under one of the shapes from earlier in this chapter, read back through a query like the ones that opened it. A private cache tucked inside a manager to avoid re-fetching is the tell that this line got crossed without actually moving the data where it belongs. The one exception is a read-side manager whose cache holds content-addressed, immutable results — a rendered note body keyed by the content's hash — because that cache can never go stale.

The third pattern carries its own rule: the result handler calls a <strong>dedicated `@MainActor` apply method on the model object</strong> — never inline mutation buried in a handler or a runner closure. The mutation logic stays testable and co-located with the state it modifies, and there's exactly one place to look when asking "what can change this?"

```swift
// In LoadTagIndexJob's @MainActor result handler — TagManager shares NoteManager's environment,
// so it shares the same two contexts:
@MainActor
func handleResult(_ result: Result<[TagCount], Error>, context: NoteMainContext) throws {
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

The apply method runs inside `handleResult`; no extra actor hop or manager callback is needed.

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
<tr><td>View/window-owned display or loader state, built by a controller from whatever model data it needs — not the model itself</td><td><code>@Observable</code> — consumers read a property, re-render when it changes. See <a href="/guide/08-2-view-state">Chapter 8.2</a>.</td></tr>
<tr><td>Flat, ambient, app-wide settings or state with no per-view projection to make — the one narrow exception</td><td><code>@Observable</code>, read directly, as in <a href="/guide/02-4-settings">Chapter 2.4</a>.</td></tr>
<tr><td>Any other model-layer state — in-memory domain data or database-backed</td><td>The manager posts a <code>Notification</code> after the write lands; consumers subscribe and re-read.</td></tr>
<tr><td>Platform / framework events</td><td>Subscribe to the framework's own notification directly.</td></tr>
</tbody>
</table>
</div>

A model itself is <code>@Observable</code> only in that one narrow case — a value flat enough that every consumer wants it verbatim, with no shape or subset to decide on. Anything else stays off-limits: binding a view straight to a model couples the view's whole contract to the model (and is a non-starter for a database-backed model to begin with — its runtime-synthesized accessors leave nothing for the Observation macro to rewrite), and a view driven straight off model mutations reacts to every intermediate step of a multi-field change instead of rendering one settled state. The moment a settings-shaped value needs to be derived, combined, or filtered for a particular view, it has graduated to needing its own display object like everything else in the row above it.

There's a mechanical reason underneath that design one, and it's what actually draws the line: `@Observable`'s guarantees only mean something for state that's exclusively touched on the main actor. A settings object like `EditorSettings` from <a href="/guide/02-4-settings">Chapter 2.4</a> qualifies because nothing ever writes to it from a background job — every other model-layer shape in this chapter, however trivial it looks today, has background work funneling through its manager, and that's disqualifying even when the model type itself carries a `@MainActor` annotation. The other two places this guide reaches for `@Observable` outside a view are the Action — see <a href="/guide/06-1-actions">Chapter 6.1</a> — and the activities an environment holds, for the identical reason: neither is ever constructed or touched off the main actor, full stop. A job writes to an activity only from its main-actor handlers.

When a notification-based source has more than one consumer that wants to observe it reactively, the recipe is to bridge it once: a single handler copies the value into an `@Observable` object that everyone else reads, rather than every consumer subscribing to the raw notification independently.

<div class="seealso">
<strong>Ahead in this guide</strong>
View-side consumption of all three signals — the `observations.track` / `observations.observe` mechanics — is <a href="/guide/08-4-state-observing">Chapter 8.4</a>; the view state controller and model those signals feed is <a href="/guide/08-2-view-state">Chapter 8.2</a>. What actually calls into the manager, and how a write earns the overhead of a full Action, is <a href="/guide/06-1-actions">Chapter 6.1</a>, next.
</div>
