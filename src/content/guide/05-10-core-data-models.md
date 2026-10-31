---
title: "Core Data Models"
description: "When the database behind a model is Core Data, the entity is the model. This subchapter covers what that changes from the backend-neutral examples before it — the stack and its two contexts, the entity itself, queries on the main context, crossing into background work by object ID, where the save goes and why the entity never makes it, the one static that may save, normalisation and validation, the main-thread shape in Core Data, and testing on the in-memory stack."
order: 5
subOrder: 10
---

When the database behind a model is Core Data, the entity is the model. This subchapter covers what that changes from the backend-neutral examples before it — the stack and its two contexts, the entity itself, queries on the main context, crossing into background work by object ID, where the save goes and why the entity never makes it, the one static that may save, normalisation and validation, the main-thread shape in Core Data, and testing on the in-memory stack.

## The entity is the model

Chapters 5.1 through 5.6 keep `Note` a value with an unnamed database behind its store, so that the manager, the jobs and the runner read the same whatever the backend. Two of the shapes in <a href="/guide/05-7-model-shapes">Chapter 5.7</a> are database-backed — synced, and persisted main-thread only — and when that database is Core Data, the picture gets simpler in one way and stricter in another. Simpler, because there is no separate store type: the `NSManagedObject` subclass <em>is</em> the model, and the contexts are its two faces. Stricter, because a managed object belongs to exactly one context and must never leave it.

This subchapter works through `Notebook`, the synced entity whose save-free `markOffline(after:)` <a href="/guide/05-1-the-model">Chapter 5.1</a> already showed, and `NoteTemplate`, the main-thread shape. In a Core Data app notes are entities exactly like `Notebook`, and everything below applies to them unchanged.

<div class="table-wrap">
<table>
<thead><tr><th></th><th>Backend-neutral (5.1–5.7)</th><th>Core Data</th></tr></thead>
<tbody>
<tr><td><strong>The model</strong></td><td>A <code>Sendable</code> struct, or a plain class</td><td>An <code>NSManagedObject</code> subclass, bound to the context it was fetched on</td></tr>
<tr><td><strong>The store's two faces</strong></td><td><code>NoteStore</code> on the main actor, <code>NoteStorage</code> in the background</td><td>The main context, and the background context jobs hop onto</td></tr>
<tr><td><strong>Crossing into background work</strong></td><td>A copy of the value</td><td>The object's <code>NSManagedObjectID</code>, resolved again on the other context</td></tr>
<tr><td><strong>Landing a background write</strong></td><td><code>finalize</code> merges into the store</td><td>The job saves the background context; the save merges onto the main context by itself</td></tr>
<tr><td><strong>Signalling change</strong></td><td>An announcement on the owning model</td><td>The same announcement. Core Data could not be tracked anyway: its runtime-synthesized accessors leave nothing for the Observation macro to rewrite</td></tr>
</tbody>
</table>
</div>

## The stack

One persistent container for the app, configured once at launch by `PersistenceInitializer` (<a href="/guide/02-2-startup">Chapter 2.2</a>) the same way `SyncConfig` is configured in <a href="/guide/02-5-object-wiring">Chapter 2.5</a>, and two contexts on it:

```swift
// NotebookCore/Persistence/PersistentStack.swift
public final class PersistentStack: Sendable {
    public private(set) static var shared: PersistentStack!

    let container: NSPersistentContainer
    let backgroundContext: NSManagedObjectContext

    /// Call once at launch, from PersistenceInitializer. A `nil` URL opens an in-memory store — what TestCase does.
    public static func configure(storeURL: URL?) throws {
        let container = try NSPersistentContainer.loadNotebookStore(at: storeURL)
        let backgroundContext = container.newBackgroundContext()
        // Each context merges the other's saves: a job's write lands on the main context,
        // a main-thread write is seen by the next job that resolves the same object.
        container.viewContext.automaticallyMergesChangesFromParent = true
        backgroundContext.automaticallyMergesChangesFromParent = true
        shared = PersistentStack(container: container, backgroundContext: backgroundContext)
    }
}
```

