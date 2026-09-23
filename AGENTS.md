# OpenAxis SDK development

These instructions apply throughout this repository, whether checked out on its
own or as `rotatrix/openaxis/`. Paths below are relative to the OpenAxis root.

## Cross-language alignment

Python, C#, TypeScript and C++ target the same SDK capabilities and observable
behavior. When changing an SDK contract or fixing a behavioral bug, inspect the
equivalent paths in all four implementations, including synchronous and async
variants where implemented. No single implementation is automatically correct.
Use `SPEC.md` for wire contracts and shared fixtures for agreed behavior; resolve
conflicts explicitly rather than copying whichever implementation came first.

- Keep equivalent public concepts, names and responsibilities aligned: client,
  connection manager, scheduler, navigation session, adapter and query capture.
  Use idiomatic casing, types, ownership and awaitability without inventing a
  different integration model for each language.
- Match validation, accepted numeric types and identifier ranges, defaults,
  errors, ordering, cancellation, reconnect and shutdown semantics. Accidental
  coercion or a runtime's wider numeric range is not a separate language contract.
- Align observer event meanings and evidence, including query identity, context,
  failure and completion reasons, and camera/object coverage. Sync and async
  variants should differ in execution model, not arbitrarily in event payloads.
  Treat observer signatures and fields as public APIs.
- Require a concrete language, runtime or supported-host constraint to justify a
  divergence. Identify that constraint and why the common API cannot accommodate
  it. Existing code, convenience and hypothetical hosts are not sufficient.
  Prefer host adapters and schedulers over extra SDK execution paths; a host
  update loop can drain its own scheduler queue without a separate SDK polling API.
- Missing capabilities are parity gaps, not deliberate language differences.
  When work leaves a gap, report the affected languages, user-visible impact and
  follow-up in the existing compatibility reference. Do not claim parity from
  wire compatibility or passing state-machine tests alone.

Before stabilizing a release, resolve differences that would later require
tightening accepted input, changing defaults or ownership, renaming public APIs,
or changing callback payloads. Assess additive extensions separately: preserve
existing delivery semantics and account for consumers with exhaustive event
handling or explicit Python callback keyword parameters.

## Implementation and verification

Read [SDK implementation and parity](docs/src/content/docs/contributing/sdk-architecture.md)
for source boundaries, reentrancy, lifecycle and diagnostic invariants. For a
shared behavior change, update shared fixtures and run their affected language
consumers. Use coordinator and transport regressions for execution-order bugs;
test the affected demo when host integration changes. Follow
[release testing](docs/src/content/docs/contributing/release-testing.md) for commands.
Report which languages and platforms were actually checked and any remaining gaps.

Keep examples aligned in workflow and equivalent class roles. Demonstrate the
ordinary public API; do not add SDK features solely to simplify a test or demo.

## Documentation ownership

Keep current support claims in
[Compatibility and language support](docs/src/content/docs/reference/language-support.mdx)
and exact observer contracts in
[Diagnostic observer events](docs/src/content/docs/reference/diagnostic-events.md).
Link to those sources rather than maintaining another status inventory here.
Follow [Writing documentation](docs/src/content/docs/contributing/documentation.md)
for editorial rules and [docs/README.md](docs/README.md) for source and tooling guidance.
