---
title: Writing documentation
description: Rules for concise, accurate OpenAxis walkthroughs, recipes and reference pages.
---

OpenAxis documentation helps developers build correct integrations. Use these
rules when writing or reviewing a page.

## Writing rules

1. **Establish the reader's context.** Introduce the application, the problem and
   the expected outcome before referring to examples or components. State the
   prerequisites needed to follow the page.
2. **Explain concepts before wiring.** At each new section, first explain
   what its subject is and the role it plays in the integration. Then follow its
   ordinary execution path before introducing supporting mechanisms or exceptions.
   Construction order alone does not establish conceptual understanding.
   Before setup code introduces several components, give a short overview of
   their responsibilities and distinguish SDK-provided pieces from application
   and integration code. Explain how their roles relate before listing constructor
   arguments or callback registrations.
   Give this overview its own section when it introduces several parts; use generic
   roles first, then map them to concrete implementations in the walkthrough.
   Keep categories coherent: distinguish components from the activities they
   perform. Once the roles are clear, follow creation, connection and execution.
3. **Make the page's purpose clear.** A walkthrough explains an existing runnable
   example; a recipe explains a particular task; reference provides facts to look
   up; concepts explain behavior and design. Use that purpose to choose content
   and phrasing. Keep short supporting explanations beside the code they clarify.
   Match the opening paragraph to the heading's scope: introduce the subject's
   role before discussing one of its parameters or implementation details. Put
   specialized cases in recipes or reference when they interrupt the walkthrough.
   In walkthrough implementation sections, describe what the demo does in the
   present tense ("The integration creates…"). Reserve instructions for actions
   the reader performs, such as running the demo and checking its behavior.
   Choose an abstraction boundary that serves the page's purpose. Explain the
   behavior readers need at that boundary; leave underlying implementation details
   to linked source or deeper documentation unless they are necessary to follow
   the topic. Move supporting tasks to recipes or reference when they delay the
   core concepts.
4. **Keep snippets focused and traceable.** Draw excerpts from working demos or
   explicitly identified illustrative integrations. Maintain a runnable demo per implemented
   language, with recipes drawing from its source. Extract focused snippets and
   link to the complete example. Preserve enough context to understand execution
   order, including background tasks. Label pseudocode and omissions explicitly.
   Remove the enclosing indentation from every line before trimming an excerpt;
   trimming alone strips only the first line's indentation and misaligns the body.
   For a method excerpt, include only the surrounding code and explanation needed
   to understand who invokes it, what its arguments mean, and which objects exist.
   Mention thread or lifetime requirements where they affect that behavior; do not
   turn every snippet into a checklist of implementation details.
   For setup excerpts, distinguish registration from callback execution and
   startup from shutdown. A file or method location alone is not execution context.
   Keep shared headings, explanations and verification steps outside language
   selectors. Add synchronized tabs only around differing code or host details;
   every language must retain the complete workflow. State demo limitations
   explicitly rather than omitting the corresponding section.
   Link to the relevant symbol in the in-site source viewer, not a manually
   maintained line range. Simplified snippets can point to a complete method.
   Neighboring snippets with the same target share one link after the final snippet.
5. **Name ownership clearly.** Use `My…` for example-defined classes and the actual
   names for SDK types. Prefer explicit component names when a shortened term
   could refer to several things. Choose consistent terminology for each subject,
   keep equivalent example names consistent across languages, and format API
   identifiers as code. Identify source
   files through links or a source table rather than prose about literal locations.
6. **Keep explanations concise and concrete.** Introduce a term when the reader
   needs it to understand the behavior being explained. Explain its role before
   its mechanics; defining every term in source order can obscure the main idea.
   Prefer active voice and familiar words. Remove repeated framing, filler
   sections and descriptions of what something is not. Prose adds purpose,
   relationships or consequences the code alone does not explain; it does not
   merely narrate assignments or constructor arguments. State general behavior
   directly and state the conditions that affect it. Distinguish general behavior
   from example-specific choices without adding irrelevant qualifications.
7. **Verify technical claims.** Check names, defaults, capabilities and behavior
   against the current implementation. Run the affected examples and documentation
   checks. Distinguish automated coverage from behavior requiring manual application
   testing, and describe planned features as planned.
8. **Review without conversation context.** Check whether a new reader can identify
   what they are running, where the code lives, who calls it and how to try the
   behavior. Fix missing context and ambiguous ownership before adding detail.
   After a local correction, reread the whole section. A clarification should fit
   the reader's learning sequence, not become the new organizing topic merely
   because it was the latest review comment.
   Exclude discussion of how or why the document was edited. Every paragraph
   should serve the reader's task independently of the authoring conversation.

## Content ownership

Each contract, default, shared control scheme and support claim has one
authoritative location. Other pages may give a short contextual explanation and
link to it. Before adding a page, identify its distinct reader task and check
whether an existing page can own the content.

- The specification owns wire behavior; reference owns SDK contracts and defaults.
- Quickstarts include the minimal install/run path, client creation, connection
  and basic shutdown needed for a working result. Explain the component roles
  beside that result before following the integration code; do not require a
  separate concepts or lifecycle tutorial first. Small repeated setup is useful
  when it keeps a quickstart complete.
- Recipes show concrete additions and how to verify them. Concepts explain the
  mental model behind behavior; reference owns exact APIs, defaults and contracts.
  Split out a concept or reference page only when it has substantial reusable
  material. Keep the short explanation needed to follow a recipe beside its code.
- State whether a page applies to both interfaces or only Navigation. Shared
  connection, metadata and logging recipes must identify Navigation-only steps
  rather than assume every integration has a session or viewport.
- Compatibility and language support owns the current support inventory. Mention
  a limitation elsewhere only when it affects the task being explained.
- Shared demo scene and native controls live in the shared-scene README. Device
  bindings belong to Rotatrix's customizable default profiles, not the SDK or
  demo code. Identify default-profile instructions as such and point users to
  Rotatrix for their active mappings.
- Keep task-specific verification beside recipes. Maintain runnable test commands
  and coverage inventories in the relevant example README; release testing owns
  the cross-SDK release procedure. Link to these instead of copying inventories.
- Example READMEs contain run/test instructions and meaningful platform differences;
  link to shared behavior, visual guidance and walkthroughs.

Keep language-independent explanations outside synchronized language tabs. Use
`Python`, `C#`, `TypeScript` and `C++` consistently, and describe unsupported
operations explicitly. Distinguish UI recommendations from protocol requirements.

## Before publishing

- Read the page in order and remove repetition across sections.
- Read each heading with its opening paragraph: does it introduce the promised
  subject? Check that component roles precede callback details and that the
  ordinary workflow precedes edge cases.
- Check that snippets match the runnable source and explain any necessary setup.
- Check consistent terminology, indentation, specific source targets and repeated
  links. Read every language independently for the same conceptual flow.
- Build the site and check links, source downloads and rendered code blocks using
  the commands in `docs/README.md`.
- Report the checks performed and any remaining manual validation.

## SDK README scope

SDK READMEs are package entry points: keep a short description, runtime
requirements, minimal installation or embedding command, and links to the
documentation, runnable example and legal notices. Use absolute documentation
URLs so links work in package registries.

Maintain detailed setup in [SDK installation](/guide/sdk-installation/),
behavioral contracts in reference pages, and workflows in guides that draw from
runnable examples. Keep build/test and parity work in contributor documentation.
Do not copy API tutorials, defaults or feature-change notes into each README.
Verify unique claims against source before relocating them; discard obsolete
claims instead of preserving them as another reference surface.
