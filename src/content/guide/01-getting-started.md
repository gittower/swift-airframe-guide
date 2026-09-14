---
title: "Getting Started"
description: "Airframe is an opinionated layered architecture for native Swift apps — AppKit and SwiftUI working together under one rule for where state lives and who is allowed to change it. This chapter lays out the four layers, the two paths data takes through them, and the single synchronization model that makes the whole thing hold together."
order: 1
---

Airframe is an opinionated layered architecture for native Swift apps — AppKit and SwiftUI working together under one rule for where state lives and who is allowed to change it. This chapter lays out the four layers, the two paths data takes through them, and the single synchronization model that makes the whole thing hold together.

## Architecture Philosophy

This guide builds on MVC as the Cocoa platform has always defined it — and that is not "Model, View, ViewController." In Cocoa's reading, the three names describe *layers*, not three kinds of class. The Model layer holds all application state and every method that manipulates it; the View layer displays that state and delegates every user action onward without interpreting it; the Controller layer sits between them, translating user input, system events, and model changes into each other. Each layer is a group of classes — a single "fat model" or a "massive view controller" is not a requirement of the pattern but a failure to split responsibilities within or across the layers — and a single object can legitimately span two layers. What the pattern demands is not a class-naming scheme but a discipline about where state lives and who may change it.

<figure class="diagram">
<svg viewBox="0 0 760 300" role="img" aria-label="The three MVC layers drawn as horizontal bands, each containing several classes: the View layer holds NoteListView, NoteEditorView, and NoteListViewController; the Controller layer holds NoteActionController, NotebookListStateController, and DeleteNoteAction; the Model layer holds Note, Notebook, NoteManager, and SyncManager. Each band ends with an ellipsis chip indicating more classes.">
<text x="78" y="60" text-anchor="end" font-family="var(--font-display)" font-weight="700" font-size="13">View</text>
<rect x="90" y="20" width="580" height="72" rx="8" fill="none" stroke="currentColor" stroke-width="1.6"/>
<rect x="104" y="43" width="88" height="26" rx="6" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.85"/>
<text x="148" y="60" text-anchor="middle" font-family="var(--font-mono)" font-size="10">NoteListView</text>
<rect x="204" y="43" width="100" height="26" rx="6" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.85"/>
<text x="254" y="60" text-anchor="middle" font-family="var(--font-mono)" font-size="10">NoteEditorView</text>
<rect x="316" y="43" width="148" height="26" rx="6" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.85"/>
<text x="390" y="60" text-anchor="middle" font-family="var(--font-mono)" font-size="10">NoteListViewController</text>
<text x="490" y="60" text-anchor="middle" font-family="var(--font-mono)" font-size="10" opacity="0.6">…</text>
<text x="78" y="152" text-anchor="end" font-family="var(--font-display)" font-weight="700" font-size="13">Controller</text>
<rect x="90" y="112" width="580" height="72" rx="8" fill="none" stroke="currentColor" stroke-width="1.6"/>
<rect x="104" y="135" width="136" height="26" rx="6" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.85"/>
<text x="172" y="152" text-anchor="middle" font-family="var(--font-mono)" font-size="10">NoteActionController</text>
<rect x="252" y="135" width="184" height="26" rx="6" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.85"/>
<text x="344" y="152" text-anchor="middle" font-family="var(--font-mono)" font-size="10">NotebookListStateController</text>
<rect x="448" y="135" width="112" height="26" rx="6" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.85"/>
<text x="504" y="152" text-anchor="middle" font-family="var(--font-mono)" font-size="10">DeleteNoteAction</text>
<text x="586" y="152" text-anchor="middle" font-family="var(--font-mono)" font-size="10" opacity="0.6">…</text>
<text x="78" y="244" text-anchor="end" font-family="var(--font-display)" font-weight="700" font-size="13">Model</text>
<rect x="90" y="204" width="580" height="72" rx="8" fill="none" stroke="currentColor" stroke-width="1.6"/>
<rect x="104" y="227" width="40" height="26" rx="6" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.85"/>
<text x="124" y="244" text-anchor="middle" font-family="var(--font-mono)" font-size="10">Note</text>
<rect x="156" y="227" width="64" height="26" rx="6" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.85"/>
<text x="188" y="244" text-anchor="middle" font-family="var(--font-mono)" font-size="10">Notebook</text>
<rect x="232" y="227" width="82" height="26" rx="6" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.85"/>
<text x="273" y="244" text-anchor="middle" font-family="var(--font-mono)" font-size="10">NoteManager</text>
<rect x="326" y="227" width="82" height="26" rx="6" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.85"/>
<text x="367" y="244" text-anchor="middle" font-family="var(--font-mono)" font-size="10">SyncManager</text>
<text x="434" y="244" text-anchor="middle" font-family="var(--font-mono)" font-size="10" opacity="0.6">…</text>
</svg>
<figcaption>Each layer is a group of classes, not one class. Splitting <code>NoteManager</code> out of <code>Note</code> — or a state controller out of a view controller — is a split <em>within</em> a layer, not a new layer.</figcaption>
</figure>

