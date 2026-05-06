const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { URL } = require("node:url");
const { DatabaseSync } = require("node:sqlite");

const rootDir = __dirname;
loadEnvFile(path.join(rootDir, ".env"));
const dataDir = resolveAppPath(process.env.DATA_DIR, path.join(rootDir, "data"));
const uploadDir = resolveAppPath(process.env.UPLOAD_DIR, path.join(rootDir, "uploads"));
const dbPath = resolveAppPath(process.env.DB_PATH, path.join(dataDir, "lootxhub.sqlite"));
const port = Number(process.env.PORT || 5173);
const host = process.env.HOST || "127.0.0.1";
const sessionDays = 14;
const stripeSecretKey = process.env.STRIPE_SECRET_KEY || "";
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET || "";
const stripeCurrency = (process.env.STRIPE_CURRENCY || "usd").toLowerCase();
const publicAppUrl = process.env.APP_URL || "";
const platformFeePercent = Math.min(25, Math.max(0, Number(process.env.PLATFORM_FEE_PERCENT || 8)));

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(uploadDir, { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'buyer',
    seller_status TEXT NOT NULL DEFAULT 'active',
    seller_tier TEXT NOT NULL DEFAULT 'New Seller',
    stripe_account_id TEXT,
    stripe_onboarding_status TEXT NOT NULL DEFAULT 'not_started',
    stripe_charges_enabled INTEGER NOT NULL DEFAULT 0,
    stripe_payouts_enabled INTEGER NOT NULL DEFAULT 0,
    email_verified INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS listings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seller_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    game TEXT NOT NULL,
    category TEXT NOT NULL,
    description TEXT NOT NULL,
    price_cents INTEGER NOT NULL,
    delivery_method TEXT NOT NULL,
    delivery_window TEXT NOT NULL DEFAULT '24 hours',
    stock INTEGER NOT NULL DEFAULT 1,
    region TEXT NOT NULL DEFAULT 'Global',
    platform TEXT NOT NULL DEFAULT 'All platforms',
    warranty_days INTEGER NOT NULL DEFAULT 0,
    image_url TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    moderation_note TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    buyer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    total_cents INTEGER NOT NULL,
    platform_fee_cents INTEGER NOT NULL DEFAULT 0,
    payment_method TEXT NOT NULL,
    payment_status TEXT NOT NULL DEFAULT 'pending',
    order_status TEXT NOT NULL DEFAULT 'new',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    listing_id INTEGER NOT NULL REFERENCES listings(id),
    seller_id INTEGER NOT NULL REFERENCES users(id),
    title TEXT NOT NULL,
    price_cents INTEGER NOT NULL,
    platform_fee_cents INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS payment_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS refunds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    provider_refund_id TEXT,
    amount_cents INTEGER NOT NULL,
    status TEXT NOT NULL,
    reason TEXT,
    raw_payload TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS disputes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
    provider TEXT NOT NULL,
    provider_dispute_id TEXT NOT NULL UNIQUE,
    charge_id TEXT,
    amount_cents INTEGER NOT NULL,
    status TEXT NOT NULL,
    reason TEXT,
    evidence_due_at TEXT,
    raw_payload TEXT,
    resolution TEXT,
    resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    resolved_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS order_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    message_type TEXT NOT NULL DEFAULT 'message',
    attachment_url TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS ratings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    rater_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rated_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    score INTEGER NOT NULL,
    comment TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(order_id, rater_id, rated_user_id)
  );

  CREATE TABLE IF NOT EXISTS favorites (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, listing_id)
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    url TEXT,
    read_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

ensureColumn("users", "seller_status", "TEXT NOT NULL DEFAULT 'active'");
ensureColumn("users", "seller_tier", "TEXT NOT NULL DEFAULT 'New Seller'");
ensureColumn("users", "stripe_account_id", "TEXT");
ensureColumn("users", "stripe_onboarding_status", "TEXT NOT NULL DEFAULT 'not_started'");
ensureColumn("users", "stripe_charges_enabled", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("users", "stripe_payouts_enabled", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("users", "email_verified", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("listings", "delivery_window", "TEXT NOT NULL DEFAULT '24 hours'");
ensureColumn("listings", "stock", "INTEGER NOT NULL DEFAULT 1");
ensureColumn("listings", "region", "TEXT NOT NULL DEFAULT 'Global'");
ensureColumn("listings", "platform", "TEXT NOT NULL DEFAULT 'All platforms'");
ensureColumn("listings", "warranty_days", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("orders", "provider", "TEXT");
ensureColumn("orders", "provider_session_id", "TEXT");
ensureColumn("orders", "provider_payment_intent", "TEXT");
ensureColumn("orders", "provider_charge_id", "TEXT");
ensureColumn("orders", "refunded_cents", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("orders", "platform_fee_cents", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("order_items", "image_url", "TEXT");
ensureColumn("order_items", "platform_fee_cents", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("order_messages", "message_type", "TEXT NOT NULL DEFAULT 'message'");
ensureColumn("order_messages", "attachment_url", "TEXT");
ensureColumn("disputes", "resolution", "TEXT");
ensureColumn("disputes", "resolved_by", "INTEGER REFERENCES users(id) ON DELETE SET NULL");
ensureColumn("disputes", "resolved_at", "TEXT");

seedAdmin();
seedListings();

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    const method = req.method || "GET";

    if (requestUrl.pathname.startsWith("/api/")) {
      await routeApi(req, res, requestUrl, method);
      return;
    }

    await serveStatic(res, requestUrl.pathname);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: "Something went wrong on the server." });
  }
});

server.listen(port, host, () => {
  console.log(`LootXHub marketplace running at http://${host}:${port}`);
  console.log("Default admin: admin@lootxhub.local / ChangeMe123!");
});

async function routeApi(req, res, requestUrl, method) {
  const user = getCurrentUser(req);

  if (method === "POST" && requestUrl.pathname === "/api/webhooks/stripe") {
    await handleStripeWebhook(req, res);
    return;
  }

  if (method === "GET" && requestUrl.pathname === "/api/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (method === "GET" && requestUrl.pathname === "/api/config") {
    sendJson(res, 200, {
      stripeConfigured: Boolean(stripeSecretKey),
      stripeWebhookConfigured: Boolean(stripeWebhookSecret),
      stripeCurrency,
      platformFeePercent,
    });
    return;
  }

  if (method === "GET" && requestUrl.pathname === "/api/me") {
    sendJson(res, 200, { user: publicUser(user) });
    return;
  }

  if (method === "POST" && requestUrl.pathname === "/api/auth/register") {
    const body = await readJson(req);
    const username = cleanText(body.username, 32);
    const email = cleanEmail(body.email);
    const password = String(body.password || "");

    if (!username || !email || password.length < 8) {
      sendJson(res, 400, { error: "Use a username, email, and password with at least 8 characters." });
      return;
    }

    const role = db.prepare("SELECT COUNT(*) AS count FROM users").get().count === 0 ? "admin" : "buyer";

    try {
      const hash = hashPassword(password);
      db.prepare("INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)").run(
        username,
        email,
        hash,
        role,
      );
    } catch (error) {
      sendJson(res, 409, { error: "That username or email is already taken." });
      return;
    }

    const created = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    createSession(res, created.id);
    sendJson(res, 201, { user: publicUser(created) });
    return;
  }

  if (method === "POST" && requestUrl.pathname === "/api/auth/login") {
    const body = await readJson(req);
    const email = cleanEmail(body.email);
    const password = String(body.password || "");
    const found = db.prepare("SELECT * FROM users WHERE email = ?").get(email);

    if (!found || !verifyPassword(password, found.password_hash)) {
      sendJson(res, 401, { error: "Invalid email or password." });
      return;
    }

    createSession(res, found.id);
    sendJson(res, 200, { user: publicUser(found) });
    return;
  }

  if (method === "POST" && requestUrl.pathname === "/api/auth/logout") {
    const token = readCookie(req, "lx_session");
    if (token) {
      db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    }
    setCookie(res, "lx_session", "", "Max-Age=0; Path=/; HttpOnly; SameSite=Lax");
    sendJson(res, 200, { ok: true });
    return;
  }

  if (method === "POST" && requestUrl.pathname === "/api/auth/change-password") {
    requireUser(res, user);
    if (!user) return;
    const body = await readJson(req);
    const currentPassword = String(body.currentPassword || "");
    const newPassword = String(body.newPassword || "");
    const found = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id);
    if (!found || !verifyPassword(currentPassword, found.password_hash)) {
      sendJson(res, 401, { error: "Current password is incorrect." });
      return;
    }
    if (newPassword.length < 10) {
      sendJson(res, 400, { error: "Use a new password with at least 10 characters." });
      return;
    }
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(newPassword), user.id);
    createNotification(user.id, "security", "Password changed", "Your LootXHub password was updated.", "#account");
    sendJson(res, 200, { ok: true });
    return;
  }

  if (method === "POST" && requestUrl.pathname === "/api/auth/password-reset/request") {
    const body = await readJson(req);
    const email = cleanEmail(body.email);
    const found = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
    let devResetToken = "";
    if (found) {
      const token = crypto.randomBytes(24).toString("hex");
      const expires = db.prepare("SELECT datetime('now', '+30 minutes') AS expires").get().expires;
      db.prepare("INSERT INTO password_reset_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(
        tokenHash(token),
        found.id,
        expires,
      );
      createNotification(found.id, "security", "Password reset requested", "A password reset token was created.", "#account");
      devResetToken = token;
    }
    sendJson(res, 200, {
      ok: true,
      message: "If that email exists, a reset token has been created.",
      devResetToken,
    });
    return;
  }

  if (method === "POST" && requestUrl.pathname === "/api/auth/password-reset/confirm") {
    const body = await readJson(req);
    const token = cleanText(body.token || "", 200);
    const newPassword = String(body.newPassword || "");
    if (newPassword.length < 10) {
      sendJson(res, 400, { error: "Use a new password with at least 10 characters." });
      return;
    }
    const reset = db
      .prepare(
        "SELECT * FROM password_reset_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > CURRENT_TIMESTAMP",
      )
      .get(tokenHash(token));
    if (!reset) {
      sendJson(res, 400, { error: "Reset token is invalid or expired." });
      return;
    }
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(newPassword), reset.user_id);
    db.prepare("UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE token_hash = ?").run(reset.token_hash);
    createNotification(reset.user_id, "security", "Password reset complete", "Your password was reset successfully.", "#account");
    sendJson(res, 200, { ok: true });
    return;
  }

  if (method === "GET" && requestUrl.pathname === "/api/my/notifications") {
    requireUser(res, user);
    if (!user) return;
    const rows = db
      .prepare("SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 30")
      .all(user.id);
    sendJson(res, 200, { notifications: rows.map(formatNotification) });
    return;
  }

  if (method === "POST" && requestUrl.pathname === "/api/my/notifications/read-all") {
    requireUser(res, user);
    if (!user) return;
    db.prepare("UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE user_id = ? AND read_at IS NULL").run(user.id);
    sendJson(res, 200, { ok: true });
    return;
  }

  const notificationMatch = requestUrl.pathname.match(/^\/api\/my\/notifications\/(\d+)$/);
  if (method === "PATCH" && notificationMatch) {
    requireUser(res, user);
    if (!user) return;
    db.prepare("UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?").run(
      Number(notificationMatch[1]),
      user.id,
    );
    sendJson(res, 200, { ok: true });
    return;
  }

  if (method === "GET" && requestUrl.pathname === "/api/connect/status") {
    requireUser(res, user);
    if (!user) return;
    if (stripeSecretKey && user.stripe_account_id) {
      try {
        await refreshStripeAccountStatus(user.id, user.stripe_account_id);
      } catch (error) {
        console.warn(`Could not refresh Stripe account ${user.stripe_account_id}: ${error.message}`);
      }
    }
    const fresh = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id);
    sendJson(res, 200, { connect: sellerConnectStatus(fresh) });
    return;
  }

  if (method === "POST" && requestUrl.pathname === "/api/connect/onboard") {
    requireUser(res, user);
    if (!user) return;
    if (!stripeSecretKey) {
      sendJson(res, 400, { error: "Stripe is not configured. Add STRIPE_SECRET_KEY first." });
      return;
    }
    try {
      const fresh = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id);
      const accountId = fresh.stripe_account_id || (await createStripeConnectedAccount(fresh));
      const link = await createStripeAccountLink(req, accountId);
      await refreshStripeAccountStatus(user.id, accountId);
      createNotification(user.id, "seller", "Stripe onboarding started", "Finish Stripe onboarding to unlock real seller payouts.", "#account");
      sendJson(res, 200, { url: link.url, connect: sellerConnectStatus(db.prepare("SELECT * FROM users WHERE id = ?").get(user.id)) });
    } catch (error) {
      sendJson(res, 502, { error: `Stripe Connect onboarding failed: ${error.message}` });
    }
    return;
  }

  if (method === "GET" && requestUrl.pathname === "/api/listings") {
    const includeMine = requestUrl.searchParams.get("mine") === "1";
    const rows =
      user && includeMine
        ? db
            .prepare(
              `SELECT listings.*, users.username AS seller_name, users.role AS seller_role
               FROM listings JOIN users ON listings.seller_id = users.id
               WHERE listings.status = 'approved' OR listings.seller_id = ?
               ORDER BY listings.created_at DESC`,
            )
            .all(user.id)
        : db
            .prepare(
              `SELECT listings.*, users.username AS seller_name, users.role AS seller_role
               FROM listings JOIN users ON listings.seller_id = users.id
               WHERE listings.status = 'approved'
               ORDER BY listings.created_at DESC`,
            )
            .all();

    sendJson(res, 200, { listings: rows.map(formatListing) });
    return;
  }

  const listingDetailMatch = requestUrl.pathname.match(/^\/api\/listings\/(\d+)$/);
  if (method === "GET" && listingDetailMatch) {
    const row = db
      .prepare(
        `SELECT listings.*, users.username AS seller_name, users.role AS seller_role
         FROM listings JOIN users ON listings.seller_id = users.id
         WHERE listings.id = ? AND (listings.status = 'approved' OR listings.seller_id = ?)`,
      )
      .get(Number(listingDetailMatch[1]), user?.id || 0);

    if (!row) {
      sendJson(res, 404, { error: "Listing not found." });
      return;
    }

    sendJson(res, 200, { listing: formatListing(row), seller: getSellerProfile(row.seller_id) });
    return;
  }

  const sellerProfileMatch = requestUrl.pathname.match(/^\/api\/sellers\/(\d+)$/);
  if (method === "GET" && sellerProfileMatch) {
    const profile = getSellerProfile(Number(sellerProfileMatch[1]));
    if (!profile) {
      sendJson(res, 404, { error: "Seller not found." });
      return;
    }
    sendJson(res, 200, { seller: profile });
    return;
  }

  if (method === "POST" && requestUrl.pathname === "/api/listings") {
    requireUser(res, user);
    if (!user) return;

    const body = await readJson(req, 5_000_000);
    const listing = await validateListing(body);
    if (listing.error) {
      sendJson(res, 400, { error: listing.error });
      return;
    }

    db.prepare(
      `INSERT INTO listings
        (seller_id, title, game, category, description, price_cents, delivery_method, delivery_window, stock, region, platform, warranty_days, image_url, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved')`,
    ).run(
      user.id,
      listing.title,
      listing.game,
      listing.category,
      listing.description,
      listing.priceCents,
      listing.deliveryMethod,
      listing.deliveryWindow,
      listing.stock,
      listing.region,
      listing.platform,
      listing.warrantyDays,
      listing.imageUrl,
    );

    const created = db
      .prepare(
        `SELECT listings.*, users.username AS seller_name, users.role AS seller_role
         FROM listings JOIN users ON listings.seller_id = users.id
         WHERE listings.id = last_insert_rowid()`,
      )
      .get();
    sendJson(res, 201, { listing: formatListing(created) });
    return;
  }

  if (method === "GET" && requestUrl.pathname === "/api/my/listings") {
    requireUser(res, user);
    if (!user) return;

    const rows = db
      .prepare(
        `SELECT listings.*, users.username AS seller_name, users.role AS seller_role
         FROM listings JOIN users ON listings.seller_id = users.id
         WHERE listings.seller_id = ?
         ORDER BY listings.created_at DESC`,
      )
      .all(user.id);
    sendJson(res, 200, { listings: rows.map(formatListing) });
    return;
  }

  if (method === "GET" && requestUrl.pathname === "/api/my/wallet") {
    requireUser(res, user);
    if (!user) return;
    sendJson(res, 200, { wallet: getSellerWallet(user.id) });
    return;
  }

  if (method === "GET" && requestUrl.pathname === "/api/my/favorites") {
    requireUser(res, user);
    if (!user) return;
    const rows = db
      .prepare(
        `SELECT listings.*, users.username AS seller_name, users.role AS seller_role
         FROM favorites
         JOIN listings ON listings.id = favorites.listing_id
         JOIN users ON users.id = listings.seller_id
         WHERE favorites.user_id = ? AND listings.status = 'approved'
         ORDER BY favorites.created_at DESC`,
      )
      .all(user.id);
    sendJson(res, 200, { listingIds: rows.map((row) => row.id), listings: rows.map(formatListing) });
    return;
  }

  const favoriteMatch = requestUrl.pathname.match(/^\/api\/favorites\/(\d+)$/);
  if ((method === "POST" || method === "DELETE") && favoriteMatch) {
    requireUser(res, user);
    if (!user) return;
    const listingId = Number(favoriteMatch[1]);
    const listing = db.prepare("SELECT id FROM listings WHERE id = ? AND status = 'approved'").get(listingId);
    if (!listing) {
      sendJson(res, 404, { error: "Listing not found." });
      return;
    }
    if (method === "POST") {
      db.prepare("INSERT OR IGNORE INTO favorites (user_id, listing_id) VALUES (?, ?)").run(user.id, listingId);
    } else {
      db.prepare("DELETE FROM favorites WHERE user_id = ? AND listing_id = ?").run(user.id, listingId);
    }
    const favorites = db.prepare("SELECT listing_id FROM favorites WHERE user_id = ?").all(user.id).map((row) => row.listing_id);
    sendJson(res, 200, { listingIds: favorites });
    return;
  }

  if (method === "POST" && requestUrl.pathname === "/api/checkout") {
    requireUser(res, user);
    if (!user) return;

    const body = await readJson(req);
    const ids = Array.isArray(body.listingIds) ? body.listingIds.map(Number).filter(Boolean) : [];
    const paymentMethod = cleanText(body.paymentMethod || "demo", 30);

    if (!ids.length) {
      sendJson(res, 400, { error: "Choose at least one listing before checkout." });
      return;
    }

    const placeholders = ids.map(() => "?").join(",");
    const rows = db
      .prepare(`SELECT * FROM listings WHERE status = 'approved' AND id IN (${placeholders})`)
      .all(...ids);

    if (rows.length !== ids.length) {
      sendJson(res, 400, { error: "One or more listings are no longer available." });
      return;
    }

    const total = rows.reduce((sum, row) => sum + row.price_cents, 0);
    const platformFee = rows.reduce((sum, row) => sum + platformFeeForPrice(row.price_cents), 0);
    const allowedPaymentMethods = ["demo", "manual", "stripe"];
    if (!allowedPaymentMethods.includes(paymentMethod)) {
      sendJson(res, 400, { error: "Choose a valid payment method." });
      return;
    }

    if (paymentMethod === "stripe" && !stripeSecretKey) {
      sendJson(res, 400, { error: "Stripe is not configured. Add STRIPE_SECRET_KEY to use Stripe Checkout." });
      return;
    }

    if (paymentMethod === "stripe" && rows.some((row) => row.price_cents <= 0)) {
      sendJson(res, 400, { error: "Stripe checkout cannot include quote-only listings." });
      return;
    }

    const paymentStatus =
      paymentMethod === "demo" ? "demo_paid" : paymentMethod === "stripe" ? "stripe_pending" : "manual_pending";
    const orderStatus = paymentMethod === "demo" ? "paid" : "awaiting_payment";

    db.prepare(
      "INSERT INTO orders (buyer_id, total_cents, platform_fee_cents, payment_method, payment_status, order_status, provider) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(user.id, total, platformFee, paymentMethod, paymentStatus, orderStatus, paymentMethod);
    const orderId = Number(db.prepare("SELECT last_insert_rowid() AS id").get().id);

    const insertItem = db.prepare(
      "INSERT INTO order_items (order_id, listing_id, seller_id, title, price_cents, platform_fee_cents, image_url) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    for (const row of rows) {
      insertItem.run(orderId, row.id, row.seller_id, row.title, row.price_cents, platformFeeForPrice(row.price_cents), row.image_url);
    }
    for (const sellerId of [...new Set(rows.map((row) => row.seller_id))]) {
      createNotification(
        sellerId,
        "order",
        `New order #${orderId}`,
        `${user.username} bought ${rows.filter((row) => row.seller_id === sellerId).length} listing(s).`,
        "#account",
      );
    }

    db.prepare("INSERT INTO payment_events (order_id, provider, event_type, payload) VALUES (?, ?, ?, ?)").run(
      orderId,
      paymentMethod,
      paymentStatus,
      JSON.stringify({ total_cents: total, listing_ids: ids }),
    );

    if (paymentMethod === "stripe") {
      try {
        const session = await createStripeCheckoutSession(req, orderId, rows, user, platformFee);
        db.prepare("UPDATE orders SET provider_session_id = ? WHERE id = ?").run(session.id, orderId);
        db.prepare("INSERT INTO payment_events (order_id, provider, event_type, payload) VALUES (?, ?, ?, ?)").run(
          orderId,
          "stripe",
          "checkout.session.created",
          JSON.stringify(session),
        );
        sendJson(res, 201, { order: getOrder(orderId, user), checkoutUrl: session.url });
        return;
      } catch (error) {
        db.prepare("UPDATE orders SET payment_status = 'stripe_session_failed', order_status = 'cancelled' WHERE id = ?").run(
          orderId,
        );
        sendJson(res, 502, { error: `Stripe checkout failed: ${error.message}` });
        return;
      }
    }

    sendJson(res, 201, { order: getOrder(orderId, user) });
    return;
  }

  if (method === "GET" && requestUrl.pathname === "/api/my/orders") {
    requireUser(res, user);
    if (!user) return;
    const rows = db.prepare("SELECT id FROM orders WHERE buyer_id = ? ORDER BY created_at DESC").all(user.id);
    sendJson(res, 200, { orders: rows.map((row) => getOrder(row.id, user)) });
    return;
  }

  if (method === "GET" && requestUrl.pathname === "/api/my/sales") {
    requireUser(res, user);
    if (!user) return;
    const rows = db
      .prepare(
        `SELECT DISTINCT orders.id
         FROM orders
         JOIN order_items ON order_items.order_id = orders.id
         WHERE order_items.seller_id = ?
         ORDER BY orders.created_at DESC`,
      )
      .all(user.id);
    sendJson(res, 200, { orders: rows.map((row) => getSellerOrder(row.id, user.id)).filter(Boolean) });
    return;
  }

  const saleMatch = requestUrl.pathname.match(/^\/api\/my\/sales\/(\d+)$/);
  if (method === "PATCH" && saleMatch) {
    requireUser(res, user);
    if (!user) return;
    const orderId = Number(saleMatch[1]);
    const ownsOrderItem = db
      .prepare("SELECT 1 FROM order_items WHERE order_id = ? AND seller_id = ?")
      .get(orderId, user.id);

    if (!ownsOrderItem) {
      sendJson(res, 404, { error: "Seller order not found." });
      return;
    }

    const currentOrder = db.prepare("SELECT order_status FROM orders WHERE id = ?").get(orderId);
    if (currentOrder?.order_status === "awaiting_payment") {
      sendJson(res, 409, { error: "Wait until payment is confirmed before updating delivery." });
      return;
    }

    const body = await readJson(req);
    const orderStatus = cleanText(body.orderStatus || "", 32);
    const allowed = ["delivering", "complete"];

    if (!allowed.includes(orderStatus)) {
      sendJson(res, 400, { error: "Use delivering or complete for seller order updates." });
      return;
    }

    db.prepare(
      `UPDATE orders
       SET order_status = ?
       WHERE id = ?
         AND order_status NOT IN ('cancelled', 'refunded', 'disputed')`,
    ).run(orderStatus, orderId);
    const buyer = db.prepare("SELECT buyer_id FROM orders WHERE id = ?").get(orderId);
    if (buyer) {
      createNotification(buyer.buyer_id, "order", `Order #${orderId} ${orderStatus}`, `Seller marked your order ${orderStatus}.`, "#order");
    }

    sendJson(res, 200, { order: getSellerOrder(orderId, user.id) });
    return;
  }

  const orderAccessMatch = requestUrl.pathname.match(/^\/api\/orders\/(\d+)$/);
  if (method === "GET" && orderAccessMatch) {
    requireUser(res, user);
    if (!user) return;
    const order = getOrderForUser(Number(orderAccessMatch[1]), user);
    if (!order) {
      sendJson(res, 404, { error: "Order not found." });
      return;
    }
    sendJson(res, 200, { order });
    return;
  }

  const orderMessagesMatch = requestUrl.pathname.match(/^\/api\/orders\/(\d+)\/messages$/);
  if (method === "GET" && orderMessagesMatch) {
    requireUser(res, user);
    if (!user) return;
    const orderId = Number(orderMessagesMatch[1]);
    if (!getOrderForUser(orderId, user)) {
      sendJson(res, 404, { error: "Order not found." });
      return;
    }
    sendJson(res, 200, { messages: getOrderMessages(orderId) });
    return;
  }

  if (method === "POST" && orderMessagesMatch) {
    requireUser(res, user);
    if (!user) return;
    const orderId = Number(orderMessagesMatch[1]);
    if (!getOrderForUser(orderId, user)) {
      sendJson(res, 404, { error: "Order not found." });
      return;
    }

    const body = await readJson(req, 5_000_000);
    const message = cleanText(body.message || "", 1000);
    let attachmentUrl = "";
    if (body.attachmentDataUrl) {
      attachmentUrl = await saveDataUrl(body.attachmentDataUrl);
    }
    const messageType = attachmentUrl ? "proof" : cleanText(body.messageType || "message", 20);
    if (!message && !attachmentUrl) {
      sendJson(res, 400, { error: "Write a message first." });
      return;
    }

    db.prepare("INSERT INTO order_messages (order_id, user_id, body, message_type, attachment_url) VALUES (?, ?, ?, ?, ?)").run(
      orderId,
      user.id,
      message || "Uploaded delivery proof.",
      messageType === "proof" ? "proof" : "message",
      attachmentUrl,
    );
    for (const participantId of orderParticipantIds(orderId).filter((id) => id !== user.id)) {
      createNotification(
        participantId,
        messageType === "proof" ? "proof" : "message",
        `Order #${orderId} update`,
        `${user.username} ${attachmentUrl ? "uploaded proof" : "sent a message"}.`,
        "#order",
      );
    }
    sendJson(res, 201, { messages: getOrderMessages(orderId) });
    return;
  }

  const orderDisputeMatch = requestUrl.pathname.match(/^\/api\/orders\/(\d+)\/dispute$/);
  if (method === "POST" && orderDisputeMatch) {
    requireUser(res, user);
    if (!user) return;
    const orderId = Number(orderDisputeMatch[1]);
    const order = getOrderForUser(orderId, user);
    if (!order) {
      sendJson(res, 404, { error: "Order not found." });
      return;
    }

    const body = await readJson(req);
    const reason = cleanText(body.reason || "Buyer reported an issue.", 500);
    const disputeId = `internal_${orderId}`;
    const evidenceDueAt = internalEvidenceDueAt(orderId);
    db.prepare(
      `INSERT INTO disputes
        (order_id, provider, provider_dispute_id, charge_id, amount_cents, status, reason, evidence_due_at, raw_payload)
       VALUES (?, 'internal', ?, '', ?, 'needs_review', ?, ?, ?)
       ON CONFLICT(provider_dispute_id) DO UPDATE SET
         status = 'needs_review',
         reason = excluded.reason,
         evidence_due_at = excluded.evidence_due_at,
         raw_payload = excluded.raw_payload,
         updated_at = CURRENT_TIMESTAMP`,
    ).run(
      orderId,
      disputeId,
      Math.round(Number(order.orderTotal || order.total || 0) * 100),
      reason,
      evidenceDueAt,
      JSON.stringify({ user_id: user.id, reason, evidence_due_at: evidenceDueAt }),
    );
    db.prepare("UPDATE orders SET order_status = 'disputed' WHERE id = ?").run(orderId);
    db.prepare("INSERT INTO order_messages (order_id, user_id, body) VALUES (?, ?, ?)").run(
      orderId,
      user.id,
      `Opened a dispute: ${reason}`,
    );
    for (const participantId of orderParticipantIds(orderId).filter((id) => id !== user.id)) {
      createNotification(participantId, "dispute", `Dispute opened on order #${orderId}`, reason, "#account");
    }
    sendJson(res, 201, { order: getOrderForUser(orderId, user), messages: getOrderMessages(orderId) });
    return;
  }

  const orderRatingMatch = requestUrl.pathname.match(/^\/api\/orders\/(\d+)\/ratings$/);
  if (method === "POST" && orderRatingMatch) {
    requireUser(res, user);
    if (!user) return;
    const orderId = Number(orderRatingMatch[1]);
    const fullOrder = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
    const order = getOrderForUser(orderId, user);
    if (!order || !fullOrder) {
      sendJson(res, 404, { error: "Order not found." });
      return;
    }
    if (fullOrder.order_status !== "complete") {
      sendJson(res, 409, { error: "Ratings unlock after the order is complete." });
      return;
    }

    const body = await readJson(req);
    const score = Math.round(Number(body.score || 0));
    const comment = cleanText(body.comment || "", 500);
    const ratedUserId = ratingTargetForOrder(orderId, user, Number(body.ratedUserId || 0));
    if (!ratedUserId) {
      sendJson(res, 400, { error: "Choose who to rate for this order." });
      return;
    }
    if (score < 1 || score > 5) {
      sendJson(res, 400, { error: "Rating must be between 1 and 5 stars." });
      return;
    }

    db.prepare(
      `INSERT INTO ratings (order_id, rater_id, rated_user_id, score, comment)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(order_id, rater_id, rated_user_id) DO UPDATE SET
         score = excluded.score,
         comment = excluded.comment,
         created_at = CURRENT_TIMESTAMP`,
    ).run(orderId, user.id, ratedUserId, score, comment);
    updateSellerTier(ratedUserId);
    createNotification(ratedUserId, "rating", `New ${score}-star rating`, comment || `Order #${orderId} was rated.`, "#account");
    sendJson(res, 201, { order: getOrderForUser(orderId, user), seller: getSellerProfile(ratedUserId) });
    return;
  }

  const orderSyncMatch = requestUrl.pathname.match(/^\/api\/orders\/(\d+)\/sync-stripe$/);
  if (method === "POST" && orderSyncMatch) {
    requireUser(res, user);
    if (!user) return;
    const orderId = Number(orderSyncMatch[1]);
    const order = getOrderForUser(orderId, user);
    if (!order) {
      sendJson(res, 404, { error: "Order not found." });
      return;
    }

    try {
      await syncStripeCheckoutOrder(orderId);
      sendJson(res, 200, { order: getOrderForUser(orderId, user) });
    } catch (error) {
      sendJson(res, 502, { error: `Could not refresh Stripe payment: ${error.message}` });
    }
    return;
  }

  const orderConfirmMatch = requestUrl.pathname.match(/^\/api\/orders\/(\d+)\/confirm$/);
  if (method === "POST" && orderConfirmMatch) {
    requireUser(res, user);
    if (!user) return;
    const orderId = Number(orderConfirmMatch[1]);
    const order = db.prepare("SELECT * FROM orders WHERE id = ? AND buyer_id = ?").get(orderId, user.id);
    if (!order) {
      sendJson(res, 404, { error: "Order not found." });
      return;
    }
    if (["awaiting_payment", "cancelled", "refunded", "disputed"].includes(order.order_status)) {
      sendJson(res, 409, { error: "This order cannot be completed yet." });
      return;
    }
    db.prepare("UPDATE orders SET order_status = 'complete' WHERE id = ?").run(orderId);
    for (const sellerId of orderSellerIds(orderId)) {
      createNotification(sellerId, "order", `Order #${orderId} complete`, `${user.username} confirmed receipt.`, "#account");
      updateSellerTier(sellerId);
    }
    sendJson(res, 200, { order: getOrderForUser(orderId, user) });
    return;
  }

  if (requestUrl.pathname.startsWith("/api/admin/")) {
    requireAdmin(res, user);
    if (!user || user.role !== "admin") return;
    await routeAdmin(req, res, requestUrl, method, user);
    return;
  }

  sendJson(res, 404, { error: "API route not found." });
}

