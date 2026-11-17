---
title: "Screen Examples"
description: "Chapter 7.2 holds the rules for structuring a screen's state and works the most common shape, loaded data, in full. This subchapter builds the other five in the notebook app: values derived from the model, a form with an async submit, a long-running operation with progress and cancel, several concerns on one screen, and a parent view controller routing between its children."
order: 7
subOrder: 7
---

<a href="/guide/07-2-view-state">Chapter 7.2</a> holds the rules for structuring a screen's state and works the most common shape, loaded data, in full. This subchapter builds the other five in the notebook app: values derived from the model, a form with an async submit, a long-running operation with progress and cancel, several concerns on one screen, and a parent view controller routing between its children. Each example names when it applies and when it doesn't, shows the types and how they interact, and says what gets a test.

## Derived values

What the view shows can be computed from the model right now, without `await`: a count, a flag, a title. It changes when the model posts notifications. This is the smallest case with state — one value, held by the view controller.

Not this example: getting the data needs `await`, or a new request must replace a running one — that is loaded data, <a href="/guide/07-2-view-state">Chapter 7.2</a>. And if nothing changes after the view appears, there is no state at all; pass plain values once.

The sidebar footer shows an Archive button while the notebook has archived notes:

```swift
// Everything the view shows, as one value. Its init is the rule.
struct ArchiveSummary: Equatable {
    let archivedCount: Int

    init(archivedCount: Int = 0) {
        self.archivedCount = archivedCount
    }

    @MainActor
    init(notebook: Notebook) {
        archivedCount = Note.archived(in: notebook).count
    }

    var showsArchiveButton: Bool { archivedCount > 0 }
}

struct SidebarFooterView: View {
    var summary: ArchiveSummary
    var onShowArchive: () -> Void

    var body: some View { /* a button, shown while summary.showsArchiveButton */ }
}
```

```swift
@StateObserving
final class SidebarFooterViewController: NSViewController {
    private let notebook: Notebook
    private var hostingView: NSHostingView<SidebarFooterView>!

    @Tracked private var summary = ArchiveSummary()

    override func loadView() {
        hostingView = NSHostingView(rootView: SidebarFooterView(
            summary: summary,
            onShowArchive: { [weak self] in self?.showArchive() }
        ))
        view = hostingView
    }

    func observeState() {
        observations.observe(NotificationCenter.default.publisher(for: .noteDidChange)) { [weak self] _ in
            self?.updateSummary()
        }
        updateSummary()
        observations.track { [weak self] in self?.updateFooter() }
    }

    private func updateSummary() {
        summary = ArchiveSummary(notebook: notebook)
    }

    private func updateFooter() {
        hostingView.rootView.summary = summary
    }
}
```

- <strong>The view controller is the writer</strong>, so the value is a `@Tracked` property on it. There is no controller and no task.
- <strong>Every signal funnels into one method</strong> that recomputes the whole value. The same method seeds it before the updater is registered — the subscribe, seed, track order of <a href="/guide/07-4-state-observing">Chapter 7.4</a>.
- <strong>Noisy signals cost nothing.</strong> `@Tracked` ignores an equal value, so the updater runs only when the summary really changed.
- <strong>The handler changes state; only the tracked updater touches the view.</strong>
- For an AppKit view the updater sets its properties instead: `footerView.archivedCount = summary.archivedCount`.

<strong>Tests.</strong> `ArchiveSummary`: build it from a notebook in a known state and assert its values. Nothing else.

<strong>Variations.</strong> Several sources — two notifications and a setting — each get their own `observe`, all calling `updateSummary()`. A value only the view controller needs, to enable a toolbar item say, has the same shape with the updater setting the toolbar item.

## A form with an async submit

The user edits fields and presses a button; the screen then does something that takes time. Meanwhile the fields are locked and progress shows. Afterwards the window closes or an error shows.

Not this example: the screen only shows data — loaded data, <a href="/guide/07-2-view-state">Chapter 7.2</a>. Submitting is instant and cannot fail — no controller and no activity; the view controller acts on `onSubmit` directly. The edits must commit or roll back as one unit against a persistent store — that is an editing scratchpad on the model's side, <a href="/guide/05-10-core-data-models">Chapter 5.10</a>.

The sheet that connects a sync account has two writers, so it has two state objects. The user writes the form:

