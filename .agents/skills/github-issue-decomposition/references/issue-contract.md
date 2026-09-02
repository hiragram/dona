# Issue contract

Use these contracts to make each Issue independently reviewable without duplicating the Epic or neighboring Issues. Adapt headings to an established repository template, but preserve the information.

## Epic

An Epic must state:

- **Outcome and background:** the user-visible or operational capability that becomes true when all children finish.
- **Coherent scope:** one architecture boundary and the smallest complete vertical outcome; explicitly name adjacent outcomes that remain outside it.
- **Architecture or flow:** the durable components and handoffs needed to understand responsibility boundaries, without prematurely specifying every implementation detail.
- **Non-goals:** attractive adjacent work, broader platforms, or unsafe shortcuts that would blur completion.
- **Native sub-issue inventory:** proposed and reused children, with each child's distinct responsibility.
- **Minimal native dependency graph:** `blocker -> blocked` edges and a short technical reason for every edge.
- **Parallel lanes:** which units can start together and which concrete artifacts join them.
- **Completion contract:** end-to-end behavior, release or operational readiness, security invariants, and evidence required before the Epic is done.
- **Existing-Issue boundaries:** related work that is reused, remains under another parent, or must not be duplicated.

Phases may explain rollout, but they must not define the dependency graph by themselves.

## Implementation sub-issue

Each implementation child must include:

- **Background / scope:** one responsibility and why it exists.
- **Candidate components or files:** likely ownership surfaces, clearly marked as candidates rather than an exhaustive change list.
- **Acceptance criteria:** observable behavior and durable state, including failure behavior where relevant.
- **Required tests:** concrete contract, integration, migration, concurrency, fault, or end-to-end evidence proportionate to the risk. Do not accept “tests pass” as the whole test plan.
- **Security and operational invariants:** authentication, authorization, isolation, secret handling, idempotency, ambiguity, restart, observability, or recovery rules that this unit must preserve. Omit categories that truly do not apply rather than adding generic boilerplate.
- **Non-goals:** responsibilities intentionally left to siblings or existing Issues.
- **Existing-Issue boundary:** reused primitives and the exact behavior this Issue must not reimplement or take over.
- **Dependency / parallelism:** direct technical prerequisites, what artifact each supplies, and sibling work that can proceed concurrently.

Acceptance criteria should make the Issue reviewable by itself. If most criteria require a sibling's branch or cannot be demonstrated until an unrelated phase finishes, reconsider the split.

## Decision/ADR issue

Use a Decision/ADR child when an unresolved choice changes multiple downstream contracts. It must contain:

- the decision questions and affected consumers;
- constraints, threat or failure model, and facts already established;
- viable alternatives, selection criteria, migration or reversal cost, and required decision record;
- acceptance criteria requiring an explicit decision, rationale, rejected alternatives, and downstream update checklist;
- examples or fixtures that downstream tests can consume where useful;
- direct dependency edges only to consumers that genuinely cannot finish without the decision.

Do not create an ADR for ordinary implementation discovery, a task that merely needs investigation, or a choice already fixed by repository policy.

## Responsibility and overlap checks

Before approving the draft, answer all of the following:

1. Can each child be reviewed and tested without silently completing another child's main responsibility?
2. Does every required end-to-end behavior have an owning Issue and a final integration/release gate?
3. Are common primitives reused rather than copied, with a named owner for shared schema or migration work?
4. Are security and ambiguous-write invariants owned at every boundary that can violate them?
5. Are related existing Issues preserved under their current parent unless reparenting was explicitly requested?
6. Can the stated parallel lanes actually proceed without depending on an unstated decision, schema, or API?
7. Is every dependency justified by a concrete artifact rather than chronology or preference?