async function routeAdmin(req, res, requestUrl, method, user) {
  if (method === "GET" && requestUrl.pathname === "/api/admin/listings") {
    const rows = db
      .prepare(
        `SELECT listings.*, users.username AS seller_name, users.role AS seller_role
         FROM listings JOIN users ON listings.seller_id = users.id
         ORDER BY listings.created_at DESC`,
      )
      .all();
    sendJson(res, 200, { listings: rows.map(formatListing) });
    return;
  }

  const listingMatch = requestUrl.pathname.match(/^\/api\/admin\/listings\/(\d+)$/);
  if (method === "PATCH" && listingMatch) {
    const body = await readJson(req);
    const status = ["pending", "approved", "rejected"].includes(body.status) ? body.status : "";
    const note = cleanText(body.moderationNote || "", 500);

    if (!status) {
      sendJson(res, 400, { error: "Use a valid moderation status." });
      return;
    }

    db.prepare(
      "UPDATE listings SET status = ?, moderation_note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    ).run(status, note, Number(listingMatch[1]));

    const row = db
      .prepare(
        `SELECT listings.*, users.username AS seller_name, users.role AS seller_role
         FROM listings JOIN users ON listings.seller_id = users.id
         WHERE listings.id = ?`,
      )
      .get(Number(listingMatch[1]));
    sendJson(res, 200, { listing: formatListing(row) });
    return;
  }

  if (method === "GET" && requestUrl.pathname === "/api/admin/orders") {
    const rows = db.prepare("SELECT id FROM orders ORDER BY created_at DESC").all();
    sendJson(res, 200, { orders: rows.map((row) => getOrder(row.id, { role: "admin" })) });
    return;
  }

  if (method === "GET" && requestUrl.pathname === "/api/admin/disputes") {
    const rows = db.prepare("SELECT * FROM disputes ORDER BY updated_at DESC").all();
    sendJson(res, 200, { disputes: rows.map(formatDispute) });
    return;
  }

  const disputeResolveMatch = requestUrl.pathname.match(/^\/api\/admin\/disputes\/(\d+)\/resolve$/);
  if (method === "POST" && disputeResolveMatch) {
    const body = await readJson(req);
    const disputeId = Number(disputeResolveMatch[1]);
    const outcome = cleanText(body.outcome || "", 30);
    const note = cleanText(body.note || "", 500);
    const dispute = db.prepare("SELECT * FROM disputes WHERE id = ?").get(disputeId);
    if (!dispute) {
      sendJson(res, 404, { error: "Dispute not found." });
      return;
    }
    const order = dispute.order_id ? db.prepare("SELECT * FROM orders WHERE id = ?").get(dispute.order_id) : null;
    if (!["buyer", "seller", "cancel"].includes(outcome)) {
      sendJson(res, 400, { error: "Use buyer, seller, or cancel as the resolution." });
      return;
    }
    try {
      if (order && outcome === "buyer") {
        const remaining = order.total_cents - order.refunded_cents;
        if (remaining > 0) {
          await createOrderRefund(order, remaining, "requested_by_customer");
        }
        db.prepare("UPDATE orders SET order_status = 'refunded' WHERE id = ?").run(order.id);
      } else if (order && outcome === "seller") {
        db.prepare("UPDATE orders SET order_status = 'complete' WHERE id = ?").run(order.id);
        for (const sellerId of orderSellerIds(order.id)) updateSellerTier(sellerId);
      } else if (order && outcome === "cancel") {
        db.prepare("UPDATE orders SET order_status = 'cancelled' WHERE id = ?").run(order.id);
      }
      db.prepare(
        "UPDATE disputes SET status = ?, resolution = ?, resolved_by = ?, resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      ).run(`resolved_${outcome}`, note || `Resolved in favor of ${outcome}.`, user.id, disputeId);
      if (order) {
        for (const participantId of orderParticipantIds(order.id)) {
          createNotification(
            participantId,
            "dispute",
            `Dispute resolved on order #${order.id}`,
            note || `Resolution: ${outcome}.`,
            "#account",
          );
        }
      }
      sendJson(res, 200, { dispute: formatDispute(db.prepare("SELECT * FROM disputes WHERE id = ?").get(disputeId)) });
    } catch (error) {
      sendJson(res, 502, { error: `Resolution failed: ${error.message}` });
    }
    return;
  }

  const refundMatch = requestUrl.pathname.match(/^\/api\/admin\/orders\/(\d+)\/refund$/);
  if (method === "POST" && refundMatch) {
    const body = await readJson(req);
    const orderId = Number(refundMatch[1]);
    const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);

    if (!order) {
      sendJson(res, 404, { error: "Order not found." });
      return;
    }

    const requested = body.amount ? Math.round(Number(body.amount) * 100) : order.total_cents - order.refunded_cents;
    const remaining = order.total_cents - order.refunded_cents;
    if (!Number.isFinite(requested) || requested <= 0 || requested > remaining) {
      sendJson(res, 400, { error: "Refund amount must be greater than zero and no more than the remaining total." });
      return;
    }

    try {
      const refund = await createOrderRefund(order, requested, cleanText(body.reason || "requested_by_customer", 80));
      for (const participantId of orderParticipantIds(orderId)) {
        createNotification(participantId, "refund", `Refund issued for order #${orderId}`, `${centsToDollars(requested)} refunded.`, "#account");
      }
      sendJson(res, 201, { refund, order: getOrder(orderId, { role: "admin" }) });
    } catch (error) {
      sendJson(res, 502, { error: `Refund failed: ${error.message}` });
    }
    return;
  }

  const orderMatch = requestUrl.pathname.match(/^\/api\/admin\/orders\/(\d+)$/);
  if (method === "PATCH" && orderMatch) {
    const body = await readJson(req);
    const orderStatus = cleanText(body.orderStatus || "", 32);
    const allowed = ["new", "awaiting_payment", "paid", "delivering", "complete", "disputed", "cancelled", "refunded"];
    if (!allowed.includes(orderStatus)) {
      sendJson(res, 400, { error: "Use a valid order status." });
      return;
    }
    db.prepare("UPDATE orders SET order_status = ? WHERE id = ?").run(orderStatus, Number(orderMatch[1]));
    sendJson(res, 200, { order: getOrder(Number(orderMatch[1]), { role: "admin" }) });
    return;
  }

  sendJson(res, 404, { error: "Admin route not found." });
}

async function serveStatic(res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : decodeURIComponent(pathname);
  const filePath = path.normalize(path.join(rootDir, safePath));

  if (!filePath.startsWith(rootDir)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) throw new Error("Not a file");
    const contentType =
      {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".gif": "image/gif",
        ".svg": "image/svg+xml",
      }[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    sendText(res, 404, "Not found");
  }
}

function seedAdmin() {
  const count = db.prepare("SELECT COUNT(*) AS count FROM users").get().count;
  if (count > 0) return;
  db.prepare("INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, 'admin')").run(
    "LootXHub Admin",
    "admin@lootxhub.local",
    hashPassword("ChangeMe123!"),
  );
}

function seedListings() {
  const count = db.prepare("SELECT COUNT(*) AS count FROM listings").get().count;
  if (count > 0) return;
  const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
  const examples = [
    ["Grow a Garden Token Pack", "Grow a Garden", "Currency", "250K tokens with fast confirmation.", 849, "Instant"],
    ["Pet Simulator 99 Gems", "Pet Simulator 99", "Currency", "High-value gems for trading and upgrades.", 1199, "Coordinated"],
    ["Adopt Me Legendary Pet", "Adopt Me", "Items", "Legendary pet with seller-guided handoff.", 1499, "Coordinated"],
    ["Blade Ball Token Drop", "Blade Ball", "Currency", "Tokens for spins, upgrades, and event runs.", 625, "Instant"],
    ["Roblox Starter Account", "Roblox", "Accounts", "Starter profile bundle with inventory notes.", 2400, "Manual"],
    ["Custom Boosting Request", "Roblox", "Boosting", "Describe your goal and receive a seller quote.", 0, "Quote"],
  ];
  const insert = db.prepare(
    `INSERT INTO listings
      (seller_id, title, game, category, description, price_cents, delivery_method, image_url, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'approved')`,
  );

  for (const [title, game, category, description, price, delivery] of examples) {
    insert.run(admin.id, title, game, category, description, price, delivery, makeSvgDataUrl(title, game));
  }
}

async function validateListing(body) {
  const title = cleanText(body.title, 90);
  const game = cleanText(body.game, 50);
  const category = cleanText(body.category, 30);
  const description = cleanText(body.description, 600);
  const deliveryMethod = cleanText(body.deliveryMethod, 30);
  const deliveryWindow = cleanText(body.deliveryWindow || "24 hours", 30);
  const region = cleanText(body.region || "Global", 30);
  const platform = cleanText(body.platform || "All platforms", 40);
  const stock = Math.round(Number(body.stock || 1));
  const warrantyDays = Math.round(Number(body.warrantyDays || 0));
  const priceCents = Math.round(Number(body.price || 0) * 100);
  const categories = ["Currency", "Items", "Accounts", "Boosting", "Gift Cards", "Top Ups"];
  const deliveries = ["Instant", "Coordinated", "Manual", "Quote"];
  const deliveryWindows = ["15 min", "1 hour", "6 hours", "12 hours", "24 hours", "2 days", "3 days"];
  const regions = ["Global", "NA", "EU", "Asia", "Oceania", "LATAM"];

  if (!title || !game || !description) return { error: "Title, game, and description are required." };
  if (!categories.includes(category)) return { error: "Choose a valid category." };
  if (!deliveries.includes(deliveryMethod)) return { error: "Choose a valid delivery method." };
  if (!deliveryWindows.includes(deliveryWindow)) return { error: "Choose a valid delivery time." };
  if (!regions.includes(region)) return { error: "Choose a valid region." };
  if (!Number.isFinite(stock) || stock < 1 || stock > 999) return { error: "Stock must be between 1 and 999." };
  if (!Number.isFinite(warrantyDays) || warrantyDays < 0 || warrantyDays > 30) {
    return { error: "Warranty days must be between 0 and 30." };
  }
  if (!Number.isFinite(priceCents) || priceCents < 0 || priceCents > 10000000) {
    return { error: "Use a valid price." };
  }
  if (description.length < 24) {
    return { error: "Add a clearer description so buyers know exactly what they will receive." };
  }

  const combined = `${title} ${description}`.toLowerCase();
  const blockedTerms = ["random", "mystery", "chance", "raffle", "lottery", "lootbox", "loot box"];
  if (blockedTerms.some((term) => combined.includes(term))) {
    return { error: "Avoid random or chance listings. Describe the exact item or service being sold." };
  }
  if (category === "Accounts" && deliveryMethod === "Instant") {
    return { error: "Account listings should use Manual or Coordinated delivery." };
  }

  let imageUrl = cleanText(body.imageUrl || "", 1200);
  if (body.imageDataUrl) {
    imageUrl = await saveDataUrl(body.imageDataUrl);
  }

  if (!imageUrl) imageUrl = makeSvgDataUrl(title, game);
  return {
    title,
    game,
    category,
    description,
    deliveryMethod,
    deliveryWindow,
    stock,
    region,
    platform,
    warrantyDays,
    priceCents,
    imageUrl,
  };
}

async function saveDataUrl(dataUrl) {
  const match = String(dataUrl).match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([a-zA-Z0-9+/=]+)$/);
  if (!match) throw new Error("Uploaded image must be PNG, JPG, WEBP, or GIF.");
  const mime = match[1];
  const extension = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif" }[mime];
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length > 3_000_000) throw new Error("Uploaded images must be under 3 MB.");
  const filename = `${crypto.randomUUID()}${extension}`;
  await fsp.writeFile(path.join(uploadDir, filename), bytes);
  return `/uploads/${filename}`;
}