```swift
// The user edits it.
@Observable @MainActor
final class SyncAccountForm {
    var server = ""
    var token = ""

    var isComplete: Bool { !server.isEmpty && !token.isEmpty }

    func credentials() -> SyncCredentials {
        SyncCredentials(server: server.trimmingCharacters(in: .whitespaces), token: token)
    }
}
```

The flow controller writes how verifying is going — a value, with every decision a transition on it:

```swift
// The view only reads it.
struct SyncAccountVerification: Equatable {
    enum Activity: Equatable {
        case verifying
        case failed(Failure)
    }

    enum Failure: Equatable {
        case unreachable
        case rejected

        init(_ error: Error) { /* map a SyncError to what the view can explain */ }
    }

    private(set) var activity: Activity?

    init(activity: Activity? = nil) {
        self.activity = activity
    }

    var isRunning: Bool { activity == .verifying }

    /// Starts a run. False while one runs — a second submit is refused.
    mutating func begin() -> Bool {
        guard !isRunning else { return false }
        activity = .verifying
        return true
    }

    /// Records a failure. Nothing after `cancel()`.
    mutating func fail(with error: Error) {
        guard isRunning else { return }
        activity = .failed(Failure(error))
    }

    mutating func cancel() {
        guard isRunning else { return }
        activity = nil
    }

    /// Clears a failure; a running verification is left alone.
    mutating func reset() {
        guard !isRunning else { return }
        activity = nil
    }
}

// Sequences the work; decides nothing; the value's only writer.
@MainActor
final class SyncAccountVerificationController {
    @Tracked private(set) var verification = SyncAccountVerification()

    /// The verified account, or nil when verifying failed or was cancelled.
    func verify(_ credentials: SyncCredentials) async -> SyncAccount? {
        guard verification.begin() else { return nil }
        do {
            return try await SyncManager.shared.verifyAccount(credentials)
        } catch {
            verification.fail(with: error)
            return nil
        }
    }

    func cancel() { verification.cancel() }
    func reset() { verification.reset() }
}
```

The view takes one of each — the form to edit, the value to read — and two intents:

```swift
struct SyncAccountFormView: View {
    @Bindable var form: SyncAccountForm             // edited
    var verification: SyncAccountVerification       // read
    var onSubmit: () -> Void
    var onCancel: () -> Void

    private var canSubmit: Bool {
        form.isComplete && !verification.isRunning
    }

    var body: some View { /* fields bound to $form, disabled while verification.isRunning */ }
}
```

The view controller owns both, moves values between them, and owns the task:

```swift
@StateObserving
final class SyncAccountViewController: NSViewController {
    private let form = SyncAccountForm()
    private let verificationController = SyncAccountVerificationController()
    private var verificationTask: Task<Void, Never>?
    private var hostingView: NSHostingView<SyncAccountFormView>!

    override func loadView() {
        hostingView = NSHostingView(rootView: SyncAccountFormView(
            form: form,
            verification: verificationController.verification,
            onSubmit: { [weak self] in self?.submit() },
            onCancel: { [weak self] in self?.cancel() }
        ))
        view = hostingView
    }

    func observeState() {
        // REACT — an edit to the server makes a shown failure stale.
        observations.observe({ [weak self] in self?.form.server }, perform: { [weak self] in
            self?.verificationController.reset()
        })
        // RENDER — assign the value in place on the hosted view.
        observations.track { [weak self] in self?.updateVerification() }
    }

    private func updateVerification() {
        hostingView.rootView.verification = verificationController.verification
    }

    private func submit() {
        let credentials = form.credentials()
        verificationTask = Task { [weak self] in
            if let account = await self?.verificationController.verify(credentials) {
                self?.close(with: account)
            }
        }
    }

    private func cancel() {
        if verificationController.verification.isRunning {
            verificationTask?.cancel()
            verificationController.cancel()
        } else {
            close(with: nil)
        }
    }
}
```

