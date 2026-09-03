---
title: "Menus"
description: "A menu isn't a special case bolted onto the architecture — it's the mutate path from Chapter 1 wearing an NSMenuItem. This chapter covers building menus, carrying typed data on them safely, and getting validation for free."
order: 9
---

A menu isn't a special case bolted onto the architecture — it's the mutate path from Chapter 1 wearing an NSMenuItem. This chapter covers building menus, carrying typed data on them safely, and getting validation for free.

## Menus as an action-driven view concern

Menu items are built through `make…()` factory methods in an `NSMenuItem` extension, so the same item can be assembled identically wherever it's needed. A dedicated <strong>menu controller</strong> — a view component controller from <a href="/guide/07-views">Chapter 7</a>, specialized for menus — owns a menu's lifecycle: it's the menu's `NSMenuDelegate` and rebuilds the item list on demand, reading whatever state the owning view controller has pushed into it. When the menu is tied to a pop-up or popover button, the menu controller manages the button and its menu together — the two are one component.

```swift
extension NSMenuItem {
    static func makeDeleteItem(for notebook: Notebook) -> NSMenuItem {
        let item = NSMenuItem(title: "Delete \"\(notebook.title)\"",
                              action: #selector(deleteNotebook(_:)), keyEquivalent: "")
        item.representedObject = notebook
        return item
    }
}

final class NotebookMenuController: NSObject, NSMenuDelegate {
    weak var menu: NSMenu? { didSet { menu?.delegate = self } }
    var selectedNotebook: Notebook?

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        guard let notebook = selectedNotebook else { return }
        menu.items = [.makeDeleteItem(for: notebook), .makeSyncItem(for: notebook)]
    }
}
```

## Wiring menu items to Actions

An item's `action` is a selector, and its `target` is left `nil` on purpose — `nil` dispatches through the responder chain to whichever view controller implements it, which is also exactly what makes <a href="/guide/05-action-validation">Chapter 5</a>'s automatic validation apply. A menu controller never calls an Action Controller directly; it only builds items and lets the responder chain do the rest.

## Type-safe payloads on menu items

`representedObject` is typed `Any?`, which pushes every consumer toward an unsafe cast unless something narrows it first. A pair of generic accessors solve this once:

```swift
extension NSMenuItem {
    func value<T>(as type: T.Type) -> T? {
        representedObject as? T
    }

    func values<T>(as type: T.Type) -> [T]? {
        if let array = representedObject as? [T] { return array }
        if let single = representedObject as? T { return [single] }
        return nil
    }
}

// Domain-specific — grouped by area, one-liners
extension NSMenuItem {
    var notebookValue: Notebook? { value(as: Notebook.self) }
    var notebooksValue: [Notebook]? { values(as: Notebook.self) }
}
```

An action method never casts `representedObject` directly — it reaches for the typed accessor, with a fallback to whatever the controller's current selection is, so the same method serves both a context menu item that carries data and a toolbar button that doesn't:

```swift
@objc func deleteNotebook(_ sender: Any?) {
    let menuItem = sender as? NSMenuItem
    let notebook = menuItem?.notebookValue ?? state.selectedNotebook
    // …
}
```

## Tying validation into menu item enablement

Because the item's target is `nil`, enabling and disabling it is automatic once <a href="/guide/05-action-validation">Chapter 5</a>'s sender validator is registered — nothing menu-specific needs to happen beyond that registration. For menus that don't participate in the responder chain at all — a simple picker with no action validation to speak of — SwiftUI's own `Menu` view is fine as-is. Once a menu <em>does</em> need validation, it needs a real `NSMenu`: a small provider protocol lets the menu controller build that real menu on demand while the SwiftUI view stays previewable, with no hard dependency on the controller that owns it.

<div class="seealso">
<strong>Ahead in this guide</strong>
Moving between the screens a menu item might navigate to is <a href="/guide/10-navigation">Chapter 10</a>. Testing a validator directly, without building a menu at all, is <a href="/guide/11-testing">Chapter 11</a>.
</div>