```swift
// NotebookCore/Persistence/NSManagedObjectContext+Stack.swift
extension NSManagedObjectContext {
    /// The main context: what queries read, and what the main-thread shape writes. Main actor only.
    @MainActor static var main: NSManagedObjectContext { PersistentStack.shared.container.viewContext }

    /// The background context every job's hops run on — always inside `perform`.
    static var background: NSManagedObjectContext { PersistentStack.shared.backgroundContext }

    /// Runs `body`, then saves once if anything changed. A failed save rolls the context back, so a
    /// half-applied unit of work is never carried along by the next save on the same context.
    /// Call it on the context's queue.
    func saving<T>(_ body: () throws -> T) throws -> T {
        let result = try body()
        guard hasChanges else { return result }
        do {
            try save()
        } catch {
            rollback()
            throw error
        }
        return result
    }
}
```

The background context is a sibling of the main context on the same coordinator, never a child of it. Nested contexts look attractive for background work — saving a child pushes its changes into the parent for free — but every fetch and save in a child blocks its parents, which puts the main thread back in the path of the work you moved off it; objects inserted in a child keep temporary IDs after the child saves, so they cannot be passed to another context; fetches always return faults; and prefetching and batch faulting do not work. A child context is for a scratchpad edit the user may still throw away, not for jobs.

Turn on Core Data's own concurrency checking in the app's and the tests' schemes from the first day: the launch argument `-com.apple.CoreData.ConcurrencyDebug 1` makes every access to a managed object off its context's queue an immediate assertion rather than an occasional corruption.

## The entity

```swift
// NotebookCore/Notebooks/Notebook.swift — the shape only; behavior lives in extension files by concern
@objc(Notebook)
public final class Notebook: NSManagedObject {
    @NSManaged public internal(set) var title: String
    @NSManaged public internal(set) var ownerName: String
    @NSManaged public internal(set) var lastSyncError: String?
    @NSManaged var remoteID: String?                 // nil until the first sync
    @NSManaged private var syncStateValue: String

    public internal(set) var syncState: SyncState {
        get { SyncState(rawValue: syncStateValue) ?? .synced }
        set { syncStateValue = newValue.rawValue }
    }

    @nonobjc static func fetchRequest() -> NSFetchRequest<Notebook> {
        NSFetchRequest(entityName: "Notebook")
    }
}
```

The class is written by hand, so the entity's code generation in the model editor is set to Manual/None. Leaving Xcode's codegen on as well produces a second, invisible definition of the same class; "Create NSManagedObject Subclass" is a one-time starting point, after which codegen goes off for that entity.

Three annotations are deliberately absent. <strong>Not `@MainActor`</strong>: the background context holds its own instances of the same entity, and its jobs use them inside `perform`. The queries, which only ever read the main context, carry the annotation instead. <strong>Not `@Observable`</strong>: the accessors are synthesized at runtime, so there is nothing for the macro to rewrite, and the model layer signals by announcement anyway (<a href="/guide/05-1-the-model">Chapter 5.1</a>). <strong>Not `Sendable`</strong>: a managed object never crosses a context, so it has nothing to declare.

The setters are `internal(set)`. Core Data would let any caller assign `notebook.title` on the main context; the package boundary from <a href="/guide/01-1-project-layout">Chapter 1.1</a> takes that away, so outside `NotebookCore` the entity is read-only and the manager is the only way to change it — the same compiler-enforced funnel the store's module-internal mutators give the neutral examples.

Behavior goes in extension files grouped by concern, beside the entity: `Notebook+Queries.swift`, `Notebook+Sync.swift` for the mutating methods a sync builds on, `Notebook+Announcements.swift` — Chapter 5.1's `notesDidChange(in:)`, and `notebookDidChange(_:)` for the notebook's own fields — and `Notebook+Resolve.swift`. The entity file stays the shape and nothing else.

## Reads: queries on the main context

The queries are the ones from <a href="/guide/05-1-the-model">Chapter 5.1</a>, with the context as their store: static, `@MainActor`, a live fetch on every call.

```swift
// NotebookCore/Notebooks/Notebook+Queries.swift
@MainActor
extension Notebook {
    public static func all() -> [Notebook] {
        let request = Notebook.fetchRequest()
        request.sortDescriptors = [NSSortDescriptor(key: "title", ascending: true)]
        return (try? NSManagedObjectContext.main.fetch(request)) ?? []
    }

    public static func notebook(id: NotebookID) -> Notebook? {
        try? NSManagedObjectContext.main.existingObject(with: id.objectID) as? Notebook
    }

    public static func notebooks(in state: SyncState) -> [Notebook] {
        let request = Notebook.fetchRequest()
        request.predicate = NSPredicate(format: "syncStateValue == %@", state.rawValue)
        request.sortDescriptors = [NSSortDescriptor(key: "title", ascending: true)]
        return (try? NSManagedObjectContext.main.fetch(request)) ?? []
    }
}
```

