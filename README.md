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
  await appthrive.bootstrap({ shopDomain, accessToken })

  That single call:
  1. Reads the shop's data via Shopify Admin GraphQL
  2. Posts owner email / plan / address / etc. to AppThrive
  3. Registers the Shopify webhooks (shop/update, app_subscriptions/update, orders/create, orders/cancelled, app/uninstalled) that keep the
   data fresh forever

  The access token is used in-memory only — never persisted on AppThrive.

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

  