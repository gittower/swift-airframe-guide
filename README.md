# Swift Airframe — Guide

The guide site for **Swift Airframe**, a layered architecture for native macOS apps: AppKit as the skeleton, SwiftUI hosted inside it as a rendering layer, one direction of data flow, and a strict rule about where each kind of code is allowed to live.

Built with [Astro](https://astro.build) — static content collections, no client-side framework. The pattern mirrors `git-flow-next-website`: plain markdown chapters in a content collection, rendered through a dynamic `[...slug]` route with automatic prev/next navigation.

## Structure

```
src/
  content/
    guide/                 chapter markdown, one file per chapter, `order` drives sequence
  layouts/
    Layout.astro            html shell — head, fonts, global CSS
    ShellLayout.astro        two-column shell — sidebar + main
    GuideLayout.astro        chapter chrome — eyebrow, title, prev/next
  components/
    Sidebar.astro            "flight plan" chapter nav, gate-numbered
  pages/
    index.astro              overview — hero + chapter grid
    guide/[...slug].astro    renders each chapter from the content collection
  styles/
    global.css               design tokens (light + automatic dark) and shared prose styles
```

## Commands

| Command | Description |
|---|---|
| `npm install` | Install dependencies |
| `npm run dev` | Start dev server at `localhost:4321` |
| `npm run build` | Build production site to `./dist/` |
| `npm run preview` | Preview the production build locally |

## Adding a chapter

Add a markdown file to `src/content/guide/`, named `NN-slug.md`, with frontmatter:

```yaml
---
title: "Chapter Title"
description: "One sentence — also used as the card teaser on the overview page."
order: 11
---
```

The sidebar, the overview grid, and prev/next navigation all derive from `order` automatically — nothing else needs to be updated by hand.
