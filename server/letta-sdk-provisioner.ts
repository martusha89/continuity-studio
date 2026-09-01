import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import Letta, { APIError } from '@letta-ai/letta-client'
import { LettaAgentClient } from '@letta-ai/letta-agent-sdk'
import type {
  ExistingAgentResult,
  HistoryImportBatchResult,
  HistoryImportFinishResult,
  HistoryImportStartResult,
  LettaProvisioner,
  ProvisionResult,
} from './provisioner.js'
import { PublicProvisioningError } from './provisioner.js'
import type {
  ExistingAgentRequest,
  HistoryImportBatchRequest,
  HistoryImportFinishRequest,
  HistoryImportStartRequest,
  ProvisionRequest,
} from './schema.js'
import {
  isCanonicalHistoryPath,
  MAX_HISTORY_CONTENT_BYTES,
  MAX_HISTORY_FILE_BYTES,
  MAX_HISTORY_FILES,
} from '../src/history-contract.js'

const IMPORT_MARKER_PATH = '.continuity-studio/import-v1.json'
const LETTA_REPOSITORY_CONFIG_PATH = '.letta/config.json'
const MAX_REPOSITORY_ENTRIES = 10_000
const RECONCILIATION_ATTEMPTS = 4
const MAX_COMPLETED_OPERATIONS = 1_000

type ImportMarker = {
  version: 1
  agentId: string
  repositoryName: string
  files: Array<{ path: string; contentBytes: number; contentSha256: string }>
}

type Repository = { id: string; name: string }
type Agent = { id: string; name: string }
type AgentRepository = { id: string; permissions?: string }
type RepositoryEntry = { path: string; type: 'file' | 'directory' }
type RepositoryFile = { path: string; content: string; contentSha256: string; ref?: string }

export type LettaProvisioningClient = {
  createAgent(options: {
    name: string
    memory: ProvisionRequest['memory']
    model: 'letta/auto'
    memfs: true
    tags?: string[]
  }): Promise<string>
  listAgents(query: { limit?: number; name?: string; tags?: string[]; match_all_tags?: boolean }): Promise<Agent[]>
  retrieveAgent(agentId: string): Promise<Agent>
  listRepositories(query?: { limit?: number; offset?: number }): Promise<{ repositories: Repository[]; hasNextPage: boolean }>
  createRepository(name: string): Promise<Repository>
  listRepositoryFiles(repositoryId: string, query?: { pathPrefix?: string; depth?: number; ref?: string }): Promise<{ files: RepositoryEntry[]; ref: string }>
  readRepositoryFile(repositoryId: string, query: { path: string; ref?: string }): Promise<RepositoryFile>
  createRepositoryFile(repositoryId: string, file: { path: string; content: string }): Promise<unknown>
  listAgentRepositories(agentId: string): Promise<AgentRepository[]>
  attachAgentRepository(agentId: string, repositoryId: string): Promise<unknown>
  detachAgentRepository(agentId: string, repositoryId: string): Promise<unknown>
  recompileAgent(agentId: string): Promise<unknown>
}

type ClientFactory = (apiKey: string) => LettaProvisioningClient
type Sleep = (milliseconds: number) => Promise<void>

type ActiveStart = {
  fingerprint: string
  promise: Promise<HistoryImportStartResult>
}

type ActiveCreate = {
  promise: Promise<ProvisionResult>
}

type CompletedStart = {
  fingerprint: string
  result: HistoryImportStartResult
}

type ActiveFinish = {
  fingerprint: string
  promise: Promise<HistoryImportFinishResult>
}

export class LettaSdkProvisioner implements LettaProvisioner {
  private readonly creates = new Map<string, ActiveCreate>()
  private readonly completedCreates = new Map<string, ProvisionResult>()
  private readonly starts = new Map<string, ActiveStart>()
  private readonly completedStarts = new Map<string, CompletedStart>()
  private readonly finishes = new Map<string, ActiveFinish>()