function makeSvgDataUrl(title, game) {
  const colors = [
    ["#3187ff", "#21bad5"],
    ["#15a67a", "#f4b83f"],
    ["#f4b83f", "#ef7b45"],
    ["#e65783", "#7b61ff"],
    ["#111722", "#3187ff"],
  ];
  const index = Math.abs(hashCode(title)) % colors.length;
  const [first, second] = colors[index];
  const mark = cleanText(game, 2).toUpperCase() || "LX";
  const safeTitle = escapeXml(title);
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 580">
      <defs>
        <linearGradient id="g" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stop-color="${first}" />
          <stop offset="1" stop-color="${second}" />
        </linearGradient>
      </defs>
      <rect width="900" height="580" rx="42" fill="url(#g)" />
      <circle cx="760" cy="92" r="160" fill="#fff" opacity=".2" />
      <circle cx="130" cy="510" r="210" fill="#fff" opacity=".14" />
      <rect x="94" y="92" width="712" height="396" rx="34" fill="#fff" opacity=".18" />
      <text x="450" y="330" text-anchor="middle" font-family="Arial" font-size="154" font-weight="900" fill="#fff">${escapeXml(mark)}</text>
      <text x="450" y="514" text-anchor="middle" font-family="Arial" font-size="34" font-weight="800" fill="#fff">${safeTitle}</text>
    </svg>
  `;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function getOrder(orderId, user) {
  const order =
    user.role === "admin"
      ? db.prepare("SELECT orders.*, users.username AS buyer_name FROM orders JOIN users ON orders.buyer_id = users.id WHERE orders.id = ?").get(orderId)
      : db.prepare("SELECT orders.*, users.username AS buyer_name FROM orders JOIN users ON orders.buyer_id = users.id WHERE orders.id = ? AND buyer_id = ?").get(orderId, user.id);
  if (!order) return null;
  const items = db
    .prepare(
      `SELECT order_items.*, users.username AS seller_name, COALESCE(order_items.image_url, listings.image_url) AS item_image_url
       FROM order_items
       JOIN users ON order_items.seller_id = users.id
       LEFT JOIN listings ON listings.id = order_items.listing_id
       WHERE order_items.order_id = ?`,
    )
    .all(orderId);
  return {
    id: order.id,
    viewerRole: user.role === "admin" ? "admin" : "buyer",
    buyerName: order.buyer_name,
    total: centsToDollars(order.total_cents),
    platformFee: centsToDollars(order.platform_fee_cents),
    sellerProceeds: centsToDollars(order.total_cents - order.platform_fee_cents),
    paymentMethod: order.payment_method,
    paymentStatus: order.payment_status,
    orderStatus: order.order_status,
    provider: order.provider,
    providerSessionId: order.provider_session_id,
    providerPaymentIntent: order.provider_payment_intent,
    providerChargeId: order.provider_charge_id,
    refunded: centsToDollars(order.refunded_cents),
    createdAt: order.created_at,
    items: items.map((item) => ({
      id: item.id,
      listingId: item.listing_id,
      sellerId: item.seller_id,
      sellerName: item.seller_name,
      title: item.title,
      price: centsToDollars(item.price_cents),
      platformFee: centsToDollars(item.platform_fee_cents),
      sellerNet: centsToDollars(item.price_cents - item.platform_fee_cents),
      imageUrl: item.item_image_url || makeSvgDataUrl(item.title, "LootXHub"),
    })),
    refunds: db
      .prepare("SELECT * FROM refunds WHERE order_id = ? ORDER BY created_at DESC")
      .all(orderId)
      .map(formatRefund),
    disputes: db
      .prepare("SELECT * FROM disputes WHERE order_id = ? ORDER BY updated_at DESC")
      .all(orderId)
      .map(formatDispute),
  };
}

function getSellerOrder(orderId, sellerId) {
  const order = db
    .prepare(
      `SELECT orders.*, users.username AS buyer_name
       FROM orders
       JOIN users ON orders.buyer_id = users.id
       JOIN order_items ON order_items.order_id = orders.id
       WHERE orders.id = ? AND order_items.seller_id = ?
       LIMIT 1`,
    )
    .get(orderId, sellerId);
  if (!order) return null;

  const items = db
    .prepare(
      `SELECT order_items.*, users.username AS seller_name, COALESCE(order_items.image_url, listings.image_url) AS item_image_url
       FROM order_items
       JOIN users ON order_items.seller_id = users.id
       LEFT JOIN listings ON listings.id = order_items.listing_id
       WHERE order_items.order_id = ? AND order_items.seller_id = ?`,
    )
    .all(orderId, sellerId);
  const sellerTotal = items.reduce((sum, item) => sum + Number(item.price_cents), 0);
  const sellerFees = items.reduce((sum, item) => sum + Number(item.platform_fee_cents || 0), 0);

  return {
    id: order.id,
    viewerRole: "seller",
    buyerName: order.buyer_name,
    total: centsToDollars(sellerTotal - sellerFees),
    orderTotal: centsToDollars(order.total_cents),
    platformFee: centsToDollars(sellerFees),
    grossTotal: centsToDollars(sellerTotal),
    paymentMethod: order.payment_method,
    paymentStatus: order.payment_status,
    orderStatus: order.order_status,
    provider: order.provider,
    createdAt: order.created_at,
    items: items.map((item) => ({
      id: item.id,
      listingId: item.listing_id,
      sellerId: item.seller_id,
      sellerName: item.seller_name,
      title: item.title,
      price: centsToDollars(item.price_cents),
      platformFee: centsToDollars(item.platform_fee_cents),
      sellerNet: centsToDollars(item.price_cents - item.platform_fee_cents),
      imageUrl: item.item_image_url || makeSvgDataUrl(item.title, "LootXHub"),
    })),
  };
}

function getOrderForUser(orderId, user) {
  if (user.role === "admin") return getOrder(orderId, { role: "admin" });
  const buyerOrder = getOrder(orderId, user);
  if (buyerOrder) return buyerOrder;
  return getSellerOrder(orderId, user.id);
}

function formatRefund(row) {
  return {
    id: row.id,
    orderId: row.order_id,
    provider: row.provider,
    providerRefundId: row.provider_refund_id,
    amount: centsToDollars(row.amount_cents),
    status: row.status,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

function formatDispute(row) {
  return {
    id: row.id,
    orderId: row.order_id,
    provider: row.provider,
    providerDisputeId: row.provider_dispute_id,
    chargeId: row.charge_id,
    amount: centsToDollars(row.amount_cents),
    status: row.status,
    reason: row.reason,
    evidenceDueAt: row.evidence_due_at,
    resolution: row.resolution,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at,
    updatedAt: row.updated_at,
  };
}

function formatListing(row) {
  return {
    id: row.id,
    sellerId: row.seller_id,
    sellerName: row.seller_name,
    sellerRole: row.seller_role,
    title: row.title,
    game: row.game,
    category: row.category,
    description: row.description,
    price: centsToDollars(row.price_cents),
    deliveryMethod: row.delivery_method,
    deliveryWindow: row.delivery_window || "24 hours",
    stock: Number(row.stock || 1),
    region: row.region || "Global",
    platform: row.platform || "All platforms",
    warrantyDays: Number(row.warranty_days || 0),
    soldCount: Number(row.sold_count ?? listingSoldCount(row.id)),
    favoriteCount: Number(row.favorite_count ?? listingFavoriteCount(row.id)),
    imageUrl: row.image_url,
    status: row.status,
    moderationNote: row.moderation_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function listingSoldCount(listingId) {
  return db.prepare("SELECT COUNT(*) AS count FROM order_items WHERE listing_id = ?").get(listingId).count;
}

function listingFavoriteCount(listingId) {
  return db.prepare("SELECT COUNT(*) AS count FROM favorites WHERE listing_id = ?").get(listingId).count;
}

function getSellerProfile(sellerId) {
  const seller = db.prepare("SELECT * FROM users WHERE id = ?").get(sellerId);
  if (!seller) return null;

  const rating = db
    .prepare(
      "SELECT COUNT(*) AS count, COALESCE(AVG(score), 0) AS average FROM ratings WHERE rated_user_id = ?",
    )
    .get(sellerId);
  const completed = db
    .prepare(
      `SELECT COUNT(DISTINCT orders.id) AS count
       FROM orders
       JOIN order_items ON order_items.order_id = orders.id
       WHERE order_items.seller_id = ? AND orders.order_status = 'complete'`,
    )
    .get(sellerId).count;
  const activeListings = db
    .prepare("SELECT COUNT(*) AS count FROM listings WHERE seller_id = ? AND status = 'approved'")
    .get(sellerId).count;
  const listings = db
    .prepare(
      `SELECT listings.*, users.username AS seller_name, users.role AS seller_role
       FROM listings JOIN users ON listings.seller_id = users.id
       WHERE listings.seller_id = ? AND listings.status = 'approved'
       ORDER BY listings.created_at DESC
       LIMIT 8`,
    )
    .all(sellerId)
    .map(formatListing);

  const badges = ["Self-serve seller"];
  if (seller.role === "admin") badges.push("Verified admin");
  if (seller.seller_status === "active") badges.push("Active seller");
  if (completed >= 1) badges.push("Completed orders");
  if (Number(rating.average) >= 4.5 && Number(rating.count) >= 3) badges.push("Top rated");
  if (activeListings >= 5) badges.push("High stock");
  const sellerTier = sellerTierForStats(completed, Number(rating.average || 0), Number(rating.count || 0), activeListings);
  if (!badges.includes(sellerTier)) badges.push(sellerTier);
  if (seller.stripe_payouts_enabled) badges.push("Payout ready");

  return {
    id: seller.id,
    username: seller.username,
    role: seller.role,
    sellerStatus: seller.seller_status,
    sellerTier,
    connect: sellerConnectStatus(seller),
    joinedAt: seller.created_at,
    ratingAverage: Number(Number(rating.average || 0).toFixed(1)),
    ratingCount: rating.count,
    completedOrders: completed,
    activeListings,
    responseTime: completed > 0 ? "Usually under 1 hour" : "New seller",
    badges,
    listings,
  };
}

function getSellerWallet(sellerId) {
  const rows = db
    .prepare(
      `SELECT orders.id, orders.order_status, orders.payment_status, order_items.price_cents
              , order_items.platform_fee_cents
       FROM order_items
       JOIN orders ON orders.id = order_items.order_id
       WHERE order_items.seller_id = ?`,
    )
    .all(sellerId);

  const wallet = {
    pending: 0,
    available: 0,
    held: 0,
    grossSales: 0,
    completedOrders: 0,
    pendingOrders: 0,
    platformFees: 0,
  };

  const completedIds = new Set();
  const pendingIds = new Set();

  for (const row of rows) {
    const gross = Number(row.price_cents || 0);
    const fee = Number(row.platform_fee_cents || 0);
    const amount = Math.max(0, gross - fee);
    wallet.platformFees += fee;
    wallet.grossSales += gross;
    if (row.order_status === "complete") {
      wallet.available += amount;
      completedIds.add(row.id);
    } else if (row.order_status === "disputed" || row.payment_status === "manual_pending") {
      wallet.held += amount;
      pendingIds.add(row.id);
    } else if (["paid", "delivering"].includes(row.order_status) || ["paid", "demo_paid"].includes(row.payment_status)) {
      wallet.pending += amount;
      pendingIds.add(row.id);
    }
  }

  wallet.completedOrders = completedIds.size;
  wallet.pendingOrders = pendingIds.size;
  return {
    pending: centsToDollars(wallet.pending),
    available: centsToDollars(wallet.available),
    held: centsToDollars(wallet.held),
    grossSales: centsToDollars(wallet.grossSales),
    platformFees: centsToDollars(wallet.platformFees),
    completedOrders: wallet.completedOrders,
    pendingOrders: wallet.pendingOrders,
    payoutNote: "Connect Stripe Connect later to withdraw real seller balances.",
  };
}

function getOrderMessages(orderId) {
  return db
    .prepare(
      `SELECT order_messages.*, users.username, users.role
       FROM order_messages
       JOIN users ON users.id = order_messages.user_id
       WHERE order_messages.order_id = ?
       ORDER BY order_messages.created_at ASC`,
    )
    .all(orderId)
    .map((row) => ({
      id: row.id,
      orderId: row.order_id,
      userId: row.user_id,
      username: row.username,
      role: row.role,
      body: row.body,
      messageType: row.message_type || "message",
      attachmentUrl: row.attachment_url || "",
      createdAt: row.created_at,
    }));
}

function internalEvidenceDueAt(orderId) {
  const rows = db
    .prepare(
      `SELECT listings.category
       FROM order_items
       JOIN listings ON listings.id = order_items.listing_id
       WHERE order_items.order_id = ?`,
    )
    .all(orderId);
  const quickProof = rows.some((row) => ["Currency", "Items", "Gift Cards", "Top Ups"].includes(row.category));
  const hours = quickProof ? 2 : 12;
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

function platformFeeForPrice(priceCents) {
  return Math.max(0, Math.round(Number(priceCents || 0) * (platformFeePercent / 100)));
}

function tokenHash(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function sellerTierForStats(completedOrders, ratingAverage, ratingCount, activeListings) {
  if (completedOrders >= 100 && ratingAverage >= 4.8 && ratingCount >= 25) return "Elite Seller";
  if (completedOrders >= 25 && ratingAverage >= 4.6 && ratingCount >= 8) return "Pro Seller";
  if (completedOrders >= 3 || activeListings >= 5) return "Verified Seller";
  return "New Seller";
}

function updateSellerTier(sellerId) {
  const profile = getSellerProfile(sellerId);
  if (!profile) return;
  db.prepare("UPDATE users SET seller_tier = ? WHERE id = ?").run(profile.sellerTier, sellerId);
}

function sellerConnectStatus(user) {
  return {
    accountId: user?.stripe_account_id || "",
    onboardingStatus: user?.stripe_onboarding_status || "not_started",
    chargesEnabled: Boolean(user?.stripe_charges_enabled),
    payoutsEnabled: Boolean(user?.stripe_payouts_enabled),
    payoutReady: Boolean(user?.stripe_charges_enabled && user?.stripe_payouts_enabled),
  };
}

function formatNotification(row) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    url: row.url || "",
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

function createNotification(userId, type, title, body, url = "") {
  if (!userId) return;
  db.prepare("INSERT INTO notifications (user_id, type, title, body, url) VALUES (?, ?, ?, ?, ?)").run(
    userId,
    cleanText(type, 40) || "notice",
    cleanText(title, 120),
    cleanText(body, 500),
    cleanText(url, 120),
  );
}

function orderSellerIds(orderId) {
  return db
    .prepare("SELECT DISTINCT seller_id FROM order_items WHERE order_id = ?")
    .all(orderId)
    .map((row) => row.seller_id);
}

function orderParticipantIds(orderId) {
  const order = db.prepare("SELECT buyer_id FROM orders WHERE id = ?").get(orderId);
  return [...new Set([order?.buyer_id, ...orderSellerIds(orderId)].filter(Boolean))];
}

function ratingTargetForOrder(orderId, user, requestedTargetId) {
  const order = db.prepare("SELECT buyer_id FROM orders WHERE id = ?").get(orderId);
  if (!order) return 0;

  if (user.id === order.buyer_id) {
    if (requestedTargetId) {
      const target = db
        .prepare("SELECT 1 FROM order_items WHERE order_id = ? AND seller_id = ?")
        .get(orderId, requestedTargetId);
      return target ? requestedTargetId : 0;
    }
    const firstSeller = db.prepare("SELECT seller_id FROM order_items WHERE order_id = ? ORDER BY id LIMIT 1").get(orderId);
    return firstSeller?.seller_id || 0;
  }

  const sellerItem = db
    .prepare("SELECT 1 FROM order_items WHERE order_id = ? AND seller_id = ?")
    .get(orderId, user.id);
  return sellerItem ? order.buyer_id : 0;
}

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
  if (!columns.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function appBaseUrl(req) {
  if (publicAppUrl) return publicAppUrl.replace(/\/$/, "");
  return `http://${req.headers.host || `${host}:${port}`}`;
}

