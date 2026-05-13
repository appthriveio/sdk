/**
 * AppThrive JS SDK.
 *
 * Runs in any runtime with fetch + Web Crypto: Node 20+, Bun, Deno,
 * Cloudflare Workers, and modern browsers. Zero dependencies.
 *
 * Usage:
 * ```ts
 * import { createClient } from '@appthriveio/sdk'
 *
 * const client = createClient({
 *   orgId: 'org_xyz',
 *   appId: 'app_abc',
 *   webhookSecret: process.env.APPTHRIVE_WEBHOOK_SECRET!,
 *   baseUrl: 'https://app.appthrive.io', // optional, default
 * })
 *
 * await client.track({
 *   shopId: 'foo.myshopify.com',
 *   eventType: 'app.feature_used',
 *   payload: { feature: 'ai_suggestions' },
 * })
 *
 * await client.incrementMetric({
 *   shopId: 'foo.myshopify.com',
 *   metric: 'variant_revenue',
 *   value: 4200,
 * })
 * ```
 */

export type AppThriveClientOptions = {
  /** Base URL of the AppThrive API (default: `https://app.appthrive.io`). */
  baseUrl?: string
  /** Organisation id (format: `org_...`). */
  orgId: string
  /** App id from the dashboard (format: `app_...`). */
  appId: string
  /**
   * Webhook secret generated at app-connect time. Shown ONCE in the
   * connect response — read via GET /api/apps/{id}/webhook-secret or
   * rotate via POST on same path.
   */
  webhookSecret: string
  /**
   * Custom fetch — required in runtimes without a global fetch, or
   * for testing. Must be compatible with `typeof fetch`.
   */
  fetch?: typeof fetch
  /**
   * Per-request timeout in ms. Default 10000. Set to 0 to disable.
   */
  timeoutMs?: number
  /**
   * Phase G — public HTTPS URL where you mount the
   * `createEnrichmentHandler()` route. The SDK auto-registers this
   * URL with AppThrive on the next outbound HTTP call by piggybacking
   * an `X-AppThrive-Enrichment-Url` header (no extra round-trip, no
   * dashboard config). When the AppThrive dashboard's Re-enrich
   * button is clicked, AppThrive POSTs a signed enrichment request
   * to this URL; your handler uses the merchant's session-stored
   * Shopify Admin token to fetch /shop GraphQL and forwards the
   * result. Tokens never leave your process.
   *
   * Omit to disable on-demand re-enrichment for this app. The
   * Re-enrich button gracefully falls back to a Partner-API sync
   * (limited fields) when no callback is registered.
   */
  enrichmentCallbackUrl?: string
}

// ─── Phase G — enrichment handler types ─────────────────────────────

/**
 * Context passed to the dev's `getAccessToken` callback. Lets the dev
 * audit-log per-request without re-parsing the wire payload.
 */
export type EnrichmentRequestContext = {
  merchantId: string
  shopId: string
  shopDomain: string
  requestId: string
  requestedByUserId: string | null
  reason: 'manual_reenrich' | 'backfill_script'
}

export type EnrichmentHandlerOptions = {
  /**
   * Look up the merchant's Shopify Admin access token from your own
   * session store. Return `null` if the merchant has uninstalled or
   * the session is otherwise gone — the handler returns a clean
   * `NO_SESSION` response without throwing.
   */
  getAccessToken: (
    shopDomain: string,
    ctx: EnrichmentRequestContext,
  ) => Promise<string | null> | string | null

  /** Override the Shopify Admin API version used for the shop GraphQL fetch. */
  shopifyApiVersion?: string

  /**
   * Optional hook fired AFTER the enrichment ingest succeeds. Errors
   * are swallowed — the handler still returns 200 to AppThrive.
   */
  onSuccess?: (ctx: EnrichmentRequestContext, fieldsWritten: string[]) => void | Promise<void>
}

/**
 * Wire shape AppThrive POSTs to the dev's enrichmentCallbackUrl. Pinned
 * by SDK-INTERFACE.md §4.
 */
type EnrichmentRequestPayload = {
  merchantId: string
  shopId: string
  shopDomain: string
  requestId: string
  requestedByUserId: string | null
  reason: 'manual_reenrich' | 'backfill_script'
  ts: number
}

export type TrackInput = {
  shopId: string
  eventType: string
  payload?: Record<string, unknown>
  at?: Date
  idempotencyKey?: string
}

export type MetricInput = {
  shopId: string
  metric: string
  value: number
  at?: Date
}

export type TrackResult = {
  eventId: string
  deduplicated: boolean
  merchantResolved: boolean
}

/** Per-item result from trackBatch. Either an eventId or an error string. */
export type BatchTrackResult =
  | { eventId: string; deduplicated: boolean; merchantResolved: boolean }
  | { error: string }

export type BatchTrackResponse = {
  results: BatchTrackResult[]
}

/** Max events per batch call — mirrors the server cap in Catalog §2.1. */
export const MAX_BATCH_SIZE = 100

/**
 * Phase F — merchant enrichment.
 *
 * Every field is optional. Only fields you supply are written; other
 * columns are preserved. Pass `null` on a typed field to clear it; pass
 * a key with value `null` inside `customAttributes` to delete that key.
 *
 * shopId accepts any of:
 *   - Shopify GID  ("gid://shopify/Shop/12345")
 *   - bare numeric id  ("12345")
 *   - myshopify domain  ("foo.myshopify.com")
 * The server resolves all three to the same merchant row.
 */
export type ShopifyPlanTier =
  | 'unknown'
  | 'developer'
  | 'basic'
  | 'shopify'
  | 'advanced'
  | 'plus'
  | 'trial'

