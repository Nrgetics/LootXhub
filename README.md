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
- Listing detail pages and seller profile pages
- Seller wallet snapshot for pending, held, and completed sales
- Buyer/seller order chat
- Order completion ratings
- Internal buyer-protection holds that create dispute records
- Admin listing management and rejection tools
- Cart and checkout order creation
- Demo/manual payment states and payment event records

## Payment Note

The checkout flow supports demo/manual orders and Stripe Checkout.

## Stripe Setup

Copy `.env.example` to your local environment and set:

```text
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
APP_URL=http://127.0.0.1:5173
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
- Admin refund action
- Admin dispute display

Real deployment still needs your own Stripe account, live keys, HTTPS hosting, business verification, tax/legal review, and a clear refund/dispute policy.
