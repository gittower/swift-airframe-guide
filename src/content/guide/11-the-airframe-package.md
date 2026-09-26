---
title: "The Airframe Package"
description: "The generic spine the ten chapters before this one describe ships as one Swift package. This chapter covers what the package provides — one product per part, carved along the Foundation/AppKit line — the two ways a target imports it, where it sits in the project's dependency graph, and the rules that decide what becomes a product."
order: 11
---

The generic spine the ten chapters before this one describe ships as one Swift package. This chapter covers what the package provides — one product per part, carved along the Foundation/AppKit line — the two ways a target imports it, where it sits in the project's dependency graph, and the rules that decide what becomes a product.

## What the package provides

Airframe provides the generic spine of a Mac app and leaves the domain to the app. State observing, the controller and Action base layers, view scaffolding, navigation, lifecycle: those are the framework's. Concrete managers, Actions, menus, services, screens: those are yours. The line between the two is the line every chapter has drawn between a pattern and the notebook app's use of it — `Action` is the framework's, `MoveNoteAction` is the app's; `StateObserving` is the framework's, `NoteListViewController.observeState()` is the app's.

Swift has no submodule import, so "take only the parts you need" means several library products in one package. The package requires macOS 14 or later and a Swift 6 toolchain, and its products are laid out along the Foundation/AppKit boundary from <a href="/guide/01-getting-started">Chapter 1</a>:

<div class="table-wrap">
<table>
<thead><tr><th>Product</th><th>Provides</th><th>Chapter</th></tr></thead>
<tbody>
<tr><td colspan="3"><em>Foundation-only</em></td></tr>
<tr><td><code>AirframeFoundation</code></td><td>Foundation and Combine extensions and the shared formatters — a relative display format style for dates, an English-in-current-region locale.</td><td>throughout</td></tr>
<tr><td><code>AirframeStateObserving</code></td><td><code>@StateObserving</code>, <code>Observations</code>, <code>StateObserving</code> / <code>StateObservingContainer</code>, <code>@Tracked</code>.</td><td><a href="/guide/08-3-state-observing">8.3</a></td></tr>
<tr><td><code>AirframeControllers</code></td><td>The background controller and view state controller bases.</td><td><a href="/guide/03-the-controller-layer">3</a>, <a href="/guide/04-background-controllers">4</a></td></tr>
<tr><td><code>AirframeActions</code></td><td>The Action, validator and action-manager bases.</td><td><a href="/guide/06-1-actions">6.1</a>, <a href="/guide/06-3-action-validation">6.3</a></td></tr>
<tr><td colspan="3"><em>AppKit</em></td></tr>
<tr><td><code>AirframeAppKit</code></td><td>AppKit extensions, the base view controller, settings, presentable helpers, menu bases.</td><td><a href="/guide/02-4-settings">2.4</a>, <a href="/guide/08-2-view-controllers">8.2</a>, <a href="/guide/08-4-menus">8.4</a></td></tr>
<tr><td><code>AirframeSwiftUI</code></td><td>View modifiers and the AppKit-in-SwiftUI bridges.</td><td><a href="/guide/08-1-views">8.1</a></td></tr>
<tr><td><code>AirframeNavigation</code></td><td>The URL-based navigation stack.</td><td><a href="/guide/09-navigation">9</a></td></tr>
<tr><td><code>AirframeLifecycle</code></td><td>The initializer protocol and runner, the startup phases, window restoration.</td><td><a href="/guide/02-2-startup">2.2</a>, <a href="/guide/02-3-window-restoration">2.3</a></td></tr>
<tr><td colspan="3"><em>Opt-in</em></td></tr>
<tr><td><code>AirframeCoreData</code></td><td>Core Data support, for apps whose persistence stack is Core Data.</td><td>—</td></tr>
<tr><td><code>AirframeTesting</code></td><td>Async XCTest helpers. The one product the umbrella never re-exports, because it links XCTest.</td><td><a href="/guide/10-4-factories-builders-and-fixtures">10.4</a></td></tr>
</tbody>
</table>
</div>

Above all of them sits `Airframe`, the umbrella: a product with no code of its own that re-exports every library above except `AirframeTesting`. Products are created when their code lands, never as empty placeholders — as of this writing `AirframeFoundation` and `AirframeStateObserving` have landed, and the layout is built for the rest to slot in.

## Two ways to import

A target picks one of two modes, with nothing in between:

