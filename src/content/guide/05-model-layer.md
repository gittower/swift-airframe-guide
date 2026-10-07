---
title: "The Model Layer"
description: "The Model is the source of truth, and it stays trustworthy because of one rule applied without exception: every mutation, from every source, funnels through a single manager. This chapter shows how the pieces that make that funnel work fit together — the model and its queries, the environment that owns a domain's shared resources, the manager, the jobs it enqueues, the runner that orders them and the activities that report their progress — then nine subchapters go deeper on each."
order: 5
---

The Model is the source of truth, and it stays trustworthy because of one rule applied without exception: every mutation, from every source, funnels through a single manager. This chapter shows how the pieces that make that funnel work fit together — the model and its queries, the environment that owns a domain's shared resources, the manager, the jobs it enqueues, the runner that orders them and the activities that report their progress — then nine subchapters go deeper on each.

## The underlying principle

Views read from the Model. They never write to it directly — every write, whether it originates from a button click, a background sync or an automated pipeline, converges on the same manager before it touches state. That convergence is what makes the rest of the architecture possible: it does not matter <em>where</em> a change came from, because ordering, validation, persistence and notification all have exactly one place to live; and views can stay naive, reading current state and reacting to a change signal without reasoning about who else might be writing.

Everything else in this chapter is machinery in service of that one sentence. A notebook's model layer is six kinds of object, and each one exists to keep the funnel narrow while letting real work — network, disk, an assistant — happen off the main thread without ever letting that work touch state directly.

## The pieces, and who owns what