A filter that would walk `all()` on a large set becomes a predicate on the fetch, as `notebooks(in:)` does — the query is still the caller-facing surface, and the fetch still reads current state. What a query returns is a managed object on the main context, and it goes no further than the view state controller that asked: the controller maps it into its own `@Observable` view state model (<a href="/guide/07-2-view-state">Chapter 7.2</a>), and the view never holds an entity. SwiftUI's `@FetchRequest` binds a view straight to entities, which is exactly that coupling, so this guide does not use it.

Re-reading after an announcement rather than holding on to an entity matters more with Core Data than anywhere else. A notebook deleted by a job's save is merged onto the main context as deleted, and an old reference to it stays around without a context to belong to. Screens remember a `NotebookID` and ask the query again, which is the identifier-not-object rule <a href="/guide/08-navigation">Chapter 8</a> applies to navigation state.

## Crossing into background work: the object ID

A managed object belongs to the context that fetched it, and it is never handed to another context or returned out of `perform`. What crosses is its `NSManagedObjectID`, which is `Sendable`, and the other context resolves its own instance from it. The notebook's identity everywhere outside a context — a job's intent, an announcement's object, the environment registry from <a href="/guide/05-2-the-environment">Chapter 5.2</a> — is a thin wrapper around it:

```swift
// NotebookCore/Notebooks/NotebookID.swift
public struct NotebookID: Hashable, Sendable {
    let objectID: NSManagedObjectID
}

extension Notebook {
    public var id: NotebookID {
        precondition(!objectID.isTemporaryID, "A notebook's ID is handed out only after its first save")
        return NotebookID(objectID: objectID)
    }
}
```

An object inserted but not yet saved has a temporary ID, which no other context can resolve; it becomes permanent when the save reaches the persistent store. So whoever creates a notebook saves it before the ID leaves the manager, and the precondition makes forgetting that a crash in development instead of a lookup that quietly fails in a job. A permanent ID also survives relaunch through its `uriRepresentation()`, which is what window restoration (<a href="/guide/02-3-window-restoration">Chapter 2.3</a>) encodes.

Every step of a job that touches Core Data names the context it runs on, per <a href="/guide/05-4-jobs">Chapter 5.4</a>. The one helper the entity carries for that is the resolve helper from Chapter 5.1's list of statics: it takes the context as a parameter, so the call site still says where the work runs, and it saves the lookup every hop would otherwise repeat:

```swift
// NotebookCore/Notebooks/Notebook+Resolve.swift
extension Notebook {
    /// Resolves the notebook on `context` and runs `body` with it there. The notebook never leaves the closure;
    /// `body` returns a `Sendable` value.
    static func withNotebook<T: Sendable>(
        _ id: NotebookID,
        on context: NSManagedObjectContext,
        _ body: @escaping @Sendable (Notebook) throws -> T
    ) async throws -> T {
        try await context.perform {
            guard let notebook = try context.existingObject(with: id.objectID) as? Notebook else {
                throw NotebookError.notFound
            }
            return try body(notebook)
        }
    }
}
```

The async `perform` returns the closure's value and rethrows its error, so nothing is captured into an optional and checked afterwards. What it must not return is a managed object.

## Writes in the synced shape: the job saves, once

A refresh of a notebook's details from the server is the synced shape in full: check, fetch, store, each step a member of the entity, each hop on the context it names.

```swift
// NotebookCore/Notebooks/Jobs/RefreshNotebookJob.swift
struct RefreshNotebookJob: NoteJob, Hashable {
    let notebookID: NotebookID

    nonisolated func perform() async throws -> Bool {
        let context = NSManagedObjectContext.background
        guard let remoteID = try await Notebook.withNotebook(notebookID, on: context, { $0.remoteID }) else {
            return false                                       // never synced: nothing to refresh
        }
        try Task.checkCancellation()
        let details = try await SyncClient(config: .shared).notebookDetails(remoteID)
        try Task.checkCancellation()
        return try await Notebook.withNotebook(notebookID, on: context) { notebook in
            try context.saving { notebook.updateDetails(from: details) }    // the unit of work, and its one save
        }
    }

    @MainActor
    func finalize(_ result: Result<Bool, Error>) async throws {
        switch result {
        case .success(true):
            Notebook.notebookDidChange(notebookID)
        case .success(false):
            break
        case .failure(SyncError.unreachable):
            if Notebook.saveOffline(ofNotebookWith: notebookID, after: SyncError.unreachable) {
                Notebook.notebookDidChange(notebookID)
            }
        case .failure:
            break
        }
    }
}
```

