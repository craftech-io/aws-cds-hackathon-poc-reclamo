---
name: grill-with-docs
description: Use when the user says "grill with docs", "grill-with-docs", "/grill-with-docs", "grillame y documentá", "interrogame y armá los docs", or wants to sharpen a plan/design at the start of a project while ALSO producing living docs (a glossary + ADRs) as decisions settle. A relentless one-question-at-a-time interview that maintains CONTEXT.md and docs/adr/ inline.
version: 0.1.0
---

# Grill with Docs

A relentless interview to sharpen a plan or design that ALSO produces documentation — a glossary and ADRs — as you go. Run this at the **start of a project, when the design is still uncertain, before writing code**.

This skill runs a **grilling** session together with **domain-modeling**. If those two skills are available, lean on them; the essentials are inlined below so this works standalone.

## Part 1 — The interview (grilling)

Interview the user relentlessly, resolving the design tree one decision at a time.

- **One question at a time**, then WAIT for the answer. No questionnaires.
- For each question, give your **recommended answer** plus a one-line rationale.
- If the codebase can answer it, **read the code instead of asking**.
- Resolve dependencies first; let each answer pick the next branch.
- **Do not start building** until the user confirms shared understanding.

## Part 2 — The documentation (domain-modeling), maintained inline

As you grill, keep the domain model alive:

- **Sharpen fuzzy terms** into canonical ones; **challenge** any term that conflicts with `CONTEXT.md`.
- **Stress-test with scenarios** to expose boundary cases.
- **Validate claims against the actual code**; surface contradictions.
- As each term resolves, **write it to `/CONTEXT.md` immediately** (pure glossary — no implementation detail).
- When a decision is **hard to reverse AND surprising AND chosen among real alternatives**, capture it as an ADR in `/docs/adr/NNNN-title.md`. Otherwise don't — keep ADRs rare.

Multi-context repos: use `/CONTEXT-MAP.md` pointing to a `CONTEXT.md` per bounded context.

## Flow

1. Restate the plan in one paragraph to anchor the conversation.
2. Grill: one question at a time, recommending answers, exploring code first.
3. Whenever a term crystallizes → update `CONTEXT.md`.
4. Whenever a hard-to-reverse / surprising choice is made → write an ADR.
5. When the tree is resolved, summarize the shared understanding, list the docs you created or updated, and ask for explicit confirmation before implementing.

## Where it sits in the workflow

`grill-with-docs → to-prd → to-issues → implement → code-review`

It produces the settled vocabulary the later steps rely on, so they don't have to re-interview.
