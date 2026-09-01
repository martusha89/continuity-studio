import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { LettaSdkProvisioner, type LettaProvisioningClient } from './letta-sdk-provisioner.js'

const apiKey = 'letta-test-key'
const agentId = 'agent-test'
const repositoryId = 'repo-test'
const path = 'sources/test/README.md'
const content = '# Test\n'

describe('LettaSdkProvisioner history integrity', () => {
  it('rejects deleted or modified reviewed files before attachment', async () => {
    const fake = new FakeLetta()
    const provisioner = makeProvisioner(fake)
    const importState = await writeReviewedImport(provisioner)

    fake.files.set(path, '# Evil\n')
    fake.advanceRef()

    await expect(provisioner.finishHistoryImport(apiKey, importState.finish)).rejects.toMatchObject({
      publicMessage: expect.stringMatching(/changed or unreadable content/),
    })
    expect(fake.attachCalls).toBe(0)
    expect(fake.recompileCalls).toBe(0)
  })

  it('requires recovery without detaching when the repository head changes during attachment', async () => {
    const fake = new FakeLetta()
    const provisioner = makeProvisioner(fake)
    const importState = await writeReviewedImport(provisioner)
    fake.onAttach = () => fake.advanceRef()

    await expect(provisioner.finishHistoryImport(apiKey, importState.finish)).rejects.toMatchObject({
      publicMessage: expect.stringMatching(/preserved the relationship/),
    })
    expect(fake.recompileCalls).toBe(0)
    expect(fake.detachCalls).toBe(0)
    expect(fake.attached).toBe(true)
    expect(fake.compiledAttached).toBe(false)
  })

  it('retries recompilation when a prior attempt left the read attachment visible', async () => {
    const fake = new FakeLetta()
    const provisioner = makeProvisioner(fake)
    const importState = await writeReviewedImport(provisioner)
    fake.recompileErrorOnce = new Error('transient recompile failure')

    await expect(provisioner.finishHistoryImport(apiKey, importState.finish)).rejects.toMatchObject({
      publicMessage: expect.stringMatching(/preserved the relationship/),
    })
    expect(fake.attachCalls).toBe(1)
    expect(fake.detachCalls).toBe(0)
    expect(fake.attached).toBe(true)
    expect(fake.compiledAttached).toBe(false)

    const result = await provisioner.finishHistoryImport(apiKey, importState.finish)
    expect(result).toEqual({ repositoryId, attached: true })
    expect(fake.attachCalls).toBe(1)
    expect(fake.recompileCalls).toBe(2)
    expect(fake.compiledAttached).toBe(true)
  })

  it('reconciles an attachment that committed before the attach call threw', async () => {
    const fake = new FakeLetta()
    const provisioner = makeProvisioner(fake)
    const importState = await writeReviewedImport(provisioner)
    fake.attachErrorAfterCommit = new Error('response lost')

    await expect(provisioner.finishHistoryImport(apiKey, importState.finish)).resolves.toEqual({ repositoryId, attached: true })
    expect(fake.attached).toBe(true)
    expect(fake.compiledAttached).toBe(true)
    expect(fake.detachCalls).toBe(0)
  })

  it('preserves the relationship when an ambiguous attachment cannot be reconciled immediately', async () => {
    const fake = new FakeLetta()
    const provisioner = makeProvisioner(fake)
    const importState = await writeReviewedImport(provisioner)
    fake.attachErrorAfterCommit = new Error('response lost')
    fake.onAttach = () => { fake.listAttachmentErrorOnce = new Error('visibility check failed') }

    await expect(provisioner.finishHistoryImport(apiKey, importState.finish)).rejects.toMatchObject({
      publicMessage: expect.stringMatching(/preserved the relationship/),
    })
    expect(fake.attached).toBe(true)
    expect(fake.compiledAttached).toBe(false)
    expect(fake.detachCalls).toBe(0)
    expect(fake.recompileCalls).toBe(0)
  })

  it('requires recovery when an existing attachment changes head during recompilation', async () => {
    const fake = new FakeLetta()
    const provisioner = makeProvisioner(fake)
    const importState = await writeReviewedImport(provisioner)
    fake.attached = true
    fake.compiledAttached = true
    fake.onRecompile = () => {
      fake.onRecompile = undefined
      fake.advanceRef()
    }

    await expect(provisioner.finishHistoryImport(apiKey, importState.finish)).rejects.toMatchObject({
      publicMessage: expect.stringMatching(/preserved the relationship/),
    })
    expect(fake.attached).toBe(true)
    expect(fake.compiledAttached).toBe(true)
    expect(fake.detachCalls).toBe(0)
    expect(fake.recompileCalls).toBe(1)
  })

  it('never detaches a pre-existing relationship hidden by a stale initial listing', async () => {
    const fake = new FakeLetta()
    const provisioner = makeProvisioner(fake)
    const importState = await writeReviewedImport(provisioner)
    fake.attached = true
    fake.compiledAttached = true
    fake.attachmentVisibilityOverrides.push(false)
    fake.onAttach = () => fake.advanceRef()

    await expect(provisioner.finishHistoryImport(apiKey, importState.finish)).rejects.toMatchObject({
      publicMessage: expect.stringMatching(/preserved the relationship/),
    })
    expect(fake.detachCalls).toBe(0)
    expect(fake.attached).toBe(true)
    expect(fake.compiledAttached).toBe(true)
  })

  it('coalesces identical concurrent finalizers', async () => {
    const fake = new FakeLetta()
    const provisioner = makeProvisioner(fake)
    const importState = await writeReviewedImport(provisioner)

    const first = provisioner.finishHistoryImport(apiKey, importState.finish)
    const second = provisioner.finishHistoryImport(apiKey, importState.finish)
    await expect(Promise.all([first, second])).resolves.toEqual([
      { repositoryId, attached: true },
      { repositoryId, attached: true },
    ])
    expect(fake.attachCalls).toBe(1)
    expect(fake.recompileCalls).toBe(1)
  })

  it('accepts exactly the reviewed files plus Letta config and rejects a deep extra', async () => {
    const accepted = new FakeLetta()
    accepted.files.set('.letta/config.json', '{}')
    const acceptedProvisioner = makeProvisioner(accepted)
    const acceptedImport = await writeReviewedImport(acceptedProvisioner)
    await expect(acceptedProvisioner.finishHistoryImport(apiKey, acceptedImport.finish)).resolves.toEqual({ repositoryId, attached: true })

    const rejected = new FakeLetta()
    const rejectedProvisioner = makeProvisioner(rejected)
    const rejectedImport = await writeReviewedImport(rejectedProvisioner)
    rejected.files.set('sources/test/deep/extra.md', 'extra')
    rejected.advanceRef()
    await expect(rejectedProvisioner.finishHistoryImport(apiKey, rejectedImport.finish)).rejects.toMatchObject({
      publicMessage: expect.stringMatching(/exactly the reviewed import files/),
    })
    expect(rejected.attachCalls).toBe(0)
  })

  it('coalesces only identical starts and rejects a conflicting concurrent start', async () => {
    const fake = new FakeLetta()
    let release: (() => void) | undefined
    fake.retrieveGate = new Promise<void>((resolve) => { release = resolve })
    const provisioner = makeProvisioner(fake)
    const manifest = [{ path, contentBytes: Buffer.byteLength(content), contentSha256: sha256(content) }]
    const first = provisioner.startHistoryImport(apiKey, { agentId, repositoryName: 'Continuity-Test', manifest, allowCreate: true })
    const identical = provisioner.startHistoryImport(apiKey, { agentId, repositoryName: 'continuity-test', manifest, allowCreate: false })
    const conflicting = provisioner.startHistoryImport(apiKey, {
      agentId: 'agent-other',
      repositoryName: 'continuity-test',
      manifest,
      allowCreate: true,
    })

    await expect(conflicting).rejects.toMatchObject({ publicMessage: expect.stringMatching(/different reviewed import/) })
    release?.()
    expect(await identical).toEqual(await first)
    expect(fake.createRepositoryCalls).toBe(1)
  })

  it('reconciles one tagged agent after an ambiguous create failure', async () => {
    const fake = new FakeLetta()
    fake.createAgentError = new Error('connection reset')
    fake.reconcileAfterCreate = true
    const provisioner = makeProvisioner(fake)

    await expect(provisioner.createAgent(apiKey, minimalProvisionRequest())).resolves.toEqual({ agentId })
    expect(fake.lastCreateTags).toEqual([expect.stringMatching(/^continuity-studio-create:/)])
    expect(fake.lastCreateModel).toBe('letta/auto')
  })

  it('reuses a stable creation operation across response-loss retries and concurrent calls', async () => {
    const fake = new FakeLetta()
    const provisioner = makeProvisioner(fake)
    const request = minimalProvisionRequest()
    let release: (() => void) | undefined
    fake.createAgentGate = new Promise<void>((resolve) => { release = resolve })

    const first = provisioner.createAgent(apiKey, request)
    const concurrent = provisioner.createAgent(apiKey, request)
    release?.()
    await expect(Promise.all([first, concurrent])).resolves.toEqual([{ agentId }, { agentId }])
    expect(fake.createAgentCalls).toBe(1)

    fake.reconcileAgent = true
    await expect(provisioner.createAgent(apiKey, request)).resolves.toEqual({ agentId })
    expect(fake.createAgentCalls).toBe(1)
  })

  it('reconciles a response-loss creation after stale tagged-agent listings and a process restart', async () => {
    const fake = new FakeLetta()
    const request = minimalProvisionRequest()
    await expect(makeProvisioner(fake).createAgent(apiKey, request)).resolves.toEqual({ agentId })
    expect(fake.createAgentCalls).toBe(1)

    fake.reconcileAgent = true
    fake.agentVisibilityOverrides.push(false, false, false, false)
    await expect(makeProvisioner(fake).createAgent(apiKey, { ...request, allowCreate: false })).rejects.toMatchObject({
      publicMessage: expect.stringMatching(/reconcile-only retry/),
    })
    expect(fake.createAgentCalls).toBe(1)

    fake.agentVisibilityOverrides.push(false, false, true, true)
    await expect(makeProvisioner(fake).createAgent(apiKey, { ...request, allowCreate: false })).resolves.toEqual({ agentId })
    expect(fake.createAgentCalls).toBe(1)
  })

  it('reconciles a response-loss history start after stale repository listings and a process restart', async () => {
    const fake = new FakeLetta()
    const request = {
      agentId,
      repositoryName: 'Continuity-Test',
      manifest: [{ path, contentBytes: Buffer.byteLength(content), contentSha256: sha256(content) }],
      allowCreate: true,
    }
    const first = await makeProvisioner(fake).startHistoryImport(apiKey, request)
    expect(fake.createRepositoryCalls).toBe(1)

    fake.repositoryVisibilityOverrides.push(false, false, false, false)
    await expect(makeProvisioner(fake).startHistoryImport(apiKey, { ...request, allowCreate: false })).rejects.toMatchObject({
      publicMessage: expect.stringMatching(/reconcile-only retry/),
    })
    expect(fake.createRepositoryCalls).toBe(1)

    fake.repositoryVisibilityOverrides.push(false, false, true, true)
    await expect(makeProvisioner(fake).startHistoryImport(apiKey, { ...request, allowCreate: false })).resolves.toMatchObject({
      repositoryId: first.repositoryId,
      resumed: true,
    })
    expect(fake.createRepositoryCalls).toBe(1)
  })

  it('rejects mismatched upstream agent identities before lookup, start, or finish mutations', async () => {
    const lookupFake = new FakeLetta()
    lookupFake.retrieveAgentOverrideId = 'agent-other'
    await expect(makeProvisioner(lookupFake).retrieveAgent(apiKey, { agentId })).rejects.toMatchObject({
      publicMessage: expect.stringMatching(/unexpected agent identity/),
    })

    const startFake = new FakeLetta()
    startFake.retrieveAgentOverrideId = 'agent-other'
    await expect(makeProvisioner(startFake).startHistoryImport(apiKey, {
      agentId,
      repositoryName: 'Continuity-Test',
      manifest: [{ path, contentBytes: Buffer.byteLength(content), contentSha256: sha256(content) }],
      allowCreate: true,
    })).rejects.toMatchObject({ publicMessage: expect.stringMatching(/unexpected agent identity/) })
    expect(startFake.createRepositoryCalls).toBe(0)

    const finishFake = new FakeLetta()
    const finishProvisioner = makeProvisioner(finishFake)
    const importState = await writeReviewedImport(finishProvisioner)
    finishFake.retrieveAgentOverrideId = 'agent-other'
    await expect(finishProvisioner.finishHistoryImport(apiKey, importState.finish)).rejects.toMatchObject({
      publicMessage: expect.stringMatching(/unexpected agent identity/),
    })
    expect(finishFake.attachCalls).toBe(0)
  })

  it('does not claim a markerless repository after an ambiguous create failure', async () => {
    const fake = new FakeLetta()
    fake.createRepositoryError = new Error('connection reset')
    fake.repositoryCreated = true
    const provisioner = makeProvisioner(fake)

    await expect(provisioner.startHistoryImport(apiKey, {
      agentId,
      repositoryName: 'Continuity-Test',
      manifest: [{ path, contentBytes: Buffer.byteLength(content), contentSha256: sha256(content) }],
      allowCreate: true,
    })).rejects.toMatchObject({ publicMessage: expect.stringMatching(/was not created by this reviewed import/) })
  })
})