  constructor(
    private readonly clientFactory: ClientFactory = createProductionClient,
    private readonly sleep: Sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  ) {}

  async verifyKey(apiKey: string): Promise<void> {
    await this.clientFactory(apiKey).listAgents({ limit: 1 })
  }

  async createAgent(apiKey: string, request: ProvisionRequest): Promise<ProvisionResult> {
    const operationTag = creationOperationTag(apiKey, request)
    const completed = this.completedCreates.get(operationTag)
    if (completed) return completed
    const active = this.creates.get(operationTag)
    if (active) return active.promise

    const promise = this.createAgentOnce(apiKey, request, operationTag)
    this.creates.set(operationTag, { promise })
    try {
      const result = await promise
      rememberBounded(this.completedCreates, operationTag, result)
      return result
    } finally {
      if (this.creates.get(operationTag)?.promise === promise) this.creates.delete(operationTag)
    }
  }

  private async createAgentOnce(apiKey: string, request: ProvisionRequest, operationTag: string): Promise<ProvisionResult> {
    const client = this.clientFactory(apiKey)
    const existing = await reconcileAgentsByOperationTag(client, operationTag, this.sleep)
    if (existing.length === 1) return { agentId: existing[0].id }
    if (existing.length > 1) throw duplicateAgentCreationError()
    if (!request.allowCreate) {
      throw publicError('No tagged agent is visible for this reconcile-only retry. Inspect Letta before starting a new creation attempt.', 502)
    }

    try {
      const agentId = await client.createAgent({
        name: request.name,
        memory: request.memory,
        model: 'letta/auto',
        memfs: true,
        tags: [operationTag],
      })
      return { agentId }
    } catch (error) {
      const candidates = await reconcileAgentsByOperationTag(client, operationTag, this.sleep)
      if (candidates.length === 1) return { agentId: candidates[0].id }
      if (candidates.length > 1) throw duplicateAgentCreationError()
      throw error
    }
  }

  async retrieveAgent(apiKey: string, request: ExistingAgentRequest): Promise<ExistingAgentResult> {
    const agent = await retrieveExpectedAgent(this.clientFactory(apiKey), request.agentId)
    return { agentId: agent.id, name: agent.name }
  }

  async startHistoryImport(apiKey: string, request: HistoryImportStartRequest): Promise<HistoryImportStartResult> {
    const marker = markerFor(request)
    const fingerprint = sha256(serializeMarker(marker))
    const lockKey = createHmac('sha256', apiKey).update(marker.repositoryName).digest('hex')
    const completed = this.completedStarts.get(lockKey)
    if (completed) {
      if (completed.fingerprint !== fingerprint) {
        throw publicError('A different reviewed import already used this repository name. Restore its reviewed inputs or choose another name.')
      }
      return completed.result
    }
    const active = this.starts.get(lockKey)
    if (active) {
      if (active.fingerprint !== fingerprint) {
        throw publicError('A different reviewed import is already starting with this repository name. Wait for it to finish or choose another name.')
      }
      return active.promise
    }

    const promise = this.startHistoryImportOnce(apiKey, request, marker)
    this.starts.set(lockKey, { fingerprint, promise })
    try {
      const result = await promise
      rememberBounded(this.completedStarts, lockKey, { fingerprint, result })
      return result
    } finally {
      if (this.starts.get(lockKey)?.promise === promise) this.starts.delete(lockKey)
    }
  }