The store step changes the notebook and saves inside one `perform` block. That is the unit of work landing as one write, and it is also what keeps the shared background context clean: no change is left unsaved on it when the block ends, so no other job's save can carry it along. The save merges onto the main context by itself, so `finalize` has nothing to apply — the first pattern in Chapter 5.4's table, with the database doing the merge — and announces only when the store step reported a change. A failure is recorded on the main context through a model helper, and the caller still sees the error `perform` threw.

Batch requests — `NSBatchInsertRequest`, `NSBatchUpdateRequest`, `NSBatchDeleteRequest` — are the one way around all of this, and they really are around it: they write to the store directly, skipping the entity's code, its validation and the contexts. A batch update can only set the same value on every matched object, and a batch insert cannot set relationships. Reach for them only for bulk work too large for the context, ask them for the affected object IDs, and merge those into both contexts yourself with `mergeChanges(fromRemoteContextSave:into:)`, because the automatic merge never sees them.

## Only the code that chose the context saves it

The rule from <a href="/guide/05-1-the-model">Chapter 5.1</a> — an entity may carry mutating methods, none of them saves — has a sharper reason in Core Data: `save()` commits everything pending on the context, not the changes of one object. `notebook.saveDetails(from:)` would read like it saves one notebook's details; on the shared background context it would commit whatever another unit of work had pending there too. An instance method runs on whatever context its object happens to live on, and it didn't choose that context, so it doesn't save it — not directly, and not through `context.saving { }` either. The code that chose the context saves it: the job on the background context it named, the manager on the main context, or a `save…` helper that picks its own (below).

The rule has a second half in Core Data. Assigning a property its current value still marks the object as changed, so `hasChanges` turns true, the next save writes it, and the save is merged into every other context. A sync that rewrites a few hundred unchanged notebooks that way turns a no-op refresh into a merge that hangs the main thread. So a mutating method compares before it assigns — which also gives it its return value for free:

```swift
// NotebookCore/Notebooks/Notebook+Sync.swift
extension Notebook {
    /// Updates the notebook from what the server reports, without saving. Assigns only what differs; returns whether anything did.
    func updateDetails(from details: NotebookDetails) -> Bool {
        var changed = false
        if title != details.title {
            title = details.title
            changed = true
        }
        if ownerName != details.ownerName {
            ownerName = details.ownerName
            changed = true
        }
        if syncState != .synced {
            syncState = .synced
            lastSyncError = nil
            changed = true
        }
        return changed
    }
}
```

It is a synchronous instance method with no `perform` inside — the caller is already on the context's queue. It touches only the notebook and what the notebook reaches through its relationships, posts nothing, does no I/O, and could throw for invalid input. It is named for the change it makes — `update…`, `mark…`, `apply…` — because `save…` is reserved for the helpers below. A store step with a late guard of its own — store nothing when the notebook was marked for removal while the request ran — keeps that guard in the model method and returns `nil` for "changed nothing on purpose"; the job still does the save around it. Avoid the version that saves itself, because it commits a context it didn't choose, the caller can no longer combine it with anything else, and it cannot tell a main context from a background one or a test's:

```swift
// Avoid — two of these in one unit of work are two writes, two merges and two announcements
func markOffline(after error: Error) throws {
    syncState = .offline
    try managedObjectContext?.save()
}
```

## The one static that saves

Sometimes several callers repeat the same look-up, change and save of one entity — recording a notebook as offline is done by the refresh job above and by every other sync job that can fail the same way. That earns a shared helper on the model: one more kind of static beside Chapter 5.1's queries, announcements and resolve helper, and the only code on the model that saves. It may save because it chooses its context itself: it resolves the object there and owns that unit of work, exactly as a job or manager does. It is a unit of work several callers reuse, not a second write path — callers still choose to call it, and a job saving its own unit of work keeps doing that itself with `context.saving { }`.

