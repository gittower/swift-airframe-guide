---
title: "Factories, Builders and Fixtures"
description: "Test data is built, not loaded. This subchapter covers the two shapes a factory takes and why there's no third, the defaults a factory carries and the rule that a test never asserts on one, payload builders that produce the wire shape, the narrow case where a fixture file is right, and the rule of two that decides when a private helper becomes a shared one."
order: 10
subOrder: 4
---

Test data is built, not loaded. This subchapter covers the two shapes a factory takes and why there's no third, the defaults a factory carries and the rule that a test never asserts on one, payload builders that produce the wire shape, the narrow case where a fixture file is right, and the rule of two that decides when a private helper becomes a shared one.

## Two kinds, and nothing in between

**Value factory.** `Type.make(...)`, a static extension on the type, every parameter defaulted, returns one well-formed instance. One line to call, one screen to read.

```swift
extension Note {
    /// A well-formed note with every field defaulted. Pass what the test asserts on.
    static func make(
        id: NoteID = NoteDefaults.id,
        title: String = NoteDefaults.title,
        body: String = NoteDefaults.body,
        tags: [Tag] = [],
        createdAt: Date = NoteDefaults.createdAt,
        editedAt: Date = NoteDefaults.editedAt,
        syncState: SyncState = .synced
    ) -> Note
}
```

**Scenario factory.** `Type.make<Scenario>()`, named after the state it produces, no parameters or at most an identifying one, and a doc comment that lists the resulting shape.

```swift
extension Notebook {
    /// "Journal" with three notes A → B → C created a minute apart, no tags, everything synced.
    static func makeThreeNotes() throws -> Notebook
}
```

There is no third kind. A `makeNotebook(notes: 3, tags: ["work", "home"], pinned: 1, pendingSync: true)` is neither: the reader cannot picture the result, every new test wants one more flag, and changing a default silently changes every caller. When a state is more than a named scenario, build it inline in the test with the builder DSL, where the reader sees each step:

```swift
let notebook = try Notebook.make { n in
    n.createNote(titled: "Groceries", body: "milk")
    n.tag("Groceries", with: "home")
    n.markSynced()
    n.editNote(titled: "Groceries", body: "milk, eggs")
}
```

The builder writes through the real store into the in-memory database — the same path production uses — so the notebook it hands back is a real `Notebook` the model layer's queries can read. This inline form is the preferred one for anything the test is specifically about. A named scenario factory is for the state a test merely starts from.

<div class="rule">
<span class="rule-label">The rule</span>

A factory uses the module's own write paths, never direct storage pokes, so it stays synchronized with production code. The builder's steps are the manager's operations wearing a shorter name.

</div>

## Defaults

- Defaults are <strong>well-formed and obviously fake</strong>: a fixed UUID, a title like "Test Note", `ada@example.com` for an author.
- Defaults are <strong>mutually distinct</strong>: `createdAt` and `editedAt` differ by one minute, ids don't share prefixes, a note's title and body are never the same string. A factory whose created and edited dates are equal cannot catch a field mix-up.
- <strong>Never assert on a default you did not pass.</strong> If a test checks the title, it passes the title. A test that reads `note.title == NoteDefaults.title` is testing a black box, and the next person to change the default breaks it without knowing why.
- Shared default values get their own `<Type>Defaults` enum only when a second builder has to agree with the factory — as the sync payload builders below have to describe the same note `Note.make()` builds, so a pull test can compare what came off the wire with what's in the store. Otherwise the defaults live as parameter defaults and nowhere else.

```swift
/// Values `Note.make` and `SyncPayloads.note` agree on. Every pair is deliberately distinct
/// so a test that mixes two fields up fails instead of passing on two equal values.
enum NoteDefaults {
    static let id = NoteID(UUID(uuidString: "5E1F0000-0000-4000-8000-000000000001")!)
    static let title = "Test Note"
    static let body = "Body of the test note."
    static let createdAt = Date(timeIntervalSince1970: 1_700_000_000)
    static let editedAt = createdAt.addingTimeInterval(60)
}
```

## Payload builders

Factories for input data in its external shape — API JSON, wire records, imported files — follow the same rules and are grouped in one namespace per source: `SyncPayloads.note(id:title:updatedAt:)`. They produce the shape the parser or mapper consumes, never the internal model, so that the transformation is what the test exercises.

```swift
enum SyncPayloads {
    /// One note as the sync service sends it. Field names are the wire names, not the model's.
    static func note(
        id: NoteID = NoteDefaults.id,
        title: String = NoteDefaults.title,
        body: String = NoteDefaults.body,
        updatedAt: Date = NoteDefaults.editedAt
    ) -> [String: Any] {
        ["note_id": id.rawValue.uuidString, "title": title, "content": body,
         "updated_at": ISO8601DateFormatter().string(from: updatedAt)]
    }

    /// A page of notes as `GET /notebooks/{id}/notes` returns it.
    static func notes(_ notes: [[String: Any]], nextCursor: String? = nil) -> [String: Any] {
        ["notes": notes, "next_cursor": nextCursor as Any]
    }
}
```

