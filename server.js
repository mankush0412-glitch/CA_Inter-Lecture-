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
const crypto = require("crypto");
const { BatchReferralUnlock, PendingReferral, setBatchPremiumCache, isBatchPremiumActiveSync, clearAllBatchPremiumCacheForUser, preloadBatchPremiumCache } = require("./models/ReferralUnlock");
const Batch = require("./models/Course");

const TOKEN = process.env.BOT_TOKEN;
const MONGO_URI = process.env.MONGO_URI;
// Render.com auto-injects RENDER_EXTERNAL_URL with the service's own public
// URL — use that automatically if WEB_URL wasn't set by hand. On other hosts
// (Railway, VPS, etc.) that var won't exist, so WEB_URL still needs setting there.
const WEB_URL = process.env.WEB_URL || process.env.RENDER_EXTERNAL_URL;
const PORT = process.env.PORT || 3000;
const OWNER_ID = parseInt(process.env.OWNER_ID || "0");
const STORAGE_CHANNEL_ID = process.env.STORAGE_CHANNEL_ID ? parseInt(process.env.STORAGE_CHANNEL_ID) : null;
const CONTACT_LINK = process.env.CONTACT_LINK || "";
// Payment system removed — premium access is unlocked for free via referrals (see Referral Unlock System below).
// IMPORTANT: this is intentionally SEPARATE from FORCE_JOIN_CHANNELS below.
// FORCE_JOIN_CHANNELS already existed in the base bot and powers the WebApp's
// whole-app "Verifying / Force Join Gate" screen (public/index.html + the
// /api/force-join/* routes) — that feature was always there, it was just
// dormant because this env var was empty. The Referral Unlock System needs its
// own force-join check (does a REFERRED user need to join before they count?),
// and reusing FORCE_JOIN_CHANNELS for that would silently switch the whole-app
// gate on too — which is what caused the "Verifying" screen to start appearing
// after this feature was configured. Keeping them separate means turning on
// Force Join for referrals never touches the WebApp gate unless you explicitly
// also set FORCE_JOIN_CHANNELS yourself.
const REFERRAL_FORCE_JOIN_CHANNELS = (process.env.REFERRAL_FORCE_JOIN_CHANNELS || "").split(",").map(s => s.trim()).filter(Boolean);
const FORCE_JOIN_CHANNELS = (process.env.FORCE_JOIN_CHANNELS || "").split(",").map(s => s.trim()).filter(Boolean);
const REFERRAL_PREMIUM_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — how long a batch stays unlocked once referral target is hit

let BOT_USERNAME = "";
let bot = null;

const _missingEnv = [];
if (!TOKEN) _missingEnv.push("BOT_TOKEN");
if (!MONGO_URI) _missingEnv.push("MONGO_URI");
if (!WEB_URL) _missingEnv.push("WEB_URL");
if (!OWNER_ID) _missingEnv.push("OWNER_ID");
if (_missingEnv.length) { console.error(`Missing env: ${_missingEnv.join(", ")} — set ${_missingEnv.length > 1 ? "these" : "this"} in your host's Environment tab.`); process.exit(1); }
if (!STORAGE_CHANNEL_ID) console.warn("Warning: STORAGE_CHANNEL_ID not set.");

function isOwner(userId) { return userId === OWNER_ID; }
function isGroupChat(msg) { return msg.chat && (msg.chat.type === "group" || msg.chat.type === "supergroup"); }

// ── MongoDB Schemas (for backup writes only) ──────────────────────────────────
const fileSchema = new mongoose.Schema({ code: { type: String, required: true, unique: true }, file_id: { type: String, required: true }, file_type: { type: String, required: true }, file_name: { type: String, default: "file" }, caption: { type: String, default: null }, caption_entities: { type: [mongoose.Schema.Types.Mixed], default: null }, uploaded_by: Number, expires_at: { type: Date, default: null }, delivered_to: [Number], delivered_at: { type: String, default: '{}' }, created_at: { type: Date, default: Date.now }, channel_msg_id: { type: Number, default: null } });
const FileRecord = mongoose.model("FileRecord", fileSchema);

const bulkBatchSchema = new mongoose.Schema({ batch_code: { type: String, required: true, unique: true }, user_id: Number, files: [{ file_id: String, file_type: String, file_name: { type: String, default: "file" }, caption: { type: String, default: null }, caption_entities: { type: [mongoose.Schema.Types.Mixed], default: null } }], created_at: { type: Date, default: Date.now } });
const BulkBatch = mongoose.model("BulkBatch", bulkBatchSchema);

const pendingDeleteSchema = new mongoose.Schema({ chat_id: Number, message_id: Number, delete_at: Date });
const PendingDelete = mongoose.model("PendingDelete", pendingDeleteSchema);

// Persisted job to remove a chatId from a file's delivered_to list once the 6h
// re-request cooldown expires — mirrors PendingDelete so it survives restarts
// instead of relying solely on an in-memory setTimeout (which was the bug:
// on restart the timer was lost and the chatId stayed in delivered_to forever).
const pendingUndeliverSchema = new mongoose.Schema({ file_record_id: String, code: String, chat_id: Number, undeliver_at: Date });
const PendingUndeliver = mongoose.model("PendingUndeliver", pendingUndeliverSchema);

const userSchema = new mongoose.Schema({ userId: { type: String, required: true, unique: true }, firstName: { type: String, default: "" }, lastName: { type: String, default: "" }, username: { type: String, default: "" }, firstSeen: { type: Date, default: Date.now }, lastSeen: { type: Date, default: Date.now } });
const User = mongoose.model("User", userSchema);

const dailyLimitSchema = new mongoose.Schema({ userId: { type: Number, required: true, unique: true }, count: { type: Number, default: 0 }, resetDate: { type: String, required: true } });
const DailyVideoLimit = mongoose.model("DailyVideoLimit", dailyLimitSchema);
const DAILY_VIDEO_LIMIT = 10;

