# Continuity Studio — product brief

## Promise

**Build the person before opening the chat.**

Continuity Studio is a humane front door into Letta. A newcomer can define the AI, themselves, and the relationship or working model before credentials or chat mechanics interrupt the work. The Studio turns those answers into a readable Letta memory structure, shows exactly what will be created, and crosses into Letta only after an explicit action.

## The adoption cliff

Letta already has persistent-agent machinery: memory blocks, MemFS, system instructions, repositories, agents, and conversations. Newcomers should not need to understand that ontology before creating someone coherent. An empty chat and a list of infrastructure concepts are not onboarding.

Migration adds another trust problem. Source formats differ; privacy markers are ambiguous; imports can duplicate, omit, or misinterpret history; and a read-only repository is not protection from instruction-bearing text.

## Journey

1. Define the AI persona.
2. Define the human persona.
3. Define the relationship and decision model.
4. Review each generated `persona`, `human`, and `relationship` memory description and file body.
5. Connect Letta, verify without creating, then explicitly create the agent.
6. Optionally choose a JSON export, review every inferred mapping and privacy rule, preview provenance-labelled files, and explicitly attach a read-only repository.

## Product rules

- Draft first; credentials at the creation boundary.
- Use Letta-managed runtime defaults; do not capture or customize the system prompt.
- Put only durable, always-relevant identity and relationship material in system memory.
- Keep imported history outside system memory and label it as untrusted reference data.
- Preserve ambiguous timestamps unless the human chooses an interpretation.
- Give generic fields no hidden customer-specific meaning.
- Show network and storage boundaries accurately; never say “nothing sent” after sending something.
- Treat retries after ambiguous external failures as reconciliation problems, not harmless button presses.
- Keep generated configuration readable and exportable.

## Current release boundary

The initial deployment was validated with one real export. That is evidence and a fixture, not the product definition. Version one performs a reviewed one-time JSON import. It has no live connector, scheduled synchronization, bidirectional writes, billing, or multi-tenant administration.

## Success

A newcomer reaches a coherent, inspectable person before seeing an empty chat; understands exactly when their key, payload, and history leave the browser; and can explain what was created in Letta without learning the SDK first.
