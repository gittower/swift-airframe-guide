---
title: "Model Shapes"
description: "Not every piece of state needs the same machinery. This subchapter is the catalog: six shapes a model can take, each with a notebook example you can lift — synced notes, user-edited templates, suggestions written by both the user and a pipeline, a tag index rebuilt from scratch, settings, and app state — plus the decision walk that picks one and the line that says when data is not model state at all."
order: 5
subOrder: 7
---

Not every piece of state needs the same machinery. This subchapter is the catalog: six shapes a model can take, each with a notebook example you can lift — synced notes, user-edited templates, suggestions written by both the user and a pipeline, a tag index rebuilt from scratch, settings, and app state — plus the decision walk that picks one and the line that says when data is not model state at all.

## The axes

Six questions classify a piece of state, and most of a model's design falls out of answering them rather than being decided from scratch: does it persist, and where; does anything load or mutate it in the background; does the whole collection get replaced at once or do individual entries change; how long does it live — app, notebook, window, session; how does it signal change; and is its manager a dedicated class or the model itself.

<div class="table-wrap">
<table>
<thead><tr><th>Shape</th><th>Persists?</th><th>Background work</th><th>Signal</th><th>Example</th></tr></thead>
<tbody>
<tr><td><a href="#synced-database-backed"><strong>Synced, database-backed</strong></a></td><td>Yes</td><td>Sync against an external source, edits</td><td>Notification</td><td><code>Note</code></td></tr>
<tr><td><a href="#persisted-main-thread-only"><strong>Persisted, main-thread only</strong></a></td><td>Yes</td><td>None</td><td>Notification</td><td><code>NoteTemplate</code></td></tr>
<tr><td><a href="#file-backed-mixed-writers"><strong>File-backed, mixed writers</strong></a></td><td>Yes, flat files</td><td>A pipeline appends, the user decides</td><td>Notification</td><td><code>Suggestion</code></td></tr>
<tr><td><a href="#in-memory-replaced-wholesale"><strong>In-memory, replaced wholesale</strong></a></td><td>No</td><td>Load only</td><td>Notification</td><td><code>TagIndex</code></td></tr>
<tr><td><a href="#preference-backed-settings"><strong>Preference-backed settings</strong></a></td><td>Yes, key-value</td><td>None</td><td><code>@Observable</code></td><td><code>EditorSettings</code></td></tr>
<tr><td><a href="#in-memory-app-state"><strong>In-memory app state</strong></a></td><td>No</td><td>None</td><td><code>@Observable</code></td><td><code>AppState</code></td></tr>
</tbody>
</table>
</div>

Only the first shape needs everything in Chapters 5.2 through 5.6. The third and fourth borrow the environment's runner and jobs for the part of their work that is background; the second needs none of it; the last two are their own manager. The funnel principle is the constant across all six — what differs is how it is implemented and what the model itself looks like.

## Synced, database-backed

<strong>Use when</strong> the state mirrors something outside the app — a server, another device — must survive relaunch, and refreshes against that source in the background. `Note` is the canonical case, and the whole of Chapters 5.1 through 5.6 is its worked example: the value type and two-faced store in <a href="/guide/05-1-the-model">5.1</a>, the environment in <a href="/guide/05-2-the-environment">5.2</a>, `NoteManager` in <a href="/guide/05-3-the-manager">5.3</a>, `PullNotesJob` and `RenameNoteJob` in <a href="/guide/05-4-jobs-and-contexts">5.4</a>, the groups in <a href="/guide/05-5-runners-and-scheduling">5.5</a>, the sync activity in <a href="/guide/05-6-progress-and-activities">5.6</a>.

What is specific to the shape: writes happen through the store's background face inside a job's handler, the database's own change tracking merges them onto the main context, and the handler publishes the notification only after the save succeeds — because the store <em>is</em> the truth, and a write is not real until it is saved. Entities are values, since they cross into background work constantly. The same skeleton serves any externally owned data — a REST resource, a shared folder — with a different client in the work context and different jobs; the manager, bridge and runner do not change.

