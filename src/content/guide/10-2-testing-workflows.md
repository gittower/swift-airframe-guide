---
title: "Testing Workflows"
description: "Most tests get written in one of two situations: a bug needs fixing or a feature needs building. This subchapter covers the discipline for each — reproduce first, signatures first — worked through as a sync bug and an archive feature in the notebook app, plus the habit that makes both cheap: investing in test infrastructure the moment a scenario is hard to set up."
order: 10
subOrder: 2
---

Most tests get written in one of two situations: a bug needs fixing or a feature needs building. This subchapter covers the discipline for each — reproduce first, signatures first — worked through as a sync bug and an archive feature in the notebook app, plus the habit that makes both cheap: investing in test infrastructure the moment a scenario is hard to set up.

## How strictly test-first

This guide doesn't enforce strict red-green-refactor TDD. It does insist on the essentials behind it: think about what the code should do before writing it, express that as a test, and let the tests guide the design. Whether the test comes first, alongside, or immediately after the implementation is a matter of personal style and context. What matters is that non-trivial logic ships with tests — a pull request that introduces complex logic without them should be challenged in review.

TDD is also the fastest way to learn to write good tests. If that skill is still forming, leaning into a disciplined test-first approach builds the instincts sooner.

## Fixing a bug

Suppose a report comes in: a note renamed on the server while it has an unsynced local edit loses that edit on the next pull. The crash log and a quick read of `PullNotesJob` point at the merge — the remote title lands, but so does the remote body, over the top of the local one.

<div class="rule">
<span class="rule-label">The discipline</span>

Reproduce the bug in a failing test <em>before</em> touching the fix. It proves you understand the bug (you can construct the exact state that fails), it proves the fix works (the test goes green), and it becomes a permanent guard (six months later, a refactor of the merge fails this test instead of shipping).

</div>

The test builds the exact state, in the test, with the builder from <a href="/guide/10-4-factories-builders-and-fixtures">Chapter 10.4</a>, and stubs the one external boundary — the network — with a payload in the server's wire shape:

```swift
/// Guards the merge rule: a remote rename never overwrites a pending local body edit.
func testPull_RenamedRemotelyWhileEditedLocally_KeepsLocalBody() async throws {
    let notebook = try Notebook.make { n in
        n.createNote(titled: "Original", body: "draft")
        n.markSynced()
        n.editNote(titled: "Original", body: "draft, extended")
    }
    let note = try XCTUnwrap(Note.all(in: notebook).first)
    stub(.get, "/notebooks/\(notebook.id)/notes") { _ in
        .json(SyncPayloads.notes([
            SyncPayloads.note(id: note.id, title: "Renamed", body: "draft", updatedAt: .now)
        ]))
    }

    try await NoteManager.shared.pull(notebookID: notebook.id)

    let merged = try XCTUnwrap(Note.note(id: note.id, in: notebook))
    XCTAssertEqual(merged.title, "Renamed")
    XCTAssertEqual(merged.body, "draft, extended")
}
```

Everything the assertions check — the title, the body — was passed in by the test. Nothing is read back from a factory default.

If you <em>can't</em> write the test, ask why. Usually the answer is a missing piece of infrastructure: the builder had `createNote` and `markSynced` but no `editNote`, so there was no way to put a note into the "edited after sync" state without poking the store by hand. The fix is to add the primitive to the builder, not to poke the store from the test — a private helper that constructs state by bypassing the module's own API is a builder primitive waiting to be written. It pays for itself on the next bug.

Once the test is red and the fix turns it green, look around: what related edge cases does this bug suggest? If a remote rename collides with a local edit, what about a remote delete? A rename on both sides? Sketch them as signatures first, then fill in the ones that reach a different branch of the merge:

```swift
func testPull_DeletedRemotelyWhileEditedLocally_KeepsNoteAsUnsynced() async throws { }
func testPull_RenamedOnBothSides_LocalTitleWins() async throws { }
```

Finally, step back. What else touches the merge? Search the codebase, think through side effects, and do one manual run of the app to confirm. The app run is confirmation, not the development loop.

