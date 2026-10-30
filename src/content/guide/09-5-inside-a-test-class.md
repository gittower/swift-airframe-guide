---
title: "Inside a Test Class"
description: "Every test builds its own state and is read in one place. This subchapter covers what that rules out — shared setUp, instance fields, helper-laden base classes — what a private helper may hide, assertions as free functions, naming, grouping tests by what they prove, and the rule that answers every double-testing question: test at the layer where the bug lives, pin once at each boundary it must cross."
order: 9
subOrder: 5
---

Every test builds its own state and is read in one place. This subchapter covers what that rules out — shared `setUp`, instance fields, helper-laden base classes — what a private helper may hide, assertions as free functions, naming, grouping tests by what they prove, and the rule that answers every double-testing question: test at the layer where the bug lives, pin once at each boundary it must cross.

## State is built in the test

No `setUp()` building test data, no `var notebook: Notebook!`. Each test builds what it needs at the top, in the order it needs it, using a factory or the builder inline.

```swift
// Avoid — read in two places, and the ivar goes `!` the moment one test wants a different notebook
final class MoveNoteTests: TestCase {
    var notebook: Notebook!
    var note: Note!

    override func setUp() async throws {
        notebook = try Notebook.makeThreeNotes()
        note = Note.all(in: notebook)[0]
    }
}

// Prefer — the test says what it starts from
final class MoveNoteTests: TestCase {
    func testMove_LeavesSourceNotebook() async throws {
        let source = try Notebook.makeThreeNotes()
        let destination = try Notebook.make { n in n.setTitle("Archive") }
        let note = try XCTUnwrap(Note.all(in: source).first)

        let action = MoveNoteAction(noteID: note.id, from: source, to: destination)
        action.perform()
        await action.waitUntilFinished()

        XCTAssertNil(Note.note(id: note.id, in: source))
        XCTAssertNotNil(Note.note(id: note.id, in: destination))
    }
}
```

A test with `setUp` is read in two places, and when tests diverge the `setUp` grows conditionals or the ivars go optional. A self-contained test can be moved, copied and changed without checking its siblings.

Accepted exceptions:

- **Cleanup** goes into the helper that created the resource, via `addTeardownBlock` (XCTest) or a `defer`, so the test body shows one line and no `setUp`/`tearDown` pair is needed.
- **Immutable configuration** as a `let` on the class or a file-level constant: a fixed-timezone `Calendar`, a decoder. Not data the test asserts on.
- **Performance tests** may share one expensive static subject built once per class, with a comment saying what it costs to build.

## Private helpers

- A private helper that builds <strong>state of the module under test</strong> is a scenario factory and follows the rule of two in <a href="/guide/09-4-factories-builders-and-fixtures">Chapter 9.4</a>. Two or three per file at most.
- A <strong>value factory for a model type</strong> is never private: it goes into `Factories/` from its first use, per the same subchapter.
- <strong>Infrastructure that sets up the environment</strong> a test runs in — temp directories, a temporary storage root, isolated user defaults, capturing output — goes into `Support/` from its first use, even if only one test file uses it yet. It is generic, and every test that needs the same environment should build it the same way.
- <strong>Test doubles and harnesses tailored to one test class</strong> — a gate that holds a job until the test releases it, a locked event log, a stub that answers one class's requests — follow the rule of two. Used by one test file, they stay in that file as `fileprivate` types or functions at file scope, below the test class, so the test reads in one place and their generic names stay out of the rest of the target. When a second file needs one, it moves to `Support/` unchanged. The same holds for a special builder or a custom assertion only one file uses.
- A <strong>wrapper that invokes the subject</strong> — `private func resolve(noteCount: Int, isSyncing: Bool) -> NoteListPlaceholder`, `private func parse(_ text: String)` — is fine and common: one per file, it saves the boilerplate the test isn't about.

## Assertions

