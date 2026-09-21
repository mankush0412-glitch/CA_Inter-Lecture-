const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const mongoose = require("mongoose");
const Batch = require("../models/Course");
const db = require("../sqlite-manager");

const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_ID = parseInt(process.env.OWNER_ID || "0");
// Set by server.js once the bot is initialized (bot doesn't exist yet at require-time),
// so giveaway confirmation/reversal notifications can be sent from here.
let _bot = null;
function setBot(botInstance) { _bot = botInstance; }

// ── Ban / abuse moderation ──────────────────────────────────────────────────
// User model is registered in server.js (loaded before this router), same
// pattern as the Giveaway models used further down this file.
async function isUserBanned(userId) {
  try {
    const User = mongoose.model('User');
    const user = await User.findOne({ userId: String(userId) }).select('banned banReason').lean();
    return user && user.banned ? (user.banReason || 'Unusual activity detected') : null;
  } catch (e) { return null; } // fail open — a lookup error shouldn't lock out legitimate users
}

// ── Suspicious activity flagging ────────────────────────────────────────────
// Automatic, velocity-based detection — NOT auto-ban. Crossing a threshold
// just raises a flag for a human admin to review (via the Users tab or the
// Telegram alert), because automatically banning on a heuristic risks locking
// out real users who just happen to be popular referrers, active on launch
// day, etc. The admin always makes the final call.
const suspiciousActivitySchema = new mongoose.Schema({
  userId: { type: String, required: true },
  type: { type: String, required: true },      // 'referral_velocity' | 'giveaway_invite_velocity'
  details: { type: String, default: '' },
  reviewed: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});
const SuspiciousActivity = mongoose.model('SuspiciousActivity', suspiciousActivitySchema);

