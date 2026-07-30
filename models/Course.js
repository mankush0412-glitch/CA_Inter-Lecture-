const mongoose = require("mongoose");

const lectureSchema = new mongoose.Schema({
  name: { type: String, required: true },
  link: { type: String, required: true },
  notes: { type: String, default: "" }, // optional class notes link
  order: { type: Number, default: 0 },
  comingSoon: { type: Boolean, default: false },
  isDemo: { type: Boolean, default: false }, // demo lecture — accessible to all without access
});

const unitSchema = new mongoose.Schema({
  name: { type: String, required: true },
  order: { type: Number, default: 0 },
  lectures: [lectureSchema],
});

const chapterSchema = new mongoose.Schema({
  name: { type: String, required: true },
  order: { type: Number, default: 0 },
  units: [unitSchema],
  lectures: [lectureSchema], // direct lectures if no units
  comingSoon: { type: Boolean, default: false },
});

const subjectSchema = new mongoose.Schema({
  name: { type: String, required: true },
  icon: { type: String, default: "📚" },
  color: { type: String, default: "#4f8ef7" },
  order: { type: Number, default: 0 },
  chapters: [chapterSchema],
});

const batchSchema = new mongoose.Schema({
  name: { type: String, required: true },
  pic: { type: String, default: "" }, // base64 encoded image
  description: { type: String, default: "" },
  order: { type: Number, default: 0 },
  isPublic: { type: Boolean, default: false }, // private by default; owner publishes when ready
  isPremium: { type: Boolean, default: false }, // premium batch — locked for non-allowed users
  referralsRequired: { type: Number, default: 5 }, // how many valid referrals unlock this batch (Referral Unlock System)
  unlockDurationHours: { type: Number, default: 168 }, // how many hours the batch stays unlocked after referral target is hit (default 168 = 7 days)
  premiumUsers: { type: [String], default: [] }, // Telegram user IDs allowed to access this batch
  subjects: [subjectSchema],
});

module.exports = mongoose.model("Batch", batchSchema);