  private async startHistoryImportOnce(
    apiKey: string,
    request: HistoryImportStartRequest,
    marker: ImportMarker,
  ): Promise<HistoryImportStartResult> {
    const client = this.clientFactory(apiKey)
    await retrieveExpectedAgent(client, request.agentId)
    const markerContent = serializeMarker(marker)
    const manifestSha256 = sha256(markerContent)
    let matching = await reconcileRepositories(client, request.repositoryName, this.sleep)
    if (matching.length > 1) throw duplicateRepositoryError(request.repositoryName)

    let resumed = matching.length === 1
    let repository = matching[0]
    if (!repository) {
      if (!request.allowCreate) {
        throw publicError(`No repository named ${request.repositoryName} is visible for this reconcile-only retry. Inspect Letta or choose a new repository name.`, 502)
      }
      try {
        repository = await client.createRepository(request.repositoryName)
      } catch (error) {
        matching = await reconcileRepositories(client, request.repositoryName, this.sleep)
        if (matching.length > 1) throw duplicateRepositoryError(request.repositoryName)
        const candidate = matching[0]
        if (candidate) {
          const markerMatches = await repositoryHasMarker(client, candidate.id, markerContent)
          if (markerMatches) {
            repository = candidate
            resumed = true
          } else {
            throw publicError(`Repository creation may have completed as ${candidate.id}, but ownership could not be proven. Do not retry with this name until you inspect that repository in Letta.`)
          }
        } else {
          throw error
        }
      }

      if (!resumed) {
        const afterCreate = await reconcileRepositories(client, request.repositoryName, this.sleep)
        if (afterCreate.length > 1) throw duplicateRepositoryError(request.repositoryName)
      }
    }

    if (resumed) {
      let existingMarker: RepositoryFile
      try {
        existingMarker = await client.readRepositoryFile(repository.id, { path: IMPORT_MARKER_PATH })
      } catch (error) {
        if (isNotFound(error)) {
          throw publicError(`Repository ${repository.id} was not created by this reviewed import. Choose a different repository name.`)
        }
        throw error
      }
      if (existingMarker.content !== markerContent) {
        throw publicError(describeMarkerConflict(repository.id, existingMarker.content, marker))
      }
    } else {
      try {
        await client.createRepositoryFile(repository.id, { path: IMPORT_MARKER_PATH, content: markerContent })
      } catch (error) {
        const existingMarker = await readAfterAmbiguousFileCreate(client, repository.id, IMPORT_MARKER_PATH, error, this.sleep)
        if (existingMarker !== markerContent) throw error
      }
    }

    const attachments = await client.listAgentRepositories(request.agentId)
    return {
      repositoryId: repository.id,
      repositoryName: repository.name,
      manifestSha256,
      resumed,
      attached: hasReadAttachment(attachments, repository.id),
    }
  }

  async importHistoryBatch(apiKey: string, request: HistoryImportBatchRequest): Promise<HistoryImportBatchResult> {
    const client = this.clientFactory(apiKey)
    const marker = await readMarker(client, request.repositoryId, request.manifestSha256)
    const expected = new Map(marker.files.map((file) => [file.path, file]))
    let filesCreated = 0
    let filesReused = 0
    for (const file of request.files) {
      const reviewed = expected.get(file.path)
      if (!reviewed || reviewed.contentBytes !== utf8Bytes(file.content) || reviewed.contentSha256 !== sha256(file.content)) {
        throw publicError(`File ${file.path} does not match the reviewed import manifest.`, 422)
      }
      try {
        const existing = await client.readRepositoryFile(request.repositoryId, { path: file.path })
        if (existing.content !== file.content) {
          throw publicError(`Repository ${request.repositoryId} already contains different content at ${file.path}.`)
        }
        filesReused += 1
      } catch (error) {
        if (!isNotFound(error)) throw error
        try {
          await client.createRepositoryFile(request.repositoryId, file)
          filesCreated += 1
        } catch (createError) {
          const existingContent = await readAfterAmbiguousFileCreate(client, request.repositoryId, file.path, createError, this.sleep)
          if (existingContent !== file.content) throw createError
          filesReused += 1
        }
      }
    }
    const paths = request.files.map((file) => file.path).sort()
    return {
      repositoryId: request.repositoryId,
      filesProcessed: request.files.length,
      filesCreated,
      filesReused,
      receipt: { paths, signature: receiptSignature(apiKey, request.repositoryId, request.manifestSha256, paths) },
    }
  }

