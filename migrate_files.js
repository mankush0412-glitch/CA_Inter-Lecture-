/**
 * migrate_files.js
 * ─────────────────────────────────────────────────────────────────
 * Bot change ke baad storage channel se naye file_id's fetch karke
 * MongoDB update karta hai.
 *
 * Usage:
 *   BOT_TOKEN=xxx MONGO_URI=yyy STORAGE_CHANNEL_ID=zzz OWNER_ID=www node migrate_files.js
 * ─────────────────────────────────────────────────────────────────
 */

const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");

const TOKEN             = process.env.BOT_TOKEN;
const MONGO_URI         = process.env.MONGO_URI;
const STORAGE_CHANNEL_ID = process.env.STORAGE_CHANNEL_ID ? parseInt(process.env.STORAGE_CHANNEL_ID) : null;
const OWNER_ID          = process.env.OWNER_ID ? parseInt(process.env.OWNER_ID) : null;

if (!TOKEN || !MONGO_URI || !STORAGE_CHANNEL_ID || !OWNER_ID) {
  console.error("❌ Required: BOT_TOKEN, MONGO_URI, STORAGE_CHANNEL_ID, OWNER_ID");
  process.exit(1);
}

// ── Schemas ──────────────────────────────────────────────────────
const fileSchema = new mongoose.Schema({
  code:               { type: String },
  file_id:            { type: String },
  file_type:          { type: String },
  file_name:          { type: String },
  uploaded_by:        { type: Number },
  expires_at:         { type: Date },
  delivered_to:       [{ type: Number }],
  channel_message_id: { type: Number, default: null },
  created_at:         { type: Date },
});
const FileRecord = mongoose.model("FileRecord", fileSchema);

const bulkFileSchema = new mongoose.Schema({
  batch_code: { type: String },
  user_id:    { type: Number },
  files: [{
    file_id:   { type: String },
    file_type: { type: String },
    file_name: { type: String },
  }],
  created_at: { type: Date },
});
const BulkBatch = mongoose.model("BulkBatch", bulkFileSchema);