async function writeReviewedImport(provisioner: LettaSdkProvisioner) {
  const start = await provisioner.startHistoryImport(apiKey, {
    agentId,
    repositoryName: 'Continuity-Test',
    manifest: [{ path, contentBytes: Buffer.byteLength(content), contentSha256: sha256(content) }],
    allowCreate: true,
  })
  const batch = await provisioner.importHistoryBatch(apiKey, {
    repositoryId: start.repositoryId,
    manifestSha256: start.manifestSha256,
    files: [{ path, content }],
  })
  return {
    finish: {
      agentId,
      repositoryId: start.repositoryId,
      manifestSha256: start.manifestSha256,
      receipts: [batch.receipt],
    },
  }
}

function makeProvisioner(fake: FakeLetta) {
  return new LettaSdkProvisioner(() => fake, async () => undefined)
}

class FakeLetta implements LettaProvisioningClient {
  files = new Map<string, string>()
  ref = 0
  repositoryCreated = false
  attached = false
  compiledAttached = false
  attachCalls = 0
  detachCalls = 0
  recompileCalls = 0
  createRepositoryCalls = 0
  createAgentCalls = 0
  recompileErrorOnce: Error | null = null
  createAgentError: Error | null = null
  createRepositoryError: Error | null = null
  reconcileAgent = false
  reconcileAfterCreate = false
  agentVisibilityOverrides: boolean[] = []
  repositoryVisibilityOverrides: boolean[] = []
  retrieveAgentOverrideId: string | null = null
  lastCreateTags: string[] = []
  lastCreateModel = ''
  onAttach?: () => void
  onRecompile?: () => void
  attachErrorAfterCommit: Error | null = null
  listAttachmentErrorOnce: Error | null = null
  attachmentVisibilityOverrides: boolean[] = []
  retrieveGate?: Promise<void>
  createAgentGate?: Promise<void>

