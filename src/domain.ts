export type StudioStep = 'ai' | 'human' | 'relationship' | 'review' | 'connect' | 'history'

export interface PersonaDraft {
  agentName: string
  identity: string
  temperament: string
  voice: string
  values: string
  boundaries: string
  autonomy: string
  humanName: string
  humanContext: string
  communication: string
  support: string
  avoid: string
  relationshipType: string
  relationshipFoundation: string
  decisionMaking: string
  continuity: string
}

export interface MemoryEntry {
  label: string
  description: string
  value: string
}

export interface LettaCreationPreview {
  name: string
  memory: MemoryEntry[]
}

export const initialDraft: PersonaDraft = {
  agentName: '',
  identity: '',
  temperament: '',
  voice: '',
  values: '',
  boundaries: '',
  autonomy: '',
  humanName: '',
  humanContext: '',
  communication: '',
  support: '',
  avoid: '',
  relationshipType: 'Creative partner',
  relationshipFoundation: '',
  decisionMaking: 'Take initiative when consequences are reversible. Ask before destructive, costly, private, or externally binding actions. Disagree honestly, and stop when the human says stop.',
  continuity: 'Use saved memory and retrievable history as context. Never invent a shared past or pretend an interruption did not happen.',
}
