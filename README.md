# @appthriveio/sdk

  Push merchant data, events, and metrics from your Shopify app into [AppThrive](https://appthrive.io).
  Zero dependencies. Web Crypto HMAC. Runs in Node 20+, Bun, Deno, Cloudflare Workers, modern browsers.

  ## Install
  ```bash
  npm install @appthriveio/sdk

  Quick start (one-liner — recommended)

  import { createClient } from '@appthriveio/sdk'

  const appthrive = createClient({
    orgId: process.env.APPTHRIVE_ORG_ID!,
    appId: process.env.APPTHRIVE_APP_ID!,
    webhookSecret: process.env.APPTHRIVE_WEBHOOK_SECRET!,
  })

  // In your existing Shopify OAuth callback:
  await appthrive.bootstrap({
    shopDomain,
    accessToken,
    shopifyClientSecret: process.env.SHOPIFY_API_SECRET!, // ⚠️ required for webhook HMAC
  })

  That single call:
  1. Reads the shop's data via Shopify Admin GraphQL
  2. Posts owner email / plan / address / etc. to AppThrive
  3. Uploads your Shopify Client Secret (encrypted at rest) so AppThrive can verify the HMAC on inbound webhooks
  4. Registers 6 Shopify webhooks (shop/update, app/uninstalled, app/scopes_update, app_subscriptions/update,
     app_subscriptions/approaching_capped_amount, app_purchases_one_time/update)

  The access token is used in-memory only — never persisted on AppThrive.

  ⚠️ shopifyClientSecret is the **Client secret** from Partner Dashboard → Apps → <your app> → Configuration →
  App credentials. Without it, AppThrive can't verify HMAC on inbound Shopify webhooks and uninstalls/plan
  changes won't propagate. Pass once on first bootstrap; re-passing rotates the stored value.

  Commerce data (orders, products, customers, carts, checkouts, refunds)

  AppThrive returns HTTP 410 Gone for the Shopify commerce topics — they're intentionally NOT in the default
  registration set. Apply your own business logic in your existing webhook handlers and push only the merchant-
  success-relevant metrics into AppThrive via `track()`:

  // inside your own orders/paid handler:
  await appthrive.track({
    event: 'order_paid',
    shopId: shopDomain,
    metrics: [
      { name: 'orders_generated', op: 'increment', value: 1 },
      { name: 'gmv_cents', op: 'increment', value: totalPriceCents },
    ],
  })

  This keeps AppThrive a merchant-success store (rollups + scores), not a commerce data store.

  Customising the topic list

  Pass webhookTopics to bootstrap() to override the default. To EXTEND rather than replace:

  import { createClient, defaultBootstrapTopics } from '@appthriveio/sdk'

  await appthrive.bootstrap({
    shopDomain,
    accessToken,
    shopifyClientSecret: process.env.SHOPIFY_API_SECRET!,
    webhookTopics: [...defaultBootstrapTopics, 'inventory_levels/update', 'fulfillments/create'],
  })

  On-demand re-enrichment (0.2.0+)

  When the AppThrive dashboard's **Re-enrich** button is clicked on a merchant, AppThrive can ask your app to
  refetch fresh shop data from Shopify Admin GraphQL — without ever holding a per-merchant Shopify token.
  Two-line setup:

  // 1. Tell the SDK where your handler lives
  const appthrive = createClient({
    orgId, appId, webhookSecret,
    enrichmentCallbackUrl: 'https://yourapp.example/appthrive/enrich',
  })

  // 2. Mount the handler — Next.js example, same shape works in Hono, Bun.serve, Deno, CF Workers
  // app/appthrive/enrich/route.ts
  export const POST = appthrive.createEnrichmentHandler({
    getAccessToken: async (shopDomain) => {
      const [s] = await shopifySession.findSessionsByShop(shopDomain)
      return s?.accessToken ?? null
    },
  })

  The SDK auto-registers the URL with AppThrive on the next signed call (via an `X-AppThrive-Enrichment-Url`
  header on existing ingest traffic — zero extra round-trips). The handler verifies AppThrive's HMAC, looks up
  the merchant's Shopify access token via your callback, fetches `/shop` GraphQL, and forwards the result
  through the same `/merchant` ingest endpoint `bootstrap()` uses. Tokens never leave your process.

  Skip it if you don't need on-demand re-enrichment — the Re-enrich button gracefully falls back to a
  Partner-API sync (limited fields).

  For Express, wrap the handler with a `Request` adapter:

  const handle = appthrive.createEnrichmentHandler({ getAccessToken })
  app.post('/appthrive/enrich', async (req, res) => {
    const webReq = new Request(`http://x${req.originalUrl}`, {
      method: 'POST',
      headers: req.headers as Record<string, string>,
      body: JSON.stringify(req.body),
    })
    const webRes = await handle(webReq)
    res.status(webRes.status)
    webRes.headers.forEach((v, k) => res.setHeader(k, v))
    res.send(await webRes.text())
  })

  Other methods

  - client.upsertMerchant({ shopId, ...fields }) — explicit per-field control
  - client.bulkUpsertMerchants([...]) — up to 100 at a time
  - client.track({ shopId, eventType, payload }) — send custom events
  - client.incrementMetric({ shopId, metric, value }) — push named metric observations
  - client.createEnrichmentHandler({ getAccessToken }) — on-demand re-enrichment (see above)

  Where do I get my credentials?

  Visit /connect-your-app in your AppThrive dashboard. Quick-start tab has copy-paste env vars + a one-click reveal for the webhook secret.

  Full API reference

  /docs/api — search for the Ingest (HMAC) tag.

  License

  MIT

  