---
title: "Suite Layout and Test Kinds"
description: "A test target has a fixed shape: a mirror of the module under test, the infrastructure around it, and the special-run suites that don't run on every Cmd+U. This subchapter covers that layout, the precise meaning of fixture, factory and builder, and the four kinds of test — tests, live integration tests, performance tests and contract tests — with the test plans and environment gates that keep them out of the default run."
order: 9
subOrder: 3
---

A test target has a fixed shape: a mirror of the module under test, the infrastructure around it, and the special-run suites that don't run on every `Cmd+U`. This subchapter covers that layout, the precise meaning of fixture, factory and builder, and the four kinds of test — tests, live integration tests, performance tests and contract tests — with the test plans and environment gates that keep them out of the default run.

The layout applies to every Swift test target you own: the app target in an Xcode project and the test targets in Swift packages alike. Every rule in it serves the one goal from <a href="/guide/09-testing">Chapter 9</a> — a test is read top to bottom, in one file, and finding the test for a source file is mechanical.

## The shape

The test target root holds exactly three kinds of things: the <strong>mirror</strong> of the module under test, the <strong>infrastructure</strong> around it, and the <strong>special-run</strong> suites.

```
NotebookAppTests/               test target root (Xcode) — or Tests/NotebookSyncTests/ (SwiftPM)
  NotebookApp/                  the mirror: one folder per source folder, one test file per source file
    App/
      Startup/
    Integrations/
    UI/
      Screens/
        NoteList/
  Factories/                    Swift code that builds values and scenarios
  Resources/                    files bundled into the test bundle
  Support/                      everything else that is not a test: environment setup, shared assertions, doubles, loaders
  LiveIntegration/              optional — tests that talk to a system you do not control
  Performance/                  optional — measure {} tests
  Contracts/                    optional — tests that pin a promise of the whole module
```

The mirror sits in a folder named exactly like the module — `NotebookApp`, `NotebookSync`, `MarkdownImport`. That one level is what makes the layout work: a source folder called `Support` or `Resources` can never collide with the test infrastructure, the root shows tested code and infrastructure apart at a glance, and finding a test is mechanical: `<TestTarget>/<Module>/<path relative to the module's source root>`. The alternative — one `TestSupport/` folder with the mirror at the root — doesn't survive a test target that covers more than one module, which an app target with several top-level source folders is. The source tree being mirrored is the one laid out in <a href="/guide/01-1-project-layout">Chapter 1.1</a>.

Keep SwiftPM's `Tests/<Target>Tests/` layer. Don't set `path: "Tests"` on the test target to save a level; it blocks a second test target for the rest of the package's life.

## What goes where