  async finishHistoryImport(apiKey: string, request: HistoryImportFinishRequest): Promise<HistoryImportFinishResult> {
    const fingerprint = sha256(JSON.stringify(request))
    const lockKey = createHmac('sha256', apiKey)
      .update(`${request.agentId}\0${request.repositoryId}`)
      .digest('hex')
    const active = this.finishes.get(lockKey)
    if (active) {
      if (active.fingerprint !== fingerprint) {
        throw publicError('A different finalization is already running for this agent and repository. Wait for it to finish before retrying.')
      }
      return active.promise
    }

    const promise = this.finishHistoryImportOnce(apiKey, request)
    this.finishes.set(lockKey, { fingerprint, promise })
    try {
      return await promise
    } finally {
      if (this.finishes.get(lockKey)?.promise === promise) this.finishes.delete(lockKey)
    }
  }

  private async finishHistoryImportOnce(apiKey: string, request: HistoryImportFinishRequest): Promise<HistoryImportFinishResult> {
    const client = this.clientFactory(apiKey)
    await retrieveExpectedAgent(client, request.agentId)
    const marker = await readMarker(client, request.repositoryId, request.manifestSha256)
    if (marker.agentId !== request.agentId) throw publicError('The target agent does not match the reviewed import manifest.')
    validateReceiptCoverage(apiKey, request, marker)

    const snapshot = await verifiedRepositorySnapshot(client, request.repositoryId, request.manifestSha256, marker)
    await assertRepositoryHead(client, request.repositoryId, snapshot.ref)

    const before = await client.listAgentRepositories(request.agentId)
    const alreadyAttached = hasReadAttachment(before, request.repositoryId)
    let attachmentMutationAttempted = false
    let recompileAttempted = false

    try {
      if (!alreadyAttached) {
        // An absent listing cannot prove this operation owns the relationship: it may be stale.
        // Never auto-detach after this point; preserve the relationship and require recovery on failure.
        attachmentMutationAttempted = true
        try {
          await client.attachAgentRepository(request.agentId, request.repositoryId)
        } catch (attachError) {
          const reconciled = await client.listAgentRepositories(request.agentId)
          if (!hasReadAttachment(reconciled, request.repositoryId)) throw attachError
        }
      }

      await assertReadAttachment(client, request.agentId, request.repositoryId)
      await assertRepositoryHead(client, request.repositoryId, snapshot.ref)
      recompileAttempted = true
      await client.recompileAgent(request.agentId)
      await assertRepositoryHead(client, request.repositoryId, snapshot.ref)
      await assertReadAttachment(client, request.agentId, request.repositoryId)
    } catch (error) {
      if (attachmentMutationAttempted || recompileAttempted) {
        throw publicError(
          `History finalization failed after the attachment or compiled state may have changed for repository ${request.repositoryId}. Continuity Studio preserved the relationship because it cannot prove this operation introduced it. Inspect the attachment and recompile the agent in Letta before retrying.`,
          502,
        )
      }
      throw error
    }

    return { repositoryId: request.repositoryId, attached: true }
  }
}

function createProductionClient(apiKey: string): LettaProvisioningClient {
  const sdk = new LettaAgentClient({ backend: 'cloud', apiKey, fetch: mutationRetryGuard(fetch) })
  const raw = new Letta({ apiKey, maxRetries: 0 })
  return {
    createAgent: (options) => sdk.createAgent(options),
    listAgents: (query) => sdk.agents.list(query),
    retrieveAgent: (agentId) => sdk.agents.retrieve(agentId),
    listRepositories: (query) => sdk.repositories.list(query),
    createRepository: (name) => sdk.repositories.create({ name }),
    listRepositoryFiles: (repositoryId, query) => sdk.repositories.files.list(repositoryId, query),
    readRepositoryFile: (repositoryId, query) => sdk.repositories.files.read(repositoryId, query),
    createRepositoryFile: (repositoryId, file) => sdk.repositories.files.create(repositoryId, file),
    listAgentRepositories: (agentId) => sdk.agents.repositories.list(agentId),
    attachAgentRepository: (agentId, repositoryId) => sdk.agents.repositories.attach(agentId, repositoryId, { permissions: 'read', recompile: false }),
    detachAgentRepository: (agentId, repositoryId) => sdk.agents.repositories.detach(agentId, repositoryId, { recompile: false }),
    recompileAgent: (agentId) => raw.agents.recompile(agentId, {}, { maxRetries: 0 }),
  }
}