async function createStripeConnectedAccount(user) {
  const account = await stripeRequest("POST", "/v1/accounts", {
    type: "express",
    email: user.email,
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
    },
    business_profile: {
      product_description: "Digital goods marketplace seller",
    },
    metadata: {
      lootxhub_user_id: String(user.id),
    },
  });
  db.prepare(
    "UPDATE users SET stripe_account_id = ?, stripe_onboarding_status = 'started', stripe_charges_enabled = ?, stripe_payouts_enabled = ? WHERE id = ?",
  ).run(account.id, account.charges_enabled ? 1 : 0, account.payouts_enabled ? 1 : 0, user.id);
  return account.id;
}

async function createStripeAccountLink(req, accountId) {
  const baseUrl = appBaseUrl(req);
  return stripeRequest("POST", "/v1/account_links", {
    account: accountId,
    refresh_url: `${baseUrl}/#account`,
    return_url: `${baseUrl}/#account`,
    type: "account_onboarding",
  });
}

async function refreshStripeAccountStatus(userId, accountId) {
  const account = await stripeRequest("GET", `/v1/accounts/${encodeURIComponent(accountId)}`);
  db.prepare(
    `UPDATE users
     SET stripe_onboarding_status = ?,
         stripe_charges_enabled = ?,
         stripe_payouts_enabled = ?
     WHERE id = ?`,
  ).run(
    account.details_submitted ? "complete" : "started",
    account.charges_enabled ? 1 : 0,
    account.payouts_enabled ? 1 : 0,
    userId,
  );
  return account;
}

