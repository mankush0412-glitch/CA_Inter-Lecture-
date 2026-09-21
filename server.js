// Load .env directly — makes the app self-sufficient regardless of whether the
// launch script (start.sh) exports variables into the shell before running
// `node server.js`. Wrapped in try/catch so a missing `dotenv` package doesn't
// crash the app either — it just falls back to whatever the shell already exported.
try {
  require("dotenv").config();
} catch (e) {
  console.warn("dotenv not installed — relying on shell-exported environment variables. Run `npm install dotenv` to load .env automatically.");
}

const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");
const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const db = require("./sqlite-manager");

// node-telegram-bot-api's internal long-polling (getUpdates) uses the
// deprecated request-promise/@cypress/request HTTP client under the hood.
// On any brief network hiccup between us and Telegram's servers (packet
// loss, a dropped TCP connection — "socket hang up", etc.), that internal
// polling loop can throw a rejection that isn't caught anywhere in OUR code,
// because it originates entirely inside the library's own networking layer.
// Node terminates the whole process on an unhandled rejection by default —
// meaning a single transient network blip could take the whole bot down.
// This just logs it and lets the bot keep running; node-telegram-bot-api's
// polling loop recovers and retries on its own once the network is back.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection (likely a transient Telegram API network blip, bot continues running):", reason?.message || reason);
});

// QR-with-logo generation. Wrapped in try/catch so the app still boots (with plain QR
// generation disabled) if these haven't been installed yet — run:
//   npm install qrcode jimp --save
let QRCode = null, JimpLib = null;
try {
  QRCode = require("qrcode");
  JimpLib = require("jimp").Jimp;
} catch (e) {
  console.warn("qrcode/jimp not installed — payment QR endpoint will be unavailable. Run `npm install qrcode jimp --save`.");
}

const TOKEN = process.env.BOT_TOKEN;
const MONGO_URI = process.env.MONGO_URI;
// Render automatically exposes the public service URL as RENDER_EXTERNAL_URL.
// Keep WEB_URL as an explicit override for custom domains and local hosting.
const WEB_URL = process.env.WEB_URL || process.env.RENDER_EXTERNAL_URL;
const PORT = process.env.PORT || 3000;
const OWNER_ID = parseInt(process.env.OWNER_ID || "0");
const STORAGE_CHANNEL_ID = process.env.STORAGE_CHANNEL_ID ? parseInt(process.env.STORAGE_CHANNEL_ID) : null;
const UPI_ID = process.env.UPI_ID || "";
const UPI_NAME = process.env.UPI_NAME || ""; // payee name shown in the UPI app (pn= param) — set this in env, else falls back to a generic name
const PAYMENT_GROUP_ID = process.env.PAYMENT_GROUP_ID ? parseInt(process.env.PAYMENT_GROUP_ID) : null;
// Real-time activity log group — every lecture/video call (who requested what,
// when) is posted here as it happens. Separate from PAYMENT_GROUP_ID/OWNER_ID
// so logs don't clutter the owner's DM or the payments group. Optional — if
// unset, logging is silently skipped.
const LOGS_GROUP_ID = process.env.LOGS_GROUP_ID ? parseInt(process.env.LOGS_GROUP_ID) : null;
// Monetag ad zone — kept as an env var (not hardcoded in index.html) so it can
// be swapped without touching frontend code. Defaults to the zone already live
// in production. The Monetag SDK creates a global function named `show_<zone>`,
// so the frontend reads this from /api/config and builds that function name
// dynamically rather than hardcoding it — see _monetagShow() in index.html.
// StuBot's production Monetag zone is the only StuBot behavior imported into
// EduBot. The env var remains supported for an intentional future override.
const MONETAG_ZONE_ID = process.env.MONETAG_ZONE_ID || "11115372";
const CONTACT_LINK = process.env.CONTACT_LINK || "";

// Ilambit DevPort — used to auto-verify UPI payments by UTR against the BharatPe
// merchant account before falling back to manual admin approval. Get a key from
// https://devport.ilambit.in/signup and configure BharatPe creds under Services.
const DEVPORT_API_KEY = process.env.DEVPORT_API_KEY || "";
// Allowed absolute paisa-level mismatch between what BharatPe reports and what we
// expect (batch price / coupon final amount) before we refuse to auto-approve.
const PAYMENT_AMOUNT_TOLERANCE = 0;

// ── Payment provider switch ─────────────────────────────────────────────────────
// "bharatpe" (default) = existing static-QR + manual UTR entry, verified via DevPort.
// "paytm" = official Paytm checkout (Initiate Transaction + hosted page), but the
// FINAL status confirmation goes through Ilambit DevPort's Paytm endpoint (same
// DEVPORT_API_KEY as BharatPe) instead of calling Paytm's Order Status API directly
// — so also configure your Paytm Merchant ID under Services → Paytm on the DevPort
// dashboard. PAYTM_MERCHANT_KEY below is still needed for two things Paytm itself
// requires directly: creating the checkout order (Initiate Transaction) and
// verifying the authenticity of Paytm's callback POST to our server.
// "razorpay" = official Razorpay Standard Checkout (popup, no page redirect needed).
// Fully self-contained — no DevPort dependency. Get Key ID/Secret from Razorpay
// Dashboard → Settings → API Keys, and (optionally, but recommended) a Webhook
// Secret from Settings → Webhooks for the redundant server-to-server confirmation.
const PAYMENT_PROVIDER = (process.env.PAYMENT_PROVIDER || "bharatpe").trim().toLowerCase();
const PAYTM_MID = process.env.PAYTM_MID || "";
const PAYTM_MERCHANT_KEY = process.env.PAYTM_MERCHANT_KEY || "";
const PAYTM_WEBSITE = process.env.PAYTM_WEBSITE || "DEFAULT"; // "WEBSTAGING" for staging, or your registered production website name
const PAYTM_INDUSTRY_TYPE = process.env.PAYTM_INDUSTRY_TYPE || "Retail";
const PAYTM_CHANNEL_ID = process.env.PAYTM_CHANNEL_ID || "WEB";
const PAYTM_ENV = (process.env.PAYTM_ENV || "production").trim().toLowerCase(); // "production" or "staging"
const PAYTM_HOST = PAYTM_ENV === "staging" ? "securegw-stage.paytm.in" : "securegw.paytm.in";
// Public HTTPS URL Paytm redirects/POSTs back to after checkout — must be reachable
// from the internet (your WEB_URL's domain). Falls back to WEB_URL's origin + this path.
const PAYTM_CALLBACK_URL = process.env.PAYTM_CALLBACK_URL || (() => { try { return WEB_URL ? new URL("/api/paytm/callback", WEB_URL).toString() : ""; } catch (_) { return ""; } })();

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || "";
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || "";
// Optional but recommended — enables /api/razorpay/webhook as a second, server-to-
// server confirmation path that grants access even if the user closes the app right
// after paying (before the Checkout.js success handler's /verify call can fire).
const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || "";

let PaytmChecksum = null;
if (PAYMENT_PROVIDER === "paytm") {
  try { PaytmChecksum = require("paytmchecksum"); }
  catch (e) { console.warn("paytmchecksum not installed — Paytm payments will be unavailable. Run `npm install paytmchecksum --save`."); }
}

let Razorpay = null, razorpayClient = null;
if (PAYMENT_PROVIDER === "razorpay") {
  try {
    Razorpay = require("razorpay");
    if (RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET) razorpayClient = new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET });
    else console.warn("RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET not set — Razorpay payments will be unavailable.");
  } catch (e) { console.warn("razorpay not installed — Razorpay payments will be unavailable. Run `npm install razorpay --save`."); }
}

let BOT_USERNAME = "";
let bot = null;

if (!TOKEN || !MONGO_URI || !WEB_URL || !OWNER_ID) { console.error("Missing env: BOT_TOKEN, MONGO_URI, WEB_URL, OWNER_ID are required."); process.exit(1); }
if (!STORAGE_CHANNEL_ID) console.warn("Warning: STORAGE_CHANNEL_ID not set.");
if (!LOGS_GROUP_ID) console.warn("Warning: LOGS_GROUP_ID not set — real-time lecture-call logs will be skipped.");