<figure class="diagram">
<svg viewBox="0 0 760 500" role="img" aria-label="Diagram of a notebook's model layer. At the top, two callers: an Action or Background Controller on the mutate path, and a View State Controller on the read path. Below the first caller, a dashed container labelled NotebookEnvironment, one per notebook, holds six boxes: NoteManager and TagManager in the first row, the Runner and NoteActivities in the second, NoteWorkContext and NoteMainContext in the third. The Action awaits a manager method; both managers enqueue onto the runner; the runner runs the job's perform against the work context and then its handlers against the main context; the main context writes progress into the activities and merges, saves and publishes into the Model box at the bottom. The View State Controller reads the Model directly through a query, bypassing the environment, and an accent-coloured arrow from the Model back up to the View State Controller is labelled notifies.">
<defs>
<marker id="arrPieces" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
<path d="M0,0 L10,5 L0,10 z" fill="currentColor"/>
</marker>
<marker id="arrPiecesAccent" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
<path d="M0,0 L10,5 L0,10 z" fill="var(--accent)"/>
</marker>
</defs>
<rect x="35" y="18" width="240" height="52" rx="8" fill="none" stroke="currentColor" stroke-width="1.6"/>
<text x="155" y="40" text-anchor="middle" font-family="var(--font-display)" font-weight="700" font-size="13">Action · Background Controller</text>
<text x="155" y="57" text-anchor="middle" font-family="var(--font-mono)" font-size="9.5" opacity="0.7">mutate path · Chapters 4 and 6</text>
<rect x="440" y="18" width="240" height="52" rx="8" fill="none" stroke="currentColor" stroke-width="1.6"/>
<text x="560" y="40" text-anchor="middle" font-family="var(--font-display)" font-weight="700" font-size="13">View State Controller</text>
<text x="560" y="57" text-anchor="middle" font-family="var(--font-mono)" font-size="9.5" opacity="0.7">read path · Chapter 7.2</text>
<rect x="50" y="104" width="420" height="290" rx="10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-dasharray="6 5" opacity="0.8"/>
<text x="458" y="121" text-anchor="end" font-family="var(--font-mono)" font-size="10" opacity="0.75">NotebookEnvironment · one per notebook</text>
<rect x="70" y="134" width="170" height="46" rx="8" fill="none" stroke="currentColor" stroke-width="1.6"/>
<text x="155" y="153" text-anchor="middle" font-family="var(--font-display)" font-weight="700" font-size="13">NoteManager</text>
<text x="155" y="169" text-anchor="middle" font-family="var(--font-mono)" font-size="9.5" opacity="0.7">public async surface</text>
<rect x="280" y="134" width="170" height="46" rx="8" fill="none" stroke="currentColor" stroke-width="1.6"/>
<text x="365" y="153" text-anchor="middle" font-family="var(--font-display)" font-weight="700" font-size="13">TagManager</text>
<text x="365" y="169" text-anchor="middle" font-family="var(--font-mono)" font-size="9.5" opacity="0.7">same runner, same contexts</text>
<rect x="70" y="214" width="170" height="46" rx="8" fill="none" stroke="currentColor" stroke-width="1.6"/>
<text x="155" y="233" text-anchor="middle" font-family="var(--font-display)" font-weight="700" font-size="13">Runner</text>
<text x="155" y="249" text-anchor="middle" font-family="var(--font-mono)" font-size="9.5" opacity="0.7">orders conflicting jobs</text>
<rect x="280" y="214" width="170" height="46" rx="8" fill="none" stroke="currentColor" stroke-width="1.6"/>
<text x="365" y="233" text-anchor="middle" font-family="var(--font-display)" font-weight="700" font-size="13">NoteActivities</text>
<text x="365" y="249" text-anchor="middle" font-family="var(--font-mono)" font-size="9.5" opacity="0.7">progress · @Observable</text>
<rect x="70" y="294" width="170" height="46" rx="8" fill="none" stroke="currentColor" stroke-width="1.6"/>
<text x="155" y="313" text-anchor="middle" font-family="var(--font-display)" font-weight="700" font-size="13">NoteWorkContext</text>
<text x="155" y="329" text-anchor="middle" font-family="var(--font-mono)" font-size="9.5" opacity="0.7">Sendable · seen by perform()</text>
<rect x="280" y="294" width="170" height="46" rx="8" fill="none" stroke="currentColor" stroke-width="1.6"/>
<text x="365" y="313" text-anchor="middle" font-family="var(--font-display)" font-weight="700" font-size="13">NoteMainContext</text>
<text x="365" y="329" text-anchor="middle" font-family="var(--font-mono)" font-size="9.5" opacity="0.7">@MainActor · seen by handlers</text>
<text x="155" y="362" text-anchor="middle" font-family="var(--font-mono)" font-size="10" opacity="0.65">built once in init</text>
<text x="155" y="376" text-anchor="middle" font-family="var(--font-mono)" font-size="10" opacity="0.65">registry in an extension</text>
<text x="155" y="390" text-anchor="middle" font-family="var(--font-mono)" font-size="10" opacity="0.65">tests build their own</text>
<rect x="50" y="424" width="630" height="54" rx="8" fill="none" stroke="currentColor" stroke-width="1.6"/>
<text x="365" y="446" text-anchor="middle" font-family="var(--font-display)" font-weight="700" font-size="15">Model</text>
<text x="365" y="464" text-anchor="middle" font-family="var(--font-mono)" font-size="10.5" opacity="0.7">Notebook · Note · NoteStore · Note+Queries · source of truth, not @Observable</text>
<line x1="155" y1="70" x2="155" y2="132" stroke="currentColor" stroke-width="1.5" marker-end="url(#arrPieces)"/>
<text x="163" y="98" font-family="var(--font-mono)" font-size="10.5">await pull()</text>
<line x1="155" y1="180" x2="155" y2="212" stroke="currentColor" stroke-width="1.5" marker-end="url(#arrPieces)"/>
<text x="147" y="200" text-anchor="end" font-family="var(--font-mono)" font-size="10.5">enqueue(job)</text>
<polyline points="365,180 365,196 190,196 190,212" fill="none" stroke="currentColor" stroke-width="1.5" marker-end="url(#arrPieces)"/>
<line x1="155" y1="260" x2="155" y2="292" stroke="currentColor" stroke-width="1.5" marker-end="url(#arrPieces)"/>
<text x="147" y="280" text-anchor="end" font-family="var(--font-mono)" font-size="10.5">runs the job</text>
<line x1="240" y1="317" x2="278" y2="317" stroke="currentColor" stroke-width="1.5" marker-end="url(#arrPieces)"/>
<text x="259" y="309" text-anchor="middle" font-family="var(--font-mono)" font-size="9.5">then</text>
<line x1="365" y1="292" x2="365" y2="262" stroke="currentColor" stroke-width="1.5" marker-end="url(#arrPieces)"/>
<text x="357" y="281" text-anchor="end" font-family="var(--font-mono)" font-size="10.5">progress · settle</text>
<line x1="365" y1="340" x2="365" y2="422" stroke="currentColor" stroke-width="1.5" marker-end="url(#arrPieces)"/>
<text x="373" y="410" font-family="var(--font-mono)" font-size="10.5">merge · save · publish</text>
<line x1="560" y1="70" x2="560" y2="422" stroke="currentColor" stroke-width="1.5" marker-end="url(#arrPieces)"/>
<text x="568" y="238" font-family="var(--font-mono)" font-size="10.5">Note.all(in: notebook)</text>
<text x="568" y="254" font-family="var(--font-mono)" font-size="10.5" opacity="0.7">a query, never the manager</text>
<path d="M680,451 C736,451 736,44 680,44" fill="none" stroke="var(--accent)" stroke-width="1.8" stroke-dasharray="1 6" stroke-linecap="round" marker-end="url(#arrPiecesAccent)"/>
<text x="748" y="247" transform="rotate(-90 748 247)" text-anchor="middle" font-family="var(--font-mono)" font-size="10.5" fill="var(--accent)">notifies</text>
</svg>
<figcaption>Everything a notebook's managers and jobs share lives in one environment: the runner that orders their work, the two contexts a job sees on either side of the actor boundary, and the activities that hold progress. Callers on the mutate path reach a manager; the manager hands a job to the runner; the job's handlers write through the main context into the Model. Callers on the read path never enter the environment at all — they query the Model directly, and the Model tells them when to look again.</figcaption>
</figure>

