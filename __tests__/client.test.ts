import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createClient, AppThriveClient, AppThriveError } from '../index'

function baseOpts(overrides: Record<string, unknown> = {}) {
  return {
    orgId: 'org_test',
    appId: 'app_test',
    webhookSecret: 'whsk_test_secret',
    baseUrl: 'https://api.test',
    ...overrides,
  }
}

function mockFetchOk<T>(data: T, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status,
    headers: new Headers(),
    json: async () => data,
    text: async () => JSON.stringify(data),
  })
}

function mockFetchErr(status: number, error = 'oops', extraHeaders: Record<string, string> = {}) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    headers: new Headers(extraHeaders),
    json: async () => ({ error }),
    text: async () => JSON.stringify({ error }),
  })
}

describe('AppThriveClient constructor', () => {
  it('requires orgId, appId, webhookSecret', () => {
    expect(() => createClient(baseOpts({ orgId: '' }))).toThrow(/orgId/)
    expect(() => createClient(baseOpts({ appId: '' }))).toThrow(/appId/)
    expect(() => createClient(baseOpts({ webhookSecret: '' }))).toThrow(/webhookSecret/)
  })

  it('accepts a custom fetch', () => {
    const c = createClient(baseOpts({ fetch: mockFetchOk({}) }))
    expect(c).toBeInstanceOf(AppThriveClient)
  })

  it('strips trailing slashes from baseUrl', async () => {
    const spy = mockFetchOk({ eventId: 'evt_1', deduplicated: false, merchantResolved: false })
    const c = createClient(
      baseOpts({ baseUrl: 'https://api.test///', fetch: spy as unknown as typeof fetch }),
    )
    await c.track({ shopId: 's', eventType: 'x' })
    expect(spy.mock.calls[0]?.[0]).toBe('https://api.test/api/ingest/org_test/app_test')
  })
})

describe('track', () => {
  let spy: ReturnType<typeof vi.fn>
  let client: AppThriveClient

  beforeEach(() => {
    spy = mockFetchOk({ eventId: 'evt_1', deduplicated: false, merchantResolved: true })
    client = createClient(baseOpts({ fetch: spy as unknown as typeof fetch }))
  })

  it('POSTs to the events ingest path', async () => {
    await client.track({ shopId: 'foo.myshopify.com', eventType: 'app.feature_used' })
    const [url, init] = spy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.test/api/ingest/org_test/app_test')
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers['X-AppThrive-Timestamp']).toMatch(/^\d+$/)
    expect(headers['X-AppThrive-Signature']).toMatch(/^[0-9a-f]{64}$/)
  })

  it('forwards idempotencyKey as header', async () => {
    await client.track({
      shopId: 's',
      eventType: 'x',
      idempotencyKey: 'abc-123',
    })
    const headers = (spy.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>
    expect(headers['X-AppThrive-Idempotency-Key']).toBe('abc-123')
  })

  it('serializes `at` to ISO string', async () => {
    const at = new Date('2026-04-17T10:00:00Z')
    await client.track({ shopId: 's', eventType: 'x', at })
    const body = JSON.parse((spy.mock.calls[0]?.[1] as RequestInit).body as string) as {
      occurredAt: string
    }
    expect(body.occurredAt).toBe('2026-04-17T10:00:00.000Z')
  })

  it('returns parsed server response', async () => {
    const result = await client.track({ shopId: 's', eventType: 'x' })
    expect(result).toEqual({ eventId: 'evt_1', deduplicated: false, merchantResolved: true })
  })
})