<div class="table-wrap">
<table>
<thead><tr><th>Folder</th><th>Holds</th><th>Does not hold</th></tr></thead>
<tbody>
<tr><td><code>&lt;Module&gt;/</code></td><td>Test files. The path mirrors the source file the test exercises. A source file with several operations may have one test class per operation, all in the mirrored folder (<code>NotebookCore/Notes/MoveNoteTests.swift</code> in the model package's test target, <code>DeleteNoteTests.swift</code>). Scenario helpers, builders, test doubles and assertions that only one test file uses live in that file, <code>fileprivate</code> at file scope.</td><td>Helpers used by more than one file. Value factories for model types and environment infrastructure, which live in <code>Factories/</code> and <code>Support/</code> from their first use.</td></tr>
<tr><td><code>Factories/</code></td><td>Value factories for model types (<code>Note.make(...)</code>), from their first use; scenario factories (<code>Notebook.makeThreeNotes()</code>) once a second file needs them; payload builders producing the external shape (<code>SyncPayloads.note(...)</code>); the shared default values a factory reads (<code>NoteDefaults</code>).</td><td>Test doubles, loaders, assertions. Scenario factories only one test file uses — those stay private in that file.</td></tr>
<tr><td><code>Resources/</code></td><td>Files: captured import documents, recorded sync responses, whole notebook bundles. Grouped by what the data is (<code>Imports/</code>, <code>Themes/</code>, <code>LiveIntegrationTargets/</code>), never in a folder called <code>Fixtures</code>. Declared with <code>.copy</code> or <code>.process</code> in <code>Package.swift</code>.</td><td>Swift code.</td></tr>
<tr><td><code>Support/</code></td><td>Infrastructure that sets up the environment tests run in, from its first use: temp-directory and temporary-storage helpers, isolated user defaults, process and output capture, resource loaders, Swift Testing tags, the environment gates described under <em>Gating a package that runs from <code>swift test</code></em>. Shared assertions with <code>file:line:</code> and shared test doubles (<code>StubURLProtocol</code>). <code>Support/LiveIntegration/</code> holds the harness of the live integration suites (credentials, probes, printers, the gate).</td><td>Anything that builds a value of the module under test — that is a factory. Test doubles, harnesses and assertions tailored to one test file; they stay <code>fileprivate</code> in that file (<a href="/guide/09-5-inside-a-test-class">Chapter 9.5</a>).</td></tr>
<tr><td><code>LiveIntegration/</code>, <code>Performance/</code>, <code>Contracts/</code></td><td>See below.</td><td>Tests that belong in the mirror.</td></tr>
</tbody>
</table>
</div>

The root itself holds only target configuration — `Info.plist`, a bridging header. No loose Swift files.

### Subfolders in `Support/`

`Support/` is flat by default. A subfolder groups shared helpers, and exists for one of two reasons only: `Support/` has grown too crowded to scan, or a set of helpers is shared by only some test files rather than the whole target — `Support/LiveIntegration/` is the standing example. A subfolder is never the home for helpers tailored to a single test file, such as a `Support/NoteList/` folder next to one test class; those stay in that test file.

## Vocabulary

Three words, used precisely:

- **Fixture:** a fixed, known state a test runs against, that the test <em>loads</em> rather than builds. In these suites that is a file in `Resources/`. The word appears in loader APIs (`Fixture.data(named:)`) and nowhere else. Fixtures are used sparingly — <a href="/guide/09-4-factories-builders-and-fixtures">Chapter 9.4</a> says when.
- **Factory:** code that builds a value on demand, with defaults, so a test names only what it cares about. Lives in `Factories/`.
- **Builder:** a factory's DSL for composing a scenario step by step — `Notebook.make { n in n.createNote(titled: "A") }`. Builders live in `Factories/` or come from a test-support package; a test uses them inline.

`Fixtures/` as a folder name is retired. It tends to mean model factories, payload builders and data files in different places and matches none of them well.

## Kinds of tests

### Tests

The default kind, and the only kind that needs no qualifier. A test that writes a real notebook through the real store into the in-memory database, or builds a real directory tree in a temp folder, is still just a test. There is no separation of unit from functional from integration by folder, class name or target — purist definitions would put the whole suite in "integration", and the categorization argument produces nothing but folders. Tests live in the mirror and run on every `Cmd+U` and every CI run.

### Live integration tests

Tests that exercise your code integrated with a <strong>system you do not control</strong>: the real sync service with real credentials, a paid API, a network. Their failures point at account state, rate limits and provider changes, not at your code, so they run on demand.

The name is <strong>live integration</strong>, always both words. "Integration" alone can't mark these tests out: several components exercised together describes most ordinary tests too, which is why it isn't a category here. "Live" is the qualifier that says what sets these tests apart — they leave the process and talk to the real thing — and the two words together say what the test does without further explanation. Use the full term in folder, class, plan, gate and environment-variable names; never shorten it to "integration tests", which is ambiguous, or to "live" alone in a name.

- Folder `LiveIntegration/` at the target root. Harness in `Support/LiveIntegration/`. Presets in `Resources/LiveIntegrationTargets/`.
- Class names end in `LiveIntegrationTests`: `SyncServiceLiveIntegrationTests`.
- Excluded from the default test plan by suite name, included by a `LiveIntegrationTests.xctestplan`. Swift Testing suites additionally carry `.tags(.liveIntegration)`.
- Behind their own gate as well, in a package that runs from `swift test` (below), so credentials on disk are never enough to run them.
- A live integration test that cannot run <strong>skips with a reason</strong>; it never returns green having done nothing. A soft `guard ... else { return }` is a passing test that proved nothing.
- Assertions are on <strong>shape</strong>, not content: ids non-empty, enums decode, pagination advances. Content drifts. Exact-set assertions are allowed only inside state the suite provisions itself.
- Edge cases and error paths are never live integration tests. They belong in the mirror, where the input is synthesized.

```swift
/// Proves the real service still speaks the shape `SyncClient` decodes. Asserts nothing about content.
final class SyncServiceLiveIntegrationTests: XCTestCase {
    override func setUpWithError() throws {
        try LiveIntegrationGate.skipUnlessEnabled()   // Support/LiveIntegration — before any credential lookup
    }

    func testFetchNotes_DecodesFirstPage() async throws {
        guard let token = LiveIntegrationCredentials.syncToken else {
            throw XCTSkip("no sync token; run the credential sync script")
        }
        let client = makeSyncClient(token: token)

        let page = try await client.fetchNotes(in: LiveIntegrationCredentials.provisionedNotebookID)

        XCTAssertFalse(page.notes.isEmpty)
        XCTAssertNotNil(page.nextCursor)
    }
}
```

### Performance tests

`measure {}` tests. Folder `Performance/`, class names end in `PerformanceTests` (`NoteSearchIndexPerformanceTests`), excluded from the default plan and selected by `PerformanceTests.xctestplan` — and, in a package that runs from `swift test`, gated by the environment variable below as well, because the plan alone can't keep them out of that run. They don't live in the mirror because they don't verify a source file's behavior and aren't run with it. This is the one place a shared `static` subject built once per class is acceptable — a ten-thousand-note notebook, say — with a comment saying what it costs to build. They measure wall-clock time, not correctness, and running them on every commit only adds noise and flakiness to the fast feedback loop everything else in this chapter depends on.

### Contract tests

Tests that pin a <strong>contract the module promises its consumers</strong> — an interface guarantee that must hold across every case, and often across the other implementations that share it: the exit-code contract every command-line entry point honours, a sync wire format the app and the sync service must agree on, an export schema a producer and a consumer both depend on. What makes a test a contract test is that it guards that cross-cutting promise as a <em>whole set</em>, not any single behavior.

The cases usually cited are examples, not the definition: every bundled theme file parsing without error, every export format round-tripping a reference notebook, every command-line entry point accepting `--dry-run`. What they share is a module-wide guarantee. A golden-value or single-behavior test is therefore <strong>not</strong> a contract test, even when it pins something the whole module leans on — how a note's export file name is derived from its title, say. That is an ordinary test, and it lives in the mirror next to the code whose behavior it guards.

Contract tests have no single mirror location, so they get `Contracts/`. Class names end in `ContractTests` (`BundledThemesContractTests`). If a contract test needs a built artifact, it skips with a reason when the artifact is absent. Cheap contract tests aren't gated: they run on every build so CI keeps exercising them. A sweep over a resource set is the one place a loop over the set is the point of the test rather than a case matrix hiding which input failed — rule 3 in <a href="/guide/09-1-which-tests-to-write">Chapter 9.1</a>.

### Test plans

Every test target has a default plan that skips `LiveIntegration` and `Performance` suites by name, and one plan per special kind. Name them by what they select: `UnitTests.xctestplan` (the default), `LiveIntegrationTests.xctestplan`, `PerformanceTests.xctestplan`, `AllTests.xctestplan`. When adding a live integration or performance class, add its name to the skip list of the default plan and the selection of its own plan in the same commit — the two drift otherwise. Plans gate Xcode only; a package that also runs from `swift test` needs the environment gate in the next section, because `swift test` ignores plans.

### Gating a package that runs from `swift test`

`swift test` — what a Swift package runs locally and on CI — doesn't read `.xctestplan` files, so a plan's skip list can't keep a suite out of the package's default run. Gate the special-run suites with an environment variable instead:

- Each gated class skips itself with a reason when the variable is unset — `try XCTSkipUnless(ProcessInfo.processInfo.environment["NOTEBOOKCORE_RUN_PERFORMANCE_TESTS"] != nil, "…")` in `setUpWithError()`, or `.enabled(if:)` in Swift Testing — through one small `Support/` helper, so every gated class reads the same gate. Bare `swift test` and CI run green without them; `NOTEBOOKCORE_RUN_PERFORMANCE_TESTS=1 swift test` opts in. The suite shows as skipped with a reason, never as silently absent.
- Guard a lazily built `static` fixture <strong>and</strong> the `class` tearDown that cleans it up behind the same flag. Otherwise the tearDown's access to the fixture builds the expensive state the skip was meant to avoid.
- Keep the Xcode plan, and have it set the same variable in its environment. Selecting the plan then runs the gated suites with nothing to set by hand, and the command-line gate and the plan stay in sync through one variable.
- Only gate what is genuinely expensive or non-deterministic. The environment variable is the gate of record; the plan is a convenience on top of it.

```swift
// NotebookCoreTests/Support/PerformanceGate.swift
enum PerformanceGate {
    static let isEnabled = ProcessInfo.processInfo.environment["NOTEBOOKCORE_RUN_PERFORMANCE_TESTS"] != nil

    static func skipUnlessEnabled() throws {
        try XCTSkipUnless(isEnabled, "set NOTEBOOKCORE_RUN_PERFORMANCE_TESTS=1, or run PerformanceTests.xctestplan")
    }
}
```

The live integration suites get the same shape: a `LiveIntegrationGate` in `Support/LiveIntegration/` reading `NOTEBOOKCORE_RUN_LIVE_INTEGRATION_TESTS`, called from `setUpWithError()` of every `*LiveIntegrationTests` class before any credential lookup. The `LiveIntegrationTests` and `AllTests` plans set the variable; the default plan keeps skipping the suites by name too, so CI's scope never depends on the variable being absent from the runner, and a developer with real credentials on disk can run bare `swift test` without touching the real service.

A behavior that merely needs a large notebook — that a search sends one query to the index regardless of how many notes match, say — is an ordinary test, not a performance test: it stays in the mirror and runs ungated on every build, even when its `measure {}` sibling is gated.

<div class="seealso">
<strong>Ahead in this chapter</strong>
What goes into <code>Factories/</code>, and why there are exactly two shapes of factory, is next: <a href="/guide/09-4-factories-builders-and-fixtures">Chapter 9.4, Factories, Builders and Fixtures</a>.
</div>
