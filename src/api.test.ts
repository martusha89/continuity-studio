import { describe, expect, it } from 'vitest'
import { readJsonResponse } from './api'

describe('API response handling', () => {
  it('accepts JSON with content-type parameters', async () => {
    const response = new Response('{"ok":true}', { headers: { 'content-type': 'application/json; charset=utf-8' } })
    await expect(readJsonResponse<{ ok: boolean }>(response, 'Verification')).resolves.toEqual({ ok: true })
  })

  it('does not reflect non-JSON proxy bodies', async () => {
    const response = new Response('<html>upstream timeout</html>', {
      status: 504,
      headers: { 'content-type': 'text/html' },
    })
    await expect(readJsonResponse(response, 'Agent creation')).rejects.toThrow(
      'Agent creation ended outside Continuity Studio (HTTP 504).',
    )
  })

  it('distinguishes malformed JSON from an application error', async () => {
    const response = new Response('{broken', { status: 502, headers: { 'content-type': 'application/json' } })
    await expect(readJsonResponse(response, 'Verification')).rejects.toThrow(
      'Verification received invalid JSON from Continuity Studio (HTTP 502).',
    )
  })

  it('uses the server error from valid failed JSON responses', async () => {
    const response = new Response('{"error":"No such agent."}', {
      status: 404,
      headers: { 'content-type': 'application/problem+json' },
    })
    await expect(readJsonResponse(response, 'Agent lookup')).rejects.toThrow('No such agent.')
  })
})
