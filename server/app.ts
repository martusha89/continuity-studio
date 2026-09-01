import { serveStatic } from '@hono/node-server/serve-static'
import { Hono, type MiddlewareHandler } from 'hono'
import { secureHeaders } from 'hono/secure-headers'
import type { LettaProvisioner } from './provisioner.js'
import { ProvisioningUnavailableError, PublicProvisioningError } from './provisioner.js'
import { upstreamStatus } from './letta-sdk-provisioner.js'
import {
  historyImportBatchRequestSchema,
  historyImportFinishRequestSchema,
  historyImportStartRequestSchema,
  existingAgentRequestSchema,
  provisionRequestSchema,
} from './schema.js'

const MAX_PROVISION_BODY_BYTES = 2 * 1024 * 1024
const MAX_HISTORY_START_BODY_BYTES = 2 * 1024 * 1024
const MAX_HISTORY_BATCH_BODY_BYTES = 11 * 1024 * 1024
const MAX_HISTORY_FINISH_BODY_BYTES = 1024 * 1024
const MAX_AGENT_LOOKUP_BODY_BYTES = 16 * 1024

export function createApp(provisioner: LettaProvisioner) {
  const app = new Hono()

  app.use('*', secureHeaders())

  const jsonRoutes: Array<[string, number]> = [
    ['/api/provision', MAX_PROVISION_BODY_BYTES],
    ['/api/agents/retrieve', MAX_AGENT_LOOKUP_BODY_BYTES],
    ['/api/history/start', MAX_HISTORY_START_BODY_BYTES],
    ['/api/history/batch', MAX_HISTORY_BATCH_BODY_BYTES],
    ['/api/history/finish', MAX_HISTORY_FINISH_BODY_BYTES],
  ]
  for (const [path, maxSize] of jsonRoutes) {
    app.use(path, async (context, next) => {
      if (!isJsonRequest(context.req.header('content-type'))) {
        return context.json({ error: 'The request Content-Type must be application/json.' }, 415)
      }
      return next()
    })
    app.use(path, boundedBody(maxSize, (context) => context.json({ error: 'The JSON request body is too large.' }, 413)))
  }
  app.get('/api/health', (context) => context.json({ ok: true }))

  app.post('/api/letta/verify', async (context) => {
    const apiKey = bearerKey(context.req.header('authorization'))
    if (!apiKey) {
      return context.json({ error: 'A Letta API key is required.' }, 401)
    }

    try {
      await provisioner.verifyKey(apiKey)
      return context.json({ ok: true })
    } catch (error) {
      if (error instanceof ProvisioningUnavailableError) {
        return context.json({ error: error.message }, 503)
      }
      return context.json({ error: 'Letta rejected the key or could not be reached.' }, 401)
    }
  })

  app.post('/api/provision', async (context) => {
    const apiKey = bearerKey(context.req.header('authorization'))

    if (!apiKey) {
      return context.json({ error: 'A Letta API key is required.' }, 401)
    }

    let body: unknown
    try {
      body = await context.req.json()
    } catch {
      return context.json({ error: 'The request body must be valid JSON.' }, 400)
    }

    const parsed = provisionRequestSchema.safeParse(body)
    if (!parsed.success) {
      return context.json(
        {
          error: 'The generated agent configuration is invalid.',
          fields: parsed.error.flatten().fieldErrors,
        },
        400,
      )
    }

    try {
      const result = await provisioner.createAgent(apiKey, parsed.data)
      return context.json(result, 201)
    } catch (error) {
      if (error instanceof ProvisioningUnavailableError) {
        return context.json({ error: error.message }, 503)
      }
      console.error('Letta provisioning failed.')
      return context.json({ error: 'Letta provisioning failed. Please try again later.' }, 502)
    }
  })

  app.post('/api/history/start', async (context) => {
    const apiKey = bearerKey(context.req.header('authorization'))
    if (!apiKey) return context.json({ error: 'A Letta API key is required.' }, 401)

    let body: unknown
    try {
      body = await context.req.json()
    } catch {
      return context.json({ error: 'The request body must be valid JSON.' }, 400)
    }

    const parsed = historyImportStartRequestSchema.safeParse(body)
    if (!parsed.success) {
      return context.json({
        error: 'The history import request is invalid.',
        fields: parsed.error.flatten().fieldErrors,
      }, 400)
    }

    try {
      if (!provisioner.startHistoryImport) throw new ProvisioningUnavailableError('History import is unavailable.')
      const result = await provisioner.startHistoryImport(apiKey, parsed.data)
      console.info(`History import ${result.resumed ? 'resumed' : 'started'} in repository ${result.repositoryId}.`)
      return context.json(result, 201)
    } catch (error) {
      if (error instanceof ProvisioningUnavailableError) {
        return context.json({ error: error.message }, 503)
      }
      if (error instanceof PublicProvisioningError) {
        return context.json({ error: error.publicMessage }, error.status)
      }
      console.error('Letta history import failed.')
      return context.json({ error: 'Letta history import failed. Please try again later.' }, 502)
    }
  })

  app.post('/api/agents/retrieve', async (context) => {
    const apiKey = bearerKey(context.req.header('authorization'))
    if (!apiKey) return context.json({ error: 'A Letta API key is required.' }, 401)
    const parsed = existingAgentRequestSchema.safeParse(await jsonBody(context))
    if (!parsed.success) return context.json({ error: 'Enter a valid Letta agent ID beginning with agent-.' }, 400)
    try {
      if (!provisioner.retrieveAgent) throw new ProvisioningUnavailableError('Agent lookup is unavailable.')
      return context.json(await provisioner.retrieveAgent(apiKey, parsed.data), 200)
    } catch (error) {
      if (error instanceof ProvisioningUnavailableError) return context.json({ error: error.message }, 503)
      console.error('Letta agent lookup failed.')
      const status = upstreamStatus(error)
      if (status === 404) return context.json({ error: 'That agent was not found in the connected Letta account.' }, 404)
      if (status === 401 || status === 403) return context.json({ error: 'Letta rejected the connected credential.' }, 401)
      if (status === 429) return context.json({ error: 'Letta is rate limiting requests. Try again shortly.' }, 429)
      return context.json({ error: 'Letta agent lookup failed. Please try again later.' }, status === 408 ? 503 : 502)
    }
  })

  app.post('/api/history/batch', async (context) => {
    const apiKey = bearerKey(context.req.header('authorization'))
    if (!apiKey) return context.json({ error: 'A Letta API key is required.' }, 401)
    const parsed = historyImportBatchRequestSchema.safeParse(await jsonBody(context))
    if (!parsed.success) return context.json({ error: 'The history batch is invalid.' }, 400)
    try {
      if (!provisioner.importHistoryBatch) throw new ProvisioningUnavailableError('History import is unavailable.')
      const result = await provisioner.importHistoryBatch(apiKey, parsed.data)
      console.info(`History batch completed for repository ${result.repositoryId}: ${result.filesProcessed} processed (${result.filesCreated} created, ${result.filesReused} reused).`)
      return context.json(result, 200)
    } catch (error) {
      if (error instanceof ProvisioningUnavailableError) {
        return context.json({ error: error.message }, 503)
      }
      if (error instanceof PublicProvisioningError) {
        return context.json({ error: error.publicMessage }, error.status)
      }
      console.error('Letta history batch failed.')
      return context.json({ error: 'Letta history import failed. Please try again later.' }, 502)
    }
  })

  app.post('/api/history/finish', async (context) => {
    const apiKey = bearerKey(context.req.header('authorization'))
    if (!apiKey) return context.json({ error: 'A Letta API key is required.' }, 401)
    const parsed = historyImportFinishRequestSchema.safeParse(await jsonBody(context))
    if (!parsed.success) return context.json({ error: 'The history finalization request is invalid.' }, 400)
    try {
      if (!provisioner.finishHistoryImport) throw new ProvisioningUnavailableError('History import is unavailable.')
      const result = await provisioner.finishHistoryImport(apiKey, parsed.data)
      console.info(`History import attached repository ${result.repositoryId} as read-only memory.`)
      return context.json(result, 200)
    } catch (error) {
      if (error instanceof ProvisioningUnavailableError) {
        return context.json({ error: error.message }, 503)
      }
      if (error instanceof PublicProvisioningError) {
        return context.json({ error: error.publicMessage }, error.status)
      }
      console.error('Letta history finalization failed.')
      return context.json({ error: 'Letta history import failed. Please try again later.' }, 502)
    }
  })

  app.use('/*', serveStatic({ root: './dist' }))
  app.get('*', serveStatic({ path: './dist/index.html' }))

  return app
}

function bearerKey(authorization: string | undefined): string | null {
  const match = (authorization ?? '').match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() || null
}

async function jsonBody(context: { req: { json(): Promise<unknown> } }): Promise<unknown> {
  try {
    return await context.req.json()
  } catch {
    return null
  }
}

function isJsonRequest(contentType: string | undefined): boolean {
  return /^(?:application\/json|[^;]+\+json)(?:;|$)/i.test(contentType?.trim() ?? '')
}

function boundedBody(maxBytes: number, onError: Parameters<MiddlewareHandler>[0] extends never ? never : (context: Parameters<MiddlewareHandler>[0]) => Response | Promise<Response>): MiddlewareHandler {
  return async (context, next) => {
    const body = context.req.raw.body
    if (!body) return next()
    const declaredLength = context.req.header('content-length')
    if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxBytes) return onError(context)
    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    let bytes = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maxBytes) {
        await reader.cancel()
        return onError(context)
      }
      chunks.push(value)
    }
    const replay = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      },
    })
    context.req.raw = new Request(context.req.raw, { body: replay, duplex: 'half' } as RequestInit & { duplex: 'half' })
    return next()
  }
}