<strong>Don't use when</strong> nothing external owns the data. Then the background dance is overhead: the second shape for user-edited records, the third for mixed writers.

## Persisted, main-thread only

<strong>Use when</strong> the records are user-edited, small and infrequent, with no external source to sync against. Note templates are the notebook app's case: the user creates a handful, edits one occasionally, and nothing else ever writes them. There is no background work, so there is no job, no runner and no `async` — but there is still a manager, because saving, validation and normalisation need one home.

```swift
// NotebookCore/Templates/NoteTemplate.swift
struct NoteTemplate: Identifiable, Sendable, Equatable {
    let id: TemplateID
    var title: String
    var body: String
}

// NotebookCore/Templates/TemplateStore.swift — database-backed, main context only
@MainActor
final class TemplateStore {
    static let shared = TemplateStore()          // app-wide: templates belong to the user, not to a notebook

    func all() -> [NoteTemplate] { … }
    func template(id: TemplateID) -> NoteTemplate? { … }

    // Module-internal: only TemplateManager calls these. Each one saves on the main context before returning.
    func save(_ template: NoteTemplate) throws { … }
    func delete(id: TemplateID) throws { … }
}

// NotebookCore/Templates/NoteTemplate+Queries.swift
extension NoteTemplate {
    static func all() -> [NoteTemplate] { TemplateStore.shared.all() }
    static func template(id: TemplateID) -> NoteTemplate? { TemplateStore.shared.template(id: id) }
}
```

```swift
// NotebookCore/Templates/TemplateManager.swift — the funnel, synchronous and throwing
@MainActor
final class TemplateManager {
    static let shared = TemplateManager()

    @discardableResult
    func create(title: String, body: String) throws -> NoteTemplate {
        let template = NoteTemplate(id: TemplateID(), title: normalized(title), body: body)
        guard !template.title.isEmpty else { throw TemplateError.emptyTitle }
        try TemplateStore.shared.save(template)
        NoteTemplate.notifications.postDidChange()
        return template
    }

    func rename(id: TemplateID, to title: String) throws {
        guard var template = NoteTemplate.template(id: id) else { throw TemplateError.notFound }
        template.title = normalized(title)
        guard !template.title.isEmpty else { throw TemplateError.emptyTitle }
        try TemplateStore.shared.save(template)
        NoteTemplate.notifications.postDidChange()
    }

    func delete(id: TemplateID) throws {
        try TemplateStore.shared.delete(id: id)
        NoteTemplate.notifications.postDidChange()
    }

    private func normalized(_ title: String) -> String {
        title.trimmingCharacters(in: .whitespaces)
    }
}
```

The manager is reached as `TemplateManager.shared`, a plain shared static per <a href="/guide/02-5-object-wiring">Chapter 2.5</a>: the templates are app-wide, there is no runner to share, so there is no environment. Its methods are synchronous because nothing in them suspends — the one-shape rule in Chapter 5.3 is about operations that have background work behind them, and these have none. The store underneath is the test seam, as everywhere else: a test opens it over an in-memory database and drives the manager through its public methods.

<strong>Don't use when</strong> the data syncs against an external source — that is the first shape — or when a second writer appears that is not the user, which is the third.

<div class="rule">
<span class="rule-label">The rule</span>

No background work means no job and no runner, but never no manager. Mutations from arbitrary call sites, and someone forgetting to save, are exactly the failure modes the funnel exists to prevent, and they do not depend on a thread.

</div>

## File-backed, mixed writers

<strong>Use when</strong> a structured collection must survive relaunch, does not belong in the database, and is written by more than one kind of source — at least one of them asynchronous. In the notebook app that is suggestions: an assistant pipeline proposes tags, links and rewrites for a note, and the user accepts or dismisses each one. Both writes go through one manager; the files in the notebook folder are a write-behind copy of what memory holds.

