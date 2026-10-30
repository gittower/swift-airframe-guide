---
title: "Background Controllers"
description: "Not every write in this guide happens because a user asked for it. This chapter covers the background controller — the long-lived controller that keeps the app current with no gesture behind it at all: periodic refreshes, reactions to system events, state derived continuously from the Model — and the rule that keeps the work it triggers out of the controller itself."
order: 4
---

Not every write in this guide happens because a user asked for it. This chapter covers the background controller — the long-lived controller that keeps the app current with no gesture behind it at all: periodic refreshes, reactions to system events, state derived continuously from the Model — and the rule that keeps the work it triggers out of the controller itself.

## What a background controller is

A background controller is the first concrete instance of the controller paradigm introduced in <a href="/guide/03-the-controller-layer">Chapter 3</a>: it bridges app events and timers to Model-layer work, knowing when to act without doing the work itself.

Some work isn't triggered by a gesture at all — a periodic refresh, a reaction to the system waking from sleep, a value derived continuously from the Model. That's a background controller: a long-lived, app- or document-lifetime controller that never renders UI and is never invoked as part of a user gesture. It sits <em>above</em> the Foundation/AppKit boundary from <a href="/guide/01-getting-started">Chapter 1</a>, next to the Action Controller: the system events it reacts to — sleep and wake, activation — are AppKit's to post, and subscribing to them is the one AppKit dependency it is allowed. What it dispatches into is not.

```swift
protocol BackgroundController: AnyObject {
    func startRunningInBackground()
    func stopRunningInBackground()
}
```

The protocol is a classification and a start/stop contract, nothing more — a class is named for what it does, never `Controller`. Conforming controllers start in phase 4 of launch — see <a href="/guide/02-2-startup">Chapter 2.2</a> — never earlier: initializers must stay fast, and a controller may assume the subsystems below it are already configured.

Reach for one when work has no gesture behind it: refreshing data on an interval, reacting to system events that can happen at any time, maintaining state derived from model changes, cleaning up stale data periodically, recording events for telemetry. And know the three cases that look like one but aren't: a one-shot user-initiated operation is an Action — <a href="/guide/06-1-actions">Chapter 6.1</a>; work that needs progress reporting and user cancellation is a long-running Action — the Action <em>is</em> the live operation, per that same subchapter; window-scoped state belongs to a view state model written by a view state controller — <a href="/guide/07-2-view-state">Chapter 7.2</a>.

<div class="table-wrap">
<table>
<thead><tr><th>Name</th><th>Driving signal</th><th>Does</th></tr></thead>
<tbody>
<tr><td class="pill">*Updater</td><td>Timer</td><td>Periodically refreshes data into local state.</td></tr>
<tr><td class="pill">*Watchdog</td><td>Timer</td><td>Checks for stalled or bad state and corrects it.</td></tr>
<tr><td class="pill">*Pruner</td><td>Timer</td><td>Periodically removes what nothing needs any more.</td></tr>
<tr><td class="pill">*Tracker</td><td>Event</td><td>Records observed events for later use.</td></tr>
<tr><td class="pill">*Projector</td><td>Event</td><td>Derives and publishes state from observed model changes.</td></tr>
</tbody>
</table>
</div>

These are names that have fit the roles they describe — examples, not a list to pick from. Name a background controller after what it does, in a word a reader understands at the call site without opening the class; a new role gets a new word rather than the nearest one from the table. Two things do hold. The generic `*BackgroundController` or `*EventController` form is reserved for when no specific word fits. And some words say nothing about the role, or the wrong thing: `*Observer` and `*Listener` (every subscription is an observer), `*Handler` (implies one-shot dispatch, not ongoing work), `*Manager` (reserved for the Model layer's stateful types), `*Worker` (says the object does the work, which is exactly what it doesn't). A hybrid — a timer that also adjusts its cadence on events — is named for the primary signal, the one that defines its purpose.

Here's a timer-driven one in full. `StaleActivityPruner` clears finished rows out of the app's activity store — <a href="/guide/05-6-progress-and-activities">Chapter 5.6</a> — once they are a day old, and shows every lifecycle rule in one place:

```swift
// NotebookApp/BackgroundControllers/StaleActivityPruner.swift — the timer and one call. Untested.
final class StaleActivityPruner: BackgroundController {
    private var timer: Timer?
    private var cancellables = Set<AnyCancellable>()

    func startRunningInBackground() {
        startTimer()

        // Pause on sleep, resume on wake — otherwise the app keeps waking
        // the machine for a cleanup nobody is awake to benefit from.
        NSWorkspace.shared.notificationCenter
            .publisher(for: NSWorkspace.willSleepNotification)
            .sink { [weak self] _ in self?.timer?.invalidate() }
            .store(in: &cancellables)

        NSWorkspace.shared.notificationCenter
            .publisher(for: NSWorkspace.didWakeNotification)
            .sink { [weak self] _ in self?.startTimer() }
            .store(in: &cancellables)
    }

    func stopRunningInBackground() {
        timer?.invalidate()
        timer = nil
        cancellables.removeAll()
    }

    deinit {
        timer?.invalidate()
    }

    private func startTimer() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 60 * 30, repeats: true) { [weak self] _ in
            self?.prune()
        }
    }

    private func prune() {
        // The work: a model function, tested in NotebookCore.
        ActivityStore.shared.removeFinished(olderThan: .seconds(24 * 60 * 60))
    }
}
```