### The view controller misreading

The most persistent misconception is that the view controller *is* the Controller layer. It isn't — a view controller belongs almost entirely to the View layer. It is a special kind of root view: it composes child views, manages their lifecycle, participates in the responder chain, and responds to events its subviews shouldn't know about. That is View-layer work. But because the view controller is the first object to receive a user's action, it is also where application logic quietly accumulates — a view controller that deletes notes, talks to the sync service, and validates input has silently absorbed two other layers. The actual Controller layer is made of objects that are *not* bound to any single view's lifetime: Action Controllers that turn a gesture into a validated operation, and View State Controllers that shape model data for one particular presentation. SwiftUI makes the distinction impossible to ignore — there is no view controller at all, and the coordination work it used to hide has to live somewhere deliberate.

<figure class="diagram">
<svg viewBox="0 0 760 300" role="img" aria-label="Two readings of MVC side by side. On the left, the misreading: three stacked boxes labeled View, ViewController cast as the Controller, and Model — one class per letter. On the right, Cocoa's reading: three layers, where the View layer contains both views and view controllers, the Controller layer contains action controllers and state controllers, and the Model layer holds all application state. An accent arrow moves the ViewController from the left stack's controller slot into the right side's View layer.">
<defs>
<marker id="arrAccentB" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
<path d="M0,0 L10,5 L0,10 z" fill="var(--accent)"/>
</marker>
</defs>
<text x="190" y="34" text-anchor="middle" font-family="var(--font-display)" font-weight="700" font-size="13">“Model, View, ViewController”</text>
<text x="190" y="50" text-anchor="middle" font-family="var(--font-mono)" font-size="9.5" opacity="0.7">one class per letter — the misreading</text>
<g opacity="0.85">
<rect x="60" y="66" width="260" height="58" rx="8" fill="none" stroke="currentColor" stroke-width="1.6"/>
<text x="190" y="99" text-anchor="middle" font-family="var(--font-display)" font-weight="700" font-size="13">View</text>
<rect x="60" y="140" width="260" height="58" rx="8" fill="none" stroke="currentColor" stroke-width="1.6"/>
<text x="190" y="163" text-anchor="middle" font-family="var(--font-display)" font-weight="700" font-size="13">ViewController</text>
<text x="190" y="181" text-anchor="middle" font-family="var(--font-mono)" font-size="9.5" opacity="0.7">cast as “the Controller”</text>
<rect x="60" y="214" width="260" height="58" rx="8" fill="none" stroke="currentColor" stroke-width="1.6"/>
<text x="190" y="247" text-anchor="middle" font-family="var(--font-display)" font-weight="700" font-size="13">Model</text>
</g>
<text x="570" y="34" text-anchor="middle" font-family="var(--font-display)" font-weight="700" font-size="13">MVC as layers</text>
<text x="570" y="50" text-anchor="middle" font-family="var(--font-mono)" font-size="9.5" opacity="0.7">Cocoa's reading — groups, not names</text>
<rect x="440" y="66" width="260" height="58" rx="8" fill="none" stroke="currentColor" stroke-width="1.6"/>
<text x="570" y="84" text-anchor="middle" font-family="var(--font-display)" font-weight="700" font-size="13">View</text>
<rect x="489" y="92" width="106" height="24" rx="6" fill="none" stroke="var(--accent)" stroke-width="1.6"/>
<text x="542" y="108" text-anchor="middle" font-family="var(--font-mono)" font-size="9.5">View Controllers</text>
<rect x="607" y="92" width="44" height="24" rx="6" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.85"/>
<text x="629" y="108" text-anchor="middle" font-family="var(--font-mono)" font-size="9.5">Views</text>
<rect x="440" y="140" width="260" height="58" rx="8" fill="none" stroke="currentColor" stroke-width="1.6"/>
<text x="570" y="163" text-anchor="middle" font-family="var(--font-display)" font-weight="700" font-size="13">Controller</text>
<text x="570" y="181" text-anchor="middle" font-family="var(--font-mono)" font-size="9.5" opacity="0.7">action controllers · state controllers</text>
<rect x="440" y="214" width="260" height="58" rx="8" fill="none" stroke="currentColor" stroke-width="1.6"/>
<text x="570" y="237" text-anchor="middle" font-family="var(--font-display)" font-weight="700" font-size="13">Model</text>
<text x="570" y="255" text-anchor="middle" font-family="var(--font-mono)" font-size="9.5" opacity="0.7">holds all application state</text>
<path d="M322,152 C 390,152 420,104 481,104" fill="none" stroke="var(--accent)" stroke-width="1.8" stroke-dasharray="1 6" stroke-linecap="round" marker-end="url(#arrAccentB)"/>
<text x="380" y="174" text-anchor="middle" font-family="var(--font-mono)" font-size="9.5" fill="var(--accent)">actually lives here</text>
</svg>
<figcaption>The name puts the view controller in the Controller slot; the platform puts it in the View layer. The Controller layer is made of the objects that outlive any single view.</figcaption>
</figure>

