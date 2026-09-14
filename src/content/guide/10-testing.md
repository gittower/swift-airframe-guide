---
title: "Testing"
description: "Not everything earns a test. This closing chapter is about testing at the altitude where regressions actually happen, skipping the layers that structurally can't fail on their own, and reaching for real collaborators instead of mocks almost everywhere."
order: 10
---

Not everything earns a test. This closing chapter is about testing at the altitude where regressions actually happen, skipping the layers that structurally can't fail on their own, and reaching for real collaborators instead of mocks almost everywhere.

## Why so few tests: three myths

Every test you write is code you maintain. Before writing one, it's worth clearing away three common misconceptions that lead to test suites that feel burdensome rather than protective.

**100% code coverage.** Coverage measures lines executed; it does not measure decisions verified. Pursuing 100% coverage forces tests on code that structurally can't fail — `notebook.add(note); assert(notebook.contains(note))` — splitting your effort between low-value change detectors and the critical tests that actually catch regressions. Experience shows that critical bugs cluster in the lower, Foundation-only layers: the exact code that's easiest to test. Extract and test that layer thoroughly, and you've caught the vast majority of production regressions. Accept coverage in the 60–80% range. If a line is simple enough that you'd never make an error in it, don't test it.

**One assertion per test.** The real rule is one *scenario* per test — one input condition and its expected outcome. A test that pulls two notes and asserts the count, titles, and sync timestamps all together is one test, not four. Splitting it into `testPull_CountMatchesResponse`, `testPull_TitlesPopulated`, `testPull_TimestampsCorrect` triples your maintenance for no information gain. A test fails when it should fail; the assertion order doesn't matter.

**Mock every dependency.** Mock-heavy tests couple to implementation: they pass when your code is restructured wrongly and fail when restructured rightly, so they stop being a safety net. A test that exercises real collaborators — a real database, real file system, real domain object interactions — fails when any layer misbehaves, which is exactly the property you want. The exception is at external boundaries (network I/O, system processes), where a narrow stub replaces only the boundary itself, not the app's use of it. Use real collaborators by default; mock only where you have no other choice.

## What to test at each layer

The Foundation/AppKit boundary from <a href="/guide/01-getting-started">Chapter 1</a> is also the testing boundary: nothing that touches AppKit gets a direct test, because there's no decision inside it that can regress independently of what it coordinates.

<div class="table-wrap">
<table>
<thead><tr><th>Layer</th><th>Test?</th><th>Why</th></tr></thead>
<tbody>
<tr><td>Models &amp; managers</td><td><span class="pill">Yes</span></td><td>The write funnel from Chapter 5 — real decisions, real regressions.</td></tr>
<tr><td>Action Validators</td><td><span class="pill">Yes</span></td><td>Pure precondition logic, Foundation-only.</td></tr>
<tr><td>View State Controllers</td><td><span class="pill">Yes</span></td><td>Foundation-only data shaping — the one testable controller kind.</td></tr>
<tr><td>Actions</td><td><span class="pill">Only if multi-step</span></td><td>A single model call needs no test beyond the manager's own.</td></tr>
<tr><td>Action Controllers</td><td><span class="pill">No</span></td><td>Present UI. Test the Action they dispatch instead.</td></tr>
<tr><td>Views &amp; other controllers</td><td><span class="pill">No</span></td><td>Coordination only. Test what they coordinate, not the wiring.</td></tr>
</tbody>
</table>
</div>

<div class="rule">
<span class="rule-label">The value question</span>

Before writing a test, ask: if it goes red six months from now, will whoever sees it thank the test or curse it? A test that fails because behavior actually regressed earns its place. A test that fails because someone reworded a label or reordered an enum case trains people to ignore red tests — don't write it. Test the decision a type makes, never the literal string or constant it happens to produce today.

</div>

## Extract logic to make it testable

When you encounter logic that's trapped in an untestable layer — usually conditional logic deep in a view controller or action controller — the answer is not to add a UI testing framework. The answer is to extract the logic into a Foundation-only type where it becomes easy to test.