## Building a feature

Suppose the feature is "archive a notebook": an archived notebook leaves the active list, keeps its notes, and waits for any pending sync to finish before it goes.

<div class="rule">
<span class="rule-label">The discipline</span>

Plan before you test, then write the <em>test method signatures only</em>. Sketching the signatures forces the questions that matter — what states can the notebook be in, what can go wrong, which combinations reach different code paths — before a line of implementation exists.

</div>

```swift
func testArchive_RemovesNotebookFromActiveList() async throws { }
func testArchive_KeepsNotesInStore() async throws { }
func testArchive_WithPendingSync_WaitsForSync() async throws { }
func testArchive_LastActiveNotebook_Throws() async throws { }
func testArchive_AlreadyArchived_Throws() async throws { }
```

The next question is where each test goes, and the layer table in <a href="/guide/10-1-which-tests-to-write">Chapter 10.1</a> answers it:

- **Manager tests carry the rules.** Removing from the active list, keeping the notes, refusing the last active notebook, refusing a second archive — every one of these is a decision `NotebookManager.archive(_:)` makes, so every one is a manager test. This is where the case matrix lives.
- **A validator test covers the precondition.** "Can this notebook be archived right now?" is a plain Foundation `ArchiveNotebookValidator` (<a href="/guide/06-3-action-validation">Chapter 6.3</a>) — constructed and asked in a test with no menu, no window, no app.
- **The Action gets one test, only because it's multi-step.** `ArchiveNotebookAction` waits for the pending sync and then calls the manager — two steps, one decision of its own. It gets its happy path plus that one decision: `testArchive_WithPendingSync_WaitsForSync` is an Action test. It never re-enumerates the manager's matrix. An Action that only forwarded one manager call would get no test at all.
- **The Action Controller gets none.** It presents a confirmation sheet and dispatches the Action. Nothing in it can regress on its own.

Distributing tests this way is the same rule <a href="/guide/10-5-inside-a-test-class">Chapter 10.5</a> states for grouping — test at the layer where the bug lives, pin once at each boundary it must cross — and it has a side effect worth wanting: if you find yourself writing the same test at two layers, the logic probably belongs in one of them, not both. If a feature seems to need tests at every layer, it's usually complex enough to warrant extracting something.

Start with the simplest case, get it passing, then work through progressively more complex scenarios. Along the way you'll discover things — a missing factory, unclear behavior at a boundary, sometimes a bug in a neighboring part of the code. That's normal and valuable.

Manual testing still matters. Tests catch logic errors; manual testing catches what tests can't — visual issues, unexpected interactions, gaps in the scenarios you thought of. The notebooks the tests build are a good starting point for a manual check, and a manual check occasionally reveals an error in the tests.

## Invest in test infrastructure

Good tests require good tooling. Factories, builders and support helpers make it easy to set up a scenario and query the resulting state; without them, writing tests is painful and slow, which means tests don't get written.

<div class="rule">
<span class="rule-label">The rule</span>

If setting up a scenario is hard, invest in the helper first. It pays for itself across every future test. A skipped test is technical debt; a helper is investment.

</div>

Both workflows above hit this: the bug fix needed `editNote` on the builder, and the archive feature needs a way to put a notebook into "sync pending" without a live network. The moment you find yourself writing `let notebook = Notebook(...); notebook.title = "…"; store.insert(notebook); try store.save()` for the third time, that's a factory. How a helper is shaped — value factory, scenario factory, or builder step — is <a href="/guide/10-4-factories-builders-and-fixtures">Chapter 10.4</a>; where it lives in the target is <a href="/guide/10-3-suite-layout-and-test-kinds">Chapter 10.3</a>.

<div class="seealso">
<strong>Ahead in this chapter</strong>
Where those helpers go, and which tests run on every <code>Cmd+U</code> versus on demand, is next: <a href="/guide/10-3-suite-layout-and-test-kinds">Chapter 10.3, Suite Layout and Test Kinds</a>.
</div>
