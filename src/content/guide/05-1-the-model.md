---
title: "The Model"
description: "A model type is plain data with a store behind it and a query in front of it. This subchapter covers what a model looks like, how reads reach it without going through a manager, who is allowed to write it, whether its entities are values or references, and how it tells the rest of the app that something changed."
order: 5
subOrder: 1
---

A model type is plain data with a store behind it and a query in front of it. This subchapter covers what a model looks like, how reads reach it without going through a manager, who is allowed to write it, whether its entities are values or references, and how it tells the rest of the app that something changed.

## Plain data, a store, a query

Take the notebook app's `Note`. It is a value: a `Sendable` struct that can cross into background work as a snapshot without anyone asking who owns it right now.

```swift
// NotebookCore/Notes/Note.swift
struct Note: Identifiable, Sendable, Equatable {
    let id: NoteID
    var title: String
    var body: String
    var tags: Set<Tag>
    var modifiedAt: Date
}
```

Behind it sits the store, which is where persistence lives and where the collection is actually held. For a database-backed model the store has two faces, because the model is read on the main actor and written from background jobs:

```swift
// NotebookCore/Notes/NoteStore.swift
/// The main-actor face: what queries read. Owned by the notebook, reached as `notebook.notes`.
@MainActor
final class NoteStore {
    let storage: NoteStorage                       // the background face, handed to jobs through their work context

    func all() -> [Note] { … }
    func note(id: NoteID) -> Note? { … }

    /// Module-internal: only a job's main-actor handler calls this. The database's own change
    /// tracking merges the background save onto the main context, so the next query sees it.
    func merge(_ incoming: [Note]) async throws { … }
}

/// The background face: `Sendable`, safe to call off the main actor, knows nothing about views or managers.
struct NoteStorage: Sendable {
    func note(id: NoteID, in notebookID: NotebookID) async throws -> Note? { … }
    func deleteNote(id: NoteID, in notebookID: NotebookID) async throws { … }
    func exportNotebook(id: NotebookID) async throws -> Data { … }
}
```

The store stays generic: `all()`, `note(id:)`, insert, merge and remove — the small set of accessors every query builds on. It never grows a bespoke method per filter. Filtering lives one layer up, in a `Model+Queries.swift` extension, which is what the rest of the app actually calls.

## Reads skip the manager

Ordinary display reads never touch a manager: the manager has nothing to contribute to a read, and routing reads through it couples every screen to the write path.

```swift
// Avoid — the manager has nothing to contribute to a read
NoteManager.shared(for: notebook).note(id: id)

// Prefer — the model reads itself
Note.note(id: id, in: notebook)
```

The queries are static functions on the model type, grouped in their own file:

```swift
// NotebookCore/Notes/Note+Queries.swift
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

Singular name and return type for a single lookup, plural for a collection; the first argument label names what is being filtered on (`taggedWith:`) rather than a generic `where:`, so the call site reads like the question being asked out loud.

These queries always answer with current state — `Note.all(in: notebook)` recomputes from whatever the store holds right now, never a result cached from an earlier call. That is what makes it safe to simply call the query again after a change notification fires, rather than reasoning about whether the old result is still good: nothing about the query itself can be stale. If a particular query is expensive enough to want caching, the cache lives on the store, kept live by the same funnel that writes through it — never as a memo hidden inside the query function, guessing when to invalidate itself.

The one read that does go through a manager is a read that must wait for an ongoing write to finish — exporting a notebook while a save is pending, say. That is a coordinated operation, and it runs as a read job on the domain's runner; <a href="/guide/05-5-runners-and-scheduling">Chapter 5.5</a> shows one. It is the exception that proves the rule: the manager contributes ordering, which a plain lookup never needs.

## Who may write

Views read from the model. They never write to it directly — every write, whether it originates from a button click, a background sync, or an automated pipeline, converges on the same manager before it touches state. That convergence is what makes the rest of the architecture possible:

- It does not matter <em>where</em> a change came from. Ordering, validation, persistence and notification all have exactly one place to live, so adding a new source of mutation never reopens those questions.
- Views can stay naive. They read current state, render it, and react to change notifications — they never need to reason about who else might be writing at the same time.

On the model's side this shows up as access control. The store's mutators — `merge`, `insert`, `remove` — are module-internal, and the model layer is its own package, `NotebookCore`, per <a href="/guide/01-1-project-layout">Chapter 1.1</a>. So "only the manager writes" is not a convention a reviewer has to catch: the app target and the Actions package physically cannot call a store mutator, because nothing but the manager's public `async` methods is public. Inside the package the discipline is still a convention — a job's handler calls `store.merge`, nothing else does — but the surface the rest of the app sees is exactly the funnel.

A manager always exists, even when it looks trivial. Sometimes it is a dedicated class; sometimes the model class acts as its own manager, when the mutation logic is simple enough that a wrapper would add nothing — a settings object's own setters, as in <a href="/guide/02-4-settings">Chapter 2.4</a>, <em>are</em> the funnel. And the funnel can run entirely on the main thread: a model with no background work still gets a manager, so that saving, validation and any cross-entity coordination have one home. The funnel is about <em>who</em> writes, not <em>which thread</em> writes. <a href="/guide/05-7-model-shapes">Chapter 5.7</a> works through both kinds.

<div class="rule">
<span class="rule-label">The rule</span>

Every mutation, from every source, goes through the model's one manager. Reads never do: a view, a view state controller or a validator asks the model through a static query, which answers with current state every time. The store's mutators are module-internal, so outside the model package the funnel is enforced by the compiler, not by review.

</div>

## Value or reference

Within a shape there is sometimes a genuine open choice: model entities as immutable structs that get replaced wholesale, or as plain reference classes that get mutated in place.

<div class="table-wrap">
<table>
<thead><tr><th></th><th>Immutable structs (replaced)</th><th>Reference classes (mutated)</th></tr></thead>
<tbody>
<tr><td><strong>Crossing into background work</strong></td><td>Automatic — a copy is a snapshot</td><td>Manual — snapshot to a <code>Sendable</code> record first</td></tr>
<tr><td><strong>Codable</strong></td><td>Synthesised</td><td>Hand-written, or a separate record type</td></tr>
<tr><td><strong>Identity across a mutation</strong></td><td>None — a new value per change</td><td>Yes — the same instance before and after</td></tr>
<tr><td><strong>Mutation syntax</strong></td><td><code>store.upsert(note.with(title: …))</code></td><td><code>note.title = …</code></td></tr>
</tbody>
</table>
</div>

Choose classes when identity across a mutation matters — a detail view holding a direct reference to an entity should see an in-place edit without re-resolving it. Choose structs when Codable simplicity and value semantics matter more than identity — small entities nobody holds a long-lived reference to, and anything that routinely crosses into background work, which is why `Note` is a struct. Neither option is `@Observable`: identity preservation is about reference versus value semantics, not reactivity. The notification below is what tells a consumer to re-read, either way.

## Signalling change

However the state is shaped, it has to tell interested views when it changes. The load-bearing question is not whether the source happens to be a plain Swift object — it is <strong>whether the state is model layer, or view/window layer</strong>.

<div class="table-wrap">
<table>
<thead><tr><th>Source</th><th>Signal</th></tr></thead>
<tbody>
<tr><td>View/window-owned display or loader state, built by a controller from whatever model data it needs — not the model itself</td><td><code>@Observable</code> — consumers read a property, re-render when it changes. See <a href="/guide/07-2-view-state">Chapter 7.2</a>.</td></tr>
<tr><td>Flat, ambient, app-wide settings or state with no per-view projection to make — the one narrow exception</td><td><code>@Observable</code>, read directly, as in <a href="/guide/02-4-settings">Chapter 2.4</a>.</td></tr>
<tr><td>Any other model-layer state — in-memory domain data or database-backed</td><td>The manager posts a <code>Notification</code> after the write lands; consumers subscribe and re-read through a query.</td></tr>
<tr><td>Platform / framework events</td><td>Subscribe to the framework's own notification directly.</td></tr>
</tbody>
</table>
</div>

A model itself is `@Observable` only in that one narrow case — a value flat enough that every consumer wants it verbatim, with no shape or subset to decide on. Anything else stays off-limits. Binding a view straight to a model couples the view's whole contract to the model, and is a non-starter for a database-backed model to begin with — its runtime-synthesized accessors leave nothing for the Observation macro to rewrite. And a view driven straight off model mutations reacts to every intermediate step of a multi-field change instead of rendering one settled state. The moment a settings-shaped value needs to be derived, combined or filtered for a particular view, it has graduated to needing its own display object like everything else in the first row.

There is a mechanical reason underneath that design one, and it is what actually draws the line: `@Observable`'s guarantees only mean something for state that is exclusively touched on the main actor. A settings object like `EditorSettings` qualifies because nothing ever writes to it from a background job. Every other model shape in this chapter, however trivial it looks today, has background work funnelling through its manager, and that is disqualifying even when the model type itself carries a `@MainActor` annotation. The other two places this guide reaches for `@Observable` outside a view are the Action — <a href="/guide/06-1-actions">Chapter 6.1</a> — and the activities an environment holds — <a href="/guide/05-6-progress-and-activities">Chapter 5.6</a> — for the identical reason: neither is ever constructed or touched off the main actor. A job writes to an activity only from its main-actor handlers.

The notification is posted by whoever applies the write — a job's main-actor result handler, or a main-thread manager method — after the write has landed, never before. Consumers subscribe, re-read whatever slice they need through a query, and republish that as their own small, purpose-built `@Observable` view state model, which is what a view actually reads. When a notification has more than one consumer that wants to observe it reactively, bridge it once: a single handler copies the value into an `@Observable` object everyone else reads, rather than every consumer subscribing to the raw notification independently.

```swift
// NotebookCore/Notes/Note+Notifications.swift — one name per model, posted with the notebook as the object
extension Note {
    enum notifications {
        static let didChange = Notification.Name("Note.didChange")

        @MainActor
        static func postDidChange(in notebookID: NotebookID) {
            NotificationCenter.default.post(name: didChange, object: notebookID)
        }
    }
}
```

Posting with the notebook's identifier as the object lets a screen that shows one notebook subscribe to exactly that notebook's changes, and the "re-read through a query" half of the recipe means the notification carries no payload a consumer could get stale by caching.

<div class="seealso">
<strong>Ahead in this chapter</strong>
The object that owns the store, the runner and everything else a notebook's managers and jobs share is next: <a href="/guide/05-2-the-environment">Chapter 5.2, The Environment</a>. The consumer side of the notification — subscribe, seed, track — is <a href="/guide/07-4-state-observing">Chapter 7.4</a>.
</div>