```swift
// NotebookCore/Suggestions/Suggestion.swift — a value; the one mutable field is the user's decision
struct Suggestion: Identifiable, Codable, Sendable, Equatable {
    enum Kind: Codable, Sendable, Equatable { case tag(Tag), link(NoteID), rewrite(String) }
    enum Decision: Codable, Sendable { case pending, accepted, dismissed }

    let id: SuggestionID
    let noteID: NoteID
    let kind: Kind
    var decision: Decision = .pending
}

// NotebookCore/Suggestions/SuggestionStore.swift — the in-memory collection; loaded from the folder when the notebook opens
@MainActor
final class SuggestionStore {
    private(set) var suggestions: [Suggestion] = []

    func suggestion(id: SuggestionID) -> Suggestion? { suggestions.first { $0.id == id } }

    // Module-internal: only SuggestionManager and its jobs' handlers call these.
    func append(_ incoming: [Suggestion]) { suggestions.append(contentsOf: incoming) }
    func upsert(_ suggestion: Suggestion) {
        if let index = suggestions.firstIndex(where: { $0.id == suggestion.id }) {
            suggestions[index] = suggestion
        } else {
            suggestions.append(suggestion)
        }
    }
}

// NotebookCore/Suggestions/Suggestion+Queries.swift
extension Suggestion {
    static func pending(for noteID: NoteID, in notebook: Notebook) -> [Suggestion] {
        notebook.suggestions.suggestions.filter { $0.noteID == noteID && $0.decision == .pending }
    }
}
```

The manager is per notebook, so it lives in the environment and shares the notebook's runner — a suggestion pipeline reading notes should never interleave with a pull writing them:

```swift
// NotebookCore/Suggestions/SuggestionManager.swift — one funnel for both writers
@MainActor
final class SuggestionManager: NotebookManaging {
    let environment: NotebookEnvironment

    init(environment: NotebookEnvironment) {
        self.environment = environment
    }

    /// The user's side. The mutation and the signal happen now, on the main thread;
    /// the file write trails behind, in order, and the caller learns if the disk failed.
    func decide(_ decision: Suggestion.Decision, suggestionID: SuggestionID) async throws {
        let store = environment.notebook.suggestions
        guard var suggestion = store.suggestion(id: suggestionID) else { throw SuggestionError.notFound }
        suggestion.decision = decision
        store.upsert(suggestion)
        Suggestion.notifications.postDidChange(in: environment.notebook.id)
        try await awaitCancellable(enqueue(PersistSuggestionJob(suggestion: suggestion)))
    }

    /// The pipeline's side. One job asks the assistant, writes the new files, and appends in its handler.
    func propose(for noteID: NoteID) async throws {
        try await awaitCancellable(enqueue(ProposeSuggestionsJob(noteID: noteID)))
    }
}
```

```swift
// NotebookCore/Suggestions/Jobs/PersistSuggestionJob.swift
struct PersistSuggestionJob: BackgroundJob, TaskAccess {
    let suggestion: Suggestion                         // frozen at submission — exactly right for write-behind
    var groups: Set<NoteJobGroup> { [.suggestions] }
    let access: TaskAccessMode = .write

    nonisolated func perform(context: NoteWorkContext) async throws {
        try await context.files.write(suggestion, as: .suggestion(suggestion.id))
    }
    // Memory is already current and published. Nothing to apply; the default handler is enough.
}

// NotebookCore/Suggestions/Jobs/ProposeSuggestionsJob.swift
struct ProposeSuggestionsJob: BackgroundJob, TaskAccess {
    let noteID: NoteID
    var groups: Set<NoteJobGroup> { [.suggestions] }
    let access: TaskAccessMode = .write

    nonisolated func perform(context: NoteWorkContext) async throws -> [Suggestion] {
        let note = try await context.requireNote(noteID)                  // the note as it is now
        let proposed = try await context.assistant.suggestions(for: note)
        for suggestion in proposed {                                       // intermediate persistence — Chapter 5.4
            try await context.files.write(suggestion, as: .suggestion(suggestion.id))
        }
        return proposed
    }

    @MainActor
    func finalize(_ result: Result<[Suggestion], Error>, context: NoteMainContext) throws {
        context.notebook.suggestions.append(try result.get())
        context.suggestionsDidChange()
    }
}
```

