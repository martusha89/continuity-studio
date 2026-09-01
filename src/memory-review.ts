import type { LettaCreationPreview, MemoryEntry, PersonaDraft } from './domain'

export type MemoryEdits = Record<string, Partial<Pick<MemoryEntry, 'description' | 'value'>>>

const fieldMemoryLabels: Record<keyof PersonaDraft, string> = {
  agentName: 'persona',
  identity: 'persona',
  temperament: 'persona',
  voice: 'persona',
  values: 'persona',
  boundaries: 'persona',
  autonomy: 'persona',
  humanName: 'human',
  humanContext: 'human',
  communication: 'human',
  support: 'human',
  avoid: 'human',
  relationshipType: 'relationship',
  relationshipFoundation: 'relationship',
  decisionMaking: 'relationship',
  continuity: 'relationship',
}

export const memoryLabelForField = (field: keyof PersonaDraft) => fieldMemoryLabels[field]

export const memoryPath = (label: string) => `system/${label}.md`

export function applyMemoryEdits(preview: LettaCreationPreview, edits: MemoryEdits): LettaCreationPreview {
  return {
    ...preview,
    memory: preview.memory.map((entry) => ({ ...entry, ...edits[entry.label] })),
  }
}

export const hasMemoryValueEdit = (edits: MemoryEdits, label: string) => edits[label]?.value !== undefined

export function clearMemoryValueEdit(edits: MemoryEdits, label: string): MemoryEdits {
  const edit = edits[label]
  if (edit?.value === undefined) return edits

  const { value: _discarded, ...remaining } = edit
  const next = { ...edits }
  if (Object.keys(remaining).length) next[label] = remaining
  else delete next[label]
  return next
}

export function memoryIsReady(entry: MemoryEntry): boolean {
  const content = entry.value.replace(/^#+\s+.*$/gm, '').trim()
  return entry.description.trim().length >= 10 && content.length >= 10
}

export function renderMemoryBundle(memory: MemoryEntry[]): string {
  return memory.map((entry) => [
    `<!-- file: ${memoryPath(entry.label)} -->`,
    '---',
    `description: ${JSON.stringify(entry.description.trim())}`,
    '---',
    '',
    entry.value,
  ].join('\n')).join('\n\n')
}