- Custom assertions are <strong>free functions</strong> with `file: StaticString = #filePath, line: UInt = #line` (XCTest) or `sourceLocation: SourceLocation = #_sourceLocation` (Swift Testing), never methods on a base class. That's what makes a failure point at the test's line, not the helper's.
- One test class needs it: `fileprivate` in that file. Needed by a second file: `Support/Assertions.swift`.
- An assertion helper earns its place by removing real noise — canonical JSON comparison, async throws, reading a store's state. Don't wrap `XCTAssertEqual(request.httpMethod, "GET")`.
- Several assertions in one test are fine when they inspect one result from several angles. Check the whole result object in one test rather than one property per test.

```swift
/// Compares two notes field by field so a failure names the field, not "not equal".
func XCTAssertNotesEqual(_ lhs: Note, _ rhs: Note, file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertEqual(lhs.title, rhs.title, "title", file: file, line: line)
    XCTAssertEqual(lhs.body, rhs.body, "body", file: file, line: line)
    XCTAssertEqual(lhs.tags, rhs.tags, "tags", file: file, line: line)
    XCTAssertEqual(lhs.syncState, rhs.syncState, "syncState", file: file, line: line)
}
```

## Test base classes: avoid, with one allowed use

Avoid test base classes. They spread setup across levels, hide what a test depends on, and turn into a dumping ground for helpers that then can't be understood without the hierarchy.

A family of tests can still warrant one, when every member needs the same <strong>wiring</strong> that can't live in a helper call. In the notebook app that's `TestCase`: it gives each test its own in-memory database with automatic merging from background contexts, an isolated `UserDefaults` suite, and a fresh temporary documents directory, and tears all three down afterwards. That's the accepted shape — and the whole of it.

```swift
@MainActor
final class NoteManagerTests: TestCase {
    func testPull_MergesRemoteNotes() async throws {
        // Database, defaults and documents directory are ready; async tests start on the main actor.
    }
}
```

A base class holds wiring only, never factories, helpers or assertions. Those stay free functions and `Support/` extensions so a test that doesn't need the wiring — a parser test, a validator test — can still use them without inheriting a database it never touches. Most model-layer tests are `@MainActor` because the model layer is always entered on the main actor (<a href="/guide/05-model-layer">Chapter 5</a>).

## Naming

Test methods: `test<What>_<Condition>`, camelCase inside each part, base case without the condition — `testPull`, `testPull_EmptyNotebook`, `testArchive_LastActiveNotebook`. The expected result lives in the assertions, not in the name; the three-part `_ReturnsTrue` / `_ThrowsError` form isn't used because it restates the assertion, lengthens every name and describes implementation rather than behavior. Swift Testing keeps the same function names; the `@Suite` string is the subject (`"NoteManager.pull"`), `@Test` carries no label.

File names: `<Subject>Tests.swift`, `<Type>+<Extension>Tests.swift`. Class names name the subject, never the technique — `SyncClientTests`, not `SyncClientHTTPPipelineTests`. The one kind suffix is for the special-run suites: `LiveIntegrationTests`, `PerformanceTests`, `ContractTests` (<a href="/guide/09-3-suite-layout-and-test-kinds">Chapter 9.3</a>).

## Comments

A short doc comment on a test class, a scenario factory and any test whose reason isn't obvious from its name: what it guards, and what it deliberately doesn't assert ("what is asserted is the error case, never the wording"). It is the cheapest brittleness insurance there is.

## Grouping

### One class per behavior cluster

Group tests by what they prove. A type with three operations that each have several scenarios gets three classes — `MoveNoteTests`, `DeleteNoteTests`, `RestoreNoteTests` — in the type's mirrored folder. A type with little behavior gets one class. A cross-cutting mechanism gets one class for the mechanism: one class covering every sync operation at the request boundary, one class covering every HTTP status code's mapping to `SyncError` once.