Three things distinguish this shape from the first. <strong>Memory is the truth and the file is a copy</strong>, so `decide` mutates and publishes immediately — the UI updates on the click — and the persist job trails behind it. In the first shape the order is reversed, because there the store is the database. <strong>Persistence is one-way</strong>, memory to disk: saves never write back into memory, and the runner's FIFO order means a stale snapshot can never overwrite a fresh one — the last decision submitted is the last file written. <strong>Freezing the record at submission is correct here</strong>, where Chapter 5.4 said the opposite for an edit: a persist carries the state to write, not an edit to apply to whatever is current.

`ProposeSuggestionsJob` deliberately does not declare the note's group. Generating suggestions must not block the user editing that note, and a suggestion for a note that changed meanwhile is simply one the user dismisses. The entities are structs; the sub-decision in <a href="/guide/05-1-the-model">Chapter 5.1</a> says when a shape like this one would choose classes instead — a detail view holding a long-lived reference to an entity that a pipeline amends in place.

<strong>Don't use when</strong> the data fits the database — then it is the first or second shape — or needs no persistence, which is the next one.

## In-memory, replaced wholesale

<strong>Use when</strong> the data is derived or loaded from a source on demand, does not need to survive relaunch, and is never edited in place: whatever the load returns <em>is</em> the new state. The notebook's tag index — how many notes carry each tag — is derived from the notes, recomputed when they change, and read by the sidebar's tag filter.

```swift
// NotebookCore/Tags/TagIndex.swift
struct TagCount: Hashable, Sendable {
    let tag: Tag
    let count: Int
}

/// The holder, exposed as `notebook.tagIndex`. Plain, not @Observable.
@MainActor
final class TagIndex {
    private(set) var counts: [TagCount] = []

    func changeset(against incoming: [TagCount]) -> TagIndexChangeset { … }
    func apply(_ changes: TagIndexChangeset) { … }        // module-internal
}

// NotebookCore/Tags/Tag+Queries.swift
extension Tag {
    static func counts(in notebook: Notebook) -> [TagCount] { notebook.tagIndex.counts }
}

// On Notebook — the dedicated apply method, the one place this state mutates
extension Notebook {
    @MainActor
    func applyTagIndexUpdate(_ incoming: [TagCount]) {
        let changes = tagIndex.changeset(against: incoming)
        tagIndex.apply(changes)
        if !changes.isEmpty { Tag.notifications.postIndexDidChange(changes, in: id) }
    }
}
```

```swift
// NotebookCore/Tags/Jobs/LoadTagIndexJob.swift
struct LoadTagIndexJob: BackgroundJob, TaskAccess {
    var groups: Set<NoteJobGroup> { [.notes] }
    let access: TaskAccessMode = .write

    nonisolated func perform(context: NoteWorkContext) async throws -> [TagCount] {
        try await context.storage.tagCounts(in: context.notebookID)
    }

    @MainActor
    func finalize(_ result: Result<[TagCount], Error>, context: NoteMainContext) throws {
        context.notebook.applyTagIndexUpdate(try result.get())
    }
}

// NotebookCore/Tags/TagManager.swift
@MainActor
final class TagManager: NotebookManaging {
    let environment: NotebookEnvironment

    init(environment: NotebookEnvironment) {
        self.environment = environment
    }

    func rebuildIndex() async throws {
        try await awaitCancellable(enqueue(LoadTagIndexJob()))
    }
}
```

The load only reads storage, yet the job declares `.write` on `.notes`. Two reasons: a rebuild should not interleave with a pull or a delete, and two rebuilds must apply in submission order — as readers they could run concurrently and the earlier-started one could apply last, replacing fresh counts with stale ones. Wholesale replacement is only safe when replacements are ordered.

