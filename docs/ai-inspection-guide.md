# Continuity Studio — AI inspection guide

Inspect the source on [GitHub](https://github.com/martusha89/continuity-studio) first. A source ZIP is an optional local release artifact for offline inspection or checksum-based comparison, not the primary source view and not a runtime requirement.

## What to inspect first

1. `src/App.tsx` — browser state, Letta-key entry, onboarding, review, and explicit creation/import actions.
2. `server/app.ts` — the public HTTP boundary, request limits, static serving, and every API route.
3. `server/letta-sdk-provisioner.ts` — the only adapter that sends the supplied key or creates Letta resources.
4. `server/schema.ts` — strict request limits and rejection of unsupported runtime fields.
5. `src/generate.ts` — deterministic generation of the three reviewed system-memory descriptions and file bodies.
6. `src/history.ts` — local parsing, privacy exclusion, stable identities, timestamp normalization, and deterministic Markdown rendering.
7. `scripts/package-source.ts` — the whitelist and hashing process used to make this archive.
8. `package-lock.json` — exact dependency resolution.

## Credential path

- The human enters a Letta API key into React state.
- The key is not written to local storage, session storage, cookies, source files, or a server database.
- Requests that need Letta include it as a bearer credential over HTTPS.
- The Hono server passes it directly to the official Letta Agent SDK for that request.
- Application logs deliberately avoid request headers and credentials.
- Refreshing or closing the browser tab removes the key from application state.

Continuity Studio does not set an application access-session cookie. The public UI and API boundary do not remove the Letta credential checks on operations that contact Letta.

## Current external effects

Nothing is created while opening the application, verifying a key, editing memory, reviewing files, inspecting JSON, mapping, or previewing.

Only two explicit actions create external resources:

- **Create agent** creates one Letta agent using the reviewed payload.
- **Import history** creates a hosted Letta repository, writes the reviewed rendered files, attaches it to the selected agent with `read` permission, and verifies the attachment.

## Honest limitations

- This is a one-time JSON backfill, not a live source connector or continuous synchronization.
- Repository writes are one file operation at a time and are not atomic. Partial progress is reported with the repository ID.
- The creation schema rejects custom `systemPrompt` input. It requires a description and meaningful content for each reviewed memory file.
- The public service has no Continuity Studio account layer. Letta operations require a user-provided Letta API key, and deployers should apply appropriate platform-level abuse controls.

## Bundle integrity

Run `npm run build:source` only when an archive is wanted. The packager derives its inputs from the Git index, rejects symlinks and paths that resolve outside the worktree, and therefore cannot pull untracked content into the ZIP. `SOURCE-MANIFEST.json` lists every included path, byte count, and SHA-256 digest. The adjacent `.sha256` file hashes the finished ZIP itself. Build artifacts, `.git`, dependencies, environment files, logs, browser traces, and local tool state are excluded because they are not tracked release inputs or fail the packaging policy.
