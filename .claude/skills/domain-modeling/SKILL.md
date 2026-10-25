---
name: domain-modeling
description: Actively build and maintain the project's ubiquitous language while designing. Challenge fuzzy terms, resolve naming conflicts against CONTEXT.md, stress-test with scenarios, validate against code, and capture resolved vocabulary in CONTEXT.md plus real trade-offs in docs/adr/. Use during any design or planning discussion, and alongside the grilling skill.
version: 0.1.0
---

# Domain Modeling

Actively construct and refine the project's domain model — the shared vocabulary and conceptual boundaries that frame how the team thinks about the problem — *during* design work. You are not a passive consumer of the glossary; you maintain it as the conversation happens.

## During the conversation

- **Challenge terminology conflicts.** If the user uses a term that diverges from `CONTEXT.md`, surface the inconsistency immediately.
- **Sharpen vague language.** When a word is overloaded (e.g. "account" meaning Customer or User), propose a precise canonical term and then use it consistently.
- **Stress-test with scenarios.** Invent concrete edge cases that expose fuzzy boundaries between concepts and force specificity about domain rules.
- **Validate against code.** Cross-reference stated behavior with the actual implementation. If someone says "partial cancellation is possible" but the code only cancels whole orders, surface the gap.
- **Capture inline, not batched.** As a term resolves, write it to `CONTEXT.md` right then. Keep that file pure vocabulary — no implementation details.

## Files (create only when needed — no premature scaffolding)

- **`/CONTEXT.md`** — the glossary of canonical terms and their definitions. The single source of truth for vocabulary.
- **`/docs/adr/NNNN-title.md`** — Architecture Decision Records.
- **`/CONTEXT-MAP.md`** — only for multi-context repos: points to a nested `CONTEXT.md` inside each bounded-context folder, with context-specific ADRs housed locally.

## When to write an ADR

Only when ALL THREE conditions hold:

1. The decision is **hard to reverse** (meaningful reversal cost).
2. The rationale is **surprising** — not obvious to a future reader without context.
3. It was chosen among **genuine alternatives** with real trade-offs.

This keeps ADRs rare and valuable instead of bloating the docs with obvious choices.

### ADR template

```markdown
# NNNN. <Title>

- Date: <YYYY-MM-DD>
- Status: Accepted

## Context
<forces at play, the problem, the constraints>

## Decision
<what we chose>

## Consequences
<trade-offs accepted, what becomes easier or harder, what we ruled out>
```
