---
title: "Actions and Controllers"
description: "Not every write deserves ceremony. This chapter introduces the coordination layer that sits between a user's gesture and the Model layer's write funnel — the Action, the Action Controller, and the background controller — and lays out how the three relate before three subchapters go deeper on each."
order: 4
---

Not every write deserves ceremony. This chapter introduces the coordination layer that sits between a user's gesture and the Model layer's write funnel — the Action, the Action Controller, and the background controller — and lays out how the three relate before three subchapters go deeper on each.

## The shape of the layer

An Action represents one live user operation — it's `@Observable`, carries its own lifecycle (`title`, `status`, progress, `cancel()`), and spawns the task that does the work. <a href="/guide/04-1-actions">Actions</a> covers the type itself, when a gesture earns one instead of a plain manager call, and the line between an Action and the manager function it calls into.

An Action Controller is the one coordination-layer type allowed to touch AppKit at all: it presents a dialog, collects the user's input, builds an Action from it, and dispatches it. <a href="/guide/04-2-action-controllers">Action Controllers</a> covers that bridge, plus the background controllers that do related, non-Action work — a periodic refresh, a reaction to a system event — with no gesture behind it at all.

Before an Action is allowed to run, something has to answer a separate question: can it run right now, given the current state? <a href="/guide/04-3-action-validation">Action Validation</a> covers the two-layer validator system that answers that, and wires the answer into menus, toolbars, and the responder chain without ever asking a view to decide.

## The rule that holds across all three

<div class="rule">
<span class="rule-label">The rule</span>

Everything below an Action Controller's dispatch point is Foundation-only, per the boundary in <a href="/guide/01-getting-started">Chapter 1</a>. An Action never bypasses its manager to read or write state directly, and a background controller never shows UI or runs as part of a user gesture. The coordination layer only ever <em>decides</em> and <em>dispatches</em> — the Model layer is still the only place a write actually happens.

</div>
