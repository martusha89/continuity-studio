import { z } from 'zod'
import {
  MAX_HISTORY_CONTENT_BYTES,
  MAX_HISTORY_FILE_BYTES,
  MAX_HISTORY_FILES,
  MAX_HISTORY_PATH_DEPTH,
  isCanonicalHistoryPath,
} from '../src/history-contract.js'

const nonEmpty = z.string().trim().min(1)

export const provisionRequestSchema = z.strictObject({
  operationId: z.string().regex(/^[a-z0-9-]{16,64}$/i),
  allowCreate: z.boolean(),
  name: nonEmpty.max(120),
  memory: z.array(
    z.object({
      label: nonEmpty.regex(/^[a-z0-9][a-z0-9_-]*$/i).max(100),
      description: z.string().trim().min(10).max(1_000),
      value: nonEmpty.max(48_000),
    }),
  ).max(32).superRefine((memory, context) => {
    const labels = new Set<string>()
    memory.forEach((block, index) => {
      const label = block.label.toLowerCase()
      if (labels.has(label)) {
        context.addIssue({
          code: 'custom',
          message: `Memory label "${block.label}" must be unique.`,
          path: [index, 'label'],
        })
      }
      labels.add(label)
    })

    for (const required of ['persona', 'human', 'relationship'] as const) {
      const requiredBlock = memory.find((block) => block.label.toLowerCase() === required)
      if (!requiredBlock) {
        context.addIssue({
          code: 'custom',
          message: `The ${required} block must be included in memory.`,
        })
      } else if (requiredBlock.value.replace(/^#+\s+.*$/gm, '').trim().length < 10) {
        context.addIssue({
          code: 'custom',
          message: `The ${required} block must contain meaningful detail beyond its heading.`,
        })
      }
    }
  }),
})

export type ProvisionRequest = z.infer<typeof provisionRequestSchema>

export const existingAgentRequestSchema = z.object({
  agentId: nonEmpty.regex(/^agent-[a-z0-9-]+$/i).max(120),
})

export type ExistingAgentRequest = z.infer<typeof existingAgentRequestSchema>

const utf8Bytes = (value: string) => Buffer.byteLength(value, 'utf8')

const historyPathSchema = nonEmpty.max(500).refine(
  (path) => isCanonicalHistoryPath(path) && path.split('/').length <= MAX_HISTORY_PATH_DEPTH,
  'History paths must use canonical safe segments beneath sources/<source>/.',
)

const historyFileSchema = z.object({
  path: historyPathSchema,
  content: z.string().refine(
    (content) => utf8Bytes(content) <= MAX_HISTORY_FILE_BYTES,
    'File content must be at most 1 MiB of UTF-8 data.',
  ),
})

const uniquePaths = (
  files: Array<{ path: string }>,
  context: z.RefinementCtx,
) => {
  const paths = new Set<string>()
  files.forEach((file, index) => {
    const path = file.path.toLowerCase()
    if (paths.has(path)) {
      context.addIssue({
        code: 'custom',
        message: `History file path "${file.path}" must be unique.`,
        path: [index, 'path'],
      })
    }
    paths.add(path)
  })
}

export const historyImportStartRequestSchema = z.object({
  agentId: nonEmpty.regex(/^agent-[a-z0-9-]+$/i).max(120),
  repositoryName: nonEmpty.regex(/^[a-z0-9._-]+$/i).max(64),
  allowCreate: z.boolean(),
  manifest: z.array(z.object({
    path: historyPathSchema,
    contentBytes: z.number().int().min(0).max(MAX_HISTORY_FILE_BYTES),
    contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })).min(1).max(MAX_HISTORY_FILES).superRefine((files, context) => {
    uniquePaths(files, context)
    const contentBytes = files.reduce((total, file) => total + file.contentBytes, 0)

    if (contentBytes > MAX_HISTORY_CONTENT_BYTES) {
      context.addIssue({
        code: 'custom',
        message: 'History content must be at most 25 MiB of UTF-8 data in aggregate.',
      })
    }
  }),
})

export const historyImportBatchRequestSchema = z.object({
  repositoryId: nonEmpty.regex(/^[a-z0-9-]+$/i).max(120),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  files: z.array(historyFileSchema).min(1).max(10).superRefine(uniquePaths),
})

export const historyImportFinishRequestSchema = z.object({
  agentId: nonEmpty.regex(/^agent-[a-z0-9-]+$/i).max(120),
  repositoryId: nonEmpty.regex(/^[a-z0-9-]+$/i).max(120),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  receipts: z.array(z.object({
    paths: z.array(historyPathSchema).min(1).max(10),
    signature: z.string().regex(/^[a-f0-9]{64}$/),
  })).min(1).max(200),
})

export type HistoryImportStartRequest = z.infer<typeof historyImportStartRequestSchema>
export type HistoryImportBatchRequest = z.infer<typeof historyImportBatchRequestSchema>
export type HistoryImportFinishRequest = z.infer<typeof historyImportFinishRequestSchema>