- <strong>Two writers, two objects.</strong> The user writes the form; the controller writes the verification. Neither knows the other.
- <strong>`@Bindable` for what the user edits, a plain `var` for what the view only reads.</strong> The view controller sets the value on the root view from a tracked updater.
- <strong>Only the controller can change the verification:</strong> the transitions are `mutating` and the property is `private(set)`. The view controller calls `cancel()` and `reset()` on the controller.
- <strong>`canSubmit` needs both objects and is only for display</strong>, so it is a private computed property on the view.
- <strong>Closures are intents.</strong> A changed field is not reported; the view controller observes the form and calls `reset()`.
- <strong>One Cancel intent</strong>, interpreted by the view controller: stop the running work, or close.
- <strong>Two routes for the result.</strong> Progress and failure go into the value the view shows; what the view controller acts on is the return value.
- <strong>The view controller owns the task</strong>; the controller's method is plain `async` and takes what it needs as arguments. Cancelling the task makes the awaited manager call throw — <a href="/guide/05-9-cancellation">Chapter 5.9</a> — and `fail(with:)` does nothing after `cancel()`, so a cancelled run leaves no error behind.
- A preview needs no controller: `SyncAccountFormView(form: SyncAccountForm(), verification: .init(activity: .verifying), onSubmit: {}, onCancel: {})`.

<strong>Tests.</strong> The transitions of `SyncAccountVerification` and the form's rules, as plain values. The controller, the view controller, the view and `canSubmit` get none.

<strong>Variations.</strong> A follow-up question — trust this certificate? — makes `verify` return an enum instead of an optional, with a case the view controller answers by presenting an alert and running again. Several steps become one `Activity` case per step the view shows, and a transition that moves on. A form that edits something stored keeps the original as a `let` next to the edited copy.

## A long-running operation

The user starts something that takes time, watches it, and can cancel it. The operation belongs to this window: closing the window stops it, and no other part of the app shows it.

Not this example: other surfaces must see or cancel the operation, or it must outlive the window — that is an Action registered as an activity, <a href="/guide/06-1-actions">Chapter 6.1</a>, not view state. And if the user fills in fields first, it is the form above, which is this example plus an editable form.

Exporting a notebook's notes to a folder:

```swift
// How the export is going. A value; every decision is a transition on it.
struct NotebookExport: Equatable {
    enum Activity: Equatable {
        case running(fraction: Double)
        case finished
        case failed(Failure)   // an Equatable enum built from the error, as in the form above
    }

    private(set) var activity: Activity?

    init(activity: Activity? = nil) {
        self.activity = activity
    }

    var isRunning: Bool {
        if case .running = activity { true } else { false }
    }

    mutating func begin() -> Bool {
        guard !isRunning else { return false }
        activity = .running(fraction: 0)
        return true
    }

    /// Nothing unless running.
    mutating func report(fraction: Double) {
        guard isRunning else { return }
        activity = .running(fraction: fraction)
    }

    /// False after `cancel()` — the caller has no result to hand on.
    mutating func finish() -> Bool {
        guard isRunning else { return false }
        activity = .finished
        return true
    }

    mutating func fail(with error: Error) {
        guard isRunning else { return }
        activity = .failed(Failure(error))
    }

    mutating func cancel() {
        guard isRunning else { return }
        activity = nil
    }
}

// Sequences the work; decides nothing; the value's only writer.
@MainActor
final class NotebookExportController {
    @Tracked private(set) var export = NotebookExport()

    /// The folder the notes were written to, or nil when the export failed or was cancelled.
    func run(_ request: ExportRequest) async -> URL? {
        guard export.begin() else { return nil }
        do {
            let manager = NoteManager.shared(for: request.notebook)
            for (index, noteID) in request.noteIDs.enumerated() {
                try await manager.export(noteID, to: request.directory)
                export.report(fraction: Double(index + 1) / Double(request.noteIDs.count))
            }
            return export.finish() ? request.directory : nil
        } catch {
            export.fail(with: error)
            return nil
        }
    }

    func cancel() { export.cancel() }
}

struct NotebookExportView: View {
    var export: NotebookExport
    var onStart: () -> Void
    var onCancel: () -> Void

    var body: some View { /* a progress bar while running, a failure message, the two buttons */ }
}
```

```swift
@StateObserving
final class NotebookExportViewController: NSViewController {
    private let request: ExportRequest
    private let exportController = NotebookExportController()
    private var exportTask: Task<Void, Never>?
    private var hostingView: NSHostingView<NotebookExportView>!

    override func viewWillAppear() {
        super.viewWillAppear()
        activateObservation()
    }

    override func viewWillDisappear() {
        super.viewWillDisappear()
        deactivateObservation()
        cancelExport()   // the operation lives and dies with this window
    }

    func observeState() {
        observations.track { [weak self] in self?.updateExport() }
    }

    private func updateExport() {
        hostingView.rootView.export = exportController.export
    }

    private func start() {
        exportTask = Task { [weak self, request] in
            if let directory = await self?.exportController.run(request) {
                self?.reveal(directory)
            }
        }
    }

    private func cancelExport() {
        exportTask?.cancel()
        exportController.cancel()
    }
}
```