function mutationRetryGuard(baseFetch: typeof fetch): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : undefined
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase()
    const headers = new Headers(init?.headers ?? request?.headers)
    const retryCount = Number(headers.get('x-stainless-retry-count') ?? '0')
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && retryCount > 0) {
      throw new Error('Automatic retry of a non-idempotent Letta mutation was blocked.')
    }
    return baseFetch(input, init)
  }
}

function creationOperationTag(apiKey: string, request: ProvisionRequest): string {
  const reviewedRequest = JSON.stringify({
    name: request.name,
    memory: request.memory,
    model: 'letta/auto',
  })
  const fingerprint = createHmac('sha256', apiKey)
    .update(`${request.operationId}\0${sha256(reviewedRequest)}`)
    .digest('hex')
  return `continuity-studio-create:${fingerprint}`
}

function duplicateAgentCreationError() {
  return publicError('Letta returned more than one agent for this creation operation. No agent was selected automatically.')
}

async function reconcileAgentsByOperationTag(
  client: LettaProvisioningClient,
  tag: string,
  sleep: Sleep,
  attempts = RECONCILIATION_ATTEMPTS,
): Promise<Agent[]> {
  const candidates = new Map<string, Agent>()
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt) await sleep(250 * attempt)
    for (const candidate of await client.listAgents({ limit: 100, tags: [tag], match_all_tags: true })) {
      candidates.set(candidate.id, candidate)
    }
  }
  return [...candidates.values()]
}

async function findRepositories(client: LettaProvisioningClient, repositoryName: string): Promise<Repository[]> {
  const canonicalName = canonicalRepositoryName(repositoryName)
  const matching: Repository[] = []
  let offset = 0
  while (true) {
    const page = await client.listRepositories({ limit: 100, offset })
    matching.push(...page.repositories.filter((repository) => canonicalRepositoryName(repository.name) === canonicalName))
    if (!page.hasNextPage) return matching
    offset += 100
  }
}

async function reconcileRepositories(client: LettaProvisioningClient, repositoryName: string, sleep: Sleep): Promise<Repository[]> {
  const matching = new Map<string, Repository>()
  for (let attempt = 0; attempt < RECONCILIATION_ATTEMPTS; attempt += 1) {
    if (attempt) await sleep(250 * attempt)
    for (const repository of await findRepositories(client, repositoryName)) {
      matching.set(repository.id, repository)
    }
  }
  return [...matching.values()]
}

async function retrieveExpectedAgent(
  client: LettaProvisioningClient,
  requestedAgentId: string,
): Promise<Agent> {
  const agent = await client.retrieveAgent(requestedAgentId)
  if (agent.id !== requestedAgentId) {
    throw publicError('Letta returned an unexpected agent identity. No operation was performed.', 502)
  }
  return agent
}

function rememberBounded<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key)
  map.set(key, value)
  while (map.size > MAX_COMPLETED_OPERATIONS) {
    const oldest = map.keys().next().value as K | undefined
    if (oldest === undefined) return
    map.delete(oldest)
  }
}

async function repositoryHasMarker(client: LettaProvisioningClient, repositoryId: string, markerContent: string): Promise<boolean> {
  try {
    return (await client.readRepositoryFile(repositoryId, { path: IMPORT_MARKER_PATH })).content === markerContent
  } catch {
    return false
  }
}