export type UpsertMerchantInput = {
  shopId: string
  /**
   * Optional `*.myshopify.com` domain. Send this alongside `shopId`
   * when `shopId` is a GID/numeric so the server populates the
   * `shop_domain` column with the real myshopify domain instead of
   * mirroring the GID into it. `bootstrap()` sets this automatically
   * from Shopify's `shop.myshopifyDomain`.
   */
  shopDomain?: string
  shopName?: string | null
  shopOwnerName?: string | null
  shopOwnerEmail?: string | null
  shopOwnerPhone?: string | null
  shopifyPlan?: ShopifyPlanTier
  shopifyCreatedAt?: string | Date | null
  shopifyTags?: string[]
  address1?: string | null
  address2?: string | null
  city?: string | null
  province?: string | null
  zip?: string | null
  country?: string | null
  countryCode?: string | null
  currency?: string | null
  timezone?: string | null
  locale?: string | null
  industry?: string | null
  customAttributes?: Record<string, unknown>
  /** Optional dedup key. Header takes precedence on the wire. */
  idempotencyKey?: string
}

export type UpsertMerchantResult = {
  merchantId: string
  isNew: boolean
  fieldsWritten: string[]
  piiBlocked: boolean
}

export type BulkUpsertMerchantResult = {
  results: Array<
    | ({ shopId: string | null } & UpsertMerchantResult)
    | { shopId: string | null; error: string }
  >
}

/**
 * Bootstrap input — call this ONCE during your app's install handler
 * for each newly-installed shop. The access token is used in-memory
 * only; AppThrive never persists it.
 *
 * Default webhook topics (6 — override with the optional list):
 *   Lifecycle:  shop/update, app/uninstalled, app/scopes_update
 *   Billing:    app_subscriptions/update,
 *               app_subscriptions/approaching_capped_amount,
 *               app_purchases_one_time/update
 *
 * Each topic registers a webhook on the shop pointing at
 * https://{baseUrl}/api/webhooks/shopify/{appId}/{topic}.
 *
 * Commerce topics (orders/*, products/*, customers/*, carts/*,
 * checkouts/*, refunds/*) are NOT registered by default — AppThrive
 * returns HTTP 410 Gone for those. To send commerce-derived metrics,
 * call `appthrive.track({ metrics: [...] })` from your own webhook
 * handlers, applying your own business logic. AppThrive is a
 * merchant-success platform, not a commerce data store.
 *
 * ⚠️ CRITICAL: pass `shopifyClientSecret` on the first bootstrap call
 * for each app. Without it, AppThrive cannot HMAC-verify the webhooks
 * Shopify sends — uninstalls and plan changes won't propagate. See the
 * field doc below.
 */
export type BootstrapInput = {
  /** *.myshopify.com domain. */
  shopDomain: string
  /**
   * Shopify Admin API access token for THIS shop (per-shop, OAuth-issued).
   * Used once to read shop + register webhooks; never sent back to AppThrive
   * after the in-memory call returns.
   */
  accessToken: string
  /**
   * Your Shopify Partner App Client Secret. Required for AppThrive to
   * HMAC-verify the inbound Shopify webhooks (app/uninstalled,
   * app_subscriptions/update, etc.) registered by this bootstrap call.
   *
   * Find it at: Partner Dashboard → Apps → <your app> → Configuration →
   * App credentials → **Client secret**. (NOT the API token, NOT a
   * Webhook secret — the Client secret.)
   *
   * Pass via env: `process.env.SHOPIFY_API_SECRET` — the same value
   * your OAuth flow already uses. Sent ONCE per app (the SDK uploads
   * it to AppThrive's `/api/ingest/{org}/{app}/shopify-secret`
   * endpoint where it's encrypted at rest). Re-passing rotates the
   * stored value.
   *
   * Optional. If omitted, `bootstrap()` still runs but `result.
   * shopifyClientSecretUploaded` is false and webhook deliveries to
   * AppThrive will fail HMAC verification (500s in your Partner
   * Dashboard delivery log) until you upload the secret.
   */
  shopifyClientSecret?: string
  /**
   * Override the default webhook topic list. Topics use Shopify's slash
   * format (`shop/update`, `app_subscriptions/update`, etc.) — the SDK
   * converts to the GraphQL enum form (`SHOP_UPDATE`,
   * `APP_SUBSCRIPTIONS_UPDATE`). Pass an empty array to skip webhook
   * registration entirely (e.g. if you already register webhooks
   * elsewhere in your app).
   *
   * To EXTEND the defaults rather than replace them:
   *   `webhookTopics: [...defaultBootstrapTopics, 'inventory_levels/update']`
   *
   * Commerce topics (orders/*, products/*, customers/*, carts/*,
   * checkouts/*, refunds/*) are 410'd by AppThrive — registering them
   * here will succeed at Shopify but every delivery will fail until
   * Shopify auto-disables (~48h). Use `appthrive.track()` with a
   * `metrics[]` payload from your own webhook handlers instead.
   */
  webhookTopics?: readonly string[]
  /**
   * Shopify Admin API version. Defaults to '2026-04' which matches the
   * Partner API version this codebase uses.
   */
  apiVersion?: string
}

export type BootstrapResult = {
  merchantId: string
  isNew: boolean
  fieldsWritten: string[]
  /** Topics successfully registered. */
  webhooksRegistered: string[]
  /**
   * Per-topic registration errors. Empty array on full success. Bootstrap
   * does NOT throw on partial-failure here — the merchant upsert is the
   * critical part; webhooks can be retried.
   */
  webhookErrors: Array<{ topic: string; message: string }>
  /**
   * True if `shopifyClientSecret` was supplied and AppThrive accepted it.
   * False when the input field was omitted, OR when the upload failed
   * (in which case `shopifyClientSecretError` carries the reason).
   *
   * If false, inbound Shopify webhooks won't HMAC-verify on AppThrive's
   * side — fix by re-bootstrapping with a valid `shopifyClientSecret`.
   */
  shopifyClientSecretUploaded: boolean
  /**
   * Error message when the upload was attempted and failed. Null when
   * the input was omitted entirely or the upload succeeded.
   */
  shopifyClientSecretError: string | null
}

