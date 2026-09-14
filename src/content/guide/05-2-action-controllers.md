---
title: "Action Controllers"
description: "Action Controllers are the only coordination-layer type allowed to touch AppKit at all — the one bridge between a user gesture and a dispatched Action. This subchapter covers that bridge, and where its result ends up once the Action finishes."
order: 5
subOrder: 2
---

Action Controllers are the only coordination-layer type allowed to touch AppKit at all — the one bridge between a user gesture and a dispatched Action. This subchapter covers that bridge, and where its result ends up once the Action finishes.

## The only AppKit-side bridge

An Action Controller presents a dialog, collects the user's input, builds an Action from it, and dispatches it. Everything downstream of that dispatch, per the boundary in <a href="/guide/01-getting-started">Chapter 1</a>, is Foundation-only again.

A common shape opens a result window immediately, before the Action has finished: a loading view binds to `action.status`, and once it flips to `.completed`, the controller fetches the result from the domain manager and swaps the content in. Results live on the manager, not on the Action itself — the Action stays focused on lifecycle, and a background-triggered run of the same work (no Action wrapper at all) can produce and cache a result the same way. That background-triggered case is exactly what a background controller does — see <a href="/guide/03-background-controllers">Chapter 3</a>.

<div class="seealso">
<strong>Ahead in this guide</strong>
Validators — the precondition checks Action Controllers use to enable or disable UI, referenced above — get their own subchapter next: <a href="/guide/05-3-action-validation">Chapter 5.3, Action Validation</a>. The serial runner and job structs used throughout Actions and Action Controllers are covered properly in <a href="/guide/06-concurrency">Chapter 6, Concurrency</a>.
</div>
