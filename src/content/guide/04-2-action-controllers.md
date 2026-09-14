---
title: "Action Controllers"
description: "Action Controllers and background controllers are the two places outside the Action itself where the coordination layer does its work — one bridging a user gesture to AppKit, the other running with no gesture behind it at all. This subchapter covers both."
order: 4
subOrder: 2
---

Action Controllers and background controllers are the two places outside the Action itself where the coordination layer does its work — one bridging a user gesture to AppKit, the other running with no gesture behind it at all. This subchapter covers both.

## Action Controllers: the only AppKit-side bridge

An Action Controller is the one coordination-layer type allowed to touch AppKit — it presents a dialog, collects the user's input, builds an Action from it, and dispatches it. Everything downstream of that dispatch, per the boundary in <a href="/guide/01-getting-started">Chapter 1</a>, is Foundation-only again.

A common shape opens a result window immediately, before the Action has finished: a loading view binds to `action.status`, and once it flips to `.completed`, the controller fetches the result from the domain manager and swaps the content in. Results live on the manager, not on the Action itself — the Action stays focused on lifecycle, and a background-triggered run of the same work (no Action wrapper at all) can produce and cache a result the same way.

## Background controllers

Some work isn't triggered by a gesture at all — a periodic refresh, a reaction to the system waking from sleep, a value derived continuously from the Model. That's a background controller: a long-lived, app- or document-lifetime object, Foundation-only, that never shows UI and is never invoked as part of a user gesture.

```swift
protocol BackgroundController: AnyObject {
    func startRunningInBackground()
    func stopRunningInBackground()
}
```

Conforming controllers start in phase 4 of launch — see <a href="/guide/02-initializing">Chapter 2</a> — never earlier: initializers must stay fast, and a controller may assume the subsystems below it are already configured.

Reach for one when work has no gesture behind it: refreshing data on an interval, reacting to system events that can happen at any time, maintaining state derived from model changes, cleaning up stale data periodically, recording events for telemetry. And know the three cases that look like one but aren't: a one-shot user-initiated operation is an Action — <a href="/guide/04-1-actions">Chapter 4.1</a>; work that needs progress reporting and user cancellation is a long-running Action — the Action <em>is</em> the live operation, per that same subchapter; window-scoped state belongs to a view state object — <a href="/guide/06-views">Chapter 6</a>.

<div class="table-wrap">
<table>
<thead><tr><th>Suffix</th><th>Driving signal</th><th>Does</th></tr></thead>
<tbody>
<tr><td class="pill">*Updater</td><td>Timer</td><td>Periodically refreshes data into local state.</td></tr>
<tr><td class="pill">*Watchdog</td><td>Timer</td><td>Checks for stalled or bad state and corrects it.</td></tr>
<tr><td class="pill">*Reaper</td><td>Timer</td><td>Periodically removes stale or expired data.</td></tr>
<tr><td class="pill">*Tracker</td><td>Event</td><td>Records observed events for later use.</td></tr>
<tr><td class="pill">*Projector</td><td>Event</td><td>Derives and publishes state from observed model changes.</td></tr>
</tbody>
</table>
</div>

The specific suffix is preferred over a generic `*Controller` or `*Observer` precisely because it makes the type's purpose legible at the call site without opening the file. A hybrid — a timer that also adjusts its cadence on events — is named for the primary signal, the one that defines its purpose.

Here's a timer-driven one in full. `StaleDraftReaper` deletes autosaved note drafts past their keep-window, and shows every lifecycle rule in one place:

```swift
final class StaleDraftReaper: BackgroundController {
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
            self?.reap()
        }
    }

    private func reap() {
        let cutoff = Date().addingTimeInterval(-30 * 24 * 3600)
        NoteManager.shared.deleteDrafts(olderThan: cutoff)
    }
}
```

The lifecycle rules the example encodes:

- <strong>Subscribe and start timers in `startRunningInBackground()`, never in `init`.</strong> The instance may be created during app setup, but nothing may fire before phase 4 — creation and starting are separate on purpose.
- <strong>A scheduled repeating `Timer` lives until it's invalidated.</strong> The run loop holds it strongly, so without an explicit `invalidate()` it keeps firing forever — and with the target/selector API it would additionally retain its target. The `weak self` in the block keeps the timer from pinning the controller; invalidation in stop <em>and</em> `deinit` keeps an orphaned timer from firing into nothing.
- <strong>Cancellables empty in stop.</strong> Block-based `NotificationCenter` observers added without Combine additionally need their token held and `removeObserver` called — they don't clean themselves up.

An event-driven controller is the same skeleton with a subscription in place of the timer: a `TagUsageProjector` subscribes to the note-changed notification, recomputes tag usage counts, and publishes the result. Which brings up the one design decision every background controller makes — <strong>where its output goes</strong>. Pick exactly one channel per piece of state:

<div class="table-wrap">
<table>
<thead><tr><th>Channel</th><th>When</th></tr></thead>
<tbody>
<tr><td>An <code>@Observable</code> property on the controller</td><td>Views and state objects consume it by tracking — <a href="/guide/07-state-observing">Chapter 7</a>.</td></tr>
<tr><td>A posted notification</td><td>Broad fan-out to consumers that don't hold a reference.</td></tr>
<tr><td>A write into a manager</td><td>The controller's whole job is refreshing data the manager already owns.</td></tr>
</tbody>
</table>
</div>

Publishing the same state through two channels means consumers never know which one to trust — one place to look, always.

<div class="rule">
<span class="rule-label">The rule</span>

A background controller may read from managers and trigger reloads on them, and it may update its own published state — delivered on the main thread, even if its work runs elsewhere. It must never show UI, never be invoked as part of a user gesture, and never be created per-window — that's a job for view state, not a background controller.

</div>

<div class="seealso">
<strong>Ahead in this guide</strong>
Validators — the precondition checks Action Controllers use to enable or disable UI, referenced above — get their own subchapter next: <a href="/guide/04-3-action-validation">Chapter 4.3, Action Validation</a>. The serial runner and job structs used throughout Actions and Action Controllers are covered properly in <a href="/guide/05-concurrency">Chapter 5, Concurrency</a>.
</div>