```swift
// NotebookCore/Notebooks/Notebook+Sync.swift
extension Notebook {
    /// Marks the notebook with `id` offline on the main context and saves it (see `markOffline(after:)`).
    /// Returns whether that changed the notebook; `false` when the notebook is gone or the save fails.
    @MainActor
    static func saveOffline(ofNotebookWith id: NotebookID, after error: Error) -> Bool {
        let context: NSManagedObjectContext = .main
        guard let notebook = try? context.existingObject(with: id.objectID) as? Notebook else {
            return false
        }
        return (try? context.saving { notebook.markOffline(after: error) }) ?? false
    }
}
```

Four rules keep it a helper rather than the ID-keyed operations Chapter 5.1 rules out:

- <strong>`save` is its verb</strong>, mirroring the instance method it wraps: `markOffline(after:)` becomes `saveOffline(ofNotebookWith:after:)`. Only a `save…` static saves; instance methods and `with…` resolve helpers never do.
- <strong>It takes the ID, never the object.</strong> An object already lives on a context the helper didn't choose; taking the ID is what lets the helper pick the context and resolve the object there. A helper that took the object would be an instance method in disguise.
- <strong>Isolation decides the context.</strong> A `@MainActor` helper takes no context and always works on the main context, synchronously — there is no hop to hide. Any other helper takes `on context:` without a default, is `async`, and runs in `context.perform`. A `@MainActor` helper with a context parameter, or a nonisolated one that reaches for the main context, is wrong.
- <strong>It returns what changed and posts nothing.</strong> The caller announces once the helper returns, as after any save — `finalize` above does.

Don't wrap a one-off store step in a `save…` static just to keep the save out of a job. The job is where its own unit of work is saved.

## Normalisation and validation

An invariant that must hold however the object was changed — whitespace trimmed, an identifier assigned — goes in `willSave`, which runs as part of whoever's save and not instead of it. Compare before writing there too, and write through the primitive accessor: setting a property normally inside `willSave` registers a change, which calls `willSave` again, until the app crashes.

```swift
// NotebookCore/Templates/NoteTemplate.swift
public override func willSave() {
    super.willSave()
    guard !isDeleted else { return }
    let trimmed = title.trimmingCharacters(in: .whitespaces)
    if trimmed != title {
        setPrimitiveValue(trimmed, forKey: "title")
    }
}
```

Validation of a value in itself belongs to Core Data, where it runs on every save from every source. Declare what the model editor can express first — required attributes, minimum and maximum values, string lengths, patterns. A rule across several properties of one object goes in `validateForInsert()` and `validateForUpdate()`: collect the superclass's errors first, unpacking `NSValidationMultipleErrorsError` into its `NSDetailedErrorsKey` list, run every custom check collecting rather than throwing, and throw one error with all of them, so the user sees every problem at once. Each error is an `NSError` in an entity-specific domain with a code from an enum, carrying `NSValidationKeyErrorKey`, `NSValidationObjectErrorKey`, `NSValidationValueErrorKey` and a localized description. A rule that depends on the operation — what may be renamed, what a user may delete — is the manager's, or the Action validator's from <a href="/guide/06-3-action-validation">Chapter 6.3</a>, not the entity's.

## The main-thread shape in Core Data

`NoteTemplate` from <a href="/guide/05-7-model-shapes">Chapter 5.7</a> keeps its shape — no job, no runner, a synchronous manager on the main thread — and loses its store: the template is an entity on the main context, and the manager is the one place its context is saved.

```swift
// NotebookCore/Templates/NoteTemplate.swift
@objc(NoteTemplate)
public final class NoteTemplate: NSManagedObject {
    @NSManaged public internal(set) var title: String
    @NSManaged public internal(set) var body: String

    @nonobjc static func fetchRequest() -> NSFetchRequest<NoteTemplate> {
        NSFetchRequest(entityName: "NoteTemplate")
    }

    // willSave(), as above
}
```

