---
title: "Which Tests to Write"
description: "A test earns its place only if it can fail for a reason you care about. This subchapter covers the value question, the nine rules that keep a test from becoming a change detector, which of the architecture's layers get tests at all, how to make trapped logic testable, and the one place a test double is allowed."
order: 10
subOrder: 1
---

A test earns its place only if it can fail for a reason you care about. This subchapter covers the value question, the nine rules that keep a test from becoming a change detector, which of the architecture's layers get tests at all, how to make trapped logic testable, and the one place a test double is allowed.

## The value question

A test earns its place only if it guards a <strong>decision, a transformation or an invariant that could plausibly regress</strong>. Before writing one, name the bug it would catch. If every conceivable failure would be resolved by "update the test to match the new code", it is a change detector, not a safety net. Don't write it.

<div class="rule">
<span class="rule-label">The value question</span>

If this test goes red six months from now, will the person seeing it thank it or curse it?

</div>

- **High value:** it fails because behavior changed unintentionally. Deleting a notebook stopped cascading to its notes, the fallback sort stopped applying, a parser dropped a field. The failure points at a real bug.
- **Low value:** it fails because someone reworded copy, added an enum case, reordered a list or refactored internals. The behavior is fine and only the expectation was stale. Every such failure trains people to ignore red tests.

Good models in the notebook app: removing the last note from a tag deletes the orphaned tag; setting the export directory to `nil` falls back to the registered default; recent notebooks are ordered most-recent-first. Each guards a rule that could silently regress.

## What to test at each layer

The Foundation/AppKit boundary from <a href="/guide/01-getting-started">Chapter 1</a> is also the testing boundary: nothing that touches AppKit gets a direct test, because there's no decision inside it that can regress independently of what it coordinates.

<div class="table-wrap">
<table>
<thead><tr><th>Component</th><th>Test?</th><th>Notes</th></tr></thead>
<tbody>
<tr><td>Models &amp; managers</td><td><span class="pill">Yes</span></td><td>Test the interface — <code>NoteManager.shared.pull(notebookID:)</code> — not the job it schedules.</td></tr>
<tr><td>Action Validators</td><td><span class="pill">Yes</span></td><td>Pure precondition logic, Foundation-only.</td></tr>
<tr><td>View State Controllers</td><td><span class="pill">Yes</span></td><td>Foundation-only data shaping — the one testable controller kind.</td></tr>
<tr><td>Actions</td><td><span class="pill">Only if multi-step</span></td><td>An Action that forwards a single manager call is covered by the manager's test.</td></tr>
<tr><td>Action Controllers</td><td><span class="pill">No</span></td><td>Present UI. Test the Action they dispatch instead.</td></tr>
<tr><td>All other controllers</td><td><span class="pill">No</span></td><td>Coordination only. Test what they coordinate.</td></tr>
<tr><td>View controllers &amp; views</td><td><span class="pill">No</span></td><td>Extract the logic into a View State Controller and test that.</td></tr>
</tbody>
</table>
</div>

Controllers coordinate — they wire collaborators together, present dialogs, observe notifications, and forward calls. There is no decision in them that can plausibly regress on its own, so a controller test either restates the wiring or turns into a test of everything the controller touches. The criterion is the boundary itself:

- **Touches AppKit** (Action Controllers, window controllers, menu controllers, view controllers) — never tested. There is nothing to assert that isn't UI presentation.
- **Pure Foundation** — testable <em>if</em> it actually produces data. In practice that means one kind: the View State Controller, a Foundation-only class that loads data from the model layer and shapes it for display — filter, group, sort, format. It has real input-output behavior, so it's tested directly on its shaped output: how many items, in what order, grouped how, which ones filtered out. Never on its internal loading mechanics.

Test what the controller coordinates instead: an Action Controller's Action, a view controller's View State Controller, a background controller's manager function or model behavior. <a href="/guide/10-6-testing-each-layer">Chapter 10.6</a> works each of these through in the notebook app.

## Extract logic to make it testable

When logic is trapped in an untestable layer — usually conditional logic deep in a view controller — the answer is not a UI testing framework. Extract the logic into a Foundation-only type and test that.

Imagine a view controller that shows one of three empty-state views — an empty list, a syncing spinner, or an error message — based on three flags:

