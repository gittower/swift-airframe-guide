---
title: "Navigation"
description: "Every chapter so far has been about one screen. This one is about the seam between screens — and why that seam is a state object owned by a parent, never a view holding a reference to another view."
order: 10
---

Every chapter so far has been about one screen. This one is about the seam between screens — and why that seam is a state object owned by a parent, never a view holding a reference to another view.

## Moving between screens without views reaching into each other

The anti-pattern is a sidebar view controller that holds a direct reference to the detail view controller next to it, and pushes data in whenever the selection changes. It works, right up until a third surface needs the same selection, or the detail pane needs to be shown in a second window — at which point every view that reached into another view has to be found and rewired.

The pattern instead is the same one from <a href="/guide/03-model-layer">Chapter 3</a>'s "scoped state" case: a parent view controller owns a small `@Observable` navigation state describing what's selected and what's showing. Children never see each other — they read plain input properties set by the parent, and own whatever loading state they need themselves.

```swift
@Observable @MainActor
final class NotebookNavigationState {
    var selectedNotebookID: NotebookID?
    var selectedNoteID: NoteID?
}
```

```swift
@StateObserving
final class WorkspaceViewController: NSViewController {
    let navigation = NotebookNavigationState()
    private let sidebar = NotebookSidebarViewController()
    private let detail = NoteDetailViewController()

    override func loadView() {
        sidebar.onSelect = { [weak self] id in self?.navigation.selectedNotebookID = id }
        // …assemble sidebar + detail into the view hierarchy…
    }

    override func viewWillAppear() {
        super.viewWillAppear()
        activateObservation()
    }

    override func viewWillDisappear() {
        super.viewWillDisappear()
        deactivateObservation()
    }

    func observeState() {
        observations.track { [weak self] in self?.pushSelection() }
    }

    private func pushSelection() {
        detail.notebookID = navigation.selectedNotebookID   // parent pushes the input down
    }
}
```

The sidebar never calls into the detail controller. It fires a closure; the parent updates its navigation state; the tracked updater above — the render mechanism covered in <a href="/guide/08-state-observing">Chapter 8</a> — pushes the new input into the detail controller, which reacts to its own `notebookID` changing exactly the way any input property does.

## Where navigation sits relative to controllers and actions

Navigation state is consumed no differently from any other state in this guide — render it in a tracked updater, react to input changes via `observations.observe`. Swapping in the right child view controller for the current selection is the controller-level swap from <a href="/guide/07-views">Chapter 7</a>, not a special navigation mechanism. An Action is free to change the selection as one step of its own work — creating a notebook and then selecting it is a natural final step of `CreateNotebookAction.main()` — but the navigation state itself is not an Action and has no lifecycle of its own; it's ordinary scoped state, owned by whichever controller is the parent for this part of the screen.

<div class="rule">
<span class="rule-label">The rule</span>

Navigation state lives on the parent that routes between children — never inside one of the children it routes between, and never in the Model layer. The Model doesn't know what's currently selected on screen; that's presentation state, not domain state, even though an identifier stored in it (a `NotebookID`) points at something the Model owns.

</div>

## Restoring navigation on relaunch

Because the navigation state stores identifiers and not the objects themselves, restoring it after a relaunch is cheap: persist the selected ID — via window restoration's `NSCoder`, or a settings value from <a href="/guide/02-initializing">Chapter 2</a> for something lighter-weight than a whole window — and re-resolve it against whatever the Model layer has actually loaded once startup reaches phase 4. Restoring a stored <em>object</em> instead of an identifier is the mistake to avoid: it risks resurrecting a stale snapshot instead of asking the Model what's true now.

<div class="seealso">
<strong>Ahead in this guide</strong>
Testing a navigation state object — a plain `@Observable` class with no AppKit dependency — follows the same rules as testing any other state object; see <a href="/guide/11-testing">Chapter 11</a>.
</div>