### The per-screen detour: MVVM, MVP, VIPER

That misreading, not MVC itself, is what the industry has spent two decades reacting to — swapping the massive view controller for a new per-screen coordinator under a new acronym: a view model in MVVM, a presenter in MVP, a module in VIPER. But the question that caused the pain — *where does application state live, and who may change it?* — is asked once, for the whole app; a pattern whose unit is the screen cannot answer it, only relocate it.

It is no accident that these patterns grew up on iOS, where showing one screen at a time makes the screen look like the unit of architecture. A Mac window dispels that at a glance: sidebar, note list, editor, window title, and menu bar are five presentations of the same state, all obliged to agree the instant a note is deleted — and two view models each holding their own copy of the notes have no source of truth between them. Keeping many separate views in sync is the resting state of a macOS app (and behind its single screen, an iOS app has the same app-level state); MVC read as layers answers it with one place state lives and controllers translating between it and every view. What survives of the per-screen patterns is their valid kernel: a View State Controller is a view model demoted from owner to lens — it shapes model data for one presentation, but owns no state and performs no mutations.

### Application state vs. view state

The dividing line between the layers is the difference between **application state** and **view state**. Which notebooks exist, which notes they contain, whether a sync is in progress — that is application state: it lives in the Model layer, is updated only through defined write paths, and broadcasts a notification whenever it changes. Which note is selected, whether the sidebar is collapsed, how a table is sorted — that is view state: it describes one presentation of the data and belongs with that view's controller, following the rule that controllers hold only state that concerns themselves. The distinction earns its keep the moment two views show the same data. A note can be deleted from the note list *and* from its detail pane. If the deletion logic lives in the detail view controller, the list cannot reuse it — and the view controller may be deallocated the moment its view disappears, mid-operation. Instead, both views hand the gesture to the same Action; `NoteManager` updates the model; the model posts a change notification; and the list, the detail pane, and the window title all revalidate themselves identically. The view that initiated the change has no special status — it finds out the same way everyone else does.

