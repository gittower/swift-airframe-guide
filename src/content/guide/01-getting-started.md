---
title: "Getting Started"
description: "Airframe is an opinionated layered architecture for native Swift apps — AppKit and SwiftUI working together under one rule for where state lives and who is allowed to change it. This chapter lays out the four layers, the two paths data takes through them, and the single synchronization model that makes the whole thing hold together."
order: 1
---

Airframe is an opinionated layered architecture for native Swift apps — AppKit and SwiftUI working together under one rule for where state lives and who is allowed to change it. This chapter lays out the four layers, the two paths data takes through them, and the single synchronization model that makes the whole thing hold together.

## The four layers

An Airframe app is built from four layers, stacked so that dependencies only ever point downward:

- <strong>Presentation</strong> — views and view controllers. What the user sees and touches.
- <strong>Controllers</strong> — the coordination layer. A <strong>View State Controller</strong> shapes model data for display; an <strong>Action Controller</strong> turns a user gesture into a configured <strong>Action</strong>.
- <strong>Actions</strong> — the operations that mutate state, plus the <strong>Validators</strong> that check whether they're allowed to run.
- <strong>Model</strong> — the domain state itself, sitting on top of the packages and libraries that talk to disk, network, and other processes. The source of truth.

Every one of those layers can be described in a sentence, and none of them do the others' job. A view never reaches past its controller into the model. A model never knows a view exists.

## Two paths, one boundary

Data only moves through the stack two ways: a <strong>read path</strong>, from Presentation down through a View State Controller to the Model, and a <strong>mutate path</strong>, from Presentation through an Action Controller into an Action and Validator, down to the Model. Both paths converge on the same layer and the Model closes the loop by notifying Presentation when something changes — nothing above it has to ask.

<figure class="diagram">
<svg viewBox="0 0 760 480" role="img" aria-label="Diagram of the Airframe layering: Presentation reads through a View State Controller and mutates through an Action Controller and Action, both converging on the Model, which delegates to Packages and Libraries below and notifies Presentation directly above.">
<defs>
<marker id="arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
<path d="M0,0 L10,5 L0,10 z" fill="currentColor"/>
</marker>
<marker id="arrAccent" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
<path d="M0,0 L10,5 L0,10 z" fill="var(--accent)"/>
</marker>
</defs>

<rect x="90" y="20" width="580" height="55" rx="8" fill="none" stroke="currentColor" stroke-width="1.6"/>
<text x="380" y="43" text-anchor="middle" font-family="var(--font-display)" font-weight="700" font-size="15">Presentation</text>
<text x="380" y="61" text-anchor="middle" font-family="var(--font-mono)" font-size="10.5" opacity="0.7">Views &amp; View Controllers · AppKit</text>

<rect x="430" y="108" width="240" height="48" rx="8" fill="none" stroke="currentColor" stroke-width="1.6"/>
<text x="550" y="130" text-anchor="middle" font-family="var(--font-display)" font-weight="700" font-size="13">Action Controller</text>
<text x="550" y="146" text-anchor="middle" font-family="var(--font-mono)" font-size="9.5" opacity="0.7">dialogs, input · AppKit</text>

<line x1="60" y1="180" x2="700" y2="180" stroke="currentColor" stroke-width="1.2" stroke-dasharray="4 5" opacity="0.6"/>
<text x="700" y="174" text-anchor="end" font-family="var(--font-mono)" font-size="10" opacity="0.65">Foundation-only below — testable without the app running</text>

<rect x="90" y="195" width="270" height="55" rx="8" fill="none" stroke="currentColor" stroke-width="1.6"/>
<text x="225" y="219" text-anchor="middle" font-family="var(--font-display)" font-weight="700" font-size="13">View State Controller</text>
<text x="225" y="236" text-anchor="middle" font-family="var(--font-mono)" font-size="9.5" opacity="0.7">shapes data for display</text>

<rect x="430" y="195" width="240" height="55" rx="8" fill="none" stroke="currentColor" stroke-width="1.6"/>
<text x="550" y="219" text-anchor="middle" font-family="var(--font-display)" font-weight="700" font-size="13">Action + Validator</text>
<text x="550" y="236" text-anchor="middle" font-family="var(--font-mono)" font-size="9.5" opacity="0.7">executes, checks preconditions</text>

