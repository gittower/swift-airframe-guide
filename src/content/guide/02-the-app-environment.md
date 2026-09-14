---
title: "The App Environment"
description: "Before the first window appears, an app has already made its most consequential wiring decisions: who receives the platform's lifecycle events, what gets configured in which order, where user preferences live, and how objects find their collaborators. This chapter covers that environment as a whole, then five subchapters take one piece each."
order: 2
---

Before the first window appears, an app has already made its most consequential wiring decisions: who receives the platform's lifecycle events, what gets configured in which order, where user preferences live, and how objects find their collaborators. This chapter covers that environment as a whole, then five subchapters take one piece each.

## The shape of the environment

Everything starts at the platform's edge: <a href="/guide/02-1-app-delegate">The App Delegate</a> is the object the system hands its lifecycle events to, and its entire job is to translate them into the app's own phases — never to own anything itself. What those phases are — a fixed initialization sequence, modal startup gates, restoration, launch — is <a href="/guide/02-2-startup">Startup</a>. One of those phases has a timing problem baked in by the platform, and <a href="/guide/02-3-window-restoration">Window Restoration</a> covers the coordinator that resolves it.

The remaining two pieces outlive launch. <a href="/guide/02-4-settings">Settings</a> covers where user-facing configuration lives — the one model shape simple enough to be its own manager. <a href="/guide/02-5-object-wiring">Object Wiring</a> covers how every object in the app reaches its collaborators — construct what you own, reach for shared when you don't — and why there is no dependency-injection container anywhere in this architecture.

## The rules that hold across all five

<div class="rule">
<span class="rule-label">The rules</span>

<strong>Launch order is enforced, not assumed.</strong> Initializers only call into the Model layer; no controller starts before phase 4; nothing shows UI before the startup gates clear. Every object downstream is written assuming the subsystems it depends on are already configured — which is only safe because the phases make it true.

<strong>The environment is ambient, not passed.</strong> Objects reach shared subsystems through flat accessors — <code>SyncManager.shared</code>, <code>EditorSettings.shared</code> — never through constructor-injected dependencies or a root service object. What varies gets configured once at launch; what doesn't stays concrete.

</div>

<div class="seealso">
<strong>Ahead in this guide</strong>
The manager/store split introduced in <a href="/guide/02-5-object-wiring">Object Wiring</a> runs through <a href="/guide/05-model-layer">Chapter 5</a>, where the persisted, database-backed model shape is built on exactly that pair. Background controllers — the long-lived objects <em>started</em> in phase 4 — are covered in <a href="/guide/04-background-controllers">Chapter 4</a>.
</div>
