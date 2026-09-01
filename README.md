# Continuity Studio V2

A source-neutral, humane onboarding and continuity layer for Letta.

This repository contains the public Continuity Studio V2 application and its source-neutral migration boundary.

The current working slice lets someone build and review an AI, a human, and their relationship before credentials interrupt the work. It turns those answers into three memory files—`system/persona.md`, `system/human.md`, and `system/relationship.md`—with reviewed descriptions and directly editable content. Agent creation uses `letta/auto` and Letta-managed runtime defaults; Continuity Studio does not capture or customize the system prompt. Letta is verified only at the explicit creation boundary, and verification creates nothing. After a reload or ambiguous creation response, an existing agent can be retrieved by ID instead of creating a duplicate; the Studio states plainly that the current draft was not applied to that agent.

After creation, the Studio can optionally guide a nontechnical user through choosing a JSON export, inspect arbitrary flat-record data, let the human review the inferred mapping, render deterministic Markdown, and import it into a read-only hosted repository attached to that agent. Raw JSON pasting remains available only as an advanced path.

GitHub is the primary place to [inspect the source](https://github.com/martusha89/continuity-studio). An optional `npm run build:source` creates `dist/downloads/continuity-studio-source.zip`, with a per-file SHA-256 manifest and an adjacent ZIP checksum; the normal production build does not require or create this archive. See `docs/ai-inspection-guide.md`. The application and API are public at runtime, while Letta operations still require the user's own Letta API key.

## Local development

```bash
npm install
npm run dev:all
```

Production uses one Hono service for the built frontend and API:

```powershell
npm run build
$env:NODE_ENV="production"
npm start
```

To create the optional source ZIP as a separate release artifact, run `npm run build:source` instead of `npm run build`.

Validation:

```bash
npm run lint
npm test
npm run typecheck:server
npm run build
npm audit
```

## Product and architecture

- [Product brief](docs/product-brief.md)
- [Current architecture](docs/architecture.md)
- [Roadmap](docs/roadmap.md)
- [AI inspection guide](docs/ai-inspection-guide.md)
- [Licensing](docs/LICENSING.md)

## Licensing

Continuity Studio source code is licensed under [Apache-2.0](LICENSE). Documentation and original non-code content are licensed under [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/). Continuity Studio and AI·DHD names and visual identities are excluded from those grants.

See [the licensing guide](docs/LICENSING.md) for scope, attribution, and brand details. Third-party materials remain under their own licences.

The Letta API key is held in the current browser tab and passes transiently through the Continuity Studio server to Letta for each requested operation; this application does not persist it. Source JSON is inspected in-browser. During import, only the reviewed rendered files pass through the server, and they are not persisted there.

The server validates every provisioning/import request and verifies that every retrieved agent ID is the exact requested target. Agent creation carries a browser-stable operation ID whose credential-bound request fingerprint becomes a Letta tag. The supported browser marks only the first reviewed attempt as creation-capable; every unchanged retry is reconcile-only, so a lost response followed by stale Letta listings produces an inspection-required error rather than another create mutation. History import uses the same first-attempt/reconcile-only contract for repository creation, plus repeated exhaustive name observations and a reviewed ownership marker. Files are written in batches of ten; the marker binds every batch to the reviewed path/size/SHA-256 manifest, and credential-bound receipts prove complete coverage before finalization. Finalization traverses and hashes the complete repository at a stable revision, attaches it with `read` permission, explicitly recompiles the agent, and verifies the relationship again before reporting success. Because an absent attachment listing cannot prove the relationship was not already present, Studio never auto-detaches after a failure that follows attachment or recompilation; it preserves the relationship and requires inspection and explicit recompilation. Interrupted imports retain their repository; retry reconciles exact matching files and refuses conflicts, unrelated repositories, extra files, or duplicate repository names rather than overwriting data. Changed agent IDs, source prefixes, and file sets receive distinct refusal messages. All browser API paths enforce JSON content types and turn non-JSON proxy failures into explicit transport errors.

The current Agent SDK's vulnerable transitive `sharp` release is overridden to patched `0.35.3`; `npm audit` is clean.
