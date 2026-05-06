# LootXHub Marketplace

A full-stack local marketplace prototype for LootXHub.

## Run

```sh
npm start
```

Open:

```text
http://127.0.0.1:5173
```

## Default Admin

```text
Email: admin@lootxhub.local
Password: ChangeMe123!
```

Change this before any real deployment.

## Included

- User registration, login, logout, and cookie sessions
- SQLite database in `data/lootxhub.sqlite`
- Seller listing creation
- Server-side image uploads in `uploads/`
- Self-serve public marketplace listings
- Delivery windows, region/platform fields, stock count, and warranty notes
- Buyer watchlist/favorites
- Listing detail pages and seller profile pages
- Category routes for currency, accounts, items, boosting, gift cards, and top ups
- Seller wallet snapshot for pending, held, completed sales, and platform fees
- Seller tiering based on completed orders, ratings, and active listings
- Seller Stripe Connect onboarding status
- Account notification center
- Password change and local prototype reset-token flows
- Buyer/seller order chat with proof image uploads
- Order completion ratings
- Internal buyer-protection holds that create dispute records and evidence deadlines
- Admin listing management and rejection tools
- Admin dispute resolution actions for refunding buyers, releasing sellers, or cancelling orders
- Cart and checkout order creation
- Demo/manual payment states, platform fee records, and payment event records

## Payment Note

The checkout flow supports demo/manual orders, Stripe Checkout, and Stripe Connect destination transfers for single-seller orders when the seller has completed onboarding.

## Stripe Setup

Copy `.env.example` to your local environment and set:

```text
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
APP_URL=http://127.0.0.1:5173
PLATFORM_FEE_PERCENT=8
```

For local webhooks, use Stripe CLI:

```sh
stripe listen --forward-to 127.0.0.1:5173/api/webhooks/stripe
```

Then use the printed `whsec_...` value as `STRIPE_WEBHOOK_SECRET`.

Implemented Stripe pieces:

- Checkout Session creation
- Order metadata on Checkout Session and PaymentIntent
- Webhook signature verification
- `checkout.session.completed`
- `checkout.session.expired`
- `payment_intent.succeeded`
- `payment_intent.payment_failed`
- `charge.succeeded`
- `charge.refunded`
- `refund.created` / `refund.updated`
- `charge.dispute.*` records
- Stripe Connect Express account creation
- Stripe Connect account links and payout readiness tracking
- Destination transfers for eligible single-seller Checkout orders
- Platform commission tracking through orders, items, and seller wallet totals
- Admin refund action
- Admin dispute display and resolution

Real deployment still needs your own Stripe account, live keys, HTTPS hosting, business verification, tax/legal review, and a clear refund/dispute policy.

## Deploy

This app needs a Node host because it has accounts, uploads, checkout, and server APIs.
GitHub Pages only hosts static files, so use the Render setup in [DEPLOY.md](DEPLOY.md).