  async createAgent(request: { tags?: string[]; model: 'letta/auto' }) {
    this.createAgentCalls += 1
    this.lastCreateTags = request.tags ?? []
    this.lastCreateModel = request.model
    await this.createAgentGate
    if (this.createAgentError) {
      if (this.reconcileAfterCreate) this.reconcileAgent = true
      throw this.createAgentError
    }
    return agentId
  }
  async listAgents(query?: { tags?: string[] }) {
    if (query?.tags?.length) {
      const visible = this.agentVisibilityOverrides.length
        ? this.agentVisibilityOverrides.shift()
        : this.reconcileAgent
      return visible ? [{ id: agentId, name: 'Test' }] : []
    }
    return [{ id: agentId, name: 'Test' }]
  }
  async retrieveAgent(id: string) {
    await this.retrieveGate
    return { id: this.retrieveAgentOverrideId ?? id, name: 'Test' }
  }
  async listRepositories() {
    const visible = this.repositoryVisibilityOverrides.length
      ? this.repositoryVisibilityOverrides.shift()
      : this.repositoryCreated
    return {
      repositories: visible ? [{ id: repositoryId, name: 'Continuity-Test' }] : [],
      hasNextPage: false,
    }
  }
  async createRepository(name: string) {
    this.createRepositoryCalls += 1
    if (this.createRepositoryError) throw this.createRepositoryError
    this.repositoryCreated = true
    return { id: repositoryId, name }
  }
  async listRepositoryFiles(_repositoryId: string, query?: { pathPrefix?: string; depth?: number; ref?: string }) {
    const ref = query?.ref ?? this.currentRef()
    const prefix = query?.pathPrefix ? `${query.pathPrefix}/` : ''
    const baseDepth = query?.pathPrefix?.split('/').length ?? 0
    const visibleFiles = [...this.files.keys()].filter((filePath) => {
      if (!filePath.startsWith(prefix)) return false
      return filePath.split('/').length <= baseDepth + (query?.depth ?? 512)
    })
    const directories = new Set<string>()
    for (const filePath of this.files.keys()) {
      const parts = filePath.split('/')
      for (let index = 1; index < parts.length; index += 1) {
        const directory = parts.slice(0, index).join('/')
        if (directory.startsWith(prefix) && directory.split('/').length <= baseDepth + (query?.depth ?? 512)) directories.add(directory)
      }
    }
    return {
      ref,
      files: [
        ...[...directories].map((directory) => ({ path: directory, type: 'directory' as const })),
        ...visibleFiles.map((filePath) => ({ path: filePath, type: 'file' as const })),
      ],
    }
  }
  async readRepositoryFile(_repositoryId: string, query: { path: string; ref?: string }) {
    const value = this.files.get(query.path)
    if (value === undefined) throw Object.assign(new Error('not found'), { status: 404 })
    return {
      path: query.path,
      content: value,
      contentSha256: sha256(value),
      ref: query.ref ?? this.currentRef(),
    }
  }
  async createRepositoryFile(_repositoryId: string, file: { path: string; content: string }) {
    this.files.set(file.path, file.content)
    this.advanceRef()
    return {}
  }
  async listAgentRepositories() {
    if (this.listAttachmentErrorOnce) {
      const error = this.listAttachmentErrorOnce
      this.listAttachmentErrorOnce = null
      throw error
    }
    const visible = this.attachmentVisibilityOverrides.length
      ? this.attachmentVisibilityOverrides.shift()
      : this.attached
    return visible ? [{ id: repositoryId, permissions: 'read' }] : []
  }
  async attachAgentRepository() {
    this.attachCalls += 1
    this.attached = true
    this.onAttach?.()
    if (this.attachErrorAfterCommit) {
      const error = this.attachErrorAfterCommit
      this.attachErrorAfterCommit = null
      throw error
    }
    return {}
  }
  async detachAgentRepository() {
    this.detachCalls += 1
    this.attached = false
    return {}
  }
  async recompileAgent() {
    this.recompileCalls += 1
    if (this.recompileErrorOnce) {
      const error = this.recompileErrorOnce
      this.recompileErrorOnce = null
      throw error
    }
    this.compiledAttached = this.attached
    this.onRecompile?.()
    return {}
  }
  advanceRef() { this.ref += 1 }
  currentRef() { return `ref-${this.ref}` }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function minimalProvisionRequest() {
  return {
    operationId: '00000000-0000-4000-8000-000000000001',
    allowCreate: true,
    name: 'Test',
    memory: [
      { label: 'persona', description: 'Who the test agent is.', value: 'A complete test persona.' },
      { label: 'human', description: 'Who the test human is.', value: 'A complete test human.' },
      { label: 'relationship', description: 'How the test pair works.', value: 'A complete test relationship.' },
    ],
  }
}