Each piece has one job, and one subchapter:

- <strong>The model</strong> — `Note`, the `NoteStore` behind it, the queries in front of it. Plain data that is read through static queries and never written by anyone but the manager. It signals change with a notification, not by being `@Observable`. <a href="/guide/05-1-the-model">Chapter 5.1</a>.
- <strong>The environment</strong> — `NotebookEnvironment`, one per notebook. It owns the runner, the store, the activities and the two job contexts, builds the managers and keeps them. It provides and never performs, and nothing outside the model package ever names it: callers see only `NoteManager.shared(for:)`. <a href="/guide/05-2-the-environment">Chapter 5.2</a>.
- <strong>The manager</strong> — `NoteManager`, `TagManager`. The entry point for one group of operations: every public method is plain `async`, and every one is a single line that enqueues a job and awaits it. It owns nothing but its environment, and never calls another manager. <a href="/guide/05-3-the-manager">Chapter 5.3</a>.
- <strong>Jobs and contexts</strong> — `PullNotesJob`, `RenameNoteJob`. One struct per operation, its intent frozen at submission. `perform` runs off the main actor and sees only the `Sendable` work context; the handlers run on the main actor and see only the main context. The job settles its own result. <a href="/guide/05-4-jobs-and-contexts">Chapter 5.4</a>.
- <strong>The runner</strong> — `SerialTaskRunner`, or `GroupedTaskRunner` once reads should overlap. It closes the gap `@MainActor` leaves open across an `await`: a job's whole lifecycle, handlers included, finishes before a conflicting job starts. <a href="/guide/05-5-runners-and-scheduling">Chapter 5.5</a>.
- <strong>Activities</strong> — `NoteActivities`, `SyncActivity`, `DraftActivity`. The live state of one kind of operation, `@Observable` because only a job's main-actor handlers ever write it, read by whichever screens care. <a href="/guide/05-6-progress-and-activities">Chapter 5.6</a>.

## One write, end to end

