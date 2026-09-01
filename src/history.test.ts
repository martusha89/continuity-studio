import { describe, expect, it } from 'vitest'
import { historySlug, isCanonicalHistoryPath } from './history-contract'
import { inferMappings, normalizeUtc, parseSourceDump, renderHistory } from './history'

const specimen = {
  exported_at: '2026-08-24T06:58:19.850Z',
  schema_version: '0.1',
  counts: { memories: 2, bones: 1 },
  tables: {
    memories: [
      { id: 1, body: 'old', weight: 0, private: 0, created_at: '2026-06-01 15:04:46', embedding: null },
      { id: 2, body: 'secret', weight: 5, private: 1, created_at: '2026-06-02 15:04:46', embedding: null },
    ],
    bones: [{ id: 1, key: 'anchor', value: 'true thing', category: 'identity', updated_at: '2026-05-28 23:20:15' }],
  },
}

describe('history mapping', () => {
  it('inspects arbitrary table arrays and infers common columns', () => {
    const dump = parseSourceDump(specimen)
    const mappings = inferMappings(dump)
    expect(mappings.find((item) => item.table === 'memories')).toEqual(expect.objectContaining({ idColumn: 'id', contentColumn: 'body', privacyColumn: 'private' }))
    expect(mappings.find((item) => item.table === 'bones')).toEqual(expect.objectContaining({ contentColumn: 'value', titleColumn: 'key' }))
  })

  it('excludes private rows and renders deterministic, provenance-labelled paths', () => {
    const dump = parseSourceDump(specimen)
    const preview = renderHistory(dump, inferMappings(dump), { sourceSlug: 'My Memory', includePrivate: false })
    expect(preview.included).toBe(2)
    expect(preview.excludedPrivate).toBe(1)
    expect(preview.invalid).toBe(0)
    expect(preview.files.map((file) => file.path)).toEqual([
      'sources/my-memory/README.md',
      'sources/my-memory/bones/1.md',
      'sources/my-memory/memories/1.md',
    ])
    expect(preview.files[2].content).toContain('2026-06-01 15:04:46')
    expect(preview.files[2].content).toContain('untrusted reference material')
    expect(preview.files[2].content).not.toContain('embedding')
  })

  it('treats timezone-less SQLite timestamps as UTC', () => {
    expect(normalizeUtc('2026-06-01 15:04:46')).toBe('2026-06-01T15:04:46Z')
  })

  it('only converts ambiguous timestamps when the user chooses UTC', () => {
    const dump = parseSourceDump(specimen)
    const preview = renderHistory(dump, inferMappings(dump), { sourceSlug: 'source', includePrivate: false, timezonePolicy: 'utc' })
    expect(preview.files.find((file) => file.path.includes('memories/1'))?.content).toContain('2026-06-01T15:04:46Z')
  })

  it('recognizes common private markers without interpreting source-specific weight fields', () => {
    const dump = parseSourceDump({ rows: [{ id: 1, text: 'hidden', private: 'YES', weight: 0 }, { id: 2, text: 'shown', private: 'no', weight: 0 }] })
    const preview = renderHistory(dump, inferMappings(dump), { sourceSlug: 'source', includePrivate: false })
    expect(preview.excludedPrivate).toBe(1)
    expect(preview.included).toBe(1)
    expect(preview).not.toHaveProperty('dormant')
  })

  it('refuses duplicate stable identities instead of producing colliding files', () => {
    const dump = parseSourceDump({ rows: [{ id: 1, text: 'one' }, { id: 1, text: 'two' }] })
    const preview = renderHistory(dump, inferMappings(dump), { sourceSlug: 'source', includePrivate: false })
    expect(preview.included).toBe(1)
    expect(preview.invalid).toBe(1)
    expect(preview.warnings).toContain('rows: stable ID “1” produces a duplicate destination path.')
  })

  it('keeps boundary-length slugs canonical after truncation', () => {
    const slug = historySlug(`${'a'.repeat(79)} separator`)
    expect(slug).toBe('a'.repeat(79))
    expect(isCanonicalHistoryPath(`sources/${slug}/records/1.md`)).toBe(true)
  })
})