A per-operation, per-provider or per-endpoint class exists only when that subject has a <strong>rule of its own</strong> — an export command that must never guess a path, an import option with real branching. "Each operation gets a test class" is not a rule; "each rule gets a home" is.

### Test at the layer where the bug lives, pin once at each boundary it must cross

This answers every question about testing the same thing twice.

- A behavior handled <strong>centrally</strong> — mapping an HTTP status to a `SyncError`, resolving an export option, pagination — gets its <strong>full case matrix once</strong>, in the class for that mechanism.
- Each <strong>boundary it must survive</strong> — the request, the manager's thrown error, the printed output — gets <strong>one exemplary test</strong> proving it arrives there, on one caller, not every caller. The comment on that test says what it adds beyond the mechanism's tests.
- A <strong>higher-level component</strong> over an extensively tested lower one gets its happy path plus the cases where <strong>it adds a decision</strong>. It never re-enumerates the lower component's matrix. If it adds no decision, it may need no test at all.
- When correctness depends on checks running in an <strong>order</strong> a later change could flip, test both orders even though today only one is reachable; the test guards the reordering.
- When the only way to reach a behavior is through a type's <strong>private helper</strong>, the helper is the layer the bug lives in, and it's missing a home. Give it one — a value type, a member on a model instance — and test it there. Never widen the helper's visibility for the test.

Concretely: `SyncErrorMappingTests` covers every status code once — 401 to `.unauthorized`, 404 to `.notebookNotFound`, 409 to `.conflict`, and so on. Then one test in `NoteManagerTests` pins the boundary:

```swift
/// SyncErrorMappingTests covers what each status maps to. What this adds is that the
/// mapped error survives the job and the runner and reaches the caller of `pull`.
func testPull_Unauthorized_SurfacesSyncError() async throws {
    let notebook = try Notebook.makeThreeNotes()
    stub(.get, "/notebooks/\(notebook.id)/notes") { _ in .status(401) }

    let environment = NotebookEnvironment(notebook: notebook)

    await XCTAssertAsyncThrowsError(try await environment.noteManager.pull()) { error in
        XCTAssertEqual(error as? SyncError, .unauthorized)
    }
}
```

There is no `testPull_NotFound_SurfacesSyncError`, no `testPush_Unauthorized_SurfacesSyncError`. One exemplary test proves the plumbing; the matrix stays where the mapping is.

### Splitting a large class

A class grows past what fits on a few screens: split by sub-feature into sibling files in the same mirrored folder — `NotebookTests`, `NotebookArchivingTests`, `NotebookSharingTests`. Never split by testing technique or layer.

## Review checklist

Flag a test or test file when any of these hold:

- State the test asserts on comes from a factory default the test did not pass.
- The test can only be understood by reading `setUp()` or a second helper file besides one factory.
- A shared scenario factory grew a parameter that changes its shape.
- More than three private scenario factories in one test file.
- A value factory for a model type, or infrastructure that sets up the test environment — temp directories, storage roots, isolated defaults — defined privately in a test file. It belongs in `Factories/` or `Support/`.
- A scenario factory, test double, harness or assertion in `Support/` (or a `Support/` subfolder) or `Factories/` that only one test file uses. It belongs in that file, `fileprivate` at file scope.
- A private helper whose visibility was widened so a test could reach it.
- A live integration test that returns instead of skipping, runs without its gate, or asserts content that drifts.
- A case matrix appears at two layers.
- A per-operation, per-provider or per-endpoint class with no rule of its own.
- A fixture file used where the test asserts on specific values, or a set of fixture files differing in one field.
- An infrastructure folder named `Fixtures`, a loose Swift file at the target root, or a `Resources/Fixtures` folder.
- A test base class holding anything besides wiring.

<div class="seealso">
<strong>Ahead in this chapter</strong>
With the shape of a test settled, the closing subchapter applies it layer by layer to the notebook app: <a href="/guide/09-6-testing-each-layer">Chapter 9.6, Testing Each Layer</a>.
</div>