async function createStripeCheckoutSession(req, orderId, rows, user, platformFeeCents = 0) {
  const baseUrl = appBaseUrl(req);
  const sellerIds = [...new Set(rows.map((row) => row.seller_id))];
  const seller = sellerIds.length === 1 ? db.prepare("SELECT * FROM users WHERE id = ?").get(sellerIds[0]) : null;
  const destination = seller?.stripe_account_id && seller.stripe_charges_enabled ? seller.stripe_account_id : "";
  const params = {
    mode: "payment",
    success_url: `${baseUrl}/?checkout=success&order_id=${orderId}`,
    cancel_url: `${baseUrl}/?checkout=cancelled&order_id=${orderId}`,
    client_reference_id: String(orderId),
    customer_email: user.email,
    metadata: {
      order_id: String(orderId),
      buyer_id: String(user.id),
    },
    payment_intent_data: {
      metadata: {
        order_id: String(orderId),
        buyer_id: String(user.id),
      },
      ...(destination
        ? {
            application_fee_amount: platformFeeCents,
            transfer_data: { destination },
          }
        : {}),
    },
    line_items: rows.map((row) => ({
      quantity: 1,
      price_data: {
        currency: stripeCurrency,
        unit_amount: Math.max(50, row.price_cents),
        product_data: {
          name: row.title,
          description: row.description.slice(0, 240),
          metadata: {
            listing_id: String(row.id),
            seller_id: String(row.seller_id),
          },
        },
      },
    })),
  };

  return stripeRequest("POST", "/v1/checkout/sessions", params, `checkout-${orderId}`);
}

