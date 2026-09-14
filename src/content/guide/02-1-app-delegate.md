---
title: "The App Delegate"
description: "The app delegate is the first object the platform talks to and the easiest one to ruin. This subchapter covers its one legitimate job — translating lifecycle events into the app's own startup phases — and the root-service-container shape it must never grow into."
order: 2
subOrder: 1
---

The app delegate is the first object the platform talks to and the easiest one to ruin. This subchapter covers its one legitimate job — translating lifecycle events into the app's own startup phases — and the root-service-container shape it must never grow into.

## A translator, not an owner

The platform delivers its lifecycle as delegate callbacks; the app runs on its own four startup phases — see <a href="/guide/02-2-startup">Startup</a>. The delegate is the seam between the two vocabularies, and each callback body is a line or two that forwards into an object that actually owns the work:

```swift
@main
final class AppDelegate: NSObject, NSApplicationDelegate {

    func applicationWillFinishLaunching(_ notification: Notification) {
        AppController.shared.initialize()      // phase 1: run the initializer chain
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        StartupController.shared.run { [weak self] in
            self?.launch()                     // phases 2–4: gates, then launch
        }
    }

    private func launch() {
        AppController.shared.launch()
    }
}
```

The other callbacks the platform offers — reopening, opening files and URLs, the termination handshake — follow the same shape: the delegate answers by asking the object that owns that domain, never by deciding anything itself. If a callback body grows past a few lines, the logic it accumulated belongs in a controller.

## Not a service container

The classic degradation of an app delegate starts innocently: it's created first and lives forever, so it looks like the natural home for everything app-wide — the persistence stack, the sync client, the settings. Properties accumulate, and every corner of the app starts reaching for them the only way it can:

```swift
// The shape to refuse
let syncManager = (NSApp.delegate as! AppDelegate).syncManager
```

Now the delegate is a root service object: every caller is coupled to a cast and to the app target itself, nothing under it can be exercised without booting the whole application shell, and the construction order of the entire app hides inside one class that also handles dock-menu clicks. The delegate didn't earn any of this — it was just standing at the door when the objects arrived.

The alternative is the flat shared-instance surface from <a href="/guide/02-5-object-wiring">Object Wiring</a>: <code>SyncManager.shared</code> is reachable from anywhere without going through the delegate, and whatever setup it needs happens in the initializer chain during phase 1 — where ordering is explicit, not an accident of property declaration order.

<div class="rule">
<span class="rule-label">The rule</span>

The delegate translates; it never owns. It holds no app-wide objects, and no code outside it ever mentions its type. If something can only be reached through <code>NSApp.delegate</code>, it's wired wrong — give it a shared instance and let the delegate forget it exists.

</div>
