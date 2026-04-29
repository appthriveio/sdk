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
  4. Registers 8 Shopify webhooks (shop/update, app/uninstalled, app/scopes_update, app_subscriptions/update,
     app_subscriptions/approaching_capped_amount, app_purchases_one_time/update, orders/create, orders/cancelled)

  The access token is used in-memory only — never persisted on AppThrive.

  ⚠️ shopifyClientSecret is the **Client secret** from Partner Dashboard → Apps → <your app> → Configuration →
  App credentials. Without it, AppThrive can't verify HMAC on inbound Shopify webhooks and uninstalls/plan
  changes won't propagate. Pass once on first bootstrap; re-passing rotates the stored value.

  Customising the topic list

  Pass webhookTopics to bootstrap() to override the default. To EXTEND rather than replace:

  import { createClient, defaultBootstrapTopics } from '@appthriveio/sdk'

  await appthrive.bootstrap({
    shopDomain,
    accessToken,
    shopifyClientSecret: process.env.SHOPIFY_API_SECRET!,
    webhookTopics: [...defaultBootstrapTopics, 'orders/paid', 'fulfillments/create'],
  })

  Other methods

  - client.upsertMerchant({ shopId, ...fields }) — explicit per-field control
  - client.bulkUpsertMerchants([...]) — up to 100 at a time
  - client.track({ shopId, eventType, payload }) — send custom events
  - client.incrementMetric({ shopId, metric, value }) — push named metric observations

  Where do I get my credentials?

  Visit /connect-your-app in your AppThrive dashboard. Quick-start tab has copy-paste env vars + a one-click reveal for the webhook secret.

  Full API reference

  /docs/api — search for the Ingest (HMAC) tag.

  License

  MIT

  