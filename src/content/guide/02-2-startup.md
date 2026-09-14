---
title: "Startup"
description: "Launch is the one moment in an app's life where the ordinary rules bend: nothing has state yet, nothing can be presumed configured, and getting the order wrong fails silently until it doesn't. This subchapter covers the four phases of startup and the gate that decides when the app counts as ready."
order: 2
subOrder: 2
---

Launch is the one moment in an app's life where the ordinary rules bend: nothing has state yet, nothing can be presumed configured, and getting the order wrong fails silently until it doesn't. This subchapter covers the four phases of startup and the gate that decides when the app counts as ready.

## Four phases, in order

Startup runs on top of the platform's own application lifecycle (`applicationWillFinishLaunching`, window restoration, `applicationDidFinishLaunching`) — each platform callback forwarded by the delegate, per <a href="/guide/02-1-app-delegate">The App Delegate</a> — and Airframe layers four phases across it:

<div class="table-wrap">
<table>
<thead><tr><th>Phase</th><th>What runs</th><th>What must not happen</th></tr></thead>
<tbody>
<tr><td><strong>1. Initialize</strong></td><td>A fixed sequence of initializers configure essential subsystems — persistence, the sync client, feature flags.</td><td>No expensive reloads. No controller starts here.</td></tr>
<tr><td><strong>2. Startup gates</strong></td><td>Modal states that must resolve before the app is usable: onboarding, an expired trial, a revoked license.</td><td>No window opens behind the gate. The app is not yet "launched."</td></tr>
<tr><td><strong>3. Restore windows</strong></td><td>The platform hands back windows from the last session. If a gate is showing, restoration is held and replayed after — see <a href="/guide/02-3-window-restoration">Window Restoration</a>.</td><td>Restored windows must never appear behind or before a gate — ordering is enforced, not assumed.</td></tr>
<tr><td><strong>4. Launch</strong></td><td>Deferred windows appear, a default window opens if none were restored, background controllers start, cleanup and update tasks run.</td><td>Nothing in this phase blocks — by now the user is looking at a window.</td></tr>
</tbody>
</table>
</div>

<div class="rule">
<span class="rule-label">The rule</span>

Initializers only call into the Model layer. They never start a controller and never show UI — controllers are written assuming the subsystems they depend on are already configured, and some are allowed to show alerts, which is exactly what must not happen before the user has passed the startup gates.

</div>

Each initializer is a small class conforming to a shared protocol, run in a fixed order by the app controller during phase 1. This is where the `configure(_:)` calls from <a href="/guide/02-5-object-wiring">Object Wiring</a> happen — one initializer per subsystem, so the launch-ordering decisions live in one visible sequence instead of being scattered across lazy accessors.

## The readiness gate

After the phases, one flag summarizes the whole sequence — and everything that opens windows or starts user-visible work checks it rather than re-deriving the pieces:

```swift
extension AppStatus {
    var isReadyForUse: Bool {
        productStatusIsValid       // license or trial in good standing
            && hasLaunched         // startup gates passed, phase 4 reached
            && onboardingCompleted
    }
}
```

The point of funneling readiness through one flag is the same as every other funnel in this guide: when a new gate is added — a migration screen, a consent dialog — it lands in one place, and every caller inherits it for free.

<div class="seealso">
<strong>Ahead in this guide</strong>
Background controllers — the long-lived objects started in phase 4 — are covered in <a href="/guide/04-background-controllers">Chapter 4</a>.
</div>