function isOwner(userId) { return userId === OWNER_ID; }
function isGroupChat(msg) { return msg.chat && (msg.chat.type === "group" || msg.chat.type === "supergroup"); }
function formatIST(d) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('day')}/${get('month')}/${get('year')}, ${get('hour')}:${get('minute')}:${get('second')} ${get('dayPeriod').toLowerCase()}`;
}

// ── Suspicious activity detection ───────────────────────────────────────────
// If a (non-owner) user's lecture pulls match any configured rule (e.g. "3+
// within 5 minutes"), it's a pattern more consistent with bulk-scraping/leaking
// than normal viewing, so the owner gets a one-time alert per rule-crossing
// with a one-tap Ban button. Rules are stored in bot_settings (JSON), so the
// owner can tune or add more of them live via /suspiciousrules commands —
// no redeploy needed. Falls back to a single default rule if none configured.
const DEFAULT_SUSPICIOUS_RULES = [{ count: 3, windowMinutes: 5 }];
function getSuspiciousRules() {
  const rules = db.settings.get('suspicious_rules', DEFAULT_SUSPICIOUS_RULES);
  return Array.isArray(rules) && rules.length ? rules : DEFAULT_SUSPICIOUS_RULES;
}

async function checkSuspiciousActivity(bot, fromUser, code) {
  try {
    const userId = fromUser?.id;
    if (!userId || isOwner(userId)) return;
    const uidStr = String(userId);
    db.lectureRequest.insert({ id: db.generateId(), userId: uidStr, code, requestedAt: Date.now() });
    const rules = getSuspiciousRules();
    // Housekeeping — retain at least as long as the widest configured window
    // (plus an hour of buffer), so a long custom rule never loses its own data.
    const maxWindowMs = Math.max(24 * 60 * 60 * 1000, ...rules.map(r => (Number(r.windowMinutes) || 5) * 60 * 1000 + 60 * 60 * 1000));
    db.lectureRequest.pruneOlderThan(maxWindowMs);

    for (const rule of rules) {
      const windowMs = Math.max(1, Number(rule.windowMinutes) || 5) * 60 * 1000;
      const threshold = Math.max(1, Number(rule.count) || 3);
      const recentCount = db.lectureRequest.countRecent(uidStr, windowMs);
      // Fire exactly once per burst — right when the count first crosses this
      // rule's threshold — so continued requests don't spam the owner repeatedly.
      if (recentCount === threshold && OWNER_ID && bot) {
        const name = fromUser.username ? `@${fromUser.username}` : (fromUser.first_name || `User ${uidStr}`);
        const ctx = getLectureContext(code);
        const text = `⚠️ <b>Suspicious Activity Detected</b>\n\n` +
          `User: ${esc(name)} (<code>${uidStr}</code>)\n` +
          `Requested <b>${recentCount} lectures</b> within the last ${rule.windowMinutes} minute(s).\n` +
          `Latest code: <code>${esc(code)}</code>` +
          (ctx ? ` (${esc(ctx.batchName)}${ctx.subjectName ? ` › ${esc(ctx.subjectName)}` : ""})` : "") + `\n\n` +
          `This may indicate bulk-downloading/leaking. Ban if needed:`;
        bot.sendMessage(OWNER_ID, text, {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[{ text: "🚫 Ban User", callback_data: `ban_${uidStr}` }]] }
        }).catch(() => {});
      }
    }
  } catch (err) { console.error("Suspicious activity check error:", err.message); }
}

// ── Lecture context lookup (batch / subject / chapter / unit / lecture name) ─
// The bot only knows a bare `code` at delivery time — the actual course
// structure (which batch/subject/chapter this code belongs to) lives in the
// `batches` JSON documents (see course.js). We build a code → context index
// once and cache it briefly, rather than walking every batch on every single
// lecture delivery, since batches are read-heavy and change infrequently.
let _lectureIndexCache = { builtAt: 0, map: null };
const LECTURE_INDEX_TTL_MS = 2 * 60 * 1000;

// l.link can be stored either as a bare code ("RbZUHU") or as a full legacy
// t.me deep link ("https://t.me/OldBotName?start=RbZUHU") — same dual format
// the frontend's openLecLink() already handles. Extract just the code so it
// matches record.code (what actually gets logged/delivered) either way.
function extractLectureCode(link) {
  if (!link) return "";
  if (link.startsWith("http")) {
    const m = link.match(/[?&]start=([^&]+)/);
    return m ? m[1] : link;
  }
  return link;
}

function _indexLectures(lectures, ctx, map) {
  for (const l of lectures || []) {
    const code = extractLectureCode(l && l.link);
    if (code) map.set(code, { ...ctx, lectureName: l.name || "" });
  }
}

function buildLectureIndex() {
  const map = new Map();
  try {
    for (const b of db.batch.getAll()) {
      const batchName = b.name || "Unknown Batch";
      for (const s of b.subjects || []) {
        const subjectName = s.name || "";
        for (const c of s.chapters || []) {
          const chapterName = c.name || "";
          _indexLectures(c.lectures, { batchName, subjectName, chapterName, unitName: "" }, map);
          for (const u of c.units || []) {
            _indexLectures(u.lectures, { batchName, subjectName, chapterName, unitName: u.name || "" }, map);
          }
        }
      }
    }
  } catch (err) { console.error("buildLectureIndex error:", err.message); }
  return map;
}

function getLectureContext(code) {
  if (!code) return null;
  const now = Date.now();
  if (!_lectureIndexCache.map || now - _lectureIndexCache.builtAt > LECTURE_INDEX_TTL_MS) {
    _lectureIndexCache = { builtAt: now, map: buildLectureIndex() };
  }
  return _lectureIndexCache.map.get(code) || null;
}

// ── Real-time lecture activity log ──────────────────────────────────────────
// Posts one message per lecture/file call to LOGS_GROUP_ID as it happens — who
// requested it, what it was (including which batch/subject/chapter it belongs
// to), and their running today-count. Fire-and-forget: a logging failure must
// never block the actual file delivery to the user.
function logLectureActivity(bot, fromUser, record, extra) {
  if (!LOGS_GROUP_ID || !bot) return;
  try {
    const userId = fromUser?.id;
    const uidStr = userId != null ? String(userId) : "unknown";
    const name = fromUser?.username ? `@${fromUser.username}` : (fromUser?.first_name || `User ${uidStr}`);
    const typeEmoji = fileTypeEmoji(record.file_type);
    const ctx = getLectureContext(record.code);
    const lines = [
      `${typeEmoji} <b>Lecture Called</b>`,
      `👤 ${esc(name)} (<code>${uidStr}</code>)`,
      `📁 ${esc(record.file_name || "file")}`,
    ];
    if (ctx) {
      lines.push(`🎓 Batch: ${esc(ctx.batchName)}`);
      if (ctx.subjectName) lines.push(`📘 Subject: ${esc(ctx.subjectName)}`);
      if (ctx.chapterName) lines.push(`📖 Chapter: ${esc(ctx.chapterName)}${ctx.unitName ? ` › ${esc(ctx.unitName)}` : ""}`);
      if (ctx.lectureName) lines.push(`🏷️ Lecture: ${esc(ctx.lectureName)}`);
    }
    lines.push(`🔑 Code: <code>${esc(record.code || "")}</code>`);
    if (extra && extra.todayUsed != null) lines.push(`📊 Today: ${extra.todayUsed}/${DAILY_VIDEO_LIMIT}`);
    lines.push(`🕐 ${formatIST(new Date())}`);
    bot.sendMessage(LOGS_GROUP_ID, lines.join("\n"), { parse_mode: "HTML" }).catch(() => {});
  } catch (err) { console.error("Lecture log error:", err.message); }
}

// ── MongoDB Schemas (for backup writes only) ──────────────────────────────────
const fileSchema = new mongoose.Schema({ code: { type: String, required: true, unique: true }, file_id: { type: String, required: true }, file_type: { type: String, required: true }, file_name: { type: String, default: "file" }, uploaded_by: Number, expires_at: { type: Date, default: null }, delivered_to: [Number], delivered_at: { type: String, default: '{}' }, created_at: { type: Date, default: Date.now }, channel_msg_id: { type: Number, default: null } });
const FileRecord = mongoose.model("FileRecord", fileSchema);

const bulkBatchSchema = new mongoose.Schema({ batch_code: { type: String, required: true, unique: true }, user_id: Number, files: [{ file_id: String, file_type: String, file_name: { type: String, default: "file" } }], created_at: { type: Date, default: Date.now } });
const BulkBatch = mongoose.model("BulkBatch", bulkBatchSchema);

const pendingDeleteSchema = new mongoose.Schema({ chat_id: Number, message_id: Number, delete_at: Date });
const PendingDelete = mongoose.model("PendingDelete", pendingDeleteSchema);

// Persisted job to remove a chatId from a file's delivered_to list once the 6h
// re-request cooldown expires — mirrors PendingDelete so it survives restarts
// instead of relying solely on an in-memory setTimeout (which was the bug:
// on restart the timer was lost and the chatId stayed in delivered_to forever).
const pendingUndeliverSchema = new mongoose.Schema({ file_record_id: String, code: String, chat_id: Number, undeliver_at: Date });
const PendingUndeliver = mongoose.model("PendingUndeliver", pendingUndeliverSchema);

const userSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  firstName: { type: String, default: "" },
  lastName: { type: String, default: "" },
  username: { type: String, default: "" },
  firstSeen: { type: Date, default: Date.now },
  lastSeen: { type: Date, default: Date.now },
  // Read-only points snapshot — written ONLY by the /sync command (db.syncToMongo).
  // The app itself never reads points from here; it always recomputes live from
  // SQLite via getPointsBreakdown(). This just makes the balance visible when
  // browsing the Mongo collection directly, e.g. in Compass or Atlas.
  points: { type: Number, default: 0 },
  pointsBreakdown: {
    referrals: { type: Number, default: 0 },
    spinEarned: { type: Number, default: 0 },
    adjustment: { type: Number, default: 0 },
    spent: { type: Number, default: 0 },
  },
  pointsSyncedAt: { type: Date, default: null },
});
const User = mongoose.model("User", userSchema);

const dailyLimitSchema = new mongoose.Schema({ userId: { type: Number, required: true, unique: true }, count: { type: Number, default: 0 }, resetDate: { type: String, required: true } });
const DailyVideoLimit = mongoose.model("DailyVideoLimit", dailyLimitSchema);
const DAILY_VIDEO_LIMIT = 10;

// ── Ads-Free Plan ─────────────────────────────────────────────────────────────
// Manually-renewed (not auto-recurring debit) subscription that turns off every
// ad in the app for that user — the ambient in-app interstitial, the "every 3rd
// lecture click shows an ad" step, and the ad-blocker wall. Completely separate
// from batch/premium access: an Ads-Free subscriber still has to buy or unlock
// a premium batch the normal way — this plan only removes annoyance-ads, it
// never substitutes for the deliberate "watch an ad to earn temporary batch
// access" reward flow, which stays unchanged for everyone (ads-free users
// included, if they choose to use it).
// Two durations are sold, each through the SAME payment flow (BharatPe/Paytm/
// Razorpay, whichever PAYMENT_PROVIDER is active) as batches, by passing one of
// these two sentinels as the "batchId" — see getProductInfo()/grantBatchAccess()
// below for how that's threaded through with zero changes to the 5 existing
// grant call sites.
// "days" are fixed (1 week / 1 month); "price" is admin-editable at runtime via
// the /setadsfreeprice bot command — see getAdsFreePlans() below, which is what
// everything actually calls (this raw map only pairs each plan's fixed
// metadata with the settings key that holds its live, possibly-overridden
// price, so a price change takes effect instantly with no redeploy/restart).
const ADS_FREE_PLAN_META = {
  ADSFREEWEEKLY: { label: "Ads-Free Plan (1 week)",  days: 7,  settingsKey: "adsFreePrice_weekly",  envDefault: () => Number(process.env.ADS_FREE_WEEKLY_PRICE  || 20) },
  ADSFREEPLAN:   { label: "Ads-Free Plan (1 month)", days: 30, settingsKey: "adsFreePrice_monthly", envDefault: () => Number(process.env.ADS_FREE_MONTHLY_PRICE || 60) },
};
// Reads the live plans map. Never cache this — call it fresh each time, it's
// a single cheap SQLite read per plan.
function getAdsFreePlans() {
  const out = {};
  for (const [id, meta] of Object.entries(ADS_FREE_PLAN_META)) {
    out[id] = { label: meta.label, days: meta.days, price: Number(db.settings.get(meta.settingsKey, meta.envDefault())) };
  }
  return out;
}
const adsFreeSchema = new mongoose.Schema({ userId: { type: String, required: true, unique: true }, expiresAt: { type: Date, required: true } });
const AdsFreeSubscription = mongoose.model("AdsFreeSubscription", adsFreeSchema);

// Extends (or starts) a user's Ads-Free subscription by `days`, stacking on top
// of any still-active remaining time rather than resetting it — so renewing a
// few days early never wastes what's left. Returns the new expiry Date.
async function grantAdsFreeAccess(userId, days) {
  const uid = String(userId);
  const existing = db.adsFree.find(uid);
  const now = Date.now();
  const base = (existing && existing.expiresAt > now) ? existing.expiresAt : now;
  const expiresAt = new Date(base + days * 24 * 60 * 60 * 1000);
  db.adsFree.upsert({ userId: uid, expiresAt });
  AdsFreeSubscription.findOneAndUpdate({ userId: uid }, { userId: uid, expiresAt }, { upsert: true }).catch(() => {});
  return expiresAt;
}

function getAdsFreeStatus(userId) {
  const rec = db.adsFree.find(String(userId));
  const active = !!(rec && rec.expiresAt > Date.now());
  return { active, expiresAt: rec ? new Date(rec.expiresAt) : null };
}

// Resolves a "product" (a real batch, or an Ads-Free plan sentinel) to a
// display name + price, used wherever a payment flow needs to show/charge an
// amount without caring which of the two it actually is.
function getProductInfo(batchId) {
  const plans = getAdsFreePlans();
  if (plans[batchId]) return { name: plans[batchId].label, price: plans[batchId].price };
  const b = db.batch.getOne(batchId);
  return { name: b ? b.name : batchId, price: b && b.price != null ? Number(b.price) : null };
}

// ── Giveaway ──────────────────────────────────────────────────────────────────
// Self-contained: doesn't touch the referral/points system at all, so it can't
// break existing referral counts. Invite tracking uses its own deep-link prefix
// (?start=give_<userId>) separate from the existing ref_ prefix.
const giveawaySchema = new mongoose.Schema({
  status: { type: String, enum: ["active","ended"], default: "active" },
  startedAt: { type: Date, default: Date.now },
  endedAt: { type: Date, default: null },
  startedBy: Number,
});
const Giveaway = mongoose.model("Giveaway", giveawaySchema);

const giveawayParticipantSchema = new mongoose.Schema({
  giveawayId: { type: mongoose.Schema.Types.ObjectId, required: true },
  userId: { type: Number, required: true },
  firstName: { type: String, default: "" },
  username: { type: String, default: "" },
  invites: { type: Number, default: 0 },
  invitedIds: { type: [Number], default: [] }, // prevents the same invitee being counted twice
  joinedAt: { type: Date, default: Date.now },
});
giveawayParticipantSchema.index({ giveawayId: 1, userId: 1 }, { unique: true });
const GiveawayParticipant = mongoose.model("GiveawayParticipant", giveawayParticipantSchema);

const GIVEAWAY_REWARDS = { 1: "🏆 1 Month Premium OR ₹319 (any 1 plan) + 1 USA Account", 2: "🥈 ₹100 + 1 USA Account", 3: "🥉 ₹50" };
function giveawayRewardFor(rank) { if (GIVEAWAY_REWARDS[rank]) return GIVEAWAY_REWARDS[rank]; if (rank>=4 && rank<=10) return "🎁 ₹10"; return null; }
async function getActiveGiveaway() { return Giveaway.findOne({ status:"active" }).sort({ startedAt:-1 }); }
async function getLatestGiveaway() { return Giveaway.findOne().sort({ startedAt:-1 }); }
async function giveawayRankOf(giveawayId, userId) {
  const me = await GiveawayParticipant.findOne({ giveawayId, userId });
  if (!me) return { participant:null, rank:null };
  const higher = await GiveawayParticipant.countDocuments({ giveawayId, $or:[ { invites:{ $gt:me.invites } }, { invites:me.invites, joinedAt:{ $lt:me.joinedAt } } ] });
  return { participant:me, rank: higher+1 };
}
function giveawayDisplayName(p) { return p.username ? `@${p.username}` : (p.firstName || `User ${p.userId}`); }

// ── Paytm order tracking ─────────────────────────────────────────────────────────
// One row per checkout attempt, created at /api/paytm/initiate and resolved by the
// callback (checksum-verified) + an authoritative Order Status API call.
const paytmOrderSchema = new mongoose.Schema({
  orderId: { type: String, required: true, unique: true },
  batchId: String,
  userId: String,
  firstName: String,
  lastName: String,
  username: String,
  amount: Number,
  couponCode: String,
  discountPct: Number,
  status: { type: String, enum: ["pending","success","failed"], default: "pending" },
  txnId: String, // Paytm's own transaction id, filled in on success
  createdAt: { type: Date, default: Date.now },
});
const PaytmOrder = mongoose.model("PaytmOrder", paytmOrderSchema);

// ── Razorpay order tracking ───────────────────────────────────────────────────
// One row per checkout attempt, created at /api/razorpay/create-order and resolved
// by /api/razorpay/verify (Checkout.js success handler, signature-verified) and/or
// the /api/razorpay/webhook (payment.captured, signature-verified) — whichever
// arrives first grants access; both are idempotent on order status.
const razorpayOrderSchema = new mongoose.Schema({
  orderId: { type: String, required: true, unique: true }, // Razorpay's order_... id
  batchId: String,
  userId: String,
  firstName: String,
  lastName: String,
  username: String,
  amount: Number,
  couponCode: String,
  discountPct: Number,
  status: { type: String, enum: ["pending","success","failed"], default: "pending" },
  paymentId: String, // Razorpay's own pay_... id, filled in on success
  createdAt: { type: Date, default: Date.now },
});
const RazorpayOrder = mongoose.model("RazorpayOrder", razorpayOrderSchema);


function giveawayRulesText() {
  return [
    `🎁 <b>GIVEAWAY — TERMS &amp; CONDITIONS</b>`,
    ``,
    `<b>How It Works</b>`,
    `1. Share your unique invite link with friends.`,
    `2. An invite is counted only after the invited user joins <b>and</b> watches their first lecture — opening the bot alone does not count.`,
    `3. If an invited user later leaves the required channel/group, that invite is reversed and your count is reduced accordingly.`,
    `4. Rankings are based on total confirmed invites — check anytime via /scoreboard.`,
    `5. View your personal standing anytime with /myscore.`,
    ``,
    `<b>Prize Structure</b>`,
    `🥇 Rank 1 — 1 Month Premium OR ₹319 (any 1 plan) + 1 USA Account`,
    `🥈 Rank 2 — ₹100 + 1 USA Account`,
    `🥉 Rank 3 — ₹50`,
    `🎖️ Rank 4–10 — ₹10 each`,
    ``,
    `Results will be announced once the giveaway concludes, and all winners will be notified individually.`,
  ].join("\n");
}

// ── MongoDB connect ───────────────────────────────────────────────────────────
mongoose.connect(MONGO_URI).then(async () => {
  console.log("MongoDB connected");
  try { await mongoose.connection.collection("filerecords").dropIndex("expires_at_1"); } catch (e) {}
  try { await mongoose.connection.collection("filerecords").updateMany({ expires_at: { $ne: null } }, { $set: { expires_at: null } }); } catch (e) {}
  // Sync all MongoDB → SQLite on startup
  await db.syncFromMongo(mongoose);
  try {
    const loadedReferralUnlocks = await preloadBatchPremiumCache();
    console.log(`Loaded ${loadedReferralUnlocks} active referral unlock(s)`);
  } catch (e) {
    console.error("Referral unlock cache preload error:", e.message);
  }
}).catch((err) => { console.error("MongoDB error:", err.message); process.exit(1); });

// ── Helpers ───────────────────────────────────────────────────────────────────
function getTodayIST() { const now = new Date(); return new Date(now.getTime() + 5.5*60*60*1000).toISOString().slice(0,10); }

// Atomically checks AND reserves one of today's video slots in a single
// synchronous operation (better-sqlite3 calls here are synchronous, so there's
// no await between the read and the write — nothing else can interleave).
// MUST be called before sendFile(), not after — the old check-then-send-then-
// increment sequence had an await gap during sendFile() where many parallel
// /start requests could all pass the check before any of them committed their
// increment, letting a user blow way past the daily limit by firing several
// lecture requests at once. If delivery actually fails, call
// releaseVideoSlot() to give the reserved slot back.
function tryReserveVideoSlot(userId) {
  const today = getTodayIST();
  let rec = db.dailyVideoLimit.find(userId);
  if (!rec || rec.resetDate !== today) rec = { count: 0 };
  if (rec.count >= DAILY_VIDEO_LIMIT) return { allowed: false, used: rec.count, remaining: 0 };
  const newCount = rec.count + 1;
  db.dailyVideoLimit.upsert({ userId, count: newCount, resetDate: today });
  DailyVideoLimit.findOneAndUpdate({ userId }, { userId, count: newCount, resetDate: today }, { upsert: true }).catch(() => {});
  return { allowed: true, used: newCount, remaining: DAILY_VIDEO_LIMIT - newCount };
}

function releaseVideoSlot(userId) {
  const today = getTodayIST();
  const rec = db.dailyVideoLimit.find(userId);
  if (!rec || rec.resetDate !== today) return; // day rolled over since reservation — nothing to release
  const newCount = Math.max(0, rec.count - 1);
  db.dailyVideoLimit.upsert({ userId, count: newCount, resetDate: today });
  DailyVideoLimit.findOneAndUpdate({ userId }, { userId, count: newCount, resetDate: today }, { upsert: true }).catch(() => {});
}

function generateCode() { const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789"; let c=""; for(let i=0;i<6;i++) c+=chars[Math.floor(Math.random()*chars.length)]; return c; }
function getUniqueCode() { let c; do { c = generateCode(); } while (db.fileRecord.findByCode(c)); return c; }
function getUniqueBatchCode() { let c; do { c = "B"+generateCode(); } while (db.bulkBatch.findByCode(c)); return c; }

function extractFileInfo(msg) {
  const caption = msg.caption || null;
  if (msg.document)   return { file_id: msg.document.file_id, file_type: "document", file_name: msg.document.file_name||"document", mime_type: msg.document.mime_type||"", caption };
  if (msg.photo)      return { file_id: msg.photo[msg.photo.length-1].file_id, file_type: "photo", file_name: "photo.jpg", caption };
  if (msg.video)      return { file_id: msg.video.file_id, file_type: "video", file_name: msg.video.file_name||"video.mp4", caption };
  if (msg.audio)      return { file_id: msg.audio.file_id, file_type: "audio", file_name: msg.audio.file_name||"audio.mp3", caption };
  if (msg.voice)      return { file_id: msg.voice.file_id, file_type: "voice", file_name: "voice.ogg", caption };
  if (msg.video_note) return { file_id: msg.video_note.file_id, file_type: "video_note", file_name: "video_note.mp4", caption: null };
  return null;
}

async function saveToStorageChannel(bot, fileInfo) {
  if (!STORAGE_CHANNEL_ID) return fileInfo;
  try {
    let sentMsg;
    const caption = fileInfo.caption || `📎 ${fileInfo.file_name}`;
    switch(fileInfo.file_type) {
      case "photo":      sentMsg = await bot.sendPhoto(STORAGE_CHANNEL_ID, fileInfo.file_id, { caption }); break;
      case "video":      sentMsg = await bot.sendVideo(STORAGE_CHANNEL_ID, fileInfo.file_id, { caption }); break;
      case "audio":      sentMsg = await bot.sendAudio(STORAGE_CHANNEL_ID, fileInfo.file_id, { caption }); break;
      case "voice":      sentMsg = await bot.sendVoice(STORAGE_CHANNEL_ID, fileInfo.file_id, { caption }); break;
      case "video_note": sentMsg = await bot.sendVideoNote(STORAGE_CHANNEL_ID, fileInfo.file_id); break;
      default:           sentMsg = await bot.sendDocument(STORAGE_CHANNEL_ID, fileInfo.file_id, { caption }); break;
    }
    const channelFileInfo = extractFileInfo(sentMsg);
    if (channelFileInfo) return { ...channelFileInfo, file_name: fileInfo.file_name, channel_msg_id: sentMsg.message_id };
    return { ...fileInfo, channel_msg_id: sentMsg.message_id };
  } catch (err) { console.error("saveToStorageChannel failed:", err.message); return fileInfo; }
}

async function sendFile(bot, chatId, record) {
  // Caption shows full lecture context (batch/subject/chapter/lecture name)
  // instead of the raw file_name — looked up via getLectureContext(record.code),
  // the same index used for the logs-group messages.
  const caption = buildLectureCaption(record);
  // Forward-restriction (protect_content) should only apply to videos — other file types
  // (photo, audio, voice, document) must stay freely forwardable even for non-owners.
  const isVideoType = record.file_type === "video" || record.file_type === "video_note";
  const protect = isVideoType && !isOwner(chatId);
  try {
    switch(record.file_type) {
      case "photo":      return await bot.sendPhoto(chatId, record.file_id, { caption, parse_mode: "HTML", protect_content: protect });
      case "video":      return await bot.sendVideo(chatId, record.file_id, { caption, parse_mode: "HTML", protect_content: protect });
      case "audio":      return await bot.sendAudio(chatId, record.file_id, { caption, parse_mode: "HTML", protect_content: protect });
      case "voice":      return await bot.sendVoice(chatId, record.file_id, { caption, parse_mode: "HTML", protect_content: protect });
      case "video_note": return await bot.sendVideoNote(chatId, record.file_id, { protect_content: protect }); // video notes don't support captions at all
      default:           return await bot.sendDocument(chatId, record.file_id, { caption, parse_mode: "HTML", filename: record.file_name, protect_content: protect });
    }
  } catch (err) {
    // file_id can go bad (e.g. after switching to a new bot token, since a
    // Telegram file_id is only valid for the bot that issued it). Fall back to
    // copying the mirrored message from the storage channel — but force our own
    // caption, otherwise Telegram keeps whatever caption was on that channel
    // message originally (old filename / promo text) instead of our own.
    if (STORAGE_CHANNEL_ID && record.channel_msg_id) {
      try { return await bot.copyMessage(chatId, STORAGE_CHANNEL_ID, record.channel_msg_id, { caption, parse_mode: "HTML", protect_content: protect }); } catch (_) {}
    }
    throw err;
  }
}
function fileTypeEmoji(type) {
  return { video:"🎬", video_note:"📹", document:"📄", photo:"🖼️", audio:"🎵", voice:"🎤" }[type] || "📎";
}
// Builds the "🎬 Lecture Details" caption shown on every delivered file —
// batch/subject/chapter/lecture name via getLectureContext(record.code), with
// a graceful fallback to just the emoji + file_name when no context is found
// (e.g. an older/orphan code not tied to any course batch).
function buildLectureCaption(record) {
  const ctx = getLectureContext(record.code);
  if (!ctx) return `${fileTypeEmoji(record.file_type)} ${esc(record.file_name || "file")}`;
  const lines = [`${fileTypeEmoji(record.file_type)} <b>Lecture Details</b>`, `🎓 Batch: ${esc(ctx.batchName)}`];
  if (ctx.subjectName) lines.push(`📘 Subject: ${esc(ctx.subjectName)}`);
  if (ctx.chapterName) lines.push(`📖 Chapter: ${esc(ctx.chapterName)}${ctx.unitName ? ` › ${esc(ctx.unitName)}` : ""}`);
  if (ctx.lectureName) lines.push(`🏷️ Lecture: ${esc(ctx.lectureName)}`);
  return lines.join("\n");
}

let rmWords = [];
function cleanFileName(name) {
  if (!rmWords.length) return name;
  const extMatch = name.match(/(\.[a-zA-Z0-9]{1,6})$/);
  let result = extMatch ? name.slice(0,-extMatch[1].length) : name;
  for (const w of rmWords) { const wN=w.toLowerCase().replace(/_/g," "); let rN=result.toLowerCase().replace(/_/g," "); let idx; while((idx=rN.indexOf(wN))!==-1){result=result.slice(0,idx)+result.slice(idx+w.length);rN=result.toLowerCase().replace(/_/g," ");} }
  result = result.replace(/[_ .\-:]{2,}/g,"_").replace(/^[_ .\-:]+|[_ .\-:]+$/g,"").trim();
  return (extMatch ? result+extMatch[1] : result) || name;
}

// "message to delete not found", "chat not found", "bot was blocked", etc. are
// PERMANENT — the message/chat is just gone, retrying changes nothing and only
// wastes API calls. Only genuinely transient errors (network blips like the
// "socket hang up" case) are worth retrying.
function isPermanentTelegramError(err) {
  const msg = (err && err.message || "").toLowerCase();
  return msg.includes("message to delete not found")
      || msg.includes("message can't be deleted")
      || msg.includes("chat not found")
      || msg.includes("bot was blocked")
      || msg.includes("user is deactivated")
      || msg.includes("bad request");
}

// Retries a deleteMessage call with linear backoff (1s, 2s, 3s) on transient
// errors only. Returns true on success, false if the message was already
// gone (permanent error — nothing to do), and re-throws if retries run out
// on a genuinely transient error so the caller's own catch/log still fires.
async function deleteMessageWithRetry(bot, chatId, messageId, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      await bot.deleteMessage(chatId, messageId);
      return true;
    } catch (err) {
      if (isPermanentTelegramError(err)) return false;
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, delay * (i + 1)));
    }
  }
}

// Max lecture videos allowed to sit in a user's chat at once (separate from the
// DAILY_VIDEO_LIMIT/day cap above). The 4th active video pushes the oldest one
// out immediately — deleted right away instead of waiting for its own 6h timer.
const MAX_ACTIVE_VIDEOS = 3;

async function scheduleDelete(bot, chatId, messageId, deleteAt) {
  const id = db.generateId(); // 24-hex string — reused as the Mongo _id below too, so
  // SQLite and Mongo always agree on identity. Without this, a resync (e.g. a
  // redeploy where SQLite's disk persists) would give the Mongo copy a brand new
  // _id and re-insert it as a DUPLICATE row instead of recognizing it as already
  // present — which is exactly what was silently inflating the active-video count
  // and causing way more than 1 eviction per new lecture call.
  db.pendingDelete.create({ id, chat_id: chatId, message_id: messageId, delete_at: deleteAt });
  PendingDelete.create({ _id: id, chat_id: chatId, message_id: messageId, delete_at: deleteAt }).catch(() => {});
  const delay = Math.max(0, new Date(deleteAt) - Date.now());
  setTimeout(async () => {
    try { await deleteMessageWithRetry(bot, chatId, messageId); } catch (err) { console.error("Auto DM deletion error:", err.message); }
    // deleteMany (not deleteOne) — cleans up ALL rows for this message, including
    // any leftover duplicate from before the _id fix above went live.
    db.pendingDelete.deleteByChatMsg(chatId, messageId);
    PendingDelete.deleteMany({ chat_id: chatId, message_id: messageId }).catch(() => {});
  }, delay);
  // Returns how many older videos got evicted by the cap below, so the caller
  // can fold that into the SAME "auto-deletes in 6 hours" message instead of
  // sending it as a separate notice.
  return enforceActiveVideoCap(bot, chatId);
}

// Keeps at most MAX_ACTIVE_VIDEOS videos "live" in a chat at any time. All
// scheduleDelete() entries for a chat are videos (it's never called for other
// file types), and every one is scheduled for exactly +6h from its own send
// time, so sorting by delete_at ascending is the same as sorting by send order
// — oldest-sent first. Anything beyond the cap gets deleted right now. Returns
// the number evicted (0 if none) — no message sent here, callers combine this
// into their own single "video sent" notice (see evictionNotice() below).
async function enforceActiveVideoCap(bot, chatId) {
  const raw = db.pendingDelete.getByChatId(chatId);
  // De-dupe by message_id — any already-existing duplicate rows left over from
  // before the _id fix above (or any future resync edge case) must never be
  // double-counted as two separate "active videos".
  const seen = new Map();
  for (const p of raw) if (!seen.has(p.message_id)) seen.set(p.message_id, p);
  const active = [...seen.values()].sort((a, b) => a.delete_at - b.delete_at);
  const excess = active.length - MAX_ACTIVE_VIDEOS;
  for (let i = 0; i < excess; i++) {
    const p = active[i];
    try { await deleteMessageWithRetry(bot, chatId, p.message_id); } catch (err) { console.error("Active-video-cap eviction error:", err.message); }
    // deleteByChatMsg/deleteMany — removes EVERY row for this message (not just
    // the one matched by its own id), so any lingering duplicate gets cleaned up
    // too instead of being recounted on the next call.
    db.pendingDelete.deleteByChatMsg(chatId, p.message_id);
    PendingDelete.deleteMany({ chat_id: chatId, message_id: p.message_id }).catch(() => {});
  }
  return Math.max(0, excess);
}

// One-line phrasing for however many older videos got evicted, or "" if none —
// meant to be folded into the same message as the "auto-deletes in 6h" notice.
function evictionNotice(evictedCount) {
  if (!evictedCount) return "";
  const word = evictedCount === 1 ? "video" : "videos";
  return `🗑 Aapke sabse purane ${evictedCount} ${word} hata diye gaye (ek time pe max ${MAX_ACTIVE_VIDEOS} lecture videos allowed hain).`;
}



async function recoverPendingDeletes(bot) {
  const pending = db.pendingDelete.getAll();
  console.log(`Recovering ${pending.length} pending DM deletions...`);
  for (const p of pending) {
    const delay = Math.max(0, new Date(p.delete_at) - Date.now());
    setTimeout(async () => {
      try { await deleteMessageWithRetry(bot, p.chat_id, p.message_id); } catch (err) { console.error("Recovered deletion error:", err.message); }
      db.pendingDelete.deleteById(p._id);
      PendingDelete.deleteOne({ _id: p._id }).catch(() => {});
    }, delay);
  }
}

// Immediately deletes every still-pending (not-yet-auto-deleted) video this user
// was sent, instead of waiting for the normal 6h auto-delete timer. Used when a
// user is banned — their DM is wiped right away. Returns the number deleted.
async function deleteAllPendingVideosForUser(bot, chatId) {
  const pending = db.pendingDelete.getByChatId(chatId);
  let deleted = 0;
  for (const p of pending) {
    try {
      const ok = await deleteMessageWithRetry(bot, chatId, p.message_id);
      if (ok) deleted++;
    } catch (err) {
      console.error("Ban-time deletion error:", err.message);
    }
    db.pendingDelete.deleteById(p._id);
    PendingDelete.deleteOne({ _id: p._id }).catch(() => {});
  }
  return deleted;
}

// delivered_at is stored as a JSON string (chatId -> timestamp) to mirror the
// SQLite column exactly; Mongo has no atomic op for "set one key inside a
// JSON string field", so this is a small best-effort read-modify-write,
// consistent with the existing fire-and-forget .catch(()=>{}) pattern here.
async function stampMongoDeliveredAt(fileRecordId, chatId, value) {
  try {
    const doc = await FileRecord.findById(fileRecordId).select('delivered_at').lean();
    if (!doc) return;
    const at = JSON.parse(doc.delivered_at || '{}');
    if (value === null) delete at[chatId]; else at[chatId] = value;
    await FileRecord.updateOne({ _id: fileRecordId }, { $set: { delivered_at: JSON.stringify(at) } });
  } catch (_) {}
}

// Persists the "un-deliver" job (like scheduleDelete persists the message-delete
// job) so a bot restart doesn't lose the timer and leave the chatId stuck in
// delivered_to forever — which was blocking re-requests after 6 hours.
async function scheduleUndeliver(fileRecordId, code, chatId, undeliverAt) {
  const id = db.generateId(); // reused as Mongo _id below — see scheduleDelete() for why
  db.pendingUndeliver.create({ id, file_record_id: fileRecordId, code, chat_id: chatId, undeliver_at: undeliverAt });
  PendingUndeliver.create({ _id: id, file_record_id: fileRecordId, code, chat_id: chatId, undeliver_at: undeliverAt })
    .catch(err => console.error('PendingUndeliver mongo create error:', err.message));
  const delay = Math.max(0, new Date(undeliverAt) - Date.now());
  setTimeout(() => {
    db.fileRecord.removeDeliveredTo(fileRecordId, chatId);
    // Match by _id (=fileRecordId), not by code — code is only kept for
    // debugging and must never be a hard requirement for clearing delivered_to.
    FileRecord.updateOne({ _id: fileRecordId }, { $pull: { delivered_to: chatId } }).catch(() => {});
    stampMongoDeliveredAt(fileRecordId, chatId, null);
    db.pendingUndeliver.deleteById(id);
    PendingUndeliver.deleteMany({ file_record_id: fileRecordId, chat_id: chatId }).catch(() => {});
  }, delay);
}

async function recoverPendingUndelivers() {
  const pending = db.pendingUndeliver.getAll();
  console.log(`Recovering ${pending.length} pending file re-request cooldowns...`);
  for (const p of pending) {
    const delay = Math.max(0, new Date(p.undeliver_at) - Date.now());
    setTimeout(() => {
      db.fileRecord.removeDeliveredTo(p.file_record_id, p.chat_id);
      FileRecord.updateOne({ _id: p.file_record_id }, { $pull: { delivered_to: p.chat_id } }).catch(() => {});
      stampMongoDeliveredAt(p.file_record_id, p.chat_id, null);
      db.pendingUndeliver.deleteById(p._id);
      PendingUndeliver.deleteOne({ _id: p._id }).catch(() => {});
    }, delay);
  }
}

const esc = (s) => String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
// Formats "👤 Name (@username)" for payment-group notifications — Paytm/Razorpay
// orders already store firstName/lastName/username at order-creation time
// (same as BharatPe's caption does), this just renders it consistently.
function formatPayerLine(order) {
  const name = [order.firstName, order.lastName].filter(Boolean).join(" ").trim() || "Unknown";
  const usernameStr = order.username ? ` (@${esc(order.username)})` : "";
  return `👤 <b>${esc(name)}</b>${usernameStr}`;
}
async function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── BharatPe payment verification (via Ilambit DevPort) ────────────────────────
// In-memory guard against the same UTR being submitted twice and auto-approved
// twice. Resets on restart — if you need this to survive restarts, persist UTRs
// used against a batch/user in SQLite/Mongo instead (e.g. a column on FileRecord-
// style payment log) and check that table here too.
const usedUTRs = new Set();

async function verifyBharatPePayment(utr) {
  if (!DEVPORT_API_KEY) return { ok: false, reason: "not_configured" };
  try {
    const resp = await fetch(`https://devport.ilambit.in/api/v1/bharatpe/status/${encodeURIComponent(utr)}`, {
      headers: { "X-API-Key": DEVPORT_API_KEY },
      signal: AbortSignal.timeout(10000),
    });
    const data = await resp.json();
    if (!data.success) return { ok: false, reason: data.error?.code || "api_error", message: data.error?.message || "" };
    const txn = data.data?.transaction || null;
    return {
      ok: true,
      verified: !!data.data?.verified,
      found: !!data.data?.found,
      amount: txn ? Number(txn.amount) : null,
      senderName: txn?.senderName || null,
      status: txn?.status || null,
      timestamp: txn?.transactionTimestamp || null,
      requestsRemaining: data.meta?.requestsRemaining,
    };
  } catch (e) {
    console.error("BharatPe verify error:", e.message);
    return { ok: false, reason: "network_error", message: e.message };
  }
}