```swift
// NotebookCore/Templates/TemplateManager.swift — the funnel, synchronous and throwing, on the main context
@MainActor
public final class TemplateManager {
    public static let shared = TemplateManager()
    private var context: NSManagedObjectContext { .main }

    @discardableResult
    public func create(title: String, body: String) throws -> NoteTemplate {
        try requireTitle(title)
        let template = try context.saving {
            let template = NoteTemplate(context: context)
            template.title = title
            template.body = body
            return template
        }                                         // saved: its ID is permanent from here on
        NoteTemplate.templatesDidChange()
        return template
    }

    public func rename(_ template: NoteTemplate, to title: String) throws {
        try requireTitle(title)
        guard template.title != title else { return }      // nothing changed, nothing to save or announce
        try context.saving { template.title = title }
        NoteTemplate.templatesDidChange()
    }

    public func delete(_ template: NoteTemplate) throws {
        try context.saving { context.delete(template) }
        NoteTemplate.templatesDidChange()
    }

    private func requireTitle(_ title: String) throws {
        guard !title.trimmingCharacters(in: .whitespaces).isEmpty else { throw TemplateError.emptyTitle }
    }
}
```

The queries are `NoteTemplate.all()` and `NoteTemplate.template(id:)` over the main context, exactly like `Notebook`'s. Everything is on the main actor, so the manager takes the template itself rather than an ID; the ID matters only once something outside the main context needs to find the template. The change signal is still the announcement after the save, not the context's own objects-did-change notification, which fires for every unsaved edit and every merge on the context and says nothing about which model changed. The day a second writer appears that is not the user — templates syncing between devices — the template graduates to the synced shape: its writes move into jobs on the background context, and the manager becomes one `enqueue` per method.

## Testing on the in-memory stack

`TestCase` from <a href="/guide/09-5-inside-a-test-class">Chapter 9.5</a> calls `PersistentStack.configure(storeURL: nil)`, so every test gets a fresh in-memory store with both contexts merging as in production. After a job's `await` returns, its background save has already landed on the main context, and the test asserts through the query with no refresh.

A save-free mutating method is tested on the object, on the main context, asserting on the object and what the method returned rather than on a save — including the half of the rule that is easy to break silently:

```swift
@MainActor
final class NotebookSyncTests: TestCase {
    func testUpdateDetails_SameValues() throws {
        let notebook = try Notebook.make(title: "Journal", ownerName: "Sam")    // saved, so it starts clean

        let changed = notebook.updateDetails(from: NotebookDetails(title: "Journal", ownerName: "Sam"))

        XCTAssertFalse(changed)
        XCTAssertFalse(notebook.hasChanges)
    }

    func testUpdateDetails_NewTitle() throws {
        let notebook = try Notebook.make(title: "Journal")

        let changed = notebook.updateDetails(from: NotebookDetails(title: "Diary", ownerName: notebook.ownerName))

        XCTAssertTrue(changed)
        XCTAssertEqual(notebook.title, "Diary")
    }
}
```

The decisions a job against the server makes — the check, the store step, what `finalize` records after a failure through `saveOffline(ofNotebookWith:after:)` — take plain data and are tested on the model the same way, so nothing has to mock the server to reach `perform`. A store step that reconciles stored data with a fetched list is tested from the stored state it changes, created directly by the test rather than by running the store step once. Cascades, both sides of a relationship and validation errors are tested through the model's API against the same stack; <a href="/guide/09-6-testing-each-layer">Chapter 9.6</a> shows those.

<div class="rule">
<span class="rule-label">The rules</span>

<strong>The entity is the model, and it stays in its context.</strong> Queries fetch on the main context, live. A managed object never crosses into another context or out of `perform`; its permanent object ID does, and is handed out only after the object's first save. Jobs run on a sibling background context, never a child one, and name it at every hop.

<strong>Only the code that chose the context saves it.</strong> The job saves the background context it named, once per unit of work; the manager saves the main context in the main-thread shape. Mutating methods on the entity never save, are named for the change, assign only what differs, and return what changed. The one exception on the model is a shared `save…` static, which may save because it takes an ID and picks its context itself, and leaves the announcement to its caller.

<strong>Invariants in the entity, operations in the manager.</strong> `willSave` normalises through primitive accessors; Core Data's validation checks values; whatever depends on the operation stays with the manager or the Action's validator. The change signal is the model's announcement after the save, as for every other backend.

</div>

<div class="seealso">
<strong>Ahead in this guide</strong>
That completes the Model layer. What actually calls into a manager — and how a write earns the overhead of a full Action — is <a href="/guide/06-actions-and-controllers">Chapter 6</a>, next. The view state controller that turns a query's entities into what a view reads is <a href="/guide/07-2-view-state">Chapter 7.2</a>.
</div>
