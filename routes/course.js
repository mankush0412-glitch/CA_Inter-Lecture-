const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const mongoose = require("mongoose");
const Batch = require("../models/Course");
const db = require("../sqlite-manager");
const { isBatchPremiumActiveSync, BatchReferralUnlock, setBatchPremiumCache } = require("../models/ReferralUnlock");

const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_ID = parseInt(process.env.OWNER_ID || "0");
// Real-time activity log group — same one server.js posts lecture-call logs
// to. Referral events get logged here too (see /refer/record below).
const LOGS_GROUP_ID = process.env.LOGS_GROUP_ID ? parseInt(process.env.LOGS_GROUP_ID) : null;
// Set by server.js once the bot is initialized (bot doesn't exist yet at require-time),
// so giveaway confirmation/reversal notifications can be sent from here.
let _bot = null;
function setBot(botInstance) { _bot = botInstance; }
// Injected from server.js after grantAdsFreeAccess is defined there (same
// setter pattern as setBot above) — lets the referral-based Ads-Free reward
// below reuse the exact same grant logic Razorpay/Paytm/BharatPe purchases
// use, instead of duplicating it here.
let _grantAdsFreeAccess = null;
function setGrantAdsFreeAccess(fn) { _grantAdsFreeAccess = fn; }
const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function formatIST(d) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('day')}/${get('month')}/${get('year')}, ${get('hour')}:${get('minute')}:${get('second')} ${get('dayPeriod').toLowerCase()}`;
}
// Formats "Name (@username)" or a fallback "User <id>" — same pattern used for
// the multi-account and suspicious-activity alerts, kept consistent here too.
function formatUserLabel(userId) {
  const u = db.user.findOne(String(userId));
  if (!u) return `User ${userId}`;
  const name = [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || `User ${userId}`;
  return name + (u.username ? ` (@${u.username})` : '');
}

// ── Admin verification ────────────────────────────────────────────────────────
function verifyAdmin(req, res, next) {
  const initData = req.headers["x-tg-init-data"];
  if (!initData) return res.status(401).json({ error: "Unauthorized" });
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    params.delete("hash");
    const dataCheckString = Array.from(params.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
    const secretKey = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
    const expectedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
    if (expectedHash !== hash) return res.status(401).json({ error: "Invalid signature" });
    const user = JSON.parse(params.get("user") || "{}");
    if (user.id !== OWNER_ID) return res.status(403).json({ error: "Forbidden" });
    next();
  } catch (e) { return res.status(401).json({ error: "Verification failed" }); }
}

function isAdminRequest(req) {
  const initData = req.headers["x-tg-init-data"];
  if (!initData) return false;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    params.delete("hash");
    const dataCheckString = Array.from(params.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
    const secretKey = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
    const expectedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
    if (expectedHash !== hash) return false;
    const user = JSON.parse(params.get("user") || "{}");
    return user.id === OWNER_ID;
  } catch (e) { return false; }
}

function getRequestUserId(req) {
  const initData = req.headers["x-tg-init-data"];
  if (!initData) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    params.delete("hash");
    const dataCheckString = Array.from(params.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
    const secretKey = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
    const expectedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
    if (expectedHash !== hash) return null;
    const user = JSON.parse(params.get("user") || "{}");
    return user.id ? String(user.id) : null;
  } catch (e) { return null; }
}

// ── Helper: strip premium links ───────────────────────────────────────────────
function stripPremiumLinks(b) {
  return {
    ...b,
    subjects: (b.subjects||[]).map(s => ({
      ...s,
      chapters: (s.chapters||[]).map(c => ({
        ...c,
        lectures: (c.lectures||[]).map(l => ({ ...l, link: l.isDemo ? l.link : '', notes: l.isDemo ? l.notes : '' })),
        units: (c.units||[]).map(u => ({
          ...u,
          lectures: (u.lectures||[]).map(l => ({ ...l, link: l.isDemo ? l.link : '', notes: l.isDemo ? l.notes : '' }))
        }))
      }))
    }))
  };
}

// ── Helper: does this user have access to a premium batch? ───────────────────
// Checks BOTH permanent access (admin/payment-granted premiumUsers list) AND
// temporary reward-granted access (from the points-redemption system). Either
// one is sufficient — this is the single source of truth used everywhere batch
// content is gated, so the reward system and the permanent-access system never
// have to be kept in sync manually.
function hasPremiumAccess(userId, batch) {
  if (!userId) return false;
  if ((batch.premiumUsers || []).includes(userId)) return true;
  if (isBatchPremiumActiveSync(String(userId), String(batch._id))) return true;
  return db.batchRewardAccess.hasAccess(userId, String(batch._id));
}

// ── Helper: save batch to MongoDB async (backup) ──────────────────────────────
function _mongoBackupBatch(batchId) {
  // Re-read from SQLite and push to MongoDB async — fire and forget
  setImmediate(async () => {
    try {
      const data = db.batch.getOne(batchId);
      if (!data) return;
      await Batch.findByIdAndUpdate(batchId, data, { upsert: true });
    } catch (e) { console.error('MongoDB batch backup error:', e.message); }
  });
}

// ── Auto-Lecture Session ──────────────────────────────────────────────────────
const autoLectureSession = db.autoLec.load();

async function _saveAutoSession() {
  db.autoLec.save(autoLectureSession);
  // MongoDB backup
  setImmediate(async () => {
    try {
      const AutoLecSession = mongoose.models.AutoLecSession;
      if (AutoLecSession) await AutoLecSession.findByIdAndUpdate('singleton', { $set: autoLectureSession }, { upsert: true });
    } catch (e) { console.error('AutoLecSession MongoDB backup error:', e.message); }
  });
}

async function autoAddLecture({ batchId, subjectId, chapterId, unitId, name, link }) {
  // Read from SQLite
  const batchData = db.batch.getOne(batchId);
  if (!batchData) throw new Error('Batch not found');

  const subj = (batchData.subjects||[]).find(s => String(s._id) === subjectId);
  if (!subj) throw new Error('Subject not found');
  const chap = (subj.chapters||[]).find(c => String(c._id) === chapterId);
  if (!chap) throw new Error('Chapter not found');

  const newLec = { _id: new mongoose.Types.ObjectId().toString(), name, link, notes: '', order: 0, comingSoon: false, isDemo: false };

  if (unitId) {
    const unit = (chap.units||[]).find(u => String(u._id) === unitId);
    if (!unit) throw new Error('Unit not found');
    newLec.order = unit.lectures.length;
    unit.lectures.push(newLec);
  } else {
    newLec.order = chap.lectures.length;
    chap.lectures.push(newLec);
  }

  // Write to SQLite
  db.batch.upsert(batchData);

  // Write to MongoDB (source of truth backup) — reuse the SAME _id generated
  // above so SQLite and MongoDB stay aligned.
  const mongoBatch = await Batch.findById(batchId);
  if (mongoBatch) {
    const ms = mongoBatch.subjects.id(subjectId);
    const mc = ms && ms.chapters.id(chapterId);
    if (mc) {
      if (unitId) { const mu = mc.units.id(unitId); if (mu) mu.lectures.push({ _id: newLec._id, name, link, notes: '', order: mu.lectures.length, isDemo: false }); }
      else mc.lectures.push({ _id: newLec._id, name, link, notes: '', order: mc.lectures.length, isDemo: false });
      await mongoBatch.save();
    }
  }

  return newLec._id;
}

// ── Batches ───────────────────────────────────────────────────────────────────

router.get("/batches", async (req, res) => {
  try {
    // Everyone reads from SQLite — it's the source of truth for reads (see
    // the strategy note at the top of sqlite-manager.js), and every batch
    // write endpoint below calls db.batch.upsert() right alongside its Mongo
    // write, so SQLite is never stale. Admin used to read fresh from MongoDB
    // directly here "to be safe", but that just made the admin panel's most
    // basic screen depend on Mongo being reachable for no real benefit — a
    // MongoDB hiccup (network blip, Atlas cluster asleep, etc.) broke the
    // whole batches list for admin while everyone else's SQLite-backed app
    // kept working fine. Admin gets the FULL unstripped data (no premium
    // filtering); everyone else gets premium links stripped unless they have access.
    const admin = isAdminRequest(req);
    const batches = db.batch.getAll();
    if (admin) return res.json(batches);

    const userId = getRequestUserId(req);
    res.json(batches.map(b => {
      if (!b.isPremium) return b;
      const referralUnlocked = !!userId && isBatchPremiumActiveSync(String(userId), String(b._id));
      const response = hasPremiumAccess(userId, b) ? b : stripPremiumLinks(b);
      return { ...response, referralUnlocked };
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/batches/:bid", async (req, res) => {
  try {
    // Same reasoning as GET /batches above — read from SQLite always, admin
    // included. Every write path keeps SQLite in sync via db.batch.upsert(),
    // so there's no freshness to gain from hitting MongoDB here, only a
    // needless dependency on it being reachable.
    const admin = isAdminRequest(req);
    const b = db.batch.getOne(req.params.bid);
    if (!b) return res.status(404).json({ error: "Not found" });
    if (admin) return res.json(b);

    const userId = getRequestUserId(req);
    const userHasAccess = hasPremiumAccess(userId, b);
    const referralUnlocked = !!userId && isBatchPremiumActiveSync(String(userId), String(b._id));
    const response = b.isPremium && !userHasAccess ? stripPremiumLinks(b) : b;
    res.json(b.isPremium ? { ...response, referralUnlocked } : response);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/batches/migrate-publish", verifyAdmin, async (req, res) => {
  try {
    const result = await Batch.updateMany({ isPublic: false }, { $set: { isPublic: true } });
    // Sync all back to SQLite
    const batches = await Batch.find({}).lean();
    for (const b of batches) db.batch.upsert(b);
    res.json({ success: true, updated: result.modifiedCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/batches", verifyAdmin, async (req, res) => {
  try {
    const count = db.batch.count();
    // Write to MongoDB first (gets real _id)
    const batch = await Batch.create({ name: req.body.name, pic: req.body.pic||"", description: req.body.description||"", order: count, isPublic: false, isPremium: req.body.isPremium===true, referralsRequired: req.body.referralsRequired != null ? Math.max(1, Number(req.body.referralsRequired) || 5) : 5, unlockDurationHours: req.body.unlockDurationHours != null ? Math.max(1, Number(req.body.unlockDurationHours) || 168) : 168, premiumUsers: [], price: req.body.price ? Number(req.body.price) : 0, rewardEligible: req.body.rewardEligible !== false, redeemCost24h: (req.body.redeemCost24h !== undefined && req.body.redeemCost24h !== null) ? Number(req.body.redeemCost24h) : null, redeemCost7d: (req.body.redeemCost7d !== undefined && req.body.redeemCost7d !== null) ? Number(req.body.redeemCost7d) : null });
    db.batch.upsert(batch.toObject());
    res.json(batch);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch("/batches/:bid/publish", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    if (!batch) return res.status(404).json({ error: "Batch not found" });
    batch.isPublic = !batch.isPublic;
    await batch.save();
    db.batch.upsert(batch.toObject());
    res.json({ success: true, isPublic: batch.isPublic });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete("/batches/:bid", verifyAdmin, async (req, res) => {
  try {
    await Batch.findByIdAndDelete(req.params.bid);
    db.batch.delete(req.params.bid);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch("/batches/:bid/edit", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    if (!batch) return res.status(404).json({ error: "Batch not found" });
    if (req.body.name) batch.name = req.body.name;
    if (req.body.description !== undefined) batch.description = req.body.description;
    if (req.body.isPremium !== undefined) batch.isPremium = req.body.isPremium;
    if (req.body.referralsRequired !== undefined) batch.referralsRequired = Math.max(1, Number(req.body.referralsRequired) || 5);
    if (req.body.unlockDurationHours !== undefined) batch.unlockDurationHours = Math.max(1, Number(req.body.unlockDurationHours) || 168);
    if (req.body.rewardEligible !== undefined) batch.rewardEligible = req.body.rewardEligible !== false;
    if (req.body.redeemCost24h !== undefined) batch.redeemCost24h = (req.body.redeemCost24h === null || req.body.redeemCost24h === '') ? null : Number(req.body.redeemCost24h);
    if (req.body.redeemCost7d !== undefined) batch.redeemCost7d = (req.body.redeemCost7d === null || req.body.redeemCost7d === '') ? null : Number(req.body.redeemCost7d);
    if (req.body.price !== undefined) batch.price = Number(req.body.price)||0;
    if (req.body.pic !== undefined) batch.pic = req.body.pic;
    await batch.save();
    db.batch.upsert(batch.toObject());
    res.json(batch);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Premium Users ─────────────────────────────────────────────────────────────

router.get("/batches/:bid/premium-users", verifyAdmin, async (req, res) => {
  try {
    const b = db.batch.getOne(req.params.bid);
    if (!b) return res.status(404).json({ error: "Batch not found" });
    res.json({ premiumUsers: b.premiumUsers||[] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/batches/:bid/premium-users", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    if (!batch) return res.status(404).json({ error: "Batch not found" });
    const uid = String(req.body.userId||'').trim();
    if (!uid) return res.status(400).json({ error: "userId required" });
    if (!batch.premiumUsers) batch.premiumUsers = [];
    if (!batch.premiumUsers.includes(uid)) { batch.premiumUsers.push(uid); await batch.save(); }
    db.batch.upsert(batch.toObject());
    res.json({ success: true, premiumUsers: batch.premiumUsers });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete("/batches/:bid/premium-users/:uid", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    if (!batch) return res.status(404).json({ error: "Batch not found" });
    batch.premiumUsers = (batch.premiumUsers||[]).filter(u => u !== req.params.uid);
    await batch.save();
    db.batch.upsert(batch.toObject());
    res.json({ success: true, premiumUsers: batch.premiumUsers });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/batches/:bid/premium-check/:userId", async (req, res) => {
  try {
    const b = db.batch.getOne(req.params.bid);
    if (!b) return res.status(404).json({ error: "Batch not found" });
    const userId = String(req.params.userId);
    const isPermanent = (b.premiumUsers||[]).includes(userId);
    const referralAccess = isBatchPremiumActiveSync(userId, String(b._id));
    const rewardAccess = db.batchRewardAccess.findOne(userId, String(b._id));
    const rewardActive = !!rewardAccess && rewardAccess.expiresAt > new Date();
    res.json({
      hasAccess: isPermanent || referralAccess || rewardActive,
      isPremium: b.isPremium===true,
      isPermanent,
      referralAccess,
      rewardAccessExpiresAt: rewardActive ? rewardAccess.expiresAt : null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Additive per-batch Refer & Unlock status ─────────────────────────────────
// Payment, admin access, points rewards, and this free referral unlock remain
// separate access paths. This endpoint is read-only; Telegram deep-link handling
// in server.js is the only code that credits referrals.
router.get("/batch-referral/status/:userId/:batchId", async (req, res) => {
  try {
    const userId = String(req.params.userId);
    const batchId = String(req.params.batchId);
    const batch = await Batch.findById(batchId).select("referralsRequired unlockDurationHours name").lean();
    const required = Math.max(1, Number(batch?.referralsRequired) || 5);
    const unlockDurationHours = Math.max(1, Number(batch?.unlockDurationHours) || 168);
    const doc = await BatchReferralUnlock.findOne({ userId, batchId }).lean();
    if (!doc) return res.json({ unlocked: false, referralCount: 0, required, unlockDurationHours, expiresAt: null });

    let unlocked = !!doc.unlocked;
    let expiresAt = doc.expiresAt;
    let referralCount = (doc.validReferrals || []).length;
    if (unlocked && expiresAt && new Date(expiresAt) <= new Date()) {
      unlocked = false;
      expiresAt = null;
      referralCount = 0;
      await BatchReferralUnlock.updateOne(
        { userId, batchId },
        { $set: { unlocked: false, expiresAt: null, validReferrals: [] } }
      );
      setBatchPremiumCache(userId, batchId, false, null);
    }
    res.json({ unlocked, referralCount, required, unlockDurationHours, expiresAt });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Subjects ──────────────────────────────────────────────────────────────────

router.post("/batches/:bid/subjects", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    if (!batch) return res.status(404).json({ error: "Batch not found" });
    batch.subjects.push({ name: req.body.name, icon: req.body.icon||"📚", color: req.body.color||"#4f8ef7", order: batch.subjects.length });
    await batch.save();
    db.batch.upsert(batch.toObject());
    res.json(batch);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete("/batches/:bid/subjects/:sid", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    if (!batch) return res.status(404).json({ error: "Batch not found" });
    batch.subjects = batch.subjects.filter(s => s._id.toString() !== req.params.sid);
    await batch.save();
    db.batch.upsert(batch.toObject());
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch("/batches/:bid/subjects/:sid/edit", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    const subj = batch && batch.subjects.id(req.params.sid);
    if (!subj) return res.status(404).json({ error: "Not found" });
    if (req.body.name) subj.name = req.body.name;
    if (req.body.icon) subj.icon = req.body.icon;
    if (req.body.color) subj.color = req.body.color;
    await batch.save();
    db.batch.upsert(batch.toObject());
    res.json(batch);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Re-arrange a subject's position within the batch — { direction: 'up' | 'down' }
// Deep-clone any subdocument as plain data, stripping every _id so Mongoose
// mints brand-new ones for it and everything nested inside it (used by the
// subject "copy to another batch" endpoint below).
function stripIds(obj) {
  const clone = JSON.parse(JSON.stringify(obj));
  const strip = (o) => {
    if (Array.isArray(o)) { o.forEach(strip); return; }
    if (o && typeof o === "object") { delete o._id; Object.values(o).forEach(strip); }
  };
  strip(clone);
  return clone;
}

router.patch("/batches/:bid/subjects/:sid/move", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    if (!batch) return res.status(404).json({ error: "Batch not found" });
    const idx = batch.subjects.findIndex(s => s._id.toString() === req.params.sid);
    if (idx === -1) return res.status(404).json({ error: "Not found" });
    const swapIdx = req.body.direction === "up" ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= batch.subjects.length) return res.status(400).json({ error: "Already at the edge" });
    const reordered = batch.subjects.map(s => s.toObject());
    [reordered[idx], reordered[swapIdx]] = [reordered[swapIdx], reordered[idx]];
    reordered.forEach((s, i) => { s.order = i; });
    batch.subjects = reordered;
    await batch.save();
    db.batch.upsert(batch.toObject());
    res.json(batch);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Copy an entire subject (with all its chapters + units + lectures) AS-IS into another batch.
// Body: { targetBatchId }
router.post("/batches/:bid/subjects/:sid/copy-to", verifyAdmin, async (req, res) => {
  try {
    const { targetBatchId } = req.body;
    if (!targetBatchId) return res.status(400).json({ error: "targetBatchId required" });

    const srcBatch = await Batch.findById(req.params.bid);
    const srcSubj = srcBatch && srcBatch.subjects.id(req.params.sid);
    if (!srcSubj) return res.status(404).json({ error: "Source subject not found" });

    const destBatch = String(targetBatchId) === String(req.params.bid) ? srcBatch : await Batch.findById(targetBatchId);
    if (!destBatch) return res.status(404).json({ error: "Target batch not found" });

    const clonedSubject = stripIds(srcSubj.toObject());
    clonedSubject.order = destBatch.subjects.length;

    destBatch.subjects.push(clonedSubject);
    await destBatch.save();
    db.batch.upsert(destBatch.toObject());
    res.json({ success: true, batch: destBatch });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Chapters ──────────────────────────────────────────────────────────────────

router.post("/batches/:bid/subjects/:sid/chapters", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    const subj = batch && batch.subjects.id(req.params.sid);
    if (!subj) return res.status(404).json({ error: "Not found" });
    subj.chapters.push({ name: req.body.name, order: subj.chapters.length });
    await batch.save();
    db.batch.upsert(batch.toObject());
    res.json(batch);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete("/batches/:bid/subjects/:sid/chapters/:cid", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    const subj = batch && batch.subjects.id(req.params.sid);
    if (!subj) return res.status(404).json({ error: "Not found" });
    subj.chapters = subj.chapters.filter(c => c._id.toString() !== req.params.cid);
    await batch.save();
    db.batch.upsert(batch.toObject());
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch("/batches/:bid/subjects/:sid/chapters/:cid/edit", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    const subj = batch && batch.subjects.id(req.params.sid);
    const chap = subj && subj.chapters.id(req.params.cid);
    if (!chap) return res.status(404).json({ error: "Not found" });
    if (req.body.name) chap.name = req.body.name;
    if (req.body.comingSoon !== undefined) chap.comingSoon = req.body.comingSoon;
    await batch.save();
    db.batch.upsert(batch.toObject());
    res.json(batch);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Re-arrange a chapter's position within the subject — { direction: 'up' | 'down' }
router.patch("/batches/:bid/subjects/:sid/chapters/:cid/move", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    const subj = batch && batch.subjects.id(req.params.sid);
    if (!subj) return res.status(404).json({ error: "Not found" });
    const idx = subj.chapters.findIndex(c => c._id.toString() === req.params.cid);
    if (idx === -1) return res.status(404).json({ error: "Not found" });
    const swapIdx = req.body.direction === "up" ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= subj.chapters.length) return res.status(400).json({ error: "Already at the edge" });
    const reordered = subj.chapters.map(c => c.toObject());
    [reordered[idx], reordered[swapIdx]] = [reordered[swapIdx], reordered[idx]];
    reordered.forEach((c, i) => { c.order = i; });
    subj.chapters = reordered;
    await batch.save();
    db.batch.upsert(batch.toObject());
    res.json(batch);
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ── Units ─────────────────────────────────────────────────────────────────────

router.post("/batches/:bid/subjects/:sid/chapters/:cid/units", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    const subj = batch && batch.subjects.id(req.params.sid);
    const chap = subj && subj.chapters.id(req.params.cid);
    if (!chap) return res.status(404).json({ error: "Not found" });
    chap.units.push({ name: req.body.name, order: chap.units.length });
    await batch.save();
    db.batch.upsert(batch.toObject());
    res.json(batch);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete("/batches/:bid/subjects/:sid/chapters/:cid/units/:uid", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    const subj = batch && batch.subjects.id(req.params.sid);
    const chap = subj && subj.chapters.id(req.params.cid);
    if (!chap) return res.status(404).json({ error: "Not found" });
    chap.units = chap.units.filter(u => u._id.toString() !== req.params.uid);
    await batch.save();
    db.batch.upsert(batch.toObject());
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch("/batches/:bid/subjects/:sid/chapters/:cid/units/:uid/edit", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    const subj = batch && batch.subjects.id(req.params.sid);
    const chap = subj && subj.chapters.id(req.params.cid);
    const unit = chap && chap.units.id(req.params.uid);
    if (!unit) return res.status(404).json({ error: "Not found" });
    if (req.body.name) unit.name = req.body.name;
    await batch.save();
    db.batch.upsert(batch.toObject());
    res.json(batch);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Lectures (chapter-level) ──────────────────────────────────────────────────

router.post("/batches/:bid/subjects/:sid/chapters/:cid/lectures", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    const subj = batch && batch.subjects.id(req.params.sid);
    const chap = subj && subj.chapters.id(req.params.cid);
    if (!chap) return res.status(404).json({ error: "Not found" });
    chap.lectures.push({ name: req.body.name, link: req.body.link, notes: req.body.notes||"", order: chap.lectures.length, isDemo: req.body.isDemo===true });
    await batch.save();
    db.batch.upsert(batch.toObject());
    res.json(batch);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete("/batches/:bid/subjects/:sid/chapters/:cid/lectures/:lid", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    const subj = batch && batch.subjects.id(req.params.sid);
    const chap = subj && subj.chapters.id(req.params.cid);
    if (!chap) return res.status(404).json({ error: "Not found" });
    chap.lectures = chap.lectures.filter(l => l._id.toString() !== req.params.lid);
    await batch.save();
    db.batch.upsert(batch.toObject());
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch("/batches/:bid/subjects/:sid/chapters/:cid/lectures/:lid/edit", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    const subj = batch && batch.subjects.id(req.params.sid);
    const chap = subj && subj.chapters.id(req.params.cid);
    const lec = chap && chap.lectures.id(req.params.lid);
    if (!lec) return res.status(404).json({ error: "Not found" });
    if (req.body.name) lec.name = req.body.name;
    if (req.body.link !== undefined) lec.link = req.body.link;
    if (req.body.notes !== undefined) lec.notes = req.body.notes;
    if (req.body.comingSoon !== undefined) lec.comingSoon = req.body.comingSoon;
    if (req.body.isDemo !== undefined) lec.isDemo = req.body.isDemo;
    await batch.save();
    db.batch.upsert(batch.toObject());
    res.json(batch);
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ── Lectures (unit-level) ─────────────────────────────────────────────────────

router.post("/batches/:bid/subjects/:sid/chapters/:cid/units/:uid/lectures", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    const subj = batch && batch.subjects.id(req.params.sid);
    const chap = subj && subj.chapters.id(req.params.cid);
    const unit = chap && chap.units.id(req.params.uid);
    if (!unit) return res.status(404).json({ error: "Not found" });
    unit.lectures.push({ name: req.body.name, link: req.body.link, notes: req.body.notes||"", order: unit.lectures.length, isDemo: req.body.isDemo===true });
    await batch.save();
    db.batch.upsert(batch.toObject());
    res.json(batch);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete("/batches/:bid/subjects/:sid/chapters/:cid/units/:uid/lectures/:lid", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    const subj = batch && batch.subjects.id(req.params.sid);
    const chap = subj && subj.chapters.id(req.params.cid);
    const unit = chap && chap.units.id(req.params.uid);
    if (!unit) return res.status(404).json({ error: "Not found" });
    unit.lectures = unit.lectures.filter(l => l._id.toString() !== req.params.lid);
    await batch.save();
    db.batch.upsert(batch.toObject());
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch("/batches/:bid/subjects/:sid/chapters/:cid/units/:uid/lectures/:lid/edit", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    const subj = batch && batch.subjects.id(req.params.sid);
    const chap = subj && subj.chapters.id(req.params.cid);
    const unit = chap && chap.units.id(req.params.uid);
    const lec = unit && unit.lectures.id(req.params.lid);
    if (!lec) return res.status(404).json({ error: "Not found" });
    if (req.body.name) lec.name = req.body.name;
    if (req.body.link !== undefined) lec.link = req.body.link;
    if (req.body.notes !== undefined) lec.notes = req.body.notes;
    if (req.body.comingSoon !== undefined) lec.comingSoon = req.body.comingSoon;
    if (req.body.isDemo !== undefined) lec.isDemo = req.body.isDemo;
    await batch.save();
    db.batch.upsert(batch.toObject());
    res.json(batch);
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ── Announcements ─────────────────────────────────────────────────────────────

const announcementSchema = new mongoose.Schema({ emoji: { type: String, default: "📢" }, heading: { type: String, required: true }, body: { type: String, required: true }, createdAt: { type: Date, default: Date.now } });
const Announcement = mongoose.model("Announcement", announcementSchema);

router.get("/announcements", (req, res) => {
  try { res.json(db.announcement.getAll()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/announcements", verifyAdmin, async (req, res) => {
  try {
    const { emoji, heading, body } = req.body;
    if (!heading || !body) return res.status(400).json({ error: "heading and body required" });
    // Write to MongoDB to get _id
    const ann = await Announcement.create({ emoji: emoji||"📢", heading, body });
    db.announcement.insert({ id: String(ann._id), emoji: ann.emoji, heading: ann.heading, body: ann.body, createdAt: ann.createdAt });
    res.json({ ...ann.toObject(), _id: String(ann._id) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete("/announcements/:id", verifyAdmin, async (req, res) => {
  try {
    await Announcement.findByIdAndDelete(req.params.id);
    db.announcement.delete(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Ad Token + Access ─────────────────────────────────────────────────────────

const adTokenSchema = new mongoose.Schema({ userId: { type: String, required: true }, token: { type: String, required: true, unique: true }, issuedAt: { type: Date, default: Date.now }, expiresAt: { type: Date, required: true } });
adTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const AdToken = mongoose.model("AdToken", adTokenSchema);

const accessSchema = new mongoose.Schema({ userId: { type: String, required: true, unique: true }, expiresAt: { type: Date, required: true }, claimsToday: { type: Number, default: 0 }, claimDay: { type: String, default: '' } });
const Access = mongoose.model("Access", accessSchema);

router.get("/access/:userId", (req, res) => {
  try {
    const record = db.access.findOne(req.params.userId);
    const today = new Date().toISOString().slice(0, 10);
    const claimsToday = (record && record.claimDay === today) ? (record.claimsToday||0) : 0;
    const claimsLeft = Math.max(0, 3 - claimsToday);
    if (!record || record.expiresAt < new Date()) return res.json({ hasAccess: false, expiresAt: null, claimsToday, claimsLeft });
    res.json({ hasAccess: true, expiresAt: record.expiresAt, claimsToday, claimsLeft });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/access/token/:userId", async (req, res) => {
  try {
    const userId = req.params.userId;
    const today = new Date().toISOString().slice(0, 10);
    const existing = db.access.findOne(userId);
    const claimsToday = (existing && existing.claimDay === today) ? (existing.claimsToday||0) : 0;
    if (claimsToday >= 3) return res.status(429).json({ error: "Aaj ke 3 claims ho gaye! Kal wapas aao.", claimsToday: 3, claimsLeft: 0 });

    db.adToken.deleteByUser(userId);
    await AdToken.deleteMany({ userId });

    const token = crypto.randomBytes(32).toString("hex");
    const tokenExpiry = new Date(Date.now() + 10 * 60 * 1000);
    const id = db.generateId();
    db.adToken.create({ id, userId, token, issuedAt: new Date(), expiresAt: tokenExpiry });
    // MongoDB backup
    AdToken.create({ userId, token, expiresAt: tokenExpiry }).catch(() => {});
    res.json({ token, claimsToday, claimsLeft: 3 - claimsToday });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/access/claim/:userId", async (req, res) => {
  try {
    const userId = req.params.userId;
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: "Token required" });

    const record = db.adToken.findOne({ userId, token });
    if (!record) return res.status(403).json({ error: "Invalid or expired token. Please watch the ad again." });
    if (record.expiresAt < new Date()) return res.status(403).json({ error: "Token expired. Please watch the ad again." });
    const elapsed = (Date.now() - new Date(record.issuedAt)) / 1000;
    if (elapsed < 10) return res.status(403).json({ error: "You skipped the ad too soon! Please watch it fully (at least 10 seconds) to unlock your reward." });

    const today = new Date().toISOString().slice(0, 10);
    const existing = db.access.findOne(userId);
    const claimsToday = (existing && existing.claimDay === today) ? (existing.claimsToday||0) : 0;
    if (claimsToday >= 3) { db.adToken.deleteById(record.id); return res.status(429).json({ error: "Aaj ke 3 claims ho gaye! Kal wapas aao." }); }

    db.adToken.deleteById(record.id);
    AdToken.deleteOne({ userId, token }).catch(() => {});

    const baseTime = (existing && existing.expiresAt > new Date()) ? existing.expiresAt : new Date();
    const expiresAt = new Date(baseTime.getTime() + 8 * 60 * 60 * 1000);
    const newClaimsToday = claimsToday + 1;

    db.access.upsert({ userId, expiresAt, claimsToday: newClaimsToday, claimDay: today });
    // MongoDB backup
    Access.findOneAndUpdate({ userId }, { userId, expiresAt, claimsToday: newClaimsToday, claimDay: today }, { upsert: true }).catch(() => {});
    res.json({ hasAccess: true, expiresAt, claimsToday: newClaimsToday, claimsLeft: 3 - newClaimsToday });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Referrals ─────────────────────────────────────────────────────────────────

const referralSchema = new mongoose.Schema({ referrerId: { type: String, required: true }, referredId: { type: String, required: true }, createdAt: { type: Date, default: Date.now } });
referralSchema.index({ referrerId: 1 });
referralSchema.index({ referredId: 1 }, { unique: true });
const Referral = mongoose.model('Referral', referralSchema);

router.get('/refer/stats/:userId', (req, res) => {
  try {
    const { referrals, spent, points } = getPointsBreakdown(req.params.userId);
    res.json({ referrals, spent, points });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/refer/record', async (req, res) => {
  try {
    const { referrerId, referredId } = req.body;
    if (!referrerId || !referredId) return res.status(400).json({ error: 'Missing fields' });
    if (referrerId === referredId) return res.status(400).json({ error: 'Cannot refer yourself' });
    if (!req.body.isNewUser) return res.json({ success: false, isNew: false, reason: 'Not a new user' });

    const existing = db.referral.findByReferred(referredId);
    if (existing) return res.json({ success: false, isNew: false, reason: 'Already referred' });

    const id = db.generateId();
    db.referral.insert({ id, referrerId, referredId });
    // MongoDB backup
    Referral.create({ referrerId, referredId }).catch(() => {});

    if (LOGS_GROUP_ID && _bot) {
      const text = `🎉 <b>New Referral</b>\n\n` +
        `👤 Referrer: ${esc(formatUserLabel(referrerId))} (<code>${referrerId}</code>)\n` +
        `➕ Referred: ${esc(formatUserLabel(referredId))} (<code>${referredId}</code>)\n` +
        `🕐 ${formatIST(new Date())}`;
      _bot.sendMessage(LOGS_GROUP_ID, text, { parse_mode: "HTML" }).catch(() => {});
    }

    res.json({ success: true, isNew: true });
  } catch (e) {
    if (e.code === 11000) return res.json({ success: false, reason: 'Already referred' });
    res.status(500).json({ error: e.message });
  }
});

// ── Rewards (spend referral points on real perks) ──────────────────────────────
// Points are never stored as a mutable balance — they are always DERIVED as
// (referrals earned) - (points spent, from reward_redemptions). This means the
// number shown to the user can never drift out of sync with their real referral
// count, no matter what happens to the reward system itself.

const rewardRedemptionSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  rewardType: { type: String, required: true },   // 'accessPass' | 'batch24h' | 'batch7d'
  batchId: { type: String, default: null },
  batchName: { type: String, default: '' },
  pointsCost: { type: Number, required: true },
  redeemedAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },
});
rewardRedemptionSchema.index({ userId: 1 });
const RewardRedemption = mongoose.models.RewardRedemption || mongoose.model('RewardRedemption', rewardRedemptionSchema);

const batchRewardAccessSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  batchId: { type: String, required: true },
  batchName: { type: String, default: '' },
  expiresAt: { type: Date, required: true },
  grantedAt: { type: Date, default: Date.now },
});
batchRewardAccessSchema.index({ userId: 1, batchId: 1 }, { unique: true });
const BatchRewardAccess = mongoose.models.BatchRewardAccess || mongoose.model('BatchRewardAccess', batchRewardAccessSchema);

// Manual point grants/deductions made by the admin via /addpoints. Kept as its own
// signed ledger (points can be negative) rather than a balance column, same reasoning
// as referrals/redemptions — see getPointsBreakdown below, which is the only place
// this actually gets folded into a user's spendable total.
const pointAdjustmentSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  points: { type: Number, required: true },
  note: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
});
pointAdjustmentSchema.index({ userId: 1 });
const PointAdjustment = mongoose.models.PointAdjustment || mongoose.model('PointAdjustment', pointAdjustmentSchema);

// Manual per-user daily spin-limit adjustments (admin /addspins command).
// Net sum for a user is added on top of the global daily spin limit — see getSpinStatus.
const spinAdjustmentSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  delta: { type: Number, required: true },
  note: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
});
spinAdjustmentSchema.index({ userId: 1 });
const SpinAdjustment = mongoose.models.SpinAdjustment || mongoose.model('SpinAdjustment', spinAdjustmentSchema);

// Reward catalog — single source of truth for cost + duration of every reward.
// To add a new reward in future, just add an entry here (and a matching branch
// in the redeem handler below if it needs special grant logic).
// Each successful referral is worth this many points (single source of truth —
// change this one number to adjust the referral reward economy).
const POINTS_PER_REFERRAL = 5;

// Spin & Earn tab configuration
// Daily spin limit is admin-configurable (via /setspinlimit in server.js) —
// stored in bot_settings so it persists across restarts, defaulting to 5 if
// never set. Read fresh each time rather than cached, since it can change at
// any moment from a bot command while the server keeps running.
function getSpinDailyLimit() {
  return db.settings.get('spin_daily_limit', 5);
}
const SPIN_COOLDOWN_MS = 10 * 1000;
const SPIN_AD_WATCH_SECONDS = 10;

const REWARD_CATALOG = {
  accessPass: { cost: 5, durationMs: 24 * 60 * 60 * 1000, label: '24 Hour Site Access' },
  batch24h: { cost: 10, durationMs: 24 * 60 * 60 * 1000, label: '24 Hour Premium Batch Access' },
  batch7d: { cost: 50, durationMs: 7 * 24 * 60 * 60 * 1000, label: '7 Day Premium Batch Access' },
};

// Every REFERRALS_PER_ADSFREE_WEEK referrals (raw count, NOT points — separate
// currency, separate redeem button) earns one redeemable "1 week Ads-Free".
// Stacks with any existing Ads-Free time (purchased or previously redeemed
// this way), same as a real purchase. See /rewards/redeem-referral-adsfree.
const REFERRALS_PER_ADSFREE_WEEK = 5;
const REFERRAL_ADSFREE_DAYS = 7;

// Single source of truth for the points formula — always fresh from the DB,
// never trusts a client-sent value. referrals here is the raw referral COUNT;
// points is the spendable balance (referrals*POINTS_PER_REFERRAL + spinEarned + adjustment - spent).
function getPointsBreakdown(userId) {
  const referrals = db.referral.countByReferrer(userId);
  const spinEarned = db.spinHistory.totalEarned(userId);
  const adjustment = db.pointAdjustment.totalForUser(userId); // manual admin grants/deductions, can be negative
  const spent = db.rewardRedemption.totalSpent(userId);
  const points = Math.max(0, referrals * POINTS_PER_REFERRAL + spinEarned + adjustment - spent);
  return { referrals, spinEarned, adjustment, spent, points };
}
function getSpendablePoints(userId) {
  return getPointsBreakdown(userId).points;
}

// Notify the bot owner whenever someone redeems a reward — fire-and-forget,
// never allowed to block or fail the actual redeem response to the user.
function notifyOwnerOfRedemption({ userId, rewardType, catalogEntry, batchDoc, pointsCost, pointsRemaining, expiresAt }) {
  if (!BOT_TOKEN || !OWNER_ID) return;
  try {
    const u = db.user.findOne(userId);
    const displayName = u ? [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || 'Unknown' : 'Unknown';
    const usernameStr = u && u.username ? ` (@${u.username})` : '';
    const expiryStr = new Date(expiresAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

    let text = `🎁 <b>Reward Redeemed!</b>\n\n` +
      `👤 <b>User:</b> ${displayName}${usernameStr}\n` +
      `🆔 <b>ID:</b> <code>${userId}</code>\n` +
      `🎯 <b>Reward:</b> ${catalogEntry.label}\n` +
      `⭐ <b>Points Spent:</b> ${pointsCost} (Balance left: ${pointsRemaining})\n`;
    if (batchDoc) text += `🎓 <b>Batch:</b> ${batchDoc.name}\n`;
    text += `⏳ <b>Access Until:</b> ${expiryStr}`;

    fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: OWNER_ID, text, parse_mode: 'HTML' }),
    }).catch(() => {});
  } catch (e) { /* never let a notification failure affect the redeem flow */ }
}

// GET summary — powers the Rewards page header (points balance + active perks)
router.get('/rewards/summary/:userId', (req, res) => {
  try {
    const userId = req.params.userId;
    const { referrals, spent, points } = getPointsBreakdown(userId);

    const accessRecord = db.access.findOne(userId);
    const accessPass = {
      active: !!accessRecord && accessRecord.expiresAt > new Date(),
      expiresAt: accessRecord ? accessRecord.expiresAt : null,
    };

    const activeBatchRewards = db.batchRewardAccess.listActiveByUser(userId)
      .map(r => ({ batchId: r.batchId, batchName: r.batchName, expiresAt: r.expiresAt }));

    // Referral-based Ads-Free reward — separate "currency" from points above,
    // eligibility is purely floor(referrals / 5) minus however many they've
    // already redeemed this way (never re-derived from points/spent).
    const referralAdsFreeRedeemed = db.rewardRedemption.countByTypeForUser(userId, 'referralAdsFree');
    const referralAdsFree = {
      referralsPerReward: REFERRALS_PER_ADSFREE_WEEK,
      rewardDays: REFERRAL_ADSFREE_DAYS,
      progress: referrals % REFERRALS_PER_ADSFREE_WEEK,
      available: Math.max(0, Math.floor(referrals / REFERRALS_PER_ADSFREE_WEEK) - referralAdsFreeRedeemed),
    };

    res.json({ referrals, spent, points, accessPass, activeBatchRewards, referralAdsFree, catalog: REWARD_CATALOG });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST — redeem one "5 referrals -> 1 week Ads-Free" reward. Pure referral-
// count based, costs zero points (separate from REWARD_CATALOG/points above).
router.post('/rewards/redeem-referral-adsfree', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    if (!_grantAdsFreeAccess) return res.status(500).json({ error: 'Ads-Free grant is not wired up yet — restart the server.' });

    // ── Critical section: no `await` between the eligibility check and the
    // ledger insert, so two rapid clicks can't both pass the check and double-
    // redeem the same batch of 5 referrals. Same pattern as /rewards/redeem.
    const referrals = db.referral.countByReferrer(userId);
    const alreadyRedeemed = db.rewardRedemption.countByTypeForUser(userId, 'referralAdsFree');
    const available = Math.floor(referrals / REFERRALS_PER_ADSFREE_WEEK) - alreadyRedeemed;
    if (available < 1) {
      const needed = REFERRALS_PER_ADSFREE_WEEK - (referrals % REFERRALS_PER_ADSFREE_WEEK || REFERRALS_PER_ADSFREE_WEEK);
      return res.status(400).json({
        error: `Abhi eligible nahi ho. Har ${REFERRALS_PER_ADSFREE_WEEK} referrals pe 1 week Ads-Free milta hai — ${needed} aur referral chahiye.`,
        referrals, available: 0,
      });
    }

    const redeemedAt = new Date();
    const id = db.generateId();
    db.rewardRedemption.insert({
      id, userId, rewardType: 'referralAdsFree', batchId: null, batchName: '',
      pointsCost: 0, redeemedAt, expiresAt: redeemedAt, // placeholder; real expiry is the Ads-Free subscription's own, set below
    });
    // ── End critical section ─────────────────────────────────────────────

    const expiresAt = await _grantAdsFreeAccess(userId, REFERRAL_ADSFREE_DAYS);

    RewardRedemption.create({
      userId, rewardType: 'referralAdsFree', batchId: null, batchName: '',
      pointsCost: 0, redeemedAt, expiresAt: redeemedAt,
    }).catch(() => {});
    notifyOwnerOfRedemption({
      userId, rewardType: 'referralAdsFree',
      catalogEntry: { label: `${REFERRAL_ADSFREE_DAYS} Day Ads-Free (referral reward)` },
      batchDoc: null, pointsCost: 0, pointsRemaining: getSpendablePoints(userId), expiresAt,
    });

    res.json({ success: true, redemptionId: id, rewardType: 'referralAdsFree', daysGranted: REFERRAL_ADSFREE_DAYS, adsFreeExpiresAt: expiresAt, referrals });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET eligible batches — the picker list shown when redeeming a batch-based reward.
// Excludes batches the user already permanently owns (no point wasting points on those).
router.get('/rewards/eligible-batches/:userId', (req, res) => {
  try {
    const userId = req.params.userId;
    const all = db.batch.getAll();
    const eligible = all
      .filter(b => b.isPremium === true && b.isPublic === true)
      .filter(b => b.rewardEligible !== false) // admin has excluded this batch from the points-redeem picker
      .filter(b => !((b.premiumUsers || []).includes(userId))) // already owned permanently — skip
      .map(b => {
        const active = db.batchRewardAccess.findOne(userId, String(b._id));
        return {
          _id: b._id,
          name: b.name,
          pic: b.pic || '',
          price: b.price || 0,
          subjectCount: (b.subjects || []).length,
          redeemCost24h: (b.redeemCost24h !== undefined && b.redeemCost24h !== null) ? b.redeemCost24h : null,
          redeemCost7d: (b.redeemCost7d !== undefined && b.redeemCost7d !== null) ? b.redeemCost7d : null,
          activeRewardExpiresAt: (active && active.expiresAt > new Date()) ? active.expiresAt : null,
        };
      });
    res.json({ batches: eligible });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST redeem — the actual "spend points" action
router.post('/rewards/redeem', async (req, res) => {
  try {
    const { userId, rewardType, batchId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const catalogEntry = REWARD_CATALOG[rewardType];
    if (!catalogEntry) return res.status(400).json({ error: 'Invalid reward type' });

    let batchDoc = null;
    if (rewardType === 'batch24h' || rewardType === 'batch7d') {
      if (!batchId) return res.status(400).json({ error: 'Please select a batch' });
      batchDoc = db.batch.getOne(batchId);
      if (!batchDoc || batchDoc.isPublic !== true) return res.status(404).json({ error: 'Batch not found' });
      if (batchDoc.isPremium !== true) return res.status(400).json({ error: 'This batch is not a premium batch' });
      if (batchDoc.rewardEligible === false) return res.status(400).json({ error: 'Yeh batch points se redeem nahi ho sakta.' });
      if ((batchDoc.premiumUsers || []).includes(userId)) {
        return res.status(400).json({ error: 'Aapke paas already is batch ka full access hai!' });
      }
    }

    // Effective cost: a batch's own redeemCost24h/redeemCost7d override, when set,
    // takes priority over the site-wide REWARD_CATALOG default for that tier.
    let cost = catalogEntry.cost;
    if (batchDoc) {
      const override = rewardType === 'batch7d' ? batchDoc.redeemCost7d : batchDoc.redeemCost24h;
      if (override !== undefined && override !== null) cost = override;
    }

    // ── Critical section: everything below is synchronous SQLite work with no
    // `await` in between, so Node's single-threaded event loop guarantees no
    // other request can interleave here — this is what prevents double-spending
    // points from two rapid clicks / concurrent requests. ──────────────────────
    const spendable = getSpendablePoints(userId);
    if (spendable < cost) {
      return res.status(400).json({ error: `Not enough points! Need ${cost}, you have ${spendable}.`, required: cost, available: spendable });
    }

    let expiresAt;
    const redeemedAt = new Date();
    const runGrant = db.getDb().transaction(() => {
      if (rewardType === 'accessPass') {
        const existing = db.access.findOne(userId);
        const baseTime = (existing && existing.expiresAt > redeemedAt) ? existing.expiresAt : redeemedAt;
        expiresAt = new Date(baseTime.getTime() + catalogEntry.durationMs);
        // Preserve existing ad-claim counters untouched — this reward is independent of the daily ad-claim cap
        db.access.upsert({
          userId, expiresAt,
          claimsToday: existing ? existing.claimsToday : 0,
          claimDay: existing ? existing.claimDay : '',
        });
      } else {
        const existing = db.batchRewardAccess.findOne(userId, String(batchId));
        const baseTime = (existing && existing.expiresAt > redeemedAt) ? existing.expiresAt : redeemedAt;
        expiresAt = new Date(baseTime.getTime() + catalogEntry.durationMs);
        db.batchRewardAccess.upsert({ userId, batchId: String(batchId), batchName: batchDoc.name, expiresAt, grantedAt: redeemedAt });
      }

      // Ledger entry — inserting this row IS the "spend"; balance is always derived, never stored directly
      const id = db.generateId();
      db.rewardRedemption.insert({
        id, userId, rewardType,
        batchId: batchDoc ? String(batchId) : null,
        batchName: batchDoc ? batchDoc.name : '',
        pointsCost: cost, redeemedAt, expiresAt,
      });
      return id;
    });
    const redemptionId = runGrant();
    // ── End critical section ───────────────────────────────────────────────────

    // MongoDB backup — fire and forget, matches existing codebase convention
    RewardRedemption.create({
      userId, rewardType, batchId: batchDoc ? String(batchId) : null,
      batchName: batchDoc ? batchDoc.name : '', pointsCost: cost, redeemedAt, expiresAt,
    }).catch(() => {});
    if (rewardType === 'accessPass') {
      const rec = db.access.findOne(userId);
      Access.findOneAndUpdate({ userId }, { userId, expiresAt: rec.expiresAt, claimsToday: rec.claimsToday, claimDay: rec.claimDay }, { upsert: true }).catch(() => {});
    } else {
      BatchRewardAccess.findOneAndUpdate({ userId, batchId: String(batchId) }, { userId, batchId: String(batchId), batchName: batchDoc.name, expiresAt, grantedAt: redeemedAt }, { upsert: true }).catch(() => {});
    }
    notifyOwnerOfRedemption({
      userId, rewardType, catalogEntry, batchDoc,
      pointsCost: cost, pointsRemaining: spendable - cost, expiresAt,
    });

    res.json({
      success: true,
      redemptionId,
      rewardType,
      label: catalogEntry.label,
      pointsSpent: cost,
      pointsRemaining: spendable - cost,
      expiresAt,
      batchId: batchDoc ? String(batchId) : null,
      batchName: batchDoc ? batchDoc.name : null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET redemption history — powers a "My Redeemed Rewards" list in the UI
router.get('/rewards/history/:userId', (req, res) => {
  try {
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    const history = db.rewardRedemption.history(req.params.userId, limit);
    res.json({ history });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Spin & Earn ───────────────────────────────────────────────────────────────
// A daily spin-the-wheel mini-game. Every spin MUST be preceded by watching a
// full rewarded ad — enforced with the exact same token-issue-then-verify
// pattern already used by the Access tab's ad flow (see /access/token and
// /access/claim above), just on its own separate table so the two ad flows
// can never interfere with each other. The wheel result (1-5 points) is always
// generated server-side — the client only ever animates to whatever result
// the server already committed to the database.

const spinHistorySchema = new mongoose.Schema({
  userId: { type: String, required: true },
  pointsWon: { type: Number, required: true },
  spunAt: { type: Date, default: Date.now },
});
spinHistorySchema.index({ userId: 1 });
const SpinHistory = mongoose.models.SpinHistory || mongoose.model('SpinHistory', spinHistorySchema);

function _todayMidnightMs() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Single source of truth for "can this user spin right now" — used by all 3 endpoints below
function getSpinStatus(userId) {
  const spinsToday = db.spinHistory.countSince(userId, _todayMidnightMs());
  // Admin-adjustable on top of the global default (see /addspins in server.js) —
  // e.g. a user with +3 gets 8 spins/day, one with -2 gets 3/day, floor 0.
  const netAdjustment = db.spinAdjustment.netForUser(userId);
  const maxSpins = Math.max(0, getSpinDailyLimit() + netAdjustment);
  const spinsLeft = Math.max(0, maxSpins - spinsToday);
  const last = db.spinHistory.lastSpinAt(userId);
  const cooldownRemainingMs = last ? Math.max(0, SPIN_COOLDOWN_MS - (Date.now() - last.getTime())) : 0;
  const nextResetAt = new Date(_todayMidnightMs() + 24 * 60 * 60 * 1000);
  return {
    spinsToday, spinsLeft, maxSpins,
    cooldownRemainingMs, canSpin: spinsLeft > 0 && cooldownRemainingMs <= 0,
    nextResetAt,
  };
}

// GET status — powers the Earn tab's UI (spins left, cooldown countdown, spin button enabled/disabled)
router.get('/spin/status/:userId', (req, res) => {
  try { res.json(getSpinStatus(req.params.userId)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// POST token — issued right before the ad plays; must be redeemed via /spin/claim afterwards
router.post('/spin/token/:userId', (req, res) => {
  try {
    const userId = req.params.userId;
    const status = getSpinStatus(userId);
    if (!status.canSpin) {
      if (status.spinsLeft <= 0) return res.status(429).json({ error: `Aaj ke saare ${status.maxSpins} spins ho gaye! Kal wapas aao.`, ...status });
      return res.status(429).json({ error: `Thoda ruko! Agla spin ${Math.ceil(status.cooldownRemainingMs / 1000)}s mein.`, ...status });
    }

    db.spinToken.deleteByUser(userId); // one live spin-token per user at a time, same as adToken

    const token = crypto.randomBytes(32).toString('hex');
    const issuedAt = new Date();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    db.spinToken.create({ id: db.generateId(), userId, token, issuedAt, expiresAt });

    res.json({ token });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST claim — verifies the ad was actually watched (min elapsed time, same as access/claim),
// re-checks the daily limit + cooldown fresh (defends against races/stale client state),
// then rolls the wheel server-side and records the spin.
router.post('/spin/claim/:userId', (req, res) => {
  try {
    const userId = req.params.userId;
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token required' });

    const record = db.spinToken.findOne({ userId, token });
    if (!record) return res.status(403).json({ error: 'Invalid or expired spin. Please try again.' });
    if (record.expiresAt < new Date()) { db.spinToken.deleteById(record.id); return res.status(403).json({ error: 'Spin expired. Please try again.' }); }
    const elapsed = (Date.now() - record.issuedAt.getTime()) / 1000;
    if (elapsed < SPIN_AD_WATCH_SECONDS) return res.status(403).json({ error: 'You skipped the ad too soon! Please watch it fully (at least 10 seconds) to get your spin.' });

    // ── Critical section: everything below is synchronous, no await in between,
    // so no concurrent request can double-spend this spin (same reasoning as
    // the reward-redeem endpoint's critical section). ─────────────────────────
    const status = getSpinStatus(userId);
    if (!status.canSpin) {
      db.spinToken.deleteById(record.id);
      if (status.spinsLeft <= 0) return res.status(429).json({ error: `Aaj ke saare ${status.maxSpins} spins ho gaye! Kal wapas aao.`, ...status });
      return res.status(429).json({ error: `Thoda ruko! Agla spin ${Math.ceil(status.cooldownRemainingMs / 1000)}s mein.`, ...status });
    }

    db.spinToken.deleteById(record.id);

    const pointsWon = 1 + Math.floor(Math.random() * 5); // uniform 1-5, decided server-side only
    const spunAt = new Date();
    db.spinHistory.insert({ id: db.generateId(), userId, pointsWon, spunAt });
    // ── End critical section ───────────────────────────────────────────────────

    SpinHistory.create({ userId, pointsWon, spunAt }).catch(() => {}); // Mongo backup, fire-and-forget

    const newStatus = getSpinStatus(userId);
    res.json({ pointsWon, ...newStatus });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Watched Lectures ────────────────────────────────────────────────────────────
// Server-side "have I seen this" marker, keyed by the stable Telegram userId.
// Deliberately NOT browser localStorage — this app is often served from a
// rotating tunnel URL (a new origin on every redeploy), which would silently
// wipe any localStorage-based state. A DB row keyed by userId survives that,
// device switches, and cache clears.

const watchedLectureSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  lectureId: { type: String, required: true },
  watchedAt: { type: Date, default: Date.now },
});
watchedLectureSchema.index({ userId: 1, lectureId: 1 }, { unique: true });
const WatchedLecture = mongoose.models.WatchedLecture || mongoose.model('WatchedLecture', watchedLectureSchema);

// ── Giveaway invite confirmation ────────────────────────────────────────────
// Giveaway/GiveawayParticipant are registered earlier in server.js (before this
// file is require()'d), so mongoose.model(name) below just retrieves them —
// no schema is redefined here, keeping a single source of truth.
const giveawayInviteSchema = new mongoose.Schema({
  giveawayId: { type: mongoose.Schema.Types.ObjectId, required: true },
  inviterId: { type: Number, required: true },
  inviteeId: { type: Number, required: true },
  status: { type: String, enum: ["pending","confirmed","reversed"], default: "pending" },
  confirmedAt: { type: Date, default: null },
  reversedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
});
giveawayInviteSchema.index({ giveawayId: 1, inviteeId: 1 }, { unique: true });
const GiveawayInvite = mongoose.models.GiveawayInvite || mongoose.model('GiveawayInvite', giveawayInviteSchema);

function _giveawayName(u) { if (!u) return null; return u.username ? `@${u.username}` : (u.firstName || `User ${u.userId}`); }

// Called the first time a user ever marks any lecture watched. Confirms their
// pending invite (if any) so the inviter's giveaway count only goes up once
// there's real engagement, not just a /start tap — this is what keeps fake
// "joined but never used the bot" referrals from counting.
async function confirmGiveawayInviteOnFirstWatch(userId) {
  try {
    const Giveaway = mongoose.model('Giveaway');
    const GiveawayParticipant = mongoose.model('GiveawayParticipant');
    const User = mongoose.model('User');
    const giveaway = await Giveaway.findOne({ status: 'active' }).sort({ startedAt: -1 });
    if (!giveaway) return;
    const inviteeNum = Number(userId);
    const invite = await GiveawayInvite.findOne({ giveawayId: giveaway._id, inviteeId: inviteeNum, status: 'pending' });
    if (!invite) return;
    invite.status = 'confirmed'; invite.confirmedAt = new Date();
    await invite.save();
    const participant = await GiveawayParticipant.findOneAndUpdate(
      { giveawayId: giveaway._id, userId: invite.inviterId },
      { $inc: { invites: 1 } },
      { new: true }
    );
    if (!participant || !_bot) return;
    const inviteeUser = await User.findOne({ userId: String(inviteeNum) }).catch(() => null);
    const inviteeName = _giveawayName(inviteeUser) || `User ${inviteeNum}`;
    _bot.sendMessage(invite.inviterId, `✅ <b>Referral Confirmed</b>\n\n${inviteeName} has watched their first lecture — this referral is now confirmed.\nUpdated Confirmed Invites: <b>${participant.invites}</b>`, { parse_mode: 'HTML' }).catch(() => {});
    if (OWNER_ID) {
      const inviterUser = await User.findOne({ userId: String(invite.inviterId) }).catch(() => null);
      const inviterName = _giveawayName(inviterUser) || `User ${invite.inviterId}`;
      _bot.sendMessage(OWNER_ID, `📈 <b>Giveaway — Referral Confirmed</b>\n\nInviter: ${inviterName} (<code>${invite.inviterId}</code>)\nInvitee: ${inviteeName} (<code>${inviteeNum}</code>)\nInviter's updated invite count: <b>${participant.invites}</b>`, { parse_mode: 'HTML' }).catch(() => {});
    }
  } catch (e) { console.error('Giveaway confirm error:', e.message); }
}

