---
title: "The Environment"
description: "A domain whose managers and jobs share resources has one root object that owns them, and nothing outside the model package ever sees it. This subchapter covers the environment — what it owns, what it deliberately is not, the one file that decides a notebook's object graph, the registry behind the flat accessors callers actually use, and how a test builds a private graph of its own."
order: 5
subOrder: 2
---

A domain whose managers and jobs share resources has one root object that owns them, and nothing outside the model package ever sees it. This subchapter covers the environment — what it owns, what it deliberately is not, the one file that decides a notebook's object graph, the registry behind the flat accessors callers actually use, and how a test builds a private graph of its own.

## One root per domain, one per key

A domain whose managers and jobs share resources — a runner that orders their work, a store they write into, the progress state they report to — has one root object that owns those resources: the domain's <strong>environment</strong>. It exists once per app when the resources are app-wide, and once per <em>key</em> when they aren't. In the notebook app the key is the notebook: every notebook has its own storage, its own queue of pending work and its own sync progress, so every notebook has its own `NotebookEnvironment`, and the flat accessor from <a href="/guide/02-5-object-wiring">Chapter 2.5</a> takes the key — `NoteManager.shared(for: notebook)`.

The environment is invisible to everyone who uses the model layer. A caller reaches `NoteManager.shared(for: notebook)`, `Tag.counts(in: notebook)` or `NoteActivities.shared(for: notebook)` and never learns that one object behind all three holds the graph together. The type has no public members, it is never passed as a parameter, and no Action, controller or view names it. It is a root that keeps references alive in the background — nothing more.

Two things an environment is not. It is not a wrapper: a root object that merely holds a config, a store and a manager and forwards to them is the shape Chapter 2.5 bans, because it adds a layer without adding behavior. An environment earns its place by owning resources that several managers and every job genuinely share. And it is not a worker: it provides, it never performs. The only functions on it manage the objects it holds. A method on the environment that fetches notes or saves one is a manager function in the wrong place.

## The class file

```swift
// NotebookCore/Environment/NotebookEnvironment.swift
@MainActor
final class NotebookEnvironment {
    let notebook: Notebook
    let runner = SerialTaskRunner()        // one per notebook, shared by every manager in it — Chapter 5.5
    let store: NoteStore                   // the main-actor model the queries read
    let activities = NoteActivities()      // every progress sink for this notebook — Chapter 5.6
    let workContext: NoteWorkContext       // what a job's perform() sees — built once, Chapter 5.4
    let mainContext: NoteMainContext       // what its main-actor handlers see — built once

    lazy var noteManager = NoteManager(environment: self)
    lazy var tagManager = TagManager(environment: self)
    lazy var suggestionManager = SuggestionManager(environment: self)   // Chapter 5.7

    // Internal: the package boundary hides it from the app; a test in the package builds one over its own notebook.
    init(notebook: Notebook, client: SyncClient, assistant: AssistantClient) {
        self.notebook = notebook
        self.store = notebook.notes
        self.workContext = NoteWorkContext(
            notebookID: notebook.id,
            storage: notebook.notes.storage,
            files: notebook.files,
            client: client,
            assistant: assistant
        )
        self.mainContext = NoteMainContext(notebook: notebook, store: notebook.notes, activities: activities)
    }
}
```

The `init` is the one place the notebook's graph is decided: which managers share the runner, what the jobs may see, where the store writes. Managers hold the environment strongly and reach everything through it. Nothing outside constructs a manager — the environment builds its managers and keeps them, which makes the graph a reference cycle by design. That is fine, because an environment is never torn down once created: in production the registry holds it for the life of the process, in a test it lives until the test ends.

The two clients in the initializer — the sync client and the assistant client — are the external boundaries the notebook's jobs talk to. They are parameters precisely so a test can hand in one built over a stubbed session; everything else in the graph is constructed from the notebook itself.

## The registry and the public surface

The registry and the accessors live in a second file, so the class file is exactly what a test constructs and the extension file is exactly what production reaches. The accessors are the whole public surface of the domain — the only `public` declarations in the package are on the managers, the models and the activities, never on the environment:

```swift
// NotebookCore/Environment/NotebookEnvironment+Shared.swift

// MARK: - The production registry, one environment per notebook for the life of the process

extension NotebookEnvironment {
    private static var environments: [NotebookID: NotebookEnvironment] = [:]

    static func shared(for notebook: Notebook) -> NotebookEnvironment {
        if let existing = environments[notebook.id] { return existing }
        let environment = NotebookEnvironment(
            notebook: notebook,
            client: SyncClient(config: .shared),
            assistant: AssistantClient(config: .shared)
        )
        environments[notebook.id] = environment
        return environment
    }
}

// MARK: - The public surface, one-liners forwarding into the registry

extension NoteManager {
    /// The one manager for this notebook. The only way any caller ever gets one.
    static func shared(for notebook: Notebook) -> NoteManager {
        NotebookEnvironment.shared(for: notebook).noteManager
    }
}

extension TagManager {
    static func shared(for notebook: Notebook) -> TagManager {
        NotebookEnvironment.shared(for: notebook).tagManager
    }
}

extension SuggestionManager {
    static func shared(for notebook: Notebook) -> SuggestionManager {
        NotebookEnvironment.shared(for: notebook).suggestionManager
    }
}

extension NoteActivities {
    static func shared(for notebook: Notebook) -> NoteActivities {
        NotebookEnvironment.shared(for: notebook).activities
    }
}
```

There is deliberately no second way to get a manager — no public initializer, no factory for tests. A manager's initializer takes the environment and is internal, so a second instance cannot exist outside the package, and inside it only the environment constructs one. That is the one-funnel guarantee made structural: there is exactly one `NoteManager` per notebook because there is exactly one object that can build it.

Tests live inside the package, so they construct the environment directly — `NotebookEnvironment(notebook:client:assistant:)` over the test's own notebook, with clients whose sessions are stubbed — and reach `environment.noteManager`, `environment.tagManager` and `environment.workContext` from the object they hold. Nothing in the production registry is touched, and a test that needs two managers has them both from the one graph it built. <a href="/guide/09-6-testing-each-layer">Chapter 9.6</a> shows the test side, including the one-line factory that wraps the construction.

## App-wide pieces stay flat

Only the genuinely per-notebook components go through the environment. `SyncConfig`, `SyncStore` and `SyncManager` from Chapter 2.5 describe the account — signed in or not, the last sync, the base URL — and there is one account, so they are reached as `.shared`. `TemplateManager` in <a href="/guide/05-7-model-shapes">Chapter 5.7</a> manages note templates, which belong to the user rather than to a notebook, and it is a plain shared static too. The environment is for resources that several managers and every job share <em>per key</em>; an app-wide manager with no runner to share is just a shared instance.

<div class="rule">
<span class="rule-label">The rule</span>

The environment provides; it never performs. It owns the runner, the store, the activities and the two job contexts, builds its managers and keeps them, and exposes nothing that does work. Nothing outside the model package names it: callers see only the flat `shared(for:)` accessors, and a manager has no other way to come into existence. Its `init` is internal and is the only place the domain's graph is decided; its registry lives in an extension and is the only thing production touches.

</div>

<div class="seealso">
<strong>Ahead in this chapter</strong>
The managers the environment builds — their public surface, the private plumbing underneath it, and the one thing they must never do — are next: <a href="/guide/05-3-the-manager">Chapter 5.3, The Manager</a>.
</div>
