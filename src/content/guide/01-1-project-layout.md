---
title: "Project Layout"
description: "The four layers become folders. This subchapter covers the shape of an Airframe project on disk — which layers are Swift packages, the six roots of the app target and the one question each answers, the rules for deciding where a file goes, and when a self-contained feature may keep its own model and views together in one folder."
order: 1
subOrder: 1
---

The four layers become folders. This subchapter covers the shape of an Airframe project on disk — which layers are Swift packages, the six roots of the app target and the one question each answers, the rules for deciding where a file goes, and when a self-contained feature may keep its own model and views together in one folder.

## The tree mirrors the layers

The layout is the layer diagram from <a href="/guide/01-getting-started">Chapter 1</a> turned into directories, and two decisions give it its shape.

<strong>The Foundation/AppKit boundary is a package boundary.</strong> The Model layer and the Actions layer are local Swift packages — `NotebookCore` and `NotebookActions` — committed with the app, never versioned, never published. A package cannot import the app, so the compiler, not a code review, keeps AppKit out of the two layers that must never see it. Everything above the line stays in the app target. The one Foundation-only kind that stays in the app target is the view state controller, because it belongs to exactly one screen and lives next to it; its tests run from the app test target's mirror.

<strong>At the root, directory means layer; below the root, directory means domain.</strong> The app target has six roots, and each answers one question about the code inside it. Inside a root, folders are named after what they are about — `Notes/`, `Sync/`, `NoteList/` — never after a pattern. There is no `Library/`, `Utilities/`, `Helpers/` or `Common/` anywhere in the app target. Generic code goes to a package, where the compiler physically prevents app types from leaking in; everything that fails that test has a domain.

## The target tree

Here is the notebook app on disk, every type the chapters define placed where it belongs, with the chapter that introduces each one:

```
NotebookApp/
├── Packages/                        local-only Swift packages: in-repo, committed with the app
│   ├── Concurrency/                 SerialTaskRunner, BackgroundJob, ProgressReportingJob   7
│   ├── TestSupport/                 StubURLProtocol, temp directories                       10.4
│   ├── NotebookSync/                SyncClient — the library below the model                5
│   ├── MarkdownImport/              another library below the model
│   ├── NotebookCore/                THE MODEL LAYER                                          5
│   │   ├── Sources/NotebookCore/
│   │   │   ├── Notes/               Note, NoteManager, NoteStore, Note+Queries
│   │   │   │   └── Jobs/            PullNotesJob, RenameNoteJob, DraftSummaryJob, …         5, 7
│   │   │   ├── Notebooks/           Notebook, NotebookManager, NotebookStore, ExportManager
│   │   │   ├── Tags/                Tag, TagManager, LoadTagIndexJob
│   │   │   ├── Sync/                SyncManager, SyncStore, SyncConfig, SyncState           2.5, 5
│   │   │   └── Persistence/         the database stack PersistenceInitializer opens
│   │   └── Tests/NotebookCoreTests/ NotebookCore/ mirror + Factories/ + Support/            10.3
│   └── NotebookActions/             ACTIONS AND VALIDATORS, depends on NotebookCore          6.1, 6.3
│       ├── Sources/NotebookActions/
│       │   ├── Action, ActionStatus, ActionManager, ActionValidator
│       │   ├── Notes/               MoveNoteAction, DeleteNoteAction
│       │   ├── Notebooks/           CreateNotebookAction, RenameNotebookAction, DeleteNotebookValidator, …
│       │   └── Tags/                DeleteTagAction
│       └── Tests/NotebookActionsTests/
│
├── NotebookApp/                     app target — six roots, one question each
│   ├── App/                         "What is the program?"                                  2
│   │   ├── Application/             AppDelegate                                             2.1
│   │   ├── Init/                    AppInitializing and the initializer chain               2.2
│   │   ├── Startup/                 AppController, AppStatus, StartupController             2.2
│   │   ├── WindowRestoration/       WindowRestorationController, RestoredWindow             2.3
│   │   ├── Settings/                EditorSettings                                          2.4
│   │   ├── Updates/                 what UpdatesInitializer configures
│   │   └── Runtime/                 the BackgroundController protocol                       4
│   ├── ActionControllers/           "How does a gesture become an operation?"               6.2
│   │   ├── Notes/                   NoteActionController
│   │   └── Notebooks/               NotebookActionController
│   ├── BackgroundControllers/       "What keeps the app current with no gesture behind it?" 4
│   │                                StaleDraftReaper, TagUsageProjector
│   ├── Integrations/                "What does the app bridge to outward?"
│   │                                the user's tools and OS surfaces — a URL scheme handler feeding Chapter 9 would be the first occupant
│   ├── UI/                          "What does the user see?"                               8
│   │   ├── ActionSenderValidation/  ActionSenderValidator, NotebookActionSenderValidator    6.3
│   │   ├── Menus/                   NotebookMenuController, NSMenuItem+Values               8.5
│   │   ├── Navigation/              NotebookNavigationState                                 9
│   │   ├── Screens/                 one folder per screen; the read path lives WITH its screen
│   │   │   ├── Workspace/           WorkspaceViewController                                 9
│   │   │   ├── Sidebar/             NotebookSidebarViewController, NotebookSidebarController, NotebookListStateController + NotebookListState   8.4
│   │   │   ├── NoteList/            NoteListViewController, NoteListStateController + NoteListState, NoteListView, NoteRowState   8.4
│   │   │   ├── NoteDetail/          NoteDetailViewController, NoteDetailStateController + NoteDetailState, NoteEditorView, TagFilterButtonController   8.1, 8.2
│   │   │   ├── Search/              NoteSearchController                                    7
│   │   │   └── Preferences/         PreferencesView                                         2.4
│   │   ├── Shared/                  SyncStatusView, SyncStatusViewController, UnsyncedBadgeView
│   │   └── Support/                 view styles, input validators, display formatters
│   └── Resources/
│
└── NotebookAppTests/                mirror of the app target                                10.3
    ├── NotebookApp/UI/Screens/NoteList/   NoteListStateControllerTests
    └── Factories/  Resources/  Support/  Live/  Performance/
```

