---
title: "Testing"
description: "Not everything earns a test. This closing chapter is about testing at the altitude where regressions actually happen, skipping the layers that structurally can't fail on their own, and reaching for real collaborators instead of mocks almost everywhere."
order: 10
---

Not everything earns a test. This closing chapter is about testing at the altitude where regressions actually happen, skipping the layers that structurally can't fail on their own, and reaching for real collaborators instead of mocks almost everywhere.

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
