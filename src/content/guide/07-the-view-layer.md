---
title: "The View Layer"
description: "Views read from the Model. This chapter introduces the read/render side of the architecture — how a SwiftUI view hosted inside AppKit stays reactive, where the state it renders comes from, how a view controller assembles and scopes that hierarchy, the activation lifecycle that drives it, the menus that are themselves just another view component, the settings window that puts all of it together, and the recurring shapes of a screen built end to end — and lays out how the seven relate before seven subchapters go deeper on each."
order: 7
---

Views read from the Model. This chapter introduces the read/render side of the architecture — how a SwiftUI view hosted inside AppKit stays reactive, where the state it renders comes from, how a view controller assembles and scopes that hierarchy, the activation lifecycle that drives it, the menus that are themselves just another view component, the settings window that puts all of it together, and the recurring shapes of a screen built end to end — and lays out how the seven relate before seven subchapters go deeper on each.

## The shape of the layer

A SwiftUI view hosted inside AppKit is deliberately dumb: given state, it draws it and emits intents through closures. <a href="/guide/07-1-views">Views</a> covers the view's side of that contract — its interface, how components compose, and the one rule that keeps a hosted SwiftUI view reactive instead of silently going stale.

Where that state comes from is the other half. <a href="/guide/07-2-view-state">View State</a> is the entry point for structuring a screen: one state object per writer — what the user edits, what a loader loads, how a running operation is going, what the view controller derives — which kind each one is, which controller writes it, how it reaches the view and what the view reports back. It works the most common shape in full: a loader and the `@Observable` model it writes, which the view never sees past.

Something still has to assemble those views into a hierarchy and scope them into coherent, independently testable pieces. <a href="/guide/07-3-view-controllers">View Controllers</a> covers that — the four jobs a view controller does, and when a piece of UI has earned a view controller of its own rather than staying embedded in its parent's.

Views and their AppKit controllers lean on `observeState()` and `activateObservation()` without fully explaining them. <a href="/guide/07-4-state-observing">State Observing</a> covers the activation lifecycle underneath — subscribing, seeding, and tracking in one auditable method — worked through as a view controller, a self-rendering view, and a container that activates a whole subtree of subcontrollers at once.

A menu isn't a special case bolted onto the architecture — it's the mutate path wearing an `NSMenuItem`. <a href="/guide/07-5-menus">Menus</a> covers building menus as view components wired to Actions, carrying typed data on them safely, and getting validation for free.

The settings window is where all of the above meets in one place, and the first complete window most apps build after the main one. <a href="/guide/07-6-settings-window">The Settings Window</a> builds it end to end — a shared window controller, an AppKit tab controller with toolbar tabs, SwiftUI panes hosted as ordinary content views, and the sections inside them, which either bind straight to a settings object or get a small controller of their own the moment they need to derive anything.

Most screens are one of a handful of shapes. <a href="/guide/07-7-screen-examples">Screen Examples</a> builds the rest of them in the notebook app — values derived from the model, a form with an async submit, a long-running operation with progress and cancel, several concerns on one screen, and a parent view controller routing between its children — each with what it's for, what it isn't for, and what gets a test.

## The rules that hold across all seven

<div class="rule">
<span class="rule-label">The rule</span>

Rendering is always a pure function of current state. Nothing outside a tracked updater calls it directly — an external event only ever updates the state that updater reads, and `observations.track` re-runs it because the state changed, not because something told it to. A menu's items follow the same discipline: they read whatever state the owning controller pushed into them, and never reach past it to decide anything themselves.

</div>

<div class="rule">
<span class="rule-label">The rule</span>

A view receives exactly two things: state and closures for its intents. State is a model it reads by reference, a value the view controller sets on it, or an object the user edits through bindings. Never the controller that writes that state, never a manager, never an Action. A view emits an intent and reacts to state — it never handles the action itself, and it never reports an edit through a closure. That is what lets a preview or a test construct the state directly, including one the app only reaches mid-operation, without a controller in sight. It is the first thing to check on any view, and the most important.

</div>

<div class="rule">
<span class="rule-label">The rule</span>

One object per writer. A screen has as many state objects as it has writers — the user, a loader, a flow controller, the view controller itself — and none of them holds a reference to another. Where two meet, the view controller routes between them.

</div>