A few placements are worth spelling out, because each is a rule in miniature:

- <strong>The sync stack splits across three levels.</strong> `SyncClient` builds requests and decodes payloads and knows nothing above itself, so it is a library below the model. `SyncManager`, `SyncStore` and the jobs are the model. The badge and the status view are UI. That is the same shape as any API or command-line wrapper under a domain manager under a screen.
- <strong>Jobs live next to the manager that enqueues them,</strong> with their result contexts, not in a `Jobs/` folder at the package root.
- <strong>Validators live with the Actions they guard,</strong> in the Actions package. The action sender validators are AppKit and stay in `UI/`.
- <strong>`NoteSearchController` is a view state controller</strong> that happens to demonstrate cancel-and-replace in <a href="/guide/07-concurrency">Chapter 7</a>, so it goes with its screen.
- <strong>A state controller and its model share a file.</strong> `NoteDetailStateController.swift` declares both `NoteDetailStateController` and `NoteDetailState`, so `fileprivate(set)` makes the controller the model's only writer — <a href="/guide/08-2-view-state">Chapter 8.2</a>. The file is named for the controller; the model is what the screen's views receive.
- <strong>`SyncStatusViewController` is in `Shared/`</strong> because <a href="/guide/08-3-view-controllers">Chapter 8.3</a> embeds it in other screens; it is a component, not a screen.
- <strong>`BackgroundControllers/` has no test mirror.</strong> The work each controller dispatches is a manager function, tested in the model package.

## Why the roots look like this

<strong>`ActionControllers/` and `BackgroundControllers/` are root-level because they are layers.</strong> They are the two coordination kinds that sit above the boundary — the mutate path's dialog-and-dispatch object from <a href="/guide/06-2-action-controllers">Chapter 6.2</a>, and the no-gesture object from <a href="/guide/04-background-controllers">Chapter 4</a>. The read path's coordination object, the view state controller, is screen-specific and lives with its screen. `BackgroundControllers/` has a second job the layer diagram doesn't show: it is the complete list of what phase 4 of launch starts, in one place.

<strong>`App/` is <a href="/guide/02-the-app-environment">Chapter 2</a> made into a folder.</strong> The delegate, the initializer chain, the startup gates, restoration, settings — plus the product concerns that talk to <em>your own</em> infrastructure: the update feed, the crash reporter, analytics. Talking to a server does not make something an integration.

<strong>`Integrations/` is the outward bridges.</strong> The litmus test: the app launches and works without it, and unplugging it disconnects a feature, not the product. Who is on the other end decides where it goes. The user's environment or an OS surface — their external editor, Spotlight, notification center, Shortcuts — is an integration. Your own product infrastructure is `App/`.

<strong>`UI/` holds everything that renders, and everything that shapes state for rendering.</strong> Views, view controllers, view state controllers and the view state models they write, menus, navigation state, drag and drop. `Screens/` is one folder per screen. `Shared/` is the reusable visual components — base dialogs, badges, chips. `Support/` is the logic-heavy helpers that serve the UI without being visual: styles, input validators, display formatters.