Who asks for the rebuild is not the model's concern. In the notebook app it is `TagUsageProjector`, the event-driven background controller from <a href="/guide/04-background-controllers">Chapter 4</a>: it observes the note-changed notification and calls `TagManager.shared(for: notebook).rebuildIndex()`. The controller decides <em>when</em>, the job is the <em>what</em>, the apply method is the one place the state changes, and the sidebar reads `Tag.counts(in:)` after the index notification — four pieces, each in the layer it belongs to.

<strong>Don't use when</strong> the data must survive relaunch, or individual entries are edited in place. Then it is the first or third shape.

## Preference-backed settings

<strong>Use when</strong> the values are user preferences: lightweight key-value data that persists across launches and changes infrequently. `EditorSettings` from <a href="/guide/02-4-settings">Chapter 2.4</a> is the shape in full — a `@UserDefault`-backed object whose setters <em>are</em> the funnel, so no separate manager exists.

This is the one deliberate exception to "models signal by notification". The values are flat and ambient — a font size, a toggle — with no per-view projection to make, so every consumer wants them verbatim and `@Observable` costs nothing. It holds only while two things stay true: nothing ever writes to the object from a background job, and no screen needs to derive, combine or filter what it holds. A setting that starts syncing from a server graduates out of the exception into the first shape; a screen that derives from several settings builds its own view state model like everything else — <a href="/guide/07-6-settings-window">Chapter 7.6</a> shows where that line falls in a real settings window.

## In-memory app state

<strong>Use when</strong> the state is transient, app-wide, not persisted and not owned by any domain: a density toggle for this session, a deep link the URL handler received before the window that should show it exists.

```swift
// NotebookApp/App/Runtime/AppState.swift — beside the settings objects: state the whole app shares and no domain owns
@Observable @MainActor
final class AppState {
    static let shared = AppState()

    var isCompactDensity = false
    var pendingDeepLink: URL?

    private init() {}
}
```

The class plays the manager role — its setters are the funnel — and with nothing to coordinate, a separate manager class would add nothing. It is `@Observable` under the same exception as settings, for the same reason: only main-actor code ever touches it. Graduate it the moment either condition fails — to settings if a value should persist, to a manager-fronted shape if a value gains validation or a background writer.

<strong>Don't use when</strong> the state belongs to one window or screen. That is a view state model written by a view state controller — <a href="/guide/07-2-view-state">Chapter 7.2</a> — not app state.

## What isn't a shape at all

Some manager calls do not produce model state: a draft summary the user may or may not keep, a notebook exported to a byte buffer, a dry-run of a merge. These are plain `async` methods returning transient data — the second result pattern in <a href="/guide/05-4-jobs-and-contexts">Chapter 5.4</a> — and nothing here is stored, notified about or queried. The line is transience, as <a href="/guide/05-3-the-manager">Chapter 5.3</a> draws it: the moment another consumer needs to ask for the same answer later, it has become state and belongs under one of the six shapes above.

## Choosing a shape

1. <strong>Does something outside the app own it, and must it survive relaunch?</strong> Synced, database-backed.
2. <strong>Persisted, but only the user writes it, from the main thread?</strong> Persisted, main-thread only — unless the values are flat preferences, which are settings.
3. <strong>Persisted, structured, with a background writer that is not a sync?</strong> File-backed, mixed writers.
4. <strong>Not persisted, loaded or derived, never edited in place?</strong> In-memory, replaced wholesale.
5. <strong>Not persisted, flat, app-wide, main-actor only?</strong> In-memory app state.
6. <strong>Fetched once and handed back?</strong> Not a shape. An `async` manager method returning the value.

Shapes are chosen per model type, not per app, and a type moves between them as its requirements change: a template that starts syncing to other devices becomes the first shape, a setting that gains a background writer stops being `@Observable`. Each shape's "don't use when" names the neighbour it most often graduates into.

<div class="seealso">
<strong>Ahead in this chapter</strong>
The runner orders work; it does not decide what "correct" means when the same operation is triggered twice before the first finishes. That choice, with four strategies and a notebook example for each, is next: <a href="/guide/05-8-execution-strategies">Chapter 5.8, Execution Strategies</a>.
</div>