/**
 * The default set of Shopify Admin webhook topics that `bootstrap()`
 * registers when no `webhookTopics` argument is supplied.
 *
 * Exported so advanced callers can EXTEND (rather than replace) the
 * defaults — for example, to also subscribe to inventory updates:
 *
 * ```ts
 * import { createClient, defaultBootstrapTopics } from '@appthriveio/sdk'
 *
 * await client.bootstrap({
 *   shopDomain,
 *   accessToken,
 *   webhookTopics: [...defaultBootstrapTopics, 'inventory_levels/update'],
 * })
 * ```
 *
 * Passing `webhookTopics` REPLACES the defaults — spread
 * `defaultBootstrapTopics` first if you want the AppThrive lifecycle
 * + billing coverage alongside your additions.
 *
 * Changed in 0.3.0: dropped `orders/create` and `orders/cancelled`.
 * AppThrive no longer pulls commerce data from Shopify webhooks
 * (orders, products, customers, carts, checkouts, refunds — all 410'd
 * by the receiver). Send commerce-derived metrics via
 * `appthrive.track({ metrics: [...] })` from your own webhook handlers
 * instead, applying your own business logic.
 */
export const defaultBootstrapTopics = [
  // Lifecycle — install/uninstall flows + scope audit
  'shop/update',
  'app/uninstalled',
  'app/scopes_update',
  // Billing — recurring + usage-cap + one-time charges
  'app_subscriptions/update',
  'app_subscriptions/approaching_capped_amount',
  'app_purchases_one_time/update',
] as const

/** @deprecated use the named export `defaultBootstrapTopics` instead. */
const DEFAULT_BOOTSTRAP_TOPICS: readonly string[] = defaultBootstrapTopics

const DEFAULT_SHOPIFY_API_VERSION = '2026-04'

export type MetricResult = {
  ok: true
  merchantId: string
  hourlyRollupId: string
  dailyRollupId: string
  allTimeRollupId: string
  aggregation: 'sum' | 'count' | 'latest' | 'max' | 'min' | 'avg' | 'unique'
}

export type AppThriveErrorCode =
  | 'UNAUTHORIZED'
  | 'RATE_LIMITED'
  | 'NOT_FOUND'
  | 'BAD_REQUEST'
  | 'SERVER_ERROR'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'UNKNOWN'

export class AppThriveError extends Error {
  constructor(
    public readonly code: AppThriveErrorCode,
    message: string,
    public readonly status?: number,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message)
    this.name = 'AppThriveError'
  }
}

export class AppThriveClient {
  private readonly baseUrl: string
  private readonly orgId: string
  private readonly appId: string
  private readonly webhookSecret: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly enrichmentCallbackUrl: string | null
  /**
   * Per-instance, in-memory cache of the etag AppThrive last echoed
   * back to us for `enrichmentCallbackUrl`. Sent as
   * `X-AppThrive-Enrichment-Url-Etag` on subsequent calls so the
   * server can short-circuit identical re-registrations. Lost on
   * process restart — first request after restart re-registers,
   * which is one extra ~30-byte header (no extra round-trip).
   */
  private cachedEnrichmentEtag: string | null = null
  private keyCache: Promise<CryptoKey> | null = null

  constructor(options: AppThriveClientOptions) {
    if (!options.orgId) throw new Error('orgId is required')
    if (!options.appId) throw new Error('appId is required')
    if (!options.webhookSecret) throw new Error('webhookSecret is required')
    this.baseUrl = (options.baseUrl ?? 'https://app.appthrive.io').replace(/\/+$/, '')
    this.orgId = options.orgId
    this.appId = options.appId
    this.webhookSecret = options.webhookSecret
    this.fetchImpl = options.fetch ?? globalThis.fetch
    if (!this.fetchImpl) {
      throw new Error(
        'No fetch available. Pass options.fetch or run in a runtime with globalThis.fetch.',
      )
    }
    this.timeoutMs = options.timeoutMs ?? 10_000
    if (options.enrichmentCallbackUrl) {
      if (!/^https?:\/\//.test(options.enrichmentCallbackUrl)) {
        throw new Error('enrichmentCallbackUrl must be a full http(s) URL')
      }
      this.enrichmentCallbackUrl = options.enrichmentCallbackUrl
    } else {
      this.enrichmentCallbackUrl = null
    }
  }

