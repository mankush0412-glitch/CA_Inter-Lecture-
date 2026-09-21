// ── Per-Batch Referral Unlock System ────────────────────────────────────────
// Free, referral-based unlock — but scoped to ONE specific premium batch at a
// time, not "all premium batches at once". Each premium batch has its own
// admin-set referralsRequired count (see models/Course.js -> Batch.referralsRequired),
// its own progress counter per user, and its own 7-day unlock window.
// Deliberately stored in MongoDB only (no SQLite mirror).
//
// Flow (entirely inside the WebApp — no bot-chat "Premium" button/command):
//   1. User opens a locked premium batch in the WebApp and taps "Unlock".
//      The WebApp shows progress + a Share button. The share link encodes
//      BOTH the referrer's id AND the batchId: t.me/<bot>?start=ref_<uid>_<batchId>
//   2. A friend opens that link -> PendingReferral is created (unconfirmed),
//      remembering which batch this referral is "for".
//   3. The friend must: start the bot, be unique, not be the referrer, and
//      finish Force Join.
//   4. Once Force Join is verified, the referral becomes valid and is added to
//      the referrer's BatchReferralUnlock.validReferrals for THAT batch only.
//   5. Once validReferrals reaches that batch's referralsRequired, the batch
//      unlocks for 7 days and validReferrals resets to [] (progress starts
//      over for the next 7-day cycle once this one expires).
//   6. If the user leaves a Force Join channel, ALL of their active per-batch
//      unlocks are revoked immediately (see the chat_member handler in server.js).
//   7. When expiresAt passes, the batch auto-locks again and needs fresh
//      referrals to re-unlock (see getBatchReferralStatus below).

const mongoose = require("mongoose");

const batchReferralUnlockSchema = new mongoose.Schema({
  userId:          { type: String, required: true, index: true },
  batchId:         { type: String, required: true, index: true },
  validReferrals:  { type: [String], default: [] }, // referredIds counted toward this batch's requirement
  unlocked:        { type: Boolean, default: false },
  unlockedAt:      { type: Date, default: null },
  expiresAt:       { type: Date, default: null },
});
batchReferralUnlockSchema.index({ userId: 1, batchId: 1 }, { unique: true });
const BatchReferralUnlock = mongoose.models.BatchReferralUnlock || mongoose.model("BatchReferralUnlock", batchReferralUnlockSchema);

// One row per referred person — tracks whether Force Join has been verified yet,
// and whether it has already been credited to the referrer (so it can never be
// double-counted, e.g. if the user re-verifies or restarts the bot). batchId is
// which batch's progress this referral counts toward.
const pendingReferralSchema = new mongoose.Schema({
  referrerId:        { type: String, required: true },
  referredId:        { type: String, required: true, unique: true, index: true },
  batchId:           { type: String, default: null },
  forceJoinVerified:  { type: Boolean, default: false },
  counted:            { type: Boolean, default: false },
  createdAt:          { type: Date, default: Date.now },
});
const PendingReferral = mongoose.models.PendingReferral || mongoose.model("PendingReferral", pendingReferralSchema);

// ── Sync cache for content-gating checks ────────────────────────────────────
// routes/course.js's hasPremiumAccess() runs synchronously in a hot path, so it
// can't `await` Mongo on every call. Keyed by "userId:batchId" now (per-batch).
const premiumCache = new Map(); // "userId:batchId" -> expiresAt(Date)

function _cacheKey(userId, batchId) { return `${userId}:${batchId}`; }

function setBatchPremiumCache(userId, batchId, active, expiresAt) {
  const key = _cacheKey(userId, batchId);
  if (active) premiumCache.set(key, expiresAt);
  else premiumCache.delete(key);
}

function isBatchPremiumActiveSync(userId, batchId) {
  const key = _cacheKey(userId, batchId);
  const expiresAt = premiumCache.get(key);
  if (!expiresAt) return false;
  if (expiresAt <= new Date()) { premiumCache.delete(key); return false; }
  return true;
}

// Clears every cached unlock for a user (used when they leave a Force Join channel —
// revokes access to every batch they'd unlocked via referrals, not just one).
function clearAllBatchPremiumCacheForUser(userId) {
  const prefix = `${userId}:`;
  for (const key of premiumCache.keys()) if (key.startsWith(prefix)) premiumCache.delete(key);
}

async function preloadBatchPremiumCache() {
  const active = await BatchReferralUnlock.find({ unlocked: true, expiresAt: { $gt: new Date() } });
  for (const doc of active) setBatchPremiumCache(doc.userId, doc.batchId, true, doc.expiresAt);
  return active.length;
}

module.exports = {
  BatchReferralUnlock, PendingReferral,
  setBatchPremiumCache, isBatchPremiumActiveSync, clearAllBatchPremiumCacheForUser, preloadBatchPremiumCache,
};
