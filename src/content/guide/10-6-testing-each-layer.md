---
title: "Testing Each Layer"
description: "Each layer of the architecture has a way it gets exercised. This closing subchapter works through the notebook app layer by layer — a manager through its public method with the network stubbed underneath, a multi-step Action, a validator, a View State Controller, async and error paths, and background jobs with progress — with the in-memory store and the temporary directory that make the real collaborators cheap."
order: 10
subOrder: 6
---

Each layer of the architecture has a way it gets exercised. This closing subchapter works through the notebook app layer by layer — a manager through its public method with the network stubbed underneath, a multi-step Action, a validator, a View State Controller, async and error paths, and background jobs with progress — with the in-memory store and the temporary directory that make the real collaborators cheap.

Every example follows the layer table from <a href="/guide/10-1-which-tests-to-write">Chapter 10.1</a>, builds its state in the test per <a href="/guide/10-5-inside-a-test-class">Chapter 10.5</a>, and inherits `TestCase`'s wiring — an in-memory database, isolated defaults, a fresh documents directory — where it needs it.

## Models and managers

Test the manager's public interface, never the job it enqueues or the store underneath. The manager is reached through `.shared`, exactly as production reaches it, and the only double is at the HTTP boundary: a `URLProtocol` stub registered on the session `SyncClient` uses, handed a payload in the server's wire shape.

```swift
@MainActor
final class NoteManagerTests: TestCase {
    func testPull_MergesRemoteNotes() async throws {
        let notebook = try Notebook.make { n in n.setTitle("Journal") }
        stub(.get, "/notebooks/\(notebook.id)/notes") { _ in
            .json(SyncPayloads.notes([
                SyncPayloads.note(id: NoteID(), title: "Monday"),
                SyncPayloads.note(id: NoteID(), title: "Tuesday")
            ]))
        }

        try await NoteManager.shared.pull(notebookID: notebook.id)

        let titles = Note.all(in: notebook).map(\.title)
        XCTAssertEqual(titles, ["Monday", "Tuesday"])
    }
}
```

Everything between the stub and the assertion runs for real: `SyncClient` builds the request and decodes the response, `PullNotesJob` performs on the runner and merges in `handleResult`, the store writes to the in-memory database, and the model's query reads it back. Because the database merges background saves onto the main context automatically, the query sees the merged notes without a manual refresh — the same guarantee <a href="/guide/05-model-layer">Chapter 5</a> describes at runtime.

```swift
// ✅ Test the interface
try await NoteManager.shared.pull(notebookID: notebook.id)

// ❌ Don't test the job directly
let job = PullNotesJob(notebookID: notebook.id)
```

Model behavior that lives in the database itself — cascades, relationships, validation — is tested the same way, through the model's API against the in-memory stack:

```swift
func testDeleteNotebook_CascadesToNotes() async throws {
    let notebook = try Notebook.make { n in n.createNote(titled: "A") }
    let note = try XCTUnwrap(Note.all(in: notebook).first)

    try await NotebookManager.shared.delete(notebook.id)

    XCTAssertNil(Notebook.notebook(id: notebook.id))
    XCTAssertNil(Note.note(id: note.id))
}

func testAddNote_LinksBothSides() throws {
    let notebook = try Notebook.make { n in n.createNote(titled: "A") }
    let note = try XCTUnwrap(Note.all(in: notebook).first)

    XCTAssertEqual(notebook.noteCount, 1)
    XCTAssertEqual(note.notebook, notebook)
}
```

Prefer a test without a built notebook when the logic allows it. A value factory (`Note.make(...)`) is enough for a pure query or a formatter; the builder costs a store write per step.

## Actions

Only Actions that add meaningful logic beyond a single manager call get a test, and the test exercises the Action itself — never the Action Controller that presents UI and dispatches it. `MoveNoteAction` from <a href="/guide/06-1-actions">Chapter 6.1</a> unlinks and relinks in sequence, so it earns one:

```swift
@MainActor
final class MoveNoteActionTests: TestCase {
    func testPerform_NoteEndsUpInDestination() async throws {
        let source = try Notebook.make { n in n.createNote(titled: "Draft") }
        let destination = try Notebook.make { n in n.setTitle("Published") }
        let note = try XCTUnwrap(Note.all(in: source).first)

        let action = MoveNoteAction(noteID: note.id, from: source.id, to: destination.id)
        action.perform()
        await action.waitUntilFinished()

        XCTAssertEqual(action.status, .completed)
        XCTAssertNil(Note.note(id: note.id, in: source))
        XCTAssertNotNil(Note.note(id: note.id, in: destination))
    }
}
```

A `DeleteTagAction` that forwards one call to `TagManager.shared.delete(_:)` gets no test; the manager's test already proves the deletion.

## Validators

A validator is a Foundation type that answers one question from state it's handed, so it's constructed and asked directly — no menu, no window, no Action:

```swift
final class DeleteNotebookValidatorTests: TestCase {
    func testValidate_ActiveNotebook() throws {
        let notebook = try Notebook.makeThreeNotes()

        XCTAssertTrue(DeleteNotebookValidator(notebook: notebook).validate())
    }

    func testValidate_NotebookIsSyncing() throws {
        let notebook = try Notebook.make { n in
            n.createNote(titled: "A")
            n.markSyncPending()
        }

        XCTAssertFalse(DeleteNotebookValidator(notebook: notebook).validate())
    }
}
```