```swift
if notes.isEmpty {
    if isSyncing { showSyncingPlaceholder() }
    else if syncError != nil { showErrorPlaceholder(syncError) }
    else { showEmptyPlaceholder() }
}
```

Pull the decision out into a type with no AppKit dependency:

```swift
enum NoteListPlaceholder: Equatable { case none, empty, syncing, syncFailed(String) }

struct NoteListPlaceholderResolver {
    static func placeholder(noteCount: Int, isSyncing: Bool, syncError: Error?) -> NoteListPlaceholder {
        guard noteCount == 0 else { return .none }
        if isSyncing { return .syncing }
        if let error = syncError { return .syncFailed(error.localizedDescription) }
        return .empty
    }
}
```

Now each combination that reaches a different branch is one test:

```swift
func testPlaceholder_NotesPresent() {
    XCTAssertEqual(NoteListPlaceholderResolver.placeholder(noteCount: 3, isSyncing: true, syncError: nil), .none)
}

func testPlaceholder_EmptyWhileSyncing() {
    XCTAssertEqual(NoteListPlaceholderResolver.placeholder(noteCount: 0, isSyncing: true, syncError: nil), .syncing)
}

/// Syncing wins over a stale error: the spinner shows until the retry settles.
func testPlaceholder_EmptyWhileSyncingWithStaleError() {
    let error = SyncError.unauthorized
    XCTAssertEqual(NoteListPlaceholderResolver.placeholder(noteCount: 0, isSyncing: true, syncError: error), .syncing)
}
```

The view controller becomes a `switch` over the result, with nothing left in it to test. The extraction serves double duty: it makes the behavior testable, and edge cases like "both `isSyncing` and `syncError` set" surface as combinations to enumerate rather than as unexpected runtime behavior. This applies whenever logic is nested in an untestable layer — and it's the only answer to a private method that seems to need tests: a private method complex enough to test is a type waiting to be extracted.

## The rules

**1. Test logic, not literals.** If a type only maps inputs to constant strings or values, asserting those literals restates the source file: test and code change together, in the same commit, by the same author, and the test can never disagree meaningfully. It will fail on every intentional copy change. When the type contains a real decision — "use the server-provided description when present, otherwise the generic message" — test <strong>which branch was taken</strong> with the weakest assertion that proves it:

```swift
// Brittle: breaks on any copywriting change, catches no logic bug
XCTAssertEqual(message.title, "Could Not Sync Notebook")

// Tests the decision: the server payload wins over the generic fallback
let withPayload = SyncFailureMessage(error: .rejected(reason: "Notebook is read-only"), operation: .push)
let without = SyncFailureMessage(error: .rejected(reason: nil), operation: .push)
XCTAssertEqual(withPayload.message, "Notebook is read-only")
XCTAssertNotEqual(without.message, withPayload.message)
```

If there is no branching at all, write no test.

**2. No logic, no test.** Catalogs, static configuration tables and mapping dictionaries — the table of export formats, the map from a tag color name to its swatch — contain nothing to compute; a test over them can only re-list the same data. If an invariant over the data matters (uniqueness, completeness, no dangling references), enforce it <strong>in production code</strong> where it cannot be skipped: an `assert` at construction, or a construction that makes the invariant unbreakable, such as building the dictionary from `allCases`.

**3. No loops or conditionals in a test body.** A loop hides which case failed, passes silently when the collection is empty, and adds test-side logic that can itself be wrong. Write one method per meaningful scenario; if scenarios differ only by data, test one representative case or move the invariant into production code (rule 2). Non-standard tests may warrant an exception, chosen with care and explained in a comment: a contract test asserting that every bundled theme file parses, or a live test printing a page of results. The body of a normal behavior test never contains `for`, `while` or `if`.

**4. No hand-maintained mirrors of production data.** A test that keeps its own copy of `allCases`, an expected selector list or an expected format-name string verifies transcription, not behavior: adding an export format now means updating the enum, the catalog and the test's private copy, and the test passes as long as all three agree — even when all three are wrong.

**5. Setup effort matches what is proven.** Building a notebook with a dozen notes, a tag graph and a pending sync to then assert a dictionary lookup is a smell: the assertion is about static wiring and the expensive setup adds only runtime and fragility. Either the thing proven justifies the setup, or the assertion is trivial and the test should not exist.