async function readMarker(
  client: LettaProvisioningClient,
  repositoryId: string,
  manifestSha256: string,
  ref?: string,
): Promise<ImportMarker> {
  const file = await client.readRepositoryFile(repositoryId, { path: IMPORT_MARKER_PATH, ...(ref ? { ref } : {}) })
  if (sha256(file.content) !== manifestSha256) throw publicError(`Repository ${repositoryId} belongs to a different reviewed import.`)
  return parseMarker(repositoryId, file.content)
}

function parseMarker(repositoryId: string, content: string): ImportMarker {
  if (utf8Bytes(content) > MAX_HISTORY_CONTENT_BYTES) {
    throw publicError(`Repository ${repositoryId} has an oversized import marker.`)
  }
  let marker: unknown
  try {
    marker = JSON.parse(content)
  } catch {
    throw publicError(`Repository ${repositoryId} has an invalid import marker.`)
  }
  if (!isImportMarker(marker)) throw publicError(`Repository ${repositoryId} has an invalid import marker.`)
  return marker
}

function isImportMarker(value: unknown): value is ImportMarker {
  if (!value || typeof value !== 'object') return false
  const marker = value as Partial<ImportMarker>
  if (!(marker.version === 1
    && typeof marker.agentId === 'string'
    && marker.agentId.trim().length > 0
    && typeof marker.repositoryName === 'string'
    && marker.repositoryName === canonicalRepositoryName(marker.repositoryName)
    && marker.repositoryName.length > 0
    && Array.isArray(marker.files)
    && marker.files.length > 0
    && marker.files.length <= MAX_HISTORY_FILES
    && marker.files.every((file) => file
      && typeof file.path === 'string'
      && isCanonicalHistoryPath(file.path)
      && Number.isSafeInteger(file.contentBytes)
      && file.contentBytes >= 0
      && file.contentBytes <= MAX_HISTORY_FILE_BYTES
      && typeof file.contentSha256 === 'string'
      && /^[a-f0-9]{64}$/.test(file.contentSha256)))) return false
  const paths = marker.files.map((file) => file.path)
  const canonicalPaths = paths.map((path) => path.toLowerCase())
  if (new Set(canonicalPaths).size !== canonicalPaths.length) return false
  if (marker.files.reduce((total, file) => total + file.contentBytes, 0) > MAX_HISTORY_CONTENT_BYTES) return false
  return paths.every((path, index) => index === 0 || marker.files![index - 1].path.localeCompare(path) <= 0)
}

async function verifiedRepositorySnapshot(
  client: LettaProvisioningClient,
  repositoryId: string,
  manifestSha256: string,
  expectedMarker: ImportMarker,
): Promise<{ ref: string }> {
  const snapshot = await listRepositoryFilesExhaustively(client, repositoryId)
  if (!snapshot.ref) throw publicError(`Repository ${repositoryId} did not return a stable revision for final review.`, 502)
  const allowedFiles = new Set([IMPORT_MARKER_PATH, LETTA_REPOSITORY_CONFIG_PATH, ...expectedMarker.files.map((file) => file.path)])
  const requiredFiles = new Set([IMPORT_MARKER_PATH, ...expectedMarker.files.map((file) => file.path)])
  const allowedDirectories = directoryPrefixes(allowedFiles)
  const listedFiles = new Set(snapshot.files.filter((entry) => entry.type === 'file').map((entry) => entry.path))
  const unexpectedDirectory = snapshot.files.some((entry) => entry.type === 'directory' && !allowedDirectories.has(entry.path))
  const extras = [...listedFiles].filter((path) => !allowedFiles.has(path))
  const missing = [...requiredFiles].filter((path) => !listedFiles.has(path))
  if (unexpectedDirectory || extras.length || missing.length) {
    throw publicError(`Repository ${repositoryId} does not contain exactly the reviewed import files.`)
  }

  const markerAtRef = await readMarker(client, repositoryId, manifestSha256, snapshot.ref)
  if (serializeMarker(markerAtRef) !== serializeMarker(expectedMarker)) {
    throw publicError(`Repository ${repositoryId} belongs to a different reviewed import.`)
  }
  for (const expected of expectedMarker.files) {
    const actual = await client.readRepositoryFile(repositoryId, { path: expected.path, ref: snapshot.ref })
    if (actual.path !== expected.path
      || (actual.ref !== undefined && actual.ref !== snapshot.ref)
      || utf8Bytes(actual.content) !== expected.contentBytes
      || actual.contentSha256 !== expected.contentSha256
      || sha256(actual.content) !== expected.contentSha256) {
      throw publicError(`Repository ${repositoryId} contains changed or unreadable content at ${expected.path}.`)
    }
  }
  return { ref: snapshot.ref }
}

