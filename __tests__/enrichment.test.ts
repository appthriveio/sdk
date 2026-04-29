/**
 * Phase G — tests for the SDK 0.2.0 enrichment surface:
 *   - Auto-registration via X-AppThrive-Enrichment-Url + Etag headers
 *   - createEnrichmentHandler HMAC verify, business-error codes,
 *     and Shopify-error mapping
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createClient, AppThriveClient } from '../index'

const SECRET = 'whsk_test_secret'

function baseOpts(overrides: Record<string, unknown> = {}) {
  return {
    orgId: 'org_test',
    appId: 'app_test',
    webhookSecret: SECRET,
    baseUrl: 'https://api.test',
    ...overrides,
  }
}

function mockFetchOk<T>(data: T, responseHeaders: Record<string, string> = {}) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers(responseHeaders),
    json: async () => data,
    text: async () => JSON.stringify(data),
  })
}

async function hmacHexSign(payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

async function buildSignedRequest(
  body: Record<string, unknown>,
  opts: { tsOverride?: number; sigOverride?: string } = {},
): Promise<Request> {
  const ts = opts.tsOverride ?? Math.floor(Date.now() / 1000)
  const raw = JSON.stringify(body)
  const sig = opts.sigOverride ?? (await hmacHexSign(`${ts}.${raw}`))
  return new Request('https://embedup.example/appthrive/enrich', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-AppThrive-Signature': sig,
      'X-AppThrive-Timestamp': String(ts),
    },
    body: raw,
  })
}

const validBody = {
  merchantId: 'mer_1',
  shopId: 'gid://shopify/Shop/1',
  shopDomain: 'foo.myshopify.com',
  requestId: 'req_abc',
  requestedByUserId: 'user_1',
  reason: 'manual_reenrich',
  ts: 1700000000,
}

// ─── Auto-register headers ──────────────────────────────────────────

describe('enrichmentCallbackUrl auto-registration', () => {
  it('rejects invalid URL at constructor', () => {
    expect(() =>
      createClient(baseOpts({ enrichmentCallbackUrl: 'not-a-url' })),
    ).toThrow(/enrichmentCallbackUrl/)
  })

  it('does not send the header when not configured', async () => {
    const spy = mockFetchOk({ eventId: 'evt_1', deduplicated: false, merchantResolved: false })
    const client = createClient(baseOpts({ fetch: spy as unknown as typeof fetch }))
    await client.track({ shopId: 'foo.myshopify.com', eventType: 'app.feature_used' })
    const headers = spy.mock.calls[0][1].headers as Record<string, string>
    expect(headers['X-AppThrive-Enrichment-Url']).toBeUndefined()
    expect(headers['X-AppThrive-Enrichment-Url-Etag']).toBeUndefined()
  })

  it('sends URL header on first call (no cached etag yet)', async () => {
    const spy = mockFetchOk(
      { eventId: 'evt_1', deduplicated: false, merchantResolved: false },
      { 'x-appthrive-enrichment-url-etag': 'etag_abc' },
    )
    const client = createClient(
      baseOpts({
        enrichmentCallbackUrl: 'https://embedup.example/appthrive/enrich',
        fetch: spy as unknown as typeof fetch,
      }),
    )
    await client.track({ shopId: 'foo.myshopify.com', eventType: 'app.feature_used' })
    const headers = spy.mock.calls[0][1].headers as Record<string, string>
    expect(headers['X-AppThrive-Enrichment-Url']).toBe('https://embedup.example/appthrive/enrich')
    // First call has no cached etag yet.
    expect(headers['X-AppThrive-Enrichment-Url-Etag']).toBeUndefined()
  })

  it('caches etag from response and sends it on subsequent calls', async () => {
    const spy = mockFetchOk(
      { eventId: 'evt_1', deduplicated: false, merchantResolved: false },
      { 'x-appthrive-enrichment-url-etag': 'etag_abc' },
    )
    const client = createClient(
      baseOpts({
        enrichmentCallbackUrl: 'https://embedup.example/appthrive/enrich',
        fetch: spy as unknown as typeof fetch,
      }),
    )
    await client.track({ shopId: 'a.myshopify.com', eventType: 'x' })
    await client.track({ shopId: 'b.myshopify.com', eventType: 'y' })
    const second = spy.mock.calls[1][1].headers as Record<string, string>
    expect(second['X-AppThrive-Enrichment-Url']).toBe('https://embedup.example/appthrive/enrich')
    expect(second['X-AppThrive-Enrichment-Url-Etag']).toBe('etag_abc')
  })
})

// ─── createEnrichmentHandler ────────────────────────────────────────

describe('createEnrichmentHandler', () => {
  let upsertSpy: ReturnType<typeof vi.fn>
  let shopFetchSpy: ReturnType<typeof vi.fn>
  let client: AppThriveClient

  beforeEach(() => {
    // upsertMerchant call (POST to /api/ingest/.../merchant) returns the
    // standard Phase F response shape.
    upsertSpy = mockFetchOk({
      merchantId: 'mer_1',
      isNew: false,
      fieldsWritten: ['shopOwnerEmail', 'country', 'currency'],
    })

    // Shopify GraphQL — returns the shop. Used by some tests directly,
    // others override.
    shopFetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        data: {
          shop: {
            id: 'gid://shopify/Shop/1',
            name: 'Acme',
            email: 'owner@acme.com',
            contactEmail: null,
            myshopifyDomain: 'foo.myshopify.com',
            currencyCode: 'USD',
            ianaTimezone: 'America/New_York',
            createdAt: '2024-01-01T00:00:00Z',
            plan: { displayName: 'Shopify', partnerDevelopment: false, shopifyPlus: false },
            billingAddress: {
              address1: '1 Main St',
              address2: null,
              city: 'Brooklyn',
              province: 'NY',
              country: 'United States',
              countryCode: 'US',
              zip: '11201',
              phone: '+15555555555',
            },
          },
        },
      }),
      text: async () => '',
    })

    // Combined fetch: route Shopify hosts to shopFetchSpy, AppThrive
    // ingest to upsertSpy.
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (url.includes('myshopify.com')) return shopFetchSpy(url)
      return upsertSpy(url)
    }) as unknown as typeof fetch

    client = createClient(baseOpts({ fetch: fetchImpl }))
  })

  it('rejects 401 when signature header is missing', async () => {
    const handler = client.createEnrichmentHandler({
      getAccessToken: () => 'shpat_token',
    })
    const req = new Request('https://example/enrich', {
      method: 'POST',
      body: JSON.stringify(validBody),
    })
    const res = await handler(req)
    expect(res.status).toBe(401)
  })

  it('rejects 401 on bad signature', async () => {
    const handler = client.createEnrichmentHandler({
      getAccessToken: () => 'shpat_token',
    })
    const req = await buildSignedRequest(validBody, { sigOverride: 'a'.repeat(64) })
    const res = await handler(req)
    expect(res.status).toBe(401)
  })

  it('rejects 401 on stale timestamp (>5min)', async () => {
    const handler = client.createEnrichmentHandler({
      getAccessToken: () => 'shpat_token',
    })
    const stale = Math.floor(Date.now() / 1000) - 600
    const req = await buildSignedRequest(validBody, { tsOverride: stale })
    const res = await handler(req)
    expect(res.status).toBe(401)
  })

  it('returns 200 NO_SESSION when getAccessToken returns null', async () => {
    const handler = client.createEnrichmentHandler({
      getAccessToken: () => null,
    })
    const req = await buildSignedRequest(validBody)
    const res = await handler(req)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.ok).toBe(false)
    expect(body.code).toBe('NO_SESSION')
  })

  it('happy path: 200 ok=true with fieldsWritten', async () => {
    const onSuccess = vi.fn()
    const handler = client.createEnrichmentHandler({
      getAccessToken: () => 'shpat_token',
      onSuccess,
    })
    const req = await buildSignedRequest(validBody)
    const res = await handler(req)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(body.code).toBeNull()
    expect(body.fieldsWritten).toEqual(['shopOwnerEmail', 'country', 'currency'])
    expect(onSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ merchantId: 'mer_1', shopDomain: 'foo.myshopify.com' }),
      ['shopOwnerEmail', 'country', 'currency'],
    )
  })

  it('returns TOKEN_REVOKED when Shopify GraphQL returns 401', async () => {
    shopFetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 401,
      headers: new Headers(),
      json: async () => ({ errors: [{ message: 'Unauthorized' }] }),
      text: async () => 'Unauthorized',
    })
    const handler = client.createEnrichmentHandler({
      getAccessToken: () => 'shpat_revoked',
    })
    const req = await buildSignedRequest(validBody)
    const res = await handler(req)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.ok).toBe(false)
    expect(body.code).toBe('TOKEN_REVOKED')
  })

  it('returns BAD_REQUEST on malformed payload', async () => {
    const handler = client.createEnrichmentHandler({
      getAccessToken: () => 'shpat_token',
    })
    const req = await buildSignedRequest({ merchantId: 'mer_1' /* missing fields */ } as Record<string, unknown>)
    const res = await handler(req)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.ok).toBe(false)
    expect(body.code).toBe('BAD_REQUEST')
  })
})
