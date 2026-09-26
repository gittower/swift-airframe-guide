---
title: "Suite Layout and Test Kinds"
description: "A test target has a fixed shape: a mirror of the module under test, the infrastructure around it, and the special-run suites that don't run on every Cmd+U. This subchapter covers that layout, the precise meaning of fixture, factory and builder, and the four kinds of test — tests, live tests, performance tests and contract tests — with the test plans that gate them."
order: 10
subOrder: 3
---

A test target has a fixed shape: a mirror of the module under test, the infrastructure around it, and the special-run suites that don't run on every `Cmd+U`. This subchapter covers that layout, the precise meaning of fixture, factory and builder, and the four kinds of test — tests, live tests, performance tests and contract tests — with the test plans that gate them.

The layout applies to every Swift test target you own: the app target in an Xcode project and the test targets in Swift packages alike. Every rule in it serves the one goal from <a href="/guide/10-testing">Chapter 10</a> — a test is read top to bottom, in one file, and finding the test for a source file is mechanical.

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
  Support/                      everything else that is not a test: assertions, doubles, loaders, harnesses
  Live/                         optional — tests that talk to a system you do not control
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
<tr><td><code>&lt;Module&gt;/</code></td><td>Test files. The path mirrors the source file the test exercises. A source file with several operations may have one test class per operation, all in the mirrored folder (<code>NotebookCore/Notes/MoveNoteTests.swift</code> in the model package's test target, <code>DeleteNoteTests.swift</code>).</td><td>Helpers used by more than one file.</td></tr>
<tr><td><code>Factories/</code></td><td>Value factories (<code>Note.make(...)</code>), scenario factories (<code>Notebook.makeThreeNotes()</code>), payload builders producing the external shape (<code>SyncPayloads.note(...)</code>), the shared default values a factory reads (<code>NoteDefaults</code>).</td><td>Test doubles, loaders, assertions.</td></tr>
<tr><td><code>Resources/</code></td><td>Files: captured import documents, recorded sync responses, whole notebook bundles. Grouped by what the data is (<code>Imports/</code>, <code>Themes/</code>), never in a folder called <code>Fixtures</code>. Declared with <code>.copy</code> or <code>.process</code> in <code>Package.swift</code>.</td><td>Swift code.</td></tr>
<tr><td><code>Support/</code></td><td>Assertions with <code>file:line:</code>, test doubles (<code>StubURLProtocol</code>), resource loaders, temp-directory helpers, process and output capture, Swift Testing tags. <code>Support/Live/</code> holds the harness of the live suites (credentials, probes, printers).</td><td>Anything that builds a value of the module under test. That is a factory.</td></tr>
<tr><td><code>Live/</code>, <code>Performance/</code>, <code>Contracts/</code></td><td>See below.</td><td>Tests that belong in the mirror.</td></tr>
</tbody>
</table>
</div>

The root itself holds only target configuration — `Info.plist`, a bridging header. No loose Swift files.

## Vocabulary

Three words, used precisely:

- **Fixture:** a fixed, known state a test runs against, that the test <em>loads</em> rather than builds. In these suites that is a file in `Resources/`. The word appears in loader APIs (`Fixture.data(named:)`) and nowhere else. Fixtures are used sparingly — <a href="/guide/10-4-factories-builders-and-fixtures">Chapter 10.4</a> says when.
- **Factory:** code that builds a value on demand, with defaults, so a test names only what it cares about. Lives in `Factories/`.
- **Builder:** a factory's DSL for composing a scenario step by step — `Notebook.make { n in n.createNote(titled: "A") }`. Builders live in `Factories/` or come from a test-support package; a test uses them inline.

`Fixtures/` as a folder name is retired. It tends to mean model factories, payload builders and data files in different places and matches none of them well.

## Kinds of tests

### Tests

The default kind, and the only kind that needs no qualifier. A test that writes a real notebook through the real store into the in-memory database, or builds a real directory tree in a temp folder, is still just a test. There is no separation of unit from functional from integration by folder, class name or target — purist definitions would put the whole suite in "integration", and the categorization argument produces nothing but folders. Tests live in the mirror and run on every `Cmd+U` and every CI run.

### Live tests

Tests that talk to a <strong>system you do not control</strong>: the real sync service with real credentials, a paid API, a network. Their failures point at account state, rate limits and provider changes, not at your code, so they run on demand.

The word is <strong>live</strong>, not integration. "Integration test" means several components exercised together, which describes most normal tests; using it for "hits the network" makes the term mean two things. `Live` says exactly what distinguishes these tests.

- Folder `Live/` at the target root. Harness in `Support/Live/`. Presets in `Resources/`.
- Class names end in `LiveTests`: `SyncServiceLiveTests`.
- Excluded from the default test plan by suite name, included by a `LiveTests.xctestplan`. Swift Testing suites additionally carry `.tags(.live)`.
- A live test that cannot run <strong>skips with a reason</strong>; it never returns green having done nothing. A soft `guard ... else { return }` is a passing test that proved nothing.
- Assertions are on <strong>shape</strong>, not content: ids non-empty, enums decode, pagination advances. Content drifts. Exact-set assertions are allowed only inside state the suite provisions itself.
- Edge cases and error paths are never live tests. They belong in the mirror, where the input is synthesized.

```swift
/// Proves the real service still speaks the shape `SyncClient` decodes. Asserts nothing about content.
final class SyncServiceLiveTests: XCTestCase {
    func testFetchNotes_DecodesFirstPage() async throws {
        guard let token = LiveCredentials.syncToken else {
            throw XCTSkip("no sync token; run the credential sync script")
        }
        let client = makeSyncClient(token: token)

        let page = try await client.fetchNotes(in: LiveCredentials.provisionedNotebookID)

        XCTAssertFalse(page.notes.isEmpty)
        XCTAssertNotNil(page.nextCursor)
    }
}
```

### Performance tests

`measure {}` tests. Folder `Performance/`, class names end in `PerformanceTests` (`NoteSearchIndexPerformanceTests`), excluded from the default plan and selected by `PerformanceTests.xctestplan`. They don't live in the mirror because they don't verify a source file's behavior and aren't run with it. This is the one place a shared `static` subject built once per class is acceptable — a ten-thousand-note notebook, say — with a comment saying what it costs to build. They measure wall-clock time, not correctness, and running them on every commit only adds noise and flakiness to the fast feedback loop everything else in this chapter depends on.

### Contract tests

Tests that pin a <strong>promise of the whole module</strong> rather than the behavior of one source file: every bundled theme file parsing without error, every export format round-tripping a reference notebook, every command-line entry point accepting `--dry-run`. They have no single mirror location, so they get `Contracts/`. Class names end in `ContractTests` (`BundledThemesContractTests`). If a contract test needs a built artifact, it skips with a reason when the artifact is absent. This is the one kind where a loop over a resource set is acceptable, explained in a comment — rule 3 in <a href="/guide/10-1-which-tests-to-write">Chapter 10.1</a>.

### Test plans

Every test target has a default plan that skips `Live` and `Performance` suites by name, and one plan per special kind. Name them by what they select: `UnitTests.xctestplan` (the default), `LiveTests.xctestplan`, `PerformanceTests.xctestplan`, `AllTests.xctestplan`. When adding a live or performance class, add its name to the skip list of the default plan and the selection of its own plan in the same commit — the two drift otherwise.

<div class="seealso">
<strong>Ahead in this chapter</strong>
What goes into <code>Factories/</code>, and why there are exactly two shapes of factory, is next: <a href="/guide/10-4-factories-builders-and-fixtures">Chapter 10.4, Factories, Builders and Fixtures</a>.
</div>
