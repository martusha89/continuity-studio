export async function readJsonResponse<T>(response: Response, operation: string): Promise<T> {
  const contentType = response.headers.get('content-type') ?? ''
  const text = await response.text()
  if (!isJsonContentType(contentType)) {
    throw new Error(`${operation} ended outside Continuity Studio (HTTP ${response.status}).`)
  }
  let result: T & { error?: string }
  try {
    result = text ? JSON.parse(text) as T & { error?: string } : {} as T & { error?: string }
  } catch {
    throw new Error(`${operation} received invalid JSON from Continuity Studio (HTTP ${response.status}).`)
  }
  if (!response.ok) throw new Error(result.error || `${operation} failed (HTTP ${response.status}).`)
  return result
}

export async function postJson<T>(
  path: string,
  apiKey: string,
  body: unknown,
  operation: string,
): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey.trim()}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })
  return readJsonResponse<T>(response, operation)
}

const isJsonContentType = (contentType: string) =>
  /^(?:application\/json|[^;]+\+json)(?:;|$)/i.test(contentType.trim())
