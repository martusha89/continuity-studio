# Continuity Studio — current architecture

This document describes the code that exists in this repository. Possible future connectors live in `roadmap.md`.

## Runtime boundary

```text
Browser
  ├─ persona, human, and relationship draft (tab memory)
  ├─ local JSON export inspection and mapping
  └─ explicit HTTPS requests
       │
Continuity Studio server (Node + Hono)
  ├─ public application and API boundary
  ├─ request validation and size limits
  └─ narrow Letta provisioning adapter
       │
Letta Agent SDK
  ├─ key verification
  ├─ agent creation with system memory
  └─ hosted repository creation, file writes, and read-only attachment
```

The browser does not persist the Letta API key. It does, necessarily, hold the key in JavaScript memory and send it through the Continuity Studio server to Letta for each requested operation. The server receives the key and reviewed rendered history files transiently but does not persist either. This is a server trust boundary, not a claim that they never leave the tab.

## Agent creation

The browser deterministically generates explicit `persona`, `human`, and `relationship` memory blocks. The review stage shows each `system/` path, its MemFS description, and its directly editable content before connecting Letta. Changing a questionnaire answer regenerates only the related file body. If that body has direct edits, the Studio asks before replacing them. Reviewed descriptions and edits to other files remain unchanged.

The server strictly validates the payload again and rejects unknown fields, including `systemPrompt`. It requires a description and meaningful content for all three memory files. It creates the agent with `model: "letta/auto"`, Letta-managed runtime defaults, `memfs: true`, and only the reviewed memory set. Creating an agent is a real external side effect. The SDK does not provide an application-level idempotency key here, so Studio binds a browser-stable operation ID to a deterministic tagged fingerprint and makes unchanged retries reconcile-only. The UI can also retrieve a known existing agent by ID and continue without creating a twin. Retrieval never claims that the currently displayed draft matches or was applied to that agent.

## Memory placement

The three identity and relationship memories are agent-local MemFS entries created under `system/`, so Letta keeps them in the system prompt on every turn. Optional imported history remains in a separately attached read-only hosted repository. That repository appears as a file tree the agent reads on demand instead of inlining a potentially large export into every turn. This split follows Letta's documented context contract while preserving the reviewed external export as canonical source material.

Current public Agent SDK documentation supports setting a reviewed `memory` entry set at agent creation and managing hosted shared repositories from both Node and the browser client. It does not document an SDK operation that writes an arbitrary reviewed file set into an existing Cloud agent's own MemFS. Continuity Studio therefore does not claim or implement that path; existing-agent selection is history-target recovery only and explicitly does not apply the displayed core-memory draft.

The browser SDK can connect directly to Letta Cloud with a user-provided API key and exposes repository operations. Direct browser provisioning is technically possible, but it is a separate deployment decision from memory placement. The current release keeps a narrow server adapter for strict validation, safe public errors, and reconciliation. Official browser guidance recommends short-lived user-scoped credentials rather than embedding an organization-wide key, so the public frontend should not replace this server trust boundary until Letta confirms the preferred issuance pattern.

## Source-neutral history import

The importer accepts JSON objects containing flat record arrays, either under `tables` or at the top level. “Table” is an internal mapping term; the source may be any JSON export with flat collections.

The browser:

1. parses the export locally;
2. suggests mappings from common field names;
3. requires human review of stable ID, primary text, timestamps, and privacy rules;
4. renders deterministic Markdown under `sources/<source>/`;
5. labels every record as untrusted historical reference material;
6. previews the exact files before import.

Ambiguous timezone-less timestamps are preserved unless the user explicitly chooses UTC. Generic mode assigns no meaning to source-specific fields such as `weight`.

The server verifies retrieved agent identities, makes repeated exhaustive observations before creating or resuming a uniquely named hosted repository, and writes files in requests capped at ten. The browser records whether the exact reviewed start was already attempted. Only its first request permits creation; unchanged retries are reconcile-only and fail with an inspection-required error if repeated listings still show nothing. Completed starts are retained in a bounded process-local cache so an immediately lost response returns the same repository without depending on listing visibility. Before any source-file write, the browser submits a reviewed manifest containing each path, UTF-8 byte count, and SHA-256 digest. The server stores that manifest in a reserved repository marker. Every batch must match the marker, reconcile its own files against Letta, and returns an HMAC receipt bound to the current Letta credential.

Finalization is a fail-closed state machine. It verifies receipt coverage, captures a stable repository revision, traverses the complete tree at that revision, rejects missing or extra files, and rereads every reviewed file to verify path, UTF-8 size, API digest, and locally calculated SHA-256. Repository head checks surround attachment and explicit agent recompilation. Finalizers for the same credential, agent, and repository are serialized in-process, and success is returned only after the read-only relationship is visible again after recompilation. Attachment ownership is deliberately conservative: an absent listing may be stale, so Studio never assumes that an attempted attachment created the relationship and never auto-detaches it on later failure. Any failure after attachment or recompilation may have changed state and therefore becomes an explicit recovery-required error directing the human to inspect the relationship and recompile in Letta. No import-progress database is required. The external export remains canonical. Read-only permission prevents repository writes through that attachment; it does not make retrieved text trustworthy.

Repository creation and writing are not atomic. A failure can leave a partial repository, but the browser reports its ID and retry finds the same unique case-insensitive name, reuses only exact matching content, and continues missing files. Conflicting content and duplicate names stop for human inspection. A marker mismatch distinguishes a changed target agent, source prefix, or reviewed file set so the user can restore the original inputs or deliberately choose a new repository name. Destructive repository deletion remains manual.

## Deployment and release

Railway runs one public service for static assets and APIs. `/api/health`, the UI, and API routes are publicly reachable; operations that contact Letta continue to require the user's Letta credential.

The normal build type-checks frontend and server and creates the web bundle. GitHub is the primary source-inspection surface. `npm run build:source` optionally adds a source ZIP derived only from tracked files in the current worktree. Packaging rejects symlinks, out-of-root resolution, unexpected extensions, and credential-like filenames. The ZIP contains a manifest with per-file byte counts and SHA-256 hashes; the adjacent archive checksum detects corruption but is not independent authenticity proof.

## Verified and unverified contracts

Unit tests mock the provisioning adapter, including stable creation-operation reconciliation, bounded completed-operation reuse, reconcile-only refusal under fully stale response-loss recovery, eventual visibility after process restart, target-identity mismatch, concurrent create/finalizer coalescing, committed-then-thrown attachment reconciliation, a pre-existing relationship hidden by a stale initial listing, and repository mutation during recompilation. On 25 August 2026 an isolated disposable live trial verified agent creation and retrieval, repository creation, marker write, three source-file writes, read-only attachment and listing, exact-file replay on resume, source-prefix conflict diagnostics, detachment, repository deletion, and agent deletion against Letta Cloud. The live trial did not inject those recovery-required, stale-visibility, response-loss, identity-mismatch, or concurrency faults. It also established that Letta creates `.letta/config.json` in every hosted repository; finalization currently tolerates that observed platform-managed path behind the provisioner adapter while continuing to reject other unreviewed files.