<rect x="90" y="298" width="580" height="55" rx="8" fill="none" stroke="currentColor" stroke-width="1.6"/>
<text x="380" y="321" text-anchor="middle" font-family="var(--font-display)" font-weight="700" font-size="15">Model</text>
<text x="380" y="339" text-anchor="middle" font-family="var(--font-mono)" font-size="10.5" opacity="0.7">domain state · source of truth</text>

<rect x="90" y="400" width="580" height="50" rx="8" fill="none" stroke="currentColor" stroke-width="1.6"/>
<text x="380" y="429" text-anchor="middle" font-family="var(--font-display)" font-weight="700" font-size="13">Packages &amp; Libraries</text>

<line x1="210" y1="75" x2="210" y2="193" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
<text x="218" y="98" font-family="var(--font-mono)" font-size="10.5">reads</text>

<line x1="550" y1="75" x2="550" y2="106" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
<text x="558" y="94" font-family="var(--font-mono)" font-size="10.5">mutates</text>

<line x1="550" y1="156" x2="550" y2="193" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
<text x="558" y="177" font-family="var(--font-mono)" font-size="10.5">dispatches</text>

<line x1="225" y1="250" x2="225" y2="296" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
<text x="233" y="278" font-family="var(--font-mono)" font-size="10.5">loads</text>

<line x1="550" y1="250" x2="550" y2="296" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
<text x="558" y="278" font-family="var(--font-mono)" font-size="10.5">writes</text>

<line x1="380" y1="353" x2="380" y2="398" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
<text x="388" y="380" font-family="var(--font-mono)" font-size="10.5">delegates</text>

<path d="M90,317 C38,317 38,47 90,47" fill="none" stroke="var(--accent)" stroke-width="1.8" stroke-dasharray="1 6" stroke-linecap="round" marker-end="url(#arrAccent)"/>
<text x="30" y="182" transform="rotate(-90 30 182)" text-anchor="middle" font-family="var(--font-mono)" font-size="10.5" fill="var(--accent)">notifies</text>
</svg>
<figcaption>The read path and mutate path converge on the Model. The Model closes the loop itself, broadcasting a change notification straight back to Presentation — no controller above it has to ask whether something changed.</figcaption>
</figure>

<div class="rule">
<span class="rule-label">The rule</span>

Everything below the boundary line is Foundation-only: no AppKit, no UI framework, no app instance required to run its tests. Only <strong>Action Controllers</strong> and <strong>Presentation</strong> are allowed to import AppKit. If a type below the line needs something an AppKit type has, that's a sign the type belongs above the line — not a reason to import AppKit below it.

</div>

## @MainActor is the lock

Every layer above the bottom Packages layer is `@MainActor`-isolated. State lives on the main thread; background work runs on the cooperative thread pool and returns its result via `await`. There is no mutex, no concurrent data structure, no queue guarding application state — the main actor <em>is</em> the synchronization.

This is a deliberate trade against custom actors for state. An actor would make every read from UI code asynchronous, for a problem `@MainActor` already solves without paying that tax. The one hazard `@MainActor` doesn't remove on its own is re-entrancy — what happens when the same method is called again while an earlier call is still suspended at an `await`. That's a concern for <a href="/guide/06-concurrency">Chapter 6</a>; for now, the rule is simply: <strong>state reads and writes happen on the main actor, everywhere, without exception.</strong>

## Walking the loop once

Take a note-taking app as the running example for this guide. A user renames a notebook in the sidebar:

1. The sidebar view controller reads its rows through a `NotebookListStateController` — the read path.
1. The user commits an inline rename. An `Action Controller` validates the new name isn't empty, builds a `RenameNotebookAction`, and dispatches it — the mutate path begins.
1. The Action calls into the Model's write funnel, which updates the notebook's title and persists it.
1. The Model broadcasts a change notification. It does not know or care that the sidebar exists.
1. The sidebar's state controller — and any other view observing notebooks, including one that doesn't exist yet — refreshes in response.

Nothing in that list required the sidebar to know about a detail view, or the detail view to know about the sidebar. That decoupling is the entire point of routing every mutation through one layer: views can be added, removed, or rebuilt in SwiftUI without the Model layer changing at all.

<div class="seealso">
<strong>Ahead in this guide</strong>
The Model layer's write funnel is <a href="/guide/03-model-layer">Chapter 3</a>. Actions, Validators, and Action Controllers get their own treatment in <a href="/guide/04-actions-and-controllers">Chapter 4</a>. Re-entrancy and the concurrency primitives referenced above land in <a href="/guide/06-concurrency">Chapter 6</a>.
</div>
