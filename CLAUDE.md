# Agent Instructions

This repo is managed mainly by AI agents. Read this file first.

## What this is

The guide site for **Swift Airframe** — a layered architecture for native macOS apps (AppKit as the skeleton, SwiftUI hosted inside it as a rendering layer). It's an Astro static site: numbered chapters as markdown in a content collection, rendered through a dynamic route. See `README.md` for the technical structure, dev commands, and the GitHub Pages hosting setup.

This repo is **standalone** — it has no MCP server, no database, and no content-routing rules of its own. It's a derived artifact: a generic, publishable version of architecture patterns that actually live, in their real (Tower-specific) form, in a different repo's knowledge base.

## Where to derive information from by default

The **`tower-kb`** MCP server — normally available in the same Claude session, connected to a Supabase-backed knowledge base — is the source of truth for everything this guide documents. Two domains matter here:

- **`tower-mac-dev`** — the primary source. Tower's actual internal engineering docs on macOS app architecture: MVC layering, the model layer's manager pattern, Actions and Activities, the serial task runner and concurrency primitives, AppKit/SwiftUI integration, menus, view state management, testing conventions. Every chapter in this guide originated as a genericized, de-Tower-ified version of specific documents in this domain.
- **`apple-dev`** — platform-level Apple/AppKit/SwiftUI/Foundation reference (WWDC session summaries, Cocoa API notes) that isn't Tower-specific to begin with. Reach for this when a claim is about the platform itself rather than Tower's architecture choices — e.g. Observation framework mechanics, `NSHostingController` lifecycle quirks, actor reentrancy.

Before writing new content or extending a chapter, use `search_knowledge` / `get_document` / `list_knowledge` against these domains rather than reconstructing a pattern from general Swift knowledge alone — the KB documents usually already state the pattern precisely, with the reasoning and the edge cases worked out.

If `tower-kb`'s MCP tools aren't connected in the current session, say so rather than inventing architectural claims that sound plausible but aren't grounded in the source docs.

## The genericization rule

This is the easiest thing to get wrong when extending the guide, so it's worth stating explicitly:

- **Nothing in this guide may be Tower-specific.** No `TowerCore`, `GTGitRepository`, `FNGit`, or any other real Tower class, type, or product name. No git/repository-flavored examples — that's what Tower's real docs use, and porting an example over without translating it is the most common way Tower-specificity leaks in.
- **The running example across all chapters is a fictional notebook/note-taking app** — `Notebook`, `Note`, `NoteManager`, `SyncService`, `NotebookNavigationState`, and so on. Stay consistent with it. Introducing a second example domain partway through fragments the guide and makes chapters harder to read side by side.
- **When pulling a new pattern from `tower-mac-dev` to extend or add a chapter, translate it:** Tower's real class names become generic equivalents; Tower's git/repository domain concepts become the notebook/note domain; anything that's a Tower *product* concern rather than a general native-app-*framework* concern gets left out. (This is why the original ten-chapter table of contents dropped things like the Text Plugin System, the What's New feature, licensing, and Tower's release/versioning process — real and documented in `tower-mac-dev`, but specific to Tower rather than to the architecture pattern itself.)
- If unsure whether a pattern generalizes or is too Tower-specific to include, that's a judgment call worth surfacing to the user rather than guessing silently either way.

## Editorial direction and structure

Decisions made with Alex (2026-09) that govern how the guide grows:

- **The goal is showing readers how they would build their app.** Content centers on worked examples in the notebook domain, not abstract pattern description. When a chapter deepens, that should mean the running example gets more real — a concrete, liftable piece (a tag filter button, a sync badge, a background controller) — not more prose about the pattern.
- **A cookbook/recipes section is planned** as a second content collection: problem-shaped entries ("Observing state that never notifies") entered sideways via search or cross-link, no reading order. Recipes apply concepts; they link back into chapters for every concept they use and never re-explain them. Prefer "Cookbook"/"Recipes" over "Best Practices" as the name — the chapters *are* the best practices.
- **The chapter-vs-cookbook boundary is likelihood, not difficulty.** A chapter covers its pattern plus every question a first implementation predictably raises (Chapter 8's seeding and `didSet` re-arm edge cases are the template — readers hit those immediately, so they stay in-chapter). The cookbook takes situational material most apps never hit (shared-toolbar-family dynamics, Objective-C owners of Swift protocol-extension APIs, no-change-signal observation).
- **Keep the single numbered chapter spine and avoid renumbering.** Inserting a chapter renames every later file and touches hardcoded `/guide/NN-slug` cross-links across many chapters — do it deliberately, in one commit, with a grep for stale links. Introduce a frontmatter-based "parts" grouping only if the spine grows past ~13–14 chapters; depth growth should flow into recipes instead of new chapters where the likelihood rule allows.
- **When a source KB doc changes, propagate to its chapter** (and vice versa — corrections agreed in conversation may need to land in the KB first, then flow here genericized). The two drift otherwise.

### Formatting gotcha

Markdown is **not** processed inside raw HTML blocks. The hand-written `<div class="table-wrap"><table>` tables (and any other raw HTML) must use `<code>`, `<strong>`, `<em>` — backticks inside them render literally. Backticks are fine everywhere else.

## Hosting

Deployed to GitHub Pages under `gittower/swift-airframe-guide`, served from a subpath (`base: '/swift-airframe-guide/'` in `astro.config.mjs`). See `README.md` → **Hosting** before touching any internal link or the Astro config — the subpath has real, non-obvious consequences (a rehype plugin rewrites links inside markdown content at build time; see `src/utils/rehype-base-links.mjs`) that are easy to silently break.