<figure class="diagram">
<svg viewBox="0 0 760 380" role="img" aria-label="Flow diagram of a note being deleted from two different views. The note list and the detail pane both dispatch the same DeleteNoteAction, which calls NoteManager, which updates the Model. The Model then broadcasts an accent-colored notification upward to the note list, the detail pane, and a window title that only observes — all three revalidate identically.">
<defs>
<marker id="arrC" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
<path d="M0,0 L10,5 L0,10 z" fill="currentColor"/>
</marker>
<marker id="arrAccentC" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
<path d="M0,0 L10,5 L0,10 z" fill="var(--accent)"/>
</marker>
</defs>
<rect x="90" y="20" width="170" height="52" rx="8" fill="none" stroke="currentColor" stroke-width="1.6"/>
<text x="175" y="41" text-anchor="middle" font-family="var(--font-display)" font-weight="700" font-size="13">Note list</text>
<text x="175" y="58" text-anchor="middle" font-family="var(--font-mono)" font-size="9.5" opacity="0.7">view controller</text>
<rect x="300" y="20" width="170" height="52" rx="8" fill="none" stroke="currentColor" stroke-width="1.6"/>
<text x="385" y="41" text-anchor="middle" font-family="var(--font-display)" font-weight="700" font-size="13">Detail pane</text>
<text x="385" y="58" text-anchor="middle" font-family="var(--font-mono)" font-size="9.5" opacity="0.7">view controller</text>
<rect x="510" y="20" width="160" height="52" rx="8" fill="none" stroke="currentColor" stroke-width="1.6"/>
<text x="590" y="41" text-anchor="middle" font-family="var(--font-display)" font-weight="700" font-size="13">Window title</text>
<text x="590" y="58" text-anchor="middle" font-family="var(--font-mono)" font-size="9.5" opacity="0.7">observer only</text>
<line x1="175" y1="74" x2="252" y2="118" stroke="currentColor" stroke-width="1.5" marker-end="url(#arrC)"/>
<line x1="385" y1="74" x2="308" y2="118" stroke="currentColor" stroke-width="1.5" marker-end="url(#arrC)"/>
<text x="280" y="100" text-anchor="middle" font-family="var(--font-mono)" font-size="10.5">delete</text>
<rect x="190" y="120" width="180" height="48" rx="8" fill="none" stroke="currentColor" stroke-width="1.6"/>
<text x="280" y="141" text-anchor="middle" font-family="var(--font-display)" font-weight="700" font-size="13">DeleteNoteAction</text>
<text x="280" y="158" text-anchor="middle" font-family="var(--font-mono)" font-size="9.5" opacity="0.7">one action, both views</text>
<line x1="280" y1="168" x2="280" y2="214" stroke="currentColor" stroke-width="1.5" marker-end="url(#arrC)"/>
<text x="288" y="196" font-family="var(--font-mono)" font-size="10.5">calls</text>
<rect x="190" y="216" width="180" height="44" rx="8" fill="none" stroke="currentColor" stroke-width="1.6"/>
<text x="280" y="237" text-anchor="middle" font-family="var(--font-display)" font-weight="700" font-size="13">NoteManager</text>
<text x="280" y="253" text-anchor="middle" font-family="var(--font-mono)" font-size="9.5" opacity="0.7">write funnel</text>
<line x1="280" y1="260" x2="280" y2="306" stroke="currentColor" stroke-width="1.5" marker-end="url(#arrC)"/>
<text x="288" y="288" font-family="var(--font-mono)" font-size="10.5">updates</text>
<rect x="90" y="308" width="580" height="52" rx="8" fill="none" stroke="currentColor" stroke-width="1.6"/>
<text x="380" y="329" text-anchor="middle" font-family="var(--font-display)" font-weight="700" font-size="13">Model</text>
<text x="380" y="346" text-anchor="middle" font-family="var(--font-mono)" font-size="9.5" opacity="0.7">application state — which notes exist</text>
<line x1="140" y1="306" x2="140" y2="76" stroke="var(--accent)" stroke-width="1.8" stroke-dasharray="1 6" stroke-linecap="round" marker-end="url(#arrAccentC)"/>
<line x1="440" y1="306" x2="440" y2="76" stroke="var(--accent)" stroke-width="1.8" stroke-dasharray="1 6" stroke-linecap="round" marker-end="url(#arrAccentC)"/>
<line x1="590" y1="306" x2="590" y2="76" stroke="var(--accent)" stroke-width="1.8" stroke-dasharray="1 6" stroke-linecap="round" marker-end="url(#arrAccentC)"/>
<text x="600" y="190" transform="rotate(-90 600 190)" text-anchor="middle" font-family="var(--font-mono)" font-size="10.5" fill="var(--accent)">notifies</text>
</svg>
<figcaption>The initiating view has no special status. Both views dispatch the same Action; the Model announces the change, and every observer — including the window title, which never touched the note — revalidates the same way.</figcaption>
</figure>