Imagine a view controller that shows one of three empty-state views: an empty list, a syncing spinner, or an error message. The logic is conditional on three flags: `notes.isEmpty`, `isSyncing`, `syncError != nil`. You might write:

```swift
if notes.isEmpty {
    if isSyncing { showSyncingPlaceholder() }
    else if syncError != nil { showErrorPlaceholder(syncError) }
    else { showEmptyPlaceholder() }
}
```

Extract this into a Foundation-only type:

```swift
enum NoteListPlaceholder { case empty, syncing, syncFailed(String), none }

struct NoteListPlaceholderResolver {
    static func placeholder(noteCount: Int, isSyncing: Bool, syncError: Error?) -> NoteListPlaceholder {
        guard noteCount == 0 else { return .none }
        if isSyncing { return .syncing }
        if let error = syncError { return .syncFailed(error.localizedDescription) }
        return .empty
    }
}
```

Now you can test all the combinations:

```swift
XCTAssertEqual(NoteListPlaceholderResolver.placeholder(noteCount: 0, isSyncing: true, syncError: nil), .syncing)
XCTAssertEqual(NoteListPlaceholderResolver.placeholder(noteCount: 0, isSyncing: false, syncError: testError), .syncFailed(_))
```

The view controller becomes simple:

```swift
let placeholder = NoteListPlaceholderResolver.placeholder(noteCount: notes.count, isSyncing: isSyncing, syncError: syncError)
switch placeholder {
case .empty: showEmptyPlaceholder()
case .syncing: showSyncingPlaceholder()
case .syncFailed(let msg): showErrorPlaceholder(msg)
case .none: hideAllPlaceholders()
}
```

The extracted type is testable because it has no dependencies on AppKit or UIKit — only Foundation. It's also simpler to reason about: the logic is no longer buried in a controller's lifecycle, and edge cases (what if both `isSyncing` and `syncError` are set?) surface as combinations to enumerate in a test, not as unexpected runtime behavior.

This pattern applies whenever logic is nested deep in an untestable layer. Never test a private method; instead, extract it into its own type. The extraction serves double duty: it makes the behavior testable and it makes the architecture clearer by separating concerns.

## Two workflows: fixing a bug and building a feature

Most of your testing happens in two contexts: you're fixing a bug or you're building a feature. Each has a discipline that makes testing efficient.

### Fixing a bug

Suppose `PullNotesJob` crashes when a note was renamed remotely while edited locally. The crash report shows the problem: the job tries to merge a note that no longer exists in the local database.

The discipline is: reproduce the bug with a failing test *before* touching the fix.

```swift
func testPull_RenamedNoteEditedLocally_Merges() async throws {
    let notebook = Notebook._notebook(
        notes: [
            .edited(title: "Original", editedAt: .now)
        ]
    )
    let response = SyncFixture.notesResponse([
        .remote(id: notebook.notes[0].id, title: "Renamed", updatedAt: .distantPast)
    ])
    stub(.get, "/notebooks/\(notebook.id)/notes") { _ in .json(response) }

    try await NoteManager.shared.pull(notebookID: notebook.id)

    let merged = try XCTUnwrap(notebook.notes.first)
    XCTAssertEqual(merged.title, "Renamed")
    XCTAssertEqual(merged.editedAt, .now)  // local edit preserved
}
```

Why write the test before fixing? Three reasons: it proves you understand the bug (you can construct the exact state that fails), it proves your fix works (the test goes green), and it becomes a permanent guard against reoccurrence (six months later, if someone refactors the merge logic, this test fails).

If you *can't* write the test, ask why. Usually the answer is a missing helper. You wanted `Notebook._notebook(notes: [.edited(...)])` but it doesn't exist. Write it — the helper pays for itself on the next bug:

```swift
extension Notebook {
    static func _notebook(notes: [Note] = []) -> Notebook {
        let notebook = Notebook(id: UUID(), title: "Test Notebook")
        for note in notes {
            notebook.add(note)
        }
        return notebook
    }
}

extension Note {
    static func edited(title: String, editedAt: Date) -> Note {
        Note(id: UUID(), title: title, body: "", editedAt: editedAt)
    }
}
```