async function assertRepositoryHead(client: LettaProvisioningClient, repositoryId: string, expectedRef: string): Promise<void> {
  const current = await client.listRepositoryFiles(repositoryId, { depth: 1 })
  if (current.ref !== expectedRef) {
    throw publicError(`Repository ${repositoryId} changed during final review and was not attached.`)
  }
}

async function listRepositoryFilesExhaustively(
  client: LettaProvisioningClient,
  repositoryId: string,
): Promise<{ files: RepositoryEntry[]; ref: string }> {
  const root = await client.listRepositoryFiles(repositoryId, { depth: 1 })
  if (!root.ref) throw publicError(`Repository ${repositoryId} did not return a stable revision for final review.`, 502)
  const entries = new Map(root.files.map((entry) => [entry.path, entry]))
  const pending = root.files.filter((entry) => entry.type === 'directory').map((entry) => entry.path)
  const visited = new Set<string>()
  while (pending.length) {
    const directory = pending.shift() as string
    if (visited.has(directory)) continue
    visited.add(directory)
    const page = await client.listRepositoryFiles(repositoryId, { pathPrefix: directory, depth: 1, ref: root.ref })
    if (page.ref !== root.ref) throw publicError(`Repository ${repositoryId} changed during final review and was not attached.`)
    for (const entry of page.files) {
      entries.set(entry.path, entry)
      if (entry.type === 'directory' && !visited.has(entry.path)) pending.push(entry.path)
      if (entries.size > MAX_REPOSITORY_ENTRIES) {
        throw publicError(`Repository ${repositoryId} is too large to verify safely.`, 422)
      }
    }
  }
  return { files: [...entries.values()], ref: root.ref }
}

function validateReceiptCoverage(apiKey: string, request: HistoryImportFinishRequest, marker: ImportMarker): void {
  const confirmed = new Set<string>()
  for (const receipt of request.receipts) {
    const paths = [...receipt.paths].sort()
    const expected = receiptSignature(apiKey, request.repositoryId, request.manifestSha256, paths)
    if (!safeEqual(receipt.signature, expected)) {
      throw publicError('A reviewed batch receipt is invalid or belongs to another Letta credential.')
    }
    for (const path of paths) confirmed.add(path)
  }
  if (confirmed.size !== marker.files.length || marker.files.some((file) => !confirmed.has(file.path))) {
    throw publicError(`Repository ${request.repositoryId} does not have receipts for every reviewed file.`)
  }
}

function markerFor(request: HistoryImportStartRequest): ImportMarker {
  return {
    version: 1,
    agentId: request.agentId,
    repositoryName: canonicalRepositoryName(request.repositoryName),
    files: [...request.manifest].sort((left, right) => left.path.localeCompare(right.path)),
  }
}

const serializeMarker = (marker: ImportMarker): string => JSON.stringify(marker)
const canonicalRepositoryName = (name: string): string => name.trim().toLowerCase()