### Unidirectional data flow

The loop in that figure has a name: **unidirectional data flow**. A gesture becomes an Action; the Action writes to the Model; the Model broadcasts the change; every observer — including the view that initiated it — refreshes from the source of truth. Mutations flow down one path, change events flow back up another, and nothing ever writes backward through the read path. If you arrive from SwiftUI, TCA, Elm, or Redux, you already know this shape — but it is not an import from those worlds. The observer loop at the heart of every unidirectional architecture *is* original MVC's model-notifies-views mechanism. Airframe's philosophy in one sentence: MVC's layers, with unidirectional data flow as the enforced mechanics.

One thing this guide deliberately does *not* follow is classic Cocoa's own implementation of the philosophy: Cocoa Bindings, whose mediating controllers (`NSArrayController` and its siblings) carried reads and writes through one bidirectional, KVO-synchronized pipe. That was marvelously little code for the data-focused table apps it was designed around, but it offers no seam for validation, no reusable operation, and no answer for a background writer. Airframe keeps the loop and replaces the mechanics: separate read and mutate paths, a validated Action instead of a property write-back, one explicit change notification, and the main actor as the lock.

### Why this scales

Because all application state sits in one layer, every controller reuses the same logic, and adding a new view — a search results list, a menu item, a status badge — means adding one more observer, not touching anything that already works. Because the logic itself is extracted into Actions and the Model layer, it is plain Foundation code, testable without a running app; views and view controllers merely render state that is already verified, which is why they need almost no tests of their own. And because every change, whether triggered by a user or a background task, flows through the same write path and announces itself the same way, there is exactly one synchronization story to get right. None of this is dogma imported from elsewhere: the observer loop around a single source of truth is the platform's oldest pattern — the same loop bindings once automated for the table-shaped apps of their era, made explicit, validated, and enforceable here.

## The four layers

An Airframe app is built from four layers, stacked so that dependencies only ever point downward:

- <strong>Presentation</strong> — views and view controllers. What the user sees and touches.
- <strong>Controllers</strong> — the coordination layer. A <strong>View State Controller</strong> shapes model data for display; an <strong>Action Controller</strong> turns a user gesture into a configured <strong>Action</strong>.
- <strong>Actions</strong> — the operations that mutate state, plus the <strong>Validators</strong> that check whether they're allowed to run.
- <strong>Model</strong> — the domain state itself, sitting on top of the packages and libraries that talk to disk, network, and other processes. The source of truth.

Every one of those layers can be described in a sentence, and none of them do the others' job. A view never reaches past its controller into the model. A model never knows a view exists.

## Two paths, one boundary

Data only moves through the stack two ways: a <strong>read path</strong>, from Presentation down through a View State Controller to the Model, and a <strong>mutate path</strong>, from Presentation through an Action Controller into an Action and Validator, down to the Model. Both paths converge on the same layer and the Model closes the loop by notifying Presentation when something changes — nothing above it has to ask.

