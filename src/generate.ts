import type { LettaCreationPreview, PersonaDraft } from './domain'

const section = (title: string, value: string) =>
  value.trim() ? `## ${title}\n\n${value.trim()}` : ''

const joinSections = (...sections: string[]) => sections.filter(Boolean).join('\n\n')

export function generateLettaPreview(draft: PersonaDraft): LettaCreationPreview {
  const name = draft.agentName.trim() || 'Untitled agent'
  const humanName = draft.humanName.trim() || 'The human'

  const persona = joinSections(
    `# ${name}`,
    section('Identity', draft.identity),
    section('Temperament', draft.temperament),
    section('Voice', draft.voice),
    section('Values', draft.values),
    section('Boundaries', draft.boundaries),
    section('Agency and initiative', draft.autonomy),
  )

  const human = joinSections(
    `# ${humanName}`,
    section('Context', draft.humanContext),
    section('Communication', draft.communication),
    section('What good support looks like', draft.support),
    section('Avoid', draft.avoid),
  )

  const relationship = joinSections(
    '# Relationship and collaboration',
    section('Model', draft.relationshipType),
    section('Foundation', draft.relationshipFoundation),
    section('Decision-making', draft.decisionMaking),
    section('Continuity', draft.continuity),
  )
  return {
    name,
    memory: [
      {
        label: 'persona',
        description: 'Who the agent is, what they value, and how they communicate.',
        value: persona,
      },
      {
        label: 'human',
        description: 'Persistent context about the human and how to support them.',
        value: human,
      },
      {
        label: 'relationship',
        description: 'The authority, trust, decisions, and continuity rules for this relationship.',
        value: relationship,
      },
    ],
  }
}

export function completionForStep(step: string, draft: PersonaDraft): number {
  const fields: Record<string, Array<keyof PersonaDraft>> = {
    ai: ['agentName', 'identity', 'voice'],
    human: ['humanName', 'humanContext', 'communication'],
    relationship: ['relationshipType', 'relationshipFoundation', 'decisionMaking'],
  }
  const required = fields[step] ?? []
  if (!required.length) return 100
  return Math.round(
    (required.filter((field) => draft[field].trim().length > 0).length / required.length) * 100,
  )
}

export const requiredPersonaFields: Array<keyof PersonaDraft> = [
  'agentName',
  'identity',
  'voice',
  'humanName',
  'humanContext',
  'communication',
  'relationshipFoundation',
  'decisionMaking',
]

export function personaReadiness(draft: PersonaDraft): { ready: boolean; missing: Array<keyof PersonaDraft> } {
  const missing = requiredPersonaFields.filter((field) => draft[field].trim().length === 0)
  return { ready: missing.length === 0, missing }
}