  /** Push an event. Rejects on network / 4xx / 5xx errors. */
  async track(input: TrackInput): Promise<TrackResult> {
    if (!input.shopId) throw new Error('shopId is required')
    if (!input.eventType) throw new Error('eventType is required')
    const body = {
      shopId: input.shopId,
      eventType: input.eventType,
      payload: input.payload ?? {},
      ...(input.at ? { occurredAt: input.at.toISOString() } : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    }
    return this.request<TrackResult>(`/api/ingest/${this.orgId}/${this.appId}`, body, {
      idempotencyKey: input.idempotencyKey,
    })
  }

  /**
   * Push up to 100 events in one HMAC-signed request. Use this instead
   * of a for-loop around track() for efficiency — one signature + one
   * rate-limit hit + batched merchant resolution on the server.
   *
   * Returns a parallel results array; per-item errors do not fail the
   * whole batch. Throws on HTTP-level errors (401, 429, 5xx).
   */
  async trackBatch(inputs: TrackInput[]): Promise<BatchTrackResponse> {
    if (inputs.length === 0) throw new Error('events array is empty')
    if (inputs.length > MAX_BATCH_SIZE) {
      throw new Error(`events array must contain <= ${MAX_BATCH_SIZE} items`)
    }
    for (const input of inputs) {
      if (!input.shopId) throw new Error('shopId is required on every event')
      if (!input.eventType) throw new Error('eventType is required on every event')
    }
    const body = {
      events: inputs.map((input) => ({
        shopId: input.shopId,
        eventType: input.eventType,
        payload: input.payload ?? {},
        ...(input.at ? { occurredAt: input.at.toISOString() } : {}),
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      })),
    }
    return this.request<BatchTrackResponse>(`/api/ingest/${this.orgId}/${this.appId}`, body)
  }

  /**
   * Push a metric observation. Server behavior depends on the metric's
   * registered aggregation:
   *  - `sum`    → value is added to existing rollup (use this for
   *               incrementMetric semantics)
   *  - `count`  → value is ignored, rollup count increments by 1
   *  - `latest` → value replaces existing (use setMetric below instead)
   *
   * Unknown metric names are rejected by the server with 400.
   */
  async incrementMetric(input: MetricInput): Promise<MetricResult> {
    return this.sendMetric(input)
  }

  /**
   * Semantic alias of incrementMetric — identical server call. Intended
   * for metrics registered with aggregation='latest', where the server
   * overwrites instead of adding. Using this on a 'sum' metric will
   * still add, not overwrite — aggregation is defined server-side.
   */
  async setMetric(input: MetricInput): Promise<MetricResult> {
    return this.sendMetric(input)
  }

  private sendMetric(input: MetricInput): Promise<MetricResult> {
    if (!input.shopId) throw new Error('shopId is required')
    if (!input.metric) throw new Error('metric is required')
    if (!Number.isFinite(input.value)) {
      throw new Error('value must be a finite number')
    }
    const body = {
      shopId: input.shopId,
      metric: input.metric,
      value: input.value,
      ...(input.at ? { at: input.at.toISOString() } : {}),
    }
    return this.request<MetricResult>(`/api/ingest/${this.orgId}/${this.appId}/metric`, body)
  }

  /**
   * Phase F — push merchant enrichment fields the Partner API can't give us
   * (owner email, plan, address, custom attributes). Idempotent: re-calling
   * with the same data is a no-op.
   *
   * Use this when you want explicit control. For a one-line "set everything
   * up at install time" experience, see `bootstrap()` instead.
   *
   * Throws on 4xx/5xx; returns details on success including `fieldsWritten`
   * (column-name list of what actually changed). `piiBlocked: true` means
   * the merchant is in a DSR redaction window — the call is silently
   * dropped server-side per PRD §5.9.
   */
  async upsertMerchant(input: UpsertMerchantInput): Promise<UpsertMerchantResult> {
    if (!input.shopId) throw new Error('shopId is required')
    const body = serializeUpsertMerchantInput(input)
    return this.request<UpsertMerchantResult>(
      `/api/ingest/${this.orgId}/${this.appId}/merchant`,
      body,
      { idempotencyKey: input.idempotencyKey },
    )
  }

  /**
   * Phase F — push up to 100 merchants in one HMAC-signed request. Use
   * this for one-time historical backfills (a `for`-loop around
   * `upsertMerchant()` works but burns N HMAC signatures + N rate-limit
   * hits + N round-trips).
   *
   * Per-item errors do NOT fail the whole batch; you get a parallel
   * results array. Throws only on HTTP-level errors (401, 429, 5xx).
   */
  async bulkUpsertMerchants(
    inputs: UpsertMerchantInput[],
  ): Promise<BulkUpsertMerchantResult> {
    if (inputs.length === 0) throw new Error('merchants array is empty')
    if (inputs.length > MAX_BATCH_SIZE) {
      throw new Error(`merchants array must contain <= ${MAX_BATCH_SIZE} items`)
    }
    for (const input of inputs) {
      if (!input.shopId) throw new Error('shopId is required on every merchant')
    }
    const body = {
      merchants: inputs.map(serializeUpsertMerchantInput),
    }
    return this.request<BulkUpsertMerchantResult>(
      `/api/ingest/${this.orgId}/${this.appId}/merchant/bulk`,
      body,
    )
  }

  /**
   * Phase F — the one-liner setup. Call this ONCE in your app's OAuth
   * callback (or wherever you receive a fresh per-shop access token)
   * to push the shop's data into AppThrive AND register the Shopify
   * webhooks that keep it fresh forever.
   *
   * Workflow:
   *   1. GraphQL `{ shop { ... } }` query against the shop's Admin API
   *   2. POST resolved fields to /api/ingest/{org}/{app}/merchant
   *   3. For each topic in `webhookTopics`, register a Shopify webhook
   *      pointing at AppThrive's receiver
   *
   * Security:
   *   - The access token is used in-memory only. After this method
   *     returns, AppThrive has zero knowledge of it.
   *   - Webhooks are signed with the shop's per-app webhook secret;
   *     AppThrive verifies HMAC on the incoming side.
   *
   * Failure modes:
   *   - GraphQL shop query fails  → throws (no merchant write happens)
   *   - Merchant upsert fails     → throws (no webhook registration happens)
   *   - Webhook registration partial-failure → returned in `webhookErrors`,
   *     not thrown. The merchant is already enriched at that point so
   *     refusing the whole call would discard real progress.
   */
  async bootstrap(input: BootstrapInput): Promise<BootstrapResult> {
    if (!input.shopDomain) throw new Error('shopDomain is required')
    if (!input.accessToken) throw new Error('accessToken is required')
    if (!input.shopDomain.endsWith('.myshopify.com')) {
      throw new Error('shopDomain must be a *.myshopify.com domain')
    }

    const apiVersion = input.apiVersion ?? DEFAULT_SHOPIFY_API_VERSION
    const topics = input.webhookTopics ?? DEFAULT_BOOTSTRAP_TOPICS

    // 1. Fetch shop data from Shopify.
    const shop = await fetchShopifyShop({
      shopDomain: input.shopDomain,
      accessToken: input.accessToken,
      apiVersion,
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
    })

    // 2. Map → enrichment fields and upsert.
    const upsertInput = mapShopToUpsertInput(shop, input.shopDomain)
    const upsert = await this.upsertMerchant(upsertInput)

    // 3. Upload Shopify Client Secret (best-effort, gated on input).
    //    Without this, AppThrive cannot verify the HMAC on inbound
    //    Shopify webhooks — they'll all 500. We attempt before webhook
    //    registration so by the time the first webhook fires, the
    //    secret is already on AppThrive's side.
    let shopifyClientSecretUploaded = false
    let shopifyClientSecretError: string | null = null
    if (input.shopifyClientSecret) {
      try {
        await this.request(
          `/api/ingest/${this.orgId}/${this.appId}/shopify-secret`,
          { shopifyClientSecret: input.shopifyClientSecret },
        )
        shopifyClientSecretUploaded = true
      } catch (err) {
        shopifyClientSecretError =
          err instanceof Error ? err.message : 'unknown error'
      }
    }

    // 4. Register webhooks (best-effort).
    const webhooksRegistered: string[] = []
    const webhookErrors: BootstrapResult['webhookErrors'] = []
    for (const topic of topics) {
      try {
        await registerShopifyWebhook({
          shopDomain: input.shopDomain,
          accessToken: input.accessToken,
          apiVersion,
          topic,
          callbackUrl: `${this.baseUrl}/api/webhooks/shopify/${this.appId}/${topic}`,
          fetchImpl: this.fetchImpl,
          timeoutMs: this.timeoutMs,
        })
        webhooksRegistered.push(topic)
      } catch (err) {
        webhookErrors.push({
          topic,
          message: err instanceof Error ? err.message : 'unknown error',
        })
      }
    }

    return {
      merchantId: upsert.merchantId,
      isNew: upsert.isNew,
      fieldsWritten: upsert.fieldsWritten,
      webhooksRegistered,
      webhookErrors,
      shopifyClientSecretUploaded,
      shopifyClientSecretError,
    }
  }

  /**
   * Phase G — return a framework-agnostic Web Fetch handler that
   * receives signed enrichment requests from AppThrive and round-
   * trips through Shopify Admin GraphQL to enrich the merchant.
   *
   * Mount the returned handler at the URL you set as
   * `enrichmentCallbackUrl` in `createClient()`. Examples:
   *
   *   // Next.js App Router (app/appthrive/enrich/route.ts):
   *   export const POST = appthrive.createEnrichmentHandler({
   *     getAccessToken: async (shopDomain) => {
   *       const [s] = await shopifySession.findSessionsByShop(shopDomain)
   *       return s?.accessToken ?? null
   *     },
   *   })
   *
   *   // Hono / Bun.serve / Deno: same shape — `(req: Request) => Promise<Response>`.
   *
   * The handler ALWAYS returns HTTP 200 when the request reached it
   * intact (HMAC verified). Business outcomes are signalled via the
   * `code` field in the JSON body — `null` on success, or one of
   * `NO_SESSION` / `TOKEN_REVOKED` / `SHOPIFY_ERROR` / `BAD_REQUEST`
   * on failure. HMAC verification failure returns 401.
   *
   * Tokens never leave your process.
   */
  createEnrichmentHandler(opts: EnrichmentHandlerOptions): (req: Request) => Promise<Response> {
    if (typeof opts.getAccessToken !== 'function') {
      throw new Error('createEnrichmentHandler: getAccessToken is required')
    }
    const apiVersion = opts.shopifyApiVersion ?? DEFAULT_SHOPIFY_API_VERSION

    return async (req: Request): Promise<Response> => {
      // Read body as text once — the HMAC signature is over the raw body.
      const rawBody = await req.text()
      const sigHeader = req.headers.get('x-appthrive-signature')
      const tsHeader = req.headers.get('x-appthrive-timestamp')

      if (!sigHeader || !tsHeader) {
        return jsonResponse(401, { error: 'Missing signature headers' })
      }
      const timestamp = Number(tsHeader)
      if (!Number.isFinite(timestamp)) {
        return jsonResponse(401, { error: 'Invalid timestamp header' })
      }
      const drift = Math.abs(Math.floor(Date.now() / 1000) - timestamp)
      if (drift > 300) {
        return jsonResponse(401, { error: 'Timestamp outside 5-minute window' })
      }

      // Compute expected signature and compare. Web Crypto's verify path
      // already runs in constant time when the signatures are the same
      // length; we ensure that with a length pre-check.
      const expected = await this.sign(`${timestamp}.${rawBody}`)
      if (!constantTimeEqual(expected, sigHeader)) {
        return jsonResponse(401, { error: 'Signature verification failed' })
      }

      let payload: EnrichmentRequestPayload
      try {
        payload = parseEnrichmentRequestPayload(JSON.parse(rawBody))
      } catch (err) {
        return jsonResponse(200, {
          ok: false,
          code: 'BAD_REQUEST',
          message: err instanceof Error ? err.message : 'Invalid request body',
        })
      }

      const ctx: EnrichmentRequestContext = {
        merchantId: payload.merchantId,
        shopId: payload.shopId,
        shopDomain: payload.shopDomain,
        requestId: payload.requestId,
        requestedByUserId: payload.requestedByUserId,
        reason: payload.reason,
      }

      let accessToken: string | null
      try {
        accessToken = await opts.getAccessToken(payload.shopDomain, ctx)
      } catch (err) {
        return jsonResponse(200, {
          ok: false,
          code: 'NO_SESSION',
          message: `getAccessToken threw: ${err instanceof Error ? err.message : 'unknown'}`,
        })
      }
      if (!accessToken) {
        return jsonResponse(200, {
          ok: false,
          code: 'NO_SESSION',
          message: `No active Shopify session found for ${payload.shopDomain}`,
        })
      }

      // Fetch shop GraphQL. Map any AppThriveError back to a wire code.
      let shop: ShopifyShop
      try {
        shop = await fetchShopifyShop({
          shopDomain: payload.shopDomain,
          accessToken,
          apiVersion,
          fetchImpl: this.fetchImpl,
          timeoutMs: this.timeoutMs,
        })
      } catch (err) {
        if (err instanceof AppThriveError) {
          // 401 from Shopify means the token is no longer valid.
          if (err.status === 401 || err.code === 'UNAUTHORIZED') {
            return jsonResponse(200, {
              ok: false,
              code: 'TOKEN_REVOKED',
              message: err.message,
            })
          }
          return jsonResponse(200, {
            ok: false,
            code: 'SHOPIFY_ERROR',
            message: err.message,
          })
        }
        return jsonResponse(200, {
          ok: false,
          code: 'SHOPIFY_ERROR',
          message: err instanceof Error ? err.message : 'Unknown Shopify error',
        })
      }

      // Forward to AppThrive enrichment ingest.
      const upsertInput = mapShopToUpsertInput(shop, payload.shopDomain)
      let upsert
      try {
        upsert = await this.upsertMerchant(upsertInput)
      } catch (err) {
        // The ingest call itself failed (network / 5xx on AppThrive
        // side). Surface as SHOPIFY_ERROR-shaped so AppThrive's
        // dispatcher retries — that's the closest existing kind.
        return jsonResponse(200, {
          ok: false,
          code: 'SHOPIFY_ERROR',
          message: `Enrichment ingest failed: ${err instanceof Error ? err.message : 'unknown'}`,
        })
      }

      if (opts.onSuccess) {
        try {
          await opts.onSuccess(ctx, upsert.fieldsWritten)
        } catch {
          // Swallow — we still return 200 to AppThrive.
        }
      }

      return jsonResponse(200, {
        ok: true,
        code: null,
        fieldsWritten: upsert.fieldsWritten,
      })
    }
  }

  private async signingKey(): Promise<CryptoKey> {
    if (this.keyCache) return this.keyCache
    this.keyCache = globalThis.crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(this.webhookSecret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    return this.keyCache
  }

  private async sign(payload: string): Promise<string> {
    const key = await this.signingKey()
    const sig = await globalThis.crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
    return bytesToHex(new Uint8Array(sig))
  }

  private async request<T>(
    path: string,
    body: unknown,
    options: { idempotencyKey?: string } = {},
  ): Promise<T> {
    const rawBody = JSON.stringify(body)
    const timestamp = Math.floor(Date.now() / 1000)
    const signature = await this.sign(`${timestamp}.${rawBody}`)

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-AppThrive-Timestamp': String(timestamp),
      'X-AppThrive-Signature': signature,
    }
    if (options.idempotencyKey) {
      headers['X-AppThrive-Idempotency-Key'] = options.idempotencyKey
    }
    // Phase G — piggyback enrichment-URL registration on every signed
    // call. AppThrive's middleware reads these headers as a side-effect
    // and echoes the current etag in the response (see SDK-INTERFACE.md
    // §3). Sending the cached etag short-circuits redundant DB writes
    // server-side. Zero extra round-trips.
    if (this.enrichmentCallbackUrl) {
      headers['X-AppThrive-Enrichment-Url'] = this.enrichmentCallbackUrl
      if (this.cachedEnrichmentEtag) {
        headers['X-AppThrive-Enrichment-Url-Etag'] = this.cachedEnrichmentEtag
      }
    }

    const controller = this.timeoutMs > 0 ? new AbortController() : null
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null

    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: rawBody,
        signal: controller?.signal,
      })
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new AppThriveError('TIMEOUT', `Request timed out after ${this.timeoutMs}ms`)
      }
      const message = err instanceof Error ? err.message : 'network error'
      throw new AppThriveError('NETWORK_ERROR', message)
    } finally {
      if (timer) clearTimeout(timer)
    }

    // Phase G — capture etag echo so subsequent requests can skip
    // re-registration. Header lookup is case-insensitive per Fetch spec.
    if (this.enrichmentCallbackUrl) {
      const echoed = response.headers.get('x-appthrive-enrichment-url-etag')
      if (echoed) this.cachedEnrichmentEtag = echoed
    }

    if (response.ok) {
      return (await response.json()) as T
    }

    const retryAfterHeader = response.headers.get('Retry-After')
    const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : undefined
    const text = await response.text().catch(() => '')
    const parsed = safeParseError(text)

    const code = mapStatusToCode(response.status)
    throw new AppThriveError(
      code,
      parsed ?? `AppThrive returned ${response.status}`,
      response.status,
      Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
    )
  }
}