<figure class="diagram">
<svg viewBox="0 0 760 480" role="img" aria-label="Diagram of the Airframe layering: Presentation reads through a View State Controller and mutates through an Action Controller and Action, both converging on the Model, which delegates to Packages and Libraries below and notifies Presentation directly above. Brackets on the right map the boxes onto classic MVC: Presentation is the View layer; Action Controllers, View State Controllers, Actions and Validators form the Controller layer; the Model box is the Model layer.">
<defs>
<marker id="arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
<path d="M0,0 L10,5 L0,10 z" fill="currentColor"/>
</marker>
<marker id="arrAccent" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
<path d="M0,0 L10,5 L0,10 z" fill="var(--accent)"/>
</marker>
</defs>
<rect x="90" y="20" width="580" height="55" rx="8" fill="none" stroke="currentColor" stroke-width="1.6"/>
<text x="380" y="43" text-anchor="middle" font-family="var(--font-display)" font-weight="700" font-size="15">Presentation</text>
<text x="380" y="61" text-anchor="middle" font-family="var(--font-mono)" font-size="10.5" opacity="0.7">Views &amp; View Controllers · AppKit</text>
<rect x="430" y="108" width="240" height="48" rx="8" fill="none" stroke="currentColor" stroke-width="1.6"/>
<text x="550" y="130" text-anchor="middle" font-family="var(--font-display)" font-weight="700" font-size="13">Action Controller</text>
<text x="550" y="146" text-anchor="middle" font-family="var(--font-mono)" font-size="9.5" opacity="0.7">dialogs, input · AppKit</text>
<line x1="60" y1="180" x2="700" y2="180" stroke="currentColor" stroke-width="1.2" stroke-dasharray="4 5" opacity="0.6"/>
<text x="700" y="174" text-anchor="end" font-family="var(--font-mono)" font-size="10" opacity="0.65">Foundation-only below — testable without the app running</text>
<rect x="90" y="195" width="270" height="55" rx="8" fill="none" stroke="currentColor" stroke-width="1.6"/>
<text x="225" y="219" text-anchor="middle" font-family="var(--font-display)" font-weight="700" font-size="13">View State Controller</text>
<text x="225" y="236" text-anchor="middle" font-family="var(--font-mono)" font-size="9.5" opacity="0.7">shapes data for display</text>
<rect x="430" y="195" width="240" height="55" rx="8" fill="none" stroke="currentColor" stroke-width="1.6"/>
<text x="550" y="219" text-anchor="middle" font-family="var(--font-display)" font-weight="700" font-size="13">Action + Validator</text>
<text x="550" y="236" text-anchor="middle" font-family="var(--font-mono)" font-size="9.5" opacity="0.7">executes, checks preconditions</text>
<rect x="90" y="298" width="580" height="55" rx="8" fill="none" stroke="currentColor" stroke-width="1.6"/>
<text x="380" y="321" text-anchor="middle" font-family="var(--font-display)" font-weight="700" font-size="15">Model</text>
<text x="380" y="339" text-anchor="middle" font-family="var(--font-mono)" font-size="10.5" opacity="0.7">domain state · source of truth</text>
<rect x="90" y="400" width="580" height="50" rx="8" fill="none" stroke="currentColor" stroke-width="1.6"/>
<text x="380" y="429" text-anchor="middle" font-family="var(--font-display)" font-weight="700" font-size="13">Packages &amp; Libraries</text>
<line x1="210" y1="75" x2="210" y2="193" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
<text x="218" y="98" font-family="var(--font-mono)" font-size="10.5">reads</text>
<line x1="550" y1="75" x2="550" y2="106" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
<text x="558" y="94" font-family="var(--font-mono)" font-size="10.5">mutates</text>
<line x1="550" y1="156" x2="550" y2="193" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
<text x="558" y="177" font-family="var(--font-mono)" font-size="10.5">dispatches</text>
<line x1="225" y1="250" x2="225" y2="296" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
<text x="233" y="278" font-family="var(--font-mono)" font-size="10.5">loads</text>
<line x1="550" y1="250" x2="550" y2="296" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
<text x="558" y="278" font-family="var(--font-mono)" font-size="10.5">writes</text>
<line x1="380" y1="353" x2="380" y2="398" stroke="currentColor" stroke-width="1.5" marker-end="url(#arr)"/>
<text x="388" y="380" font-family="var(--font-mono)" font-size="10.5">delegates</text>
<path d="M90,317 C38,317 38,47 90,47" fill="none" stroke="var(--accent)" stroke-width="1.8" stroke-dasharray="1 6" stroke-linecap="round" marker-end="url(#arrAccent)"/>
<text x="30" y="182" transform="rotate(-90 30 182)" text-anchor="middle" font-family="var(--font-mono)" font-size="10.5" fill="var(--accent)">notifies</text>
<g opacity="0.75">
<path d="M712,22 h-6 v51 h6" fill="none" stroke="currentColor" stroke-width="1.2"/>
<text x="726" y="48" transform="rotate(-90 726 48)" text-anchor="middle" font-family="var(--font-display)" font-weight="700" font-size="12">View</text>
<path d="M712,110 h-6 v138 h6" fill="none" stroke="currentColor" stroke-width="1.2"/>
<text x="726" y="179" transform="rotate(-90 726 179)" text-anchor="middle" font-family="var(--font-display)" font-weight="700" font-size="12">Controller</text>
<path d="M712,300 h-6 v51 h6" fill="none" stroke="currentColor" stroke-width="1.2"/>
<text x="726" y="326" transform="rotate(-90 726 326)" text-anchor="middle" font-family="var(--font-display)" font-weight="700" font-size="12">Model</text>
</g>
</svg>
<figcaption>The read path and mutate path converge on the Model. The Model closes the loop itself, broadcasting a change notification straight back to Presentation — no controller above it has to ask whether something changed. The brackets on the right map Airframe's layers onto classic Cocoa MVC: view controllers sit in the View layer, and the Controller layer is everything between Presentation and the Model.</figcaption>
</figure>