## Deciding where a file goes

<div class="table-wrap">
<table>
<thead><tr><th>Question</th><th>Answer</th></tr></thead>
<tbody>
<tr><td><strong>Core or Actions?</strong></td><td>Defines entities, stores, managers, jobs or queries &rarr; <code>NotebookCore</code>. Performs one user-triggered operation with a lifecycle, or validates whether one may run &rarr; <code>NotebookActions</code>. The manager-function-versus-Action test in <a href="/guide/06-1-actions">Chapter 6.1</a> decides between them.</td></tr>
<tr><td><strong>App or Integrations?</strong></td><td>Who is on the other end? The user's environment or an OS surface &rarr; <code>Integrations/</code>. Your own product infrastructure &rarr; <code>App/</code>. "Talks to something outside the process" is not the test — half of <code>App/</code> talks to servers.</td></tr>
<tr><td><strong>App or UI?</strong></td><td>Infrastructure the app needs that isn't visual &rarr; <code>App/</code>. Contains a view, a view controller or a view state controller &rarr; <code>UI/</code>.</td></tr>
<tr><td><strong>Is it a background controller?</strong></td><td>The controller itself &rarr; <code>BackgroundControllers/</code>. Anything inside it worth testing is a collaborator waiting to be extracted &rarr; its domain, in Core, <code>Integrations/</code> or <code>App/</code>. If the controller would need a test, the split is wrong.</td></tr>
<tr><td><strong>Screens, Shared or Support?</strong></td><td>Specific to one screen &rarr; <code>UI/Screens/&lt;Screen&gt;/</code>. A reusable visual component &rarr; <code>UI/Shared/</code>. A logic-heavy helper that serves the UI but isn't visual &rarr; <code>UI/Support/</code>.</td></tr>
<tr><td><strong>Package or app target?</strong></td><td>The library test: could this file move to a package without dragging an app type with it? Yes &rarr; a package. No &rarr; it isn't library code; it has a domain, find it. The app target deliberately has nowhere generic to put things.</td></tr>
</tbody>
</table>
</div>

The cost of sorting by layer at the root is that one capability is found in several places — notes have a folder under Actions, under ActionControllers and under Screens. Two things keep that navigable. Use the <strong>same domain folder name under every root</strong>, so the reader who knows one location can guess the others. And let a component that is genuinely self-contained stay together, under the rule below.

## Features: when a component keeps its own model

Some components are isolated enough that splitting them by layer only scatters them. A <strong>feature</strong> is a folder that owns everything one capability needs — its model, its controllers, its validators and its views — arranged by layer inside the folder and reachable from outside only through its facade file. The term is <em>feature</em>, not <em>component</em>, because <a href="/guide/08-1-views">Chapter 8.1</a> already uses "view component" for an `NSView` piece.

A feature may stay vertical only if all four conditions hold:

1. <strong>One facade file.</strong> Every type that code outside the folder may name is declared in a single file, `<Feature>/<Feature>.swift` — typically the entry controller plus the plain value types its API takes. Nothing else in the folder is referenced from outside it: no manager, store, state object, view, validator or notification name.
2. <strong>The removal test.</strong> Delete the folder and the facade's call sites. The app compiles and every other feature works.
3. <strong>Layered inside.</strong> Vertical means co-located, not unlayered. Model files are Foundation-only, views render state and emit intents, controllers decide when and never how. A feature may own a background controller, an action controller, even an Action if only the feature dispatches it. Its model and validators are tested; its controllers and views are not. The feature is the four-layer architecture at small scale, with a wall around it.
4. <strong>No package consumer.</strong> Nothing in `NotebookCore` or `NotebookActions` names any of its types. The compiler enforces this for free while the folder lives in the app target.

"Its own model" means private state, not a second source of truth. The feature's model is what nothing outside it reads. It may read the app's Model layer downward, through `NoteManager.shared` like any other code. It may never hold state that another feature displays, because the only way that state could get out is through a channel the facade rule forbids. State that two features need is app model and belongs in Core.

A feature lives under the root whose question it answers — `App/Telemetry/`, `UI/Screens/QuickOpen/`, `Integrations/ExternalEditor/`. There is deliberately no `Features/` root: vertical is a property a folder earns, not a place it goes to. The folder is flat until it needs layers, and then its subfolders are the layer names:

```
QuickOpen/
  QuickOpen.swift             facade: QuickOpenController + the value types its API takes
  Model/                      QuickOpenItem, QuickOpenIndex, the item loaders — Foundation-only
  Validators/
  Controllers/                action, background and view state controllers
  Views/                      window controller, view controller, views
```