export function createClient(options: AppThriveClientOptions): AppThriveClient {
  return new AppThriveClient(options)
}

// ─── Shopify GraphQL helpers (Phase F bootstrap) ─────────────────────

type ShopifyShop = {
  id: string
  name: string
  email: string | null
  contactEmail: string | null
  myshopifyDomain: string | null
  currencyCode: string | null
  ianaTimezone: string | null
  createdAt: string | null
  plan: { displayName: string | null; partnerDevelopment: boolean; shopifyPlus: boolean } | null
  billingAddress: {
    address1: string | null
    address2: string | null
    city: string | null
    province: string | null
    country: string | null
    countryCode: string | null
    zip: string | null
    phone: string | null
  } | null
}

const SHOP_QUERY = `
  query AppThriveBootstrapShop {
    shop {
      id
      name
      email
      contactEmail
      myshopifyDomain
      currencyCode
      ianaTimezone
      createdAt
      plan { displayName partnerDevelopment shopifyPlus }
      billingAddress {
        address1
        address2
        city
        province
        country
        countryCode
        zip
        phone
      }
    }
  }
`

const WEBHOOK_MUTATION = `
  mutation AppThriveBootstrapWebhook($topic: WebhookSubscriptionTopic!, $callbackUrl: URL!) {
    webhookSubscriptionCreate(
      topic: $topic
      webhookSubscription: { callbackUrl: $callbackUrl, format: JSON }
    ) {
      webhookSubscription { id topic }
      userErrors { field message }
    }
  }
`