async function createOrderRefund(order, amountCents, reason) {
  const normalizedReason = ["duplicate", "fraudulent", "requested_by_customer"].includes(reason)
    ? reason
    : "requested_by_customer";

  if (order.payment_method === "stripe") {
    if (!stripeSecretKey) throw new Error("Stripe is not configured.");
    if (!order.provider_payment_intent) throw new Error("This order does not have a Stripe PaymentIntent yet.");

    const refund = await stripeRequest(
      "POST",
      "/v1/refunds",
      {
        payment_intent: order.provider_payment_intent,
        amount: amountCents,
        reason: normalizedReason,
        metadata: {
          order_id: String(order.id),
        },
      },
      `refund-${order.id}-${amountCents}-${Date.now()}`,
    );

    upsertRefund(order.id, "stripe", refund.id, amountCents, refund.status || "pending", normalizedReason, refund);
    applyRefundTotals(order.id);
    return formatRefund(db.prepare("SELECT * FROM refunds WHERE provider_refund_id = ?").get(refund.id));
  }

  const manualRefundId = `manual_${crypto.randomUUID()}`;
  upsertRefund(order.id, order.payment_method || "manual", manualRefundId, amountCents, "succeeded", normalizedReason, {
    id: manualRefundId,
    amount: amountCents,
  });
  applyRefundTotals(order.id);
  return formatRefund(db.prepare("SELECT * FROM refunds WHERE provider_refund_id = ?").get(manualRefundId));
}

