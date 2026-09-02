---
title: "Action Validation"
description: "An Action existing and an Action being allowed to run right now are different questions. This chapter covers the two-layer system that answers the second one, and wires the answer into menus, toolbars, and the responder chain without ever asking a view to make the decision."
order: 5
---

An Action existing and an Action being allowed to run right now are different questions. This chapter covers the two-layer system that answers the second one, and wires the answer into menus, toolbars, and the responder chain without ever asking a view to make the decision.

## Two layers, two questions

A <strong>Validator</strong> answers "can this Action run, given current state?" It's a plain Foundation type, split into two methods that answer two different questions:

- `validateBefore()` — preconditions independent of any parameter. Is there more than one notebook left to delete from? Is nothing already syncing? An Action Controller calls this alone to decide whether a dialog can even open.
- `validate()` — calls `validateBefore()`, then checks that the specific parameters this run needs are actually present.

```swift
class ActionValidator {
    func validateBefore() throws { }
    func validate() throws { try validateBefore() }
}

final class DeleteNotebookValidator: ActionValidator {
    var notebook: Notebook?

    override func validateBefore() throws {
        guard NotebookStore.shared.notebooks.count > 1 else {
            throw ValidationError("Can't delete the last notebook")
        }
    }

    override func validate() throws {
        try validateBefore()
        guard notebook != nil else {
            throw ValidationError("No notebook given")
        }
    }
}
```

Concrete validators for the same domain chain their preconditions through `super.validateBefore()`, so a shared check — "nothing is mid-sync," say — is written once and reused by every Action that needs it.

## Wiring validation into the responder chain

AppKit already validates `NSMenuItem` and `NSToolbarItem` automatically, via `NSUserInterfaceValidations` on responder-chain objects — Airframe just gives that mechanism something real to call. A second type, the <strong>Action Sender Validator</strong>, bridges the two: it registers a mapping from UI action selectors to validation methods, and the view controller asks each registered sender validator, in turn, whether it can handle a given menu item or toolbar item.

```swift
final class NotebookActionSenderValidator: ActionSenderValidator {
    override func registerActions() {
        register(#selector(deleteNotebook(_:)), validator: validateDelete)
        register(#selector(syncNotebook(_:)), validator: validateSync)
    }

    private func validateDelete(_ item: NSMenuItem?) -> Bool {
        let validator = DeleteNotebookValidator()
        validator.notebook = item?.notebookValue ?? currentSelection
        return (try? validator.validate()) != nil
    }
}
```

End to end, a click on a menu item that reads `target: nil` travels: down the responder chain to the owning view controller's `validateMenuItem:`; through its list of registered sender validators until one claims the selector; into that validator's registered method; which builds the concrete `ActionValidator`, fills in whatever data the menu item carried, and calls `validate()`. The boolean result enables or disables the item — nothing about this path required the view controller to know what "can this notebook be deleted" actually means.

## Keeping validation logic out of the view

Both validator types are Foundation-only, per the boundary from <a href="/guide/01-getting-started">Chapter 1</a> — they can be constructed and asked questions in a test with no window, no menu, no app instance. That's only true because of one discipline: a validator answers exactly one question and returns, it never renders anything, and it never reaches into a view to check what's currently selected — the caller (an Action Controller, or the sender validator's registered method) is responsible for handing it whatever it needs to decide.

<div class="rule">
<span class="rule-label">The rule</span>

If a validator needs a piece of data that isn't on the UI element that triggered it, the caller supplies it — usually from the current selection. The validator itself never asks a view for anything. This is what keeps `validate()` callable from a test, a background controller, or an Action's own precondition check, identically.

</div>

<div class="seealso">
<strong>Ahead in this guide</strong>
How a menu item carries `notebookValue` — a typed, safe accessor over `representedObject` — is <a href="/guide/08-menus">Chapter 8</a>. Testing validators directly, without constructing an Action or a controller, is <a href="/guide/10-testing">Chapter 10</a>.
</div>
