---
title: "The Environment"
description: "A domain whose managers share resources has one root object that owns them, and nothing outside the model package ever sees it. This subchapter covers the environment — what it owns, what it deliberately is not and what it never hands to a job, the one file that decides a notebook's object graph, the registry behind the flat accessors callers actually use, and how a test builds a private graph of its own."
order: 5
subOrder: 2
---

A domain whose managers share resources has one root object that owns them, and nothing outside the model package ever sees it. This subchapter covers the environment — what it owns, what it deliberately is not and what it never hands to a job, the one file that decides a notebook's object graph, the registry behind the flat accessors callers actually use, and how a test builds a private graph of its own.

## One root per domain, one per key

A domain whose managers share resources — a runner that orders their work, a store they write into — has one root object that owns those resources: the domain's <strong>environment</strong>. It exists once per app when the resources are app-wide, and once per <em>key</em> when they aren't. In the notebook app the key is the notebook: every notebook has its own storage and its own queue of pending work, so every notebook has its own `NotebookEnvironment`, and the flat accessor from <a href="/guide/02-5-object-wiring">Chapter 2.5</a> takes the key — `NoteManager.shared(for: notebook)`.

The environment is invisible to everyone who uses the model layer. A caller reaches `NoteManager.shared(for: notebook)` or `Tag.counts(in: notebook)` and never learns that one object behind both holds the graph together. The type has no public members, it is never passed as a parameter, and no Action, controller or view names it. It is a root that keeps references alive in the background — nothing more.

Three things an environment is not. It is not a wrapper: a root object that merely holds a config, a store and a manager and forwards to them is the shape Chapter 2.5 bans, because it adds a layer without adding behavior. An environment earns its place by owning resources that several managers genuinely share — one runner, one store. It is not a worker: it provides, it never performs. The only functions on it manage the objects it holds. A method on the environment that fetches notes or saves one is a manager function in the wrong place. And it is not a supplier for jobs: <strong>it hands jobs nothing</strong>. A job carries its intent — including the notebook it works on — and reaches the client, the storage and the store it needs from that intent itself, where the hop is visible (<a href="/guide/05-4-jobs">Chapter 5.4</a>). An environment that built a bag of dependencies for each family of jobs would grow back exactly what jobs are meant to do without.

## The class file

```swift
// NotebookCore/Environment/NotebookEnvironment.swift
@MainActor
final class NotebookEnvironment {
    let notebook: Notebook
    let runner = SerialTaskRunner()        // one per notebook, shared by every manager in it — Chapter 5.5
    let store: NoteStore                   // the main-actor model the queries read

    lazy var noteManager = NoteManager(environment: self)
    lazy var tagManager = TagManager(environment: self)
    lazy var suggestionManager = SuggestionManager(environment: self)   // Chapter 5.7

    // Internal: the package boundary hides it from the app; a test in the package builds one over its own notebook.
    init(notebook: Notebook) {
        self.notebook = notebook
        self.store = notebook.notes
        Self.register(self)   // every environment that exists is findable by its notebook's ID — see below
    }
}
```

The `init` is the one place the notebook's graph is decided: which managers share the runner, which store they write into. Managers hold the environment strongly and reach the runner through it. Nothing outside constructs a manager — the environment builds its managers and keeps them, which makes the graph a reference cycle by design. That is fine, because an environment is never torn down once created: in production the registry holds it for the life of the process, in a test it lives until the test ends.

The initializer takes nothing but the notebook. The external boundaries the notebook's jobs talk to — the sync client, the assistant, the notebook's folder on disk — are not in it, and neither is anything a job would otherwise be handed. Each job builds the client it needs inside its own `perform`, from configuration that is already app-wide, which is also why a test needs no constructor parameter to stub one.

## The registry and the public surface

The registry and the accessors live in a second file, so the class file is exactly what a test constructs and the extension file is exactly what production reaches. The accessors are the whole public surface of the domain — the only `public` declarations in the package are on the managers and the models, never on the environment:

```swift
// NotebookCore/Environment/NotebookEnvironment+Shared.swift

// MARK: - The registry, one environment per notebook for the life of the process

extension NotebookEnvironment {
    private static var environments: [NotebookID: NotebookEnvironment] = [:]

    /// Called by `init` only, so an environment a test builds is found by its notebook's ID exactly like one
    /// production built.
    static func register(_ environment: NotebookEnvironment) {
        precondition(environments[environment.notebook.id] == nil, "A second environment for one notebook")
        environments[environment.notebook.id] = environment
    }

    static func shared(for notebook: Notebook) -> NotebookEnvironment {
        environments[notebook.id] ?? NotebookEnvironment(notebook: notebook)
    }

    /// Finds the environment of a notebook that is already open. An ID can only find one, never create one:
    /// it carries nothing to build an environment from, and a job holding the ID was enqueued through one.
    static func existing(for notebookID: NotebookID) -> NotebookEnvironment {
        guard let environment = environments[notebookID] else {
            preconditionFailure("No environment for notebook \(notebookID)")
        }
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

// MARK: - Inside the package, what a job's finalize reaches from the ID it carries

extension NoteStore {
    static func shared(for notebookID: NotebookID) -> NoteStore {
        NotebookEnvironment.existing(for: notebookID).store
    }
}
```

The last accessor is the one a job uses. A job is a `Sendable` value that stores the notebook's ID, not the notebook, so its main-actor `finalize` finds the store it applies to through `NoteStore.shared(for: notebookID)` — internal, because only the package's own jobs need it, and find-only, because a job that exists was enqueued through an environment that exists. Production code that holds a `Notebook` keeps going through `shared(for: notebook)`, the one accessor that may build an environment.

That is also why `init` registers the environment it builds instead of leaving registration to `shared(for:)`. A job's `finalize` finds its store by ID whoever built the environment, and a test builds its own: if only the production accessor registered, every job in a test would look for an environment that was never recorded. Registering in `init` keeps one rule — every environment that exists is findable by its notebook's ID, and there is at most one per notebook — and a test stays isolated from the production graph because its notebook has an ID nothing else uses.

There is deliberately no second way to get a manager — no public initializer, no factory for tests. A manager's initializer takes the environment and is internal, so a second instance cannot exist outside the package, and inside it only the environment constructs one. That is the one-funnel guarantee made structural: there is exactly one `NoteManager` per notebook because there is exactly one object that can build it.

Tests live inside the package, so they construct the environment directly — `NotebookEnvironment(notebook:)` over the test's own notebook in a temporary storage root — and reach `environment.noteManager` and `environment.tagManager` from the object they hold. Its jobs run against real external boundaries: a temporary notebook folder, a sync session stubbed at the HTTP layer through the sync configuration, the storage root. A test that needs two managers has them both from the one graph it built. <a href="/guide/09-6-testing-each-layer">Chapter 9.6</a> shows the test side.

## App-wide pieces stay flat

Only the genuinely per-notebook components go through the environment. `SyncConfig`, `SyncStore` and `SyncManager` from Chapter 2.5 describe the account — signed in or not, the last sync, the base URL — and there is one account, so they are reached as `.shared`. `TemplateManager` in <a href="/guide/05-7-model-shapes">Chapter 5.7</a> manages note templates, which belong to the user rather than to a notebook, and it is a plain shared static too. The app's activity store from <a href="/guide/05-6-progress-and-activities">Chapter 5.6</a> holds the live runs of every notebook at once, so it is a plain shared static as well: a job's main-actor `handle` reaches `ActivityStore.shared` directly, and the environment holds no activities. The environment is for resources that several managers share <em>per key</em>; an app-wide manager with no runner to share is just a shared instance.

<div class="rule">
<span class="rule-label">The rule</span>

The environment provides; it never performs. It owns the runner and the store, builds its managers and keeps them, hands jobs nothing, and exposes nothing that does work. Nothing outside the model package names it: callers see only the flat `shared(for:)` accessors, and a manager has no other way to come into existence. Its `init` is internal, is the only place the domain's graph is decided, and registers the environment it builds, so a job finds its notebook's store by ID whether production or a test built the graph.

</div>

<div class="seealso">
<strong>Ahead in this chapter</strong>
The managers the environment builds — their public surface, the private plumbing underneath it, and the one thing they must never do — are next: <a href="/guide/05-3-the-manager">Chapter 5.3, The Manager</a>.
</div>