<figure class="diagram">
<svg viewBox="0 0 760 420" role="img" aria-label="Sequence diagram of one pull. Two lanes separated by a dashed actor boundary: the main actor above, the cooperative thread pool below. Step 1, a caller awaits pull(). Step 2, NoteManager enqueues a PullNotesJob and returns a Task the caller suspends on. Step 3, below the boundary, the runner waits its turn. Step 4, the job's perform fetches with the work context only. Step 5, back above the boundary, handleProgress writes the pull activity, which any screen observes. Step 6, finalize merges, saves and publishes, after which step 7, Presentation re-reads the model through a query. A return arrow shows pull() returning to the caller only after the handler has finished.">
<defs>
<marker id="arrFlow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
<path d="M0,0 L10,5 L0,10 z" fill="currentColor"/>
</marker>
<marker id="arrFlowAccent" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
<path d="M0,0 L10,5 L0,10 z" fill="var(--accent)"/>
</marker>
</defs>
<text x="16" y="120" transform="rotate(-90 16 120)" text-anchor="middle" font-family="var(--font-mono)" font-size="10" opacity="0.65">MAIN ACTOR</text>
<text x="16" y="330" transform="rotate(-90 16 330)" text-anchor="middle" font-family="var(--font-mono)" font-size="10" opacity="0.65">THREAD POOL</text>
<line x1="34" y1="225" x2="750" y2="225" stroke="currentColor" stroke-width="1.2" stroke-dasharray="4 5" opacity="0.6"/>
<text x="40" y="218" font-family="var(--font-mono)" font-size="10" opacity="0.65">the await is the boundary</text>
<rect x="34" y="40" width="120" height="50" rx="8" fill="none" stroke="currentColor" stroke-width="1.6"/>
<text x="94" y="61" text-anchor="middle" font-family="var(--font-display)" font-weight="700" font-size="13">1 · Caller</text>
<text x="94" y="78" text-anchor="middle" font-family="var(--font-mono)" font-size="9.5" opacity="0.7">await pull()</text>
<rect x="180" y="40" width="150" height="50" rx="8" fill="none" stroke="currentColor" stroke-width="1.6"/>
<text x="255" y="61" text-anchor="middle" font-family="var(--font-display)" font-weight="700" font-size="13">2 · NoteManager</text>
<text x="255" y="78" text-anchor="middle" font-family="var(--font-mono)" font-size="9.5" opacity="0.7">enqueue(PullNotesJob)</text>
<rect x="390" y="40" width="160" height="50" rx="8" fill="none" stroke="currentColor" stroke-width="1.6"/>
<text x="470" y="61" text-anchor="middle" font-family="var(--font-display)" font-weight="700" font-size="13">NoteActivities.pull</text>
<text x="470" y="78" text-anchor="middle" font-family="var(--font-mono)" font-size="9.5" opacity="0.7">any screen observes it</text>
<rect x="580" y="40" width="160" height="50" rx="8" fill="none" stroke="currentColor" stroke-width="1.6"/>
<text x="660" y="61" text-anchor="middle" font-family="var(--font-display)" font-weight="700" font-size="13">7 · Presentation</text>
<text x="660" y="78" text-anchor="middle" font-family="var(--font-mono)" font-size="9.5" opacity="0.7">re-reads Note.all(in:)</text>
<rect x="390" y="140" width="160" height="50" rx="8" fill="none" stroke="currentColor" stroke-width="1.6"/>
<text x="470" y="161" text-anchor="middle" font-family="var(--font-display)" font-weight="700" font-size="13">5 · handleProgress</text>
<text x="470" y="178" text-anchor="middle" font-family="var(--font-mono)" font-size="9.5" opacity="0.7">writes the activity</text>
<rect x="580" y="140" width="160" height="50" rx="8" fill="none" stroke="currentColor" stroke-width="1.6"/>
<text x="660" y="161" text-anchor="middle" font-family="var(--font-display)" font-weight="700" font-size="13">6 · finalize</text>
<text x="660" y="178" text-anchor="middle" font-family="var(--font-mono)" font-size="9.5" opacity="0.7">merge · save · publish</text>
<rect x="180" y="280" width="150" height="50" rx="8" fill="none" stroke="currentColor" stroke-width="1.6"/>
<text x="255" y="301" text-anchor="middle" font-family="var(--font-display)" font-weight="700" font-size="13">3 · Runner</text>
<text x="255" y="318" text-anchor="middle" font-family="var(--font-mono)" font-size="9.5" opacity="0.7">waits its turn</text>
<rect x="390" y="280" width="160" height="50" rx="8" fill="none" stroke="currentColor" stroke-width="1.6"/>
<text x="470" y="301" text-anchor="middle" font-family="var(--font-display)" font-weight="700" font-size="13">4 · perform(context:)</text>
<text x="470" y="318" text-anchor="middle" font-family="var(--font-mono)" font-size="9.5" opacity="0.7">fetch · work context only</text>
<line x1="154" y1="65" x2="178" y2="65" stroke="currentColor" stroke-width="1.5" marker-end="url(#arrFlow)"/>
<line x1="255" y1="90" x2="255" y2="278" stroke="currentColor" stroke-width="1.5" marker-end="url(#arrFlow)"/>
<text x="263" y="118" font-family="var(--font-mono)" font-size="10.5">returns a Task</text>
<text x="263" y="206" font-family="var(--font-mono)" font-size="10.5">the caller suspends on it</text>
<line x1="330" y1="305" x2="388" y2="305" stroke="currentColor" stroke-width="1.5" marker-end="url(#arrFlow)"/>
<text x="359" y="298" text-anchor="middle" font-family="var(--font-mono)" font-size="9.5">its turn</text>
<line x1="470" y1="280" x2="470" y2="192" stroke="currentColor" stroke-width="1.5" marker-end="url(#arrFlow)"/>
<text x="478" y="240" font-family="var(--font-mono)" font-size="10.5">progress · in order</text>
<line x1="470" y1="140" x2="470" y2="92" stroke="currentColor" stroke-width="1.5" marker-end="url(#arrFlow)"/>
<text x="478" y="120" font-family="var(--font-mono)" font-size="10.5">begin · stage</text>
<polyline points="550,305 660,305 660,192" fill="none" stroke="currentColor" stroke-width="1.5" marker-end="url(#arrFlow)"/>
<text x="668" y="250" font-family="var(--font-mono)" font-size="10.5">result</text>
<line x1="660" y1="140" x2="660" y2="92" stroke="var(--accent)" stroke-width="1.8" stroke-dasharray="1 6" stroke-linecap="round" marker-end="url(#arrFlowAccent)"/>
<text x="652" y="120" text-anchor="end" font-family="var(--font-mono)" font-size="10.5" fill="var(--accent)">notesDidChange</text>
<path d="M740,165 L752,165 L752,22 L94,22 L94,38" fill="none" stroke="currentColor" stroke-width="1.5" marker-end="url(#arrFlow)"/>
<text x="423" y="16" text-anchor="middle" font-family="var(--font-mono)" font-size="10.5">pull() returns only after the handler has finished</text>
</svg>
<figcaption>One pull, start to finish. The caller's <code>await</code> is the only thing waiting; the queue underneath is invisible from outside the manager. The job performs on the thread pool against the work context, every progress event and the result come back to the main actor against the main context, and the store's merge and the notification happen there — before the runner lets the next conflicting job start, and before the caller's call returns.</figcaption>
</figure>