function describeMarkerConflict(repositoryId: string, existingContent: string, requested: ImportMarker): string {
  let existing: ImportMarker
  try {
    existing = parseMarker(repositoryId, existingContent)
  } catch (error) {
    return error instanceof PublicProvisioningError
      ? `${error.publicMessage} Choose a different repository name.`
      : `Repository ${repositoryId} has an invalid Continuity Studio import marker. Choose a different repository name.`
  }
  if (existing.agentId !== requested.agentId) {
    return `Repository ${repositoryId} was reviewed for agent ${existing.agentId}, not ${requested.agentId}. Restore the original target agent or choose a different repository name.`
  }
  const existingSources = sourcePrefixes(existing.files)
  const requestedSources = sourcePrefixes(requested.files)
  if (existingSources.join('\0') !== requestedSources.join('\0')) {
    return `Repository ${repositoryId} was reviewed for source ${formatList(existingSources)}, not ${formatList(requestedSources)}. Restore the original source name or choose a different repository name deliberately.`
  }
  const existingByPath = new Map(existing.files.map((file) => [file.path.toLowerCase(), file]))
  const requestedByPath = new Map(requested.files.map((file) => [file.path.toLowerCase(), file]))
  const added = requested.files.filter((file) => !existingByPath.has(file.path.toLowerCase())).length
  const removed = existing.files.filter((file) => !requestedByPath.has(file.path.toLowerCase())).length
  const changed = requested.files.filter((file) => {
    const prior = existingByPath.get(file.path.toLowerCase())
    return prior && (prior.contentBytes !== file.contentBytes || prior.contentSha256 !== file.contentSha256)
  }).length
  return `Repository ${repositoryId} is bound to a different reviewed file set (${added} added, ${removed} removed, ${changed} changed). Restore the original export and settings, or choose a different repository name deliberately.`
}

const sourcePrefixes = (files: ImportMarker['files']) => [...new Set(files.map((file) => file.path.split('/').slice(0, 2).join('/')))].sort()
const formatList = (values: string[]) => values.length ? values.join(', ') : 'an unknown source'

async function readAfterAmbiguousFileCreate(
  client: LettaProvisioningClient,
  repositoryId: string,
  path: string,
  originalError: unknown,
  sleep: Sleep,
): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt) await sleep(250 * attempt)
    try {
      return (await client.readRepositoryFile(repositoryId, { path })).content
    } catch {
      // The mutation may have committed even when its response was lost.
    }
  }
  throw originalError
}

function directoryPrefixes(paths: Set<string>): Set<string> {
  const prefixes = new Set<string>()
  for (const path of paths) {
    const segments = path.split('/')
    for (let index = 1; index < segments.length; index += 1) prefixes.add(segments.slice(0, index).join('/'))
  }
  return prefixes
}

const utf8Bytes = (content: string) => Buffer.byteLength(content, 'utf8')
const sha256 = (content: string) => createHash('sha256').update(content, 'utf8').digest('hex')

function receiptSignature(apiKey: string, repositoryId: string, manifestSha256: string, paths: string[]): string {
  return createHmac('sha256', apiKey).update(JSON.stringify({ repositoryId, manifestSha256, paths })).digest('hex')
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

function hasReadAttachment(attachments: AgentRepository[], repositoryId: string): boolean {
  return attachments.some((item) => item.id === repositoryId && item.permissions === 'read')
}

async function assertReadAttachment(client: LettaProvisioningClient, agentId: string, repositoryId: string): Promise<void> {
  const attachments = await client.listAgentRepositories(agentId)
  if (!hasReadAttachment(attachments, repositoryId)) {
    throw publicError(`Repository ${repositoryId} exists but its read-only attachment could not be verified.`, 502)
  }
}

function duplicateRepositoryError(name: string): PublicProvisioningError {
  return publicError(`More than one repository is named ${name}. Rename or delete duplicates in Letta before retrying.`)
}

function publicError(message: string, status: 409 | 422 | 502 = 409): PublicProvisioningError {
  return new PublicProvisioningError(message, status)
}

export function upstreamStatus(error: unknown): number | undefined {
  return error instanceof APIError ? error.status : undefined
}

function isNotFound(error: unknown): boolean {
  return upstreamStatus(error) === 404 || (error instanceof Error && (error as Error & { status?: number }).status === 404)
}