describe('incrementMetric / setMetric', () => {
  let spy: ReturnType<typeof vi.fn>
  let client: AppThriveClient

  beforeEach(() => {
    spy = mockFetchOk({
      ok: true,
      merchantId: 'mer_1',
      hourlyRollupId: 'mm_1',
      dailyRollupId: 'mm_2',
      allTimeRollupId: 'mm_3',
      aggregation: 'sum',
    })
    client = createClient(baseOpts({ fetch: spy as unknown as typeof fetch }))
  })

  it('POSTs to the metric ingest path', async () => {
    await client.incrementMetric({
      shopId: 'foo.myshopify.com',
      metric: 'variant_revenue',
      value: 4200,
    })
    const [url] = spy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.test/api/ingest/org_test/app_test/metric')
  })

  it('rejects non-finite values', async () => {
    await expect(
      client.incrementMetric({ shopId: 's', metric: 'm', value: Number.NaN }),
    ).rejects.toThrow(/finite/)
    await expect(client.setMetric({ shopId: 's', metric: 'm', value: Infinity })).rejects.toThrow(
      /finite/,
    )
  })

  it('setMetric hits the same endpoint as incrementMetric', async () => {
    await client.setMetric({ shopId: 's', metric: 'm', value: 1 })
    const url = spy.mock.calls[0]?.[0]
    expect(url).toBe('https://api.test/api/ingest/org_test/app_test/metric')
  })
})