// ── Helpers ──────────────────────────────────────────────────────
function extractFileInfo(msg) {
  if (msg.document)   return { file_id: msg.document.file_id,  file_type: "document",  file_name: msg.document.file_name || "document" };
  if (msg.photo)      return { file_id: msg.photo[msg.photo.length-1].file_id, file_type: "photo", file_name: "photo.jpg" };
  if (msg.video)      return { file_id: msg.video.file_id,     file_type: "video",     file_name: msg.video.file_name || "video.mp4" };
  if (msg.audio)      return { file_id: msg.audio.file_id,     file_type: "audio",     file_name: msg.audio.file_name || "audio.mp3" };
  if (msg.voice)      return { file_id: msg.voice.file_id,     file_type: "voice",     file_name: "voice.ogg" };
  if (msg.video_note) return { file_id: msg.video_note.file_id,file_type: "video_note",file_name: "video_note.mp4" };
  return null;
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Main ─────────────────────────────────────────────────────────
async function migrate() {
  console.log("🔌 Connecting to MongoDB...");
  await mongoose.connect(MONGO_URI);
  console.log("✅ MongoDB connected\n");

  const bot = new TelegramBot(TOKEN, { polling: false });

  // Step 1: Get latest message_id in channel
  console.log("📡 Probing storage channel for latest message_id...");
  const probe = await bot.sendMessage(STORAGE_CHANNEL_ID, "🔄 Migration probe — will be deleted");
  const maxId = probe.message_id;
  await bot.deleteMessage(STORAGE_CHANNEL_ID, probe.message_id).catch(() => {});
  console.log(`📊 Latest message_id in channel: ${maxId}`);
  console.log(`🔍 Scanning message IDs 1 to ${maxId}...\n`);

  // Step 2: Scan all messages — forward to OWNER to get file object, then delete
  const channelFiles = []; // { message_id, file_id, file_type, file_name }
  let scanned = 0, found = 0;

  for (let msgId = 1; msgId <= maxId; msgId++) {
    try {
      const fwd = await bot.forwardMessage(OWNER_ID, STORAGE_CHANNEL_ID, msgId);
      const info = extractFileInfo(fwd);
      if (info) {
        channelFiles.push({ message_id: msgId, ...info });
        found++;
      }
      // Delete forwarded message from owner chat (cleanup)
      await bot.deleteMessage(OWNER_ID, fwd.message_id).catch(() => {});
    } catch (e) {
      // Message deleted/doesn't exist — skip silently
    }
    scanned++;
    if (scanned % 25 === 0) {
      process.stdout.write(`\r🔍 Scanned: ${scanned}/${maxId} | Files found: ${found}`);
      await wait(1000); // rate limit
    }
  }
  console.log(`\n\n✅ Channel scan complete. Files found: ${found}\n`);

  if (!channelFiles.length) {
    console.log("⚠️  No files found in storage channel. Exiting.");
    await mongoose.disconnect();
    return;
  }

  // Step 3: Load DB records
  console.log("🗄️  Loading MongoDB records...");
  const allRecords = await FileRecord.find({}).sort({ created_at: 1 }).lean();
  const allBulks   = await BulkBatch.find({}).sort({ created_at: 1 }).lean();
  const totalBulkFiles = allBulks.reduce((a, b) => a + b.files.length, 0);
  console.log(`📋 FileRecords: ${allRecords.length}`);
  console.log(`📋 BulkBatch total files: ${totalBulkFiles}\n`);

  // Step 4: Match by file_name first (most accurate), then fallback to file_type order
  // Build lookup: file_name -> channel file entries (queue)
  const nameMap = {}; // file_name (lowercase) -> [channelFile, ...]
  const typeMap = {}; // file_type -> [channelFile, ...]

  for (const cf of channelFiles) {
    const key = (cf.file_name || '').toLowerCase().trim();
    if (key && key !== 'document' && key !== 'photo.jpg' && key !== 'video.mp4' && key !== 'audio.mp3') {
      if (!nameMap[key]) nameMap[key] = [];
      nameMap[key].push(cf);
    }
    if (!typeMap[cf.file_type]) typeMap[cf.file_type] = [];
    typeMap[cf.file_type].push(cf);
  }

  // Clone typeMap queues for fallback (FIFO)
  const typeQueue = {};
  for (const t in typeMap) typeQueue[t] = [...typeMap[t]];

  function matchChannelFile(file_name, file_type) {
    // Try name match first
    const key = (file_name || '').toLowerCase().trim();
    if (key && nameMap[key] && nameMap[key].length > 0) {
      return nameMap[key].shift();
    }
    // Fallback: type queue
    if (typeQueue[file_type] && typeQueue[file_type].length > 0) {
      return typeQueue[file_type].shift();
    }
    return null;
  }

  // Step 5: Update FileRecords
  console.log("🔄 Updating FileRecords...");
  let frUpdated = 0, frSkipped = 0;
  for (const rec of allRecords) {
    const match = matchChannelFile(rec.file_name, rec.file_type);
    if (match) {
      await FileRecord.updateOne(
        { _id: rec._id },
        { $set: { file_id: match.file_id, channel_message_id: match.message_id } }
      );
      frUpdated++;
    } else {
      frSkipped++;
    }
  }
  console.log(`  ✅ Updated: ${frUpdated} | ⚠️  No match: ${frSkipped}`);

  // Step 6: Update BulkBatch files
  console.log("\n🔄 Updating BulkBatch files...");
  let bbUpdated = 0, bbSkipped = 0;
  for (const batch of allBulks) {
    let changed = false;
    for (const f of batch.files) {
      const match = matchChannelFile(f.file_name, f.file_type);
      if (match) {
        f.file_id = match.file_id;
        changed = true;
        bbUpdated++;
      } else {
        bbSkipped++;
      }
    }
    if (changed) {
      await BulkBatch.updateOne({ _id: batch._id }, { $set: { files: batch.files } });
    }
  }
  console.log(`  ✅ Updated: ${bbUpdated} | ⚠️  No match: ${bbSkipped}`);

  // Summary
  console.log("\n" + "=".repeat(55));
  console.log("✅  MIGRATION COMPLETE");
  console.log("=".repeat(55));
  console.log(`📁  FileRecords updated : ${frUpdated}`);
  console.log(`📦  BulkBatch files updated : ${bbUpdated}`);
  console.log(`⚠️   Could not match : ${frSkipped + bbSkipped}`);
  if (frSkipped + bbSkipped > 0) {
    console.log(`    (Unmatched files need to be re-uploaded manually)`);
  }
  console.log("=".repeat(55));

  await mongoose.disconnect();
  console.log("\n🔌 Done!");
}

migrate().catch(err => {
  console.error("❌ Migration error:", err.message);
  process.exit(1);
});
