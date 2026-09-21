# StuBot — Render deployment

This build keeps EduBot as the source of truth for the interface, payment flow,
rewards, referrals, admin panel, SQLite cache and course behavior.

The delivered bot is named StuBot. Only the requested StuBot infrastructure is
carried over without replacing EduBot's existing behavior:

- StuBot's Monetag zone, defaulting to `11115372`
- Force Join channel gate and channel membership verification
- Force Join `chat_member` leave detection for referred/giveaway invite tracking
- Per-batch Refer & Unlock as a second access option beside Buy
- Deletion of active bot-delivered lecture videos when a user leaves Force Join
- EduBot's MongoDB backup plus Render-compatible health/URL handling

## Required Render variables

- `BOT_TOKEN`
- `MONGO_URI`
- `OWNER_ID`
- `STORAGE_CHANNEL_ID`
- `FORCE_JOIN_CHANNELS` (optional; comma-separated channel/group IDs)
- `FORCE_JOIN_CHANNEL_NAMES` (optional)
- `FORCE_JOIN_CHANNEL_LINKS` (optional)
- `REFERRAL_FORCE_JOIN_CHANNELS` (optional; leave blank to reuse `FORCE_JOIN_CHANNELS`)

Render automatically provides `PORT` and `RENDER_EXTERNAL_URL`. Set `WEB_URL`
only when using a custom domain or a non-Render host.

The Monetag zone can be left at the StuBot default or intentionally overridden
with `MONETAG_ZONE_ID`.

The served WebApp uses Monetag only for ads: rewarded interstitial/popup ads,
the ambient in-app full-screen interstitial (also initialized before the
Force Join gate), and the existing ad-blocker check. Telegram WebApp,
Razorpay, and Tabler Icons are platform/payment/UI dependencies, not ad
networks. A legacy unused file under `models/` contains older archived ad
markup; Express serves `public/`, so it is not loaded by this bot.

Start command:

```bash
node server.js
```

Health check:

```text
/health
```