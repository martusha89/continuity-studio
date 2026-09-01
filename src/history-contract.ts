export const MAX_HISTORY_SOURCE_BYTES = 20 * 1024 * 1024
export const MAX_HISTORY_FILE_BYTES = 1 * 1024 * 1024
export const MAX_HISTORY_CONTENT_BYTES = 25 * 1024 * 1024
export const MAX_HISTORY_FILES = 2_000
export const MAX_HISTORY_PATH_DEPTH = 5
export const MAX_HISTORY_TABLES = 200
export const MAX_HISTORY_ROWS = 20_000
export const MAX_HISTORY_COLUMNS = 200
export const MAX_HISTORY_WARNINGS = 50

export function historySlug(value: string, fallback = 'source'): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 80)
    .replace(/^-+|-+$/g, '') || fallback
}

export function isCanonicalHistoryPath(path: string): boolean {
  const segments = path.split('/')
  if (segments.length < 3 || segments.length > MAX_HISTORY_PATH_DEPTH || segments[0] !== 'sources') return false
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return false
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(segments[1])) return false
  return segments.slice(2).every((segment) => /^[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$/i.test(segment))
}

export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}
