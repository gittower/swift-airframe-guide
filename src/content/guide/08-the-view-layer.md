---
title: "The View Layer"
description: "Views read from the Model. This chapter introduces the read/render side of the architecture — how a SwiftUI view hosted inside AppKit stays reactive, how a view controller assembles and scopes that hierarchy, the activation lifecycle that drives it, and the menus that are themselves just another view component — and lays out how the four relate before four subchapters go deeper on each."
order: 8
---

Views read from the Model. This chapter introduces the read/render side of the architecture — how a SwiftUI view hosted inside AppKit stays reactive, how a view controller assembles and scopes that hierarchy, the activation lifecycle that drives it, and the menus that are themselves just another view component — and lays out how the four relate before four subchapters go deeper on each.

## The shape of the layer

A SwiftUI view hosted inside AppKit is deliberately dumb: given state, it draws it and emits intents through closures. <a href="/guide/08-1-views">Views</a> covers that split in full — the three-layer shape every piece of UI follows, and the one rule that keeps a hosted SwiftUI view reactive instead of silently going stale.

Something still has to assemble those views into a hierarchy and scope them into coherent, independently testable pieces. <a href="/guide/08-2-view-controllers">View Controllers</a> covers that — the four jobs a view controller does, and when a piece of UI has earned a view controller of its own rather than staying embedded in its parent's.

Views and their AppKit controllers lean on `observeState()` and `activateObservation()` without fully explaining them. <a href="/guide/08-3-state-observing">State Observing</a> covers the activation lifecycle underneath — subscribing, seeding, and tracking in one auditable method — worked through as a view controller, a self-rendering view, and a container that activates a whole subtree of subcontrollers at once.

A menu isn't a special case bolted onto the architecture — it's the mutate path wearing an `NSMenuItem`. <a href="/guide/08-4-menus">Menus</a> covers building menus as view components wired to Actions, carrying typed data on them safely, and getting validation for free.

## The rule that holds across all four

<div class="rule">
<span class="rule-label">The rule</span>

Rendering is always a pure function of current state. Nothing outside a tracked updater calls it directly — an external event only ever updates the state that updater reads, and `observations.track` re-runs it because the state changed, not because something told it to. A menu's items follow the same discipline: they read whatever state the owning controller pushed into them, and never reach past it to decide anything themselves.

</div>