Once the test goes red and you've fixed the bug, take a moment to add related cases the test suggests. If renaming while editing fails, does renaming-and-deleting also fail? What about renaming twice? Add those as empty method signatures first, then fill them in:

```swift
func testPull_RenamedAndDeletedLocally_PreservesRemoteVersion() async throws { }
func testPull_RenamedTwice_LastNameWins() async throws { }
```

Finally, step back: what else touches this path? Grep for usages of the merge logic, think through whether your change affects them, then do one manual test run of the app to confirm. The app run is confirmation, not the development loop.

### Building a feature

Before writing the implementation, write the *test method signatures only*. Suppose you're adding "archive notebook."

```swift
func testArchive_MovesNotebookOutOfActiveList() async throws {}
func testArchive_PreservesNotesOnDisk() async throws {}
func testArchive_WithSyncPending_WaitsForSync() async throws {}
func testArchive_LastNotebook_Throws() async throws {}
func testArchive_AlreadyArchived_Throws() async throws {}
```

Writing the signatures forces the questions that matter: What states can the notebook be in? What can go wrong? Which combinations trigger different code paths (test those; skip combinations that provably execute the same path)? Where do the tests go?

The answer to the last question uses the layer table as a guide:

- **Action test (one, full-flow):** Test that the Action coordinates the operation end-to-end. This is the only place you'll test that archiving actually removes the notebook from the UI. A single multi-step test: archive, verify the list refreshed, verify the archived notebook is gone.
- **Manager tests (edge cases):** Test preconditions and error cases. Can you archive a notebook with no notes? Can you archive the last active notebook? Does archiving trigger a sync? These tests verify that the manager enforces the rules.
- **Lower-layer tests (exhaustive):** If you extract a validator or state transformer for archive eligibility (e.g., `NotebookArchiveValidator`), test all the combinations that define the contract.

This distribution matters because it clarifies where code belongs. If you find you're writing the same test in two places, the logic probably belongs in one layer, not both. If a feature requires tests at every layer, that usually means the feature is complex enough to warrant extraction.

Why write signatures first? Because if you find you can't fill in a test without launching the app and manually setting up state, that's a signal: you're missing a helper. Fix that problem once (write the helper), and every future test becomes cheaper. The test-first discipline here — write signatures to enumerate cases, then write helpers to make cases cheap, then write the tests themselves — is where you invest the effort upfront and reap the savings across the whole test suite.

## Test doubles and fixtures for async and persistence-backed code

The default is to avoid mocks and use real collaborators: a real database against an in-memory store, a real temporary directory on disk, a real domain object graph. Each has enough real behavior — fetch predicates, file permissions, relationship cascades — that a mock layer over it mostly proves the mock returns what the test expects, not that the app works.

There's one structural exception: a network client is mocked, but only at its own library boundary — a `URLProtocol` stub on an ephemeral session, verifying request construction and response parsing. The app that <em>consumes</em> that client doesn't re-mock the network at all; it constructs the response objects directly, since they're plain Swift values, and tests what the app does with them. Fixtures should match that same external shape — the wire format a server would actually send — never the internal model shape, or the parsing code they're meant to exercise goes untested.

```swift
@MainActor
final class NoteManagerTests: TestCase {
    func testPull_MergesRemoteNotes() async throws {
        let notebook = Notebook._notebook()
        let response = SyncFixture.notesResponse(count: 2)   // external shape
        stub(.get, "/notebooks/\(notebook.id)/notes") { _ in .json(response) }

        try await NoteManager.shared.pull(notebookID: notebook.id)

        XCTAssertEqual(notebook.notes.count, 2)
    }
}
```

The test reaches `NoteManager` the same way production code does — `.shared`, never a constructor — because there's no injected-client seam to construct it with in the first place: `NoteManager`'s `init` is private, per <a href="/guide/05-model-layer">Chapter 5</a>. The stub sits at the HTTP boundary instead, intercepting the request `SyncClient` would otherwise send over the real network; `SyncClient` itself, request building, and response decoding all still run for real.