**6. Edge cases over coverage.** The happy path plus every boundary where the code decides something: an empty notebook, the last note, a conflicting edit, an unset setting, a renamed note, a title at the length limit. Lines covered is not a goal; 100 % coverage produces exactly the low-value tests rules 1 and 2 forbid. The hard part of testing is deciding what is complex and critical, and that judgment is the work.

**7. Combinations.** When a state is a combination of flags, test the combinations that reach <strong>different code paths</strong>, not the cross product. Five flags of which three take the same branch need one test for that branch, plus one per remaining branch — the placeholder resolver above needs four tests, not eight.

**8. Order dependencies.** When correctness depends on checks running in an order that a later change could flip — a delete validator checking "is syncing" before "is empty" — test both orders even though today only one is reachable. The test guards the reordering.

**9. Brittleness check before committing.** Run the mental diff: <em>copy reworded → must not break; data reordered → must not break; internals refactored → must not break; behavior changed → must break.</em> A test failing any of the first three is brittle. Fix the test's altitude, not the code.

## What to test

- **All non-trivial logic:** parsing, mapping, validation, state transitions, anything with more than one code path, wherever it lives.
- **Bug fixes:** reproduce the bug in a failing test first, then fix — the workflow is <a href="/guide/10-2-testing-workflows">Chapter 10.2</a>. If you cannot write the test, ask why: a missing factory or builder primitive is written first, code that resists testing is restructured.
- **The public interface**, not the mechanism behind it: `NoteManager.shared.pull(notebookID:)`, not the `PullNotesJob` it enqueues; the model's query, not the store underneath it.
- **Components that add a decision** over the ones they call. A multi-step Action or a coordinator with branching is tested; one that forwards a single call is covered by the callee's tests and needs none of its own.

## What not to test

- **Trivial code.** Appending to an array, setting a property, a one-branch helper. The probability of a bug is near zero and the maintenance cost is not.
- **View glue and coordinating controllers.** Anything touching AppKit is never tested, per the layer table above. When a controller does hold logic worth guarding, extract it into a plain Foundation type and test that.
- **Private methods.** Never, by any means. A private method complex enough to need its own tests is a type waiting to be extracted.
- **Test infrastructure.** A factory or harness is self-validating through use; if it breaks, every test using it fails first.

## Real collaborators, seams only at external boundaries

Use the real thing wherever it can run in a test: the in-memory database, a real notebook built through the real store, a real temporary directory on disk. Do not introduce a protocol, an init parameter or a settable shared instance so that a test can swap in a mock — that couples the test to the implementation and makes it pass while the integrated code fails. The seams this guide accepts sit at <strong>external boundaries you cannot control</strong>: the network, an external process, credentials, time. Replacing an internal collaborator with a double is the case to push back on.

This is why `NoteManager`'s `init` is private and tests reach it through `.shared`, exactly as production does (<a href="/guide/02-5-object-wiring">Chapter 2.5</a>): there is no injected-client seam to construct it with. The stub sits one layer down, at the HTTP boundary, intercepting the request `SyncClient` would otherwise send over the real network — `SyncClient` itself, request building and response decoding all still run for real. Doubles that do exist produce the <strong>external shape</strong> their real counterpart would (the payload builders in <a href="/guide/10-4-factories-builders-and-fixtures">Chapter 10.4</a>), so the full transformation pipeline runs in the test.

## Review checklist

Flag a test when any of these hold:

- Asserts exact user-facing copy (full-string equality on titles or messages).
- The subject under test is a static data declaration with no branching.
- A loop, a conditional, or a hand-maintained mirror of production data in the body of a normal behavior test.
- Expected values are the same literals as the source file, verbatim.
- Heavy setup (a built notebook, a database graph) feeding a constant-lookup assertion.
- A protocol or seam introduced only so this test can swap in a double.
- You cannot name a realistic regression this test would catch.

<div class="seealso">
<strong>Ahead in this chapter</strong>
With the judgment settled, the two disciplines that produce most tests — fixing a bug and building a feature — are next: <a href="/guide/10-2-testing-workflows">Chapter 10.2, Testing Workflows</a>.
</div>