- <strong>All</strong> — `import Airframe`. The umbrella re-exports every product, state observing and its macro included. This is what the app target does.
- <strong>Individual</strong> — `import AirframeActions`, `import AirframeFoundation`, … Each product stands on its own, so a Foundation-only consumer never links AppKit. This is what the Model and Actions packages do, and what a command-line helper beside the app does.

```swift
// The app's Package.swift, or the Xcode package dependency
.package(url: "https://github.com/gittower/swift-airframe.git", from: "1.0.0"),

// The app target takes everything.
.product(name: "Airframe", package: "swift-airframe"),

// NotebookActions takes the Action bases and nothing else.
.product(name: "AirframeActions", package: "swift-airframe"),
```

Every product name carries the `Airframe` prefix so it cannot collide with a module or type of your own — `Airframe` and `AirframeActions` are the module names, `Action` and `ActionValidator` the types inside them.

## Where it sits

<a href="/guide/01-1-project-layout">Chapter 1.1</a> sorts dependencies by which side of the Foundation/AppKit line they live on: `NotebookCore` and `NotebookActions` below it, the app target above. Airframe is the one dependency on both sides, and it can be exactly because it is carved along that line. The Foundation-only products are imported below the boundary — `NotebookActions` depends on `AirframeActions`, `NotebookCore` on `AirframeFoundation` if it needs the shared helpers — and the umbrella is imported above it. A Foundation-only product never links AppKit, so the compiler keeps AppKit out of the model through the framework the same way it keeps it out through your own packages.

It is a pinned, remote dependency, not a local package: the app names a version and the framework's own repository owns the code. That is also why the local packages that would otherwise hold generic code — extensions, observation machinery, test helpers — do not appear in the project tree. Airframe ships them. What is left under `Packages/` is either a library below the model or the app's own domain.

## The rules that decide product boundaries

Four rules decide what becomes a product and what stays inside one:

1. <strong>Carve along the Foundation/AppKit line.</strong> In the architecture only Action Controllers and Presentation may import AppKit; that rule becomes a product boundary. Model, actions, validators, controllers and state observing are Foundation-only products; the AppKit pieces sit in separate products on top.
2. <strong>Split only where a rule demands it.</strong> Products are the coarsest grouping the first rule allows. A Foundation and a Combine extension do not need separate modules; nor do AppKit extensions and AppKit base classes. Every extra product costs a consumer an import and a "which one?" decision.
3. <strong>Nothing happens on import.</strong> A product does nothing until the host wires it through an explicit `configure()` call. No import-time singletons, no side effects — the same rule <a href="/guide/02-5-object-wiring">Chapter 2.5</a> holds the app to.
4. <strong>Curate extensions, don't dump them.</strong> Extensions on `NSView`, `String` or `Publisher` leak into every file that imports the product and are the biggest collision risk. The framework ships the unambiguous ones and prefers namespaced types for shared helpers — a format style you pass to `formatted(_:)`, a static on `Locale` — so importing a product adds nothing to autocompletion on every value in your files.

<div class="rule">
<span class="rule-label">The rule</span>

The framework provides the generic spine; the app provides the domain. A product boundary exists only where the Foundation/AppKit line forces one, every product is inert until the host wires it, and the app target imports the umbrella while Foundation-only packages import individual products.

</div>

## Runtime libraries and the macro plugin

The library products are runtime code. Beside them, one compiler plugin, `AirframeMacros`, hosts every macro the package vends — `@StateObserving` today — built on [swift-syntax](https://github.com/swiftlang/swift-syntax) and not part of the shipped runtime surface. The split is deliberate: a macro only removes wiring boilerplate, while every semantic lives in the runtime library, where it is unit-tested directly instead of through expanded macro output. `Observations` and `@Tracked` are ordinary types you can reason about as such, and `@StateObserving` is sugar over declaring `observations` and the reconciliation method yourself; it fills in only what is missing, so a class that already declares those members keeps its own.

<div class="seealso">
<strong>Where this connects</strong>
The observation lifecycle worked through in full — a view controller, a self-rendering view, and a container that arms a whole subtree — is <a href="/guide/08-3-state-observing">Chapter 8.3</a>. The project tree the products slot into is <a href="/guide/01-1-project-layout">Chapter 1.1</a>. The package carries its own test suite, so in your app it is a trusted dependency you don't re-test: there is no decision of yours inside it that could regress, the same standard <a href="/guide/10-1-which-tests-to-write">Chapter 10.1</a> applies to everything else.
</div>
