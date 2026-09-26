---
title: "The Airframe Package"
description: "The observation core the view chapters lean on isn't something you hand-write — it ships as a small Swift package. This chapter covers what the Airframe package contains, why that slice and no more is reusable, how it sits above the Foundation/AppKit boundary as a pinned dependency, and the rule that decides what earns a place in it."
order: 11
---

The observation core the view chapters lean on isn't something you hand-write — it ships as a small Swift package. This chapter covers what the Airframe package contains, why that slice and no more is reusable, how it sits above the Foundation/AppKit boundary as a pinned dependency, and the rule that decides what earns a place in it.

## Two things share the name

This guide calls the whole architecture *Airframe*, and there is also a Swift package named `Airframe`. They are not the same size, so this chapter spells the noun out wherever the two could be confused. The **Airframe architecture** is everything in the ten chapters before this one — the four layers, the two paths through them, the main actor as the lock. The **Airframe package** is one small, app-agnostic slice of it, extracted so you don't rewrite it in every app: the state-observation core that <a href="/guide/08-3-state-observing">Chapter 8.3</a> is built on. Everything below is about the package.

## What ships in it

The package vends a single product — `import Airframe` — and requires macOS 14 or later and a Swift 6 toolchain, the floor for the Observation framework it's built on. Its whole public surface is the four names <a href="/guide/08-3-state-observing">Chapter 8.3</a> already uses, verbatim:

<div class="table-wrap">
<table>
<thead><tr><th>Name</th><th>What it is</th></tr></thead>
<tbody>
<tr><td><code>@StateObserving</code></td><td>A macro attached to a class. Generates the <code>observations</code> store and the private reconciliation method, and adds the <code>StateObserving</code> conformance.</td></tr>
<tr><td><code>Observations</code></td><td>The subscription and tracking store — <code>observe(publisher:)</code>, <code>observe(_:perform:)</code>, <code>track</code>, <code>cancelAll()</code>.</td></tr>
<tr><td><code>StateObserving</code> / <code>StateObservingContainer</code></td><td>The activation-lifecycle protocols: one method to declare (<code>observeState()</code>), activate/deactivate for free, and a container that propagates through a subtree.</td></tr>
<tr><td><code>@Tracked</code></td><td>A property wrapper making one property on a plain class observation-tracked, with an equality-guarded setter.</td></tr>
</tbody>
</table>
</div>

```swift
import Airframe

@StateObserving
final class NoteListController {
    @Tracked var query = ""

    func observeState() {
        observations.track { [weak self] in self?.render() }
    }

    func render() { /* read query, update the view */ }
}
```

That is the entire library. Everything <a href="/guide/08-3-state-observing">Chapter 8.3</a> explains about how it behaves — the subscribe-seed-track order, change-only delivery on the main queue, the generation guard against stale re-runs, the `didSet` re-arm — is the behavior of *this* code. The chapter teaches how to use the machinery correctly; the package is the machinery, so in your own app you use it rather than maintain it.

## Why only this slice is a package

The observation core is the one part of the architecture with no app domain anywhere in it. `@StateObserving` knows nothing about notebooks, notes, or sync — it is pure lifecycle-managed observation wiring, identical in every app that follows the pattern. That is exactly the shape of thing that belongs in a versioned, shared library: it generalizes completely, and hand-writing the `Observations` store and its cancellation-safety bookkeeping in every project would be repetitive and easy to get subtly wrong.

Everything else the guide describes carries app decisions and stays in your own code. Actions name real operations (<a href="/guide/06-1-actions">Chapter 6.1</a>); managers own real domain state (<a href="/guide/05-model-layer">Chapter 5</a>); controllers coordinate real screens. A "base Action" or "base manager" in a shared package would either be empty ceremony over a protocol you already have, or would drag one app's domain choices into every other app that depended on it — a seam that never earns its indirection, in the sense of <a href="/guide/02-5-object-wiring">Chapter 2.5</a>.

<div class="rule">
<span class="rule-label">The rule</span>

A component belongs in the Airframe package only when it is <strong>app-agnostic</strong> — no domain type appears anywhere in its API — <strong>and</strong> non-trivial enough that rewriting it per app is a real cost. The observation core clears both bars. A thin convention you could restate in a few lines does not: it stays a pattern the guide describes, not a dependency you add.

</div>

That rule is also what governs the package as it grows. New reusable framework components join it only when they pass both tests; a pattern that generalizes but is cheap to write, or one whose API can't be stated without naming a domain type, stays in the app.

## Adding it, and where it sits

Add the package as a Swift Package Manager dependency and depend on the `Airframe` product from the targets that consume it:

```swift
// Package.swift (or the Xcode package dependency)
.package(url: "https://github.com/your-org/swift-airframe.git", from: "1.0.0"),

// on the target
.product(name: "Airframe", package: "swift-airframe"),
```

Its place in the dependency graph is the one exception to <a href="/guide/01-1-project-layout">Chapter 1.1</a>'s package taxonomy. `NotebookCore` and `NotebookActions` are local-only and never published; libraries like `NotebookSync` may be remote but sit *below* the model. Airframe is a **pinned, remote dependency that lives above the Foundation/AppKit boundary** — `@StateObserving` and `@Tracked` are consumed by view controllers and views, which is the only place they make sense.

So only the app target, and any other UI-bearing target, depends on it. The Model and Actions packages must not — and cannot: Airframe imports Cocoa, and those two layers are Foundation-only, so the compiler rejects the dependency rather than a reviewer having to catch it. The boundary that keeps AppKit out of the model keeps Airframe out too, for free.

## Runtime library and macro

The package is two targets. `Airframe` is the runtime library you import — `Observations`, the protocols, `@Tracked`. `AirframeMacros` is a compiler plugin, built on [swift-syntax](https://github.com/swiftlang/swift-syntax), that backs the `@StateObserving` macro and is not part of the shipped runtime surface. The split is deliberate: the macro only removes wiring boilerplate, while every observation *semantic* lives in the runtime library, where it is unit-tested directly instead of through expanded macro output.

The practical consequence is that `Observations` and `@Tracked` are ordinary types you can reason about as such, and the macro is sugar over declaring `observations` and the reconciliation method yourself. It fills in only what's missing — a class that already declares those members keeps its own, so the macro never fights hand-written code.

<div class="seealso">
<strong>Where this connects</strong>
The lifecycle worked through in full — a view controller, a self-rendering view, and a container that arms a whole subtree — plus the seeding and re-arm edge cases, is <a href="/guide/08-3-state-observing">Chapter 8.3</a>. The package carries its own test suite, so in your app it's a trusted dependency you don't re-test: there's no decision of yours inside it that could regress, which is the same standard <a href="/guide/10-1-which-tests-to-write">Chapter 10.1</a> applies to everything else.
</div>