/**
 * Convert "shop/update" / "app_subscriptions/update" →
 * "SHOP_UPDATE" / "APP_SUBSCRIPTIONS_UPDATE". Shopify's
 * WebhookSubscriptionTopic enum uses the all-caps form.
 */
function topicSlashToEnum(topic: string): string {
  return topic.replace(/[/.]/g, '_').toUpperCase()
}

async function fetchShopifyShop(opts: {
  shopDomain: string
  accessToken: string
  apiVersion: string
  fetchImpl: typeof fetch
  timeoutMs: number
}): Promise<ShopifyShop> {
  const url = `https://${opts.shopDomain}/admin/api/${opts.apiVersion}/graphql.json`
  const data = await shopifyGraphql<{ shop: ShopifyShop }>(opts, url, SHOP_QUERY, {})
  return data.shop
}

async function registerShopifyWebhook(opts: {
  shopDomain: string
  accessToken: string
  apiVersion: string
  topic: string
  callbackUrl: string
  fetchImpl: typeof fetch
  timeoutMs: number
}): Promise<void> {
  const url = `https://${opts.shopDomain}/admin/api/${opts.apiVersion}/graphql.json`
  const data = await shopifyGraphql<{
    webhookSubscriptionCreate: {
      webhookSubscription: { id: string } | null
      userErrors: Array<{ field: string[]; message: string }>
    }
  }>(opts, url, WEBHOOK_MUTATION, {
    topic: topicSlashToEnum(opts.topic),
    callbackUrl: opts.callbackUrl,
  })
  const errs = data.webhookSubscriptionCreate.userErrors
  if (errs && errs.length > 0) {
    // Shopify returns "address must be unique for this topic" when the
    // webhook already exists — that's not a real failure, treat as ok.
    const nonDuplicate = errs.filter((e) => !/already exists|must be unique/i.test(e.message))
    if (nonDuplicate.length > 0) {
      throw new Error(nonDuplicate.map((e) => e.message).join('; '))
    }
  }
}

