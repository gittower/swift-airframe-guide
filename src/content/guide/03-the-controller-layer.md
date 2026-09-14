---
title: "The Controller Layer"
description: "Controller is one of this guide's most overloaded words — Action Controllers, Background Controllers, view state controllers, view controllers, menu controllers. This chapter names the paradigm they all share: an object that bridges two layers and coordinates work across that boundary, knowing who and when, never how."
order: 3
---

Controller is one of this guide's most overloaded words — Action Controllers, Background Controllers, view state controllers, view controllers, menu controllers. This chapter names the paradigm they all share: an object that bridges two layers and coordinates work across that boundary, knowing who and when, never how.

## One paradigm, many boundaries

The word <em>controller</em> shows up at almost every layer boundary in this guide, and that's not five unrelated ideas that happen to share a name — it's one recurring paradigm. There is no single controller layer to point at; there are multiple controller kinds, each sitting at a different seam between two other layers.

## Who and when, never how

A controller's job description has the same shape everywhere it appears: when something happens on one side of a boundary, coordinate the right response on the other side. It knows <em>who</em> should act and <em>when</em> they should act — never <em>how</em> the work itself gets done. The how lives elsewhere: a manager computes and persists domain results, an Action performs the operation, a view renders. A controller holds little state of its own and no domain logic — it's a thin, high-level object that knows both sides of its boundary well enough to connect them, and nothing else. It coordinates; it doesn't compute domain results, and it doesn't render.

## The kinds

<div class="table-wrap">
<table>
<thead><tr><th>Kind</th><th>Bridges</th><th>UI framework allowed?</th><th>Covered in</th></tr></thead>
<tbody>
<tr><td><strong>Action Controller</strong></td><td>A user gesture and a dialog &rarr; a dispatched Action</td><td>AppKit</td><td><a href="/guide/06-2-action-controllers">Chapter 6.2</a></td></tr>
<tr><td><strong>Background Controller</strong></td><td>App events and timers &rarr; Model-layer work</td><td>No UI</td><td><a href="/guide/04-background-controllers">Chapter 4</a></td></tr>
<tr><td><strong>View State Controller</strong></td><td>Model data &rarr; view-shaped read state</td><td>Foundation-only</td><td><a href="/guide/08-the-view-layer">Chapter 8</a></td></tr>
<tr><td><strong>View Controller</strong></td><td>View state &rarr; a rendered AppKit view hierarchy</td><td>AppKit</td><td><a href="/guide/08-2-view-controllers">Chapter 8.2</a></td></tr>
<tr><td><strong>Menu controller</strong></td><td>A view-component specialization, for menus specifically</td><td>AppKit</td><td><a href="/guide/08-4-menus">Chapter 8.4</a></td></tr>
</tbody>
</table>
</div>

## Controllers aren't the MVC Controller

One nuance is worth being precise about, because the word invites a mix-up: in MVC terms, a view controller belongs to the <strong>View</strong> layer — it controls a slice of the view hierarchy, the way any container manages its children. It is not the MVC "Controller." The "Controller" in its name describes the bridging role this chapter is about, not membership in an MVC layer — which is exactly why the word shows up on both sides of the Foundation/AppKit boundary from <a href="/guide/01-getting-started">Chapter 1</a>: a View State Controller is Foundation-only, below that line; an Action Controller and a view controller both sit above it, in Presentation's AppKit territory. They're sorted by what they bridge, not by sharing a name.

## The litmus test

Three short tests separate a controller from its neighbors:

<div class="rule">
<span class="rule-label">The test</span>

If the job description is "when X happens, get Y to do Z," it's a controller. If it owns and computes domain state, it's a manager. If it renders, it's a view.

</div>

Hold that test in mind through the chapters ahead — every "controller" this guide introduces from here on is an instance of the same shape, wired to a different boundary. The first concrete kind, the Background Controller, is next.