Async work follows Chapter 7's own contract: prefer `async` test methods over bridging helpers, and where cancellation matters, assert the terminal persisted and published state — not merely that an error was thrown. Cancellation may arrive after a durable write, so the expected outcome can be an accurately settled partial result rather than an untouched store.

## Test helpers are infrastructure

The `Notebook._notebook()` and `SyncFixture.notesResponse(count:)` helpers in the examples above aren't conveniences — they're a deliberately maintained layer of test infrastructure, as important as the tests themselves.

Helpers come in three kinds:

- **Factory methods** — create test objects in useful states. Use underscore-prefixed names (`_notebook()`, `_note()`) to mark them as test-only. A factory uses production write paths, never direct storage pokes, so it stays synchronized with real code.
- **Scenario builders** — compose objects into more complex states. `Notebook._notebook(notes: [.edited(...), .synced(...)])` builds a realistic scenario without scattered setup code.
- **Fixture builders** — produce external representations (API responses, file formats) that match what your app will encounter in production.

The investment in helpers pays for itself quickly. The moment you find yourself writing `let notebook = Notebook(...); notebook.title = "..."; notebook.add(note); try notebook.save()` for the third time, extract it into a helper. The first test is expensive (you build the helper), the next hundred are cheap.

One rule: if you can't write a test because the setup is tedious, the fix is a new helper, not a skipped test. Skipped tests are technical debt. Helpers are investment.

<div class="rule">
<span class="rule-label">Test the decision, not today's order</span>

Test all combinations that *define the contract*, not all combinations that happen to execute today. If `NoteListPlaceholderResolver` checks `isSyncing` before `syncError`, and both happen to be true, test that the syncing state wins — test the contract. Also test the other combinations that have different behavior. But if reordering the checks doesn't change the outcome, you don't need a separate test for that reordering. One representative test per distinct code path suffices.

</div>

## Testing jobs and progress

Exercise real jobs and manager entry points with temporary storage and narrow doubles at external process or network boundaries. Use a deliberate gate in the test double to hold an operation while submitting the next one; avoid timing assertions based on sleeps. Test the application's group declarations and resulting behavior:

- Queue a rename behind a note update, then verify both changes survive. This catches a job capturing its editable baseline too early.
- Export while a save is pending and verify the export sees the completed save. Also verify work on a different notebook can proceed.
- Delete a note during ongoing work, then submit a delayed edit. Verify the edit reports the missing note and cannot recreate it.
- Emit progress and then fail or cancel. Verify accepted progress precedes the final activity state, and a late callback cannot revive it.
- Fail persistence after a successful download. Verify the activity reports failure and no successful-save notification is published. If an earlier step already saved data, verify that committed change is published accurately.
- Start two draft requests with separate progress callbacks. Verify each caller receives only its own events, and a dismissed or replaced caller ignores stale updates.

For a worker-only test, call `job.perform(context: work)`; progress-reporting jobs inherit that overload with reporting disabled, and it does not run result handling. To test progress and persistence together, use the manager entry point or `job.execute(context: work, resultContext: result)`. Assert the final accumulated text and meaningful event order rather than an exact number of UI updates, since pending text deltas may be coalesced.

The app's coalescing rule is also a small, directly testable value operation:

```swift
// DraftSummaryJob.Progress is Equatable in this example.
XCTAssertEqual(
    DraftSummaryJob.coalesceProgress(.text("Hello"), .text(" world")),
    .text("Hello world")
)
XCTAssertNil(DraftSummaryJob.coalesceProgress(.text("Hello"), .stage("Saving")))
XCTAssertNil(DraftSummaryJob.coalesceProgress(.started, .text("Hello")))
```

## Where performance testing fits

Performance tests live in their own test plan, run separately from the default suite — they measure wall-clock time, not correctness, and running them on every commit only adds noise and flakiness to the fast feedback loop the rest of this chapter depends on. Naming them consistently (a shared suffix in the file name) keeps them filterable and keeps the two plans from drifting out of sync as tests are added.

<div class="seealso">
<strong>End of the guide</strong>
That closes the ten chapters. <a href="/">Back to the overview</a> for the full map, or start again from <a href="/guide/01-getting-started">Chapter 1</a>.
</div>