async function syncStripeCheckoutOrder(orderId) {
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
  if (!order || order.payment_method !== "stripe") return;
  if (!stripeSecretKey) throw new Error("Stripe is not configured.");
  if (!order.provider_session_id) throw new Error("This order does not have a Stripe Checkout Session yet.");

  const session = await stripeRequest(
    "GET",
    `/v1/checkout/sessions/${encodeURIComponent(order.provider_session_id)}`,
    { expand: ["payment_intent", "payment_intent.latest_charge"] },
  );
  const paymentIntent = session.payment_intent;
  const paymentIntentId =
    typeof paymentIntent === "string" ? paymentIntent : paymentIntent && typeof paymentIntent === "object" ? paymentIntent.id : "";
  const latestCharge = paymentIntent && typeof paymentIntent === "object" ? paymentIntent.latest_charge : "";
  const chargeId = typeof latestCharge === "string" ? latestCharge : latestCharge && typeof latestCharge === "object" ? latestCharge.id : "";

  if (session.payment_status === "paid") {
    db.prepare(
      `UPDATE orders
       SET payment_status = 'paid',
           order_status = CASE WHEN order_status = 'awaiting_payment' THEN 'paid' ELSE order_status END,
           provider_session_id = ?,
           provider_payment_intent = COALESCE(?, provider_payment_intent),
           provider_charge_id = COALESCE(?, provider_charge_id)
       WHERE id = ?`,
    ).run(session.id, paymentIntentId || null, chargeId || null, orderId);
  } else if (session.status === "expired") {
    db.prepare("UPDATE orders SET payment_status = 'expired', order_status = 'cancelled' WHERE id = ?").run(orderId);
  } else {
    db.prepare("UPDATE orders SET payment_status = ?, provider_session_id = ? WHERE id = ?").run(
      `stripe_${session.payment_status || "pending"}`,
      session.id,
      orderId,
    );
  }

  recordPaymentEvent(orderId, "stripe", "checkout.session.synced", session);
}