The lifecycle rules the example encodes:

- <strong>Subscribe and start timers in `startRunningInBackground()`, never in `init`.</strong> The instance may be created during app setup, but nothing may fire before phase 4 — creation and starting are separate on purpose.
- <strong>A scheduled repeating `Timer` lives until it's invalidated.</strong> The run loop holds it strongly, so without an explicit `invalidate()` it keeps firing forever — and with the target/selector API it would additionally retain its target. The `weak self` in the block keeps the timer from pinning the controller; invalidation in stop <em>and</em> `deinit` keeps an orphaned timer from firing into nothing.
- <strong>Cancellables empty in stop.</strong> Block-based `NotificationCenter` observers added without Combine additionally need their token held and `removeObserver` called — they don't clean themselves up.

## The work goes elsewhere

Look at what `prune()` actually does: one call, nothing else. That is not an accident of the example — it is the rule. <strong>A background controller only forwards and coordinates; it never performs the task itself.</strong> It steers its signal — starts, pauses and invalidates the timer, subscribes and unsubscribes — and when the signal fires it makes one call into a named collaborator below the boundary: a model or manager function, an Action when the work is one the Action layer already owns, a Foundation-only helper that computes the state a projector publishes. The collaborator is tested where it lives, `removeFinished(olderThan:)` in the model package per <a href="/guide/09-6-testing-each-layer">Chapter 9.6</a>. The controller is not tested at all, per <a href="/guide/09-1-which-tests-to-write">Chapter 9.1</a>: there is no decision in it that can regress on its own, and a test of it would either restate the wiring or become an integration test of everything it touches.

Here is the same controller doing the task itself — the shape to avoid:

```swift
// Avoid — finding and deleting the stale rows lives in the controller, where nothing can test it
private func prune() {
    let cutoff = Date.now.addingTimeInterval(-24 * 60 * 60)
    let stale = ActivityStore.shared.activities.filter { $0.isFinished && ($0.endDate ?? .now) < cutoff }
    for activity in stale {
        ActivityStore.shared.remove(activity)
    }
}
```

So the tell is simple. If a background controller's body holds anything beyond that one call — finding what to act on, a filter, a computation, a decision beyond "fire now", a delete or a save — that is a collaborator waiting to be extracted into the model or Action layer. Controllers are not tested, so logic left in one is logic with no test. A background controller that would need its own test is a sign the split is wrong.

All of them live in one root folder of the app target, `BackgroundControllers/`, for the same reason Action Controllers do: they are a coordination kind above the boundary, and the folder doubles as the complete list of what phase 4 starts. The collaborators live in their own domain — never in that folder, and never the other way round: a controller inside the model package is either model-layer work that should be a manager function, or a controller that belongs upstairs. <a href="/guide/01-1-project-layout">Chapter 1.1</a> has the tree.

An event-driven controller is the same skeleton with a subscription in place of the timer: a `TagUsageProjector` subscribes to the note-changed notification and calls the one function that recomputes tag usage counts and publishes the result. Which brings up the one design decision every background controller makes — <strong>where its output goes</strong>. Pick exactly one channel per piece of state:

<div class="table-wrap">
<table>
<thead><tr><th>Channel</th><th>When</th></tr></thead>
<tbody>
<tr><td>An <code>@Observable</code> property on the controller</td><td>Views and view controllers consume it by tracking — <a href="/guide/07-4-state-observing">Chapter 7.4</a>.</td></tr>
<tr><td>A posted notification</td><td>Broad fan-out to consumers that don't hold a reference.</td></tr>
<tr><td>A write into a manager</td><td>The controller's whole job is refreshing data the manager already owns.</td></tr>
</tbody>
</table>
</div>

Publishing the same state through two channels means consumers never know which one to trust — one place to look, always.

<div class="rule">
<span class="rule-label">The rule</span>

A background controller may read from managers and trigger reloads on them, and it may update its own published state — delivered on the main thread, even if its work runs elsewhere. It must never render UI, never contain the work itself — when its signal fires it makes one call into a model or manager function or dispatches an Action, tested where it lives — never be invoked as part of a user gesture, and never be created per-window — that's a job for view state, not a background controller.

</div>

<div class="seealso">
<strong>Ahead in this guide</strong>
The Model layer these controllers read from and write into — the write funnel every manager enforces — is next: <a href="/guide/05-model-layer">Chapter 5, The Model Layer</a>.
</div>
