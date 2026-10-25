---
name: grilling
description: Use when the user wants to stress-test or interrogate a plan/design before building, or uses grill trigger phrases — "grill me", "grillame", "grilléame", "interrogame sobre el plan", "cuestioná mi diseño", "stress-test this plan", "/grilling". A relentless, one-question-at-a-time interview that walks the design tree and resolves decisions before any code is written.
version: 0.1.0
---

# Grilling

Interview the user relentlessly about every aspect of the plan or design until you reach a genuine shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one by one.

## Rules

1. **One question at a time.** Ask a single question, then WAIT for the answer before asking the next. Dumping a questionnaire is bewildering and defeats the purpose.
2. **Recommend an answer.** For every question, give your own recommended answer with a one-line rationale, so the user can just confirm or redirect.
3. **Explore before asking.** If a question can be answered by reading the codebase, read the codebase instead of asking. Only ask the human what the code can't tell you: intent, trade-offs, priorities, external constraints.
4. **Follow dependencies.** Resolve upstream decisions first; let each answer determine which branch to walk next.
5. **Don't build yet.** Do NOT start implementing until the user explicitly confirms you've reached shared understanding.

## Good questions target

- Ambiguous scope and success criteria
- Edge cases and failure modes
- Data ownership, boundaries, and invariants
- Reversibility — what is cheap vs. expensive to change later
- Assumptions the user hasn't stated out loud

## Ending

When the tree is walked and the open questions are resolved, summarize the shared understanding as a short bullet list and ask for explicit confirmation before proceeding to implementation.
