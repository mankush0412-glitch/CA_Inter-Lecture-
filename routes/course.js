const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const mongoose = require("mongoose");
const Batch = require("../models/Course");
const { isBatchPremiumActiveSync, BatchReferralUnlock, setBatchPremiumCache } = require("../models/ReferralUnlock");
// User model is registered by server.js before this module loads; grabbed via
// the mongoose registry rather than a fresh require to avoid a duplicate schema.
const User = mongoose.model("User");

const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_ID = parseInt(process.env.OWNER_ID || "0");
const BOT_USERNAME = process.env.BOT_USERNAME || "";

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
async function hasPremiumAccess(userId, batch) {
  if (!userId) return false;
  if ((batch.premiumUsers || []).includes(userId)) return true;
  if (isBatchPremiumActiveSync(userId, String(batch._id))) return true; // free Referral Unlock — in-memory cache hit
  // Cache miss (e.g. server restart cleared memory) — fall back to MongoDB directly
  // so a valid referral-unlock user never gets stripped links just because cache is cold.
  const refDoc = await BatchReferralUnlock.findOne({ userId: String(userId), batchId: String(batch._id), unlocked: true }).lean();
  if (refDoc && refDoc.expiresAt && refDoc.expiresAt > new Date()) {
    setBatchPremiumCache(String(userId), String(batch._id), true, refDoc.expiresAt); // warm up cache for next call
    return true;
  }
  const r = await BatchRewardAccess.findOne({ userId, batchId: String(batch._id) }).lean();
  return !!r && r.expiresAt > new Date();
}

// ── Auto-Lecture Session ──────────────────────────────────────────────────────
// Singleton doc — was previously only persisted in SQLite (the "MongoDB backup"
// below was dead code: it referenced a model that was never actually defined).
const autoLecSessionSchema = new mongoose.Schema({
  _id: { type: String, default: 'singleton' },
  active: { type: Boolean, default: false },
  batchId: { type: String, default: null },
  subjectId: { type: String, default: null },
  chapterId: { type: String, default: null },
  unitId: { type: String, default: null },
  lectureCount: { type: Number, default: 0 },
  batchName: { type: String, default: '' },
  subjectName: { type: String, default: '' },
  chapterName: { type: String, default: '' },
  unitName: { type: String, default: '' },
});
const AutoLecSession = mongoose.models.AutoLecSession || mongoose.model('AutoLecSession', autoLecSessionSchema);

// Mutated in place (not reassigned) so the reference exported below stays valid
// everywhere it was imported before the initial load finished.
const autoLectureSession = { active:false, batchId:null, subjectId:null, chapterId:null, unitId:null, lectureCount:0, batchName:'', subjectName:'', chapterName:'', unitName:'' };
(async () => {
  try {
    const doc = await AutoLecSession.findById('singleton').lean();
    if (doc) Object.assign(autoLectureSession, doc);
  } catch (e) { console.error('AutoLecSession load error:', e.message); }
})();

async function _saveAutoSession() {
  try {
    await AutoLecSession.findByIdAndUpdate('singleton', { $set: autoLectureSession }, { upsert: true });
  } catch (e) { console.error('AutoLecSession save error:', e.message); }
}

async function autoAddLecture({ batchId, subjectId, chapterId, unitId, name, link }) {
  const mongoBatch = await Batch.findById(batchId);
  if (!mongoBatch) throw new Error('Batch not found');
  const ms = mongoBatch.subjects.id(subjectId);
  if (!ms) throw new Error('Subject not found');
  const mc = ms.chapters.id(chapterId);
  if (!mc) throw new Error('Chapter not found');

  if (unitId) {
    const mu = mc.units.id(unitId);
    if (!mu) throw new Error('Unit not found');
    mu.lectures.push({ name, link, notes: '', order: mu.lectures.length, isDemo: false });
  } else {
    mc.lectures.push({ name, link, notes: '', order: mc.lectures.length, isDemo: false });
  }
  await mongoBatch.save();
}

// ── Batches ───────────────────────────────────────────────────────────────────

