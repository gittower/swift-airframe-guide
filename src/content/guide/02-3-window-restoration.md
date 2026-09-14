---
title: "Window Restoration"
description: "The platform restores last session's windows at a moment when the app hasn't yet decided whether it's allowed to show any. This subchapter covers the restoration coordinator that holds every restored window until the startup gates resolve, then shows or replays it."
order: 2
subOrder: 3
---

The platform restores last session's windows at a moment when the app hasn't yet decided whether it's allowed to show any. This subchapter covers the restoration coordinator that holds every restored window until the startup gates resolve, then shows or replays it.

## Why restoration needs a coordinator

The platform triggers window restoration between <em>will</em>-finish-launching and <em>did</em>-finish-launching — before phase 2 of <a href="/guide/02-2-startup">Startup</a> has had a chance to decide whether a gate needs to show. A restored window can't simply appear the moment the platform hands it back, or it would appear behind (or before) an onboarding screen that hasn't been decided yet. A restoration coordinator resolves this: it holds each restored window until the startup-gate decision is final, then either shows it immediately or replays it once the gate clears.

```swift
static func restoreWindow(
    withIdentifier identifier: NSUserInterfaceItemIdentifier,
    state: NSCoder,
    completionHandler: @escaping (NSWindow?, Error?) -> Void
) {
    guard let window = window(for: identifier, state: state) else {
        completionHandler(nil, nil)
        return
    }

    if AppStatus.shared.startupMode == .normal {
        completionHandler(window, nil)   // no gate pending — show it now
    } else {
        // hold until the gate resolves, then replay
        shared.store(RestoredWindow(window: window, completionHandler: completionHandler))
    }
}
```

The deferred windows surface again in phase 4: launch shows whatever the coordinator held back, and only opens a default window if nothing was restored at all.

## What a window restores

Restoration hands back windows, not app state — what a window <em>shows</em> is re-derived, not deserialized. Persist identifiers in the window's `NSCoder` state (a selected notebook's ID, not the notebook), and re-resolve them against whatever the Model layer has actually loaded once launch completes. <a href="/guide/09-navigation">Chapter 9</a> covers this identifier-not-object rule in full, because it's the same rule navigation state lives by everywhere, not just at restoration time.