function upsertRefund(orderId, provider, providerRefundId, amountCents, status, reason, rawPayload) {
  const existing = providerRefundId
    ? db.prepare("SELECT id FROM refunds WHERE provider_refund_id = ?").get(providerRefundId)
    : null;

  if (existing) {
    db.prepare(
      "UPDATE refunds SET amount_cents = ?, status = ?, reason = ?, raw_payload = ? WHERE provider_refund_id = ?",
    ).run(amountCents, status, reason, JSON.stringify(rawPayload), providerRefundId);
    return;
  }

  db.prepare(
    "INSERT INTO refunds (order_id, provider, provider_refund_id, amount_cents, status, reason, raw_payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(orderId, provider, providerRefundId, amountCents, status, reason, JSON.stringify(rawPayload));
}

function applyRefundTotals(orderId) {
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
  if (!order) return;

  const refunded = db
    .prepare("SELECT COALESCE(SUM(amount_cents), 0) AS refunded FROM refunds WHERE order_id = ? AND status IN ('succeeded', 'pending')")
    .get(orderId).refunded;
  const paymentStatus = refunded >= order.total_cents ? "refunded" : refunded > 0 ? "partially_refunded" : order.payment_status;

  db.prepare(
    "UPDATE orders SET refunded_cents = ?, payment_status = ?, order_status = CASE WHEN ? >= total_cents THEN 'refunded' ELSE order_status END WHERE id = ?",
  ).run(refunded, paymentStatus, refunded, orderId);
}

async function handleStripeWebhook(req, res) {
  const rawBody = await readRawBody(req, 2_000_000);

  if (!stripeWebhookSecret) {
    sendJson(res, 400, { error: "STRIPE_WEBHOOK_SECRET is not configured." });
    return;
  }

  const signature = req.headers["stripe-signature"];
  if (!verifyStripeSignature(rawBody, signature, stripeWebhookSecret)) {
    sendJson(res, 400, { error: "Invalid Stripe webhook signature." });
    return;
  }

  const event = JSON.parse(rawBody);
  await handleStripeEvent(event);
  sendJson(res, 200, { received: true });
}

async function handleStripeEvent(event) {
  const object = event.data && event.data.object ? event.data.object : {};
  const orderId = stripeOrderId(object);

  if (event.type === "checkout.session.completed") {
    const id = Number(orderId);
    if (id) {
      db.prepare(
        `UPDATE orders
         SET payment_status = ?, order_status = ?, provider_session_id = ?, provider_payment_intent = ?
         WHERE id = ?`,
      ).run(object.payment_status || "paid", object.payment_status === "paid" ? "paid" : "awaiting_payment", object.id, object.payment_intent, id);
      recordPaymentEvent(id, "stripe", event.type, event);
    }
    return;
  }

  if (event.type === "checkout.session.expired") {
    const id = Number(orderId);
    if (id) {
      db.prepare("UPDATE orders SET payment_status = 'expired', order_status = 'cancelled' WHERE id = ?").run(id);
      recordPaymentEvent(id, "stripe", event.type, event);
    }
    return;
  }

  if (event.type === "checkout.session.async_payment_failed" || event.type === "payment_intent.payment_failed") {
    const id = Number(orderId) || orderIdFromPaymentIntent(object.id);
    if (id) {
      db.prepare("UPDATE orders SET payment_status = 'payment_failed', order_status = 'awaiting_payment' WHERE id = ?").run(id);
      recordPaymentEvent(id, "stripe", event.type, event);
    }
    return;
  }

  if (event.type === "payment_intent.succeeded") {
    const id = Number(orderId) || orderIdFromPaymentIntent(object.id);
    if (id) {
      db.prepare(
        "UPDATE orders SET payment_status = 'paid', order_status = 'paid', provider_payment_intent = ? WHERE id = ?",
      ).run(object.id, id);
      recordPaymentEvent(id, "stripe", event.type, event);
    }
    return;
  }

  if (event.type === "charge.succeeded") {
    const id = Number(stripeOrderId(object)) || orderIdFromPaymentIntent(object.payment_intent);
    if (id) {
      db.prepare("UPDATE orders SET provider_charge_id = ? WHERE id = ?").run(object.id, id);
      recordPaymentEvent(id, "stripe", event.type, event);
    }
    return;
  }

  if (event.type === "charge.refunded") {
    const id = Number(stripeOrderId(object)) || orderIdFromCharge(object.id) || orderIdFromPaymentIntent(object.payment_intent);
    if (id) {
      const amountRefunded = Number(object.amount_refunded || 0);
      db.prepare("UPDATE orders SET refunded_cents = ?, payment_status = CASE WHEN ? >= total_cents THEN 'refunded' ELSE 'partially_refunded' END WHERE id = ?").run(
        amountRefunded,
        amountRefunded,
        id,
      );
      recordPaymentEvent(id, "stripe", event.type, event);
    }
    return;
  }

  if (event.type === "refund.created" || event.type === "refund.updated") {
    const id = Number(stripeOrderId(object)) || orderIdFromPaymentIntent(object.payment_intent) || orderIdFromCharge(object.charge);
    if (id) {
      upsertRefund(id, "stripe", object.id, Number(object.amount || 0), object.status || "pending", object.reason || "", object);
      applyRefundTotals(id);
      recordPaymentEvent(id, "stripe", event.type, event);
    }
    return;
  }

  if (event.type.startsWith("charge.dispute.")) {
    const id = orderIdFromCharge(object.charge) || orderIdFromPaymentIntent(object.payment_intent);
    upsertDispute(id || null, object);
    if (id) {
      db.prepare("UPDATE orders SET order_status = 'disputed' WHERE id = ?").run(id);
      recordPaymentEvent(id, "stripe", event.type, event);
    }
  }
}

function stripeOrderId(object) {
  return object?.metadata?.order_id || object?.client_reference_id || "";
}

function orderIdFromPaymentIntent(paymentIntentId) {
  if (!paymentIntentId) return 0;
  const row = db.prepare("SELECT id FROM orders WHERE provider_payment_intent = ?").get(paymentIntentId);
  return row ? row.id : 0;
}

function orderIdFromCharge(chargeId) {
  if (!chargeId) return 0;
  const row = db.prepare("SELECT id FROM orders WHERE provider_charge_id = ?").get(chargeId);
  return row ? row.id : 0;
}

function upsertDispute(orderId, dispute) {
  const evidenceDueAt = dispute.evidence_details?.due_by
    ? new Date(Number(dispute.evidence_details.due_by) * 1000).toISOString()
    : null;

  db.prepare(
    `INSERT INTO disputes
      (order_id, provider, provider_dispute_id, charge_id, amount_cents, status, reason, evidence_due_at, raw_payload)
     VALUES (?, 'stripe', ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider_dispute_id) DO UPDATE SET
      order_id = excluded.order_id,
      charge_id = excluded.charge_id,
      amount_cents = excluded.amount_cents,
      status = excluded.status,
      reason = excluded.reason,
      evidence_due_at = excluded.evidence_due_at,
      raw_payload = excluded.raw_payload,
      updated_at = CURRENT_TIMESTAMP`,
  ).run(
    orderId,
    dispute.id,
    dispute.charge,
    Number(dispute.amount || 0),
    dispute.status || "unknown",
    dispute.reason || "",
    evidenceDueAt,
    JSON.stringify(dispute),
  );
}

function recordPaymentEvent(orderId, provider, eventType, payload) {
  db.prepare("INSERT INTO payment_events (order_id, provider, event_type, payload) VALUES (?, ?, ?, ?)").run(
    orderId,
    provider,
    eventType,
    JSON.stringify(payload),
  );
}

function stripeRequest(method, endpoint, params = {}, idempotencyKey = "") {
  return new Promise((resolve, reject) => {
    const body = method === "GET" ? "" : encodeStripeForm(params);
    const pathWithQuery = method === "GET" && Object.keys(params).length ? `${endpoint}?${encodeStripeForm(params)}` : endpoint;
    const request = https.request(
      {
        hostname: "api.stripe.com",
        path: pathWithQuery,
        method,
        headers: {
          Authorization: `Bearer ${stripeSecretKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          const json = raw ? JSON.parse(raw) : {};
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(json.error?.message || `Stripe returned ${response.statusCode}`));
            return;
          }
          resolve(json);
        });
      },
    );
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

function encodeStripeForm(value) {
  const params = new URLSearchParams();
  appendStripeParam(params, "", value);
  return params.toString();
}

function appendStripeParam(params, prefix, value) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => appendStripeParam(params, `${prefix}[${index}]`, item));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      appendStripeParam(params, prefix ? `${prefix}[${key}]` : key, child);
    }
    return;
  }
  if (value !== undefined && value !== null) {
    params.append(prefix, String(value));
  }
}

function verifyStripeSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;
  const parts = Object.fromEntries(
    String(signatureHeader)
      .split(",")
      .map((item) => item.split("="))
      .filter(([key, value]) => key && value),
  );
  if (!parts.t || !parts.v1) return false;
  const signedPayload = `${parts.t}.${rawBody}`;
  const expected = crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");
  return safeEqualHex(expected, parts.v1);
}

function safeEqualHex(a, b) {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function getCurrentUser(req) {
  const token = readCookie(req, "lx_session");
  if (!token) return null;
  const session = db
    .prepare(
      `SELECT users.*
       FROM sessions JOIN users ON sessions.user_id = users.id
       WHERE sessions.token = ? AND sessions.expires_at > CURRENT_TIMESTAMP`,
    )
    .get(token);
  return session || null;
}

function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + sessionDays * 24 * 60 * 60 * 1000).toISOString();
  db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)").run(token, userId, expires);
  setCookie(res, "lx_session", token, `Max-Age=${sessionDays * 86400}; Path=/; HttpOnly; SameSite=Lax`);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(":");
  if (!salt || !hash) return false;
  const test = crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(test, "hex"));
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    sellerStatus: user.seller_status,
    sellerTier: user.seller_tier || "New Seller",
    emailVerified: Boolean(user.email_verified),
    connect: sellerConnectStatus(user),
    createdAt: user.created_at,
  };
}

async function readJson(req, limit = 1_000_000) {
  const raw = await readRawBody(req, limit);
  return raw ? JSON.parse(raw) : {};
}

async function readRawBody(req, limit = 1_000_000) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("Request is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function requireUser(res, user) {
  if (!user) {
    sendJson(res, 401, { error: "Sign in first." });
  }
}

function requireAdmin(res, user) {
  if (!user || user.role !== "admin") {
    sendJson(res, 403, { error: "Admin access required." });
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function setCookie(res, name, value, attrs) {
  const encoded = `${name}=${encodeURIComponent(value)}; ${attrs}`;
  const existing = res.getHeader("Set-Cookie");
  res.setHeader("Set-Cookie", existing ? [].concat(existing, encoded) : encoded);
}

function readCookie(req, name) {
  const cookie = req.headers.cookie || "";
  for (const part of cookie.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return "";
}

function cleanText(value, max) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, max);
}

function cleanEmail(value) {
  return cleanText(value, 200).toLowerCase();
}

function centsToDollars(cents) {
  return Number((Number(cents || 0) / 100).toFixed(2));
}

function hashCode(value) {
  let hash = 0;
  for (const char of String(value)) {
    hash = (hash << 5) - hash + char.charCodeAt(0);
    hash |= 0;
  }
  return hash;
}

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char],
  );
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function resolveAppPath(value, fallback) {
  if (!value) return fallback;
  return path.isAbsolute(value) ? value : path.join(rootDir, value);
}