// ── MongoDB connect ───────────────────────────────────────────────────────────
mongoose.connect(MONGO_URI).then(async () => {
  console.log("MongoDB connected");
  try { await mongoose.connection.collection("filerecords").dropIndex("expires_at_1"); } catch (e) {}
  try { await mongoose.connection.collection("filerecords").updateMany({ expires_at: { $ne: null } }, { $set: { expires_at: null } }); } catch (e) {}
}).catch((err) => { console.error("MongoDB error:", err.message); process.exit(1); });

// ── Helpers ───────────────────────────────────────────────────────────────────
function getTodayIST() { const now = new Date(); return new Date(now.getTime() + 5.5*60*60*1000).toISOString().slice(0,10); }

async function peekVideoLimit(userId) {
  const today = getTodayIST();
  let rec = await DailyVideoLimit.findOne({ userId });
  if (!rec || rec.resetDate !== today) return { allowed: true, used: 0, remaining: DAILY_VIDEO_LIMIT };
  if (rec.count >= DAILY_VIDEO_LIMIT) return { allowed: false, used: rec.count, remaining: 0 };
  return { allowed: true, used: rec.count, remaining: DAILY_VIDEO_LIMIT - rec.count };
}

// Call only AFTER the file has actually been delivered successfully — never
// before sendFile(). Incrementing before delivery meant a failed send (dead
// file_id, Telegram error, etc.) still burned one of the user's 10 daily
// slots even though they received nothing, with no rollback on error.
// Takes `knownUsed` (from the peekVideoLimit() call already made right before
// this, in the same request) so it doesn't have to re-fetch the same document —
// one fewer MongoDB round-trip on every single video delivery.
async function commitVideoLimitIncrement(userId, knownUsed) {
  const today = getTodayIST();
  const newCount = knownUsed + 1;
  DailyVideoLimit.findOneAndUpdate({ userId }, { userId, count: newCount, resetDate: today }, { upsert: true }).catch(err => console.error("commitVideoLimitIncrement error:", err.message));
  return { allowed: true, used: newCount, remaining: DAILY_VIDEO_LIMIT - newCount };
}