async function shopifyGraphql<T>(
  opts: { accessToken: string; fetchImpl: typeof fetch; timeoutMs: number },
  url: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const controller = opts.timeoutMs > 0 ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), opts.timeoutMs) : null
  let response: Response
  try {
    response = await opts.fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': opts.accessToken,
      },
      body: JSON.stringify({ query, variables }),
      signal: controller?.signal,
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new AppThriveError('TIMEOUT', `Shopify GraphQL timed out after ${opts.timeoutMs}ms`)
    }
    const message = err instanceof Error ? err.message : 'network error'
    throw new AppThriveError('NETWORK_ERROR', `Shopify GraphQL: ${message}`)
  } finally {
    if (timer) clearTimeout(timer)
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new AppThriveError(
      mapStatusToCode(response.status),
      `Shopify GraphQL ${response.status}: ${text.slice(0, 200)}`,
      response.status,
    )
  }

  const json = (await response.json()) as { data?: T; errors?: Array<{ message: string }> }
  if (json.errors && json.errors.length > 0) {
    throw new AppThriveError('BAD_REQUEST', json.errors.map((e) => e.message).join('; '))
  }
  if (!json.data) {
    throw new AppThriveError('SERVER_ERROR', 'Shopify GraphQL returned no data')
  }
  return json.data
}

/**
 * Translate Shopify's plan.displayName (which is human-prose, e.g.
 * "Shopify Plus", "Basic Shopify") into our typed `merchantPlanTierEnum`.
 * partnerDevelopment + shopifyPlus booleans on the plan object are
 * authoritative; displayName is the fallback.
 */
function mapShopifyPlanDisplayNameToTier(
  displayName: string | null,
  plan: { partnerDevelopment: boolean; shopifyPlus: boolean } | null,
): ShopifyPlanTier | undefined {
  if (plan?.shopifyPlus) return 'plus'
  if (plan?.partnerDevelopment) return 'developer'
  if (!displayName) return undefined
  const lc = displayName.toLowerCase()
  if (lc.includes('plus')) return 'plus'
  if (lc.includes('advanced')) return 'advanced'
  if (lc.includes('basic')) return 'basic'
  if (lc.includes('shopify') && !lc.includes('plus')) return 'shopify'
  if (lc.includes('developer') || lc.includes('partner')) return 'developer'
  if (lc.includes('trial')) return 'trial'
  return 'unknown'
}