- <strong>Progress is part of the value.</strong> The controller calls `report(fraction:)` between its steps; the view shows it. That is progress between the steps the controller sequences. Progress from inside one job still travels the way <a href="/guide/05-6-progress-and-activities">Chapter 5.6</a> describes — the job's activity row — and never through a closure handed to the job.
- <strong>The view controller owns the task</strong> and cancels it when the user asks and when the view disappears.
- <strong>A late answer changes nothing.</strong> Every transition checks `isRunning`, so work that finishes after a cancel leaves no error and no result behind.
- <strong>What the view controller acts on is the return value</strong> — the folder to reveal; what the view shows is the value.

<strong>Tests.</strong> The transitions of `NotebookExport`, as a plain value, including "nothing after `cancel()`" — <a href="/guide/09-6-testing-each-layer">Chapter 9.6</a> shows them. The controller, the view controller and the view get none.

<strong>Variations.</strong> Steps instead of a fraction are one `Activity` case per step. Output lines that stream in can be an array on the value for a few dozen lines; for a long log, hold an `@Observable` model the view reads by reference.

## Several concerns on one screen

The screen does more than one of the things the other examples show: it loads data and also runs an operation on it, or loads a list and also holds the user's selection. The temptation is one state object with everything in it. The rule is the one from <a href="/guide/07-2-view-state">Chapter 7.2</a>: one object per writer, none of them knows another, and the view controller routes between them.

The note detail screen from Chapter 7.2 gains a Publish button, which uploads the note to a public page. The loaded note keeps its pair, `NoteDetailStateController` writing `NoteDetailState`. Publishing gets its own:

```swift
// Written by the flow controller.
struct NotePublication: Equatable {
    private(set) var isRunning = false

    init(isRunning: Bool = false) {
        self.isRunning = isRunning
    }

    mutating func begin() -> Bool {
        guard !isRunning else { return false }
        isRunning = true
        return true
    }

    mutating func end() {
        isRunning = false
    }
}

enum NotePublishResult {
    case published(URL)
    case failed(Error)
    case cancelled
}

@MainActor
final class NotePublishController {
    @Tracked private(set) var publication = NotePublication()

    func publish(_ noteID: NoteID, in notebook: Notebook) async -> NotePublishResult {
        guard publication.begin() else { return .cancelled }
        defer { publication.end() }
        do {
            return .published(try await NoteManager.shared(for: notebook).publish(noteID))
        } catch is CancellationError {
            return .cancelled
        } catch {
            return .failed(error)
        }
    }
}

struct NoteDetailView: View {
    let state: NoteDetailState          // large, by reference
    var publication: NotePublication    // small, set by the view controller
    var onSave: () -> Void
    var onPublish: () -> Void
    var onCancelPublish: () -> Void

    var body: some View { /* reads state.title, state.body, publication.isRunning */ }
}
```

```swift
@StateObserving
final class NoteDetailViewController: NSViewController {
    private let notebook: Notebook
    private let detail = NoteDetailStateController()
    private let publishController = NotePublishController()
    private var publishTask: Task<Void, Never>?
    private var hostingView: NSHostingView<NoteDetailView>!

    var noteID: NoteID? {
        didSet {
            cancelPublishing()        // the run belonged to the note that was showing
            detail.noteID = noteID
        }
    }

    func observeState() {
        observations.observe(NotificationCenter.default.publisher(for: .noteDidChange)) { [weak self] _ in
            self?.detail.reload()
        }
        observations.track { [weak self] in self?.updatePublication() }
    }

    private func updatePublication() {
        hostingView.rootView.publication = publishController.publication
    }

    private func publish() {
        guard let noteID, !detail.state.isLoading else { return }
        publishTask = Task { [weak self, notebook] in
            switch await self?.publishController.publish(noteID, in: notebook) {
            case .published(let url):
                self?.copyLink(url)
            case .failed(let error):
                self?.presentError(error)
            case .cancelled, nil:
                break
            }
        }
    }

    private func cancelPublishing() {
        publishTask?.cancel()
    }
}
```

