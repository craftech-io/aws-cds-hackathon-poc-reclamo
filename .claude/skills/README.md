# Project skills

Copied here so they travel with the repository. They are also installed at user level in
`~/.claude/skills/`. They predate this repository and are declared in the root README as
pre-existing scaffolding: process tooling, not product code.

| Skill | Purpose | Used by |
|---|---|---|
| `grill-with-docs` | One-question-at-a-time interrogation that also produces CONTEXT.md and ADRs. | `pm`, on every new request or ambiguous decision. |
| `grilling` | The interrogation alone, without documentation. | `pm`, when the answer will not change the glossary or an ADR. |
| `domain-modeling` | Maintains the glossary and the ADRs. Ships `ADR-FORMAT.md` and `CONTEXT-FORMAT.md`. | `architect` to write CONTEXT.md and ADRs; `seed-generator` to name every table, field and enum of the seed with the vocabulary of CONTEXT.md. |

Source: https://github.com/mattpocock/skills (`skills/engineering/` and `skills/productivity/`),
MIT License; the upstream notice ships as [LICENSE-mattpocock-skills](LICENSE-mattpocock-skills).

The `grill-with-docs` version used here is expanded: it works standalone, without requiring
`grilling` and `domain-modeling` to be installed, and carries Spanish trigger phrases. The
upstream original is a seven-line dispatcher that calls the other two.