function generateCode() { const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789"; let c=""; for(let i=0;i<6;i++) c+=chars[Math.floor(Math.random()*chars.length)]; return c; }
async function getUniqueCode() { let c; do { c = generateCode(); } while (await FileRecord.findOne({ code: c })); return c; }
async function getUniqueBatchCode() { let c; do { c = "B"+generateCode(); } while (await BulkBatch.findOne({ batch_code: c })); return c; }

function extractFileInfo(msg) {
  const caption = msg.caption || null;
  const caption_entities = msg.caption_entities || null;
  if (msg.document)   return { file_id: msg.document.file_id, file_type: "document", file_name: msg.document.file_name||"document", caption, caption_entities };
  if (msg.photo)      return { file_id: msg.photo[msg.photo.length-1].file_id, file_type: "photo", file_name: "photo.jpg", caption, caption_entities };
  if (msg.video)      return { file_id: msg.video.file_id, file_type: "video", file_name: msg.video.file_name||"video.mp4", caption, caption_entities };
  if (msg.audio)      return { file_id: msg.audio.file_id, file_type: "audio", file_name: msg.audio.file_name||"audio.mp3", caption, caption_entities };
  if (msg.voice)      return { file_id: msg.voice.file_id, file_type: "voice", file_name: "voice.ogg", caption, caption_entities };
  if (msg.video_note) return { file_id: msg.video_note.file_id, file_type: "video_note", file_name: "video_note.mp4", caption: null };
  return null;
}

async function saveToStorageChannel(bot, fileInfo) {
  if (!STORAGE_CHANNEL_ID) return fileInfo;
  try {
    let sentMsg;
    const caption = fileInfo.caption || `📎 ${fileInfo.file_name}`;
    const caption_entities = fileInfo.caption_entities && fileInfo.caption_entities.length ? fileInfo.caption_entities : undefined;
    const captionOptions = { caption, ...(caption_entities ? { caption_entities } : {}) };
    switch(fileInfo.file_type) {
      case "photo":      sentMsg = await bot.sendPhoto(STORAGE_CHANNEL_ID, fileInfo.file_id, captionOptions); break;
      case "video":      sentMsg = await bot.sendVideo(STORAGE_CHANNEL_ID, fileInfo.file_id, captionOptions); break;
      case "audio":      sentMsg = await bot.sendAudio(STORAGE_CHANNEL_ID, fileInfo.file_id, captionOptions); break;
      case "voice":      sentMsg = await bot.sendVoice(STORAGE_CHANNEL_ID, fileInfo.file_id, captionOptions); break;
      case "video_note": sentMsg = await bot.sendVideoNote(STORAGE_CHANNEL_ID, fileInfo.file_id); break;
      default:           sentMsg = await bot.sendDocument(STORAGE_CHANNEL_ID, fileInfo.file_id, captionOptions); break;
    }
    const channelFileInfo = extractFileInfo(sentMsg);
    if (channelFileInfo) return { ...channelFileInfo, file_name: fileInfo.file_name, caption: fileInfo.caption, caption_entities: fileInfo.caption_entities, channel_msg_id: sentMsg.message_id };
    return { ...fileInfo, channel_msg_id: sentMsg.message_id };
  } catch (err) { console.error("saveToStorageChannel failed:", err.message); return fileInfo; }
}

async function sendFile(bot, chatId, record) {
  const protect = !isOwner(chatId);
  const hasCaption = record.caption !== undefined && record.caption !== null && record.caption !== "";
  const caption = hasCaption ? record.caption : `📎 ${record.file_name}`;
  const caption_entities = hasCaption && record.caption_entities && record.caption_entities.length ? record.caption_entities : undefined;
  const captionOptions = { caption, ...(caption_entities ? { caption_entities } : {}) };

  // Older records did not store captions. If their storage-channel copy still
  // exists, copy it directly so Telegram preserves the original caption and
  // its bold/italic/custom-emoji entities instead of inventing a filename caption.
  if (!hasCaption && STORAGE_CHANNEL_ID && record.channel_msg_id) {
    try { return await bot.copyMessage(chatId, STORAGE_CHANNEL_ID, record.channel_msg_id, { protect_content: protect }); } catch (_) {}
  }

  try {
    switch(record.file_type) {
      case "photo":      return await bot.sendPhoto(chatId, record.file_id, { ...captionOptions, protect_content: protect });
      case "video":      return await bot.sendVideo(chatId, record.file_id, { ...captionOptions, protect_content: protect });
      case "audio":      return await bot.sendAudio(chatId, record.file_id, { ...captionOptions, protect_content: protect });
      case "voice":      return await bot.sendVoice(chatId, record.file_id, { ...captionOptions, protect_content: protect });
      case "video_note": return await bot.sendVideoNote(chatId, record.file_id, { protect_content: protect });
      default:           return await bot.sendDocument(chatId, record.file_id, { ...captionOptions, filename: record.file_name, protect_content: protect });
    }
  } catch (err) {
    // file_id can go bad (e.g. after switching to a new bot token, since a
    // Telegram file_id is only valid for the bot that issued it). Fall back to
    // copying the mirrored message from the storage channel — but force our own
    // caption, otherwise Telegram keeps whatever caption was on that channel
    // message originally (old filename / promo text) instead of record.file_name.
    if (STORAGE_CHANNEL_ID && record.channel_msg_id) {
      try {
        return await bot.copyMessage(chatId, STORAGE_CHANNEL_ID, record.channel_msg_id, {
          ...captionOptions,
          protect_content: protect,
        });
      } catch (_) {}
    }
    throw err;
  }
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

async function scheduleDelete(bot, chatId, messageId, deleteAt) {
  PendingDelete.create({ chat_id: chatId, message_id: messageId, delete_at: deleteAt }).catch(() => {});
  const delay = Math.max(0, new Date(deleteAt) - Date.now());
  setTimeout(async () => {
    try { await bot.deleteMessage(chatId, messageId); } catch (err) { if (!err.message?.includes("message to delete not found")) console.error("Auto DM deletion error:", err.message); }
    PendingDelete.deleteOne({ chat_id: chatId, message_id: messageId }).catch(() => {});
  }, delay);
}

async function recoverPendingDeletes(bot) {
  const pending = await PendingDelete.find({}).lean();
  console.log(`Recovering ${pending.length} pending DM deletions...`);
  for (const p of pending) {
    const delay = Math.max(0, new Date(p.delete_at) - Date.now());
    setTimeout(async () => {
      try { await bot.deleteMessage(p.chat_id, p.message_id); } catch (err) { console.error("Recovered deletion error:", err.message); }
      PendingDelete.deleteOne({ _id: p._id }).catch(() => {});
    }, delay);
  }
}

// Persists the "un-deliver" job (like scheduleDelete persists the message-delete
// job) so a bot restart doesn't lose the timer and leave the chatId stuck in
// delivered_to forever — which was blocking re-requests after 6 hours.
async function scheduleUndeliver(fileRecordId, code, chatId, undeliverAt) {
  PendingUndeliver.create({ file_record_id: fileRecordId, code, chat_id: chatId, undeliver_at: undeliverAt })
    .catch(err => console.error('PendingUndeliver mongo create error:', err.message));
  const delay = Math.max(0, new Date(undeliverAt) - Date.now());
  setTimeout(() => {
    // Match by _id (=fileRecordId), not by code — code is only kept for
    // debugging and must never be a hard requirement for clearing delivered_to.
    FileRecord.updateOne({ _id: fileRecordId }, { $pull: { delivered_to: chatId } }).catch(() => {});
    PendingUndeliver.deleteOne({ file_record_id: fileRecordId, chat_id: chatId }).catch(() => {});
  }, delay);
}

async function recoverPendingUndelivers() {
  const pending = await PendingUndeliver.find({}).lean();
  console.log(`Recovering ${pending.length} pending file re-request cooldowns...`);
  for (const p of pending) {
    const delay = Math.max(0, new Date(p.undeliver_at) - Date.now());
    setTimeout(() => {
      FileRecord.updateOne({ _id: p.file_record_id }, { $pull: { delivered_to: p.chat_id } }).catch(() => {});
      PendingUndeliver.deleteOne({ _id: p._id }).catch(() => {});
    }, delay);
  }
}

const esc = (s) => String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
// Codes/params from deep links are matched case-insensitively via a RegExp built
// from that raw string. Without escaping, a code containing ANY regex-special
// character (., +, *, (, ), etc.) makes `new RegExp(...)` throw a SyntaxError —
// caught by the surrounding try/catch and shown as a generic "Error occurred"
// with no useful detail. Escaping here fixes that class of failure outright.
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
async function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

app.get("/health", (req, res) => res.json({ status: "ok", build: "referral-unlock-v1", uptime: process.uptime(), mongo: mongoose.connection.readyState===1?"connected":"disconnected" }));
app.get("/api/config", (req, res) => {
  res.json({ ownerId: OWNER_ID, botUsername: BOT_USERNAME||"", forceJoinRequired: FORCE_JOIN_CHANNELS.length>0, contactLink: CONTACT_LINK||`https://t.me/${BOT_USERNAME}` });
});

const courseRoutes = require("./routes/course");
app.use("/api", courseRoutes);
const autoLectureSession = courseRoutes.autoLectureSession;
const autoAddLecture = courseRoutes.autoAddLecture;

// NOTE: the old /api/pay-request (UPI cash-payment) endpoint has been removed.
// Premium batches are now unlocked for free through the per-batch Referral
// Unlock System — see models/ReferralUnlock.js and the
// /api/batch-referral/status/:userId/:batchId route in routes/course.js.

app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// ── Bulk sessions ─────────────────────────────────────────────────────────────
const bulkSessions = new Map();
const BULK_TIMEOUT_MS = 5 * 60 * 1000;

// ── Per-Batch Referral Unlock System (WebApp-driven — no bot-chat "Premium" UI) ──
// The Unlock button, progress display, and Share button all live in the WebApp.
// The bot's only role here is: (a) receive the referred friend via /start deep
// link, (b) gate them behind Force Join, (c) credit the referrer's progress for
// the specific batch once verified. See models/ReferralUnlock.js for the schema.

// Which of REFERRAL_FORCE_JOIN_CHANNELS has this user NOT joined yet? Empty array = fully joined.
async function getUnjoinedChannels(botInstance, userId) {
  if (!REFERRAL_FORCE_JOIN_CHANNELS.length) return [];
  const unjoined = [];
  for (const channel of REFERRAL_FORCE_JOIN_CHANNELS) {
    try {
      const member = await botInstance.getChatMember(channel, userId);
      if (!member || ["left", "kicked"].includes(member.status)) unjoined.push(channel);
    } catch (e) {
      // If the bot can't check (not an admin there, invalid id, etc.) fail open for
      // that single channel rather than permanently blocking every user.
      console.warn(`Force-join check failed for ${channel}:`, e.message);
    }
  }
  return unjoined;
}

function forceJoinKeyboard(unjoined) {
  const rows = unjoined.map((c, i) => [{ text: `➡️ Join Channel ${i + 1}`, url: c.startsWith("@") ? `https://t.me/${c.slice(1)}` : `https://t.me/c/${String(c).replace(/^-100/, "")}` }]);
  rows.push([{ text: "✅ I've Joined", callback_data: "batch_ref_verify_join" }]);
  return { inline_keyboard: rows };
}

// Reads-through with lazy expiry: if this batch's unlock has expired, locks it
// and resets progress back to 0 in the same call.
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

// Credits one valid (force-join-verified) referral toward the referrer's progress
// on the SPECIFIC batch the referral link was generated for. Idempotent — safe to
// call more than once for the same PendingReferral (checks `counted`).
async function creditValidReferralForBatch(botInstance, pending) {
  if (pending.counted || !pending.batchId) return;
  pending.counted = true;
  await pending.save();

  const batch = await Batch.findById(pending.batchId).select("name referralsRequired unlockDurationHours").lean();
  const required = (batch && batch.referralsRequired) || 5;
  const durationMs = ((batch && batch.unlockDurationHours) || 168) * 60 * 60 * 1000;

  const doc = await getBatchReferralStatus(pending.referrerId, pending.batchId);
  if (doc.unlocked) return; // already unlocked this cycle, nothing to add
  if (!doc.validReferrals.includes(pending.referredId)) doc.validReferrals.push(pending.referredId);

  if (doc.validReferrals.length >= required) {
    doc.unlocked = true;
    doc.unlockedAt = new Date();
    doc.expiresAt = new Date(Date.now() + durationMs);
    doc.validReferrals = [];
    await doc.save();
    setBatchPremiumCache(doc.userId, doc.batchId, true, doc.expiresAt);
    const durationHours = Math.round(durationMs / (60 * 60 * 1000));
    const durationLabel = durationHours % 24 === 0 ? `${durationHours / 24} days` : `${durationHours} hours`;
    await botInstance.sendMessage(parseInt(pending.referrerId),
      `🎉 <b>Unlocked!</b>\n\n<b>${batch ? batch.name : "This batch"}</b> is now open for the next ${durationLabel}. 👑`,
      { parse_mode: "HTML" }
    ).catch(() => {});
  } else {
    await doc.save();
    await botInstance.sendMessage(parseInt(pending.referrerId),
      `🎁 <b>New Valid Referral!</b>\n\n${batch ? batch.name : "Batch"}: (${doc.validReferrals.length}/${required})`,
      { parse_mode: "HTML" }
    ).catch(() => {});
  }
}

// Call this once a user is confirmed to have completed Force Join (either right
// after /start if no gate is needed, or after they tap "✅ I've Joined"). If they
// arrived via a referral link, this is what actually turns it into a valid, counted referral.
async function verifyForceJoinAndCreditReferral(botInstance, userId) {
  const pending = await PendingReferral.findOne({ referredId: String(userId) });
  if (!pending || pending.counted) return;
  if (pending.referrerId === String(userId)) return; // self-referral guard
  pending.forceJoinVerified = true;
  await pending.save();
  await creditValidReferralForBatch(botInstance, pending);
}

// If a user leaves a Force Join channel, revoke EVERY batch they'd unlocked via
// referrals (not just one) — they no longer meet the condition for any of them.
async function revokeAllBatchPremiumForUser(userId) {
  await BatchReferralUnlock.updateMany(
    { userId: String(userId), unlocked: true },
    { $set: { unlocked: false, expiresAt: null } }
  );
  clearAllBatchPremiumCacheForUser(String(userId));
}

// ── Bot startup ───────────────────────────────────────────────────────────────
async function startBot() {
  try { await fetch(`https://api.telegram.org/bot${TOKEN}/getUpdates?offset=-1&timeout=0`, { signal: AbortSignal.timeout(10000) }); } catch (_) {}
  console.log("Clearing old polling...");

  for (let attempt=1; attempt<=5; attempt++) {
    try { bot = new TelegramBot(TOKEN, { polling: { interval:2000, autoStart:false, params:{ timeout:30, allowed_updates:["message","callback_query","inline_query","chat_member"] } } }); await bot.getMe(); break; }
    catch (err) { console.error(`Bot init attempt ${attempt} failed`); if(attempt===5) throw err; await wait(5000*attempt); }
  }

  bot.startPolling();
  const me = await bot.getMe();
  BOT_USERNAME = me.username;
  console.log(`Bot started: @${BOT_USERNAME}`);

  try {
    await fetch(`https://api.telegram.org/bot${TOKEN}/setChatMenuButton`, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ menu_button:{ type:"web_app", text:"Open StuBot", web_app:{ url:WEB_URL } } }) });
    console.log("Menu button set:", WEB_URL);
  } catch (_) {}

  await recoverPendingDeletes(bot);
  await recoverPendingUndelivers();
  try { const n = await preloadBatchPremiumCache(); if (n) console.log(`Loaded ${n} active per-batch Referral Unlock(s) from MongoDB`); } catch (e) { console.warn("preloadBatchPremiumCache failed:", e.message); }

  // ── /start ────────────────────────────────────────────────────────────────
  bot.onText(/\/start(.*)/, async (msg, match) => {
    if (isGroupChat(msg)) return;
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const param = match[1].trim();
    const isNewUser = userId ? !(await User.findOne({ userId: String(userId) })) : false;

    if (userId) {
      User.findOneAndUpdate({ userId: String(userId) }, { $setOnInsert: { firstSeen: new Date() }, $set: { firstName: msg.from.first_name||"", lastName: msg.from.last_name||"", username: msg.from.username||"", lastSeen: new Date() } }, { upsert: true }).catch(() => {});
    }

    if (param) {
      if (param.startsWith("ref_")) {
        // Format: ref_<referrerId> (old, points-only) or ref_<referrerId>_<batchId>
        // (new — generated by the WebApp's per-batch Unlock button).
        const refParts = param.replace("ref_","").split("_");
        const referrerId = refParts[0];
        const refBatchId = refParts.length > 1 ? refParts.slice(1).join("_") : null;
        const isValidReferrer = referrerId && referrerId !== String(userId);

        // Existing points-economy referral tracking (unrelated to the per-batch
        // Referral Unlock below — this just keeps the Points System working as before).
        if (isValidReferrer) {
          try {
            const r = await fetch(`http://localhost:${PORT}/api/refer/record`, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ referrerId, referredId: String(userId), isNewUser }) });
            const d = await r.json();
            if (d.isNew) {
              const s = await (await fetch(`http://localhost:${PORT}/api/refer/stats/${referrerId}`)).json();
              bot.sendMessage(parseInt(referrerId), `🎉 <b>New Referral!</b>\n\n${msg.from.first_name} joined using your link!\n⭐ <b>+5 Points!</b> Total: <b>${s.points}</b>`, { parse_mode:"HTML" }).catch(() => {});
            }
          } catch (_) {}
        }

        // Per-Batch Referral Unlock — a referral only becomes "valid" toward
        // unlocking the specific batch once this user is unique + has started
        // the bot + completes Force Join. Self-referrals and duplicate accounts
        // are ignored. No-op if the link didn't carry a batchId (old-style link).
        if (isValidReferrer && refBatchId) {
          try {
            await PendingReferral.findOneAndUpdate(
              { referredId: String(userId) },
              { $setOnInsert: { referrerId, referredId: String(userId), batchId: refBatchId } },
              { upsert: true, new: true }
            );
          } catch (_) { /* duplicate referredId — already tracked, ignore */ }
        }

        const unjoined = await getUnjoinedChannels(bot, userId);
        if (unjoined.length > 0) {
          bot.sendMessage(chatId, `👋 Hello ${msg.from.first_name}!\n\n⚠️ Please join the channel(s)/group(s) below first, then tap "I've Joined" to continue.`, { parse_mode:"HTML", reply_markup: forceJoinKeyboard(unjoined) });
        } else {
          await verifyForceJoinAndCreditReferral(bot, userId);
          bot.sendMessage(chatId, `👋 Hello ${msg.from.first_name}!\n\nTap below to browse all lectures! 📚`, { reply_markup:{ inline_keyboard:[[{ text:"📚 Browse Lectures", web_app:{ url:WEB_URL } }]] } });
        }
        return;
      }

      if (param.startsWith("B")) {
        try {
          const batch = await BulkBatch.findOne({ batch_code: { $regex: new RegExp(`^${escapeRegex(param)}$`, "i") } }).lean();
          if (!batch) return bot.sendMessage(chatId, `File not found. Link may be invalid.`);
          let hasVideo = false, failedCount = 0;
          for (const f of batch.files) {
            let sentMsg;
            try {
              sentMsg = await sendFile(bot, chatId, f);
            } catch (fileErr) {
              // One broken file (dead file_id + no channel copy to fall back on) must
              // not abort the whole batch — skip it and keep sending the rest.
              failedCount++;
              continue;
            }
            if ((f.file_type==="video"||f.file_type==="video_note") && sentMsg) { hasVideo=true; scheduleDelete(bot,chatId,sentMsg.message_id,new Date(Date.now()+6*60*60*1000)); }
          }
          if (hasVideo) await bot.sendMessage(chatId, `⚠️ Videos will auto-delete after 6 hours.`);
          if (failedCount > 0) await bot.sendMessage(chatId, `⚠️ ${failedCount} file(s) in this batch couldn't be delivered (owner needs to re-upload them).`);
          return;
        } catch (err) { return bot.sendMessage(chatId, `Error occurred. Please try again.`); }
      }

      // Single file
      try {
        const record = await FileRecord.findOne({ code: { $regex: new RegExp(`^${escapeRegex(param)}$`, "i") } }).lean();
        if (!record) return bot.sendMessage(chatId, `File not found. Link may be invalid.`);
        const isVideo = record.file_type==="video"||record.file_type==="video_note";
        if (isVideo && (record.delivered_to||[]).includes(chatId)) return bot.sendMessage(chatId, `⚠️ This video was already delivered. You can request it again after 6 hours.`);
        if (isVideo && !isOwner(userId)) {
          const limCheck = await peekVideoLimit(userId);
          if (!limCheck.allowed) return bot.sendMessage(chatId, `🚫 <b>Daily limit reached!</b>\n\nYou've watched <b>${DAILY_VIDEO_LIMIT} videos</b> today.\n📅 Resets at midnight.`, { parse_mode:"HTML" });
          const sentMsg = await sendFile(bot, chatId, record);
          const lim = await commitVideoLimitIncrement(userId, limCheck.used);
          scheduleDelete(bot,chatId,sentMsg.message_id,new Date(Date.now()+6*60*60*1000));
          FileRecord.updateOne({ code:record.code },{ $addToSet:{ delivered_to:chatId } }).catch(() => {});
          scheduleUndeliver(record._id, record.code, chatId, new Date(Date.now()+6*60*60*1000));
          const lines=[`⚠️ This video auto-deletes in 6 hours.`,``,`📊 <b>Today:</b> ${lim.used}/${DAILY_VIDEO_LIMIT} videos`];
          if(lim.remaining===0) lines.push(`🚫 Limit reached for today!`);
          else if(lim.remaining<=3) lines.push(`⚠️ Only <b>${lim.remaining}</b> left today!`);
          await bot.sendMessage(chatId, lines.join("\n"), { parse_mode:"HTML" });
          return;
        }
        const sentMsg = await sendFile(bot, chatId, record);
        if (isVideo) {
          scheduleDelete(bot,chatId,sentMsg.message_id,new Date(Date.now()+6*60*60*1000));
          FileRecord.updateOne({ code:record.code },{ $addToSet:{ delivered_to:chatId } }).catch(() => {});
          scheduleUndeliver(record._id, record.code, chatId, new Date(Date.now()+6*60*60*1000));
          await bot.sendMessage(chatId, `⚠️ This video auto-deletes in 6 hours.`);
        }
      } catch (err) { console.error("Deep link error:", err.message); bot.sendMessage(chatId, `Error occurred. Please try again.`); }
      return;
    }

    const referLink = userId ? `https://t.me/${BOT_USERNAME}?start=ref_${userId}` : "";
    const referLinkCode = referLink ? `<code>${referLink}</code>` : "";
    const welcomeText = isOwner(userId)
      ? `👋 Hello Admin!\n\nTap below to browse lectures! 📚\n\n📁 File Store:\n/bulk — bulk upload\n/myfiles — view files\n/delete &lt;code&gt; — delete file\n/rmword 'word' — remove word from names\n/cancel — cancel bulk\n\n📡 Broadcast:\n/broadcast &lt;text&gt; or reply to media\n\n🔗 <b>Your Invite Link:</b> (tap to copy)\n${referLinkCode}`
      : `👋 Hello ${msg.from.first_name}!\n\n🎓 <b>Welcome to StuBot!</b>\n\nTap below to browse all lectures! 📚\n\n🔗 <b>Your Invite Link:</b> (tap to copy)\n${referLinkCode}\n\nShare karo aur har referral pe <b>5 points</b> kamao! 🎁`;
    const shareUrl = referLink ? `https://t.me/share/url?url=${encodeURIComponent(referLink)}&text=${encodeURIComponent("Join and get free lectures! 📚")}` : "";
    const startButtons = [[{ text:"📚 Browse Lectures", web_app:{ url:WEB_URL } }]];
    if (shareUrl) startButtons.push([{ text:"📤 Share & Earn Points", url: shareUrl }]);
    bot.sendMessage(chatId, welcomeText, { parse_mode:"HTML", reply_markup:{ inline_keyboard: startButtons } });
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
      const batchCode=await getUniqueBatchCode();
      // BUG FIX: this used to `await saveToStorageChannel()` one file at a time in a
      // for-loop, so a 10-file batch took 10x a single Telegram round-trip to save —
      // that was the "delay after clicking Save" the client reported. Saving files in
      // small parallel chunks instead makes /done feel instant while still respecting
      // Telegram's flood limits (chunk of 5 concurrent requests at a time).
      const storedFiles=[];
      const SAVE_CHUNK=5;
      for (let i=0;i<session.files.length;i+=SAVE_CHUNK) {
        const chunk=session.files.slice(i,i+SAVE_CHUNK);
        const results=await Promise.all(chunk.map(f=>saveToStorageChannel(bot,f)));
        storedFiles.push(...results);
      }
      await BulkBatch.create({ batch_code:batchCode, user_id:userId, files:storedFiles });
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
      const allFiles=await FileRecord.find({ uploaded_by:userId }).lean();
      const allBatches=await BulkBatch.find({ user_id:userId }).lean();
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
  // ── Inline sharing for the Referral Unlock System ───────────────────────────
  // The WebApp calls tg.switchInlineQuery('ref_<uid>_<batchId>', [...]) which
  // opens Telegram's native "choose a chat" picker (exactly the DM/group/
  // channel/bot list from the Forward screen). Whichever chat the user picks,
  // Telegram sends US this inline_query with that same text, and we answer with
  // the actual referral message + link to deliver there.
  // REQUIRES: Inline Mode must be turned ON for this bot via @BotFather
  // (/mybots → select your bot → Bot Settings → Inline Mode → Turn on).
  function _toUnicodeBoldServer(str) {
    const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ", lower = "abcdefghijklmnopqrstuvwxyz";
    const map = {};
    for (let i = 0; i < 26; i++) { map[upper[i]] = String.fromCodePoint(0x1D400 + i); map[lower[i]] = String.fromCodePoint(0x1D41A + i); }
    return str.split("").map(ch => map[ch] || ch).join("");
  }

  bot.on("inline_query", async (query) => {
    try {
      const q = (query.query || "").trim();
      let messageText = `Join StuBot for free lectures! 📚\n\nhttps://t.me/${BOT_USERNAME}`;
      let title = "Share StuBot";
      if (q.startsWith("ref_")) {
        const referLink = `https://t.me/${BOT_USERNAME}?start=${q}`;
        let batchName = "";
        const parts = q.replace("ref_", "").split("_");
        const batchId = parts.length > 1 ? parts.slice(1).join("_") : null;
        if (batchId) {
          try { const b = await Batch.findById(batchId).select("name").lean(); if (b) batchName = b.name; } catch (_) {}
        }
        messageText = `${_toUnicodeBoldServer("Free Lecture")} unlock karne ke liye mera link use karo! 📚\n\n${referLink}`;
        title = batchName ? `Share: ${batchName}` : "Share Referral Link";
      }
      await bot.answerInlineQuery(query.id, [{
        type: "article",
        id: "ref_share_" + Date.now(),
        title,
        description: "Tap to send this invite",
        input_message_content: { message_text: messageText },
      }], { cache_time: 0 });
    } catch (e) { console.error("inline_query error:", e.message); }
  });

  bot.on("callback_query", async (query) => {
    const userId=query.from?.id; const data=query.data||""; const chatId=query.message?.chat?.id; const msgId=query.message?.message_id;
    // NOTE: the old pay_approve_/pay_reject_ cash-payment callback branch has been removed —
    // premium batch access is now granted automatically by the Referral Unlock System.
    if(query.message&&isGroupChat(query.message)) return bot.answerCallbackQuery(query.id);

    // ── Force Join verification (for referred users who followed a batch's
    // referral link) — this just confirms the join; the actual unlock progress
    // display lives entirely in the WebApp, not in bot chat. ─────────────────
    if (data === "batch_ref_verify_join") {
      const unjoined = await getUnjoinedChannels(bot, userId);
      if (unjoined.length > 0) {
        await bot.answerCallbackQuery(query.id, { text: "❌ You haven't joined all required channels yet.", show_alert: true });
        return bot.editMessageReplyMarkup(forceJoinKeyboard(unjoined), { chat_id: chatId, message_id: msgId }).catch(() => {});
      }
      await verifyForceJoinAndCreditReferral(bot, userId);
      await bot.answerCallbackQuery(query.id, { text: "✅ Verified! Thanks for joining." });
      return bot.editMessageText(`✅ Force Join verified — thanks!\n\nTap below to browse all lectures! 📚`, { chat_id: chatId, message_id: msgId, reply_markup:{ inline_keyboard:[[{ text:"📚 Browse Lectures", web_app:{ url:WEB_URL } }]] } }).catch(() => {});
    }

    if(!isOwner(userId)) return bot.answerCallbackQuery(query.id);
    if(data.startsWith("myfiles_page_")){const page=parseInt(data.replace("myfiles_page_",""),10);await sendMyFilesPage(query.message.chat.id,userId,page,msgId);await bot.answerCallbackQuery(query.id);}
  });

  // ── /delete ───────────────────────────────────────────────────────────────
  bot.onText(/\/delete (.+)/, async (msg,match) => {
    if(isGroupChat(msg)||!isOwner(msg.from?.id)) return;
    const chatId=msg.chat.id; const code=match[1].trim();
    try {
      const delFile = await FileRecord.deleteOne({code:{$regex:new RegExp(`^${escapeRegex(code)}$`,"i")},uploaded_by:msg.from.id});
      if (delFile.deletedCount>0) return bot.sendMessage(chatId,`✅ File deleted!`);
      const delBatch = await BulkBatch.deleteOne({batch_code:{$regex:new RegExp(`^${escapeRegex(code)}$`,"i")},user_id:msg.from.id});
      if (delBatch.deletedCount>0) return bot.sendMessage(chatId,`✅ Batch deleted!`);
      bot.sendMessage(chatId,`Code not found.`);
    } catch(_){bot.sendMessage(chatId,`Deletion failed.`);}
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
      await DailyVideoLimit.findOneAndUpdate({ userId: targetId }, { userId: targetId, count: 0, resetDate: today }, { upsert: true });
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
      const singleFiles = await FileRecord.find({ channel_msg_id: { $ne: null } }).lean();
      const batches = await BulkBatch.find({}).lean();
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
          await FileRecord.updateOne({ code: rec.code }, { file_id });
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
          await BulkBatch.updateOne({ batch_code: batch.batch_code }, { files: batch.files });
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

  // ── Telegram link fetch ───────────────────────────────────────────────────
  const TG_LINK_RE=/https?:\/\/t\.me\/(c\/(\d+)|([a-zA-Z][a-zA-Z0-9_]{3,}))\/(\d+)/;
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
        const session=bulkSessions.get(userId);
        if(session){session.files.push(fileInfo);return bot.editMessageText(`✅ File ${session.files.length} added: ${fileInfo.file_name}\n📦 Total: ${session.files.length}\n\nSend more or /done`,{chat_id:chatId,message_id:processing.message_id});}
        const stored=await saveToStorageChannel(bot,fileInfo); stored.file_name=cleanFileName(stored.file_name);
        const code=await getUniqueCode();
        await FileRecord.create({code,file_id:stored.file_id,file_type:stored.file_type,file_name:stored.file_name,caption:stored.caption ?? null,caption_entities:stored.caption_entities ?? null,uploaded_by:userId,expires_at:null,channel_msg_id:stored.channel_msg_id||null});
        const link=`https://t.me/${BOT_USERNAME}?start=${code}`;
        await bot.deleteMessage(chatId,processing.message_id);
        if(autoLectureSession&&autoLectureSession.active){
          try{
            const lNum=autoLectureSession.lectureCount+1; const lName=`Lecture ${lNum}`;
            await autoAddLecture({batchId:autoLectureSession.batchId,subjectId:autoLectureSession.subjectId,chapterId:autoLectureSession.chapterId,unitId:autoLectureSession.unitId,name:lName,link:code});
            autoLectureSession.lectureCount=lNum; courseRoutes.saveAutoSession&&courseRoutes.saveAutoSession();
            const loc=autoLectureSession.unitName?`${autoLectureSession.subjectName} › ${autoLectureSession.chapterName} › ${autoLectureSession.unitName}`:`${autoLectureSession.subjectName} › ${autoLectureSession.chapterName}`;
            await bot.sendMessage(chatId,`✅ <b>Auto-Saved!</b>\n📖 <b>${lName}</b>\n📁 ${stored.file_name}\n📍 ${loc}\n🔗 <code>${link}</code>\n\n📨 Send next video for <b>Lecture ${lNum+1}</b>`,{parse_mode:"HTML"});
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

  // ── File upload handler ───────────────────────────────────────────────────
  bot.on("message", (msg) => {
    if(isGroupChat(msg)||msg.text||!isOwner(msg.from?.id)) return;
    if(msg.text&&TG_LINK_RE.test(msg.text)) return;
    const chatId=msg.chat.id; const userId=msg.from.id;
    const fileInfo=extractFileInfo(msg);
    if(!fileInfo) return;
    const session=bulkSessions.get(userId);
    if(session){enqueueFile(userId,async()=>{session.files.push(fileInfo);await bot.sendMessage(chatId,`✅ File ${session.files.length} added: ${fileInfo.file_name}\n📦 Total: ${session.files.length}\n\nSend more or /done`,{reply_to_message_id:msg.message_id});});return;}
    enqueueFile(userId, async () => {
      const processing=await bot.sendMessage(chatId,`⏳ Saving: ${fileInfo.file_name}...`);
      try {
        const stored=await saveToStorageChannel(bot,fileInfo); stored.file_name=cleanFileName(stored.file_name);
        const code=await getUniqueCode();
        await FileRecord.create({code,file_id:stored.file_id,file_type:stored.file_type,file_name:stored.file_name,caption:stored.caption ?? null,caption_entities:stored.caption_entities ?? null,uploaded_by:userId,expires_at:null,channel_msg_id:stored.channel_msg_id||null});
        const link=`https://t.me/${BOT_USERNAME}?start=${code}`;
        await bot.deleteMessage(chatId,processing.message_id);
        if(autoLectureSession&&autoLectureSession.active){
          try{
            const lNum=autoLectureSession.lectureCount+1; const lName=`Lecture ${lNum}`;
            await autoAddLecture({batchId:autoLectureSession.batchId,subjectId:autoLectureSession.subjectId,chapterId:autoLectureSession.chapterId,unitId:autoLectureSession.unitId,name:lName,link:code});
            autoLectureSession.lectureCount=lNum; courseRoutes.saveAutoSession&&courseRoutes.saveAutoSession();
            const loc=autoLectureSession.unitName?`${autoLectureSession.subjectName} › ${autoLectureSession.chapterName} › ${autoLectureSession.unitName}`:`${autoLectureSession.subjectName} › ${autoLectureSession.chapterName}`;
            await bot.sendMessage(chatId,`✅ <b>Auto-Saved!</b>\n📖 <b>${lName}</b>\n📁 ${stored.file_name}\n📍 ${loc}\n🔗 <code>${link}</code>\n\n📨 Send next video for <b>Lecture ${lNum+1}</b>`,{parse_mode:"HTML"});
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

    const allUsers=await User.find({}).select('userId').lean();
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
  function formatIST(d) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true }).formatToParts(d);
    const get = (t) => parts.find((p) => p.type === t).value;
    return `${get('day')}/${get('month')}/${get('year')}, ${get('hour')}:${get('minute')}:${get('second')} ${get('dayPeriod').toLowerCase()}`;
  }
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
        `┗ Database: MongoDB only`,
        ``,
        `🕐 ${formatIST(new Date())}`,
      ].join("\n");

      await bot.editMessageText(text,{chat_id:chatId,message_id:processing.message_id});
    } catch(err){ console.error("Stats error:", err.message); bot.editMessageText("❌ Could not fetch stats.",{chat_id:chatId,message_id:processing.message_id}); }
  });

  // ── Force Join channel/group leave → revoke access + delete pending lectures ──
  // Fires when a member leaves/is kicked from a chat where the bot is admin.
  bot.on("chat_member", async (update) => {
    const newStatus = update.new_chat_member?.status;
    const userId = update.new_chat_member?.user?.id;
    if (!userId || !["left", "kicked"].includes(newStatus)) return;
    const allForceJoinChannels = [...new Set([...REFERRAL_FORCE_JOIN_CHANNELS, ...FORCE_JOIN_CHANNELS])];
    if (!allForceJoinChannels.length) return;

    const chatUsername = String(update.chat?.username || "").trim().toLowerCase();
    const chatIdStr = String(update.chat?.id ?? "").trim();
    const isForceJoinChannel = allForceJoinChannels.some((configuredChannel) => {
      const configured = String(configuredChannel || "").trim().toLowerCase();
      const configuredUsername = configured.replace(/^@/, "");
      return configured === chatIdStr
        || configuredUsername === chatUsername
        || configuredUsername === chatUsername.replace(/^@/, "");
    });
    if (!isForceJoinChannel) return;

    // Revoke Premium immediately if it was active.
    await revokeAllBatchPremiumForUser(userId).catch(() => {});

    // Delete every lecture/media message still tracked for auto-delete in this
    // user's DM. The explanatory notice is sent only after the lecture messages
    // are gone, then it gets its own six-hour auto-delete timer.
    const pendingVideos = await PendingDelete.find({ chat_id: userId });
    if (pendingVideos.length > 0) {
      for (const p of pendingVideos) {
        try { await bot.deleteMessage(userId, p.message_id); } catch (_) {}
      }
      await PendingDelete.deleteMany({ chat_id: userId }).catch(() => {});
      try {
        const notice = await bot.sendMessage(
          userId,
          "⚠️ <b>Video deleted</b>\n\nYou left a required force-join channel or group, so the lecture video sent by the bot has been deleted.\n\nPlease rejoin the required channel or group to request the lecture again.\n\n⏳ This notice will be deleted automatically after 6 hours.",
          { parse_mode: "HTML" }
        );
        await scheduleDelete(bot, userId, notice.message_id, new Date(Date.now() + 6 * 60 * 60 * 1000));
      } catch (_) {}
    }
  });

  bot.on("polling_error",(err)=>console.error("Polling error:",err.message));
  process.on("SIGTERM",()=>{bot.stopPolling();mongoose.connection.close();process.exit(0);});
  process.on("SIGINT",()=>{bot.stopPolling();mongoose.connection.close();process.exit(0);});
}

startBot().catch((err)=>{console.error("Bot startup error:",err.message);process.exit(1);});
