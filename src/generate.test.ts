import { describe, expect, it } from 'vitest'
import { initialDraft } from './domain'
import { generateLettaPreview, personaReadiness } from './generate'

describe('generateLettaPreview', () => {
  it('creates only reviewed memory and leaves runtime configuration to Letta', () => {
    const preview = generateLettaPreview({ ...initialDraft, agentName: 'Rowan' })
    expect(preview.name).toBe('Rowan')
    expect(preview).not.toHaveProperty('systemPrompt')
    expect(Object.keys(preview)).toEqual(['name', 'memory'])
  })

  it('maps identity, human, and relationship content into distinct memories', () => {
    const preview = generateLettaPreview({
      ...initialDraft,
      agentName: 'Rowan',
      identity: 'A persistent creative partner.',
      humanName: 'Alex',
      humanContext: 'Builds strange and useful things.',
      relationshipFoundation: 'Partners who disagree honestly.',
    })

    expect(preview.memory[0]).toEqual(
      expect.objectContaining({
        label: 'persona',
        description: expect.stringContaining('Who the agent is'),
        value: expect.stringContaining('A persistent creative partner.'),
      }),
    )
    expect(preview.memory[1]).toEqual(
      expect.objectContaining({
        label: 'human',
        description: expect.stringContaining('Persistent context'),
        value: expect.stringContaining('# Alex'),
      }),
    )
    expect(preview.memory[2]).toEqual(
      expect.objectContaining({ label: 'relationship', description: expect.stringContaining('authority') }),
    )
    expect(preview.memory[2]).toEqual(
      expect.objectContaining({ value: expect.stringContaining('Partners who disagree honestly.') }),
    )
  })

  it('does not call a heading-only draft a finished person', () => {
    expect(personaReadiness(initialDraft)).toEqual(expect.objectContaining({ ready: false }))
    expect(personaReadiness({
      ...initialDraft,
      agentName: 'Rowan', identity: 'A persistent collaborator.', voice: 'Direct and warm.',
      humanName: 'Alex', humanContext: 'Builds useful things.', communication: 'Say the real thing.',
      relationshipFoundation: 'Partners who disagree honestly.', decisionMaking: 'Lead when reversible.',
    })).toEqual({ ready: true, missing: [] })
  })
})