router.get("/batches", async (req, res) => {
  try {
    const admin = isAdminRequest(req);
    // Admin: fresh from MongoDB
    if (admin) { return res.json(await Batch.find({}).sort({ order: 1 })); }

    const batches = await Batch.find({}).sort({ order: 1 }).lean();
    const userId = getRequestUserId(req);
    const results = await Promise.all(batches.map(async b => {
      if (!b.isPremium) return b;
      return (await hasPremiumAccess(userId, b)) ? b : stripPremiumLinks(b);
    }));
    res.json(results);
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
    const b = await Batch.findById(req.params.bid).lean();
    if (!b) return res.status(404).json({ error: "Not found" });
    const userId = getRequestUserId(req);
    const userHasAccess = await hasPremiumAccess(userId, b);
    res.json(b.isPremium && !userHasAccess ? stripPremiumLinks(b) : b);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/batches/migrate-publish", verifyAdmin, async (req, res) => {
  try {
    const result = await Batch.updateMany({ isPublic: false }, { $set: { isPublic: true } });
    res.json({ success: true, updated: result.modifiedCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/batches", verifyAdmin, async (req, res) => {
  try {
    const count = await Batch.countDocuments({});
    // Write to MongoDB first (gets real _id)
    const batch = await Batch.create({ name: req.body.name, pic: req.body.pic||"", description: req.body.description||"", order: count, isPublic: false, isPremium: req.body.isPremium===true, premiumUsers: [], referralsRequired: req.body.referralsRequired ? Math.max(1, parseInt(req.body.referralsRequired)) : 5, unlockDurationHours: req.body.unlockDurationHours ? Math.max(1, parseInt(req.body.unlockDurationHours)) : 168 });
    res.json(batch);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch("/batches/:bid/publish", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    if (!batch) return res.status(404).json({ error: "Batch not found" });
    batch.isPublic = !batch.isPublic;
    await batch.save();
    res.json({ success: true, isPublic: batch.isPublic });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete("/batches/:bid", verifyAdmin, async (req, res) => {
  try {
    await Batch.findByIdAndDelete(req.params.bid);
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
    if (req.body.referralsRequired !== undefined) batch.referralsRequired = Math.max(1, parseInt(req.body.referralsRequired) || 5);
    if (req.body.unlockDurationHours !== undefined) batch.unlockDurationHours = Math.max(1, parseInt(req.body.unlockDurationHours) || 168);
    if (req.body.pic !== undefined) batch.pic = req.body.pic;
    await batch.save();
    res.json(batch);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Premium Users ─────────────────────────────────────────────────────────────

router.get("/batches/:bid/premium-users", verifyAdmin, async (req, res) => {
  try {
    const b = await Batch.findById(req.params.bid).lean();
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
    res.json({ success: true, premiumUsers: batch.premiumUsers });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete("/batches/:bid/premium-users/:uid", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    if (!batch) return res.status(404).json({ error: "Batch not found" });
    batch.premiumUsers = (batch.premiumUsers||[]).filter(u => u !== req.params.uid);
    await batch.save();
    res.json({ success: true, premiumUsers: batch.premiumUsers });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/batches/:bid/premium-check/:userId", async (req, res) => {
  try {
    const b = await Batch.findById(req.params.bid).lean();
    if (!b) return res.status(404).json({ error: "Batch not found" });
    const userId = String(req.params.userId);
    const isPermanent = (b.premiumUsers||[]).includes(userId);
    const rewardAccess = await BatchRewardAccess.findOne({ userId, batchId: String(b._id) }).lean();
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
    res.json(batch);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete("/batches/:bid/subjects/:sid", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    if (!batch) return res.status(404).json({ error: "Batch not found" });
    batch.subjects = batch.subjects.filter(s => s._id.toString() !== req.params.sid);
    await batch.save();
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
    res.json(batch);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Announcements ─────────────────────────────────────────────────────────────

const announcementSchema = new mongoose.Schema({ emoji: { type: String, default: "📢" }, heading: { type: String, required: true }, body: { type: String, required: true }, createdAt: { type: Date, default: Date.now } });
const Announcement = mongoose.model("Announcement", announcementSchema);

router.get("/announcements", async (req, res) => {
  try { res.json(await Announcement.find({}).sort({ createdAt: -1 }).limit(20).lean()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/announcements", verifyAdmin, async (req, res) => {
  try {
    const { emoji, heading, body } = req.body;
    if (!heading || !body) return res.status(400).json({ error: "heading and body required" });
    const ann = await Announcement.create({ emoji: emoji||"📢", heading, body });
    res.json({ ...ann.toObject(), _id: String(ann._id) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete("/announcements/:id", verifyAdmin, async (req, res) => {
  try {
    await Announcement.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Ad Token + Access ─────────────────────────────────────────────────────────

const adTokenSchema = new mongoose.Schema({ userId: { type: String, required: true }, token: { type: String, required: true, unique: true }, issuedAt: { type: Date, default: Date.now }, expiresAt: { type: Date, required: true } });
adTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const AdToken = mongoose.model("AdToken", adTokenSchema);

const accessSchema = new mongoose.Schema({ userId: { type: String, required: true, unique: true }, expiresAt: { type: Date, required: true }, claimsToday: { type: Number, default: 0 }, claimDay: { type: String, default: '' } });
const Access = mongoose.model("Access", accessSchema);

router.get("/access/:userId", async (req, res) => {
  try {
    const record = await Access.findOne({ userId: req.params.userId }).lean();
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
    const existing = await Access.findOne({ userId }).lean();
    const claimsToday = (existing && existing.claimDay === today) ? (existing.claimsToday||0) : 0;
    if (claimsToday >= 3) return res.status(429).json({ error: "Aaj ke 3 claims ho gaye! Kal wapas aao.", claimsToday: 3, claimsLeft: 0 });

    await AdToken.deleteMany({ userId });

    const token = crypto.randomBytes(32).toString("hex");
    const tokenExpiry = new Date(Date.now() + 10 * 60 * 1000);
    await AdToken.create({ userId, token, expiresAt: tokenExpiry });
    res.json({ token, claimsToday, claimsLeft: 3 - claimsToday });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/access/claim/:userId", async (req, res) => {
  try {
    const userId = req.params.userId;
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: "Token required" });

    const record = await AdToken.findOne({ userId, token }).lean();
    if (!record) return res.status(403).json({ error: "Invalid or expired token. Please watch the ad again." });
    if (record.expiresAt < new Date()) return res.status(403).json({ error: "Token expired. Please watch the ad again." });
    const elapsed = (Date.now() - new Date(record.issuedAt)) / 1000;
    if (elapsed < 15) return res.status(403).json({ error: "Ad not fully watched. Please wait..." });

    const today = new Date().toISOString().slice(0, 10);
    const existing = await Access.findOne({ userId }).lean();
    const claimsToday = (existing && existing.claimDay === today) ? (existing.claimsToday||0) : 0;
    if (claimsToday >= 3) { await AdToken.deleteOne({ _id: record._id }); return res.status(429).json({ error: "Aaj ke 3 claims ho gaye! Kal wapas aao." }); }

    await AdToken.deleteOne({ _id: record._id });

    const baseTime = (existing && existing.expiresAt > new Date()) ? existing.expiresAt : new Date();
    const expiresAt = new Date(baseTime.getTime() + 8 * 60 * 60 * 1000);
    const newClaimsToday = claimsToday + 1;

    await Access.findOneAndUpdate({ userId }, { userId, expiresAt, claimsToday: newClaimsToday, claimDay: today }, { upsert: true });
    res.json({ hasAccess: true, expiresAt, claimsToday: newClaimsToday, claimsLeft: 3 - newClaimsToday });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Referrals ─────────────────────────────────────────────────────────────────

const referralSchema = new mongoose.Schema({ referrerId: { type: String, required: true }, referredId: { type: String, required: true }, createdAt: { type: Date, default: Date.now } });
referralSchema.index({ referrerId: 1 });
referralSchema.index({ referredId: 1 }, { unique: true });
const Referral = mongoose.model('Referral', referralSchema);

router.get('/refer/stats/:userId', async (req, res) => {
  try {
    const { referrals, spent, points } = await getPointsBreakdown(req.params.userId);
    res.json({ referrals, spent, points });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/refer/record', async (req, res) => {
  try {
    const { referrerId, referredId } = req.body;
    if (!referrerId || !referredId) return res.status(400).json({ error: 'Missing fields' });
    if (referrerId === referredId) return res.status(400).json({ error: 'Cannot refer yourself' });
    if (!req.body.isNewUser) return res.json({ success: false, isNew: false, reason: 'Not a new user' });

    const existing = await Referral.findOne({ referredId }).lean();
    if (existing) return res.json({ success: false, isNew: false, reason: 'Already referred' });

    await Referral.create({ referrerId, referredId });
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

// ── Daily Lecture Limit (WebApp) ────────────────────────────────────────────
// Same 10/day counter the Telegram bot's file-store deep-links already use (DailyVideoLimit), exposed here so the WebApp can show
// "Today's Limit: 7/10 Remaining" and gate lecture playback for non-owner users.
// IMPORTANT (for the next phase): the frontend does not call this endpoint yet —
// it needs to call GET on lecture-list load and POST /consume right before
// opening/playing a lecture link.
const DAILY_LECTURE_LIMIT = 10;
function getTodayISTStr() { const now = new Date(); return new Date(now.getTime() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10); }

// ── Per-Batch Referral Unlock status (for the WebApp's Unlock modal) ────────
// Mirrors the lazy-expiry logic in server.js's getBatchReferralStatus() — kept
// as a separate read here since this route only ever reads; server.js remains
// the only place that writes/credits/expires it.
router.get('/batch-referral/status/:userId/:batchId', async (req, res) => {
  try {
    const userId = String(req.params.userId);
    const batchId = String(req.params.batchId);
    const batch = await Batch.findById(batchId).select('referralsRequired name').lean();
    const required = (batch && batch.referralsRequired) || 5;

    let doc = await BatchReferralUnlock.findOne({ userId, batchId }).lean();
    if (!doc) return res.json({ unlocked: false, referralCount: 0, required, expiresAt: null, botUsername: BOT_USERNAME });

    let unlocked = doc.unlocked;
    let expiresAt = doc.expiresAt;
    let referralCount = (doc.validReferrals || []).length;
    if (unlocked && expiresAt && new Date(expiresAt) <= new Date()) {
      unlocked = false; expiresAt = null; referralCount = 0;
      await BatchReferralUnlock.updateOne({ userId, batchId }, { $set: { unlocked: false, expiresAt: null, validReferrals: [] } });
    }
    res.json({ unlocked, referralCount, required, expiresAt, botUsername: BOT_USERNAME });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/lecture-limit/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    if (String(userId) === String(OWNER_ID)) return res.json({ used: 0, remaining: DAILY_LECTURE_LIMIT, limit: DAILY_LECTURE_LIMIT, unlimited: true });
    const today = getTodayISTStr();
    const rec = await mongoose.model('DailyVideoLimit').findOne({ userId }).lean();
    if (!rec || rec.resetDate !== today) return res.json({ used: 0, remaining: DAILY_LECTURE_LIMIT, limit: DAILY_LECTURE_LIMIT });
    res.json({ used: rec.count, remaining: Math.max(0, DAILY_LECTURE_LIMIT - rec.count), limit: DAILY_LECTURE_LIMIT });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/lecture-limit/:userId/consume', async (req, res) => {
  try {
    const userId = req.params.userId;
    if (String(userId) === String(OWNER_ID)) return res.json({ used: 0, remaining: DAILY_LECTURE_LIMIT, limit: DAILY_LECTURE_LIMIT, unlimited: true });
    const today = getTodayISTStr();
    let rec = await mongoose.model('DailyVideoLimit').findOne({ userId }).lean();
    if (!rec || rec.resetDate !== today) rec = { count: 0 };
    if (rec.count >= DAILY_LECTURE_LIMIT) return res.status(429).json({ error: 'Daily limit reached', used: rec.count, remaining: 0, limit: DAILY_LECTURE_LIMIT });
    const newCount = rec.count + 1;
    await mongoose.model('DailyVideoLimit').findOneAndUpdate({ userId }, { userId, count: newCount, resetDate: today }, { upsert: true });
    res.json({ used: newCount, remaining: Math.max(0, DAILY_LECTURE_LIMIT - newCount), limit: DAILY_LECTURE_LIMIT });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Mongo queries are async, so the old trick of "no `await` between the balance
// check and the write, so nothing else can interleave" (which is what made the
// SQLite version double-spend-proof) no longer applies. This tiny per-user
// mutex serializes redeem requests for the SAME user instead — two rapid clicks
// from one user now queue instead of racing; different users are unaffected.
const _userLocks = new Map();
async function withUserLock(userId, fn) {
  const prev = _userLocks.get(userId) || Promise.resolve();
  let release;
  const next = new Promise(r => { release = r; });
  _userLocks.set(userId, prev.then(() => next));
  await prev;
  try { return await fn(); } finally { release(); if (_userLocks.get(userId) === next) _userLocks.delete(userId); }
}

const REWARD_CATALOG = {
  accessPass: { cost: 5, durationMs: 24 * 60 * 60 * 1000, label: '24 Hour Site Access' },
  batch24h: { cost: 10, durationMs: 24 * 60 * 60 * 1000, label: '24 Hour Premium Batch Access' },
  batch7d: { cost: 50, durationMs: 7 * 24 * 60 * 60 * 1000, label: '7 Day Premium Batch Access' },
};

// Single source of truth for the points formula — always fresh from the DB,
// never trusts a client-sent value. referrals here is the raw referral COUNT;
// points is the spendable balance (referrals*POINTS_PER_REFERRAL + spinEarned - spent).
async function getPointsBreakdown(userId) {
  const referrals = await Referral.countDocuments({ referrerId: userId });
  const spinEarned = (await SpinHistory.aggregate([{ $match: { userId } }, { $group: { _id: null, total: { $sum: '$pointsWon' } } }]))[0]?.total || 0;
  const spent = (await RewardRedemption.aggregate([{ $match: { userId } }, { $group: { _id: null, total: { $sum: '$pointsCost' } } }]))[0]?.total || 0;
  const points = Math.max(0, referrals * POINTS_PER_REFERRAL + spinEarned - spent);
  return { referrals, spinEarned, spent, points };
}
async function getSpendablePoints(userId) {
  return (await getPointsBreakdown(userId)).points;
}

// Notify the bot owner whenever someone redeems a reward — fire-and-forget,
// never allowed to block or fail the actual redeem response to the user.
async function notifyOwnerOfRedemption({ userId, rewardType, catalogEntry, batchDoc, pointsCost, pointsRemaining, expiresAt }) {
  if (!BOT_TOKEN || !OWNER_ID) return;
  try {
    const u = await User.findOne({ userId }).lean();
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
router.get('/rewards/summary/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    const { referrals, spent, points } = await getPointsBreakdown(userId);

    const accessRecord = await Access.findOne({ userId }).lean();
    const accessPass = {
      active: !!accessRecord && accessRecord.expiresAt > new Date(),
      expiresAt: accessRecord ? accessRecord.expiresAt : null,
    };

    const activeBatchRewardDocs = await BatchRewardAccess.find({ userId, expiresAt: { $gt: new Date() } }).lean();
    const activeBatchRewards = activeBatchRewardDocs.map(r => ({ batchId: r.batchId, batchName: r.batchName, expiresAt: r.expiresAt }));

    res.json({ referrals, spent, points, accessPass, activeBatchRewards, catalog: REWARD_CATALOG });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET eligible batches — the picker list shown when redeeming a batch-based reward.
// Excludes batches the user already permanently owns (no point wasting points on those).
router.get('/rewards/eligible-batches/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    const all = await Batch.find({ isPremium: true, isPublic: true }).lean();
    const eligible = await Promise.all(all
      .filter(b => !((b.premiumUsers || []).includes(userId))) // already owned permanently — skip
      .map(async b => {
        const active = await BatchRewardAccess.findOne({ userId, batchId: String(b._id) }).lean();
        return {
          _id: b._id,
          name: b.name,
          pic: b.pic || '',
          subjectCount: (b.subjects || []).length,
          activeRewardExpiresAt: (active && active.expiresAt > new Date()) ? active.expiresAt : null,
        };
      }));
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
      batchDoc = await Batch.findById(batchId).lean();
      if (!batchDoc || batchDoc.isPublic !== true) return res.status(404).json({ error: 'Batch not found' });
      if (batchDoc.isPremium !== true) return res.status(400).json({ error: 'This batch is not a premium batch' });
      if ((batchDoc.premiumUsers || []).includes(userId)) {
        return res.status(400).json({ error: 'Aapke paas already is batch ka full access hai!' });
      }
    }

    // ── Critical section: serialized per-user via withUserLock so two rapid
    // clicks from the same user can't both pass the balance check before either
    // one's spend is recorded (see withUserLock above for why this replaced the
    // old SQLite-synchronous-transaction trick). ───────────────────────────────
    const result = await withUserLock(userId, async () => {
      const spendable = await getSpendablePoints(userId);
      if (spendable < catalogEntry.cost) {
        return { error: { status: 400, body: { error: `Not enough points! Need ${catalogEntry.cost}, you have ${spendable}.`, required: catalogEntry.cost, available: spendable } } };
      }

      let expiresAt;
      const redeemedAt = new Date();
      if (rewardType === 'accessPass') {
        const existing = await Access.findOne({ userId }).lean();
        const baseTime = (existing && existing.expiresAt > redeemedAt) ? existing.expiresAt : redeemedAt;
        expiresAt = new Date(baseTime.getTime() + catalogEntry.durationMs);
        // Preserve existing ad-claim counters untouched — this reward is independent of the daily ad-claim cap
        await Access.findOneAndUpdate({ userId }, {
          userId, expiresAt,
          claimsToday: existing ? existing.claimsToday : 0,
          claimDay: existing ? existing.claimDay : '',
        }, { upsert: true });
      } else {
        const existing = await BatchRewardAccess.findOne({ userId, batchId: String(batchId) }).lean();
        const baseTime = (existing && existing.expiresAt > redeemedAt) ? existing.expiresAt : redeemedAt;
        expiresAt = new Date(baseTime.getTime() + catalogEntry.durationMs);
        await BatchRewardAccess.findOneAndUpdate({ userId, batchId: String(batchId) }, { userId, batchId: String(batchId), batchName: batchDoc.name, expiresAt, grantedAt: redeemedAt }, { upsert: true });
      }

      // Ledger entry — inserting this row IS the "spend"; balance is always derived, never stored directly
      const redemption = await RewardRedemption.create({
        userId, rewardType,
        batchId: batchDoc ? String(batchId) : null,
        batchName: batchDoc ? batchDoc.name : '',
        pointsCost: catalogEntry.cost, redeemedAt, expiresAt,
      });
      return { redemptionId: String(redemption._id), expiresAt, spendable };
    });
    // ── End critical section ───────────────────────────────────────────────────

    if (result.error) return res.status(result.error.status).json(result.error.body);
    const { redemptionId, expiresAt, spendable } = result;

    notifyOwnerOfRedemption({
      userId, rewardType, catalogEntry, batchDoc,
      pointsCost: catalogEntry.cost, pointsRemaining: spendable - catalogEntry.cost, expiresAt,
    });

    res.json({
      success: true,
      redemptionId,
      rewardType,
      label: catalogEntry.label,
      pointsSpent: catalogEntry.cost,
      pointsRemaining: spendable - catalogEntry.cost,
      expiresAt,
      batchId: batchDoc ? String(batchId) : null,
      batchName: batchDoc ? batchDoc.name : null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET redemption history — powers a "My Redeemed Rewards" list in the UI
router.get('/rewards/history/:userId', async (req, res) => {
  try {
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    const history = await RewardRedemption.find({ userId: req.params.userId }).sort({ redeemedAt: -1 }).limit(limit).lean();
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

// SpinToken previously only existed in SQLite (no Mongo equivalent) — added here,
// mirroring AdToken's shape/TTL-index pattern exactly.
const spinTokenSchema = new mongoose.Schema({ userId: { type: String, required: true }, token: { type: String, required: true, unique: true }, issuedAt: { type: Date, default: Date.now }, expiresAt: { type: Date, required: true } });
spinTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const SpinToken = mongoose.models.SpinToken || mongoose.model('SpinToken', spinTokenSchema);

function _todayMidnightMs() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Single source of truth for "can this user spin right now" — used by all 3 endpoints below
async function getSpinStatus(userId) {
  const spinsToday = await SpinHistory.countDocuments({ userId, spunAt: { $gte: new Date(_todayMidnightMs()) } });
  const spinsLeft = Math.max(0, SPIN_DAILY_LIMIT - spinsToday);
  const lastDoc = await SpinHistory.findOne({ userId }).sort({ spunAt: -1 }).lean();
  const last = lastDoc ? lastDoc.spunAt : null;
  const cooldownRemainingMs = last ? Math.max(0, SPIN_COOLDOWN_MS - (Date.now() - new Date(last).getTime())) : 0;
  const nextResetAt = new Date(_todayMidnightMs() + 24 * 60 * 60 * 1000);
  return {
    spinsToday, spinsLeft, maxSpins: SPIN_DAILY_LIMIT,
    cooldownRemainingMs, canSpin: spinsLeft > 0 && cooldownRemainingMs <= 0,
    nextResetAt,
  };
}

// GET status — powers the Earn tab's UI (spins left, cooldown countdown, spin button enabled/disabled)
router.get('/spin/status/:userId', async (req, res) => {
  try { res.json(await getSpinStatus(req.params.userId)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// POST token — issued right before the ad plays; must be redeemed via /spin/claim afterwards
router.post('/spin/token/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    const status = await getSpinStatus(userId);
    if (!status.canSpin) {
      if (status.spinsLeft <= 0) return res.status(429).json({ error: 'Aaj ke saare 5 spins ho gaye! Kal wapas aao.', ...status });
      return res.status(429).json({ error: `Thoda ruko! Agla spin ${Math.ceil(status.cooldownRemainingMs / 1000)}s mein.`, ...status });
    }

    await SpinToken.deleteMany({ userId }); // one live spin-token per user at a time, same as adToken

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await SpinToken.create({ userId, token, expiresAt });

    res.json({ token });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST claim — verifies the ad was actually watched (min elapsed time, same as access/claim),
// re-checks the daily limit + cooldown fresh (defends against races/stale client state),
// then rolls the wheel server-side and records the spin.
router.post('/spin/claim/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token required' });

    const record = await SpinToken.findOne({ userId, token }).lean();
    if (!record) return res.status(403).json({ error: 'Invalid or expired spin. Please try again.' });
    if (record.expiresAt < new Date()) { await SpinToken.deleteOne({ _id: record._id }); return res.status(403).json({ error: 'Spin expired. Please try again.' }); }
    const elapsed = (Date.now() - record.issuedAt.getTime()) / 1000;
    if (elapsed < SPIN_AD_WATCH_SECONDS) return res.status(403).json({ error: 'Ad poori dekho pehle! Spin count nahi hoga.' });

    // ── Critical section: serialized per-user via withUserLock (same reasoning
    // as the reward-redeem endpoint above). ────────────────────────────────────
    const result = await withUserLock(userId, async () => {
      const status = await getSpinStatus(userId);
      if (!status.canSpin) {
        await SpinToken.deleteOne({ _id: record._id });
        if (status.spinsLeft <= 0) return { error: { status: 429, body: { error: 'Aaj ke saare 5 spins ho gaye! Kal wapas aao.', ...status } } };
        return { error: { status: 429, body: { error: `Thoda ruko! Agla spin ${Math.ceil(status.cooldownRemainingMs / 1000)}s mein.`, ...status } } };
      }

      await SpinToken.deleteOne({ _id: record._id });

      const pointsWon = 1 + Math.floor(Math.random() * 5); // uniform 1-5, decided server-side only
      const spunAt = new Date();
      await SpinHistory.create({ userId, pointsWon, spunAt });
      return { pointsWon };
    });
    // ── End critical section ───────────────────────────────────────────────────

    if (result.error) return res.status(result.error.status).json(result.error.body);

    const newStatus = await getSpinStatus(userId);
    res.json({ pointsWon: result.pointsWon, ...newStatus });
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

// GET — full list of lectureIds this user has marked watched
router.get('/watched/:userId', async (req, res) => {
  try {
    const docs = await WatchedLecture.find({ userId: req.params.userId }).select('lectureId').lean();
    res.json({ watched: docs.map(d => d.lectureId) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST — mark or unmark a single lecture as watched
router.post('/watched/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    const { lectureId, watched } = req.body;
    if (!lectureId) return res.status(400).json({ error: 'lectureId required' });

    if (watched === false) {
      await WatchedLecture.deleteOne({ userId, lectureId });
    } else {
      await WatchedLecture.updateOne({ userId, lectureId }, { userId, lectureId, watchedAt: new Date() }, { upsert: true });
    }
    res.json({ success: true, lectureId, watched: watched !== false });
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
    const batchData = await Batch.findById(batchId).lean();
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

router.get('/stats', async (req, res) => {
  try {
    const batches = await Batch.find({}).lean();
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
    const FileRecord = mongoose.model('FileRecord');
    const BulkBatch = mongoose.model('BulkBatch');
    const PendingDelete = mongoose.model('PendingDelete');
    const singleTotal = await FileRecord.countDocuments({});
    const singleWithBackup = await FileRecord.countDocuments({ channel_msg_id: { $ne: null } });
    const allBulkBatches = await BulkBatch.find({}).lean();
    let bulkFileTotal=0, bulkFileWithBackup=0;
    allBulkBatches.forEach(b => { (b.files||[]).forEach(f => { bulkFileTotal++; if (f.channel_msg_id) bulkFileWithBackup++; }); });

    const now = Date.now();
    const totalReferrals = await Referral.countDocuments({});
    const referrerAgg = await Referral.aggregate([{ $group: { _id: '$referrerId', c: { $sum: 1 } } }, { $sort: { c: -1 } }, { $limit: 5 }]);
    const top5 = await Promise.all(referrerAgg.map(async (r) => {
      const u = await User.findOne({ userId: r._id }).lean();
      const name = u ? (u.firstName || u.username || `User ${r._id}`) : `User ${r._id}`;
      return { userId: r._id, name, count: r.c };
    }));
    const uniqueReferrers = (await Referral.distinct('referrerId')).length;

    const spinAgg = (await SpinHistory.aggregate([{ $group: { _id: null, total: { $sum: '$pointsWon' } } }]))[0]?.total || 0;
    const redemptionAgg = (await RewardRedemption.aggregate([{ $group: { _id: null, total: { $sum: '$pointsCost' } } }]))[0]?.total || 0;

    res.json({
      content: { totalBatches, publicBatches, privateBatches: totalBatches - publicBatches, totalSubjects, totalChapters, totalLectures, totalPremiumUnlocks },
      users: {
        totalUsers: await User.countDocuments({}),
        recentUsers: await User.countDocuments({ firstSeen: { $gte: new Date(now - 7*24*60*60*1000) } }),
        newToday: await User.countDocuments({ firstSeen: { $gte: new Date(now - 24*60*60*1000) } }),
      },
      access: {
        totalAccess: await Access.countDocuments({}),
        activeAccess: await Access.countDocuments({ expiresAt: { $gt: new Date() } }),
        grantedToday: await Access.countDocuments({ claimDay: new Date().toISOString().slice(0, 10), claimsToday: { $gt: 0 } }),
      },
      referrals: {
        totalReferrals,
        uniqueReferrers,
        referralsToday: await Referral.countDocuments({ createdAt: { $gte: new Date(now - 24*60*60*1000) } }),
        referralsThisWeek: await Referral.countDocuments({ createdAt: { $gte: new Date(now - 7*24*60*60*1000) } }),
        avgPerReferrer: uniqueReferrers > 0 ? +(totalReferrals / uniqueReferrers).toFixed(1) : 0,
        totalPointsEarned: totalReferrals * POINTS_PER_REFERRAL,
        topReferrers: top5,
      },
      spinWheel: {
        spinsToday: await SpinHistory.countDocuments({ spunAt: { $gte: new Date(now - 24*60*60*1000) } }),
        totalSpinners: (await SpinHistory.distinct('userId')).length,
        totalPtsEarned: spinAgg,
        totalPtsRedeemed: redemptionAgg,
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
        totalRedemptions: await RewardRedemption.countDocuments({}),
        activeBatchUnlocks: await BatchRewardAccess.countDocuments({ expiresAt: { $gt: new Date() } }),
      },
      pendingDeletes: await PendingDelete.countDocuments({}),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


module.exports = router;