// ── Multi-account (shared device/IP) detection ──────────────────────────────
// Telegram's Bot API never exposes device info or IP to the bot side — this
// signal only exists because the Mini App talks to our own server over HTTP,
// so every /device-check call legitimately carries the caller's real IP
// (given app.set('trust proxy', true) in server.js) plus a browser fingerprint
// the frontend computes locally. Fingerprint match = high confidence (same
// physical device/browser); IP-only match = lower confidence (could just be
// shared WiFi/hostel/college NAT) — the alert says which one fired so the
// owner can judge for themselves. This is a heuristic for manual review, not
// an auto-ban trigger.
const DEVICE_CORRELATION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const DEVICE_RETENTION_MS = 45 * 24 * 60 * 60 * 1000; // prune buffer

function checkMultiAccount(userId, fingerprint, ip, fromUser) {
  try {
    const uidStr = String(userId);
    const beforeFp = fingerprint ? db.deviceSighting.distinctUsersForFingerprint(fingerprint, DEVICE_CORRELATION_WINDOW_MS) : [];
    const beforeIp = ip ? db.deviceSighting.distinctUsersForIp(ip, DEVICE_CORRELATION_WINDOW_MS) : [];
    const wasNewToFp = fingerprint && !beforeFp.some(r => r.userId === uidStr);
    const wasNewToIp = ip && !beforeIp.some(r => r.userId === uidStr);

    db.deviceSighting.insert({ id: db.generateId(), userId: uidStr, fingerprint, ip, seenAt: Date.now() });
    db.deviceSighting.pruneOlderThan(DEVICE_RETENTION_MS);

    if (!OWNER_ID || !_bot) return;
    // Nothing new to report — this exact userId was already part of both
    // clusters before this request, so re-alerting would just be noise.
    if (!wasNewToFp && !wasNewToIp) return;

    // Re-fetch AFTER the insert so the lists below include this request too.
    const afterFp = wasNewToFp ? db.deviceSighting.distinctUsersForFingerprint(fingerprint, DEVICE_CORRELATION_WINDOW_MS) : null;
    const afterIp = wasNewToIp ? db.deviceSighting.distinctUsersForIp(ip, DEVICE_CORRELATION_WINDOW_MS) : null;
    const fpQualifies = afterFp && afterFp.length >= 2;
    const ipQualifies = afterIp && afterIp.length >= 2;
    if (!fpQualifies && !ipQualifies) return;

    sendMultiAccountAlert(fpQualifies ? afterFp : null, ipQualifies ? afterIp : null);
  } catch (err) { console.error("Multi-account check error:", err.message); }
}