/**
 * Map a Shopify shop GraphQL response into UpsertMerchantInput. Shared
 * by `bootstrap()` (install-time) and `createEnrichmentHandler()`
 * (on-demand re-enrichment) so they emit identical wire shapes.
 *
 * `fallbackDomain` is used when `shop.myshopifyDomain` is missing —
 * historically it shouldn't be, but the GraphQL field is nullable.
 */
function mapShopToUpsertInput(shop: ShopifyShop, fallbackDomain: string): UpsertMerchantInput {
  return {
    shopId: shop.id, // Shopify GID — most stable identifier
    // Send the myshopify domain alongside the GID so the receiver
    // populates merchants.shop_domain with the real domain instead
    // of mirroring the GID into it (the Apr 2026 stub-row bug).
    shopDomain: shop.myshopifyDomain ?? fallbackDomain,
    shopName: shop.name,
    shopOwnerEmail: shop.email ?? shop.contactEmail ?? null,
    shopOwnerPhone: shop.billingAddress?.phone ?? null,
    shopifyPlan: mapShopifyPlanDisplayNameToTier(shop.plan?.displayName ?? null, shop.plan ?? null),
    shopifyCreatedAt: shop.createdAt ?? undefined,
    address1: shop.billingAddress?.address1 ?? null,
    address2: shop.billingAddress?.address2 ?? null,
    city: shop.billingAddress?.city ?? null,
    province: shop.billingAddress?.province ?? null,
    zip: shop.billingAddress?.zip ?? null,
    country: shop.billingAddress?.country ?? null,
    countryCode: shop.billingAddress?.countryCode ?? null,
    currency: shop.currencyCode ?? null,
    timezone: shop.ianaTimezone ?? null,
  }
}

/**
 * Convert UpsertMerchantInput → wire shape. shopifyCreatedAt is normalised
 * to ISO-8601 (Date or string both accepted at the SDK boundary). Fields
 * left undefined are NOT sent — the server-side helper only writes fields
 * actually present in the JSON body.
 */
function serializeUpsertMerchantInput(input: UpsertMerchantInput): Record<string, unknown> {
  const out: Record<string, unknown> = { shopId: input.shopId }
  // Each field below is only copied when the caller supplied it. We
  // distinguish "undefined" (don't touch) from "null" (explicit clear).
  const passthrough: Array<keyof UpsertMerchantInput> = [
    'shopDomain',
    'shopName',
    'shopOwnerName',
    'shopOwnerEmail',
    'shopOwnerPhone',
    'shopifyPlan',
    'shopifyTags',
    'address1',
    'address2',
    'city',
    'province',
    'zip',
    'country',
    'countryCode',
    'currency',
    'timezone',
    'locale',
    'industry',
    'customAttributes',
  ]
  for (const key of passthrough) {
    if (key in input) {
      out[key] = input[key]
    }
  }
  if ('shopifyCreatedAt' in input) {
    const v = input.shopifyCreatedAt
    out.shopifyCreatedAt =
      v === null || v === undefined ? v : v instanceof Date ? v.toISOString() : v
  }
  if (input.idempotencyKey) {
    out.idempotencyKey = input.idempotencyKey
  }
  return out
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = ''
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, '0')
  }
  return hex
}

// ─── Phase G — enrichment handler helpers ───────────────────────────

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * Constant-time string equality. Both values must be hex strings of
 * the same length (HMAC-SHA256 hex always 64 chars). Returns false
 * immediately on length mismatch — that's not a timing leak because
 * length is observable from the protocol shape.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

/**
 * Parse + shape-validate an inbound enrichment request body. Manual
 * validation rather than zod because the SDK is zero-dep. Throws on
 * any missing or wrong-typed field; the handler maps to BAD_REQUEST.
 */
function parseEnrichmentRequestPayload(raw: unknown): EnrichmentRequestPayload {
  if (!raw || typeof raw !== 'object') throw new Error('body must be a JSON object')
  const r = raw as Record<string, unknown>
  const requireString = (key: string): string => {
    const v = r[key]
    if (typeof v !== 'string' || v.length === 0) {
      throw new Error(`missing or invalid field: ${key}`)
    }
    return v
  }
  const requireNullableString = (key: string): string | null => {
    const v = r[key]
    if (v === null) return null
    if (typeof v !== 'string') throw new Error(`field must be string or null: ${key}`)
    return v
  }
  const requireNumber = (key: string): number => {
    const v = r[key]
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`missing or invalid number field: ${key}`)
    }
    return v
  }
  const reasonRaw = r.reason
  if (reasonRaw !== 'manual_reenrich' && reasonRaw !== 'backfill_script') {
    throw new Error(`reason must be 'manual_reenrich' or 'backfill_script', got: ${String(reasonRaw)}`)
  }
  return {
    merchantId: requireString('merchantId'),
    shopId: requireString('shopId'),
    shopDomain: requireString('shopDomain'),
    requestId: requireString('requestId'),
    requestedByUserId: requireNullableString('requestedByUserId'),
    reason: reasonRaw,
    ts: requireNumber('ts'),
  }
}

function safeParseError(text: string): string | null {
  if (!text) return null
  try {
    const parsed = JSON.parse(text) as { error?: string }
    return parsed.error ?? null
  } catch {
    return text.slice(0, 200)
  }
}

function mapStatusToCode(status: number): AppThriveErrorCode {
  if (status === 401 || status === 403) return 'UNAUTHORIZED'
  if (status === 404) return 'NOT_FOUND'
  if (status === 429) return 'RATE_LIMITED'
  if (status >= 400 && status < 500) return 'BAD_REQUEST'
  if (status >= 500) return 'SERVER_ERROR'
  return 'UNKNOWN'
}
