import { describe, expect, it } from 'vitest'
import type { LettaCreationPreview } from './domain'
import {
  applyMemoryEdits,
  clearMemoryValueEdit,
  memoryIsReady,
  memoryLabelForField,
  renderMemoryBundle,
} from './memory-review'

const preview: LettaCreationPreview = {
  name: 'Rowan',
  memory: [{
    label: 'persona',
    description: 'Who Rowan is and how Rowan approaches the world.',
    value: '# Rowan\n\nA persistent creative companion.',
  }],
}

describe('memory review', () => {
  it('applies direct description and content edits to the creation payload', () => {
    expect(applyMemoryEdits(preview, {
      persona: { description: 'A reviewed purpose.', value: '# Rowan\n\nReviewed content.' },
    }).memory[0]).toEqual({
      label: 'persona',
      description: 'A reviewed purpose.',
      value: '# Rowan\n\nReviewed content.',
    })
  })

  it('regenerates only the edited file body and preserves its reviewed description', () => {
    const edits = {
      persona: { description: 'A reviewed purpose.', value: 'Direct persona edit.' },
      human: { value: 'Direct human edit.' },
    }

    expect(clearMemoryValueEdit(edits, 'persona')).toEqual({
      persona: { description: 'A reviewed purpose.' },
      human: { value: 'Direct human edit.' },
    })
    expect(memoryLabelForField('humanName')).toBe('human')
    expect(memoryLabelForField('identity')).toBe('persona')
  })

  it('requires both a useful description and content beyond headings', () => {
    expect(memoryIsReady(preview.memory[0])).toBe(true)
    expect(memoryIsReady({ ...preview.memory[0], description: 'Short' })).toBe(false)
    expect(memoryIsReady({ ...preview.memory[0], value: '# Rowan' })).toBe(false)
  })

  it('copies explicit file boundaries and MemFS description frontmatter', () => {
    const copied = renderMemoryBundle(preview.memory)

    expect(copied).toContain('<!-- file: system/persona.md -->')
    expect(copied).toContain('description: "Who Rowan is and how Rowan approaches the world."')
    expect(copied).not.toContain('# system/persona.md')
  })
})
