# grill-with-docs

Conduct a rigorous, one-question-at-a-time interview to stress-test a design plan against the project's domain model and documentation.

## Core Approach

**Interview methodology**: Ask questions sequentially, waiting for feedback before advancing. Explore the codebase when applicable rather than relying on user assertions.

## Key Responsibilities

**Domain validation**: Detect terminology conflicts with `CONTEXT.md`. When user language diverges from the glossary, flag it immediately: "Your glossary defines X as A, but you seem to mean B."

**Precision sharpening**: Challenge vague or overloaded terms. Propose canonical alternatives when ambiguity exists.

**Concrete testing**: Probe domain relationships with specific scenarios to expose edge cases and force boundary clarity.

**Code-to-claim verification**: Cross-check user statements against actual code. Surface contradictions: "Your code does X, but you said Y — which is correct?"

## Documentation Updates

**Glossary management**: Update `CONTEXT.md` inline as terms resolve — don't batch updates. Keep it strictly terminological; exclude implementation details.

**ADR creation**: Only propose architecture decision records when *all three* conditions hold:
- Hard to reverse (meaningful cost to change)
- Surprising without context (future reader needs explanation)
- Result of genuine trade-offs (real alternatives existed)

## File Structure

Single-context repos: `/CONTEXT.md`, `/docs/adr/`

Multi-context repos: `/CONTEXT-MAP.md` points to bounded context locations with their own `CONTEXT.md` and `/docs/adr/` directories.

If `CONTEXT-MAP.md` exists, read it to find contexts. If only a root `CONTEXT.md` exists, single context. If neither exists, create a root `CONTEXT.md` lazily when the first term is resolved.

---

## CONTEXT.md Format

```md
# {Context Name}

{One or two sentence description of what this context is and why it exists.}

## Language

**Term**:
{A one or two sentence description of the term}
_Avoid_: SynonymA, SynonymB
```

Rules:
- **Be opinionated.** Pick the best word; list others under `_Avoid_`.
- **Keep definitions tight.** One or two sentences max. Define what it IS, not what it does.
- **Only include terms specific to this project's context.** General programming concepts don't belong.
- **Group terms under subheadings** when natural clusters emerge.

---

## ADR Format

Save to `docs/adr/NNNN-short-title.md`. Sequential numbering.

An ADR can be a single paragraph. The value is in recording *that* a decision was made and *why* — not in filling out sections.

Add Status, Considered Options, or Consequences only when they provide meaningful insight.

**Only create an ADR when all three conditions apply:**
1. Hard to reverse — changing course later carries real costs
2. Surprising without context — future readers will question the approach
3. Result of trade-offs — genuine alternatives existed and one was selected deliberately

---

## Execution

Begin by asking the user what design plan or decision they want to stress-test. Then proceed one question at a time.