<strong>When the facade breaks, never widen it.</strong> The moment a second place needs a type from inside the folder, there are exactly two outcomes. If the type is a plain value that belongs to the boundary — an event enum, an identifier — it moves into the facade file. If it is something other code computes with, it sinks to Core or Actions and the rest of the feature stays vertical. The finished shape of that split is one component name across both trees: `NotebookCore/Sync/` holding the model, `UI/Shared/` holding the badge.

<strong>Promotion.</strong> When a feature earns its own test target, or a second target such as a command-line helper needs it, it becomes a local package. Then the compiler runs the facade rule instead of a script: `internal` is the default, and only the facade file is `public`.

The facade rule is a lint, not a convention. For every folder containing a `<Folder>.swift`, list the types it declares, grep for them outside the folder, and fail on any hit not declared in the facade file. That check is a few lines of script and it is what keeps a feature folder from turning into the junk drawer the layout has no other place for.

## Two starting points

<strong>A new app</strong> creates `NotebookCore` as an empty local package before any production code exists. The scaffold costs nothing, the dependency direction is executable immediately, and the boundary is cheapest to hold before anything has crossed it. Create `NotebookActions` when the first Action appears, not before: an app whose writes are all instant, local and without a failure mode the user can act on — the case <a href="/guide/06-1-actions">Chapter 6.1</a> says needs no Action — would carry an empty package for nothing. Put the package tests on the CI path the same day; adding a package product to the app does not make its tests run.

<strong>An existing app</strong> keeps the same tree with `Model/` and `Actions/` as folders at the app-target root in place of the two packages, guarded by a lint rule that forbids `import AppKit`, `import Cocoa` and `import SwiftUI` under those paths. Then it migrates one dependency-closed vertical slice at a time — a leaf model cluster plus its tests into `NotebookCore`, then the Action and validator that use it into `NotebookActions` — making `public` only the API current callers consume. Never a big-bang move. Never `public` on everything to get a package compiling. Never a change to concurrency or persistence behavior in the same commit as a module move. A grep for app-target types referenced under `Model/` and `Actions/` lists every component whose model must sink first.

## Beyond the app target

<strong>Libraries below the model may be remote.</strong> `NotebookSync` or `MarkdownImport` could as well be pinned packages from their own repositories, with a gitignored override slot for tandem development. `NotebookCore` and `NotebookActions` are always local: they are an enforced module boundary for this app, not a library anyone else consumes.

<strong>Airframe is the one dependency on both sides of the boundary.</strong> The framework (<a href="/guide/11-the-airframe-package">Chapter 11</a>) is a pinned remote dependency carved into products along the same Foundation/AppKit line this layout is built on. `NotebookCore` and `NotebookActions` import the individual Foundation-only products they need — `AirframeActions` for the Action and validator bases, `AirframeFoundation` for the shared helpers — and the app target imports the `Airframe` umbrella, which re-exports everything. A Foundation-only product never links AppKit, so the compiler holds the line through the framework the same way it holds it through your own packages. The framework is also why there is no `FoundationExtensions`, `StateObserving` or observation package of your own under `Packages/`: Airframe ships that generic code, and what remains there is either a library below the model or domain code.

<strong>Sibling targets sit beside the app target.</strong> A command-line helper embedded in the bundle, a dock tile plug-in, a Quick Look extension each get their own folder at the repository root, with their own test target laid out per <a href="/guide/10-3-suite-layout-and-test-kinds">Chapter 10.3</a>. Code compiled into two targets is a local package, never a folder added to both.

<div class="rule">
<span class="rule-label">The rule</span>

At the root, a folder is a layer; below it, a folder is a domain. The Model and Actions layers are packages so the compiler holds the Foundation/AppKit line. Nothing in the app target is generic — it either passes the library test and moves to a package, or it has a domain. A component may keep its model and views together only behind a single facade file that the removal test proves is the whole of its surface.

</div>

<div class="seealso">
<strong>Ahead in this guide</strong>
The test target that mirrors this tree — one folder per source folder, one file per source file — is <a href="/guide/10-3-suite-layout-and-test-kinds">Chapter 10.3</a>. The two root folders that hold coordination code are <a href="/guide/04-background-controllers">Chapter 4</a> and <a href="/guide/06-2-action-controllers">Chapter 6.2</a>; the packages at the bottom are where <a href="/guide/05-model-layer">Chapter 5</a> and <a href="/guide/06-1-actions">Chapter 6.1</a> live.
</div>