What happens, step by step, when a caller does `try await NoteManager.shared(for: notebook).pull()`:

1. `shared(for:)` finds the notebook's environment in the registry, or builds it on first use, and returns its manager.
1. `pull` builds a `PullNotesJob` and hands it to `enqueue`, which reads the two contexts off the environment and returns immediately with a `Task`. The manager's bridge then suspends on that task, forwarding the caller's cancellation to it. The caller's own `await` is the one thing waiting.
1. The runner schedules the job behind whatever else is already queued for this notebook, so a pull and a save on the same notebook never interleave.
1. The job's `perform` runs on the cooperative thread pool with the work context, fetches from the network, and returns its result. It cannot reach the store, an activity or a manager — the work context does not carry them.
1. Each progress event the worker reported reaches `handleProgress` on the main actor, in order, and lands in the pull activity any screen may be observing.
1. `finalize` runs on the main actor with the main context: it merges the notes through the store, the database's own change tracking merges that save onto the main context, and the handler posts the change notification — only after the save succeeded.
1. Presentation, still on the read path from <a href="/guide/01-getting-started">Chapter 1</a>, re-reads through `Note.all(in:)` without knowing a sync ever happened. The runner releases the job, the next conflicting job may start, and `pull()` returns.

## Choosing a shape

Not every piece of state needs all of that. The notebook's `Note` does, because something outside the app owns it. Most of the other state in a real app is lighter, and <a href="/guide/05-7-model-shapes">Chapter 5.7</a> works each shape through with a liftable example:

<div class="table-wrap">
<table>
<thead><tr><th>Shape</th><th>Example</th><th>Needs</th></tr></thead>
<tbody>
<tr><td><strong>Synced, database-backed</strong></td><td><code>Note</code></td><td>Everything in 5.2–5.6</td></tr>
<tr><td><strong>Persisted, main-thread only</strong></td><td><code>NoteTemplate</code></td><td>A store and a synchronous manager — no job, no runner</td></tr>
<tr><td><strong>File-backed, mixed writers</strong></td><td><code>Suggestion</code></td><td>The environment's runner for its persist and pipeline jobs</td></tr>
<tr><td><strong>In-memory, replaced wholesale</strong></td><td><code>TagIndex</code></td><td>One load job and one apply method</td></tr>
<tr><td><strong>Preference-backed settings</strong></td><td><code>EditorSettings</code></td><td>Nothing — the object is its own manager</td></tr>
<tr><td><strong>In-memory app state</strong></td><td><code>AppState</code></td><td>Nothing — the object is its own manager</td></tr>
</tbody>
</table>
</div>

## The shape of the chapter

The first six subchapters build the heavy shape one object at a time, in the order the diagram above reads. <a href="/guide/05-1-the-model">The Model</a> covers plain data, the store behind it, the queries in front of it, who may write it, value versus reference entities, and the six cases for signalling change. <a href="/guide/05-2-the-environment">The Environment</a> covers the root object that owns a notebook's shared resources and that no caller ever sees, its registry, and how a test builds one of its own. <a href="/guide/05-3-the-manager">The Manager</a> covers the one shape every public method takes, the private plumbing under it, and the rule that managers never call each other. <a href="/guide/05-4-jobs-and-contexts">Jobs and Contexts</a> covers the job struct, why its two contexts are two types, a complete job, and the three things a job can do with its result. <a href="/guide/05-5-runners-and-scheduling">Runners and Scheduling</a> covers the serial runner in full, the grouped runner, group and access declarations, and deleting something with work in flight. <a href="/guide/05-6-progress-and-activities">Progress and Activities</a> covers typed progress events, streaming output, and giving one screen its own activity instead of a callback.

The last three apply all of it. <a href="/guide/05-7-model-shapes">Model Shapes</a> is the catalog above, with code for every row. <a href="/guide/05-8-execution-strategies">Execution Strategies</a> covers what "correct" means when the same operation fires twice — cancel-and-replace, serial, coalesce, gate — each worked through in the notebook app. <a href="/guide/05-9-cancellation">Cancellation</a> covers the caller's task as the one handle, what a cancelled job may leave behind, the three scopes, external processes, and how cancellation meets each strategy.

## The rules that hold across all nine

<div class="rule">
<span class="rule-label">The rules</span>

<strong>One funnel.</strong> Every mutation, from every source, goes through the model's one manager. Reads never do — they query the model directly, and the model signals change with a notification after the write lands. A model is <code>@Observable</code> only when nothing ever touches it off the main actor: settings, app state, and the activities an environment holds.

<strong>Entered on the main actor, confined off it.</strong> The model layer is always entered on the main actor. A job's intent is <code>Sendable</code> and frozen at submission; its <code>perform</code> sees only the work context; its handlers see only the main context and are the only place a result is applied, published or settled. Workers never reach back into a manager, an activity or a view.

<strong>One shape at the boundary.</strong> A manager's public methods are plain <code>async</code>, never a returned <code>Task</code>. A manager owns nothing but its environment, never calls another manager, and never does anything with a job's result. The environment provides and never performs, and is invisible to every caller of the layer.

</div>

<div class="seealso">
<strong>Ahead in this chapter</strong>
Start with what is being protected: <a href="/guide/05-1-the-model">Chapter 5.1, The Model</a>. What actually calls into a manager — and how a write earns the overhead of a full Action — is <a href="/guide/06-actions-and-controllers">Chapter 6</a>, after this one.
</div>