// Formats the FULL member list for a cluster (every account currently sharing
// that device/IP, not just the newest one) — name, username, and userId each.
function _formatAccountList(accounts) {
  const rows = accounts.slice(0, 15).map(a => {
    const u = db.user.findOne(a.userId);
    const label = u ? ([u.firstName, u.lastName].filter(Boolean).join(' ').trim() || `User ${a.userId}`) + (u.username ? ` (@${u.username})` : '') : `User ${a.userId}`;
    return `• ${esc(label)} — <code>${a.userId}</code>`;
  });
  if (accounts.length > 15) rows.push(`…and ${accounts.length - 15} more`);
  return rows.join("\n");
}

// One combined message per event — clearly separated "Same Device" and "Same
// IP" sections (never mixed into one list), each listing every account
// currently in that cluster so the owner sees the full picture at a glance.
function sendMultiAccountAlert(deviceAccounts, ipAccounts) {
  try {
    let text = `👥 <b>Possible Multi-Account Detected</b>\n\n`;
    if (deviceAccounts) {
      text += `🔴 <b>Same Device</b> — ${deviceAccounts.length} accounts:\n${_formatAccountList(deviceAccounts)}\n\n`;
    }
    if (ipAccounts) {
      text += `🟡 <b>Same IP Address</b> — ${ipAccounts.length} accounts (could be shared WiFi/network):\n${_formatAccountList(ipAccounts)}\n\n`;
    }
    _bot.sendMessage(OWNER_ID, text.trim(), { parse_mode: "HTML" }).catch(() => {});
  } catch (err) { console.error("Multi-account alert error:", err.message); }
}

