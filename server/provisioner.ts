import type {
  HistoryImportBatchRequest,
  HistoryImportFinishRequest,
  HistoryImportStartRequest,
  ExistingAgentRequest,
  ProvisionRequest,
} from './schema.js'

export interface ProvisionResult {
  agentId: string
}

export interface ExistingAgentResult {
  agentId: string
  name: string
}

export interface HistoryImportStartResult {
  repositoryId: string
  repositoryName: string
  manifestSha256: string
  resumed: boolean
  attached: boolean
}

export interface HistoryImportBatchResult {
  repositoryId: string
  filesProcessed: number
  filesCreated: number
  filesReused: number
  receipt: { paths: string[]; signature: string }
}

export interface HistoryImportFinishResult {
  repositoryId: string
  attached: boolean
}

export interface LettaProvisioner {
  verifyKey(apiKey: string): Promise<void>
  createAgent(apiKey: string, request: ProvisionRequest): Promise<ProvisionResult>
  retrieveAgent?(apiKey: string, request: ExistingAgentRequest): Promise<ExistingAgentResult>
  startHistoryImport?(apiKey: string, request: HistoryImportStartRequest): Promise<HistoryImportStartResult>
  importHistoryBatch?(apiKey: string, request: HistoryImportBatchRequest): Promise<HistoryImportBatchResult>
  finishHistoryImport?(apiKey: string, request: HistoryImportFinishRequest): Promise<HistoryImportFinishResult>
  /** @deprecated Compatibility seam for existing test adapters. */
  importHistory?: (...args: never[]) => unknown
}

export class UnconfiguredProvisioner implements LettaProvisioner {
  async verifyKey(): Promise<void> {
    throw unavailable()
  }

  async createAgent(): Promise<ProvisionResult> {
    throw unavailable()
  }

  async retrieveAgent(): Promise<ExistingAgentResult> {
    throw unavailable()
  }

  async startHistoryImport(): Promise<HistoryImportStartResult> {
    throw unavailable()
  }

  async importHistoryBatch(): Promise<HistoryImportBatchResult> {
    throw unavailable()
  }

  async finishHistoryImport(): Promise<HistoryImportFinishResult> {
    throw unavailable()
  }
}

const unavailable = () => new ProvisioningUnavailableError(
  'The Letta adapter is not installed in this local prototype.',
)

export class ProvisioningUnavailableError extends Error {}

export class PublicProvisioningError extends Error {
  constructor(
    readonly publicMessage: string,
    readonly status: 409 | 422 | 502 = 409,
  ) {
    super(publicMessage)
    this.name = 'PublicProvisioningError'
  }
}