describe('error mapping', () => {
  it('maps 401 → UNAUTHORIZED', async () => {
    const spy = mockFetchErr(401, 'bad signature')
    const c = createClient(baseOpts({ fetch: spy as unknown as typeof fetch }))
    const err = await c.track({ shopId: 's', eventType: 'x' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AppThriveError)
    expect((err as AppThriveError).code).toBe('UNAUTHORIZED')
    expect((err as AppThriveError).status).toBe(401)
  })

  it('maps 429 → RATE_LIMITED and extracts Retry-After', async () => {
    const spy = mockFetchErr(429, 'rate limited', { 'Retry-After': '30' })
    const c = createClient(baseOpts({ fetch: spy as unknown as typeof fetch }))
    const err = await c.track({ shopId: 's', eventType: 'x' }).catch((e: unknown) => e)
    expect((err as AppThriveError).code).toBe('RATE_LIMITED')
    expect((err as AppThriveError).retryAfterSeconds).toBe(30)
  })

  it('maps 500 → SERVER_ERROR', async () => {
    const spy = mockFetchErr(500, 'oops')
    const c = createClient(baseOpts({ fetch: spy as unknown as typeof fetch }))
    const err = await c.track({ shopId: 's', eventType: 'x' }).catch((e: unknown) => e)
    expect((err as AppThriveError).code).toBe('SERVER_ERROR')
  })

  it('maps fetch rejection → NETWORK_ERROR', async () => {
    const spy = vi.fn().mockRejectedValue(new Error('ECONNRESET'))
    const c = createClient(baseOpts({ fetch: spy as unknown as typeof fetch }))
    const err = await c.track({ shopId: 's', eventType: 'x' }).catch((e: unknown) => e)
    expect((err as AppThriveError).code).toBe('NETWORK_ERROR')
  })
})

describe('signature integrity', () => {
  it('signature changes when body changes', async () => {
    const spy = mockFetchOk({ eventId: 'evt_1', deduplicated: false, merchantResolved: false })
    const c = createClient(baseOpts({ fetch: spy as unknown as typeof fetch }))
    await c.track({ shopId: 'a', eventType: 'x' })
    await c.track({ shopId: 'b', eventType: 'x' })
    const sig1 = (spy.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>
    const sig2 = (spy.mock.calls[1]?.[1] as RequestInit).headers as Record<string, string>
    expect(sig1['X-AppThrive-Signature']).not.toBe(sig2['X-AppThrive-Signature'])
  })

  it('signature is 64-char hex (SHA-256)', async () => {
    const spy = mockFetchOk({ eventId: 'evt_1', deduplicated: false, merchantResolved: false })
    const c = createClient(baseOpts({ fetch: spy as unknown as typeof fetch }))
    await c.track({ shopId: 's', eventType: 'x' })
    const headers = (spy.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>
    expect(headers['X-AppThrive-Signature']).toMatch(/^[0-9a-f]{64}$/)
  })
})

// ─── Phase F — merchant enrichment SDK methods ─────────────────────

describe('upsertMerchant', () => {
  let spy: ReturnType<typeof vi.fn>
  let client: AppThriveClient

  beforeEach(() => {
    spy = mockFetchOk({
      merchantId: 'mer_x',
      isNew: false,
      fieldsWritten: ['shop_owner_email'],
      piiBlocked: false,
    })
    client = createClient(baseOpts({ fetch: spy as unknown as typeof fetch }))
  })

  it('POSTs to the /merchant ingest path', async () => {
    await client.upsertMerchant({ shopId: 'foo.myshopify.com', shopOwnerEmail: 'owner@foo.com' })
    const [url, init] = spy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.test/api/ingest/org_test/app_test/merchant')
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers['X-AppThrive-Signature']).toMatch(/^[0-9a-f]{64}$/)
  })

  it('serializes only fields the caller supplied — no nulls leak from undefineds', async () => {
    await client.upsertMerchant({ shopId: 's', shopOwnerEmail: 'a@b.co' })
    const body = JSON.parse((spy.mock.calls[0]?.[1] as RequestInit).body as string) as Record<
      string,
      unknown
    >
    expect(body.shopId).toBe('s')
    expect(body.shopOwnerEmail).toBe('a@b.co')
    expect('shopOwnerName' in body).toBe(false)
    expect('shopifyPlan' in body).toBe(false)
    expect('customAttributes' in body).toBe(false)
  })

  it('preserves explicit null values to clear typed fields', async () => {
    await client.upsertMerchant({ shopId: 's', shopOwnerEmail: null })
    const body = JSON.parse((spy.mock.calls[0]?.[1] as RequestInit).body as string) as Record<
      string,
      unknown
    >
    expect(body.shopOwnerEmail).toBeNull()
  })

  it('serializes Date shopifyCreatedAt to ISO-8601', async () => {
    const d = new Date('2026-01-01T00:00:00Z')
    await client.upsertMerchant({ shopId: 's', shopifyCreatedAt: d })
    const body = JSON.parse((spy.mock.calls[0]?.[1] as RequestInit).body as string) as Record<
      string,
      unknown
    >
    expect(body.shopifyCreatedAt).toBe('2026-01-01T00:00:00.000Z')
  })

  it('forwards customAttributes verbatim (server deep-merges)', async () => {
    await client.upsertMerchant({
      shopId: 's',
      customAttributes: { onboardedFlow: 'v2', power_user: true },
    })
    const body = JSON.parse((spy.mock.calls[0]?.[1] as RequestInit).body as string) as Record<
      string,
      unknown
    >
    expect(body.customAttributes).toEqual({ onboardedFlow: 'v2', power_user: true })
  })

  it('forwards idempotencyKey as header AND in body', async () => {
    await client.upsertMerchant({ shopId: 's', idempotencyKey: 'abc-1' })
    const headers = (spy.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>
    const body = JSON.parse((spy.mock.calls[0]?.[1] as RequestInit).body as string) as Record<
      string,
      unknown
    >
    expect(headers['X-AppThrive-Idempotency-Key']).toBe('abc-1')
    expect(body.idempotencyKey).toBe('abc-1')
  })

  it('throws when shopId is missing', async () => {
    // @ts-expect-error — testing runtime guard
    await expect(client.upsertMerchant({ shopOwnerEmail: 'x@y.co' })).rejects.toThrow(/shopId/)
  })

  it('returns the parsed result body', async () => {
    const r = await client.upsertMerchant({ shopId: 's', shopOwnerEmail: 'a@b.co' })
    expect(r).toEqual({
      merchantId: 'mer_x',
      isNew: false,
      fieldsWritten: ['shop_owner_email'],
      piiBlocked: false,
    })
  })

  it('surfaces 410 piiBlocked as an AppThriveError', async () => {
    const err = mockFetchErr(410, 'merchant in redaction window')
    const c = createClient(baseOpts({ fetch: err as unknown as typeof fetch }))
    await expect(c.upsertMerchant({ shopId: 's', shopOwnerEmail: 'a@b.co' })).rejects.toBeInstanceOf(
      AppThriveError,
    )
  })
})

describe('bulkUpsertMerchants', () => {
  it('POSTs to /merchant/bulk with merchants array', async () => {
    const spy = mockFetchOk({
      results: [
        { shopId: 's1', merchantId: 'mer_1', isNew: false, fieldsWritten: [], piiBlocked: false },
      ],
    })
    const c = createClient(baseOpts({ fetch: spy as unknown as typeof fetch }))
    await c.bulkUpsertMerchants([{ shopId: 's1', shopOwnerEmail: 'a@b.co' }])
    const [url, init] = spy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.test/api/ingest/org_test/app_test/merchant/bulk')
    const body = JSON.parse((init.body as string)) as { merchants: Array<{ shopId: string }> }
    expect(body.merchants).toHaveLength(1)
    expect(body.merchants[0]?.shopId).toBe('s1')
  })

  it('rejects empty arrays', async () => {
    const c = createClient(baseOpts({ fetch: mockFetchOk({}) as unknown as typeof fetch }))
    await expect(c.bulkUpsertMerchants([])).rejects.toThrow(/empty/)
  })

  it('rejects oversized arrays (> MAX_BATCH_SIZE)', async () => {
    const c = createClient(baseOpts({ fetch: mockFetchOk({}) as unknown as typeof fetch }))
    const big = Array.from({ length: 101 }, (_, i) => ({ shopId: `s${i}` }))
    await expect(c.bulkUpsertMerchants(big)).rejects.toThrow(/<=/)
  })

  it('rejects items missing shopId', async () => {
    const c = createClient(baseOpts({ fetch: mockFetchOk({}) as unknown as typeof fetch }))
    await expect(
      // @ts-expect-error — testing runtime guard
      c.bulkUpsertMerchants([{ shopOwnerEmail: 'a@b.co' }]),
    ).rejects.toThrow(/shopId/)
  })

  it('returns server response verbatim including per-item errors', async () => {
    const spy = mockFetchOk({
      results: [
        { shopId: 's1', merchantId: 'mer_1', isNew: true, fieldsWritten: ['shop_owner_email'], piiBlocked: false },
        { shopId: 's2', error: 'shopOwnerEmail: invalid email' },
      ],
    })
    const c = createClient(baseOpts({ fetch: spy as unknown as typeof fetch }))
    const r = await c.bulkUpsertMerchants([
      { shopId: 's1', shopOwnerEmail: 'a@b.co' },
      { shopId: 's2', shopOwnerEmail: 'malformed' },
    ])
    expect(r.results).toHaveLength(2)
    expect('error' in r.results[1]!).toBe(true)
  })
})

// ─── Phase F.4 — bootstrap() one-liner ───────────────────────────

describe('bootstrap', () => {
  /**
   * The bootstrap method makes 3 + N HTTP calls per invocation:
   *   1. Shopify GraphQL { shop { ... } }
   *   2. AppThrive POST /merchant
   *   3..N. Shopify GraphQL webhookSubscriptionCreate (one per topic)
   *
   * We script a single mock fetch with a queue of canned responses so
   * tests can assert ordering, request bodies, and tolerate partial
   * failures.
   */
  function queuedFetch(scripts: Array<{ ok?: boolean; status?: number; data: unknown }>) {
    let i = 0
    return vi.fn().mockImplementation(() => {
      const s = scripts[i++] ?? { ok: true, status: 200, data: {} }
      return Promise.resolve({
        ok: s.ok ?? true,
        status: s.status ?? 200,
        headers: new Headers(),
        json: async () => s.data,
        text: async () => JSON.stringify(s.data),
      })
    })
  }

  const SHOP_RESPONSE = {
    data: {
      shop: {
        id: 'gid://shopify/Shop/12345',
        name: 'Acme Co',
        email: 'owner@acme.com',
        contactEmail: 'support@acme.com',
        myshopifyDomain: 'acme.myshopify.com',
        currencyCode: 'USD',
        ianaTimezone: 'America/New_York',
        createdAt: '2024-01-01T00:00:00Z',
        plan: { displayName: 'Shopify', partnerDevelopment: false, shopifyPlus: false },
        billingAddress: {
          address1: '1 Main St',
          address2: null,
          city: 'Springfield',
          province: 'IL',
          country: 'United States',
          countryCode: 'US',
          zip: '62701',
          phone: '+15551234567',
        },
      },
    },
  }

  const UPSERT_RESPONSE = {
    merchantId: 'mer_acme',
    isNew: true,
    fieldsWritten: ['shop_owner_email', 'shop_name', 'address1'],
    piiBlocked: false,
  }

  const WEBHOOK_OK = {
    data: {
      webhookSubscriptionCreate: {
        webhookSubscription: { id: 'gid://shopify/WebhookSubscription/1' },
        userErrors: [],
      },
    },
  }

  it('runs the full happy-path: shop fetch → upsert → 6 webhook registrations', async () => {
    const fetch = queuedFetch([
      { data: SHOP_RESPONSE },
      { data: UPSERT_RESPONSE },
      // 6 default topics, one webhookSubscriptionCreate call each
      { data: WEBHOOK_OK },
      { data: WEBHOOK_OK },
      { data: WEBHOOK_OK },
      { data: WEBHOOK_OK },
      { data: WEBHOOK_OK },
      { data: WEBHOOK_OK },
    ])
    const c = createClient(baseOpts({ fetch: fetch as unknown as typeof fetch }))
    const r = await c.bootstrap({
      shopDomain: 'acme.myshopify.com',
      accessToken: 'shpat_redacted',
    })

    expect(r.merchantId).toBe('mer_acme')
    expect(r.isNew).toBe(true)
    expect(r.webhooksRegistered).toEqual([
      'shop/update',
      'app/uninstalled',
      'app/scopes_update',
      'app_subscriptions/update',
      'app_subscriptions/approaching_capped_amount',
      'app_purchases_one_time/update',
    ])
    expect(r.webhookErrors).toEqual([])
    // No shopifyClientSecret passed → upload was not attempted.
    expect(r.shopifyClientSecretUploaded).toBe(false)
    expect(r.shopifyClientSecretError).toBeNull()

    // Assert call ordering
    expect(fetch.mock.calls[0]?.[0]).toBe(
      'https://acme.myshopify.com/admin/api/2026-04/graphql.json',
    )
    expect(fetch.mock.calls[1]?.[0]).toBe(
      'https://api.test/api/ingest/org_test/app_test/merchant',
    )
    // Webhook calls 2..7 all hit the same Shopify graphql endpoint
    for (let i = 2; i < 8; i++) {
      expect(fetch.mock.calls[i]?.[0]).toBe(
        'https://acme.myshopify.com/admin/api/2026-04/graphql.json',
      )
    }
  })

  it('forwards X-Shopify-Access-Token header on Shopify calls only', async () => {
    const fetch = queuedFetch([
      { data: SHOP_RESPONSE },
      { data: UPSERT_RESPONSE },
      { data: WEBHOOK_OK },
      { data: WEBHOOK_OK },
      { data: WEBHOOK_OK },
      { data: WEBHOOK_OK },
      { data: WEBHOOK_OK },
      { data: WEBHOOK_OK },
    ])
    const c = createClient(baseOpts({ fetch: fetch as unknown as typeof fetch }))
    await c.bootstrap({
      shopDomain: 'acme.myshopify.com',
      accessToken: 'shpat_secret_token',
    })

    // Shopify call
    const shopifyHeaders = (fetch.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>
    expect(shopifyHeaders['X-Shopify-Access-Token']).toBe('shpat_secret_token')
    // AppThrive call — must NOT carry the access token
    const appthriveHeaders = (fetch.mock.calls[1]?.[1] as RequestInit).headers as Record<string, string>
    expect(appthriveHeaders['X-Shopify-Access-Token']).toBeUndefined()
    expect(appthriveHeaders['X-AppThrive-Signature']).toMatch(/^[0-9a-f]{64}$/)
  })

  it('forwards shopDomain alongside the GID so the receiver can populate shop_domain correctly', async () => {
    const fetch = queuedFetch([
      { data: SHOP_RESPONSE },
      { data: UPSERT_RESPONSE },
    ])
    const c = createClient(baseOpts({ fetch: fetch as unknown as typeof fetch }))
    await c.bootstrap({
      shopDomain: 'acme.myshopify.com',
      accessToken: 't',
      webhookTopics: [],
    })
    const upsertBody = JSON.parse((fetch.mock.calls[1]?.[1] as RequestInit).body as string) as {
      shopId: string
      shopDomain: string
    }
    expect(upsertBody.shopId).toBe('gid://shopify/Shop/12345')
    expect(upsertBody.shopDomain).toBe('acme.myshopify.com')
  })

  it('maps Shopify plan to typed enum; "Shopify Plus" → plus', async () => {
    const fetch = queuedFetch([
      {
        data: {
          data: {
            shop: {
              ...SHOP_RESPONSE.data.shop,
              plan: { displayName: 'Shopify Plus', partnerDevelopment: false, shopifyPlus: true },
            },
          },
        },
      },
      { data: UPSERT_RESPONSE },
      // no webhooks
    ])
    const c = createClient(baseOpts({ fetch: fetch as unknown as typeof fetch }))
    await c.bootstrap({
      shopDomain: 'acme.myshopify.com',
      accessToken: 't',
      webhookTopics: [],
    })
    const upsertBody = JSON.parse((fetch.mock.calls[1]?.[1] as RequestInit).body as string) as {
      shopifyPlan: string
    }
    expect(upsertBody.shopifyPlan).toBe('plus')
  })

  it('treats "already exists" Shopify webhook errors as success', async () => {
    const dupErr = {
      data: {
        webhookSubscriptionCreate: {
          webhookSubscription: null,
          userErrors: [{ field: ['callbackUrl'], message: 'Address already exists for this topic' }],
        },
      },
    }
    const fetch = queuedFetch([
      { data: SHOP_RESPONSE },
      { data: UPSERT_RESPONSE },
      { data: dupErr },
      { data: dupErr },
      { data: dupErr },
      { data: dupErr },
      { data: dupErr },
      { data: dupErr },
    ])
    const c = createClient(baseOpts({ fetch: fetch as unknown as typeof fetch }))
    const r = await c.bootstrap({
      shopDomain: 'acme.myshopify.com',
      accessToken: 't',
    })
    expect(r.webhookErrors).toEqual([])
    expect(r.webhooksRegistered).toHaveLength(6)
  })

  it('records webhook registration errors per-topic; merchant upsert still succeeds', async () => {
    const realErr = {
      data: {
        webhookSubscriptionCreate: {
          webhookSubscription: null,
          userErrors: [{ field: ['callbackUrl'], message: 'Invalid HTTPS URL' }],
        },
      },
    }
    const fetch = queuedFetch([
      { data: SHOP_RESPONSE },
      { data: UPSERT_RESPONSE },
      { data: WEBHOOK_OK }, // shop/update
      { data: WEBHOOK_OK }, // app/uninstalled
      { data: WEBHOOK_OK }, // app/scopes_update
      { data: realErr }, // app_subscriptions/update fails
      { data: WEBHOOK_OK }, // app_subscriptions/approaching_capped_amount
      { data: WEBHOOK_OK }, // app_purchases_one_time/update
    ])
    const c = createClient(baseOpts({ fetch: fetch as unknown as typeof fetch }))
    const r = await c.bootstrap({
      shopDomain: 'acme.myshopify.com',
      accessToken: 't',
    })
    expect(r.merchantId).toBe('mer_acme')
    expect(r.webhooksRegistered).toEqual([
      'shop/update',
      'app/uninstalled',
      'app/scopes_update',
      'app_subscriptions/approaching_capped_amount',
      'app_purchases_one_time/update',
    ])
    expect(r.webhookErrors).toHaveLength(1)
    expect(r.webhookErrors[0]?.topic).toBe('app_subscriptions/update')
  })

  it('throws if Shopify shop query fails — no merchant write', async () => {
    const fetch = queuedFetch([{ ok: false, status: 401, data: { errors: [{ message: 'Invalid API key' }] } }])
    const c = createClient(baseOpts({ fetch: fetch as unknown as typeof fetch }))
    await expect(
      c.bootstrap({ shopDomain: 'acme.myshopify.com', accessToken: 'wrong' }),
    ).rejects.toBeInstanceOf(AppThriveError)
    // No 2nd call attempted
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('rejects non-myshopify domains', async () => {
    const c = createClient(baseOpts({ fetch: vi.fn() as unknown as typeof fetch }))
    await expect(
      c.bootstrap({ shopDomain: 'acme.com', accessToken: 't' }),
    ).rejects.toThrow(/myshopify\.com/)
  })

  it('skips webhook registration when webhookTopics is an empty array', async () => {
    const fetch = queuedFetch([{ data: SHOP_RESPONSE }, { data: UPSERT_RESPONSE }])
    const c = createClient(baseOpts({ fetch: fetch as unknown as typeof fetch }))
    const r = await c.bootstrap({
      shopDomain: 'acme.myshopify.com',
      accessToken: 't',
      webhookTopics: [],
    })
    expect(r.webhooksRegistered).toEqual([])
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('converts slash topics to Shopify enum format in mutation variables', async () => {
    const fetch = queuedFetch([
      { data: SHOP_RESPONSE },
      { data: UPSERT_RESPONSE },
      { data: WEBHOOK_OK },
    ])
    const c = createClient(baseOpts({ fetch: fetch as unknown as typeof fetch }))
    await c.bootstrap({
      shopDomain: 'acme.myshopify.com',
      accessToken: 't',
      webhookTopics: ['shop/update'],
    })
    const webhookBody = JSON.parse(
      (fetch.mock.calls[2]?.[1] as RequestInit).body as string,
    ) as { variables: { topic: string } }
    expect(webhookBody.variables.topic).toBe('SHOP_UPDATE')
  })

  // ─── shopifyClientSecret upload (0.1.4) ────────────────────────

  it('uploads shopifyClientSecret to AppThrive between merchant upsert and webhook registration', async () => {
    const fetch = queuedFetch([
      { data: SHOP_RESPONSE },
      { data: UPSERT_RESPONSE },
      { data: { ok: true, rotated: false } }, // /shopify-secret response
      // no webhooks (skipped)
    ])
    const c = createClient(baseOpts({ fetch: fetch as unknown as typeof fetch }))
    const r = await c.bootstrap({
      shopDomain: 'acme.myshopify.com',
      accessToken: 't',
      shopifyClientSecret: 'shpss_my_partner_dashboard_client_secret',
      webhookTopics: [],
    })

    expect(r.shopifyClientSecretUploaded).toBe(true)
    expect(r.shopifyClientSecretError).toBeNull()
    // Call ordering: shop fetch → merchant upsert → secret upload
    expect(fetch.mock.calls[2]?.[0]).toBe(
      'https://api.test/api/ingest/org_test/app_test/shopify-secret',
    )
    const body = JSON.parse((fetch.mock.calls[2]?.[1] as RequestInit).body as string) as {
      shopifyClientSecret: string
    }
    expect(body.shopifyClientSecret).toBe('shpss_my_partner_dashboard_client_secret')
    // HMAC headers present (same scheme as upsertMerchant)
    const headers = (fetch.mock.calls[2]?.[1] as RequestInit).headers as Record<string, string>
    expect(headers['X-AppThrive-Signature']).toMatch(/^[0-9a-f]{64}$/)
    expect(headers['X-AppThrive-Timestamp']).toMatch(/^\d+$/)
  })

  it('captures upload error in shopifyClientSecretError without throwing', async () => {
    const fetch = queuedFetch([
      { data: SHOP_RESPONSE },
      { data: UPSERT_RESPONSE },
      { ok: false, status: 500, data: { error: 'KMS unavailable' } }, // /shopify-secret 500
      // no webhooks (skipped)
    ])
    const c = createClient(baseOpts({ fetch: fetch as unknown as typeof fetch }))
    const r = await c.bootstrap({
      shopDomain: 'acme.myshopify.com',
      accessToken: 't',
      shopifyClientSecret: 'shpss_xxxxxxxxxxxxxxxxxxxxxxxx',
      webhookTopics: [],
    })

    // Bootstrap does NOT throw — the merchant upsert is still good.
    expect(r.merchantId).toBe('mer_acme')
    expect(r.shopifyClientSecretUploaded).toBe(false)
    expect(r.shopifyClientSecretError).toMatch(/KMS unavailable/)
  })

  it('skips the upload entirely when shopifyClientSecret is omitted', async () => {
    const fetch = queuedFetch([
      { data: SHOP_RESPONSE },
      { data: UPSERT_RESPONSE },
      // no /shopify-secret call expected
    ])
    const c = createClient(baseOpts({ fetch: fetch as unknown as typeof fetch }))
    const r = await c.bootstrap({
      shopDomain: 'acme.myshopify.com',
      accessToken: 't',
      webhookTopics: [],
    })

    expect(r.shopifyClientSecretUploaded).toBe(false)
    expect(r.shopifyClientSecretError).toBeNull()
    // Only 2 calls: shop fetch + merchant upsert. No /shopify-secret.
    expect(fetch).toHaveBeenCalledTimes(2)
    for (const call of fetch.mock.calls) {
      expect(call[0]).not.toContain('/shopify-secret')
    }
  })

  it('proceeds with webhook registration even if upload fails', async () => {
    const fetch = queuedFetch([
      { data: SHOP_RESPONSE },
      { data: UPSERT_RESPONSE },
      { ok: false, status: 401, data: { error: 'unauthorized' } }, // /shopify-secret fails
      { data: WEBHOOK_OK }, // webhook still registers
    ])
    const c = createClient(baseOpts({ fetch: fetch as unknown as typeof fetch }))
    const r = await c.bootstrap({
      shopDomain: 'acme.myshopify.com',
      accessToken: 't',
      shopifyClientSecret: 'shpss_xxxxxxxxxxxxxxxxxxxxxxxx',
      webhookTopics: ['shop/update'],
    })

    expect(r.shopifyClientSecretUploaded).toBe(false)
    expect(r.shopifyClientSecretError).toBeTruthy()
    expect(r.webhooksRegistered).toEqual(['shop/update'])
    expect(r.webhookErrors).toEqual([])
  })
})

// ─── defaultBootstrapTopics public export (0.1.4, narrowed 0.3.0) ──────

describe('defaultBootstrapTopics export', () => {
  it('exports the same 6-topic list bootstrap() uses by default', async () => {
    const { defaultBootstrapTopics } = await import('../index')
    expect(defaultBootstrapTopics).toEqual([
      'shop/update',
      'app/uninstalled',
      'app/scopes_update',
      'app_subscriptions/update',
      'app_subscriptions/approaching_capped_amount',
      'app_purchases_one_time/update',
    ])
  })

  it('does NOT include the commerce topics deprecated in 0.3.0', async () => {
    const { defaultBootstrapTopics } = await import('../index')
    // AppThrive 410's all of these — they must stay out of defaults so
    // bootstrap() doesn't waste a webhookSubscriptionCreate call that's
    // guaranteed to auto-disable within 48h.
    for (const dep of [
      'orders/create',
      'orders/paid',
      'orders/cancelled',
      'orders/fulfilled',
      'refunds/create',
      'products/create',
      'products/update',
      'products/delete',
      'customers/create',
      'customers/update',
      'carts/create',
      'carts/update',
      'checkouts/create',
      'checkouts/update',
    ]) {
      expect(defaultBootstrapTopics).not.toContain(dep)
    }
  })

  it('callers can extend the defaults via spread', async () => {
    const { defaultBootstrapTopics } = await import('../index')
    const extended = [...defaultBootstrapTopics, 'inventory_levels/update', 'fulfillments/create']
    expect(extended).toContain('shop/update') // default kept
    expect(extended).toContain('inventory_levels/update') // addition landed
    expect(extended).toHaveLength(8)
  })
})