// POST — called once per app session by the frontend with a computed device
// fingerprint. Records this sighting (userId + fingerprint + real IP) and
// alerts the owner if it newly links this account to another one on the same
// device or IP. Always responds 200 even on internal failure — this must
// never block the app from loading for the user.
router.post('/device-check', (req, res) => {
  try {
    const userId = getRequestUserId(req);
    if (!userId) return res.json({ ok: false });
    const fingerprint = String(req.body?.fingerprint || '').slice(0, 128);
    // req.ip resolves the real client IP from X-Forwarded-For because
    // server.js sets app.set('trust proxy', true).
    const ip = String(req.ip || req.connection?.remoteAddress || '').slice(0, 64);
    const u = db.user.findOne(userId);
    checkMultiAccount(userId, fingerprint, ip, { id: userId, username: u?.username, first_name: u?.firstName });
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false }); }
});

// GET — is the current user (identified via verified initData) banned?
// Uses getRequestUserId (verified initData), not a raw :userId param, so a user
// can't probe someone else's ban status by guessing IDs. Deliberately does NOT
// return the ban reason — that's internal admin context (e.g. "3+ requests in
// 5 min") and telling a banned user the exact detection rule just teaches them
// how to stay under it next time.
router.get('/banned/me', (req, res) => {
  try {
    const userId = getRequestUserId(req);
    if (!userId) return res.json({ banned: false });
    const banned = db.bannedUser.isBanned(userId);
    res.json({ banned });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET — is the current user exempt from the ad-blocker hard-block gate?
// Owner is exempt automatically on the frontend before this is ever called;
// this covers the additional per-user exemption list (/exemptads command).
router.get('/adblock-exempt/me', (req, res) => {
  try {
    const userId = getRequestUserId(req);
    if (!userId) return res.json({ exempt: false });
    res.json({ exempt: db.adblockExempt.isExempt(userId) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET — full list of lectureIds this user has marked watched
router.get('/watched/:userId', (req, res) => {
  try {
    const watched = db.watchedLecture.listByUser(req.params.userId);
    res.json({ watched });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST — mark or unmark a single lecture as watched
router.post('/watched/:userId', (req, res) => {
  try {
    const userId = req.params.userId;
    const { lectureId, watched } = req.body;
    if (!lectureId) return res.status(400).json({ error: 'lectureId required' });

    if (watched === false) {
      db.watchedLecture.unmark(userId, lectureId);
      WatchedLecture.deleteOne({ userId, lectureId }).catch(() => {});
    } else {
      const hadWatchedBefore = db.watchedLecture.listByUser(userId).length > 0;
      db.watchedLecture.mark(userId, lectureId);
      WatchedLecture.updateOne({ userId, lectureId }, { userId, lectureId, watchedAt: new Date() }, { upsert: true }).catch(() => {});
      if (!hadWatchedBefore) confirmGiveawayInviteOnFirstWatch(userId);
    }
    res.json({ success: true, lectureId, watched: watched !== false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET — giveaway status for the webapp: whether one is live, and if this user
// is participating, their invite count/rank (mirrors the bot's /myscore).
router.get('/giveaway/status/:userId', async (req, res) => {
  try {
    const Giveaway = mongoose.model('Giveaway');
    const GiveawayParticipant = mongoose.model('GiveawayParticipant');
    const giveaway = await Giveaway.findOne({ status: 'active' }).sort({ startedAt: -1 });
    if (!giveaway) return res.json({ active: false });
    const userId = Number(req.params.userId);
    const participant = await GiveawayParticipant.findOne({ giveawayId: giveaway._id, userId });
    if (!participant) return res.json({ active: true, participating: false, giveawayId: String(giveaway._id) });
    const higher = await GiveawayParticipant.countDocuments({ giveawayId: giveaway._id, $or: [ { invites: { $gt: participant.invites } }, { invites: participant.invites, joinedAt: { $lt: participant.joinedAt } } ] });
    res.json({ active: true, participating: true, invites: participant.invites, rank: higher + 1, giveawayId: String(giveaway._id) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Force Join ────────────────────────────────────────────────────────────────

function getForceJoinChannels() {
  const ids = (process.env.FORCE_JOIN_CHANNELS||'').split(',').map(s => s.trim()).filter(Boolean);
  const names = (process.env.FORCE_JOIN_CHANNEL_NAMES||'').split(',').map(s => s.trim());
  const links = (process.env.FORCE_JOIN_CHANNEL_LINKS||'').split(',').map(s => s.trim());
  return ids.map((id, i) => ({ id, name: names[i]||('Channel '+(i+1)), link: links[i]||null }));
}

router.get('/force-join/channels', (req, res) => {
  const channels = getForceJoinChannels();
  res.json({ channels, required: channels.length > 0 });
});

const _channelInfoCache = new Map();
async function getChannelInfo(chatId, botToken) {
  const now = Date.now();
  const cached = _channelInfoCache.get(chatId);
  if (cached && now - cached.cachedAt < 10 * 60 * 1000) return cached;
  try {
    const chatRes = await fetch(`https://api.telegram.org/bot${botToken}/getChat?chat_id=${encodeURIComponent(chatId)}`);
    const chatData = await chatRes.json();
    const chat = chatData.ok ? chatData.result : null;
    const title = chat ? (chat.title||chat.first_name||'') : '';
    const username = chat ? (chat.username||'') : '';
    let photoUrl = null;
    if (chat && chat.photo && chat.photo.small_file_id) {
      try {
        const fileRes = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(chat.photo.small_file_id)}`);
        const fileData = await fileRes.json();
        if (fileData.ok && fileData.result && fileData.result.file_path) photoUrl = `https://api.telegram.org/file/bot${botToken}/${fileData.result.file_path}`;
      } catch (_) {}
    }
    const redirectLink = username ? `https://t.me/${username}` : (chat && chat.invite_link ? chat.invite_link : null);
    const info = { title, username, photoUrl, redirectLink, cachedAt: now };
    _channelInfoCache.set(chatId, info);
    return info;
  } catch (e) { return { title: '', username: '', photoUrl: null, redirectLink: null, cachedAt: now }; }
}

router.post('/force-join/check', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const channels = getForceJoinChannels();
  if (!channels.length) return res.json({ allJoined: true, channels: [] });
  const BOT_TOKEN = process.env.BOT_TOKEN;
  if (!BOT_TOKEN) return res.status(500).json({ error: 'BOT_TOKEN not set' });
  const results = await Promise.all(channels.map(async (ch) => {
    const [memberData, info] = await Promise.all([
      fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(ch.id)}&user_id=${encodeURIComponent(userId)}`).then(r => r.json()).catch(() => ({})),
      getChannelInfo(ch.id, BOT_TOKEN),
    ]);
    const status = memberData.result && memberData.result.status;
    const joined = ['member','administrator','creator'].includes(status);
    return { id: ch.id, name: ch.name !== ('Channel '+(channels.indexOf(ch)+1)) ? ch.name : (info.title||ch.name), link: ch.link||info.redirectLink||null, photoUrl: info.photoUrl||null, joined, status: status||'not_member' };
  }));
  res.json({ allJoined: results.every(c => c.joined), channels: results });
});

// ── Auto-Lecture ──────────────────────────────────────────────────────────────

router.get('/auto-lecture/status', verifyAdmin, (req, res) => { res.json(autoLectureSession); });

router.post('/auto-lecture/start', verifyAdmin, async (req, res) => {
  const { batchId, subjectId, chapterId, unitId, batchName, subjectName, chapterName, unitName } = req.body;
  if (!batchId || !subjectId || !chapterId) return res.status(400).json({ error: 'batchId, subjectId, chapterId required' });
  try {
    const batchData = db.batch.getOne(batchId);
    const subj = batchData && (batchData.subjects||[]).find(s => String(s._id)===subjectId);
    const chap = subj && (subj.chapters||[]).find(c => String(c._id)===chapterId);
    if (!chap) return res.status(404).json({ error: 'Chapter not found' });
    let existingCount = unitId ? ((chap.units||[]).find(u => String(u._id)===unitId)?.lectures||[]).length : (chap.lectures||[]).length;
    Object.assign(autoLectureSession, { active: true, batchId, subjectId, chapterId, unitId: unitId||null, lectureCount: existingCount, batchName: batchName||'', subjectName: subjectName||'', chapterName: chapterName||'', unitName: unitName||'' });
    await _saveAutoSession();
    res.json({ success: true, session: autoLectureSession });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/auto-lecture/stop', verifyAdmin, async (req, res) => {
  const totalAdded = autoLectureSession.lectureCount;
  Object.assign(autoLectureSession, { active: false, batchId: null, subjectId: null, chapterId: null, unitId: null, lectureCount: 0, batchName: '', subjectName: '', chapterName: '', unitName: '' });
  await _saveAutoSession();
  res.json({ success: true, totalAdded });
});

router.autoLectureSession = autoLectureSession;
router.autoAddLecture = autoAddLecture;
router.saveAutoSession = _saveAutoSession;

// ── Stats ─────────────────────────────────────────────────────────────────────

router.get('/stats', (req, res) => {
  try {
    const batches = db.batch.getAll();
    const totalBatches = batches.length;
    const publicBatches = batches.filter(b => b.isPublic).length;
    let totalSubjects=0, totalChapters=0, totalLectures=0, totalPremiumUnlocks=0;
    batches.forEach(b => {
      totalPremiumUnlocks += (b.premiumUsers||[]).length;
      totalSubjects += (b.subjects||[]).length;
      (b.subjects||[]).forEach(s => {
        totalChapters += (s.chapters||[]).length;
        (s.chapters||[]).forEach(c => {
          totalLectures += (c.lectures||[]).length;
          (c.units||[]).forEach(u => { totalLectures += (u.lectures||[]).length; });
        });
      });
    });

    // File store health: how many stored files have a channel backup (can survive
    // a bot-token switch via /migrate) vs ones that don't (would need re-upload
    // if their file_id ever goes bad).
    const singleTotal = db.fileRecord.count();
    const singleWithBackup = db.fileRecord.findAllWithChannelMsg().length;
    const allBulkBatches = db.bulkBatch.findAll();
    let bulkFileTotal=0, bulkFileWithBackup=0;
    allBulkBatches.forEach(b => { (b.files||[]).forEach(f => { bulkFileTotal++; if (f.channel_msg_id) bulkFileWithBackup++; }); });

    const coupons = db.coupon.getAll();
    const activeCoupons = coupons.filter(c => c.isActive && c.expiresAt.getTime() > Date.now()).length;

    const now = Date.now();
    res.json({
      content: { totalBatches, publicBatches, privateBatches: totalBatches - publicBatches, totalSubjects, totalChapters, totalLectures, totalPremiumUnlocks },
      users: {
        totalUsers: db.user.count(),
        recentUsers: db.user.countSince(now - 7*24*60*60*1000),
        newToday: db.user.countSince(now - 24*60*60*1000),
      },
      access: {
        totalAccess: db.access.count(),
        activeAccess: db.access.countActive(),
        grantedToday: db.access.countClaimedOnDay(new Date().toISOString().slice(0, 10)),
      },
      referrals: (() => {
        const totalReferrals = db.referral.count();
        const uniqueReferrers = db.referral.distinctReferrers();
        const top5 = db.referral.topReferrers(5).map((r) => {
          const u = db.user.findOne(r.referrerId);
          const name = u ? (u.firstName || u.username || `User ${r.referrerId}`) : `User ${r.referrerId}`;
          return { userId: r.referrerId, name, count: r.c };
        });
        return {
          totalReferrals,
          uniqueReferrers,
          referralsToday: db.referral.countSince(now - 24*60*60*1000),
          referralsThisWeek: db.referral.countSince(now - 7*24*60*60*1000),
          avgPerReferrer: uniqueReferrers > 0 ? +(totalReferrals / uniqueReferrers).toFixed(1) : 0,
          totalPointsEarned: totalReferrals * POINTS_PER_REFERRAL,
          topReferrers: top5,
        };
      })(),
      spinWheel: {
        spinsToday: db.spinHistory.countSinceGlobal(now - 24*60*60*1000),
        totalSpinners: db.spinHistory.distinctSpinners(),
        totalPtsEarned: db.spinHistory.totalEarnedGlobal(),
        totalPtsRedeemed: db.rewardRedemption.totalSpentGlobal(),
      },
      fileStore: {
        singleFiles: singleTotal,
        singleFilesWithBackup: singleWithBackup,
        singleFilesNoBackup: singleTotal - singleWithBackup,
        bulkBatches: allBulkBatches.length,
        bulkFiles: bulkFileTotal,
        bulkFilesWithBackup: bulkFileWithBackup,
        bulkFilesNoBackup: bulkFileTotal - bulkFileWithBackup,
      },
      rewards: {
        totalRedemptions: db.rewardRedemption.count(),
        activeBatchUnlocks: db.batchRewardAccess.countActive(),
      },
      coupons: { total: coupons.length, active: activeCoupons },
      pendingDeletes: db.pendingDelete.getAll().length,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ── Coupons ───────────────────────────────────────────────────────────────────

const couponSchema = new mongoose.Schema({ code: { type: String, required: true, unique: true, uppercase: true, trim: true }, discountPct: { type: Number, required: true }, expiresAt: { type: Date, required: true }, isActive: { type: Boolean, default: true }, usageCount: { type: Number, default: 0 }, batchIds: [{ type: String }], createdAt: { type: Date, default: Date.now } });
const Coupon = mongoose.model('Coupon', couponSchema);

router.get('/coupons', verifyAdmin, (req, res) => {
  try { res.json(db.coupon.getAll()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/coupons', verifyAdmin, async (req, res) => {
  try {
    const { code, discountPct, expiresAt, isActive, batchIds } = req.body;
    if (!code || !discountPct || !expiresAt) return res.status(400).json({ error: 'code, discountPct, expiresAt required' });
    // Write to MongoDB to get _id
    const c = await Coupon.create({ code: code.toUpperCase().trim(), discountPct: Number(discountPct), expiresAt: new Date(expiresAt), isActive: isActive!==false, batchIds: Array.isArray(batchIds) ? batchIds.filter(Boolean) : [] });
    db.coupon.insert({ id: String(c._id), code: c.code, discountPct: c.discountPct, expiresAt: c.expiresAt, isActive: c.isActive, batchIds: c.batchIds, createdAt: c.createdAt });
    res.json(db.coupon.findById(String(c._id)));
  } catch (e) {
    if (e.code === 11000) return res.status(400).json({ error: 'Coupon code already exists' });
    res.status(500).json({ error: e.message });
  }
});

router.delete('/coupons/:id', verifyAdmin, async (req, res) => {
  try {
    await Coupon.findByIdAndDelete(req.params.id);
    db.coupon.delete(req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/coupons/:id/toggle', verifyAdmin, async (req, res) => {
  try {
    const c = db.coupon.toggle(req.params.id);
    if (!c) return res.status(404).json({ error: 'Not found' });
    // MongoDB backup
    Coupon.findByIdAndUpdate(req.params.id, { isActive: c.isActive }).catch(() => {});
    res.json(c);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/coupons/validate', (req, res) => {
  try {
    const { code, batchId } = req.body;
    if (!code) return res.status(400).json({ error: 'code required' });
    const coupon = db.coupon.findByCode(code);
    if (!coupon) return res.status(404).json({ error: 'Invalid coupon code' });
    if (!coupon.isActive) return res.status(400).json({ error: 'Coupon is inactive' });
    if (coupon.expiresAt < new Date()) return res.status(400).json({ error: 'Coupon has expired' });
    if (coupon.batchIds && coupon.batchIds.length > 0) {
      if (!batchId || !coupon.batchIds.includes(String(batchId))) return res.status(400).json({ error: 'This coupon is not valid for this batch' });
    }
    res.json({ valid: true, discountPct: coupon.discountPct, code: coupon.code });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.getPointsBreakdown = getPointsBreakdown;
module.exports.POINTS_PER_REFERRAL = POINTS_PER_REFERRAL;
module.exports.setBot = setBot;
module.exports.setGrantAdsFreeAccess = setGrantAdsFreeAccess;
module.exports.getSpinStatus = getSpinStatus;
module.exports.getSpinDailyLimit = getSpinDailyLimit;
