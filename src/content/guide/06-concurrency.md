---
title: "Concurrency"
description: "Every layer above Packages is @MainActor-isolated, per Chapter 1. This chapter covers what runs on the other side of every await: how background work gets structured, ordered, and cancelled without letting re-entrancy corrupt the state it eventually writes back to."
order: 6
---

Every layer above Packages is @MainActor-isolated, per Chapter 1. This chapter covers what runs on the other side of every await: how background work gets structured, ordered, and cancelled without letting re-entrancy corrupt the state it eventually writes back to.

## Queues, runners, actors — when to reach for which

`@MainActor` alone is enough for one-at-a-time access to state with no suspension in between. The gap it leaves is a <strong>transaction across an `await`</strong> — two calls to the same method, overlapping, where the second must wait for the first to fully finish rather than interleaving with it. A custom actor looks like the fix, but it isn't: calling an actor's methods is itself asynchronous, which forces every call site — including simple reads — to suspend, and an actor's own re-entrancy means a second call can still interleave inside an `await`. Neither problem shows up with a plain struct wrapping a lock.

```swift
struct SerialTaskRunner: Sendable {
    private let state = State()

    private final class State: @unchecked Sendable {
        let lock = NSLock()
        var previous: Task<Void, Never>?
    }

    @discardableResult
    func run<T: Sendable>(
        _ operation: @Sendable @escaping () async throws -> T
    ) -> Task<T, Error> {
        state.lock.lock()
        let prev = state.previous
        state.lock.unlock()

        let task = Task.detached {
            _ = await prev?.value             // wait for predecessor
            try Task.checkCancellation()      // bail if cancelled while queued
            return try await operation()
        }

        state.lock.lock()
        state.previous = Task.detached { _ = try? await task.value }
        state.lock.unlock()

        return task
    }

    func cancelAll() {
        state.lock.lock()
        let prev = state.previous
        state.previous = nil
        state.lock.unlock()
        prev?.cancel()
    }
}
```

Every piece earns its place: it's a `struct` so copies are cheap and every copy still coordinates through the same underlying lock — which is how a runner shared across several managers keeps their writes from interleaving. `Task.detached` is deliberate — a plain `Task { }` inherits the caller's actor, which called from a `@MainActor` manager would run the "background" work on main and defeat the entire point. Enqueue itself stays synchronous, callable directly from `@MainActor` code with no suspension at the call site.

## Structuring background work as data, not closures

A closure captures whatever is in scope, which makes it easy to accidentally grab a mutable reference and silently break isolation. A job struct forces every input to be declared as a stored property at init — `Sendable` conformance makes the compiler enforce it, not code review.

```swift
// ❌ Closure — quietly captures the manager's mutable state
runner.run {
    let notes = try await client.fetchNotes(in: notebookID)
    self.store.apply(notes)             // compiles, breaks isolation silently
}

// ✅ Struct — every input declared, Sendable enforces it
protocol BackgroundJob: Sendable {
    associatedtype Context: Sendable
    associatedtype Output: Sendable
    func execute(context: Context) async throws -> Output
}

struct PullNotesJob: BackgroundJob {
    let notebookID: NotebookID           // frozen at init — let, not var

    func execute(context: SyncContext) async throws {
        let notes = try await context.client.fetchNotes(in: notebookID)
        try await context.store.merge(notes, into: notebookID)
    }
}
```

Each manager family declares its own `Sendable` context — `SyncContext` from <a href="/guide/03-model-layer">Chapter 3</a> — bundling exactly the services its jobs need. The manager's `enqueue` constrains on that context type, so a job built for one family is a compile error if handed to another manager's runner. For simpler cases with no runner involved — one or two inputs, nothing to compose — a plain `@MainActor` command struct gets the same input-freezing benefit without needing `Sendable` at all, because its properties never cross an actor boundary.

## Execution strategies: avoiding races by construction

The runner above solves ordering. It doesn't decide what "correct" means when the same operation is triggered twice before the first finishes — that's a separate choice, made per call site.

<div class="table-wrap">
<table>
<thead><tr><th>Strategy</th><th>Use when</th></tr></thead>
<tbody>
<tr><td><strong>Cancel-and-replace</strong></td><td>Only the latest call matters — search-as-you-type, loading data for a newly selected item.</td></tr>
<tr><td><strong>Serial (enqueue)</strong></td><td>Every call carries real work that must not be lost — saves, sequential mutations. <strong>Default when unsure.</strong></td></tr>
<tr><td><strong>Coalesce</strong></td><td>Concurrent callers want the same result — piggyback on the in-flight request instead of starting a second one.</td></tr>
<tr><td><strong>Gate (reject)</strong></td><td>A second call is genuinely invalid while the first runs — a non-repeatable operation. Use sparingly; the caller must see the rejection.</td></tr>
</tbody>
</table>
</div>

```swift
@MainActor
final class NoteSearchController {
    private(set) var results: [Note] = []
    private var runningTask: Task<Void, Error>?

    func search(query: String) {
        runningTask?.cancel()
        runningTask = Task {
            let found = try await NoteManager.shared.search(query)
            try Task.checkCancellation()   // a newer search may have superseded us
            self.results = found
        }
    }
}
```

The `try Task.checkCancellation()` immediately before the write is the load-bearing line in every strategy above — a superseded task must never overwrite what its replacement writes.

## Cancellation as part of a task's contract

A caller doesn't need a cancellation token — the `Task` returned by a manager method <em>is</em> the handle, and Swift's structured concurrency propagates cancellation through every `await` underneath it automatically.

<div class="rule">
<span class="rule-label">The rule</span>

A service that catches errors internally must re-throw `CancellationError` rather than mapping it into a domain error — otherwise the caller's `cancel()` has no observable effect. And per the manager pattern in <a href="/guide/03-model-layer">Chapter 3</a>, state is only ever written <em>after</em> the background work returns successfully — a cancelled job throws before that point, so main-actor state is untouched by construction. Cancellation is atomic for free; nothing extra has to be written to guarantee it.

</div>

Only store the returned `Task` when cancellation is a real requirement — a view dismissed mid-load, a newer request superseding an older one. A quick fire-and-forget call needs nothing beyond `Task { try? await … }`. And when async work shells out to an external process rather than another `await` chain, cancellation still flows the same way in — it just terminates at a system signal instead of a thrown error, via `withTaskCancellationHandler`'s `onCancel`.

<div class="seealso">
<strong>Ahead in this guide</strong>
How a view's own state object owns and cancels its loading `Task` — the consumer side of everything in this chapter — is <a href="/guide/07-views">Chapter 7</a>. Testing async, job-based code without mocking the runner is <a href="/guide/11-testing">Chapter 11</a>.
</div>
