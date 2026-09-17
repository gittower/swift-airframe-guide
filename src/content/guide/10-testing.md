---
title: "Testing"
description: "Not everything earns a test, and the tests that do earn their place are read top to bottom in one file. This closing chapter introduces the guide's testing discipline — why it tests at all, which tests it writes, how a suite is laid out, how test data is built, how a test class is shaped, and how each layer of the architecture is exercised — and lays out how the six subchapters relate before each goes deeper."
order: 10
---

Not everything earns a test, and the tests that do earn their place are read top to bottom in one file. This closing chapter introduces the guide's testing discipline — why it tests at all, which tests it writes, how a suite is laid out, how test data is built, how a test class is shaped, and how each layer of the architecture is exercised — and lays out how the six subchapters relate before each goes deeper.

## Why test at all

Testing is essential, and it's hard to get right. It takes real practice — nobody writes great tests from day one, and that's fine. What matters is building the habit and improving over time. Five reasons make it worth the effort, and the first is the one people underestimate most:

- **Development speed.** For logic-heavy code, developing through tests is faster than the build-run-verify loop. Consider the full cycle of checking a sync edge case by hand: build the app, launch it, navigate to the right notebook, put it in the right state, trigger the sync, verify the result, reset everything to try the next case. A test does all of that in seconds, and complex scenarios you'd never bother setting up manually actually get tested. Tests are a speed multiplier, not a tax.
- **Confidence to change things.** A good suite means you can refactor, extend, and fix without fear of breaking something else. In a long-running project this is the single biggest benefit.
- **Faster feedback.** If you find yourself launching the whole application to verify a change, that's the signal to write a test instead.
- **Bug prevention.** Reproducing a bug in a test first guarantees it's fixed and prevents regression. The test becomes a permanent safeguard.
- **Better design.** Writing tests before or alongside the code pushes you toward smaller, more modular types. If you can't test something, that's usually a sign the code needs restructuring — extracting the logic into its own type makes it testable and improves the architecture at the same time.

Not all code carries equal risk, so effort goes where bugs would hurt most. Critical errors cluster almost exclusively in the lower, Foundation-only layers — the manager, the model, the parser, the validator — which are also the easiest layers to test. A pragmatic suite over that logic catches the vast majority of critical errors; the AppKit-touching layers above it are covered by testing what they coordinate, never by testing them directly.

## The shape of the chapter

A test earns its place only if it can fail for a reason you care about. <a href="/guide/10-1-which-tests-to-write">Which Tests to Write</a> covers that judgment — the value question, the rules that keep a test from being a change detector, the layer table that says which of the architecture's types get tests at all, and the one place a test double is allowed.

Most testing happens in two contexts: fixing a bug and building a feature. <a href="/guide/10-2-testing-workflows">Testing Workflows</a> covers the discipline for each, worked through as a sync bug and an archive feature in the notebook app, and the habit of investing in test infrastructure the moment a scenario is hard to set up.

A test target has a fixed shape, and a test is one of four kinds. <a href="/guide/10-3-suite-layout-and-test-kinds">Suite Layout and Test Kinds</a> covers the module-named mirror, the three infrastructure folders, the precise meaning of fixture, factory and builder, and the live, performance and contract suites that don't run on every `Cmd+U`.

Test data is built, not loaded. <a href="/guide/10-4-factories-builders-and-fixtures">Factories, Builders and Fixtures</a> covers the two factory shapes and why there's no third, the defaults a factory carries, payload builders that produce the wire shape, the narrow case where a fixture file is right, and the rule of two that decides when a private helper becomes a shared one.

Inside a class, every test builds its own state and reads in one place. <a href="/guide/10-5-inside-a-test-class">Inside a Test Class</a> covers that — no shared setup, what a private helper may hide, assertions as free functions, the one allowed base class, naming, grouping tests by what they prove, and where a behavior is tested once and merely pinned everywhere else.

Finally, each layer of the architecture has a way it gets exercised. <a href="/guide/10-6-testing-each-layer">Testing Each Layer</a> works through the notebook app layer by layer: a manager through its public method with the network stubbed underneath, a multi-step Action, a validator, a View State Controller, async and error paths, and background jobs with progress.

## The rule that holds across all six

<div class="rule">
<span class="rule-label">The rule</span>

A test is read top to bottom, in one file, and the reader knows what state it starts from, what it does, and what it proves. Opening one factory to check its doc comment is acceptable. Opening five setup methods to reconstruct the state is the failure mode every rule in this chapter is written against — such a test is also brittle, because nobody can change a setup method without knowing every test it feeds, so tests become hard to add and hard to change.

</div>

## Four things this guide considers myths

Each of these sounds like discipline and produces the opposite.

- **100 % test coverage.** Anything short of it has no meaning, and reaching it forces tests over code that cannot plausibly break — `notebook.add(note); XCTAssertTrue(notebook.contains(note))`. It produces low-value tests that slow the team down and make refactoring harder.
- **One assertion per test.** What the advice actually means is that one input should have one expected outcome. A pulled notebook checked for count, titles and sync timestamps in one test is the readable form; one test per property is the workaround for a framework that stops at the first failure.
- **Mock every dependency.** That tests the object graph's wiring, not its behavior, and couples every test to the implementation. A real collaborator fails the test when it misbehaves; a mock passes it.
- **Test every class in isolation so a failure points at one class.** A test that exercises a component top to bottom fails when anything in between misbehaves, and that is exactly the property you want.

<div class="seealso">
<strong>Ahead in this chapter</strong>
The judgment that decides whether a test gets written at all is first: <a href="/guide/10-1-which-tests-to-write">Chapter 10.1, Which Tests to Write</a>.
</div>
