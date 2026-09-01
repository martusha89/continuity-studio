# Continuity Studio — roadmap

Nothing in this document is implemented unless it is also described in `architecture.md`.

## Import profiles

Keep the generic flat-JSON mapper free of source-specific semantics. Add named, inspectable profiles for known exports only when they improve safety or reduce mapping work. Customer-specific schemas belong in private mapping recipes, not the product ontology.

## Interviewer-led setup

A future interviewer agent may help someone reach the same reviewed memory-file set through conversation rather than a form. It must still stop at the same explicit review and creation boundary; conversational fluency is not permission to hide generated memory.

## Authentication beyond entered API keys

The browser-capable Agent SDK supports Cloud clients with user-provided keys, but official guidance recommends short-lived user-scoped credentials rather than embedding an organization-wide key. Any future replacement for the current user-entered-key flow needs an approved credential-issuing pattern first.