async function flagSuspicious(userId, type, details) {
  try {
    await SuspiciousActivity.create({ userId: String(userId), type, details });
    if (_bot && OWNER_ID) {
      _bot.sendMessage(OWNER_ID,
        `⚠️ <b>Suspicious Activity Flagged</b>\n\nUser: <code>${userId}</code>\nType: ${type}\n${details}\n\nCheck Admin Panel → 🚫 Users tab to review/ban.`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }
  } catch (e) { console.error('flagSuspicious error:', e.message); }
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

  // Write to MongoDB (source of truth backup)
  const mongoBatch = await Batch.findById(batchId);
  if (mongoBatch) {
    const ms = mongoBatch.subjects.id(subjectId);
    const mc = ms && ms.chapters.id(chapterId);
    if (mc) {
      if (unitId) { const mu = mc.units.id(unitId); if (mu) mu.lectures.push({ name, link, notes: '', order: mu.lectures.length, isDemo: false }); }
      else mc.lectures.push({ name, link, notes: '', order: mc.lectures.length, isDemo: false });
      await mongoBatch.save();
    }
  }
}

// ── Batches ───────────────────────────────────────────────────────────────────

router.get("/batches", async (req, res) => {
  try {
    const admin = isAdminRequest(req);
    // Admin: fresh from MongoDB
    if (admin) { return res.json(await Batch.find({}).sort({ order: 1 })); }

    // Users: from SQLite ⚡
    const batches = db.batch.getAll();
    const userId = getRequestUserId(req);
    res.json(batches.map(b => {
      if (!b.isPremium) return b;
      return hasPremiumAccess(userId, b) ? b : stripPremiumLinks(b);
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/batches/:bid", async (req, res) => {
  try {
    const admin = isAdminRequest(req);
    if (admin) {
      const b = await Batch.findById(req.params.bid);
      if (!b) return res.status(404).json({ error: "Not found" });
      return res.json(b.toObject());
    }
    const b = db.batch.getOne(req.params.bid);
    if (!b) return res.status(404).json({ error: "Not found" });
    const userId = getRequestUserId(req);
    const userHasAccess = hasPremiumAccess(userId, b);
    res.json(b.isPremium && !userHasAccess ? stripPremiumLinks(b) : b);
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
    const batch = await Batch.create({ name: req.body.name, pic: req.body.pic||"", description: req.body.description||"", order: count, isPublic: false, isPremium: req.body.isPremium===true, premiumUsers: [], price: req.body.price ? Number(req.body.price) : 0, rewardEligible: req.body.rewardEligible !== false, redeemCost24h: (req.body.redeemCost24h !== undefined && req.body.redeemCost24h !== null) ? Number(req.body.redeemCost24h) : null, redeemCost7d: (req.body.redeemCost7d !== undefined && req.body.redeemCost7d !== null) ? Number(req.body.redeemCost7d) : null });
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
    const rewardAccess = db.batchRewardAccess.findOne(userId, String(b._id));
    const rewardActive = !!rewardAccess && rewardAccess.expiresAt > new Date();
    res.json({
      hasAccess: isPermanent || rewardActive,
      isPremium: b.isPremium===true,
      isPermanent,
      rewardAccessExpiresAt: rewardActive ? rewardAccess.expiresAt : null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
    const banReason = await isUserBanned(userId);
    if (banReason) return res.status(403).json({ error: `Aapka account suspend hai: ${banReason}`, banned: true });
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
    const banReason = await isUserBanned(userId);
    if (banReason) return res.status(403).json({ error: `Aapka account suspend hai: ${banReason}`, banned: true });
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: "Token required" });

    const record = db.adToken.findOne({ userId, token });
    if (!record) return res.status(403).json({ error: "Invalid or expired token. Please watch the ad again." });
    if (record.expiresAt < new Date()) return res.status(403).json({ error: "Token expired. Please watch the ad again." });
    const elapsed = (Date.now() - new Date(record.issuedAt)) / 1000;
    if (elapsed < 15) return res.status(403).json({ error: "Ad not fully watched. Please wait..." });

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

    // Velocity check: 5+ new referrals from the same referrer within an hour
    // is a strong farming signal (real organic sharing rarely lands this fast).
    const recentCount = db.referral.countByReferrerSince(referrerId, Date.now() - 60 * 60 * 1000);
    if (recentCount >= 5) {
      flagSuspicious(referrerId, 'referral_velocity', `${recentCount} referrals confirmed in the last hour.`);
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

// Reward catalog — single source of truth for cost + duration of every reward.
// To add a new reward in future, just add an entry here (and a matching branch
// in the redeem handler below if it needs special grant logic).
// Each successful referral is worth this many points (single source of truth —
// change this one number to adjust the referral reward economy).
const POINTS_PER_REFERRAL = 5;

// Spin & Earn tab configuration
const SPIN_DAILY_LIMIT = 5;
const SPIN_COOLDOWN_MS = 10 * 1000;
const SPIN_AD_WATCH_SECONDS = 2; // NOTE: lower than access/claim's 15s on purpose — that flow has a manual
// "Claim" button tap AFTER the ad finishes (adding natural delay on top of ad duration), but spins
// auto-chain claim immediately once the ad SDK's promise resolves, so elapsed here is essentially just
// the ad's own playback time. Many ad formats (pop/interstitial) resolve in well under 15s, so keeping
// that threshold here would silently reject every legitimate spin. 2s still blocks trivial direct-API
// abuse that skips the ad SDK entirely.

const REWARD_CATALOG = {
  accessPass: { cost: 5, durationMs: 24 * 60 * 60 * 1000, label: '24 Hour Site Access' },
  batch24h: { cost: 10, durationMs: 24 * 60 * 60 * 1000, label: '24 Hour Premium Batch Access' },
  batch7d: { cost: 50, durationMs: 7 * 24 * 60 * 60 * 1000, label: '7 Day Premium Batch Access' },
};

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

    res.json({ referrals, spent, points, accessPass, activeBatchRewards, catalog: REWARD_CATALOG });
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
    const banReason = await isUserBanned(userId);
    if (banReason) return res.status(403).json({ error: `Aapka account suspend hai: ${banReason}`, banned: true });
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
  const spinsLeft = Math.max(0, SPIN_DAILY_LIMIT - spinsToday);
  const last = db.spinHistory.lastSpinAt(userId);
  const cooldownRemainingMs = last ? Math.max(0, SPIN_COOLDOWN_MS - (Date.now() - last.getTime())) : 0;
  const nextResetAt = new Date(_todayMidnightMs() + 24 * 60 * 60 * 1000);
  return {
    spinsToday, spinsLeft, maxSpins: SPIN_DAILY_LIMIT,
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
router.post('/spin/token/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    const banReason = await isUserBanned(userId);
    if (banReason) return res.status(403).json({ error: `Aapka account suspend hai: ${banReason}`, banned: true });
    const status = getSpinStatus(userId);
    if (!status.canSpin) {
      if (status.spinsLeft <= 0) return res.status(429).json({ error: 'Aaj ke saare 5 spins ho gaye! Kal wapas aao.', ...status });
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
router.post('/spin/claim/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    const banReason = await isUserBanned(userId);
    if (banReason) return res.status(403).json({ error: `Aapka account suspend hai: ${banReason}`, banned: true });
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token required' });

    const record = db.spinToken.findOne({ userId, token });
    if (!record) return res.status(403).json({ error: 'Invalid or expired spin. Please try again.' });
    if (record.expiresAt < new Date()) { db.spinToken.deleteById(record.id); return res.status(403).json({ error: 'Spin expired. Please try again.' }); }
    const elapsed = (Date.now() - record.issuedAt.getTime()) / 1000;
    if (elapsed < SPIN_AD_WATCH_SECONDS) return res.status(403).json({ error: 'Ad poori dekho pehle! Spin count nahi hoga.' });

    // ── Critical section: everything below is synchronous, no await in between,
    // so no concurrent request can double-spend this spin (same reasoning as
    // the reward-redeem endpoint's critical section). ─────────────────────────
    const status = getSpinStatus(userId);
    if (!status.canSpin) {
      db.spinToken.deleteById(record.id);
      if (status.spinsLeft <= 0) return res.status(429).json({ error: 'Aaj ke saare 5 spins ho gaye! Kal wapas aao.', ...status });
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

    // Velocity check: 5+ confirmed giveaway invites within an hour is a strong
    // fake-account farming signal for rank manipulation.
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const recentInviteCount = await GiveawayInvite.countDocuments({ giveawayId: giveaway._id, inviterId: invite.inviterId, status: 'confirmed', confirmedAt: { $gte: oneHourAgo } });
    if (recentInviteCount >= 5) {
      flagSuspicious(invite.inviterId, 'giveaway_invite_velocity', `${recentInviteCount} giveaway invites confirmed in the last hour.`);
    }
  } catch (e) { console.error('Giveaway confirm error:', e.message); }
}

// GET — full list of lectureIds this user has marked watched
router.get('/watched/:userId', (req, res) => {
  try {
    const watched = db.watchedLecture.listByUser(req.params.userId);
    res.json({ watched });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST — mark or unmark a single lecture as watched
router.post('/watched/:userId', async (req, res) => {
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

      // Signal 1: this is the exact trigger that confirms a giveaway referral
      // (see confirmGiveawayInviteOnFirstWatch below) — so it's the highest-value
      // fraud target. A brand-new account marking a lecture "watched" within
      // seconds of first opening the bot is very unlikely to be a real person
      // actually browsing in, opening a lecture, and watching it — much more
      // consistent with a script just hitting this endpoint to farm the referral.
      if (!hadWatchedBefore) {
        confirmGiveawayInviteOnFirstWatch(userId);
        try {
          const User = mongoose.model('User');
          const user = await User.findOne({ userId: String(userId) }).select('firstSeen').lean();
          if (user && user.firstSeen) {
            const secondsSinceSignup = (Date.now() - new Date(user.firstSeen).getTime()) / 1000;
            if (secondsSinceSignup < 90) {
              flagSuspicious(userId, 'instant_watch_after_signup', `First lecture marked "watched" just ${Math.round(secondsSinceSignup)}s after account creation.`);
            }
          }
        } catch (e) { /* non-critical — don't block the request over this */ }
      }

      // Signal 2: general bot-like bulk marking, independent of whether it's
      // their first watch — no one genuinely watches 8+ lectures in 2 minutes.
      const recentWatchCount = db.watchedLecture.countByUserSince(userId, Date.now() - 2 * 60 * 1000);
      if (recentWatchCount === 8) { // fire once per burst, not on every single mark past the threshold
        flagSuspicious(userId, 'lecture_watch_velocity', `${recentWatchCount} lectures marked "watched" within 2 minutes.`);
      }
      // Signal 3: general daily activity cap — independent of whether a giveaway
      // is even running. 10+ lectures marked "watched" in a single day is well
      // beyond normal study pace and more consistent with account sharing,
      // scripted/bulk marking, or scraping lecture links.
      const dailyWatchCount = db.watchedLecture.countByUserSince(userId, Date.now() - 24 * 60 * 60 * 1000);
      if (dailyWatchCount === 10) { // fire once when the day's count first crosses the line
        flagSuspicious(userId, 'daily_lecture_limit', `${dailyWatchCount} lectures marked "watched" in the last 24 hours.`);
      }
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

// ── Ban / abuse moderation ───────────────────────────────────────────────────
// Manual, admin-driven bans for unusual activity (multi-accounting, farming
// points via rapid claims, giveaway invite fraud, etc). This is deliberately
// NOT automatic — false positives would lock out real users, so an admin
// reviews and bans by hand from the Admin Panel's Users tab.

router.post('/users/:userId/ban', verifyAdmin, async (req, res) => {
  try {
    const User = mongoose.model('User');
    const reason = (req.body.reason || '').trim() || 'Unusual activity detected';
    const user = await User.findOneAndUpdate(
      { userId: String(req.params.userId) },
      { banned: true, banReason: reason, bannedAt: new Date() },
      { upsert: true, new: true }
    );
    SuspiciousActivity.updateMany({ userId: String(req.params.userId), reviewed: false }, { reviewed: true }).catch(() => {});
    res.json({ success: true, userId: user.userId, banned: true, banReason: user.banReason });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/users/:userId/unban', verifyAdmin, async (req, res) => {
  try {
    const User = mongoose.model('User');
    const user = await User.findOneAndUpdate(
      { userId: String(req.params.userId) },
      { banned: false, banReason: '', bannedAt: null },
      { new: true }
    );
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true, userId: user.userId, banned: false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// List unreviewed flags (newest first) — powers the ⚠️ Suspicious Activity
// section in the Users tab.
router.get('/flags', verifyAdmin, async (req, res) => {
  try {
    const flags = await SuspiciousActivity.find({ reviewed: false }).sort({ createdAt: -1 }).limit(100).lean();
    res.json({ flags });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Dismiss a flag without banning — e.g. after checking and deciding it's a
// false positive (a genuinely popular referrer, a viral moment, etc).
router.post('/flags/:id/dismiss', verifyAdmin, async (req, res) => {
  try {
    await SuspiciousActivity.findByIdAndUpdate(req.params.id, { reviewed: true });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/users/banned', verifyAdmin, async (req, res) => {
  try {
    const User = mongoose.model('User');
    const users = await User.find({ banned: true }).select('userId firstName lastName username banReason bannedAt').sort({ bannedAt: -1 }).lean();
    res.json({ users });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Public — the webapp calls this on load to decide whether to show the
// normal app or a "your account is suspended" screen.
router.get('/user-status/:userId', async (req, res) => {
  try {
    const User = mongoose.model('User');
    const user = await User.findOne({ userId: String(req.params.userId) }).select('banned banReason').lean();
    res.json({ banned: !!(user && user.banned), reason: (user && user.banReason) || '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.getPointsBreakdown = getPointsBreakdown;
module.exports.POINTS_PER_REFERRAL = POINTS_PER_REFERRAL;
module.exports.setBot = setBot;
module.exports.isUserBanned = isUserBanned;