<div class="rule">
<span class="rule-label">The rule</span>

Everything below the boundary line is Foundation-only: no AppKit, no UI framework, no app instance required to run its tests. Only <strong>Action Controllers</strong> and <strong>Presentation</strong> are allowed to import AppKit. If a type below the line needs something an AppKit type has, that's a sign the type belongs above the line — not a reason to import AppKit below it.

</div>

## @MainActor is the lock

Every layer above the bottom Packages layer is `@MainActor`-isolated. State lives on the main thread; background work runs on the cooperative thread pool and returns its result via `await`. There is no mutex, no concurrent data structure, no queue guarding application state — the main actor <em>is</em> the synchronization.

This is a deliberate trade against custom actors for state. An actor would make every read from UI code asynchronous, for a problem `@MainActor` already solves without paying that tax. The one hazard `@MainActor` doesn't remove on its own is re-entrancy — what happens when the same method is called again while an earlier call is still suspended at an `await`. That's a concern for <a href="/guide/07-concurrency">Chapter 7</a>; for now, the rule is simply: <strong>state reads and writes happen on the main actor, everywhere, without exception.</strong>

## Walking the loop once

Take a note-taking app as the running example for this guide. A user renames a notebook in the sidebar:

1. The sidebar view controller reads its rows through a `NotebookListStateController` — the read path.
1. The user commits an inline rename. An `Action Controller` validates the new name isn't empty, builds a `RenameNotebookAction`, and dispatches it — the mutate path begins.
1. The Action calls into the Model's write funnel, which updates the notebook's title and persists it.
1. The Model broadcasts a change notification. It does not know or care that the sidebar exists.
1. The sidebar's state controller — and any other view observing notebooks, including one that doesn't exist yet — refreshes in response.

Nothing in that list required the sidebar to know about a detail view, or the detail view to know about the sidebar. That decoupling is the entire point of routing every mutation through one layer: views can be added, removed, or rebuilt in SwiftUI without the Model layer changing at all.

<div class="seealso">
<strong>Ahead in this guide</strong>
The Model layer's write funnel is <a href="/guide/05-model-layer">Chapter 5</a>. Actions, Validators, and Action Controllers get their own treatment in <a href="/guide/06-actions-and-controllers">Chapter 6</a>. Re-entrancy and the concurrency primitives referenced above land in <a href="/guide/07-concurrency">Chapter 7</a>.
</div>