A test that stubs the network with `SyncPayloads.notes([...])` runs `SyncClient`'s real decoding and `PullNotesJob`'s real merge — <a href="/guide/10-6-testing-each-layer">Chapter 10.6</a> shows the whole test. A stub that handed back a ready-made `[Note]` would skip both.

## Fixtures, sparingly

A fixture file is a black box. The test cannot say which part of it matters, its shape is verified by nothing, and asserting a specific value against it means reading the file to find out what is in there. So a fixture is the right tool only when both hold: the input would be complex or unnatural to build in code, <strong>and</strong> the test covers one specific scenario rather than a family of them. A captured Markdown document with nested lists and checkboxes feeding `MarkdownImporter` is the canonical case: real, hard to synthesize faithfully, and each capture pins one parsing situation.

The moment a test needs many variants or asserts on particular values, switch to a payload builder or factory. That is why `SyncPayloads` exists instead of recorded responses: one recording could never cover pagination edges, missing fields, every sync state and every error body, but a builder produces each of those in one line, with the varying value visible in the test. If a suite is accumulating fixture files that differ in one field, that is a builder waiting to be written.

When a fixture is used: keep it small, name the file after the scenario it captures (`nested_lists_with_checkboxes.md`), and load it through one `Support/` loader so the bundle lookup is written once:

```swift
func testImport_NestedListsWithCheckboxes() throws {
    let markdown = try Fixture.string(named: "nested_lists_with_checkboxes.md", subdirectory: "Imports")

    let note = try MarkdownImporter().importNote(from: markdown)

    XCTAssertEqual(note.checklistItems.count, 4)
    XCTAssertEqual(note.checklistItems.filter(\.isDone).count, 1)
}
```

## Sharing: the rule of two

- A helper that builds state for <strong>one test file</strong> is a `private func make<Scenario>()` in that file. It stays tailored and can change freely.
- The moment a <strong>second file</strong> needs it, move it to `Factories/` unchanged. Not before: premature promotion turns a convenience into an API.
- Once in `Factories/`, a scenario factory's <strong>shape is frozen</strong>. Need a variation? Add `makeThreeNotesWithPendingEdit()`; don't add a parameter to `makeThreeNotes()`. The doc comment is the contract, and every caller relies on exactly that shape.
- A test file with more than two or three private scenario factories, or with private helpers that build state the module under test doesn't know about — writing store rows by hand, hand-assembling a sync response — is a signal: either the builder is missing a primitive (add it) or the test class covers too much (split it).

## Naming

<div class="table-wrap">
<table>
<thead><tr><th>Kind</th><th>Form</th><th>Example</th></tr></thead>
<tbody>
<tr><td>Value factory</td><td><code>Type.make(...)</code></td><td><code>Note.make(title: "Groceries")</code></td></tr>
<tr><td>Scenario factory</td><td><code>Type.make&lt;Scenario&gt;()</code></td><td><code>Notebook.makeThreeNotes()</code></td></tr>
<tr><td>Builder entry point</td><td><code>Type.make { n in ... }</code></td><td><code>Notebook.make { n in n.createNote(titled: "A") }</code></td></tr>
<tr><td>Payload builder</td><td><code>&lt;Source&gt;Payloads.&lt;resource&gt;(...)</code></td><td><code>SyncPayloads.note(title: "Renamed")</code></td></tr>
<tr><td>Subject under test with wiring</td><td><code>make&lt;Type&gt;(...)</code> free function in the test file or <code>Support/</code></td><td><code>makeSyncClient(token:)</code></td></tr>
<tr><td>Shared defaults</td><td><code>&lt;Type&gt;Defaults</code></td><td><code>NoteDefaults.editedAt</code></td></tr>
<tr><td>Private in a test file</td><td><code>private func make&lt;Scenario&gt;()</code></td><td><code>private func makeArchivedNotebook()</code></td></tr>
</tbody>
</table>
</div>

`fixture()` as a method name is retired; it names a factory after the thing it is not. An `_underscore` prefix on factory names (`_note()`, `_create`) is retired too — the test target's own prefix is the `Factories/` folder, and nothing in the name needs to repeat it.

<div class="seealso">
<strong>Ahead in this chapter</strong>
Inside the test class that calls these factories — no shared setup, what a helper may hide, one allowed base class, and how tests are grouped — is next: <a href="/guide/10-5-inside-a-test-class">Chapter 10.5, Inside a Test Class</a>.
</div>