// Shared by both auto-approval (BharatPe-verified) and manual admin approval —
// grants a user access to a batch in both Mongo (source of truth) and SQLite
// (fast local reads). Also transparently handles the Ads-Free plan sentinels
// (see getAdsFreePlans() above) so every existing caller — BharatPe admin
// approval, Paytm callback, Razorpay verify/webhook — supports selling either
// Ads-Free duration for free, with no changes needed at any of those call sites.
async function grantBatchAccess(batchId, targetUserId) {
  const adsFreePlans = getAdsFreePlans();
  if (adsFreePlans[batchId]) {
    const expiresAt = await grantAdsFreeAccess(targetUserId, adsFreePlans[batchId].days);
    return { _id: batchId, name: `Ads-Free Plan (active till ${expiresAt.toLocaleDateString("en-IN")})` };
  }
  const Batch = require("./models/Course");
  const batch = await Batch.findById(batchId);
  if (batch) {
    if (!batch.premiumUsers) batch.premiumUsers = [];
    if (!batch.premiumUsers.includes(String(targetUserId))) { batch.premiumUsers.push(String(targetUserId)); await batch.save(); }
    db.batch.upsert(batch.toObject());
  }
  return batch;
}

// ── Paytm Payment Gateway (official) ────────────────────────────────────────────
// Standard "Initiate Transaction" + hosted checkout page + Order Status confirmation
// flow, per Paytm's documented Payment Gateway integration. Requires real PG
// credentials (MID + Merchant Key) from Paytm Business dashboard → Developer Settings
// — NOT the same as a plain Paytm UPI collection ID, which has no public status API.
async function paytmInitiateTransaction({ orderId, amount, custId, email, mobile }) {
  if (!PaytmChecksum || !PAYTM_MID || !PAYTM_MERCHANT_KEY) return { ok:false, reason:"not_configured" };
  try {
    const body = {
      requestType: "Payment",
      mid: PAYTM_MID,
      websiteName: PAYTM_WEBSITE,
      orderId,
      callbackUrl: PAYTM_CALLBACK_URL,
      txnAmount: { value: Number(amount).toFixed(2), currency: "INR" },
      userInfo: { custId: String(custId), ...(email?{email}:{}) , ...(mobile?{mobile}:{}) },
    };
    const signature = await PaytmChecksum.generateSignature(JSON.stringify(body), PAYTM_MERCHANT_KEY);
    const resp = await fetch(`https://${PAYTM_HOST}/theia/api/v1/initiateTransaction?mid=${encodeURIComponent(PAYTM_MID)}&orderId=${encodeURIComponent(orderId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ head: { signature }, body }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await resp.json();
    const txnToken = data?.body?.txnToken;
    if (!txnToken) return { ok:false, reason: data?.body?.resultInfo?.resultMsg || "no_txn_token", raw: data };
    return { ok:true, txnToken };
  } catch (e) {
    console.error("Paytm initiate error:", e.message);
    return { ok:false, reason:"network_error", message: e.message };
  }
}

// Authoritative status check — via Ilambit DevPort's Paytm endpoint (same pattern as
// verifyBharatPePayment), NOT a direct call to Paytm. DevPort holds the Paytm Order
// Status lookup against your configured Merchant ID (Services → Paytm on their
// dashboard) — reuses the same DEVPORT_API_KEY already used for BharatPe.
async function verifyPaytmPayment(orderId) {
  if (!DEVPORT_API_KEY) return { ok:false, reason:"not_configured" };
  try {
    const resp = await fetch(`https://devport.ilambit.in/api/v1/paytm/status/${encodeURIComponent(orderId)}`, {
      headers: { "X-API-Key": DEVPORT_API_KEY },
      signal: AbortSignal.timeout(10000),
    });
    const data = await resp.json();
    if (!data.success) return { ok:false, reason: data.error?.code || "api_error", message: data.error?.message || "" };
    const txn = data.data?.transaction || null;
    return {
      ok: true,
      verified: !!data.data?.verified,
      found: !!data.data?.found,
      status: txn?.status || null, // "TXN_SUCCESS" | ...
      amount: txn?.txnAmount != null ? Number(txn.txnAmount) : null,
      txnId: txn?.txnId || null,
      bankTxnId: txn?.bankTxnId || null,
      paymentMode: txn?.paymentMode || null,
      gatewayName: txn?.gatewayName || null,
      timestamp: txn?.txnDate || null,
      requestsRemaining: data.meta?.requestsRemaining,
    };
  } catch (e) {
    console.error("Paytm (DevPort) verify error:", e.message);
    return { ok:false, reason:"network_error", message: e.message };
  }
}

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();
// Trust the first hop reverse proxy (nginx/ALB/etc.) so req.ip resolves to the
// real client IP from X-Forwarded-For instead of the proxy's own address —
// needed for the multi-account (same-IP) detection in course.js. If this app
// is ever exposed directly to the internet (no proxy in front), this should
// be removed/changed, since trusting X-Forwarded-For without a proxy lets a
// client spoof its own IP.
app.set("trust proxy", true);
app.use(express.json({ limit: "10mb", verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

app.get("/health", (req, res) => res.json({ status: "ok", uptime: process.uptime(), mongo: mongoose.connection.readyState===1?"connected":"disconnected", sqlite: "active" }));
app.get("/api/config", (req, res) => {
  const fj = (process.env.FORCE_JOIN_CHANNELS||"").split(",").map(s=>s.trim()).filter(Boolean);
  const adsFreePlans = getAdsFreePlans();
  res.json({ ownerId: OWNER_ID, botUsername: BOT_USERNAME||"", forceJoinRequired: fj.length>0, upiId: UPI_ID||"", upiName: UPI_NAME||"", contactLink: CONTACT_LINK||`https://t.me/${BOT_USERNAME}`, paymentProvider: PAYMENT_PROVIDER, razorpayKeyId: RAZORPAY_KEY_ID||"", monetagZoneId: MONETAG_ZONE_ID, adsFreeWeeklyPrice: adsFreePlans.ADSFREEWEEKLY.price, adsFreeMonthlyPrice: adsFreePlans.ADSFREEPLAN.price });
});

// Whether this user currently has an active Ads-Free subscription, and when it
// expires. Frontend polls/caches this at init to decide whether to skip ads.
app.get("/api/adsfree/status", (req, res) => {
  const userId = req.query.userId;
  if (!userId) return apiErr(res, 400, "MISSING_FIELDS", "userId is required");
  const status = getAdsFreeStatus(userId);
  return apiOk(res, status, { service: "adsfree" });
});

// Whether the maintenance-mode full-screen gate should be shown to this user.
// Off by default; the owner toggles it via /maintenance in the bot, and can
// whitelist specific user IDs via /maintenanceallow to keep testing while
// everyone else sees the gate. The owner's own account always bypasses this
// automatically (isAdmin short-circuits client-side before this is even
// called, but it's double-checked here too in case that ever changes).
app.get("/api/maintenance/status", (req, res) => {
  const userId = req.query.userId;
  const active = !!db.settings.get("maintenance_mode", false);
  if (!active || (userId && isOwner(Number(userId)))) return apiOk(res, { show: false }, { service: "maintenance" });
  const allowed = db.settings.get("maintenance_allowlist", []);
  const show = !allowed.includes(String(userId));
  return apiOk(res, { show }, { service: "maintenance" });
});

// Generates the payment UPI QR server-side (so it's a real, shareable/downloadable HTTPS
// URL — required for Telegram's native tg.downloadFile) and overlays public/logo.png in
// the center. errorCorrectionLevel "H" (30% redundancy) keeps the code scannable even with
// ~22% of the middle covered by the logo. If public/logo.png doesn't exist yet, falls back
// to a plain QR with no logo — drop your logo file in at public/logo.png to enable this.
app.get("/api/payment-qr", async (req, res) => {
  try {
    if (!QRCode || !JimpLib) return res.status(503).send("QR generator not installed on server. Run: npm install qrcode jimp --save");
    if (!UPI_ID) return res.status(404).send("UPI_ID not configured");
    const amount = req.query.amount ? Number(req.query.amount) : null;
    const note = (req.query.note || "Payment").toString().slice(0, 40);

    let upiStr = `upi://pay?pa=${encodeURIComponent(UPI_ID)}&pn=${encodeURIComponent(UPI_NAME || "Payment")}`;
    if (amount && amount > 0) upiStr += `&am=${amount.toFixed(2)}`;
    upiStr += `&cu=INR&tn=${encodeURIComponent("Payment for " + note)}`;

    const qrBuffer = await QRCode.toBuffer(upiStr, { errorCorrectionLevel: "H", width: 500, margin: 1 });
    const qrImg = await JimpLib.read(qrBuffer);

    const logoPath = path.join(__dirname, "public", "logo.png");
    if (fs.existsSync(logoPath)) {
      const logoImg = await JimpLib.read(logoPath);
      const qrSize = qrImg.bitmap.width;
      const logoSize = Math.floor(qrSize * 0.22);
      logoImg.resize({ w: logoSize, h: logoSize });

      const pad = Math.floor(logoSize * 0.12);
      const backdropSize = logoSize + pad * 2;
      const backdrop = new JimpLib({ width: backdropSize, height: backdropSize, color: 0xffffffff });
      const bx = Math.floor((qrSize - backdropSize) / 2), by = Math.floor((qrSize - backdropSize) / 2);
      qrImg.composite(backdrop, bx, by);

      const lx = Math.floor((qrSize - logoSize) / 2), ly = Math.floor((qrSize - logoSize) / 2);
      qrImg.composite(logoImg, lx, ly);
    }

    const outBuffer = await qrImg.getBuffer("image/png");
    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "no-store");
    res.send(outBuffer);
  } catch (e) {
    console.error("payment-qr error:", e);
    res.status(500).send("QR generation failed");
  }
});

const courseRoutes = require("./routes/course");
const GiveawayInvite = mongoose.model("GiveawayInvite"); // schema lives in routes/course.js, registered at require-time above
const {
  BatchReferralUnlock,
  PendingReferral,
  setBatchPremiumCache,
  clearAllBatchPremiumCacheForUser,
  preloadBatchPremiumCache,
} = require("./models/ReferralUnlock");
app.use("/api", courseRoutes);
const autoLectureSession = courseRoutes.autoLectureSession;
const autoAddLecture = courseRoutes.autoAddLecture;

app.post("/api/pay-request", async (req, res) => {
  try {
    const { batchId, userId, firstName, lastName, username, txnId, screenshotBase64, couponCode, discountPct, finalAmount } = req.body;
    if (!batchId || !txnId) return res.status(400).json({ error: "Missing fields" });
    const info = getProductInfo(batchId);
    const batchName = info.name;
    const origPrice = info.price != null ? `₹${info.price}` : "N/A";
    const expectedAmount = finalAmount != null ? Number(finalAmount) : (info.price != null ? Number(info.price) : null);
    let priceLine = `💰 Amount: <b>${esc(origPrice)}</b>`;
    if (couponCode && discountPct && finalAmount!=null) priceLine = `💰 Original: <b>${esc(origPrice)}</b>\n🎟 Coupon: <code>${esc(couponCode)}</code> (${esc(String(discountPct))}% off)\n✅ Final: <b>₹${esc(String(finalAmount))}</b>`;
    if (!PAYMENT_GROUP_ID) return res.status(500).json({ error: "PAYMENT_GROUP_ID not configured" });

    // ── Try auto-verifying the UTR against BharatPe via DevPort before bothering an admin ──
    const alreadyUsed = usedUTRs.has(txnId);
    const verify = alreadyUsed ? { ok: false, reason: "utr_reused" } : await verifyBharatPePayment(txnId);
    const amountMatches = verify.ok && expectedAmount != null && verify.amount != null && Math.abs(verify.amount - expectedAmount) <= PAYMENT_AMOUNT_TOLERANCE;
    const autoApprove = verify.ok && verify.verified && verify.found && verify.status === "SUCCESS" && amountMatches;

    let verifyLine;
    if (alreadyUsed) verifyLine = `🔍 Verify: ⚠️ UTR already used earlier`;
    else if (!verify.ok) verifyLine = `🔍 Verify: ⚠️ ${verify.reason === "not_configured" ? "DevPort not configured" : "could not verify (" + (verify.reason || "error") + ")"}`;
    else if (!verify.found) verifyLine = `🔍 Verify: ❌ Not found on BharatPe`;
    else if (!verify.verified || verify.status !== "SUCCESS") verifyLine = `🔍 Verify: ⚠️ Found but status is ${esc(verify.status||"unknown")}`;
    else if (!amountMatches) verifyLine = `🔍 Verify: ⚠️ Amount mismatch (paid ₹${esc(String(verify.amount))}, expected ₹${esc(String(expectedAmount))})`;
    else verifyLine = `🔍 Verify: ✅ Matched — ₹${esc(String(verify.amount))} from ${esc(verify.senderName||"N/A")}`;

    const caption = `💸 <b>New Payment Request!</b>\n\n👤 <b>${esc(firstName)}${lastName?" "+esc(lastName):""}</b>\n🆔 UID: <code>${esc(userId)}</code>\n📱 @${username||"N/A"}\n\n📚 Batch: <b>${esc(batchName)}</b>\n${priceLine}\n🔖 UTR: <code>${esc(txnId)}</code>\n${verifyLine}`;

    if (autoApprove) {
      usedUTRs.add(txnId);
      try {
        const batch = await grantBatchAccess(batchId, userId);
        await bot.sendMessage(parseInt(userId), `✅ <b>Payment Verified & Approved!</b>\n\nAccess to <b>${esc(batch?.name||batchName)}</b> unlocked! 🚀`, { parse_mode:"HTML", reply_markup:{ inline_keyboard:[[{text:"📚 Open App",web_app:{url:WEB_URL}}]] } }).catch(()=>{});
        const autoCaption = `${caption}\n\n✅ <b>AUTO-APPROVED</b> (BharatPe verified)`;
        if (screenshotBase64) { const buf = Buffer.from(screenshotBase64.replace(/^data:image\/\w+;base64,/,""),"base64"); await bot.sendPhoto(PAYMENT_GROUP_ID, buf, { caption: autoCaption, parse_mode:"HTML", filename:`payment_${userId}.jpg` }); }
        else await bot.sendMessage(PAYMENT_GROUP_ID, autoCaption, { parse_mode:"HTML" });
        return res.json({ success: true, autoApproved: true });
      } catch (err) {
        console.error("Auto-approve grant error:", err.message);
        // fall through to manual review below if granting access failed
      }
    }

    // ── Manual review fallback — same as before, plus the verification line above ──
    const kb = { inline_keyboard: [[{ text: "✅ Approve", callback_data: `pay_approve_${batchId}_${userId}` },{ text: "❌ Reject", callback_data: `pay_reject_${batchId}_${userId}` }]] };
    if (screenshotBase64) { const buf = Buffer.from(screenshotBase64.replace(/^data:image\/\w+;base64,/,""),"base64"); await bot.sendPhoto(PAYMENT_GROUP_ID, buf, { caption, parse_mode:"HTML", filename:`payment_${userId}.jpg`, reply_markup: kb }); }
    else await bot.sendMessage(PAYMENT_GROUP_ID, caption, { parse_mode:"HTML", reply_markup: kb });
    res.json({ success: true, autoApproved: false });
  } catch (err) { console.error("Payment request error:", err.message); res.status(500).json({ error: err.message }); }
});

// ── DevPort-style response envelope ─────────────────────────────────────────────
// Mirrors the success/data/meta and error.code conventions documented at
// https://devport.ilambit.in/docs#response-format — used for our own Paytm
// endpoints so error handling on the frontend can switch on `error.code` the
// same way it would for a DevPort-backed service.
function apiOk(res, data, extraMeta) {
  res.json({ success: true, data, meta: { requestId: crypto.randomUUID(), timestamp: new Date().toISOString(), ...extraMeta } });
}
function apiErr(res, httpStatus, code, message) {
  res.status(httpStatus).json({ success: false, error: { code, message }, meta: { requestId: crypto.randomUUID(), timestamp: new Date().toISOString() } });
}

// ── Paytm: start checkout ─────────────────────────────────────────────────────
// Creates a tracked order, asks Paytm for a txnToken, and hands the frontend what
// it needs to redirect into Paytm's own hosted payment page.
app.post("/api/paytm/initiate", async (req, res) => {
  try {
    if (PAYMENT_PROVIDER !== "paytm") return apiErr(res, 400, "SERVICE_DISABLED", "Paytm is not the active payment provider");
    if (!PaytmChecksum || !PAYTM_MID || !PAYTM_MERCHANT_KEY) return apiErr(res, 500, "NOT_CONFIGURED", "Paytm not configured (missing PAYTM_MID/PAYTM_MERCHANT_KEY or paytmchecksum package)");
    const { batchId, userId, firstName, lastName, username, couponCode, discountPct, finalAmount } = req.body;
    if (!batchId || !userId) return apiErr(res, 400, "MISSING_FIELDS", "batchId and userId are required");
    const amount = finalAmount != null ? Number(finalAmount) : getProductInfo(batchId).price;
    if (!amount || amount <= 0) return apiErr(res, 400, "INVALID_AMOUNT", "Could not determine a valid amount for this batch");

    const orderId = `ORD${Date.now()}${Math.floor(Math.random()*1000)}`;
    await PaytmOrder.create({ orderId, batchId, userId: String(userId), firstName, lastName, username, amount, couponCode, discountPct, status: "pending" });

    const result = await paytmInitiateTransaction({ orderId, amount, custId: userId });
    if (!result.ok) return apiErr(res, 502, "UPSTREAM_ERROR", result.reason === "not_configured" ? "Paytm not configured" : (result.message || `Paytm rejected the request: ${result.reason}`));

    return apiOk(res, { orderId, mid: PAYTM_MID, txnToken: result.txnToken, amount, checkoutUrl: `https://${PAYTM_HOST}/theia/api/v1/showPaymentPage` }, { service: "paytm" });
  } catch (err) { console.error("Paytm initiate error:", err.message); apiErr(res, 500, "INTERNAL_ERROR", err.message); }
});

// ── Paytm: checkout callback ──────────────────────────────────────────────────
// Paytm POSTs (form-urlencoded) here once the user finishes on their hosted page.
// We verify the checksum for authenticity, then call the Order Status API as the
// authoritative source (never trust callback params alone for granting access).
app.post("/api/paytm/callback", async (req, res) => {
  const params = req.body || {};
  const orderId = params.ORDERID;
  const resultPage = (ok, msg) => res.send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:system-ui,sans-serif;background:#0f1115;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;padding:24px}a{color:#f59e0b}</style></head><body><div><h2>${ok?"✅ Payment "+esc(msg||"Successful"):"❌ "+esc(msg||"Payment Failed")}</h2><p><a href="${esc(WEB_URL||"/")}">Tap here to return to the app</a></p></div></body></html>`);
  try {
    if (!orderId) return resultPage(false, "Invalid callback");
    const order = await PaytmOrder.findOne({ orderId });
    if (!order) return resultPage(false, "Order not found");
    if (order.status === "success") return resultPage(true, "Already Verified"); // idempotent — Paytm may hit this more than once

    if (PaytmChecksum) {
      const receivedChecksum = params.CHECKSUMHASH;
      const toVerify = { ...params }; delete toVerify.CHECKSUMHASH;
      const valid = receivedChecksum ? await PaytmChecksum.verifySignature(toVerify, PAYTM_MERCHANT_KEY, receivedChecksum) : false;
      if (!valid) { console.error(`Paytm callback checksum mismatch for order ${orderId}`); return resultPage(false, "Verification Failed"); }
    }

    // Authoritative check — via DevPort, don't trust the callback body alone
    const status = await verifyPaytmPayment(orderId);
    const amountMatches = status.ok && status.amount != null && Math.abs(status.amount - order.amount) <= PAYMENT_AMOUNT_TOLERANCE;
    const confirmed = status.ok && status.verified && status.found && status.status === "TXN_SUCCESS" && amountMatches;
    if (confirmed) {
      order.status = "success"; order.txnId = status.txnId || params.TXNID || ""; await order.save();
      const batch = await grantBatchAccess(order.batchId, order.userId);
      await bot.sendMessage(parseInt(order.userId), `✅ <b>Payment Verified & Approved!</b>\n\nAccess to <b>${esc(batch?.name||order.batchId)}</b> unlocked! 🚀`, { parse_mode:"HTML", reply_markup:{ inline_keyboard:[[{text:"📚 Open App",web_app:{url:WEB_URL}}]] } }).catch(()=>{});
      if (PAYMENT_GROUP_ID) bot.sendMessage(PAYMENT_GROUP_ID, `💸 <b>Paytm Payment Received</b>\n\n${formatPayerLine(order)}\n🆔 UID: <code>${esc(order.userId)}</code>\n📚 Batch: <b>${esc(batch?.name||order.batchId)}</b>\n💰 Amount: <b>₹${esc(String(status.amount))}</b>\n🔖 Paytm Txn: <code>${esc(order.txnId)}</code>\n💳 Mode: ${esc(status.paymentMode||"N/A")} via ${esc(status.gatewayName||"N/A")}\n\n✅ <b>AUTO-APPROVED</b> (verified via DevPort)`, { parse_mode:"HTML" }).catch(()=>{});
      return resultPage(true, "Successful");
    } else {
      order.status = "failed"; await order.save();
      if (PAYMENT_GROUP_ID) bot.sendMessage(PAYMENT_GROUP_ID, `⚠️ <b>Paytm Payment Failed/Unmatched</b>\n\n${formatPayerLine(order)}\n🆔 UID: <code>${esc(order.userId)}</code>\nOrder: <code>${esc(orderId)}</code>\nStatus: ${esc(status.status||"unknown")}`, { parse_mode:"HTML" }).catch(()=>{});
      return resultPage(false, status.status || "Payment Failed");
    }
  } catch (err) {
    console.error("Paytm callback error:", err.message);
    return resultPage(false, "Server Error");
  }
});

// ── Razorpay: create order ────────────────────────────────────────────────────
// Creates a Razorpay order (amount in paise) + a tracked RazorpayOrder row, and
// hands the frontend what it needs to open the official Checkout.js popup.
app.post("/api/razorpay/create-order", async (req, res) => {
  try {
    if (PAYMENT_PROVIDER !== "razorpay") return apiErr(res, 400, "SERVICE_DISABLED", "Razorpay is not the active payment provider");
    if (!razorpayClient) return apiErr(res, 500, "NOT_CONFIGURED", "Razorpay not configured (missing RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET or razorpay package)");
    const { batchId, userId, firstName, lastName, username, couponCode, discountPct, finalAmount } = req.body;
    if (!batchId || !userId) return apiErr(res, 400, "MISSING_FIELDS", "batchId and userId are required");
    const amount = finalAmount != null ? Number(finalAmount) : getProductInfo(batchId).price;
    if (!amount || amount <= 0) return apiErr(res, 400, "INVALID_AMOUNT", "Could not determine a valid amount for this batch");

    const rpOrder = await razorpayClient.orders.create({
      amount: Math.round(amount * 100), // paise
      currency: "INR",
      receipt: `ORD${Date.now()}${Math.floor(Math.random()*1000)}`,
      notes: { batchId, userId: String(userId), couponCode: couponCode || "" },
    });

    await RazorpayOrder.create({ orderId: rpOrder.id, batchId, userId: String(userId), firstName, lastName, username, amount, couponCode, discountPct, status: "pending" });

    return apiOk(res, { orderId: rpOrder.id, amount: rpOrder.amount, currency: rpOrder.currency, keyId: RAZORPAY_KEY_ID }, { service: "razorpay" });
  } catch (err) { console.error("Razorpay create-order error:", err.message); apiErr(res, 500, "INTERNAL_ERROR", err.message); }
});

// ── Razorpay: verify payment ──────────────────────────────────────────────────
// Called by the frontend's Checkout.js success handler with razorpay_order_id,
// razorpay_payment_id, razorpay_signature. The signature is an HMAC-SHA256 of
// "order_id|payment_id" keyed with our Key Secret — Razorpay's own recommended
// way to authoritatively confirm a payment without any extra API call. Never
// trust the presence of a success callback alone; always verify this signature
// before granting access.
app.post("/api/razorpay/verify", async (req, res) => {
  try {
    if (PAYMENT_PROVIDER !== "razorpay") return apiErr(res, 400, "SERVICE_DISABLED", "Razorpay is not the active payment provider");
    if (!RAZORPAY_KEY_SECRET) return apiErr(res, 500, "NOT_CONFIGURED", "Razorpay not configured");
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) return apiErr(res, 400, "MISSING_FIELDS", "Missing Razorpay payment fields");

    const order = await RazorpayOrder.findOne({ orderId: razorpay_order_id });
    if (!order) return apiErr(res, 404, "NOT_FOUND", "Order not found");
    if (order.status === "success") return apiOk(res, { alreadyVerified: true }, { service: "razorpay" }); // idempotent

    const expectedSignature = crypto.createHmac("sha256", RAZORPAY_KEY_SECRET).update(`${razorpay_order_id}|${razorpay_payment_id}`).digest("hex");
    const valid = expectedSignature.length === razorpay_signature.length && crypto.timingSafeEqual(Buffer.from(expectedSignature), Buffer.from(razorpay_signature));
    if (!valid) {
      console.error(`Razorpay signature mismatch for order ${razorpay_order_id}`);
      return apiErr(res, 400, "SIGNATURE_INVALID", "Payment verification failed");
    }

    order.status = "success"; order.paymentId = razorpay_payment_id; await order.save();
    const batch = await grantBatchAccess(order.batchId, order.userId);
    await bot.sendMessage(parseInt(order.userId), `✅ <b>Payment Verified & Approved!</b>\n\nAccess to <b>${esc(batch?.name||order.batchId)}</b> unlocked! 🚀`, { parse_mode:"HTML", reply_markup:{ inline_keyboard:[[{text:"📚 Open App",web_app:{url:WEB_URL}}]] } }).catch(()=>{});
    if (PAYMENT_GROUP_ID) bot.sendMessage(PAYMENT_GROUP_ID, `💸 <b>Razorpay Payment Received</b>\n\n${formatPayerLine(order)}\n🆔 UID: <code>${esc(order.userId)}</code>\n📚 Batch: <b>${esc(batch?.name||order.batchId)}</b>\n💰 Amount: <b>₹${esc(String(order.amount))}</b>\n🔖 Razorpay Payment: <code>${esc(razorpay_payment_id)}</code>\n\n✅ <b>AUTO-APPROVED</b> (signature verified)`, { parse_mode:"HTML" }).catch(()=>{});
    return apiOk(res, { verified: true, batchName: batch?.name||order.batchId }, { service: "razorpay" });
  } catch (err) { console.error("Razorpay verify error:", err.message); apiErr(res, 500, "INTERNAL_ERROR", err.message); }
});

// ── Razorpay: webhook (redundant server-to-server confirmation) ──────────────
// Optional but recommended: configure this URL (WEB_URL + /api/razorpay/webhook)
// under Razorpay Dashboard → Settings → Webhooks, subscribed to "payment.captured".
// This grants access even if the user closes the WebView right after paying,
// before the Checkout.js success handler's /verify call reaches our server.
// Idempotent with /verify — whichever arrives first wins, the other is a no-op.
app.post("/api/razorpay/webhook", async (req, res) => {
  try {
    if (!RAZORPAY_WEBHOOK_SECRET) return res.status(200).send("ignored"); // not configured — ack so Razorpay stops retrying
    const signature = req.headers["x-razorpay-signature"];
    const expected = crypto.createHmac("sha256", RAZORPAY_WEBHOOK_SECRET).update(req.rawBody || Buffer.from(JSON.stringify(req.body))).digest("hex");
    if (!signature || expected.length !== signature.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) {
      console.error("Razorpay webhook signature mismatch");
      return res.status(400).send("invalid signature");
    }
    const event = req.body;
    if (event.event === "payment.captured") {
      const payment = event.payload?.payment?.entity;
      const orderId = payment?.order_id;
      if (orderId) {
        const order = await RazorpayOrder.findOne({ orderId });
        if (order && order.status !== "success") {
          order.status = "success"; order.paymentId = payment.id; await order.save();
          const batch = await grantBatchAccess(order.batchId, order.userId);
          await bot.sendMessage(parseInt(order.userId), `✅ <b>Payment Verified & Approved!</b>\n\nAccess to <b>${esc(batch?.name||order.batchId)}</b> unlocked! 🚀`, { parse_mode:"HTML", reply_markup:{ inline_keyboard:[[{text:"📚 Open App",web_app:{url:WEB_URL}}]] } }).catch(()=>{});
          if (PAYMENT_GROUP_ID) bot.sendMessage(PAYMENT_GROUP_ID, `💸 <b>Razorpay Payment Received (webhook)</b>\n\n${formatPayerLine(order)}\n🆔 UID: <code>${esc(order.userId)}</code>\n📚 Batch: <b>${esc(batch?.name||order.batchId)}</b>\n💰 Amount: <b>₹${esc(String(order.amount))}</b>\n🔖 Razorpay Payment: <code>${esc(payment.id)}</code>\n\n✅ <b>AUTO-APPROVED</b> (webhook verified)`, { parse_mode:"HTML" }).catch(()=>{});
        }
      }
    }
    res.status(200).send("ok");
  } catch (err) { console.error("Razorpay webhook error:", err.message); res.status(500).send("error"); }
});

// ── Monetag SDK proxy ────────────────────────────────────────────────────────
// TEMP: currently NOT used by index.html — loadMonetagSdk() there was switched
// to load directly from https://libtl.com/sdk.js to A/B test whether this
// proxy technique (serving the SDK same-origin to dodge ad-blockers) was
// getting flagged by Monetag's traffic-quality systems and suppressing CPM.
// Route kept alive and ready — just point s.src back to '/mn-sdk.js' in
// index.html's loadMonetagSdk() to restore ad-blocker resistance if the test
// shows the proxy wasn't actually the cause.
//
// Monetag doesn't offer a signed server-to-server API like HilltopAds does —
// this is a plain reverse-proxy of their static sdk.js file. Same idea though:
// serving it from our own domain means both hostname-based blocklist rules
// AND DNS-level ad-blocking (Private DNS resolvers like AdGuard/NextDNS that
// refuse to resolve libtl.com at all) won't catch this request, since our
// own domain was never on any such blocklist.
// Cached briefly so we're not re-fetching it on every page load, but short
// enough that we pick up any update Monetag pushes to the script fairly soon.
let mnSdkCache = null; // { code, fetchedAt }
const MN_SDK_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

app.get("/mn-sdk.js", async (req, res) => {
  res.set("Content-Type", "application/javascript");
  try {
    if (mnSdkCache && Date.now() - mnSdkCache.fetchedAt < MN_SDK_CACHE_TTL_MS) {
      return res.send(mnSdkCache.code);
    }
    const upstream = await fetch("https://libtl.com/sdk.js");
    const code = await upstream.text();
    if (code) mnSdkCache = { code, fetchedAt: Date.now() };
    res.send(code);
  } catch (err) {
    console.error("Monetag SDK proxy error:", err.message);
    // Fall back to last known-good copy rather than breaking the watch-ad
    // flow entirely if libtl.com is briefly unreachable.
    res.send(mnSdkCache ? mnSdkCache.code : "");
  }
});

app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// ── Bulk sessions ─────────────────────────────────────────────────────────────
const bulkSessions = new Map();
const BULK_TIMEOUT_MS = 5 * 60 * 1000;

// ── Additive per-batch Refer & Unlock flow ───────────────────────────────────
// The existing payment/referral/reward flows remain unchanged. These records
// only power the second "Refer & Unlock" option on locked premium batches.
function getReferralForceJoinChannels() {
  return (process.env.REFERRAL_FORCE_JOIN_CHANNELS || process.env.FORCE_JOIN_CHANNELS || "")
    .split(",").map(s => s.trim()).filter(Boolean);
}

function forceJoinKeyboard(channels) {
  const names = (process.env.FORCE_JOIN_CHANNEL_NAMES || "").split(",").map(s => s.trim());
  const links = (process.env.FORCE_JOIN_CHANNEL_LINKS || "").split(",").map(s => s.trim());
  const rows = channels.map((channel, index) => {
    const link = links[index] || (channel.startsWith("@")
      ? `https://t.me/${channel.slice(1)}`
      : `https://t.me/c/${String(channel).replace(/^-100/, "")}`);
    return [{ text: `➡️ ${names[index] || `Join Channel ${index + 1}`}`, url: link }];
  });
  rows.push([{ text: "✅ I've Joined", callback_data: "batch_ref_verify_join" }]);
  return { inline_keyboard: rows };
}

async function getUnjoinedReferralChannels(userId) {
  const channels = getReferralForceJoinChannels();
  if (!channels.length) return [];
  const unjoined = [];
  for (const channel of channels) {
    try {
      const member = await bot.getChatMember(channel, userId);
      if (!member || ["left", "kicked"].includes(member.status) ||
          (member.status === "restricted" && member.is_member === false)) {
        unjoined.push(channel);
      }
    } catch (e) {
      // A Telegram check failure must not turn into a false referral credit.
      console.warn(`Referral Force Join check failed for ${channel}:`, e.message);
      unjoined.push(channel);
    }
  }
  return unjoined;
}

async function getBatchReferralStatus(userId, batchId) {
  let doc = await BatchReferralUnlock.findOne({ userId: String(userId), batchId: String(batchId) });
  if (!doc) doc = await BatchReferralUnlock.create({ userId: String(userId), batchId: String(batchId) });
  if (doc.unlocked && doc.expiresAt && doc.expiresAt <= new Date()) {
    doc.unlocked = false;
    doc.expiresAt = null;
    doc.validReferrals = [];
    await doc.save();
  }
  setBatchPremiumCache(doc.userId, doc.batchId, doc.unlocked, doc.expiresAt);
  return doc;
}

async function creditValidBatchReferral(pending) {
  if (!pending || pending.counted || !pending.batchId) return;
  const Batch = require("./models/Course");
  const batch = await Batch.findById(pending.batchId)
    .select("name referralsRequired unlockDurationHours")
    .lean();
  if (!batch) {
    pending.counted = true;
    await pending.save();
    return;
  }

  const required = Math.max(1, Number(batch.referralsRequired) || 5);
  const durationHours = Math.max(1, Number(batch.unlockDurationHours) || 168);
  const doc = await getBatchReferralStatus(pending.referrerId, pending.batchId);
  pending.counted = true;
  await pending.save();
  if (doc.unlocked) return;

  if (!doc.validReferrals.includes(pending.referredId)) {
    doc.validReferrals.push(pending.referredId);
  }
  if (doc.validReferrals.length >= required) {
    doc.unlocked = true;
    doc.unlockedAt = new Date();
    doc.expiresAt = new Date(Date.now() + durationHours * 60 * 60 * 1000);
    doc.validReferrals = [];
    await doc.save();
    setBatchPremiumCache(doc.userId, doc.batchId, true, doc.expiresAt);
    await bot.sendMessage(
      Number(pending.referrerId),
      `🎉 <b>Refer & Unlock complete!</b>\n\n<b>${esc(batch.name)}</b> is unlocked for ${durationHours % 24 === 0 ? `${durationHours / 24} days` : `${durationHours} hours`}.`,
      { parse_mode: "HTML" }
    ).catch(() => {});
  } else {
    await doc.save();
    await bot.sendMessage(
      Number(pending.referrerId),
      `🎁 <b>Valid referral added</b>\n\n<b>${esc(batch.name)}</b>: ${doc.validReferrals.length}/${required}`,
      { parse_mode: "HTML" }
    ).catch(() => {});
  }
}

async function verifyBatchReferral(userId) {
  const pending = await PendingReferral.findOne({ referredId: String(userId) });
  if (!pending || pending.counted || pending.referrerId === String(userId)) return;
  pending.forceJoinVerified = true;
  await pending.save();
  await creditValidBatchReferral(pending);
}

async function revokeBatchReferralUnlocks(userId) {
  await BatchReferralUnlock.updateMany(
    { userId: String(userId), unlocked: true },
    { $set: { unlocked: false, expiresAt: null } }
  );
  clearAllBatchPremiumCacheForUser(String(userId));
}

async function deletePendingVideosAfterForceJoinLeave(userId) {
  const pendingVideos = await PendingDelete.find({ chat_id: userId }).lean();
  if (!pendingVideos.length) return 0;
  let deleted = 0;
  for (const pending of pendingVideos) {
    try {
      await deleteMessageWithRetry(bot, userId, pending.message_id);
      deleted++;
    } catch (_) {}
    db.pendingDelete.deleteByChatMsg(userId, pending.message_id);
    PendingDelete.deleteMany({ chat_id: userId, message_id: pending.message_id }).catch(() => {});
  }
  try {
    const notice = await bot.sendMessage(
      userId,
      "⚠️ <b>Video deleted</b>\n\nAapne required Force Join channel/group leave kiya, isliye bot ke bheje hue lecture videos delete kar diye gaye.\n\nLecture dobara lene ke liye required channel/group join karein.",
      { parse_mode: "HTML" }
    );
    await scheduleDelete(bot, userId, notice.message_id, new Date(Date.now() + 6 * 60 * 60 * 1000));
  } catch (_) {}
  return deleted;
}

// ── Bot startup ───────────────────────────────────────────────────────────────
async function startBot() {
  try { await fetch(`https://api.telegram.org/bot${TOKEN}/getUpdates?offset=-1&timeout=0`, { signal: AbortSignal.timeout(10000) }); } catch (_) {}
  console.log("Clearing old polling...");

  for (let attempt=1; attempt<=5; attempt++) {
    try { bot = new TelegramBot(TOKEN, { polling: { interval:2000, autoStart:false, params:{ timeout:30, allowed_updates: JSON.stringify(["message","edited_message","callback_query","chat_member"]) } } }); await bot.getMe(); break; }
    catch (err) { console.error(`Bot init attempt ${attempt} failed`); if(attempt===5) throw err; await wait(5000*attempt); }
  }

  bot.startPolling();
  const me = await bot.getMe();
  BOT_USERNAME = me.username;
  console.log(`Bot started: @${BOT_USERNAME}`);
  courseRoutes.setBot(bot);
  courseRoutes.setGrantAdsFreeAccess(grantAdsFreeAccess);

  try {
    await fetch(`https://api.telegram.org/bot${TOKEN}/setChatMenuButton`, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ menu_button:{ type:"web_app", text:"Open StuBot", web_app:{ url:WEB_URL } } }) });
    console.log("Menu button set:", WEB_URL);
  } catch (_) {}

  await recoverPendingDeletes(bot);
  await recoverPendingUndelivers();

  // ── /start ────────────────────────────────────────────────────────────────
  bot.onText(/^\/start(?:\s+(.*))?$/, async (msg, match) => {
    if (isGroupChat(msg)) return;
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const param = (match[1] || "").trim();
    const isNewUser = userId ? !db.user.findOne(String(userId)) : false;

    // Banned users get a short refusal and nothing else — no lecture delivery,
    // no referral/giveaway processing. Owner can never be banned by this check
    // since isOwner() is excluded below.
    if (userId && !isOwner(userId) && db.bannedUser.isBanned(String(userId))) {
      return bot.sendMessage(chatId, `🚫 You have been banned from using this bot.\n\nContact the admin if you think this is a mistake.`);
    }

    if (userId) {
      db.user.upsert({ userId: String(userId), firstName: msg.from.first_name||"", lastName: msg.from.last_name||"", username: msg.from.username||"", firstSeen: new Date(), lastSeen: new Date() });
      User.findOneAndUpdate({ userId: String(userId) }, { userId: String(userId), firstName: msg.from.first_name||"", lastName: msg.from.last_name||"", username: msg.from.username||"", lastSeen: new Date() }, { upsert: true }).catch(() => {});
    }

    if (param) {
      const batchReferralMatch = param.match(/^ref_([^_]+)_([A-Za-z0-9_-]+)$/);
      if (batchReferralMatch) {
        const referrerId = batchReferralMatch[1];
        const batchId = batchReferralMatch[2];
        if (referrerId && referrerId !== String(userId) && isNewUser) {
          try {
            await PendingReferral.create({
              referrerId: String(referrerId),
              referredId: String(userId),
              batchId: String(batchId),
            });
          } catch (_) {
            // The unique referredId index makes repeated starts idempotent.
          }
        }

        const unjoined = await getUnjoinedReferralChannels(userId);
        if (unjoined.length) {
          return bot.sendMessage(
            chatId,
            `👋 Hello ${msg.from.first_name}!\n\nRequired channel/group join karke neeche <b>I've Joined</b> dabayein. Referral verify hone ke baad unlock progress me count hoga.`,
            { parse_mode: "HTML", reply_markup: forceJoinKeyboard(unjoined) }
          );
        }
        await verifyBatchReferral(userId);
        return bot.sendMessage(chatId, `👋 Hello ${msg.from.first_name}!\n\nTap below to browse all lectures! 📚`, {
          reply_markup: { inline_keyboard: [[{ text: "📚 Browse Lectures", web_app: { url: WEB_URL } }]] }
        });
      }

      if (param.startsWith("ref_")) {
        const referrerId = param.replace("ref_","");
        bot.sendMessage(chatId, `👋 Hello ${msg.from.first_name}!\n\nTap below to browse all lectures! 📚`, { reply_markup:{ inline_keyboard:[[{ text:"📚 Browse Lectures", web_app:{ url:WEB_URL } }]] } });
        if (referrerId && referrerId !== String(userId)) {
          try {
            const r = await fetch(`http://localhost:${PORT}/api/refer/record`, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ referrerId, referredId: String(userId), isNewUser }) });
            const d = await r.json();
            if (d.isNew) {
              const s = await (await fetch(`http://localhost:${PORT}/api/refer/stats/${referrerId}`)).json();
              bot.sendMessage(parseInt(referrerId), `🎉 <b>New Referral!</b>\n\n${msg.from.first_name} joined using your link!\n⭐ <b>+5 Points!</b> Total: <b>${s.points}</b>`, { parse_mode:"HTML" }).catch(() => {});
            }
          } catch (_) {}
        }
        return;
      }

      if (param.startsWith("give_")) {
        const inviterId = param.replace("give_","");
        bot.sendMessage(chatId, `👋 Hello ${msg.from.first_name}!\n\nTap below to browse all lectures! 📚`, { reply_markup:{ inline_keyboard:[[{ text:"📚 Browse Lectures", web_app:{ url:WEB_URL } }]] } });
        if (inviterId && inviterId !== String(userId)) {
          try {
            const giveaway = await getActiveGiveaway();
            if (giveaway && isNewUser) {
              const inviterNum = parseInt(inviterId, 10);
              const isParticipant = await GiveawayParticipant.findOne({ giveawayId: giveaway._id, userId: inviterNum });
              // Only counts if the inviter is an actual participant, and only ONE invite
              // record can ever exist per invitee (unique index) — no double counting.
              // It stays "pending" here; it only turns into a real point once this user
              // watches their first lecture (see routes/course.js) — this is what filters
              // out fake/inactive "joins" from actually counting toward the giveaway.
              if (isParticipant) {
                try {
                  await GiveawayInvite.create({ giveawayId: giveaway._id, inviterId: inviterNum, inviteeId: userId, status: "pending" });
                  bot.sendMessage(inviterNum, `📥 <b>New Referral Received</b>\n\n${msg.from.first_name} has joined using your giveaway invite link.\nThis referral will be confirmed and added to your count once they watch their first lecture.`, { parse_mode:"HTML" }).catch(() => {});
                } catch (dupErr) { /* already invited via this or another link — ignored, unique index blocks it */ }
              }
            }
          } catch (_) {}
        }
        return;
      }

      if (param === "participate") {
        try {
          const giveaway = await getActiveGiveaway();
          if (!giveaway) { bot.sendMessage(chatId, `⚠️ No giveaway is active right now.`); return; }
          const inviteLink = `https://t.me/${BOT_USERNAME}?start=give_${userId}`;
          let participant = await GiveawayParticipant.findOne({ giveawayId: giveaway._id, userId });
          if (!participant) {
            participant = await GiveawayParticipant.create({ giveawayId: giveaway._id, userId, firstName: msg.from.first_name||"", username: msg.from.username||"" });
          }
          const { rank } = await giveawayRankOf(giveaway._id, userId);
          const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(inviteLink)}&text=${encodeURIComponent("Join the giveaway and win prizes! 🎁")}`;
          const text = `✅ <b>You Have Successfully Joined the Giveaway</b>\n\n<b>Your Invite Link:</b>\n<code>${inviteLink}</code>\n\nConfirmed Invites: <b>${participant.invites}</b>   |   Current Rank: <b>#${rank}</b>\n\n` + giveawayRulesText();
          bot.sendMessage(chatId, text, { parse_mode:"HTML", reply_markup:{ inline_keyboard:[[{ text:"📤 Share Invite Link", url: shareUrl }]] } });
        } catch (err) { console.error("participate deep-link error:", err.message); bot.sendMessage(chatId, `❌ Could not join giveaway.`); }
        return;
      }

      if (param.startsWith("buy_")) {
        bot.sendMessage(chatId, `💳 <b>Complete your payment in the app!</b>`, { parse_mode:"HTML", reply_markup:{ inline_keyboard:[[{ text:"💳 Pay Now", web_app:{ url:WEB_URL } }]] } });
        return;
      }

      if (param.startsWith("B")) {
        try {
          const batch = db.bulkBatch.findByCode(param);
          if (!batch) return bot.sendMessage(chatId, `File not found. Link may be invalid.`);
          let hasVideo = false, failedCount = 0, limitBlockedCount = 0, totalEvicted = 0;
          for (const f of batch.files) {
            const isVideoFile = f.file_type==="video"||f.file_type==="video_note";
            // Same daily cap enforced on the single-file path below — this loop
            // was missing it entirely, letting a batch of N videos bypass the
            // per-day limit completely regardless of N. Non-owner + video only;
            // non-video files in the batch are unaffected, same as single-file.
            // Reserve BEFORE sending (atomic, no await gap) so parallel requests
            // can't all pass the check before any of them commit — see
            // tryReserveVideoSlot() for why.
            let reserved = false;
            if (isVideoFile && !isOwner(userId)) {
              const limCheck = tryReserveVideoSlot(userId);
              if (!limCheck.allowed) { limitBlockedCount++; continue; }
              reserved = true;
            }
            let sentMsg;
            try {
              sentMsg = await sendFile(bot, chatId, f);
            } catch (fileErr) {
              // One broken file (dead file_id + no channel copy to fall back on) must
              // not abort the whole batch — skip it and keep sending the rest.
              if (reserved) releaseVideoSlot(userId); // give the slot back, delivery never happened
              failedCount++;
              continue;
            }
            if (isVideoFile && sentMsg) {
              hasVideo=true;
              totalEvicted += await scheduleDelete(bot,chatId,sentMsg.message_id,new Date(Date.now()+6*60*60*1000));
            }
            if (sentMsg) logLectureActivity(bot, msg.from, { file_type: f.file_type, file_name: f.file_name, code: param });
          }
          if (hasVideo) {
            var noticeLines = [`⚠️ Videos will auto-delete after 6 hours.`];
            var ev = evictionNotice(totalEvicted);
            if (ev) noticeLines.push("", ev);
            await bot.sendMessage(chatId, noticeLines.join("\n"));
          }
          if (failedCount > 0) await bot.sendMessage(chatId, `⚠️ ${failedCount} file(s) in this batch couldn't be delivered (owner needs to re-upload them).`);
          if (limitBlockedCount > 0) await bot.sendMessage(chatId, `🚫 <b>Daily limit reached!</b>\n\n${limitBlockedCount} video(s) in this batch weren't sent — you've hit your <b>${DAILY_VIDEO_LIMIT} videos/day</b> limit.\n📅 Resets at midnight.`, { parse_mode:"HTML" });
          return;
        } catch (err) { return bot.sendMessage(chatId, `Error occurred. Please try again.`); }
      }

      // Single file
      try {
        const record = db.fileRecord.findByCode(param);
        if (!record) return bot.sendMessage(chatId, `File not found. Link may be invalid.`);
        const isVideo = record.file_type==="video"||record.file_type==="video_note";
        if (isVideo && db.fileRecord.isDeliveryActive(record.id, chatId, 6*60*60*1000)) return bot.sendMessage(chatId, `⚠️ This video was already delivered. You can request it again after 6 hours.`);
        if (isVideo && !isOwner(userId)) {
          const limCheck = tryReserveVideoSlot(userId);
          if (!limCheck.allowed) return bot.sendMessage(chatId, `🚫 <b>Daily limit reached!</b>\n\nYou've watched <b>${DAILY_VIDEO_LIMIT} videos</b> today.\n📅 Resets at midnight.`, { parse_mode:"HTML" });
          let sentMsg;
          try {
            sentMsg = await sendFile(bot, chatId, record);
          } catch (err) {
            releaseVideoSlot(userId); // delivery failed — give the reserved slot back
            throw err;
          }
          const lim = limCheck;
          const evicted = await scheduleDelete(bot,chatId,sentMsg.message_id,new Date(Date.now()+6*60*60*1000));
          db.fileRecord.addDeliveredTo(record.id,chatId);
          FileRecord.updateOne({ code:record.code },{ $addToSet:{ delivered_to:chatId } }).catch(() => {});
          stampMongoDeliveredAt(record.id, chatId, Date.now());
          await scheduleUndeliver(record.id, record.code, chatId, new Date(Date.now()+6*60*60*1000));
          checkSuspiciousActivity(bot, msg.from, record.code);
          logLectureActivity(bot, msg.from, record, { todayUsed: lim.used });
          const lines=[`⚠️ This video auto-deletes in 6 hours.`,``,`📊 <b>Today:</b> ${lim.used}/${DAILY_VIDEO_LIMIT} videos`];
          if(lim.remaining===0) lines.push(`🚫 Limit reached for today!`);
          else if(lim.remaining<=3) lines.push(`⚠️ Only <b>${lim.remaining}</b> left today!`);
          const evictionMsg = evictionNotice(evicted);
          if (evictionMsg) lines.push(``, evictionMsg);
          await bot.sendMessage(chatId, lines.join("\n"), { parse_mode:"HTML" });
          return;
        }
        const sentMsg = await sendFile(bot, chatId, record);
        logLectureActivity(bot, msg.from, record, null);
        if (isVideo) {
          const evicted = await scheduleDelete(bot,chatId,sentMsg.message_id,new Date(Date.now()+6*60*60*1000));
          db.fileRecord.addDeliveredTo(record.id,chatId);
          FileRecord.updateOne({ code:record.code },{ $addToSet:{ delivered_to:chatId } }).catch(() => {});
          stampMongoDeliveredAt(record.id, chatId, Date.now());
          await scheduleUndeliver(record.id, record.code, chatId, new Date(Date.now()+6*60*60*1000));
          var ownerLines = [`⚠️ This video auto-deletes in 6 hours.`];
          var ownerEvictionMsg = evictionNotice(evicted);
          if (ownerEvictionMsg) ownerLines.push(``, ownerEvictionMsg);
          await bot.sendMessage(chatId, ownerLines.join("\n"));
        }
      } catch (err) { console.error("Deep link error:", err.message); bot.sendMessage(chatId, `Error occurred. Please try again.`); }
      return;
    }

    const referLink = userId ? `https://t.me/${BOT_USERNAME}?start=ref_${userId}` : "";

    // ── Giveaway banner: shown to everyone while a giveaway is live.
    // While a user is an active-giveaway participant, their normal referral
    // link is hidden and replaced by the giveaway link, so they don't manage
    // two links at once. This reverts automatically once the giveaway ends
    // (isParticipating becomes false the moment there's no active giveaway),
    // no separate "restore" step needed.
    let giveawayBanner = "", giveawayShareUrl = "", isParticipating = false;
    try {
      const activeGiveaway = await getActiveGiveaway();
      if (activeGiveaway) {
        const participant = userId ? await GiveawayParticipant.findOne({ giveawayId: activeGiveaway._id, userId }) : null;
        if (participant) {
          isParticipating = true;
          const { rank } = await giveawayRankOf(activeGiveaway._id, userId);
          const giveLink = `https://t.me/${BOT_USERNAME}?start=give_${userId}`;
          giveawayShareUrl = `https://t.me/share/url?url=${encodeURIComponent(giveLink)}&text=${encodeURIComponent("Join the giveaway and win prizes! 🎁")}`;
          giveawayBanner = `\n\n🎁 <b>Giveaway in Progress</b>\nConfirmed Invites: <b>${participant.invites}</b>   |   Current Rank: <b>#${rank}</b>\n\n<b>Your Invite Link:</b>\n<code>${giveLink}</code>\n\nTrack your progress: /scoreboard · /myscore`;
        } else {
          giveawayBanner = `\n\n🎁 <b>A Giveaway Is Currently Running</b>\nJoin now with /participate to receive your personal invite link and compete for rewards.`;
        }
      }
    } catch (_) {}

    const referLinkLine = isParticipating ? "" : `\n\n🔗 <b>Your Invite Link:</b> (tap to copy)\n<code>${referLink}</code>`;
    const welcomeText = (isOwner(userId)
      ? `👋 Hello Admin!\n\nTap below to browse lectures! 📚\n\n📁 File Store:\n/bulk — bulk upload\n/myfiles — view files\n/delete &lt;code&gt; — delete file\n/rmword 'word' — remove word from names\n/cancel — cancel bulk\n\n📡 Broadcast:\n/broadcast &lt;text&gt; or reply to media${referLinkLine}`
      : `👋 Hello ${msg.from.first_name}!\n\nTap below to browse all lectures! 📚${referLinkLine}${isParticipating ? "" : "\n\nShare karo aur har referral pe <b>5 points</b> kamao! 🎁"}`) + giveawayBanner;
    const shareUrl = (!isParticipating && referLink) ? `https://t.me/share/url?url=${encodeURIComponent(referLink)}&text=${encodeURIComponent("Join and get free lectures! 📚")}` : "";
    const startButtons = [[{ text:"📚 Browse Lectures", web_app:{ url:WEB_URL } }]];
    if (shareUrl) startButtons.push([{ text:"📤 Share & Earn Points", url: shareUrl }]);
    if (giveawayShareUrl) startButtons.push([{ text:"🎁 Share Giveaway Link", url: giveawayShareUrl }]);
    bot.sendMessage(chatId, welcomeText, { parse_mode:"HTML", reply_markup:{ inline_keyboard: startButtons } });
  });

  // ── /admin ────────────────────────────────────────────────────────────────
  // Owner-only reference — lists every admin command, grouped by category, with
  // a one-line description and its arguments. Kept in plain (arg) placeholder
  // style rather than <arg> — this message uses parse_mode HTML, and literal
  // angle brackets get parsed as (invalid) HTML tags and silently fail to send.
  bot.onText(/\/admin/, async (msg) => {
    if(isGroupChat(msg)||!isOwner(msg.from?.id)) return;
    const chatId=msg.chat.id;
    const text =
`⚙️ <b>Admin Commands</b>

<b>📁 File Management</b>
• /bulk — Start bulk upload mode (forward multiple files, then /done)
• /done — Finish and save the current bulk upload session
• /cancel — Cancel the current bulk upload session
• /myfiles — List all files you've uploaded, with codes
• /delete (code) — Delete a file or batch by its code
• /migrate — Migrate files from the old storage channel
• /sync — Sync SQLite and MongoDB data

<b>👤 User Management</b>
• /ban (userId) [reason] — Ban a user (also deletes all their pending DM videos immediately)
• /unban (userId) — Remove a user's ban
• /banned — List all currently banned users
• /resetlimit (userId) — Reset a user's daily video-watch limit

<b>⚠️ Suspicious Activity Detection</b>
• /suspiciousrules — List active detection rules
• /addsuspiciousrule (count) (minutes) — Add a rule, e.g. "5 lectures in 30 min"
• /delsuspiciousrule (number) — Remove a rule by its listed number
• /resetsuspiciousrules — Reset rules to the default (3 in 5 min)

<b>🎯 Points &amp; Rewards</b>
• /addpoints (points) (userId) — Manually add or deduct points (negative = deduct)
• /setspinlimit (count) — Change the GLOBAL daily spin limit for all users
• /addspins (count) (userId) — Adjust one specific user's daily spin limit on top of the global default
• /points — View points/leaderboard summary

<b>📢 Broadcast</b>
• /broadcast (message) — Send a message to every user
   Flags: --pin (pin it), --f (forward instead of copy)

<b>🎁 Giveaway</b>
• /startgiveaway — Launch a new giveaway
• /endgiveaway — Conclude the active giveaway

<b>✨ Ads-Free Plan</b>
• /setadsfreeprice (weekly|monthly) (price) — Change the live price, no restart needed
• /setadsfreeprice — Show current weekly/monthly prices
• /giveadsfree (days) (userId) — Manually grant/revoke Ads-Free days (negative = revoke)
• /adsfreeusers — List all active subscribers with time remaining

<b>🛠 Maintenance Mode</b>
• /maintenance — Show current status + allowed test users
• /maintenance on / off — Toggle the full-screen maintenance gate for everyone except you
• /maintenanceallow (userId) — Let a user use the app while maintenance is on
• /maintenanceblock (userId) — Remove that user's access

<b>📊 System</b>
• /stats — View bot usage stats
• /rmword (word) — Add a word to the auto-filter blocklist
• /rmword list — Show all blocked words
• /exemptads (userId) [note] — Let a user bypass the ad-blocker gate
• /unexemptads (userId) — Remove that exemption
• /exemptadslist — List everyone exempt from the ad-blocker gate
• /admin — Show this list`;
    bot.sendMessage(chatId, text, { parse_mode:"HTML" });
  });

  // ── /bulk ─────────────────────────────────────────────────────────────────
  bot.onText(/\/bulk/, async (msg) => {
    if (isGroupChat(msg)||!isOwner(msg.from?.id)) return;
    const chatId=msg.chat.id; const userId=msg.from.id;
    if (bulkSessions.has(userId)) return bot.sendMessage(chatId, `⚠️ Bulk mode already active! Use /done or /cancel.`);
    const timer = setTimeout(async () => { if(bulkSessions.has(userId)){bulkSessions.delete(userId);try{await bot.sendMessage(chatId,`⏰ Bulk session timed out. Use /bulk to start again.`);}catch(_){}} }, BULK_TIMEOUT_MS);
    bulkSessions.set(userId, { files:[], chatId, timer });
    bot.sendMessage(chatId, `📦 Bulk mode ON!\n\nSend files one by one, then /done for a single link!\n\n❌ Cancel: /cancel`);
  });

  // ── /done ─────────────────────────────────────────────────────────────────
  bot.onText(/\/done/, async (msg) => {
    if (isGroupChat(msg)||!isOwner(msg.from?.id)) return;
    const chatId=msg.chat.id; const userId=msg.from.id;
    const session=bulkSessions.get(userId);
    if (!session) return bot.sendMessage(chatId, `No active bulk session. Use /bulk to start.`);
    if (session.files.length===0) return bot.sendMessage(chatId, `⚠️ No files yet! Send files first.`);
    clearTimeout(session.timer); bulkSessions.delete(userId);
    const processing=await bot.sendMessage(chatId,`⏳ Saving batch...`);
    try {
      const batchCode=getUniqueBatchCode();
      const storedFiles=[];
      for (const f of session.files) storedFiles.push(await saveToStorageChannel(bot,f));
      const id=db.generateId();
      db.bulkBatch.create({ id, batch_code:batchCode, user_id:userId, files:storedFiles });
      BulkBatch.create({ batch_code:batchCode, user_id:userId, files:storedFiles }).catch(() => {});
      const link=`https://t.me/${BOT_USERNAME}?start=${batchCode}`;
      await bot.deleteMessage(chatId,processing.message_id);
      const fileList=session.files.map((f,i)=>`${i+1}. ${f.file_name}`).join("\n");
      await bot.sendMessage(chatId, `✅ Batch ready! ${session.files.length} files.\n\n📋 Files:\n${fileList}\n\n🔗 Link:\n<code>${link}</code>`, { parse_mode:"HTML", reply_markup:{ inline_keyboard:[[{ text:"📥 Get Files", url:link }]] } });
    } catch (err) { console.error("Batch save error:",err.message); try{await bot.editMessageText(`Batch save failed. Try again.`,{chat_id:chatId,message_id:processing.message_id});}catch(_){} }
  });

  // ── /cancel ───────────────────────────────────────────────────────────────
  bot.onText(/\/cancel/, async (msg) => {
    if (isGroupChat(msg)||!isOwner(msg.from?.id)) return;
    const chatId=msg.chat.id; const userId=msg.from.id;
    const session=bulkSessions.get(userId);
    if (!session) return bot.sendMessage(chatId,`No active bulk session.`);
    clearTimeout(session.timer); bulkSessions.delete(userId);
    bot.sendMessage(chatId,`❌ Bulk session cancelled.${session.files.length>0?` (${session.files.length} files discarded)`:""}`);
  });

  // ── /myfiles ──────────────────────────────────────────────────────────────
  const PAGE_SIZE=10;
  async function sendMyFilesPage(chatId,userId,page,editMsgId=null) {
    try {
      const allFiles=db.fileRecord.findByUploader(userId);
      const allBatches=db.bulkBatch.findByUser(userId);
      const totalItems=allFiles.length+allBatches.length;
      if (!totalItems) return bot.sendMessage(chatId,`No files or batches uploaded yet.`);
      const totalPages=Math.ceil(totalItems/PAGE_SIZE);
      page=Math.max(0,Math.min(page,totalPages-1));
      const combined=[...allFiles.map(f=>({type:"file",data:f,created_at:f.created_at})),...allBatches.map(b=>({type:"batch",data:b,created_at:b.created_at}))].sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
      const items=combined.slice(page*PAGE_SIZE,(page+1)*PAGE_SIZE);
      const emoji={document:"📄",photo:"🖼️",video:"🎬",audio:"🎵",voice:"🎤",video_note:"📹"};
      let text=`📂 My Files — Page ${page+1}/${totalPages} (${totalItems} total)\n\n`;
      items.forEach((item,i) => {
        const n=page*PAGE_SIZE+i+1;
        if(item.type==="file"){const f=item.data;text+=`${n}. ${emoji[f.file_type]||"📎"} ${f.file_name}\nhttps://t.me/${BOT_USERNAME}?start=${f.code}\n\n`;}
        else{const b=item.data;text+=`${n}. 📦 Batch (${b.files.length} files)\nhttps://t.me/${BOT_USERNAME}?start=${b.batch_code}\n\n`;}
      });
      const buttons=[];
      if(page>0) buttons.push({text:"⬅️ Prev",callback_data:`myfiles_page_${page-1}`});
      if(page<totalPages-1) buttons.push({text:"Next ➡️",callback_data:`myfiles_page_${page+1}`});
      const rm=buttons.length?{inline_keyboard:[buttons]}:undefined;
      if(editMsgId) await bot.editMessageText(text,{chat_id:chatId,message_id:editMsgId,disable_web_page_preview:true,reply_markup:rm});
      else await bot.sendMessage(chatId,text,{disable_web_page_preview:true,reply_markup:rm});
    } catch(err){console.error("myfiles error:",err.message);bot.sendMessage(chatId,`Error occurred.`);}
  }
  bot.onText(/\/myfiles/, async (msg) => { if(isGroupChat(msg)||!isOwner(msg.from?.id)) return; await sendMyFilesPage(msg.chat.id,msg.from.id,0); });

  // ── Callback queries ──────────────────────────────────────────────────────
  bot.on("callback_query", async (query) => {
    const userId=query.from?.id; const data=query.data||""; const chatId=query.message?.chat?.id; const msgId=query.message?.message_id;
    if (data.startsWith("pay_approve_")||data.startsWith("pay_reject_")) {
      if (!isOwner(userId)) return bot.answerCallbackQuery(query.id,{text:"❌ Not authorized"});
      const isApprove=data.startsWith("pay_approve_");
      const parts=data.replace("pay_approve_","").replace("pay_reject_","").split("_");
      const batchId=parts[0]; const targetUserId=parts[1];
      if (isApprove) {
        try {
          const batch = await grantBatchAccess(batchId, targetUserId);
          bot.sendMessage(parseInt(targetUserId),`✅ <b>Payment Approved!</b>\n\nAccess to <b>${esc(batch?.name||"the batch")}</b> unlocked! 🚀`,{parse_mode:"HTML",reply_markup:{inline_keyboard:[[{text:"📚 Open App",web_app:{url:WEB_URL}}]]}}).catch(()=>{});
          await bot.editMessageCaption(`${query.message.caption||""}\n\n✅ <b>APPROVED</b> by ${esc(query.from.first_name||"Admin")}`,{chat_id:chatId,message_id:msgId,parse_mode:"HTML",reply_markup:{inline_keyboard:[]}}).catch(()=>bot.editMessageText(`${query.message.text||""}\n\n✅ <b>APPROVED</b>`,{chat_id:chatId,message_id:msgId,parse_mode:"HTML",reply_markup:{inline_keyboard:[]}}).catch(()=>{}));
          await bot.answerCallbackQuery(query.id,{text:"✅ Approved!"});
        } catch(err){await bot.answerCallbackQuery(query.id,{text:"❌ Error: "+err.message});}
      } else {
        bot.sendMessage(parseInt(targetUserId),`❌ <b>Payment Rejected</b>\n\nPlease contact support.`,{parse_mode:"HTML"}).catch(()=>{});
        await bot.editMessageCaption(`${query.message.caption||""}\n\n❌ <b>REJECTED</b>`,{chat_id:chatId,message_id:msgId,parse_mode:"HTML",reply_markup:{inline_keyboard:[]}}).catch(()=>bot.editMessageText(`${query.message.text||""}\n\n❌ <b>REJECTED</b>`,{chat_id:chatId,message_id:msgId,parse_mode:"HTML",reply_markup:{inline_keyboard:[]}}).catch(()=>{}));
        await bot.answerCallbackQuery(query.id,{text:"❌ Rejected"});
      }
      return;
    }
    if (data === "batch_ref_verify_join") {
      const unjoined = await getUnjoinedReferralChannels(userId);
      if (unjoined.length) {
        await bot.answerCallbackQuery(query.id, { text: "❌ Pehle sab required channels/groups join karein.", show_alert: true });
        return bot.editMessageReplyMarkup(forceJoinKeyboard(unjoined), { chat_id: chatId, message_id: msgId }).catch(() => {});
      }
      await verifyBatchReferral(userId);
      await bot.answerCallbackQuery(query.id, { text: "✅ Referral verified!" });
      return bot.editMessageText(
        "✅ Force Join verified — referral count ho gaya.\n\nTap below to browse lectures! 📚",
        { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: "📚 Browse Lectures", web_app: { url: WEB_URL } }]] } }
      ).catch(() => {});
    }
    if(query.message&&isGroupChat(query.message)) return bot.answerCallbackQuery(query.id);
    if(!isOwner(userId)) return bot.answerCallbackQuery(query.id);
    if(data.startsWith("myfiles_page_")){const page=parseInt(data.replace("myfiles_page_",""),10);await sendMyFilesPage(query.message.chat.id,userId,page,msgId);await bot.answerCallbackQuery(query.id);}
    if(data.startsWith("ban_")){
      const targetId=data.replace("ban_","");
      try {
        db.bannedUser.ban({ userId: targetId, reason: "Suspicious activity (3+ lecture requests within 5 min)", bannedBy: String(userId) });
        const deletedCount = await deleteAllPendingVideosForUser(bot, parseInt(targetId,10));
        const baseText = query.message?.text || "";
        await bot.editMessageText(`${baseText}\n\n🚫 <b>BANNED</b> by ${esc(query.from.first_name||"Admin")}\n🗑️ ${deletedCount} video(s) deleted from their DM`, { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: [] } }).catch(() => {});
        await bot.answerCallbackQuery(query.id,{text:"🚫 User banned"});
        bot.sendMessage(parseInt(targetId,10), `🚫 You have been banned from using this bot.\n\nContact the admin if you think this is a mistake.`).catch(() => {});
      } catch(err){ await bot.answerCallbackQuery(query.id,{text:"❌ Error: "+err.message}); }
    }
  });

  // ── /delete ───────────────────────────────────────────────────────────────
  bot.onText(/\/delete (.+)/, async (msg,match) => {
    if(isGroupChat(msg)||!isOwner(msg.from?.id)) return;
    const chatId=msg.chat.id; const code=match[1].trim();
    try {
      if(db.fileRecord.deleteByCode(code,msg.from.id)){FileRecord.deleteOne({code:{$regex:new RegExp(`^${code}$`,"i")},uploaded_by:msg.from.id}).catch(()=>{});return bot.sendMessage(chatId,`✅ File deleted!`);}
      if(db.bulkBatch.deleteByCode(code,msg.from.id)){BulkBatch.deleteOne({batch_code:{$regex:new RegExp(`^${code}$`,"i")},user_id:msg.from.id}).catch(()=>{});return bot.sendMessage(chatId,`✅ Batch deleted!`);}
      bot.sendMessage(chatId,`Code not found.`);
    } catch(_){bot.sendMessage(chatId,`Deletion failed.`);}
  });

  // ── /ban <userId> [reason] ───────────────────────────────────────────────
  bot.onText(/\/ban (.+)/, async (msg,match) => {
    if(isGroupChat(msg)||!isOwner(msg.from?.id)) return;
    const chatId=msg.chat.id;
    const parts=match[1].trim().split(/\s+/);
    const targetId=parts.shift();
    const reason=parts.join(" ");
    if(!targetId||isNaN(parseInt(targetId,10))) return bot.sendMessage(chatId,`Usage: /ban <userId> [reason]`);
    try {
      db.bannedUser.ban({ userId: targetId, reason, bannedBy: String(msg.from.id) });
      const deletedCount = await deleteAllPendingVideosForUser(bot, parseInt(targetId,10));
      bot.sendMessage(chatId,`🚫 User <code>${targetId}</code> has been banned.${reason?`\nReason: ${esc(reason)}`:""}\n🗑️ ${deletedCount} video(s) deleted from their DM`,{parse_mode:"HTML"});
    } catch(err){ console.error("ban error:",err.message); bot.sendMessage(chatId,`❌ Could not ban user.`); }
  });

  // ── /unban <userId> ──────────────────────────────────────────────────────
  bot.onText(/\/unban (.+)/, async (msg,match) => {
    if(isGroupChat(msg)||!isOwner(msg.from?.id)) return;
    const chatId=msg.chat.id;
    const targetId=match[1].trim();
    try {
      const removed=db.bannedUser.unban(targetId);
      bot.sendMessage(chatId, removed ? `✅ User <code>${targetId}</code> has been unbanned.` : `User <code>${targetId}</code> was not banned.`, {parse_mode:"HTML"});
    } catch(err){ console.error("unban error:",err.message); bot.sendMessage(chatId,`❌ Could not unban user.`); }
  });

  // ── /banned ───────────────────────────────────────────────────────────────
  bot.onText(/\/banned/, async (msg) => {
    if(isGroupChat(msg)||!isOwner(msg.from?.id)) return;
    const chatId=msg.chat.id;
    try {
      const list=db.bannedUser.listAll();
      if(!list.length) return bot.sendMessage(chatId,`No banned users.`);
      const text=`🚫 <b>Banned Users</b> (${list.length})\n\n`+list.map(b=>`• <code>${b.userId}</code>${b.reason?` — ${esc(b.reason)}`:""} (${formatIST(b.bannedAt)})`).join("\n");
      bot.sendMessage(chatId,text,{parse_mode:"HTML"});
    } catch(err){ console.error("banned list error:",err.message); bot.sendMessage(chatId,`❌ Could not load banned users.`); }
  });

  // ── Ad-blocker gate exemption list ──────────────────────────────────────────
  // /exemptads <userId> [note]  — let this user bypass the ad-blocker hard-block gate
  // /unexemptads <userId>       — remove that exemption
  // /exemptadslist              — list everyone currently exempt
  bot.onText(/\/exemptads (.+)/, async (msg,match) => {
    if(isGroupChat(msg)||!isOwner(msg.from?.id)) return;
    const chatId=msg.chat.id;
    const parts=match[1].trim().split(/\s+/);
    const targetId=parts.shift();
    const note=parts.join(" ");
    if(!targetId||isNaN(parseInt(targetId,10))) return bot.sendMessage(chatId,`Usage: /exemptads <userId> [note]`);
    try {
      db.adblockExempt.add({ userId: targetId, note, addedBy: String(msg.from.id) });
      bot.sendMessage(chatId,`✅ User <code>${targetId}</code> can now bypass the ad-blocker gate.${note?`\nNote: ${esc(note)}`:""}`,{parse_mode:"HTML"});
    } catch(err){ console.error("exemptads error:",err.message); bot.sendMessage(chatId,`❌ Could not add exemption.`); }
  });

  bot.onText(/\/unexemptads (.+)/, async (msg,match) => {
    if(isGroupChat(msg)||!isOwner(msg.from?.id)) return;
    const chatId=msg.chat.id;
    const targetId=match[1].trim();
    try {
      const removed=db.adblockExempt.remove(targetId);
      bot.sendMessage(chatId, removed ? `✅ Removed ad-blocker exemption for <code>${targetId}</code>.` : `User <code>${targetId}</code> wasn't exempt.`, {parse_mode:"HTML"});
    } catch(err){ console.error("unexemptads error:",err.message); bot.sendMessage(chatId,`❌ Could not remove exemption.`); }
  });

  bot.onText(/\/exemptadslist/, async (msg) => {
    if(isGroupChat(msg)||!isOwner(msg.from?.id)) return;
    const chatId=msg.chat.id;
    try {
      const list=db.adblockExempt.listAll();
      if(!list.length) return bot.sendMessage(chatId,`No one is exempt from the ad-blocker gate (besides you).`);
      const text=`🛡️ <b>Ad-Blocker Gate Exemptions</b> (${list.length})\n\n`+list.map(e=>`• <code>${e.userId}</code>${e.note?` — ${esc(e.note)}`:""} (${formatIST(e.addedAt)})`).join("\n");
      bot.sendMessage(chatId,text,{parse_mode:"HTML"});
    } catch(err){ console.error("exemptadslist error:",err.message); bot.sendMessage(chatId,`❌ Could not load exemption list.`); }
  });

  // ── Suspicious-activity rules ────────────────────────────────────────────
  // /suspiciousrules              — list current rules with their index
  // /addsuspiciousrule <count> <minutes> — add a new rule, e.g. "5 lectures in 30 min"
  // /delsuspiciousrule <index>    — remove a rule by its listed number
  // /resetsuspiciousrules         — restore the single default rule (3 in 5 min)
  bot.onText(/\/suspiciousrules/, async (msg) => {
    if(isGroupChat(msg)||!isOwner(msg.from?.id)) return;
    const chatId=msg.chat.id;
    try {
      const rules=getSuspiciousRules();
      const text=`⚙️ <b>Suspicious Activity Rules</b>\n\n`+
        rules.map((r,i)=>`${i+1}. ${r.count}+ lectures within ${r.windowMinutes} minute(s)`).join("\n")+
        `\n\nAdd: /addsuspiciousrule (count) (minutes)\nRemove: /delsuspiciousrule (number)\nReset: /resetsuspiciousrules`;
      bot.sendMessage(chatId,text,{parse_mode:"HTML"});
    } catch(err){ console.error("suspiciousrules error:",err.message); bot.sendMessage(chatId,`❌ Could not load rules.`); }
  });

  bot.onText(/\/addsuspiciousrule (.+)/, async (msg,match) => {
    if(isGroupChat(msg)||!isOwner(msg.from?.id)) return;
    const chatId=msg.chat.id;
    const parts=match[1].trim().split(/\s+/);
    const count=parseInt(parts[0],10); const windowMinutes=parseInt(parts[1],10);
    if(!count||count<1||!windowMinutes||windowMinutes<1) return bot.sendMessage(chatId,`Usage: /addsuspiciousrule (count) (minutes)\ne.g. /addsuspiciousrule 5 30`);
    try {
      const rules=getSuspiciousRules().slice();
      rules.push({ count, windowMinutes });
      db.settings.set('suspicious_rules', rules);
      bot.sendMessage(chatId,`✅ Rule added: <b>${count}+</b> lectures within <b>${windowMinutes}</b> minute(s).\n\nUse /suspiciousrules to see all rules.`,{parse_mode:"HTML"});
    } catch(err){ console.error("addsuspiciousrule error:",err.message); bot.sendMessage(chatId,`❌ Could not add rule.`); }
  });

  bot.onText(/\/delsuspiciousrule (.+)/, async (msg,match) => {
    if(isGroupChat(msg)||!isOwner(msg.from?.id)) return;
    const chatId=msg.chat.id;
    const idx=parseInt(match[1].trim(),10)-1;
    try {
      const rules=getSuspiciousRules().slice();
      if(isNaN(idx)||idx<0||idx>=rules.length) return bot.sendMessage(chatId,`Invalid rule number. Use /suspiciousrules to see valid numbers.`);
      if(rules.length===1) return bot.sendMessage(chatId,`⚠️ Can't remove the last remaining rule. Add a new one first, or use /resetsuspiciousrules.`);
      const removed=rules.splice(idx,1)[0];
      db.settings.set('suspicious_rules', rules);
      bot.sendMessage(chatId,`🗑️ Removed rule: ${removed.count}+ lectures within ${removed.windowMinutes} minute(s).`);
    } catch(err){ console.error("delsuspiciousrule error:",err.message); bot.sendMessage(chatId,`❌ Could not remove rule.`); }
  });

  bot.onText(/\/resetsuspiciousrules/, async (msg) => {
    if(isGroupChat(msg)||!isOwner(msg.from?.id)) return;
    const chatId=msg.chat.id;
    try {
      db.settings.set('suspicious_rules', DEFAULT_SUSPICIOUS_RULES);
      bot.sendMessage(chatId,`✅ Rules reset to default: ${DEFAULT_SUSPICIOUS_RULES[0].count}+ lectures within ${DEFAULT_SUSPICIOUS_RULES[0].windowMinutes} minute(s).`);
    } catch(err){ console.error("resetsuspiciousrules error:",err.message); bot.sendMessage(chatId,`❌ Could not reset rules.`); }
  });

  // ── /resetlimit <userId> ─────────────────────────────────────────────────
  // Owner-only: manually clears a user's daily video-watch count back to 0
  // for today, e.g. to compensate a user hit by a failed delivery, or as a
  // one-off courtesy reset — without waiting for the midnight IST rollover.
  bot.onText(/\/resetlimit (.+)/, async (msg,match) => {
    if(isGroupChat(msg)||!isOwner(msg.from?.id)) return;
    const chatId=msg.chat.id;
    const targetId=parseInt(match[1].trim(),10);
    if(!targetId||isNaN(targetId)) return bot.sendMessage(chatId,`Usage: /resetlimit <userId>`);
    try {
      const today=getTodayIST();
      db.dailyVideoLimit.upsert({ userId: targetId, count: 0, resetDate: today });
      DailyVideoLimit.findOneAndUpdate({ userId: targetId }, { userId: targetId, count: 0, resetDate: today }, { upsert: true }).catch(()=>{});
      bot.sendMessage(chatId,`✅ Daily video limit reset for user <code>${targetId}</code>.`, { parse_mode:"HTML" });
    } catch(_){ bot.sendMessage(chatId,`Reset failed.`); }
  });

  // ── /rmword ───────────────────────────────────────────────────────────────
  bot.onText(/\/rmword(.*)/, async (msg,match) => {
    if(isGroupChat(msg)||!isOwner(msg.from?.id)) return;
    const chatId=msg.chat.id; const arg=(match[1]||"").trim();
    if(arg.toLowerCase()==="list") return bot.sendMessage(chatId,rmWords.length?`📋 Words:\n${rmWords.map((w,i)=>`${i+1}. <code>${esc(w)}</code>`).join("\n")}`:`No words in list.`,{parse_mode:"HTML"});
    if(arg.toLowerCase()==="clear"){const c=rmWords.length;rmWords=[];return bot.sendMessage(chatId,`🗑️ Cleared ${c} word(s).`);}
    const quoted=arg.match(/^['"'](.+?)['"']$/)||arg.match(/^'(.+?)'$/)||arg.match(/^"(.+?)"$/);
    const word=quoted?quoted[1].trim():arg.replace(/^['"']|['"']$/g,"").trim();
    if(!word) return bot.sendMessage(chatId,`Usage: /rmword 'word' | list | clear`,{parse_mode:"HTML"});
    const wl=word.toLowerCase();
    if(rmWords.includes(wl)) return bot.sendMessage(chatId,`⚠️ Already in list.`);
    rmWords.push(wl);
    bot.sendMessage(chatId,`✅ Added <code>${esc(word)}</code>. Total: ${rmWords.length}`,{parse_mode:"HTML"});
  });

  // ── /migrate ──────────────────────────────────────────────────────────────
  // Fixes files saved by an old bot token: a Telegram file_id only works for the
  // bot that issued it, so after switching bots, sendFile()'s primary path fails
  // and falls back to copyMessage from the storage channel — which shows the
  // channel's original caption instead of the correct file_name. This command
  // re-forwards every stored file from the storage channel (which the CURRENT
  // bot can access), grabs a fresh valid file_id, and updates the DB in place.
  // The original file_name already stored in the DB is preserved — only file_id
  // is replaced — so nothing about naming needs to be re-typed.
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  let migrateRunning = false;

  bot.onText(/\/migrate/, async (msg) => {
    if (isGroupChat(msg) || !isOwner(msg.from?.id)) return;
    const chatId = msg.chat.id;
    if (!STORAGE_CHANNEL_ID) return bot.sendMessage(chatId, `⚠️ STORAGE_CHANNEL_ID not set — nothing to migrate from.`);
    if (migrateRunning) return bot.sendMessage(chatId, `⚠️ A migration is already running.`);
    migrateRunning = true;

    try {
      const singleFiles = db.fileRecord.findAllWithChannelMsg();
      const batches = db.bulkBatch.findAll();
      const batchJobs = [];
      const noBackupCodes = []; // files with NO channel_msg_id — can't be auto-fixed, must be re-uploaded
      for (const b of batches) {
        b.files.forEach((f, idx) => {
          if (f.channel_msg_id) batchJobs.push({ batch: b, idx });
          else noBackupCodes.push(`${b.batch_code} (file ${idx + 1})`);
        });
      }
      const total = singleFiles.length + batchJobs.length;
      if (!total && !noBackupCodes.length) return bot.sendMessage(chatId, `Nothing to migrate.`);
      if (!total) {
        return bot.sendMessage(chatId, `⚠️ No files have a channel_msg_id to migrate from.\n\nThese ${noBackupCodes.length} file(s) have no channel backup at all and must be re-uploaded:\n${noBackupCodes.slice(0, 30).map(esc).join(", ")}${noBackupCodes.length > 30 ? "…" : ""}`, { parse_mode: "HTML" });
      }

      const status = await bot.sendMessage(chatId, `🔄 Migrating 0/${total}...`);
      let done = 0, fixed = 0, failed = 0;
      const failedCodes = [];

      const migrateOne = async (channelMsgId) => {
        // Forward → new valid file_id for THIS bot, then clean up the forwarded copy.
        const fwd = await bot.forwardMessage(chatId, STORAGE_CHANNEL_ID, channelMsgId);
        const info = extractFileInfo(fwd);
        bot.deleteMessage(chatId, fwd.message_id).catch(() => {});
        if (!info) throw new Error("no file in forwarded message");
        return info.file_id;
      };

      for (const rec of singleFiles) {
        try {
          const file_id = await migrateOne(rec.channel_msg_id);
          db.fileRecord.updateFileId(rec.id, { file_id });
          FileRecord.updateOne({ code: rec.code }, { file_id }).catch(() => {});
          fixed++;
        } catch (err) { failed++; failedCodes.push(rec.code); }
        done++;
        if (done % 20 === 0 || done === total) {
          bot.editMessageText(`🔄 Migrating ${done}/${total}... (✅ ${fixed} 🚫 ${failed})`, { chat_id: chatId, message_id: status.message_id }).catch(() => {});
        }
        await sleep(300); // stay well under Telegram's flood limits
      }

      for (const { batch, idx } of batchJobs) {
        try {
          const file_id = await migrateOne(batch.files[idx].channel_msg_id);
          batch.files[idx].file_id = file_id;
          db.bulkBatch.updateFiles(batch.id, batch.files);
          BulkBatch.updateOne({ batch_code: batch.batch_code }, { files: batch.files }).catch(() => {});
          fixed++;
        } catch (err) { failed++; failedCodes.push(batch.batch_code); }
        done++;
        if (done % 20 === 0 || done === total) {
          bot.editMessageText(`🔄 Migrating ${done}/${total}... (✅ ${fixed} 🚫 ${failed})`, { chat_id: chatId, message_id: status.message_id }).catch(() => {});
        }
        await sleep(300);
      }

      let summary = `✅ <b>Migration done!</b>\n\n📦 Total: ${total}\n✅ Fixed: ${fixed}\n🚫 Failed: ${failed}`;
      if (failedCodes.length) summary += `\n\n⚠️ Failed codes (message likely deleted from channel):\n${failedCodes.slice(0, 30).map(esc).join(", ")}${failedCodes.length > 30 ? "…" : ""}`;
      if (noBackupCodes.length) summary += `\n\n📛 No channel backup at all (re-upload needed):\n${noBackupCodes.slice(0, 30).map(esc).join(", ")}${noBackupCodes.length > 30 ? "…" : ""}`;
      await bot.sendMessage(chatId, summary, { parse_mode: "HTML" });
    } catch (err) {
      console.error("Migrate error:", err.message);
      bot.sendMessage(chatId, `❌ Migration failed: ${esc(err.message)}`, { parse_mode: "HTML" });
    } finally {
      migrateRunning = false;
    }
  });

  let syncRunning = false;
  bot.onText(/\/sync/, async (msg) => {
    if (isGroupChat(msg) || !isOwner(msg.from?.id)) return;
    const chatId = msg.chat.id;
    if (syncRunning) return bot.sendMessage(chatId, `⚠️ A sync is already running.`);
    syncRunning = true;
    const status = await bot.sendMessage(chatId, `🔄 Syncing SQLite → MongoDB…`);
    try {
      const summary = await db.syncToMongo(mongoose, courseRoutes.getPointsBreakdown);
      const labels = {
        batches: '📚 Batches', users: '👤 Users', announcements: '📢 Announcements',
        access: '🔓 Access grants', referrals: '🔗 Referrals', coupons: '🎟️ Coupons',
        autoLecSession: '⚙️ Auto-lecture session', fileRecords: '📎 File records',
        bulkBatches: '📦 Bulk batches', dailyVideoLimits: '📺 Daily video limits',
        rewardRedemptions: '🎁 Reward redemptions', batchRewardAccess: '⏳ Batch reward access',
        spinHistory: '🎡 Spin history', watchedLectures: '👁️ Watched lectures',
        pointAdjustments: '⭐ Manual point adjustments',
      };
      let text = `✅ <b>Sync complete</b>\n\n`;
      let hadError = false;
      for (const key of Object.keys(labels)) {
        const val = summary[key];
        if (val === undefined) continue;
        if (val === 'error') { text += `${labels[key]}: ⚠️ failed (check server logs)\n`; hadError = true; }
        else text += `${labels[key]}: ${val}\n`;
      }
      text += `\n<i>👤 Users includes a fresh points-balance snapshot on each Mongo doc (points, pointsBreakdown, pointsSyncedAt).</i>`;
      if (summary.totalPoints !== undefined) {
        text += `\n\n⭐ <b>Total Points (all users):</b> ${summary.totalPoints} <i>(${summary.usersWithPoints} users have points > 0)</i>`;
      }
      text += `\n<i>Skipped: pending deletes/undelivers and spin tokens — these are short-lived job markers, not data worth backing up.</i>`;
      if (hadError) text += `\n\n⚠️ Some tables had errors — check server logs for details.`;
      await bot.editMessageText(text, { chat_id: chatId, message_id: status.message_id, parse_mode: "HTML" });
    } catch (err) {
      console.error("Sync error:", err.message);
      bot.editMessageText(`❌ Sync failed: ${esc(err.message)}`, { chat_id: chatId, message_id: status.message_id, parse_mode: "HTML" }).catch(() => {});
    } finally {
      syncRunning = false;
    }
  });

  bot.onText(/\/addpoints(?:\s+(-?\d+)\s+(\S+))?/, async (msg, match) => {
    if (isGroupChat(msg) || !isOwner(msg.from?.id)) return;
    const chatId = msg.chat.id;
    const points = match[1] ? parseInt(match[1], 10) : NaN;
    const userId = match[2];
    if (!userId || isNaN(points) || points === 0) {
      return bot.sendMessage(chatId, `Usage: <code>/addpoints &lt;points&gt; &lt;user_id&gt;</code>\ne.g. <code>/addpoints 20 123456789</code>\n\nUse a negative number to deduct points, e.g. <code>/addpoints -10 123456789</code>.`, { parse_mode: "HTML" });
    }
    try {
      const u = db.user.findOne(userId);
      if (!u) return bot.sendMessage(chatId, `⚠️ No user found with ID <code>${esc(userId)}</code> (they must have started the bot at least once).`, { parse_mode: "HTML" });

      const record = { id: db.generateId(), userId: String(userId), points, note: `Manual ${points > 0 ? 'grant' : 'deduction'} by admin`, createdAt: new Date() };
      db.pointAdjustment.insert(record); // SQLite first (source of truth)
      mongoose.model("PointAdjustment").create(record).catch(() => {}); // Mongo backup, fire-and-forget

      const { points: newBalance } = courseRoutes.getPointsBreakdown(String(userId));
      const displayName = [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || 'Unknown';
      const usernameStr = u.username ? ` (@${u.username})` : '';
      await bot.sendMessage(chatId,
        `✅ ${points > 0 ? 'Added' : 'Deducted'} <b>${Math.abs(points)}</b> point${Math.abs(points)===1?'':'s'} ${points > 0 ? 'to' : 'from'} ${esc(displayName)}${esc(usernameStr)}\n` +
        `🆔 <code>${esc(userId)}</code>\n` +
        `⭐ New balance: <b>${newBalance}</b> points`,
        { parse_mode: "HTML" });
    } catch (err) {
      console.error("addpoints error:", err.message);
      bot.sendMessage(chatId, `❌ Failed: ${esc(err.message)}`, { parse_mode: "HTML" }).catch(() => {});
    }
  });

  bot.onText(/\/addspins(?:\s+(-?\d+)\s+(\S+))?/, async (msg, match) => {
    if (isGroupChat(msg) || !isOwner(msg.from?.id)) return;
    const chatId = msg.chat.id;
    const delta = match[1] ? parseInt(match[1], 10) : NaN;
    const userId = match[2];
    if (!userId || isNaN(delta) || delta === 0) {
      return bot.sendMessage(chatId, `Usage: <code>/addspins &lt;count&gt; &lt;user_id&gt;</code>\ne.g. <code>/addspins 3 123456789</code>\n\nUse a negative number to reduce their daily limit, e.g. <code>/addspins -2 123456789</code>.\n\nThis permanently changes their daily spin limit (on top of the default) until adjusted again.`, { parse_mode: "HTML" });
    }
    try {
      const u = db.user.findOne(userId);
      if (!u) return bot.sendMessage(chatId, `⚠️ No user found with ID <code>${esc(userId)}</code> (they must have started the bot at least once).`, { parse_mode: "HTML" });

      const record = { id: db.generateId(), userId: String(userId), delta, note: `Manual ${delta > 0 ? 'increase' : 'decrease'} by admin`, createdAt: new Date() };
      db.spinAdjustment.insert(record); // SQLite first (source of truth)
      mongoose.model("SpinAdjustment").create(record).catch(() => {}); // Mongo backup, fire-and-forget

      const newStatus = courseRoutes.getSpinStatus(String(userId));
      const displayName = [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || 'Unknown';
      const usernameStr = u.username ? ` (@${u.username})` : '';
      await bot.sendMessage(chatId,
        `✅ ${delta > 0 ? 'Increased' : 'Decreased'} daily spin limit by <b>${Math.abs(delta)}</b> for ${esc(displayName)}${esc(usernameStr)}\n` +
        `🆔 <code>${esc(userId)}</code>\n` +
        `🎯 New daily limit: <b>${newStatus.maxSpins}</b> (${newStatus.spinsLeft} left today)`,
        { parse_mode: "HTML" });
    } catch (err) {
      console.error("addspins error:", err.message);
      bot.sendMessage(chatId, `❌ Failed: ${esc(err.message)}`, { parse_mode: "HTML" }).catch(() => {});
    }
  });

  // ── /setspinlimit <count> ────────────────────────────────────────────────
  // Changes the GLOBAL default daily spin limit for every user (not one
  // specific person — see /addspins for that). Persisted in bot_settings, so
  // it survives restarts. Per-user /addspins adjustments still stack on top
  // of whatever this global default is.
  bot.onText(/\/setspinlimit(?:\s+(\d+))?/, async (msg, match) => {
    if (isGroupChat(msg) || !isOwner(msg.from?.id)) return;
    const chatId = msg.chat.id;
    const count = match[1] ? parseInt(match[1], 10) : NaN;
    if (isNaN(count) || count < 0) {
      const current = courseRoutes.getSpinDailyLimit();
      return bot.sendMessage(chatId, `Current global daily spin limit: <b>${current}</b>\n\nUsage: <code>/setspinlimit &lt;count&gt;</code>\ne.g. <code>/setspinlimit 8</code>\n\nThis changes the default for ALL users. To adjust just one person on top of this, use /addspins instead.`, { parse_mode: "HTML" });
    }
    try {
      db.settings.set('spin_daily_limit', count);
      await bot.sendMessage(chatId, `✅ Global daily spin limit set to <b>${count}</b> for all users.\n\nUsers with a personal /addspins adjustment will still get that on top of this new number.`, { parse_mode: "HTML" });
    } catch (err) {
      console.error("setspinlimit error:", err.message);
      bot.sendMessage(chatId, `❌ Failed: ${esc(err.message)}`, { parse_mode: "HTML" }).catch(() => {});
    }
  });

  // ── /setadsfreeprice <weekly|monthly> <price> ───────────────────────────
  // Changes the Ads-Free plan price at runtime — no .env edit / redeploy
  // needed. Persisted in bot_settings (same mechanism as /setspinlimit above),
  // and getAdsFreePlans() reads it fresh on every call, so it takes effect on
  // the very next purchase attempt.
  bot.onText(/\/setadsfreeprice(?:\s+(\S+))?(?:\s+(\d+(?:\.\d+)?))?/, async (msg, match) => {
    if (isGroupChat(msg) || !isOwner(msg.from?.id)) return;
    const chatId = msg.chat.id;
    const planArg = (match[1] || "").toLowerCase();
    const price = match[2] ? Number(match[2]) : NaN;
    const plans = getAdsFreePlans();
    if (!["weekly", "monthly"].includes(planArg) || isNaN(price) || price <= 0) {
      return bot.sendMessage(chatId,
        `Current Ads-Free prices:\n` +
        `📅 Weekly: <b>₹${plans.ADSFREEWEEKLY.price}</b>\n` +
        `🗓 Monthly: <b>₹${plans.ADSFREEPLAN.price}</b>\n\n` +
        `Usage: <code>/setadsfreeprice weekly &lt;price&gt;</code>\n` +
        `or: <code>/setadsfreeprice monthly &lt;price&gt;</code>\n` +
        `e.g. <code>/setadsfreeprice weekly 25</code>`,
        { parse_mode: "HTML" });
    }
    const settingsKey = planArg === "weekly" ? ADS_FREE_PLAN_META.ADSFREEWEEKLY.settingsKey : ADS_FREE_PLAN_META.ADSFREEPLAN.settingsKey;
    try {
      db.settings.set(settingsKey, price);
      await bot.sendMessage(chatId, `✅ Ads-Free <b>${planArg}</b> price set to <b>₹${price}</b>. Takes effect immediately — no restart needed.`, { parse_mode: "HTML" });
    } catch (err) {
      console.error("setadsfreeprice error:", err.message);
      bot.sendMessage(chatId, `❌ Failed: ${esc(err.message)}`, { parse_mode: "HTML" }).catch(() => {});
    }
  });

  // ── /giveadsfree <days> <user_id> ────────────────────────────────────────
  // Manually grants (or revokes, with a negative number) Ads-Free days to one
  // user — for comps, support gestures, referral prizes, etc., completely
  // outside the payment flow. Stacks on top of any existing remaining time,
  // same as a real purchase (see grantAdsFreeAccess).
  bot.onText(/\/giveadsfree(?:\s+(-?\d+)\s+(\S+))?/, async (msg, match) => {
    if (isGroupChat(msg) || !isOwner(msg.from?.id)) return;
    const chatId = msg.chat.id;
    const days = match[1] ? parseInt(match[1], 10) : NaN;
    const userId = match[2];
    if (!userId || isNaN(days) || days === 0) {
      return bot.sendMessage(chatId, `Usage: <code>/giveadsfree &lt;days&gt; &lt;user_id&gt;</code>\ne.g. <code>/giveadsfree 30 123456789</code> (1 month free)\ne.g. <code>/giveadsfree 7 123456789</code> (1 week free)\n\nUse a negative number to revoke/reduce, e.g. <code>/giveadsfree -30 123456789</code>. This stacks on top of any time they already have (from a real purchase or an earlier grant), exactly like a normal renewal.`, { parse_mode: "HTML" });
    }
    try {
      const u = db.user.findOne(userId);
      if (!u) return bot.sendMessage(chatId, `⚠️ No user found with ID <code>${esc(userId)}</code> (they must have started the bot at least once).`, { parse_mode: "HTML" });

      const expiresAt = await grantAdsFreeAccess(userId, days);
      const displayName = [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || 'Unknown';
      const usernameStr = u.username ? ` (@${u.username})` : '';
      const active = expiresAt > new Date();
      await bot.sendMessage(chatId,
        `✅ ${days > 0 ? 'Granted' : 'Reduced'} <b>${Math.abs(days)}</b> Ads-Free day(s) for ${esc(displayName)}${esc(usernameStr)}\n` +
        `🆔 <code>${esc(userId)}</code>\n` +
        (active ? `📅 Ads-Free until: <b>${esc(expiresAt.toLocaleDateString("en-IN"))}</b>` : `🔴 Ads-Free access ended (no time remaining).`),
        { parse_mode: "HTML" });
      bot.sendMessage(parseInt(userId),
        days > 0
          ? `🎉 <b>Ads-Free access gifted!</b>\n\nAap ke liye ${days} din ka ads-free access on kar diya gaya hai. Ab koi ads nahi dikhenge — enjoy! 🚀`
          : `ℹ️ Aapka Ads-Free access update kiya gaya hai.`,
        { parse_mode: "HTML" }).catch(() => {});
    } catch (err) {
      console.error("giveadsfree error:", err.message);
      bot.sendMessage(chatId, `❌ Failed: ${esc(err.message)}`, { parse_mode: "HTML" }).catch(() => {});
    }
  });

  // ── /adsfreeusers ─────────────────────────────────────────────────────────
  // Lists everyone with a currently-active Ads-Free subscription, soonest-
  // expiring first, with how much time each has left — a quick way to see who
  // to nudge about renewing before they're locked out again.
  bot.onText(/\/adsfreeusers/, async (msg) => {
    if (isGroupChat(msg) || !isOwner(msg.from?.id)) return;
    const chatId = msg.chat.id;
    try {
      const active = db.adsFree.getAllActive();
      if (!active.length) return bot.sendMessage(chatId, `📭 Koi bhi Ads-Free subscriber active nahi hai abhi.`);

      const fmtRemaining = (ms) => {
        const totalHours = Math.floor(ms / (60 * 60 * 1000));
        const days = Math.floor(totalHours / 24);
        const hours = totalHours % 24;
        if (days === 0) return `${hours}h`;
        return `${days}d ${hours}h`;
      };

      const now = Date.now();
      const lines = active.map((row, i) => {
        const u = db.user.findOne(row.userId);
        const name = u ? [u.firstName, u.lastName].filter(Boolean).join(' ').trim() : 'Unknown';
        const usernameStr = u && u.username ? ` (@${esc(u.username)})` : '';
        const remaining = fmtRemaining(row.expiresAt - now);
        const expDate = new Date(row.expiresAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
        return `${i + 1}. ${esc(name)}${usernameStr}\n   🆔 <code>${esc(row.userId)}</code> — ⏳ <b>${remaining}</b> left (till ${expDate})`;
      });

      await bot.sendMessage(chatId, `✨ <b>Active Ads-Free Subscribers (${active.length})</b>`, { parse_mode: "HTML" });
      // Telegram caps messages at 4096 chars — chunk into batches of 25 lines
      // so a large subscriber list never gets silently truncated or rejected.
      const CHUNK = 25;
      for (let i = 0; i < lines.length; i += CHUNK) {
        await bot.sendMessage(chatId, lines.slice(i, i + CHUNK).join("\n\n"), { parse_mode: "HTML" });
      }
    } catch (err) {
      console.error("adsfreeusers error:", err.message);
      bot.sendMessage(chatId, `❌ Failed: ${esc(err.message)}`, { parse_mode: "HTML" }).catch(() => {});
    }
  });

  // ── Maintenance Mode ─────────────────────────────────────────────────────
  // Off by default. When on, every user sees the full-screen maintenance gate
  // (index.html #maintenanceGate) EXCEPT the owner (always bypasses) and
  // anyone on the allowlist below — lets the owner test the live app while
  // it's "down" for everyone else. Toggled instantly, no restart needed.
  bot.onText(/\/maintenance(?!allow|block)(?:\s+(on|off))?/, async (msg, match) => {
    if (isGroupChat(msg) || !isOwner(msg.from?.id)) return;
    const chatId = msg.chat.id;
    const action = match[1];
    if (!action) {
      const active = !!db.settings.get("maintenance_mode", false);
      const allowed = db.settings.get("maintenance_allowlist", []);
      return bot.sendMessage(chatId,
        `🛠 Maintenance mode: ${active ? "🔴 <b>ON</b>" : "🟢 <b>OFF</b>"}\n` +
        `👥 Allowed test users: ${allowed.length ? allowed.map(id => `<code>${esc(id)}</code>`).join(", ") : "none"}\n\n` +
        `Usage:\n` +
        `<code>/maintenance on</code> — turn on\n` +
        `<code>/maintenance off</code> — turn off\n` +
        `<code>/maintenanceallow &lt;user_id&gt;</code> — let a user test while it's on\n` +
        `<code>/maintenanceblock &lt;user_id&gt;</code> — remove that access`,
        { parse_mode: "HTML" });
    }
    db.settings.set("maintenance_mode", action === "on");
    await bot.sendMessage(chatId, action === "on"
      ? `🔴 Maintenance mode is now <b>ON</b>. Everyone except you and the allowlist will see the maintenance screen.`
      : `🟢 Maintenance mode is now <b>OFF</b>. The app is back for everyone.`,
      { parse_mode: "HTML" });
  });

  bot.onText(/\/maintenance(allow|block)(?:\s+(\S+))?/, async (msg, match) => {
    if (isGroupChat(msg) || !isOwner(msg.from?.id)) return;
    const chatId = msg.chat.id;
    const isAllow = match[1] === "allow";
    const userId = match[2];
    if (!userId) return bot.sendMessage(chatId, `Usage: <code>/maintenance${match[1]} &lt;user_id&gt;</code>`, { parse_mode: "HTML" });
    let allowed = db.settings.get("maintenance_allowlist", []);
    if (isAllow) {
      if (!allowed.includes(userId)) allowed.push(userId);
    } else {
      allowed = allowed.filter(id => id !== userId);
    }
    db.settings.set("maintenance_allowlist", allowed);
    await bot.sendMessage(chatId,
      isAllow
        ? `✅ <code>${esc(userId)}</code> can now use the app during maintenance.`
        : `✅ <code>${esc(userId)}</code> removed — they'll see the maintenance screen like everyone else now.`,
      { parse_mode: "HTML" });
  });

  bot.onText(/\/points/, async (msg) => {
    if (isGroupChat(msg) || !isOwner(msg.from?.id)) return;
    const chatId = msg.chat.id;
    try {
      const users = db.user.listAll();
      if (!users.length) return bot.sendMessage(chatId, `No users found yet.`);

      const rows = users
        .map(u => {
          const b = courseRoutes.getPointsBreakdown(u.userId);
          const displayName = [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || 'Unknown';
          return {
            userId: u.userId, name: displayName, username: u.username || null,
            points: b.points, referrals: b.referrals, spinEarned: b.spinEarned,
            adjustment: b.adjustment, spent: b.spent,
          };
        })
        .filter(r => r.points > 0) // skip users sitting at 0 — nothing to show for them
        .sort((a, b) => b.points - a.points);

      if (!rows.length) return bot.sendMessage(chatId, `No users have any points yet (everyone's at 0).`);

      const totalPoints = rows.reduce((s, r) => s + r.points, 0);
      const payload = { generatedAt: new Date().toISOString(), userCount: rows.length, totalPoints, users: rows };
      const buffer = Buffer.from(JSON.stringify(payload, null, 2), "utf-8");

      await bot.sendDocument(chatId, buffer, {
        caption: `⭐ ${rows.length} user${rows.length===1?'':'s'} with points (${totalPoints} total)`,
      }, {
        filename: `points_${new Date().toISOString().slice(0,10)}.json`,
        contentType: "application/json",
      });
    } catch (err) {
      console.error("points list error:", err.message);
      bot.sendMessage(chatId, `❌ Failed: ${esc(err.message)}`, { parse_mode: "HTML" }).catch(() => {});
    }
  });
  const TG_LINK_RE=/https?:\/\/t\.me\/(c\/(\d+)|([a-zA-Z][a-zA-Z0-9_]{3,}))\/(\d+)/;

  // Shared by both auto-save entry points (t.me-link forward and direct
  // upload). Auto-save now creates lecture entries only; PDF files are ignored
  // by the callers and are never attached as lecture notes.
  async function handleAutoLectureFile(bot, chatId, stored, code, link) {
    const lNum = autoLectureSession.lectureCount + 1; const lName = `Lecture ${lNum}`;
    await autoAddLecture({ batchId: autoLectureSession.batchId, subjectId: autoLectureSession.subjectId, chapterId: autoLectureSession.chapterId, unitId: autoLectureSession.unitId, name: lName, link: code });
    autoLectureSession.lectureCount = lNum; courseRoutes.saveAutoSession && courseRoutes.saveAutoSession();
    const loc = autoLectureSession.unitName ? `${autoLectureSession.subjectName} › ${autoLectureSession.chapterName} › ${autoLectureSession.unitName}` : `${autoLectureSession.subjectName} › ${autoLectureSession.chapterName}`;
    await bot.sendMessage(chatId, `✅ <b>Auto-Saved!</b>\n📖 <b>${lName}</b>\n📁 ${stored.file_name}\n📍 ${loc}\n🔗 <code>${link}</code>\n\n📨 Send the next lecture for <b>Lecture ${lNum + 1}</b>`, { parse_mode: "HTML" });
  }

  function isPdfFile(fileInfo) {
    if (!fileInfo) return false;
    const name = String(fileInfo.file_name || "").toLowerCase();
    const mime = String(fileInfo.mime_type || "").toLowerCase();
    return fileInfo.file_type === "document" && (mime === "application/pdf" || name.endsWith(".pdf"));
  }

  const fileQueues=new Map();
  function enqueueFile(userId,task){const prev=fileQueues.get(userId)||Promise.resolve();const next=prev.then(task).catch(()=>{});fileQueues.set(userId,next);next.finally(()=>{if(fileQueues.get(userId)===next)fileQueues.delete(userId);});}

  bot.onText(TG_LINK_RE, (msg,match) => {
    if(isGroupChat(msg)||!isOwner(msg.from?.id)) return;
    enqueueFile(msg.from.id, async () => {
      const chatId=msg.chat.id; const userId=msg.from.id;
      const isPrivate=!!match[2]; const rawId=match[2]; const username=match[3]; const messageId=parseInt(match[4],10);
      const fromChatId=isPrivate?parseInt(`-100${rawId}`,10):`@${username}`;
      const processing=await bot.sendMessage(chatId,`⏳ Fetching file...`);
      try {
        const forwarded=await bot.forwardMessage(chatId,fromChatId,messageId);
        const fileInfo=extractFileInfo(forwarded);
        if(!fileInfo){await bot.deleteMessage(chatId,forwarded.message_id).catch(()=>{});return bot.editMessageText(`⚠️ No file found in that message.`,{chat_id:chatId,message_id:processing.message_id});}
        await bot.deleteMessage(chatId,forwarded.message_id).catch(()=>{});
        if(autoLectureSession&&autoLectureSession.active&&isPdfFile(fileInfo)){
          return bot.editMessageText(`📄 PDF ignored in Auto Mode. Send the next lecture for Lecture ${autoLectureSession.lectureCount + 1}.`,{chat_id:chatId,message_id:processing.message_id});
        }
        const session=bulkSessions.get(userId);
        if(session){session.files.push(fileInfo);return bot.editMessageText(`✅ File ${session.files.length} added: ${fileInfo.file_name}\n📦 Total: ${session.files.length}\n\nSend more or /done`,{chat_id:chatId,message_id:processing.message_id});}
        const stored=await saveToStorageChannel(bot,fileInfo); stored.file_name=cleanFileName(stored.file_name);
        const code=getUniqueCode(); const id=db.generateId();
        db.fileRecord.create({id,code,file_id:stored.file_id,file_type:stored.file_type,file_name:stored.file_name,uploaded_by:userId,channel_msg_id:stored.channel_msg_id||null});
        FileRecord.create({code,file_id:stored.file_id,file_type:stored.file_type,file_name:stored.file_name,uploaded_by:userId,expires_at:null,channel_msg_id:stored.channel_msg_id||null}).catch(()=>{});
        const link=`https://t.me/${BOT_USERNAME}?start=${code}`;
        await bot.deleteMessage(chatId,processing.message_id);
        if(autoLectureSession&&autoLectureSession.active){
          try{
            await handleAutoLectureFile(bot, chatId, stored, code, link);
          }catch(err){await bot.sendMessage(chatId,`⚠️ File saved but auto-lecture failed: ${err.message}\n🔗 <code>${link}</code>`,{parse_mode:"HTML"});}
        } else {
          await bot.sendMessage(chatId,`✅ ${stored.file_name}\n\n🔗 Link:\n<code>${link}</code>`,{parse_mode:"HTML",reply_markup:{inline_keyboard:[[{text:"📥 File Lo",url:link}]]}});
        }
      } catch(err){
        const errText=err.message.includes("chat not found")||err.message.includes("CHAT_ADMIN_REQUIRED")?`❌ Bot is not a member of that group/channel.`:err.message.includes("MESSAGE_ID_INVALID")?`❌ Message not found.`:err.message.includes("PEER_ID_INVALID")?`❌ Cannot access this channel.`:`❌ Error: ${err.message}`;
        try{await bot.editMessageText(errText,{chat_id:chatId,message_id:processing.message_id});}catch(_){bot.sendMessage(chatId,errText);}
      }
    });
  });

  // ── Giveaway: force-join leave detection ────────────────────────────────────
  // Requires the bot to be an admin of the FORCE_JOIN_CHANNELS so Telegram
  // delivers chat_member updates for them (enabled via allowed_updates above).
  bot.on("chat_member", async (update) => {
    try {
      const chatId = String(update.chat.id);
      const forceJoinIds = [...new Set([
        ...getReferralForceJoinChannels(),
        ...(process.env.FORCE_JOIN_CHANNELS || "").split(",").map(s => s.trim()).filter(Boolean),
      ])];
      console.log(`[chat_member] chat=${chatId} user=${update.new_chat_member?.user?.id} ${update.old_chat_member?.status}→${update.new_chat_member?.status} | watching:[${forceJoinIds.join(",")}]`);
      if (!forceJoinIds.includes(chatId)) return;
      const oldStatus = update.old_chat_member?.status;
      const newStatus = update.new_chat_member?.status;
      const wasIn = ["member","administrator","creator"].includes(oldStatus);
      const nowOut = ["left","kicked"].includes(newStatus);
      if (!(wasIn && nowOut)) return;
      const inviteeNum = update.new_chat_member.user.id;

      // This is intentionally independent of EduBot's existing giveaway
      // reversal. Leaving Force Join revokes additive batch unlocks and
      // removes active lecture videos already delivered to the user's DM.
      await revokeBatchReferralUnlocks(inviteeNum).catch((err) => console.error("Referral unlock revoke error:", err.message));
      await deletePendingVideosAfterForceJoinLeave(inviteeNum).catch((err) => console.error("Force Join video deletion error:", err.message));

      const giveaway = await getActiveGiveaway();
      if (!giveaway) return;
      const invite = await GiveawayInvite.findOne({ giveawayId: giveaway._id, inviteeId: inviteeNum, status: "confirmed" });
      if (!invite) return; // this user's invite was never confirmed (or already reversed) — nothing to undo
      invite.status = "reversed"; invite.reversedAt = new Date(); await invite.save();
      const participant = await GiveawayParticipant.findOneAndUpdate(
        { giveawayId: giveaway._id, userId: invite.inviterId, invites: { $gt: 0 } },
        { $inc: { invites: -1 } },
        { new: true }
      );
      const newCount = participant ? participant.invites : 0;
      const inviteeUser = await User.findOne({ userId: String(inviteeNum) }).catch(() => null);
      const inviteeName = inviteeUser ? (inviteeUser.username ? `@${inviteeUser.username}` : (inviteeUser.firstName||`User ${inviteeNum}`)) : `User ${inviteeNum}`;
      bot.sendMessage(invite.inviterId, `⚠️ <b>Referral Update</b>\n\n${inviteeName} has left the required channel/group, so this referral has been removed from your count.\nUpdated Confirmed Invites: <b>${newCount}</b>`, { parse_mode:"HTML" }).catch(() => {});
      if (OWNER_ID) {
        const inviterUser = await User.findOne({ userId: String(invite.inviterId) }).catch(() => null);
        const inviterName = inviterUser ? (inviterUser.username ? `@${inviterUser.username}` : (inviterUser.firstName||`User ${invite.inviterId}`)) : `User ${invite.inviterId}`;
        bot.sendMessage(OWNER_ID, `📉 <b>Giveaway — Referral Reversed</b>\n\nInvitee: ${inviteeName} (<code>${inviteeNum}</code>) left a required channel/group.\nInviter: ${inviterName} (<code>${invite.inviterId}</code>)\nInviter's updated invite count: <b>${newCount}</b>`, { parse_mode:"HTML" }).catch(() => {});
      }
    } catch (err) { console.error("chat_member giveaway-reversal error:", err.message); }
  });

  // ── File upload handler ───────────────────────────────────────────────────
  bot.on("message", (msg) => {
    if(isGroupChat(msg)||msg.text||!isOwner(msg.from?.id)) return;
    if(msg.text&&TG_LINK_RE.test(msg.text)) return;
    const chatId=msg.chat.id; const userId=msg.from.id;
    const fileInfo=extractFileInfo(msg);
    if(!fileInfo) return;
    if(autoLectureSession&&autoLectureSession.active&&isPdfFile(fileInfo)){
      return bot.sendMessage(chatId,`📄 PDF ignored in Auto Mode. Send the next lecture for Lecture ${autoLectureSession.lectureCount + 1}.`,{reply_to_message_id:msg.message_id});
    }
    const session=bulkSessions.get(userId);
    if(session){enqueueFile(userId,async()=>{session.files.push(fileInfo);await bot.sendMessage(chatId,`✅ File ${session.files.length} added: ${fileInfo.file_name}\n📦 Total: ${session.files.length}\n\nSend more or /done`,{reply_to_message_id:msg.message_id});});return;}
    enqueueFile(userId, async () => {
      const processing=await bot.sendMessage(chatId,`⏳ Saving: ${fileInfo.file_name}...`);
      try {
        const stored=await saveToStorageChannel(bot,fileInfo); stored.file_name=cleanFileName(stored.file_name);
        const code=getUniqueCode(); const id=db.generateId();
        db.fileRecord.create({id,code,file_id:stored.file_id,file_type:stored.file_type,file_name:stored.file_name,uploaded_by:userId,channel_msg_id:stored.channel_msg_id||null});
        FileRecord.create({code,file_id:stored.file_id,file_type:stored.file_type,file_name:stored.file_name,uploaded_by:userId,expires_at:null,channel_msg_id:stored.channel_msg_id||null}).catch(()=>{});
        const link=`https://t.me/${BOT_USERNAME}?start=${code}`;
        await bot.deleteMessage(chatId,processing.message_id);
        if(autoLectureSession&&autoLectureSession.active){
          try{
            await handleAutoLectureFile(bot, chatId, stored, code, link);
          }catch(err){await bot.sendMessage(chatId,`⚠️ Saved but auto-lecture failed: ${err.message}\n🔗 <code>${link}</code>`,{parse_mode:"HTML"});}
        } else {
          await bot.sendMessage(chatId,`✅ ${stored.file_name}\n\n🔗 Link:\n<code>${link}</code>`,{parse_mode:"HTML",reply_markup:{inline_keyboard:[[{text:"📥 Get File",url:link}]]}});
        }
      } catch(err){console.error("Save error:",err.message);try{await bot.editMessageText(`❌ Could not save. Try again.`,{chat_id:chatId,message_id:processing.message_id});}catch(_){}}
    });
  });

  // ── /broadcast ────────────────────────────────────────────────────────────
  bot.onText(/\/broadcast(.*)/, async (msg,match) => {
    if(isGroupChat(msg)||!isOwner(msg.from?.id)) return;
    const chatId=msg.chat.id; const argRaw=(match[1]||"").trim();
    const pinFlag=argRaw.includes("--pin"); const forwardFlag=argRaw.includes("--f");
    const inlineText=argRaw.replace("--pin","").replace("--f","").trim();
    const reply=msg.reply_to_message;
    let bType=null, bPayload={};
    if(reply){
      if(reply.sticker){bType="sticker";bPayload={file_id:reply.sticker.file_id};}
      else if(reply.animation){bType="animation";bPayload={file_id:reply.animation.file_id,caption:reply.caption||""};}
      else if(reply.video_note){bType="video_note";bPayload={file_id:reply.video_note.file_id};}
      else if(reply.voice){bType="voice";bPayload={file_id:reply.voice.file_id,caption:reply.caption||""};}
      else if(reply.audio){bType="audio";bPayload={file_id:reply.audio.file_id,caption:reply.caption||""};}
      else if(reply.document){bType="document";bPayload={file_id:reply.document.file_id,caption:reply.caption||""};}
      else if(reply.video){bType="video";bPayload={file_id:reply.video.file_id,caption:reply.caption||""};}
      else if(reply.photo){bType="photo";bPayload={file_id:reply.photo[reply.photo.length-1].file_id,caption:reply.caption||""};}
      else if(reply.text){bType="text";bPayload={text:reply.text};}
    }
    if(!bType&&inlineText){bType="text";bPayload={text:inlineText};}
    if(!bType) return bot.sendMessage(chatId,`❌ Nothing to broadcast.\n\nReply to a message with /broadcast or /broadcast Your text here`);

    async function sendToUser(tid){
      if(forwardFlag&&reply) return bot.forwardMessage(tid,reply.chat.id,reply.message_id);
      const o={parse_mode:"HTML"};
      switch(bType){
        case"text": return bot.sendMessage(tid,bPayload.text,o);
        case"photo": return bot.sendPhoto(tid,bPayload.file_id,bPayload.caption?{caption:bPayload.caption,...o}:{});
        case"video": return bot.sendVideo(tid,bPayload.file_id,bPayload.caption?{caption:bPayload.caption,...o}:{});
        case"audio": return bot.sendAudio(tid,bPayload.file_id,bPayload.caption?{caption:bPayload.caption,...o}:{});
        case"document": return bot.sendDocument(tid,bPayload.file_id,bPayload.caption?{caption:bPayload.caption,...o}:{});
        case"voice": return bot.sendVoice(tid,bPayload.file_id,bPayload.caption?{caption:bPayload.caption,...o}:{});
        case"video_note": return bot.sendVideoNote(tid,bPayload.file_id);
        case"sticker": return bot.sendSticker(tid,bPayload.file_id);
        case"animation": return bot.sendAnimation(tid,bPayload.file_id,bPayload.caption?{caption:bPayload.caption,...o}:{});
      }
    }

    const allUsers=db.user.getAll();
    if(!allUsers.length) return bot.sendMessage(chatId,`⚠️ No users found.`);
    const progress=await bot.sendMessage(chatId,`📡 Broadcasting to ${allUsers.length} users...`);
    let sent=0,failed=0,blocked=0;
    for(let i=0;i<allUsers.length;i++){
      const tid=parseInt(allUsers[i].userId,10);
      if(!tid){failed++;continue;}
      try{const sm=await sendToUser(tid);if(pinFlag&&sm?.message_id){try{await bot.pinChatMessage(tid,sm.message_id,{disable_notification:true});}catch(_){}}sent++;}
      catch(err){if((err.message||"").match(/blocked|deactivated|Forbidden/))blocked++;else failed++;}
      if((i+1)%20===0||i===allUsers.length-1){try{await bot.editMessageText(`📡 Broadcasting...\n✅ ${sent} | 🚫 ${blocked} | ❌ ${failed} | ⏳ ${i+1}/${allUsers.length}`,{chat_id:chatId,message_id:progress.message_id});}catch(_){}}
      if((i+1)%25===0&&i<allUsers.length-1) await wait(1000);
    }
    try{await bot.editMessageText(`✅ <b>Broadcast Complete!</b>\n\n✅ Delivered: ${sent}\n🚫 Blocked: ${blocked}\n❌ Failed: ${failed}`,{chat_id:chatId,message_id:progress.message_id,parse_mode:"HTML"});}catch(_){}
  });

  // ── /stats ────────────────────────────────────────────────────────────────
  const nf = (n) => Number(n || 0).toLocaleString('en-IN');

  bot.onText(/\/stats/, async (msg) => {
    if(isGroupChat(msg)||!isOwner(msg.from?.id)) return;
    const chatId=msg.chat.id;
    const processing=await bot.sendMessage(chatId,"⏳ Fetching stats...");
    try {
      const s=await (await fetch(`http://localhost:${PORT}/api/stats`)).json();
      const uptime=process.uptime(); const d=Math.floor(uptime/86400); const h=Math.floor((uptime%86400)/3600); const m=Math.floor((uptime%3600)/60);
      const uptimeStr = d>0 ? `${d}d ${h}h ${m}m` : `${h}h ${m}m`;

      const text = [
        `╔═══════════════════════╗`,
        `      📊 BOT DASHBOARD`,
        `╚═══════════════════════╝`,
        ``,
        `👥 USERS`,
        `┣ Total Users: ${nf(s.users.totalUsers)}`,
        `┣ New Today: +${nf(s.users.newToday)}`,
        `┗ This Week: +${nf(s.users.recentUsers)}`,
        ``,
        `📚 CONTENT`,
        `┣ Batches: ${s.content.totalBatches} (🟢 ${s.content.publicBatches} Public · 🔒 ${s.content.privateBatches} Private)`,
        `┣ Subjects: ${s.content.totalSubjects}  |  Chapters: ${s.content.totalChapters}`,
        `┗ Lectures: ${nf(s.content.totalLectures)}`,
        ``,
        `🔑 ACCESS`,
        `┣ Total Granted: ${nf(s.access.totalAccess)}`,
        `┣ Granted Today: +${nf(s.access.grantedToday)}`,
        `┗ Currently Active: ${nf(s.access.activeAccess)}`,
        ``,
        `👫 REFERRALS`,
        `┣ Total Referrals: ${nf(s.referrals.totalReferrals)}`,
        `┣ Today: +${nf(s.referrals.referralsToday)}  |  This Week: +${nf(s.referrals.referralsThisWeek)}`,
        `┣ Unique Referrers: ${nf(s.referrals.uniqueReferrers)}  |  Avg: ${s.referrals.avgPerReferrer}/referrer`,
        `┣ Points Earned (total): ${nf(s.referrals.totalPointsEarned)}`,
        `┣ Top Referrers:`,
        ...(s.referrals.topReferrers && s.referrals.topReferrers.length
          ? s.referrals.topReferrers.map((r, i) => {
              const medal = ["🥇","🥈","🥉"][i] || `${i+1}.`;
              const isLast = i === s.referrals.topReferrers.length - 1;
              return `${isLast ? "┗" : "┃"}  ${medal} ${r.name} — ${nf(r.count)} refs`;
            })
          : [`┗  —`]),
        ``,
        `🎰 SPIN WHEEL`,
        `┣ Spins Today: ${nf(s.spinWheel.spinsToday)}`,
        `┣ Total Spinners: ${nf(s.spinWheel.totalSpinners)}`,
        `┣ Total Pts Earned: ${nf(s.spinWheel.totalPtsEarned)}`,
        `┗ Total Pts Redeemed: ${nf(s.spinWheel.totalPtsRedeemed)}`,
        ``,
        `📁 FILE STORE`,
        `┣ Files: ${nf(s.fileStore.singleFiles)}`,
        `┗ Bulk Batches: ${nf(s.fileStore.bulkBatches)}`,
        ``,
        `⚙️ SERVER`,
        `┣ Uptime: ${uptimeStr}`,
        `┣ MongoDB: ${mongoose.connection.readyState===1?"🟢 Online":"🔴 Offline"}`,
        `┗ SQLite: ✅ Active`,
        ``,
        `🕐 ${formatIST(new Date())}`,
      ].join("\n");

      await bot.editMessageText(text,{chat_id:chatId,message_id:processing.message_id});
    } catch(err){ console.error("Stats error:", err.message); bot.editMessageText("❌ Could not fetch stats.",{chat_id:chatId,message_id:processing.message_id}); }
  });

  // ── /startgiveaway ────────────────────────────────────────────────────────
  bot.onText(/\/startgiveaway/, async (msg) => {
    if (isGroupChat(msg)||!isOwner(msg.from?.id)) return;
    const chatId = msg.chat.id;
    try {
      const existing = await getActiveGiveaway();
      if (existing) return bot.sendMessage(chatId, `⚠️ A giveaway is already in progress (started ${formatIST(existing.startedAt)}).\n\nUse /endgiveaway to conclude it before launching a new one.`, { parse_mode:"HTML" });
      await Giveaway.create({ status:"active", startedBy: msg.from.id });
      bot.sendMessage(chatId, `✅ <b>Giveaway Launched</b>\n\nParticipants can now join using /participate — the full terms and prize structure are shown to them automatically.\nEnd the giveaway anytime with /endgiveaway.\n\n` + giveawayRulesText(), { parse_mode:"HTML" });
    } catch (err) { console.error("startgiveaway error:", err.message); bot.sendMessage(chatId, `❌ Could not start giveaway.`); }
  });

  // ── /participate ──────────────────────────────────────────────────────────
  bot.onText(/\/participate/, async (msg) => {
    if (isGroupChat(msg)) return;
    const chatId = msg.chat.id; const userId = msg.from.id;
    try {
      const giveaway = await getActiveGiveaway();
      if (!giveaway) return bot.sendMessage(chatId, `⚠️ No giveaway is active right now.`);
      const inviteLink = `https://t.me/${BOT_USERNAME}?start=give_${userId}`;
      let participant = await GiveawayParticipant.findOne({ giveawayId: giveaway._id, userId });
      if (!participant) {
        participant = await GiveawayParticipant.create({ giveawayId: giveaway._id, userId, firstName: msg.from.first_name||"", username: msg.from.username||"" });
      }
      const { rank } = await giveawayRankOf(giveaway._id, userId);
      const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(inviteLink)}&text=${encodeURIComponent("Join the giveaway and win prizes! 🎁")}`;
      const text = `✅ <b>You Have Successfully Joined the Giveaway</b>\n\n<b>Your Invite Link:</b>\n<code>${inviteLink}</code>\n\nConfirmed Invites: <b>${participant.invites}</b>   |   Current Rank: <b>#${rank}</b>\n\n` + giveawayRulesText();
      bot.sendMessage(chatId, text, { parse_mode:"HTML", reply_markup:{ inline_keyboard:[[{ text:"📤 Share Invite Link", url: shareUrl }]] } });
    } catch (err) { console.error("participate error:", err.message); bot.sendMessage(chatId, `❌ Could not join giveaway.`); }
  });

  // ── /scoreboard ───────────────────────────────────────────────────────────
  bot.onText(/\/scoreboard/, async (msg) => {
    if (isGroupChat(msg)) return;
    const chatId = msg.chat.id;
    try {
      const giveaway = await getLatestGiveaway();
      if (!giveaway) return bot.sendMessage(chatId, `⚠️ No giveaway has been run yet.`);
      const top = await GiveawayParticipant.find({ giveawayId: giveaway._id }).sort({ invites:-1, joinedAt:1 }).limit(20);
      const statusLine = giveaway.status==="active" ? `Status: 🟢 Active — started ${formatIST(giveaway.startedAt)}` : `Status: 🔴 Concluded — ended ${formatIST(giveaway.endedAt)}`;
      let text = `🏆 <b>GIVEAWAY LEADERBOARD</b>\n${statusLine}\n\n`;
      if (!top.length) { text += `No participants yet. Use /participate to join.`; }
      else {
        top.forEach((p,i) => {
          const medal = ["🥇","🥈","🥉"][i] || `${i+1}.`;
          text += `${medal} ${giveawayDisplayName(p)} — <b>${p.invites}</b> confirmed invites\n`;
        });
      }
      bot.sendMessage(chatId, text, { parse_mode:"HTML" });
    } catch (err) { console.error("scoreboard error:", err.message); bot.sendMessage(chatId, `❌ Could not load the leaderboard.`); }
  });

  // ── /myscore ──────────────────────────────────────────────────────────────
  bot.onText(/\/myscore/, async (msg) => {
    if (isGroupChat(msg)) return;
    const chatId = msg.chat.id; const userId = msg.from.id;
    try {
      const giveaway = await getLatestGiveaway();
      if (!giveaway) return bot.sendMessage(chatId, `⚠️ No giveaway has been run yet.`);
      const { participant, rank } = await giveawayRankOf(giveaway._id, userId);
      if (!participant) return bot.sendMessage(chatId, `⚠️ You have not joined the giveaway yet. Use /participate to join.`);
      const total = await GiveawayParticipant.countDocuments({ giveawayId: giveaway._id });
      bot.sendMessage(chatId, `📊 <b>Your Giveaway Standing</b>\n\nConfirmed Invites: <b>${participant.invites}</b>\nCurrent Rank: <b>#${rank}</b> of ${total} participants`, { parse_mode:"HTML" });
    } catch (err) { console.error("myscore error:", err.message); bot.sendMessage(chatId, `❌ Could not load your standing.`); }
  });

  // ── /endgiveaway ──────────────────────────────────────────────────────────
  bot.onText(/\/endgiveaway/, async (msg) => {
    if (isGroupChat(msg)||!isOwner(msg.from?.id)) return;
    const chatId = msg.chat.id;
    try {
      const giveaway = await getActiveGiveaway();
      if (!giveaway) return bot.sendMessage(chatId, `⚠️ There is no active giveaway to end.`);
      giveaway.status = "ended"; giveaway.endedAt = new Date(); await giveaway.save();
      const top10 = await GiveawayParticipant.find({ giveawayId: giveaway._id }).sort({ invites:-1, joinedAt:1 }).limit(10);
      if (!top10.length) return bot.sendMessage(chatId, `🏁 <b>Giveaway Concluded</b>\n\nNo participants were recorded — no winners to announce.`, { parse_mode:"HTML" });
      let text = `🏁 <b>GIVEAWAY — FINAL RESULTS</b>\n\n`;
      top10.forEach((p,i) => {
        const rank = i+1; const reward = giveawayRewardFor(rank);
        text += `<b>Rank #${rank}</b> — ${giveawayDisplayName(p)} (${p.invites} confirmed invites)\nReward: ${reward}\n\n`;
        bot.sendMessage(p.userId, `🎉 <b>Congratulations!</b>\n\nYou have finished <b>Rank #${rank}</b> in the giveaway with <b>${p.invites}</b> confirmed invites.\n\n<b>Your Reward:</b> ${reward}\n\nOur team will reach out to you shortly to arrange delivery of your reward.`, { parse_mode:"HTML" }).catch(() => {});
      });
      bot.sendMessage(chatId, text, { parse_mode:"HTML" });
    } catch (err) { console.error("endgiveaway error:", err.message); bot.sendMessage(chatId, `❌ Could not conclude the giveaway.`); }
  });

  bot.on("polling_error",(err)=>console.error("Polling error:",err.message));
  process.on("SIGTERM",()=>{bot.stopPolling();mongoose.connection.close();process.exit(0);});
  process.on("SIGINT",()=>{bot.stopPolling();mongoose.connection.close();process.exit(0);});
}

startBot().catch((err)=>{console.error("Bot startup error:",err.message);process.exit(1);});