- <strong>Two writers, two objects.</strong> The loader writes the note; the publish controller writes the publication. A single object with `title`, `isLoading` and `isPublishing` would have two writers, and the view controller would be setting flags on a model it does not own.
- <strong>Each reaches the view its own way:</strong> the loaded note by reference, the small publication value by assignment.
- <strong>The view controller routes.</strong> It reads what it needs from the loader's state and passes values to the publish controller as arguments. Neither controller holds the other.
- <strong>The reload after publishing arrives the usual way.</strong> Publishing goes through the manager, the manager posts `.noteDidChange`, and the view controller already reloads the loader on that signal. The flow controller's result is not a second trigger.
- <strong>An input change that affects both</strong> is handled where both are known: the `noteID` setter cancels the publish and hands the identifier to the loader.
- <strong>An error the user must dismiss is the return value</strong>, presented by the view controller. It is not state.

<strong>Tests.</strong> The loader on its model; the transitions of `NotePublication`. Nothing that sequences or routes.

<strong>Variations.</strong> A loaded list plus the user's selection: the loader writes the list; the selection is an `@Observable` object the view binds to. When a reload removes a selected item, the view controller prunes the selection after the load; the loader does not know the selection. Loaded options plus a form are the same split, with the form as the editable object. And two things that always change together are one concern, not two: keep them in one object with one writer.

## Parent and child view controllers

A parent view controller owns children: a list and a detail, or one of several content views chosen by a mode. Something in one child decides what another shows. Each child is a screen of its own and follows whichever other example fits it; this example is only about what crosses between view controllers.

```swift
final class NoteListViewController: NSViewController {
    /// Called when the user selects another note.
    var onSelect: ((NoteID?) -> Void)?
}

final class NoteDetailViewController: NSViewController {
    /// Set by the parent. A change reloads.
    var noteID: NoteID? {
        didSet { detail.noteID = noteID }   // forwarded to the loader
    }
}
```

```swift
@StateObserving
final class NotesViewController: NSViewController {
    private let listViewController = NoteListViewController()
    private let detailViewController = NoteDetailViewController()
    private let emptyViewController = EmptySelectionViewController()

    @Tracked private var selectedNoteID: NoteID?

    override func loadView() {
        // …assemble the list and the content slot…
        listViewController.onSelect = { [weak self] in self?.selectedNoteID = $0 }
    }

    func observeState() {
        observations.track { [weak self] in self?.updateDetail() }
    }

    private func updateDetail() {
        detailViewController.noteID = selectedNoteID
        show(selectedNoteID == nil ? emptyViewController : detailViewController)
    }
}
```

- <strong>Children do not share a state object.</strong> The list does not write something the detail reads. The list reports to the parent, and the parent sets the detail's input.
- <strong>A child's input is a plain property.</strong> The child decides what a change means, usually by handing it to its loader.
- <strong>What decides the parent's own layout is the parent's state</strong> — here a `@Tracked` value, with a tracked updater that sets the input and swaps the child. Swapping the child is the controller-level swap from <a href="/guide/07-1-views">Chapter 7.1</a>.
- <strong>A child reports to its parent with a closure or a delegate.</strong> That is a view controller telling its owner what happened; the rule that a <em>view</em> reports only intents is about the view, one level below.
- <strong>Each child activates its own observation</strong> in its own `viewWillAppear`. The parent does not reach into a child's state or controllers.

<strong>Tests.</strong> None for the routing. Each child's loader or values are tested as in its own example.

<strong>Variations.</strong> When the selection lives in a SwiftUI list, the list child holds an `@Observable` selection object the view binds to, observes it, and calls `onSelect`. A mode instead of a selection — notes, tags, trash — has the same shape, with a `@Tracked` mode and an updater that swaps the child. A parent that needs nothing but forwarding, passing a value straight through and always showing the same child, needs no `@Tracked` and no observation; the closure sets the child's input directly. And once what is selected spans more than one value, or has to be restored on relaunch, it becomes the navigation state object of <a href="/guide/08-navigation">Chapter 8</a> — still written only by the parent.

<div class="seealso">
<strong>Ahead in this guide</strong>
Moving between screens, with the parent's selection grown into a navigation state object, is <a href="/guide/08-navigation">Chapter 8</a>. Testing a value's transitions and a loader's output is <a href="/guide/09-6-testing-each-layer">Chapter 9.6</a>.
</div>
