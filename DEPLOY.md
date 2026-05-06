# Deploy LootXHub

LootXHub is a Node.js web service with SQLite storage and uploaded listing images.
It needs a Node host, not GitHub Pages.

## Render Blueprint

This repo includes `render.yaml` for Render.

1. Open Render and create a new Blueprint from the GitHub repo.
2. Select `Nrgetics/LootXhub`.
3. Render should detect `render.yaml`.
4. Fill the secret environment variables when Render asks:
   - `APP_URL`: your Render URL after the first deploy, for example `https://lootxhub-marketplace.onrender.com`
   - `STRIPE_SECRET_KEY`: your Stripe test or live secret key
   - `STRIPE_WEBHOOK_SECRET`: your Stripe webhook signing secret
5. Deploy the service.

The blueprint uses:

- Runtime: Node
- Start command: `npm start`
- Health check: `/api/health`
- Host binding: `0.0.0.0`
- Persistent disk mount: `/var/data`
- Database directory: `/var/data/data`
- Upload directory: `/var/data/uploads`

## Important Storage Note

Marketplace accounts, listings, orders, and uploads need persistent storage.
The Render blueprint uses a paid web service with a persistent disk so SQLite and images survive deploys/restarts.

Render free web services are useful for previews, but they do not support persistent disks. On the free plan, local SQLite data and uploaded images can disappear after restarts or redeploys.

## Stripe Webhook

After deployment, add this webhook endpoint in Stripe:

```text
https://YOUR-RENDER-URL/api/webhooks/stripe
```

Listen for these events:

- `checkout.session.completed`
- `checkout.session.expired`
- `checkout.session.async_payment_failed`
- `payment_intent.succeeded`
- `payment_intent.payment_failed`
- `charge.succeeded`
- `charge.refunded`
- `refund.created`
- `refund.updated`
- `charge.dispute.created`
- `charge.dispute.updated`
- `charge.dispute.closed`

Then copy Stripe's `whsec_...` signing secret into Render as `STRIPE_WEBHOOK_SECRET`.

## Before Real Sellers Use It

- Rotate any keys that were pasted into chat or terminal output.
- Replace the default admin password.
- Add a public refund/dispute policy.
- Set up Stripe Connect before automatic seller payouts.
- Add moderation and abuse reporting rules for digital goods.