A validator with two checks whose order matters — "is syncing" before "is the last notebook", say, because the error the user sees depends on which fires — gets both orders tested, per rule 8 in <a href="/guide/10-1-which-tests-to-write">Chapter 10.1</a>.

## View State Controllers

The one testable controller kind. Load it, wait for it, and assert on the shaped output — how many items, in what order, grouped how, which ones filtered out. Never on the internal loading mechanics.

```swift
@MainActor
final class NoteListStateControllerTests: TestCase {
    /// Pinned notes sort first regardless of edit date; the rest are most-recently-edited first.
    func testLoad_PinnedNotesFirst() async throws {
        let notebook = try Notebook.make { n in
            n.createNote(titled: "Old", editedAt: .distantPast)
            n.createNote(titled: "Pinned", editedAt: .distantPast)
            n.createNote(titled: "New", editedAt: .now)
            n.pin("Pinned")
        }
        let controller = NoteListStateController(notebookID: notebook.id)

        await controller.load()

        XCTAssertEqual(controller.items.map(\.title), ["Pinned", "New", "Old"])
    }
}
```

## Async, errors and cancellation

Prefer `async` test methods over expectation-based bridging; the test awaits the manager the way any caller would. Synchronous errors use `XCTAssertThrowsError`; async ones use a free-function `XCTAssertAsyncThrowsError` from `Support/`, since the built-in doesn't take an `async` expression:

```swift
func testArchive_LastActiveNotebook_Throws() async throws {
    let notebook = try Notebook.makeThreeNotes()

    await XCTAssertAsyncThrowsError(try await NotebookManager.shared.archive(notebook.id)) { error in
        XCTAssertEqual(error as? NotebookError, .cannotArchiveLastActiveNotebook)
    }
}
```

Where cancellation matters, assert the terminal persisted and published state — not merely that an error was thrown. Cancellation may arrive after a durable write, so the expected outcome can be an accurately settled partial result rather than an untouched store; <a href="/guide/07-concurrency">Chapter 7</a> defines that contract.

A precondition that the setup actually produced the intended state goes in a plain `assert`, so a broken factory fails loudly before the assertion under test can pass for the wrong reason:

```swift
let notebook = try Notebook.makeThreeNotes()
assert(Note.all(in: notebook).count == 3)
```

## Jobs and progress

Exercise real jobs through the manager entry point, with temporary storage and a narrow double at the external process or network boundary. Use a deliberate gate in the double to hold one operation while submitting the next; never a timing assertion built on `sleep`. Test the application's group declarations from <a href="/guide/07-concurrency">Chapter 7</a> and the behavior that results:

- Queue a rename behind a note update, then verify both changes survive. This catches a job capturing its editable baseline too early.
- Export while a save is pending and verify the export sees the completed save. Also verify work on a different notebook can proceed.
- Delete a note during ongoing work, then submit a delayed edit. Verify the edit reports the missing note and cannot recreate it.
- Emit progress and then fail or cancel. Verify accepted progress precedes the final activity state, and a late callback cannot revive it.
- Fail persistence after a successful download. Verify the activity reports failure and no successful-save notification is published. If an earlier step already saved data, verify that committed change is published accurately.
- Start two draft requests with separate progress callbacks. Verify each caller receives only its own events, and a dismissed or replaced caller ignores stale updates.

For a worker-only test, call `job.perform(context: work)`; progress-reporting jobs inherit that overload with reporting disabled, and it does not run result handling. To test progress and persistence together, use the manager entry point or `job.execute(context: work, resultContext: result)`. Assert the final accumulated text and meaningful event order rather than an exact number of UI updates, since pending text deltas may be coalesced.

The coalescing rule itself is a small, directly testable value operation:

```swift
// DraftSummaryJob.Progress is Equatable in this example.
XCTAssertEqual(
    DraftSummaryJob.coalesceProgress(.text("Hello"), .text(" world")),
    .text("Hello world")
)
XCTAssertNil(DraftSummaryJob.coalesceProgress(.text("Hello"), .stage("Saving")))
XCTAssertNil(DraftSummaryJob.coalesceProgress(.started, .text("Hello")))
```

## Temporary directories

A test that touches the file system — an export, an import, a notebook bundle — gets a unique temporary directory from a `Support/` helper, never a hardcoded `/tmp` path. Cleanup belongs in the helper that created the directory, registered with `addTeardownBlock`, so the test body shows one line and no `setUp`/`tearDown` pair is needed:

```swift
func testExport_WritesOneFilePerNote() async throws {
    let notebook = try Notebook.makeThreeNotes()
    let directory = try makeTemporaryDirectory()   // registers its own teardown

    try await ExportManager.shared.export(notebook.id, to: directory)

    let files = try FileManager.default.contentsOfDirectory(atPath: directory.path)
    XCTAssertEqual(files.filter { $0.hasSuffix(".md") }.count, 3)
}
```

<div class="seealso">
<strong>End of the architecture</strong>
That closes the architecture. What the framework ships of it as a Swift package — the products, how a target imports them, where they sit in the tree — is <a href="/guide/11-the-airframe-package">Chapter 11</a>. <a href="/">Back to the overview</a> for the full map.
</div>
