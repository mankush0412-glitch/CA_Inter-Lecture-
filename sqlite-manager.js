/**
 * sqlite-manager.js
 * ─────────────────
 * Single source of truth for ALL SQLite operations.
 * Strategy:
 *   READ  → SQLite (fast, local)
 *   WRITE → SQLite first, then MongoDB async (backup)
 *   STARTUP → sync from MongoDB into SQLite
 */

const BetterSqlite3 = require('better-sqlite3');
const path = require('path');

// Render pe /tmp use karo (writable), VPS pe home directory
const IS_RENDER = !!process.env.RENDER_SERVICE_ID || process.env.RENDER === 'true';
const USE_SQLITE = !IS_RENDER && process.env.USE_SQLITE !== 'false';
const DB_PATH = process.env.SQLITE_PATH || (IS_RENDER ? '/tmp/bot_cache.db' : path.join(__dirname, 'bot_cache.db'));
let _db = null;

function getDb() {
  if (!_db) {
    _db = new BetterSqlite3(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
    _setupTables(_db);
  }
  return _db;
}

// ── Table Setup ───────────────────────────────────────────────────────────────

function _setupTables(db) {
  // ── Self-healing schema check (must run BEFORE the CREATE TABLE block below) ──
  // reward_redemptions / batch_reward_access are brand-new tables for this
  // feature. If an earlier/partial deploy left either one on disk with an
  // incompatible schema (missing columns, or — as seen in production — an
  // unexpected leftover NOT NULL column with no default, e.g. a stray `reward`
  // column), CREATE TABLE IF NOT EXISTS is a no-op and every insert would keep
  // failing forever. Since these are pure ledger tables for a new feature (no
  // legacy data worth preserving), the safest fix is: if the actual columns
  // don't EXACTLY match what this code expects, drop the table so it gets
  // recreated fresh, correct, right below.
  _resetTableIfIncompatible(db, 'reward_redemptions', ['id', 'userId', 'rewardType', 'batchId', 'batchName', 'pointsCost', 'redeemedAt', 'expiresAt']);
  _resetTableIfIncompatible(db, 'batch_reward_access', ['userId', 'batchId', 'batchName', 'expiresAt', 'grantedAt']);
  _resetTableIfIncompatible(db, 'spin_tokens', ['id', 'userId', 'token', 'issuedAt', 'expiresAt']);
  _resetTableIfIncompatible(db, 'spin_history', ['id', 'userId', 'pointsWon', 'spunAt']);
  _resetTableIfIncompatible(db, 'watched_lectures', ['userId', 'lectureId', 'watchedAt']);

  // file_records holds real user data (unlike the ledger tables above), so we
  // never drop it on schema mismatch — just add the new column if it's
  // missing, for any deployment where the SQLite file survives a restart.
  try {
    const frCols = db.prepare(`PRAGMA table_info(file_records)`).all().map(c => c.name);
    if (frCols.length && !frCols.includes('delivered_at')) {
      db.exec(`ALTER TABLE file_records ADD COLUMN delivered_at TEXT DEFAULT '{}'`);
    }
  } catch (e) { /* table doesn't exist yet — CREATE TABLE below will make it fresh */ }


  db.exec(`
    -- Batches (full document stored as JSON blob for simplicity)
    CREATE TABLE IF NOT EXISTS batches (
      id         TEXT PRIMARY KEY,
      data       TEXT NOT NULL,
      updated_at INTEGER DEFAULT 0
    );

    -- Users
    CREATE TABLE IF NOT EXISTS users (
      userId    TEXT PRIMARY KEY,
      firstName TEXT DEFAULT '',
      lastName  TEXT DEFAULT '',
      username  TEXT DEFAULT '',
      firstSeen INTEGER DEFAULT 0,
      lastSeen  INTEGER DEFAULT 0
    );

    -- Announcements
    CREATE TABLE IF NOT EXISTS announcements (
      id        TEXT PRIMARY KEY,
      emoji     TEXT DEFAULT '📢',
      heading   TEXT NOT NULL,
      body      TEXT NOT NULL,
      createdAt INTEGER DEFAULT 0
    );

    -- Access tokens (ad-watch access)
    CREATE TABLE IF NOT EXISTS access (
      userId      TEXT PRIMARY KEY,
      expiresAt   INTEGER DEFAULT 0,
      claimsToday INTEGER DEFAULT 0,
      claimDay    TEXT DEFAULT ''
    );

    -- Ad tokens (one-time tokens before ad)
    CREATE TABLE IF NOT EXISTS ad_tokens (
      id        TEXT PRIMARY KEY,
      userId    TEXT NOT NULL,
      token     TEXT NOT NULL UNIQUE,
      issuedAt  INTEGER DEFAULT 0,
      expiresAt INTEGER DEFAULT 0
    );

    -- Referrals
    CREATE TABLE IF NOT EXISTS referrals (
      id          TEXT PRIMARY KEY,
      referrerId  TEXT NOT NULL,
      referredId  TEXT NOT NULL UNIQUE,
      createdAt   INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrerId);

    -- Coupons
    CREATE TABLE IF NOT EXISTS coupons (
      id          TEXT PRIMARY KEY,
      code        TEXT NOT NULL UNIQUE,
      discountPct REAL NOT NULL,
      expiresAt   INTEGER DEFAULT 0,
      isActive    INTEGER DEFAULT 1,
      usageCount  INTEGER DEFAULT 0,
      batchIds    TEXT DEFAULT '[]',
      createdAt   INTEGER DEFAULT 0
    );

    -- Auto lecture session (singleton)
    CREATE TABLE IF NOT EXISTS auto_lec_session (
      id           TEXT PRIMARY KEY DEFAULT 'singleton',
      active       INTEGER DEFAULT 0,
      batchId      TEXT,
      subjectId    TEXT,
      chapterId    TEXT,
      unitId       TEXT,
      lectureCount INTEGER DEFAULT 0,
      batchName    TEXT DEFAULT '',
      subjectName  TEXT DEFAULT '',
      chapterName  TEXT DEFAULT '',
      unitName     TEXT DEFAULT ''
    );

    -- File records
    CREATE TABLE IF NOT EXISTS file_records (
      id             TEXT PRIMARY KEY,
      code           TEXT NOT NULL UNIQUE,
      file_id        TEXT NOT NULL,
      file_type      TEXT NOT NULL,
      file_name      TEXT DEFAULT 'file',
      uploaded_by    INTEGER,
      expires_at     INTEGER DEFAULT NULL,
      delivered_to   TEXT DEFAULT '[]',
      delivered_at   TEXT DEFAULT '{}',
      created_at     INTEGER DEFAULT 0,
      channel_msg_id INTEGER DEFAULT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_file_records_code ON file_records(code);
    CREATE INDEX IF NOT EXISTS idx_file_records_uploader ON file_records(uploaded_by);

    -- Bulk batches
    CREATE TABLE IF NOT EXISTS bulk_batches (
      id          TEXT PRIMARY KEY,
      batch_code  TEXT NOT NULL UNIQUE,
      user_id     INTEGER NOT NULL,
      files       TEXT DEFAULT '[]',
      created_at  INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_bulk_batches_code ON bulk_batches(batch_code);
    CREATE INDEX IF NOT EXISTS idx_bulk_batches_user ON bulk_batches(user_id);

    -- Pending deletes
    CREATE TABLE IF NOT EXISTS pending_deletes (
      id         TEXT PRIMARY KEY,
      chat_id    INTEGER NOT NULL,
      message_id INTEGER NOT NULL,
      delete_at  INTEGER NOT NULL
    );

    -- Pending "un-deliver" markers: removes a chatId from a file's delivered_to
    -- list once its 6h re-request cooldown expires. Persisted (not just an
    -- in-memory setTimeout) so a bot restart doesn't leave the chatId stuck in
    -- delivered_to forever, permanently blocking re-requests.
    CREATE TABLE IF NOT EXISTS pending_undelivers (
      id            TEXT PRIMARY KEY,
      file_record_id TEXT NOT NULL,
      code          TEXT,
      chat_id       INTEGER NOT NULL,
      undeliver_at  INTEGER NOT NULL
    );

    -- Daily video limits
    CREATE TABLE IF NOT EXISTS daily_video_limits (
      userId    INTEGER PRIMARY KEY,
      count     INTEGER DEFAULT 0,
      resetDate TEXT NOT NULL
    );

    -- Ads-Free subscriptions (monthly, manually-renewed — see grantAdsFreeAccess
    -- in server.js). expiresAt is a unix-ms timestamp; active = expiresAt > now.
    CREATE TABLE IF NOT EXISTS ads_free_subscriptions (
      userId    TEXT PRIMARY KEY,
      expiresAt INTEGER NOT NULL
    );

    -- Reward Redemptions (points-spend ledger — history of every reward claimed)
    CREATE TABLE IF NOT EXISTS reward_redemptions (
      id         TEXT PRIMARY KEY,
      userId     TEXT NOT NULL,
      rewardType TEXT NOT NULL,        -- 'accessPass' | 'batch24h' | 'batch7d'
      batchId    TEXT DEFAULT NULL,    -- NULL for accessPass (not batch-specific)
      batchName  TEXT DEFAULT '',      -- snapshot of batch name at redeem time
      pointsCost INTEGER NOT NULL,
      redeemedAt INTEGER DEFAULT 0,
      expiresAt  INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_reward_redemptions_user ON reward_redemptions(userId);

    -- Batch Reward Access (live, time-limited premium-batch unlocks granted via points)
    -- Kept completely separate from batches.premiumUsers (which is permanent/paid access),
    -- so an expiring reward can never accidentally strip someone's permanent access.
    CREATE TABLE IF NOT EXISTS batch_reward_access (
      userId    TEXT NOT NULL,
      batchId   TEXT NOT NULL,
      batchName TEXT DEFAULT '',
      expiresAt INTEGER DEFAULT 0,
      grantedAt INTEGER DEFAULT 0,
      PRIMARY KEY (userId, batchId)
    );
    CREATE INDEX IF NOT EXISTS idx_batch_reward_access_user ON batch_reward_access(userId);

    -- Spin Tokens (proves a spin's ad was actually watched, before the spin is allowed to count)
    -- Mirrors the ad_tokens table's exact pattern, kept separate so the Earn tab's
    -- ad-watch flow never interferes with the Access tab's ad-watch flow.
    CREATE TABLE IF NOT EXISTS spin_tokens (
      id        TEXT PRIMARY KEY,
      userId    TEXT NOT NULL,
      token     TEXT NOT NULL,
      issuedAt  INTEGER DEFAULT 0,
      expiresAt INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_spin_tokens_user ON spin_tokens(userId);

    -- Spin History (ledger of completed spins). Three jobs in one table:
    -- 1) SUM(pointsWon) = total points earned from spinning (feeds the points formula)
    -- 2) COUNT(*) since midnight = today's spin count (feeds the daily-5-spin limit)
    -- 3) MAX(spunAt) = last spin time (feeds the 10-second cooldown)
    CREATE TABLE IF NOT EXISTS spin_history (
      id        TEXT PRIMARY KEY,
      userId    TEXT NOT NULL,
      pointsWon INTEGER NOT NULL,
      spunAt    INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_spin_history_user ON spin_history(userId);

    -- Watched Lectures (server-side, keyed by the stable Telegram userId — NOT
    -- browser localStorage. This survives redeploys, tunnel URL changes, cache
    -- clears, and switching devices, none of which affect a userId-keyed row.)
    CREATE TABLE IF NOT EXISTS watched_lectures (
      userId    TEXT NOT NULL,
      lectureId TEXT NOT NULL,
      watchedAt INTEGER DEFAULT 0,
      PRIMARY KEY (userId, lectureId)
    );
    CREATE INDEX IF NOT EXISTS idx_watched_lectures_user ON watched_lectures(userId);

    -- Manual point adjustments (admin /addpoints command). Kept as a separate ledger,
    -- same pattern as referrals/spin history — points are still never stored as a
    -- direct balance column, this just adds one more signed term into the formula
    -- (getPointsBreakdown in course.js), so nothing can drift or double-count.
    CREATE TABLE IF NOT EXISTS point_adjustments (
      id        TEXT PRIMARY KEY,
      userId    TEXT NOT NULL,
      points    INTEGER NOT NULL,     -- can be negative (manual deduction)
      note      TEXT DEFAULT '',
      createdAt INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_point_adjustments_user ON point_adjustments(userId);

    -- Manual spin-limit adjustments (admin /addspins command). Same signed-ledger
    -- pattern as point_adjustments: the net sum for a user is added on top of the
    -- global SPIN_DAILY_LIMIT to get that user's effective daily spin limit — so
    -- an admin can grant bonus spins (positive) or cap a user down (negative)
    -- without ever touching the base config or overwriting a raw balance.
    CREATE TABLE IF NOT EXISTS spin_adjustments (
      id        TEXT PRIMARY KEY,
      userId    TEXT NOT NULL,
      delta     INTEGER NOT NULL,     -- can be negative
      note      TEXT DEFAULT '',
      createdAt INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_spin_adjustments_user ON spin_adjustments(userId);

    -- Banned users — blocks a userId from receiving lecture deliveries via the bot.
    CREATE TABLE IF NOT EXISTS banned_users (
      userId   TEXT PRIMARY KEY,
      reason   TEXT DEFAULT '',
      bannedAt INTEGER DEFAULT 0,
      bannedBy TEXT DEFAULT ''
    );

    -- Users exempted from the ad-blocker gate (index.html blocks the whole app
    -- if the Monetag SDK fails to load — owner is always exempt, this table
    -- lets the owner exempt specific other users too, e.g. testers or VIPs).
    CREATE TABLE IF NOT EXISTS adblock_exempt_users (
      userId    TEXT PRIMARY KEY,
      note      TEXT DEFAULT '',
      addedAt   INTEGER DEFAULT 0,
      addedBy   TEXT DEFAULT ''
    );

    -- Lecture request log — one row per successful lecture/video delivery via the
    -- bot's /start deep link. Used only to detect a burst of requests (possible
    -- bulk-download/leak behavior) within a short rolling window; rows older than
    -- a day are pruned periodically so this never grows unbounded.
    CREATE TABLE IF NOT EXISTS lecture_requests (
      id          TEXT PRIMARY KEY,
      userId      TEXT NOT NULL,
      code        TEXT NOT NULL,
      requestedAt INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_lecture_requests_user ON lecture_requests(userId, requestedAt);

    -- Generic key/value settings store (JSON-encoded values). Currently used for
    -- the configurable suspicious-activity rules (see settings.get/set below),
    -- but written as a generic table so future admin-tunable settings can reuse
    -- it without another migration.
    CREATE TABLE IF NOT EXISTS bot_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Device/IP sightings — one row per app-open, used only to spot the same
    -- browser fingerprint or IP being used across multiple different Telegram
    -- userIds (a heuristic for multi-accounting), never for anything else.
    -- Rows older than the correlation window are pruned periodically.
    CREATE TABLE IF NOT EXISTS device_sightings (
      id          TEXT PRIMARY KEY,
      userId      TEXT NOT NULL,
      fingerprint TEXT DEFAULT '',
      ip          TEXT DEFAULT '',
      seenAt      INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_device_sightings_fp ON device_sightings(fingerprint);
    CREATE INDEX IF NOT EXISTS idx_device_sightings_ip ON device_sightings(ip);
    CREATE INDEX IF NOT EXISTS idx_device_sightings_user ON device_sightings(userId);
  `);
}

function _resetTableIfIncompatible(db, table, expectedColumns) {
  let existingCols;
  try {
    existingCols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  } catch (e) {
    return; // couldn't inspect it — leave it for CREATE TABLE IF NOT EXISTS to handle
  }
  if (existingCols.length === 0) return; // table doesn't exist yet — nothing to reset
  const existingSet = new Set(existingCols);
  const matches = existingCols.length === expectedColumns.length && expectedColumns.every(c => existingSet.has(c));
  if (!matches) {
    console.log(`  🔧 ${table} schema mismatch (has: [${existingCols.join(',')}], expected: [${expectedColumns.join(',')}]) — resetting table`);
    try {
      db.exec(`DROP TABLE IF EXISTS ${table}`);
    } catch (e) {
      console.error(`  ❌ Failed to reset ${table}:`, e.message);
    }
  }
}

// ── Startup Sync from MongoDB ─────────────────────────────────────────────────

async function syncFromMongo(mongoose) {
  const db = getDb();
  console.log('🔄 Syncing from MongoDB to SQLite...');

  try {
    // 1. Batches
    const Batch = mongoose.model('Batch');
    const batches = await Batch.find({}).lean();
    const upsertBatch = db.prepare(`INSERT INTO batches(id,data,updated_at) VALUES(?,?,?)
      ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`);
    const batchTx = db.transaction(() => {
      for (const b of batches) upsertBatch.run(String(b._id), JSON.stringify(b), Date.now());
    });
    batchTx();
    console.log(`  ✅ Batches: ${batches.length}`);
  } catch (e) { console.error('  ❌ Batches sync error:', e.message); }

  try {
    // 2. Users
    const User = mongoose.models.User;
    if (User) {
      const users = await User.find({}).lean();
      const upsertUser = db.prepare(`INSERT INTO users(userId,firstName,lastName,username,firstSeen,lastSeen)
        VALUES(?,?,?,?,?,?) ON CONFLICT(userId) DO UPDATE SET
        firstName=excluded.firstName, lastName=excluded.lastName,
        username=excluded.username, lastSeen=excluded.lastSeen`);
      const userTx = db.transaction(() => {
        for (const u of users) upsertUser.run(
          u.userId, u.firstName||'', u.lastName||'', u.username||'',
          new Date(u.firstSeen||0).getTime(), new Date(u.lastSeen||0).getTime()
        );
      });
      userTx();
      console.log(`  ✅ Users: ${users.length}`);
    }
  } catch (e) { console.error('  ❌ Users sync error:', e.message); }

  try {
    // 3. Announcements
    const Announcement = mongoose.models.Announcement;
    if (Announcement) {
      const anns = await Announcement.find({}).lean();
      const upsertAnn = db.prepare(`INSERT INTO announcements(id,emoji,heading,body,createdAt)
        VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        emoji=excluded.emoji, heading=excluded.heading, body=excluded.body`);
      const annTx = db.transaction(() => {
        for (const a of anns) upsertAnn.run(
          String(a._id), a.emoji||'📢', a.heading, a.body,
          new Date(a.createdAt||0).getTime()
        );
      });
      annTx();
      console.log(`  ✅ Announcements: ${anns.length}`);
    }
  } catch (e) { console.error('  ❌ Announcements sync error:', e.message); }

  try {
    // 4. Access
    const Access = mongoose.models.Access;
    if (Access) {
      const records = await Access.find({}).lean();
      const upsertAccess = db.prepare(`INSERT INTO access(userId,expiresAt,claimsToday,claimDay)
        VALUES(?,?,?,?) ON CONFLICT(userId) DO UPDATE SET
        expiresAt=excluded.expiresAt, claimsToday=excluded.claimsToday, claimDay=excluded.claimDay`);
      const accessTx = db.transaction(() => {
        for (const r of records) upsertAccess.run(
          r.userId, new Date(r.expiresAt||0).getTime(),
          r.claimsToday||0, r.claimDay||''
        );
      });
      accessTx();
      console.log(`  ✅ Access records: ${records.length}`);
    }
  } catch (e) { console.error('  ❌ Access sync error:', e.message); }

  try {
    // 5. Referrals
    const Referral = mongoose.models.Referral;
    if (Referral) {
      const refs = await Referral.find({}).lean();
      const upsertRef = db.prepare(`INSERT OR IGNORE INTO referrals(id,referrerId,referredId,createdAt)
        VALUES(?,?,?,?)`);
      const refTx = db.transaction(() => {
        for (const r of refs) upsertRef.run(
          String(r._id), r.referrerId, r.referredId,
          new Date(r.createdAt||0).getTime()
        );
      });
      refTx();
      console.log(`  ✅ Referrals: ${refs.length}`);
    }
  } catch (e) { console.error('  ❌ Referrals sync error:', e.message); }

  try {
    // 6. Coupons
    const Coupon = mongoose.models.Coupon;
    if (Coupon) {
      const coupons = await Coupon.find({}).lean();
      const upsertCoupon = db.prepare(`INSERT INTO coupons(id,code,discountPct,expiresAt,isActive,usageCount,batchIds,createdAt)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        code=excluded.code, discountPct=excluded.discountPct, expiresAt=excluded.expiresAt,
        isActive=excluded.isActive, usageCount=excluded.usageCount, batchIds=excluded.batchIds`);
      const couponTx = db.transaction(() => {
        for (const c of coupons) upsertCoupon.run(
          String(c._id), c.code, c.discountPct,
          new Date(c.expiresAt||0).getTime(),
          c.isActive ? 1 : 0, c.usageCount||0,
          JSON.stringify(c.batchIds||[]),
          new Date(c.createdAt||0).getTime()
        );
      });
      couponTx();
      console.log(`  ✅ Coupons: ${coupons.length}`);
    }
  } catch (e) { console.error('  ❌ Coupons sync error:', e.message); }

  try {
    // 7. AutoLecSession
    const AutoLecSession = mongoose.models.AutoLecSession;
    if (AutoLecSession) {
      const sess = await AutoLecSession.findById('singleton').lean();
      if (sess) {
        db.prepare(`INSERT INTO auto_lec_session(id,active,batchId,subjectId,chapterId,unitId,lectureCount,batchName,subjectName,chapterName,unitName)
          VALUES('singleton',?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET active=excluded.active,batchId=excluded.batchId,
          subjectId=excluded.subjectId,chapterId=excluded.chapterId,unitId=excluded.unitId,
          lectureCount=excluded.lectureCount,batchName=excluded.batchName,
          subjectName=excluded.subjectName,chapterName=excluded.chapterName,unitName=excluded.unitName`
        ).run(
          sess.active?1:0, sess.batchId||null, sess.subjectId||null,
          sess.chapterId||null, sess.unitId||null, sess.lectureCount||0,
          sess.batchName||'', sess.subjectName||'', sess.chapterName||'', sess.unitName||''
        );
        console.log(`  ✅ AutoLecSession synced`);
      }
    }
  } catch (e) { console.error('  ❌ AutoLecSession sync error:', e.message); }

  try {
    // 8. FileRecords
    const FileRecord = mongoose.models.FileRecord;
    if (FileRecord) {
      const files = await FileRecord.find({}).lean();
      const upsertFile = db.prepare(`INSERT INTO file_records(id,code,file_id,file_type,file_name,uploaded_by,expires_at,delivered_to,delivered_at,created_at,channel_msg_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          code=excluded.code,file_id=excluded.file_id,delivered_to=excluded.delivered_to,delivered_at=excluded.delivered_at,channel_msg_id=excluded.channel_msg_id
        ON CONFLICT(code) DO UPDATE SET
          id=excluded.id,file_id=excluded.file_id,delivered_to=excluded.delivered_to,delivered_at=excluded.delivered_at,channel_msg_id=excluded.channel_msg_id`);
      let fileOk = 0, fileFail = 0;
      const fileTx = db.transaction(() => {
        for (const f of files) {
          try {
            upsertFile.run(
              String(f._id), f.code, f.file_id, f.file_type, f.file_name||'file',
              f.uploaded_by||null,
              f.expires_at ? new Date(f.expires_at).getTime() : null,
              JSON.stringify(f.delivered_to||[]),
              f.delivered_at || '{}',
              new Date(f.created_at||0).getTime(),
              f.channel_msg_id||null
            );
            fileOk++;
          } catch (rowErr) {
            fileFail++;
            console.error(`    ⚠️ FileRecord skipped (id=${f._id}, code=${f.code}): ${rowErr.message}`);
          }
        }
      });
      fileTx();
      console.log(`  ✅ FileRecords: ${fileOk}${fileFail ? ` (⚠️ ${fileFail} skipped)` : ''}`);
    }
  } catch (e) { console.error('  ❌ FileRecords sync error:', e.message); }

  try {
    // 9. BulkBatches
    const BulkBatch = mongoose.models.BulkBatch;
    if (BulkBatch) {
      const bulks = await BulkBatch.find({}).lean();
      const upsertBulk = db.prepare(`INSERT INTO bulk_batches(id,batch_code,user_id,files,created_at)
        VALUES(?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          batch_code=excluded.batch_code,files=excluded.files
        ON CONFLICT(batch_code) DO UPDATE SET
          id=excluded.id,files=excluded.files`);
      let bulkOk = 0, bulkFail = 0;
      const bulkTx = db.transaction(() => {
        for (const b of bulks) {
          try {
            upsertBulk.run(
              String(b._id), b.batch_code, b.user_id,
              JSON.stringify(b.files||[]),
              new Date(b.created_at||0).getTime()
            );
            bulkOk++;
          } catch (rowErr) {
            bulkFail++;
            console.error(`    ⚠️ BulkBatch skipped (id=${b._id}, batch_code=${b.batch_code}): ${rowErr.message}`);
          }
        }
      });
      bulkTx();
      console.log(`  ✅ BulkBatches: ${bulkOk}${bulkFail ? ` (⚠️ ${bulkFail} skipped)` : ''}`);
    }
  } catch (e) { console.error('  ❌ BulkBatches sync error:', e.message); }

  try {
    // 10. PendingDeletes
    const PendingDelete = mongoose.models.PendingDelete;
    if (PendingDelete) {
      const pds = await PendingDelete.find({}).lean();
      const upsertPD = db.prepare(`INSERT INTO pending_deletes(id,chat_id,message_id,delete_at)
        VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING`);
      const pdTx = db.transaction(() => {
        for (const p of pds) upsertPD.run(
          String(p._id), p.chat_id, p.message_id,
          new Date(p.delete_at).getTime()
        );
      });
      pdTx();
      console.log(`  ✅ PendingDeletes: ${pds.length}`);
    }
  } catch (e) { console.error('  ❌ PendingDeletes sync error:', e.message); }

  try {
    // 10b. PendingUndelivers
    const PendingUndeliver = mongoose.models.PendingUndeliver;
    if (PendingUndeliver) {
      const pus = await PendingUndeliver.find({}).lean();
      const upsertPU = db.prepare(`INSERT INTO pending_undelivers(id,file_record_id,code,chat_id,undeliver_at)
        VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING`);
      let puOk = 0, puFail = 0;
      const puTx = db.transaction(() => {
        for (const p of pus) {
          try {
            upsertPU.run(
              String(p._id), String(p.file_record_id), p.code || null, p.chat_id,
              new Date(p.undeliver_at).getTime()
            );
            puOk++;
          } catch (rowErr) {
            puFail++;
            console.error(`    ⚠️ PendingUndeliver skipped (id=${p._id}): ${rowErr.message}`);
          }
        }
      });
      puTx();
      console.log(`  ✅ PendingUndelivers: ${puOk}${puFail ? ` (⚠️ ${puFail} skipped)` : ''}`);
    }
  } catch (e) { console.error('  ❌ PendingUndelivers sync error:', e.message); }

  try {
    // 11. DailyVideoLimits
    const DailyVideoLimit = mongoose.models.DailyVideoLimit;
    if (DailyVideoLimit) {
      const limits = await DailyVideoLimit.find({}).lean();
      const upsertLimit = db.prepare(`INSERT INTO daily_video_limits(userId,count,resetDate)
        VALUES(?,?,?) ON CONFLICT(userId) DO UPDATE SET count=excluded.count, resetDate=excluded.resetDate`);
      const limitTx = db.transaction(() => {
        for (const l of limits) upsertLimit.run(l.userId, l.count||0, l.resetDate||'');
      });
      limitTx();
      console.log(`  ✅ DailyVideoLimits: ${limits.length}`);
    }
  } catch (e) { console.error('  ❌ DailyVideoLimits sync error:', e.message); }

  try {
    // 11b. Ads-Free Subscriptions
    const AdsFreeSubscription = mongoose.models.AdsFreeSubscription;
    if (AdsFreeSubscription) {
      const subs = await AdsFreeSubscription.find({}).lean();
      const upsertAF = db.prepare(`INSERT INTO ads_free_subscriptions(userId,expiresAt)
        VALUES(?,?) ON CONFLICT(userId) DO UPDATE SET expiresAt=excluded.expiresAt`);
      const afTx = db.transaction(() => {
        for (const a of subs) upsertAF.run(String(a.userId), new Date(a.expiresAt).getTime());
      });
      afTx();
      console.log(`  ✅ AdsFreeSubscriptions: ${subs.length}`);
    }
  } catch (e) { console.error('  ❌ AdsFreeSubscriptions sync error:', e.message); }

  try {
    // 12. Reward Redemptions
    const RewardRedemption = mongoose.models.RewardRedemption;
    if (RewardRedemption) {
      const rows = await RewardRedemption.find({}).lean();
      const upsertRR = db.prepare(`INSERT INTO reward_redemptions(id,userId,rewardType,batchId,batchName,pointsCost,redeemedAt,expiresAt)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`);
      const rrTx = db.transaction(() => {
        for (const r of rows) upsertRR.run(
          String(r._id), r.userId, r.rewardType, r.batchId || null, r.batchName || '',
          r.pointsCost, new Date(r.redeemedAt || 0).getTime(), new Date(r.expiresAt || 0).getTime()
        );
      });
      rrTx();
      console.log(`  ✅ Reward Redemptions: ${rows.length}`);
    }
  } catch (e) { console.error('  ❌ Reward Redemptions sync error:', e.message); }

  try {
    // 13. Batch Reward Access
    const BatchRewardAccess = mongoose.models.BatchRewardAccess;
    if (BatchRewardAccess) {
      const rows = await BatchRewardAccess.find({}).lean();
      const upsertBRA = db.prepare(`INSERT INTO batch_reward_access(userId,batchId,batchName,expiresAt,grantedAt)
        VALUES(?,?,?,?,?) ON CONFLICT(userId,batchId) DO UPDATE SET
        expiresAt=excluded.expiresAt, batchName=excluded.batchName`);
      const braTx = db.transaction(() => {
        for (const r of rows) upsertBRA.run(
          r.userId, r.batchId, r.batchName || '',
          new Date(r.expiresAt || 0).getTime(), new Date(r.grantedAt || 0).getTime()
        );
      });
      braTx();
      console.log(`  ✅ Batch Reward Access: ${rows.length}`);
    }
  } catch (e) { console.error('  ❌ Batch Reward Access sync error:', e.message); }

  try {
    // 14. Spin History (spin_tokens are short-lived ad-watch proofs — not worth syncing, same as ad_tokens)
    const SpinHistory = mongoose.models.SpinHistory;
    if (SpinHistory) {
      const rows = await SpinHistory.find({}).lean();
      const upsertSH = db.prepare(`INSERT INTO spin_history(id,userId,pointsWon,spunAt)
        VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING`);
      const shTx = db.transaction(() => {
        for (const r of rows) upsertSH.run(String(r._id), r.userId, r.pointsWon, new Date(r.spunAt || 0).getTime());
      });
      shTx();
      console.log(`  ✅ Spin History: ${rows.length}`);
    }
  } catch (e) { console.error('  ❌ Spin History sync error:', e.message); }

  try {
    // 15. Watched Lectures
    const WatchedLecture = mongoose.models.WatchedLecture;
    if (WatchedLecture) {
      const rows = await WatchedLecture.find({}).lean();
      const upsertWL = db.prepare(`INSERT INTO watched_lectures(userId,lectureId,watchedAt)
        VALUES(?,?,?) ON CONFLICT(userId,lectureId) DO NOTHING`);
      const wlTx = db.transaction(() => {
        for (const r of rows) upsertWL.run(r.userId, r.lectureId, new Date(r.watchedAt || 0).getTime());
      });
      wlTx();
      console.log(`  ✅ Watched Lectures: ${rows.length}`);
    }
  } catch (e) { console.error('  ❌ Watched Lectures sync error:', e.message); }

  try {
    // 16. Point Adjustments (manual admin grants/deductions)
    const PointAdjustment = mongoose.models.PointAdjustment;
    if (PointAdjustment) {
      const rows = await PointAdjustment.find({}).lean();
      const upsertPA = db.prepare(`INSERT INTO point_adjustments(id,userId,points,note,createdAt)
        VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING`);
      const paTx = db.transaction(() => {
        for (const r of rows) upsertPA.run(String(r._id), r.userId, r.points, r.note||'', new Date(r.createdAt||0).getTime());
      });
      paTx();
      console.log(`  ✅ Point Adjustments: ${rows.length}`);
    }
  } catch (e) { console.error('  ❌ Point Adjustments sync error:', e.message); }

  console.log('✅ SQLite sync complete');
}

// Pushes the CURRENT SQLite state up into MongoDB. SQLite is the live source of
// truth (every write lands here first, synchronously); Mongo is normally kept in
// step by a fire-and-forget backup write alongside each SQLite write. This
// function exists as a manual "catch up" tool for the rare case one of those
// fire-and-forget Mongo writes silently failed (network blip, Mongo hiccup,
// etc. — they're wrapped in .catch(()=>{}) by design so a Mongo outage never
// blocks the user-facing action) — running it forces every row to be re-pushed.
//
// Matching keys are chosen per-table to avoid creating duplicates in Mongo:
// where the SQLite row's id is the actual Mongo _id (batches, announcements,
// coupons) we match on _id; everywhere else we match on whatever natural/unique
// key the app already uses for that entity (userId, code, batch_code, etc.) —
// mirroring the same matching strategy syncFromMongo already uses in reverse.
//
// Skips: spin_tokens (short-lived ad-watch proofs) and pending_deletes /
// pending_undelivers (transient scheduled-job markers) — none of these are
// data worth backing up, same reasoning the app already applies to spin_tokens
// elsewhere.
//
// getPointsBreakdown (optional) — pass courseRoutes.getPointsBreakdown from server.js.
// If given, each user's CURRENT points balance is computed fresh from SQLite (the
// live source of truth — referrals + spin + manual adjustments − spent) and saved
// onto their Mongo User document as a read-only snapshot (points/pointsBreakdown/
// pointsSyncedAt fields). This is only a cached snapshot for visibility when
// browsing Mongo directly — the app itself never reads points from here, it always
// recomputes live from SQLite, so this snapshot can never cause a points mismatch
// in the product itself, only go stale in the Mongo copy until the next /sync.
async function syncToMongo(mongoose, getPointsBreakdown) {
  const db = getDb();
  const summary = {};
  console.log('🔄 Syncing from SQLite to MongoDB...');

  try {
    // 1. Batches (SQLite id === Mongo _id already)
    const Batch = mongoose.model('Batch');
    const rows = db.prepare(`SELECT data FROM batches`).all().map(r => JSON.parse(r.data));
    let ok = 0;
    for (const b of rows) {
      try { await Batch.findByIdAndUpdate(b._id, b, { upsert: true }); ok++; } catch (e) {}
    }
    summary.batches = ok;
    console.log(`  ✅ Batches: ${ok}/${rows.length}`);
  } catch (e) { console.error('  ❌ Batches sync error:', e.message); summary.batches = 'error'; }

  try {
    // 2. Users (matched by userId) — also snapshots each user's current points
    // balance onto their Mongo doc when getPointsBreakdown is provided.
    const User = mongoose.models.User;
    if (User) {
      const rows = db.prepare(`SELECT * FROM users`).all();
      const now = new Date();
      let totalPoints = 0, usersWithPoints = 0;
      const ops = rows.map(u => {
        const fields = { userId: u.userId, firstName: u.firstName||'', lastName: u.lastName||'', username: u.username||'', firstSeen: new Date(u.firstSeen||0), lastSeen: new Date(u.lastSeen||0) };
        if (typeof getPointsBreakdown === 'function') {
          try {
            const b = getPointsBreakdown(u.userId);
            fields.points = b.points;
            fields.pointsBreakdown = { referrals: b.referrals, spinEarned: b.spinEarned, adjustment: b.adjustment, spent: b.spent };
            fields.pointsSyncedAt = now;
            totalPoints += b.points;
            if (b.points > 0) usersWithPoints++;
          } catch (e) { /* leave points fields untouched for this user if computation fails */ }
        }
        return { updateOne: { filter: { userId: u.userId }, update: { $set: fields }, upsert: true } };
      });
      if (ops.length) await User.bulkWrite(ops, { ordered: false });
      summary.users = rows.length;
      if (typeof getPointsBreakdown === 'function') { summary.totalPoints = totalPoints; summary.usersWithPoints = usersWithPoints; }
      console.log(`  ✅ Users: ${rows.length}${typeof getPointsBreakdown === 'function' ? ` (points snapshot: ${totalPoints} total across ${usersWithPoints} users)` : ''}`);
    }
  } catch (e) { console.error('  ❌ Users sync error:', e.message); summary.users = 'error'; }

  try {
    // 3. Announcements (SQLite id === Mongo _id)
    const Announcement = mongoose.models.Announcement;
    if (Announcement) {
      const rows = db.prepare(`SELECT * FROM announcements`).all();
      let ok = 0;
      for (const a of rows) {
        try {
          await Announcement.findByIdAndUpdate(a.id, { emoji: a.emoji||'📢', heading: a.heading, body: a.body, createdAt: new Date(a.createdAt||0) }, { upsert: true });
          ok++;
        } catch (e) {}
      }
      summary.announcements = ok;
      console.log(`  ✅ Announcements: ${ok}/${rows.length}`);
    }
  } catch (e) { console.error('  ❌ Announcements sync error:', e.message); summary.announcements = 'error'; }

  try {
    // 4. Access (matched by userId)
    const Access = mongoose.models.Access;
    if (Access) {
      const rows = db.prepare(`SELECT * FROM access`).all();
      const ops = rows.map(r => ({
        updateOne: {
          filter: { userId: r.userId },
          update: { $set: { userId: r.userId, expiresAt: new Date(r.expiresAt||0), claimsToday: r.claimsToday||0, claimDay: r.claimDay||'' } },
          upsert: true,
        },
      }));
      if (ops.length) await Access.bulkWrite(ops, { ordered: false });
      summary.access = rows.length;
      console.log(`  ✅ Access: ${rows.length}`);
    }
  } catch (e) { console.error('  ❌ Access sync error:', e.message); summary.access = 'error'; }

  try {
    // 5. Referrals (matched by referredId — unique per referral by design)
    const Referral = mongoose.models.Referral;
    if (Referral) {
      const rows = db.prepare(`SELECT * FROM referrals`).all();
      const ops = rows.map(r => ({
        updateOne: {
          filter: { referredId: r.referredId },
          update: { $setOnInsert: { referrerId: r.referrerId, referredId: r.referredId, createdAt: new Date(r.createdAt||0) } },
          upsert: true,
        },
      }));
      if (ops.length) await Referral.bulkWrite(ops, { ordered: false });
      summary.referrals = rows.length;
      console.log(`  ✅ Referrals: ${rows.length}`);
    }
  } catch (e) { console.error('  ❌ Referrals sync error:', e.message); summary.referrals = 'error'; }

  try {
    // 6. Coupons (SQLite id === Mongo _id)
    const Coupon = mongoose.models.Coupon;
    if (Coupon) {
      const rows = db.prepare(`SELECT * FROM coupons`).all();
      let ok = 0;
      for (const c of rows) {
        try {
          await Coupon.findByIdAndUpdate(c.id, {
            code: c.code, discountPct: c.discountPct, expiresAt: new Date(c.expiresAt||0),
            isActive: c.isActive === 1, usageCount: c.usageCount||0,
            batchIds: JSON.parse(c.batchIds||'[]'), createdAt: new Date(c.createdAt||0),
          }, { upsert: true });
          ok++;
        } catch (e) {}
      }
      summary.coupons = ok;
      console.log(`  ✅ Coupons: ${ok}/${rows.length}`);
    }
  } catch (e) { console.error('  ❌ Coupons sync error:', e.message); summary.coupons = 'error'; }

  try {
    // 7. AutoLecSession (singleton)
    const AutoLecSession = mongoose.models.AutoLecSession;
    if (AutoLecSession) {
      const s = db.prepare(`SELECT * FROM auto_lec_session WHERE id='singleton'`).get();
      if (s) {
        await AutoLecSession.findByIdAndUpdate('singleton', {
          active: s.active === 1, batchId: s.batchId, subjectId: s.subjectId, chapterId: s.chapterId,
          unitId: s.unitId, lectureCount: s.lectureCount||0, batchName: s.batchName||'',
          subjectName: s.subjectName||'', chapterName: s.chapterName||'', unitName: s.unitName||'',
        }, { upsert: true });
        summary.autoLecSession = 1;
        console.log(`  ✅ AutoLecSession synced`);
      }
    }
  } catch (e) { console.error('  ❌ AutoLecSession sync error:', e.message); summary.autoLecSession = 'error'; }

  try {
    // 8. FileRecords (matched by code — unique)
    const FileRecord = mongoose.models.FileRecord;
    if (FileRecord) {
      const rows = db.prepare(`SELECT * FROM file_records`).all();
      const ops = rows.map(f => ({
        updateOne: {
          filter: { code: f.code },
          update: { $set: {
            code: f.code, file_id: f.file_id, file_type: f.file_type, file_name: f.file_name||'file',
            uploaded_by: f.uploaded_by||null, expires_at: f.expires_at ? new Date(f.expires_at) : null,
            delivered_to: JSON.parse(f.delivered_to||'[]'), created_at: new Date(f.created_at||0),
            channel_msg_id: f.channel_msg_id||null,
          } },
          upsert: true,
        },
      }));
      if (ops.length) await FileRecord.bulkWrite(ops, { ordered: false });
      summary.fileRecords = rows.length;
      console.log(`  ✅ FileRecords: ${rows.length}`);
    }
  } catch (e) { console.error('  ❌ FileRecords sync error:', e.message); summary.fileRecords = 'error'; }

  try {
    // 9. BulkBatches (matched by batch_code — unique)
    const BulkBatch = mongoose.models.BulkBatch;
    if (BulkBatch) {
      const rows = db.prepare(`SELECT * FROM bulk_batches`).all();
      const ops = rows.map(b => ({
        updateOne: {
          filter: { batch_code: b.batch_code },
          update: { $set: { batch_code: b.batch_code, user_id: b.user_id, files: JSON.parse(b.files||'[]'), created_at: new Date(b.created_at||0) } },
          upsert: true,
        },
      }));
      if (ops.length) await BulkBatch.bulkWrite(ops, { ordered: false });
      summary.bulkBatches = rows.length;
      console.log(`  ✅ BulkBatches: ${rows.length}`);
    }
  } catch (e) { console.error('  ❌ BulkBatches sync error:', e.message); summary.bulkBatches = 'error'; }

  try {
    // 10. DailyVideoLimits (matched by userId)
    const DailyVideoLimit = mongoose.models.DailyVideoLimit;
    if (DailyVideoLimit) {
      const rows = db.prepare(`SELECT * FROM daily_video_limits`).all();
      const ops = rows.map(l => ({
        updateOne: {
          filter: { userId: l.userId },
          update: { $set: { userId: l.userId, count: l.count||0, resetDate: l.resetDate||'' } },
          upsert: true,
        },
      }));
      if (ops.length) await DailyVideoLimit.bulkWrite(ops, { ordered: false });
      summary.dailyVideoLimits = rows.length;
      console.log(`  ✅ DailyVideoLimits: ${rows.length}`);
    }
  } catch (e) { console.error('  ❌ DailyVideoLimits sync error:', e.message); summary.dailyVideoLimits = 'error'; }

  try {
    // 10b. AdsFreeSubscriptions (matched by userId)
    const AdsFreeSubscription = mongoose.models.AdsFreeSubscription;
    if (AdsFreeSubscription) {
      const rows = db.prepare(`SELECT * FROM ads_free_subscriptions`).all();
      const ops = rows.map(a => ({
        updateOne: {
          filter: { userId: a.userId },
          update: { $set: { userId: a.userId, expiresAt: new Date(a.expiresAt) } },
          upsert: true,
        },
      }));
      if (ops.length) await AdsFreeSubscription.bulkWrite(ops, { ordered: false });
      summary.adsFreeSubscriptions = rows.length;
      console.log(`  ✅ AdsFreeSubscriptions: ${rows.length}`);
    }
  } catch (e) { console.error('  ❌ AdsFreeSubscriptions sync error:', e.message); summary.adsFreeSubscriptions = 'error'; }

  try {
    // 11. Reward Redemptions (ledger — best-effort match on userId+pointsCost+redeemedAt,
    // same shared Date instance used on both writes at insert time, see course.js redeem route)
    const RewardRedemption = mongoose.models.RewardRedemption;
    if (RewardRedemption) {
      const rows = db.prepare(`SELECT * FROM reward_redemptions`).all();
      const ops = rows.map(r => ({
        updateOne: {
          filter: { userId: r.userId, pointsCost: r.pointsCost, redeemedAt: new Date(r.redeemedAt||0) },
          update: { $setOnInsert: {
            userId: r.userId, rewardType: r.rewardType, batchId: r.batchId||null, batchName: r.batchName||'',
            pointsCost: r.pointsCost, redeemedAt: new Date(r.redeemedAt||0), expiresAt: new Date(r.expiresAt||0),
          } },
          upsert: true,
        },
      }));
      if (ops.length) await RewardRedemption.bulkWrite(ops, { ordered: false });
      summary.rewardRedemptions = rows.length;
      console.log(`  ✅ Reward Redemptions: ${rows.length}`);
    }
  } catch (e) { console.error('  ❌ Reward Redemptions sync error:', e.message); summary.rewardRedemptions = 'error'; }

  try {
    // 12. Batch Reward Access (matched by userId+batchId — compound PK in SQLite too)
    const BatchRewardAccess = mongoose.models.BatchRewardAccess;
    if (BatchRewardAccess) {
      const rows = db.prepare(`SELECT * FROM batch_reward_access`).all();
      const ops = rows.map(r => ({
        updateOne: {
          filter: { userId: r.userId, batchId: r.batchId },
          update: { $set: { userId: r.userId, batchId: r.batchId, batchName: r.batchName||'', expiresAt: new Date(r.expiresAt||0), grantedAt: new Date(r.grantedAt||0) } },
          upsert: true,
        },
      }));
      if (ops.length) await BatchRewardAccess.bulkWrite(ops, { ordered: false });
      summary.batchRewardAccess = rows.length;
      console.log(`  ✅ Batch Reward Access: ${rows.length}`);
    }
  } catch (e) { console.error('  ❌ Batch Reward Access sync error:', e.message); summary.batchRewardAccess = 'error'; }

  try {
    // 13. Spin History (ledger — best-effort match on userId+pointsWon+spunAt, same
    // shared Date instance used on both writes at insert time)
    const SpinHistory = mongoose.models.SpinHistory;
    if (SpinHistory) {
      const rows = db.prepare(`SELECT * FROM spin_history`).all();
      const ops = rows.map(r => ({
        updateOne: {
          filter: { userId: r.userId, pointsWon: r.pointsWon, spunAt: new Date(r.spunAt||0) },
          update: { $setOnInsert: { userId: r.userId, pointsWon: r.pointsWon, spunAt: new Date(r.spunAt||0) } },
          upsert: true,
        },
      }));
      if (ops.length) await SpinHistory.bulkWrite(ops, { ordered: false });
      summary.spinHistory = rows.length;
      console.log(`  ✅ Spin History: ${rows.length}`);
    }
  } catch (e) { console.error('  ❌ Spin History sync error:', e.message); summary.spinHistory = 'error'; }

  try {
    // 14. Watched Lectures (matched by userId+lectureId — compound PK in SQLite too)
    const WatchedLecture = mongoose.models.WatchedLecture;
    if (WatchedLecture) {
      const rows = db.prepare(`SELECT * FROM watched_lectures`).all();
      const ops = rows.map(r => ({
        updateOne: {
          filter: { userId: r.userId, lectureId: r.lectureId },
          update: { $set: { userId: r.userId, lectureId: r.lectureId, watchedAt: new Date(r.watchedAt||0) } },
          upsert: true,
        },
      }));
      if (ops.length) await WatchedLecture.bulkWrite(ops, { ordered: false });
      summary.watchedLectures = rows.length;
      console.log(`  ✅ Watched Lectures: ${rows.length}`);
    }
  } catch (e) { console.error('  ❌ Watched Lectures sync error:', e.message); summary.watchedLectures = 'error'; }

  try {
    // 15. Point Adjustments (SQLite id === Mongo _id, same linked pattern as batches/announcements/coupons)
    const PointAdjustment = mongoose.models.PointAdjustment;
    if (PointAdjustment) {
      const rows = db.prepare(`SELECT * FROM point_adjustments`).all();
      let ok = 0;
      for (const r of rows) {
        try {
          await PointAdjustment.findByIdAndUpdate(r.id, { userId: r.userId, points: r.points, note: r.note||'', createdAt: new Date(r.createdAt||0) }, { upsert: true });
          ok++;
        } catch (e) {}
      }
      summary.pointAdjustments = ok;
      console.log(`  ✅ Point Adjustments: ${ok}/${rows.length}`);
    }
  } catch (e) { console.error('  ❌ Point Adjustments sync error:', e.message); summary.pointAdjustments = 'error'; }

  console.log('✅ SQLite → MongoDB sync complete');
  return summary;
}

// ── BATCH Operations ──────────────────────────────────────────────────────────

const batch = {
  getAll() {
    const rows = getDb().prepare(`SELECT data FROM batches ORDER BY json_extract(data,'$.order') ASC`).all();
    return rows.map(r => JSON.parse(r.data));
  },
  getOne(id) {
    const row = getDb().prepare(`SELECT data FROM batches WHERE id=?`).get(id);
    return row ? JSON.parse(row.data) : null;
  },
  upsert(batchObj) {
    getDb().prepare(`INSERT INTO batches(id,data,updated_at) VALUES(?,?,?)
      ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at`)
      .run(String(batchObj._id), JSON.stringify(batchObj), Date.now());
  },
  delete(id) {
    getDb().prepare(`DELETE FROM batches WHERE id=?`).run(id);
  },
  count() {
    return getDb().prepare(`SELECT COUNT(*) as c FROM batches`).get().c;
  },
};

// ── USER Operations ───────────────────────────────────────────────────────────

const user = {
  upsert({ userId, firstName, lastName, username, firstSeen, lastSeen }) {
    getDb().prepare(`INSERT INTO users(userId,firstName,lastName,username,firstSeen,lastSeen)
      VALUES(?,?,?,?,?,?)
      ON CONFLICT(userId) DO UPDATE SET firstName=excluded.firstName,
      lastName=excluded.lastName, username=excluded.username, lastSeen=excluded.lastSeen`)
      .run(userId, firstName||'', lastName||'', username||'',
        new Date(firstSeen||Date.now()).getTime(),
        new Date(lastSeen||Date.now()).getTime());
  },
  findOne(userId) {
    return getDb().prepare(`SELECT * FROM users WHERE userId=?`).get(userId);
  },
  count() {
    return getDb().prepare(`SELECT COUNT(*) as c FROM users`).get().c;
  },
  countSince(timestamp) {
    return getDb().prepare(`SELECT COUNT(*) as c FROM users WHERE firstSeen >= ?`).get(timestamp).c;
  },
  getAll() {
    return getDb().prepare(`SELECT userId FROM users`).all();
  },
  // Full rows (not just userId) — powers the /points admin command.
  listAll() {
    return getDb().prepare(`SELECT * FROM users`).all();
  },
};

// ── POINT ADJUSTMENT Operations (manual admin grants/deductions, /addpoints) ──

const pointAdjustment = {
  insert({ id, userId, points, note, createdAt }) {
    getDb().prepare(`INSERT INTO point_adjustments(id,userId,points,note,createdAt) VALUES(?,?,?,?,?)`)
      .run(id, userId, points, note||'', new Date(createdAt||Date.now()).getTime());
  },
  // Net manual adjustment for one user — added straight into the points formula.
  totalForUser(userId) {
    return getDb().prepare(`SELECT COALESCE(SUM(points),0) as total FROM point_adjustments WHERE userId=?`).get(userId).total;
  },
  totalGlobal() {
    return getDb().prepare(`SELECT COALESCE(SUM(points),0) as total FROM point_adjustments`).get().total;
  },
  history(userId, limit) {
    return getDb().prepare(`SELECT * FROM point_adjustments WHERE userId=? ORDER BY createdAt DESC LIMIT ?`)
      .all(userId, limit || 20)
      .map(r => ({ ...r, createdAt: new Date(r.createdAt) }));
  },
};

const spinAdjustment = {
  insert({ id, userId, delta, note, createdAt }) {
    getDb().prepare(`INSERT INTO spin_adjustments(id,userId,delta,note,createdAt) VALUES(?,?,?,?,?)`)
      .run(id, String(userId), delta, note||'', new Date(createdAt||Date.now()).getTime());
  },
  // Net manual adjustment for one user — added on top of SPIN_DAILY_LIMIT to
  // get their effective daily spin limit (see getSpinStatus in course.js).
  netForUser(userId) {
    return getDb().prepare(`SELECT COALESCE(SUM(delta),0) as total FROM spin_adjustments WHERE userId=?`).get(String(userId)).total;
  },
  history(userId, limit) {
    return getDb().prepare(`SELECT * FROM spin_adjustments WHERE userId=? ORDER BY createdAt DESC LIMIT ?`)
      .all(String(userId), limit || 20)
      .map(r => ({ ...r, createdAt: new Date(r.createdAt) }));
  },
};

// ── ANNOUNCEMENT Operations ───────────────────────────────────────────────────

const announcement = {
  getAll() {
    return getDb().prepare(`SELECT * FROM announcements ORDER BY createdAt DESC LIMIT 20`).all()
      .map(a => ({ ...a, _id: a.id, createdAt: new Date(a.createdAt).toISOString() }));
  },
  insert({ id, emoji, heading, body, createdAt }) {
    getDb().prepare(`INSERT INTO announcements(id,emoji,heading,body,createdAt) VALUES(?,?,?,?,?)`)
      .run(id, emoji||'📢', heading, body, new Date(createdAt||Date.now()).getTime());
  },
  delete(id) {
    getDb().prepare(`DELETE FROM announcements WHERE id=?`).run(id);
  },
};

// ── ACCESS Operations ─────────────────────────────────────────────────────────

const access = {
  findOne(userId) {
    const r = getDb().prepare(`SELECT * FROM access WHERE userId=?`).get(userId);
    if (!r) return null;
    return { ...r, expiresAt: new Date(r.expiresAt), claimsToday: r.claimsToday, claimDay: r.claimDay };
  },
  upsert({ userId, expiresAt, claimsToday, claimDay }) {
    getDb().prepare(`INSERT INTO access(userId,expiresAt,claimsToday,claimDay) VALUES(?,?,?,?)
      ON CONFLICT(userId) DO UPDATE SET expiresAt=excluded.expiresAt,
      claimsToday=excluded.claimsToday, claimDay=excluded.claimDay`)
      .run(userId, new Date(expiresAt).getTime(), claimsToday||0, claimDay||'');
  },
  count() {
    return getDb().prepare(`SELECT COUNT(*) as c FROM access`).get().c;
  },
  countActive() {
    return getDb().prepare(`SELECT COUNT(*) as c FROM access WHERE expiresAt > ?`).get(Date.now()).c;
  },
  // Users who claimed at least one ad-watch access grant on a given day (claimDay is
  // the 'YYYY-MM-DD' string the claim counter resets against — see checkAndClaim logic).
  countClaimedOnDay(dayStr) {
    return getDb().prepare(`SELECT COUNT(*) as c FROM access WHERE claimDay=? AND claimsToday>0`).get(dayStr).c;
  },
};

// ── AD TOKEN Operations ───────────────────────────────────────────────────────

const adToken = {
  create({ id, userId, token, issuedAt, expiresAt }) {
    getDb().prepare(`INSERT INTO ad_tokens(id,userId,token,issuedAt,expiresAt) VALUES(?,?,?,?,?)`)
      .run(id, userId, token, new Date(issuedAt||Date.now()).getTime(), new Date(expiresAt).getTime());
  },
  findOne({ userId, token }) {
    const r = getDb().prepare(`SELECT * FROM ad_tokens WHERE userId=? AND token=?`).get(userId, token);
    if (!r) return null;
    return { ...r, issuedAt: new Date(r.issuedAt), expiresAt: new Date(r.expiresAt) };
  },
  deleteByUser(userId) {
    getDb().prepare(`DELETE FROM ad_tokens WHERE userId=?`).run(userId);
  },
  deleteById(id) {
    getDb().prepare(`DELETE FROM ad_tokens WHERE id=?`).run(id);
  },
};

// ── REFERRAL Operations ───────────────────────────────────────────────────────

const referral = {
  findByReferred(referredId) {
    return getDb().prepare(`SELECT * FROM referrals WHERE referredId=?`).get(referredId);
  },
  countByReferrer(referrerId) {
    return getDb().prepare(`SELECT COUNT(*) as c FROM referrals WHERE referrerId=?`).get(referrerId).c;
  },
  insert({ id, referrerId, referredId }) {
    getDb().prepare(`INSERT INTO referrals(id,referrerId,referredId,createdAt) VALUES(?,?,?,?)`)
      .run(id, referrerId, referredId, Date.now());
  },
  count() {
    return getDb().prepare(`SELECT COUNT(*) as c FROM referrals`).get().c;
  },
  distinctReferrers() {
    return getDb().prepare(`SELECT COUNT(DISTINCT referrerId) as c FROM referrals`).get().c;
  },
  countSince(sinceMs) {
    return getDb().prepare(`SELECT COUNT(*) as c FROM referrals WHERE createdAt>=?`).get(sinceMs).c;
  },
  // Top N referrers by referral count — powers the dashboard leaderboard line.
  topReferrers(limit) {
    return getDb().prepare(`SELECT referrerId, COUNT(*) as c FROM referrals GROUP BY referrerId ORDER BY c DESC LIMIT ?`).all(limit || 1);
  },
};

// ── COUPON Operations ─────────────────────────────────────────────────────────

const coupon = {
  getAll() {
    return getDb().prepare(`SELECT * FROM coupons ORDER BY createdAt DESC`).all()
      .map(_couponRow);
  },
  findById(id) {
    const r = getDb().prepare(`SELECT * FROM coupons WHERE id=?`).get(id);
    return r ? _couponRow(r) : null;
  },
  findByCode(code) {
    const r = getDb().prepare(`SELECT * FROM coupons WHERE code=?`).get(code.toUpperCase().trim());
    return r ? _couponRow(r) : null;
  },
  insert({ id, code, discountPct, expiresAt, isActive, batchIds, createdAt }) {
    getDb().prepare(`INSERT INTO coupons(id,code,discountPct,expiresAt,isActive,usageCount,batchIds,createdAt)
      VALUES(?,?,?,?,?,0,?,?)`)
      .run(id, code.toUpperCase().trim(), discountPct,
        new Date(expiresAt).getTime(), isActive!==false?1:0,
        JSON.stringify(batchIds||[]), new Date(createdAt||Date.now()).getTime());
  },
  toggle(id) {
    const c = coupon.findById(id);
    if (!c) return null;
    const newVal = c.isActive ? 0 : 1;
    getDb().prepare(`UPDATE coupons SET isActive=? WHERE id=?`).run(newVal, id);
    return coupon.findById(id);
  },
  delete(id) {
    getDb().prepare(`DELETE FROM coupons WHERE id=?`).run(id);
  },
};

function _couponRow(r) {
  return {
    ...r,
    _id: r.id,
    isActive: r.isActive === 1,
    expiresAt: new Date(r.expiresAt),
    createdAt: new Date(r.createdAt),
    batchIds: JSON.parse(r.batchIds||'[]'),
  };
}

// ── AUTO LEC SESSION Operations ───────────────────────────────────────────────

const autoLec = {
  load() {
    const r = getDb().prepare(`SELECT * FROM auto_lec_session WHERE id='singleton'`).get();
    if (!r) return { active:false, batchId:null, subjectId:null, chapterId:null, unitId:null, lectureCount:0, batchName:'', subjectName:'', chapterName:'', unitName:'' };
    return { ...r, active: r.active===1 };
  },
  save(session) {
    getDb().prepare(`INSERT INTO auto_lec_session(id,active,batchId,subjectId,chapterId,unitId,lectureCount,batchName,subjectName,chapterName,unitName)
      VALUES('singleton',?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET active=excluded.active,batchId=excluded.batchId,
      subjectId=excluded.subjectId,chapterId=excluded.chapterId,unitId=excluded.unitId,
      lectureCount=excluded.lectureCount,batchName=excluded.batchName,
      subjectName=excluded.subjectName,chapterName=excluded.chapterName,unitName=excluded.unitName`)
      .run(session.active?1:0, session.batchId||null, session.subjectId||null,
        session.chapterId||null, session.unitId||null, session.lectureCount||0,
        session.batchName||'', session.subjectName||'', session.chapterName||'', session.unitName||'');
  },
};

// ── FILE RECORD Operations ────────────────────────────────────────────────────

const fileRecord = {
  create({ id, code, file_id, file_type, file_name, uploaded_by, channel_msg_id }) {
    getDb().prepare(`INSERT INTO file_records(id,code,file_id,file_type,file_name,uploaded_by,expires_at,delivered_to,created_at,channel_msg_id)
      VALUES(?,?,?,?,?,?,NULL,'[]',?,?)`)
      .run(id, code, file_id, file_type, file_name||'file', uploaded_by||null, Date.now(), channel_msg_id||null);
  },
  findByCode(code) {
    const r = getDb().prepare(`SELECT * FROM file_records WHERE code=? COLLATE NOCASE`).get(code);
    return r ? _fileRow(r) : null;
  },
  findById(id) {
    const r = getDb().prepare(`SELECT * FROM file_records WHERE id=?`).get(id);
    return r ? _fileRow(r) : null;
  },
  findByUploader(userId) {
    return getDb().prepare(`SELECT * FROM file_records WHERE uploaded_by=?`).all(userId).map(_fileRow);
  },
  countByUploader(userId) {
    return getDb().prepare(`SELECT COUNT(*) as c FROM file_records WHERE uploaded_by=?`).get(userId).c;
  },
  count() {
    return getDb().prepare(`SELECT COUNT(*) as c FROM file_records`).get().c;
  },
  addDeliveredTo(id, chatId) {
    const r = getDb().prepare(`SELECT delivered_to, delivered_at FROM file_records WHERE id=?`).get(id);
    if (!r) return;
    const arr = JSON.parse(r.delivered_to||'[]');
    const at = JSON.parse(r.delivered_at||'{}');
    at[chatId] = Date.now();
    if (!arr.includes(chatId)) arr.push(chatId);
    getDb().prepare(`UPDATE file_records SET delivered_to=?, delivered_at=? WHERE id=?`).run(JSON.stringify(arr), JSON.stringify(at), id);
  },
  removeDeliveredTo(id, chatId) {
    const r = getDb().prepare(`SELECT delivered_to, delivered_at FROM file_records WHERE id=?`).get(id);
    if (!r) return;
    const arr = JSON.parse(r.delivered_to||'[]').filter(x => x !== chatId);
    const at = JSON.parse(r.delivered_at||'{}');
    delete at[chatId];
    getDb().prepare(`UPDATE file_records SET delivered_to=?, delivered_at=? WHERE id=?`).run(JSON.stringify(arr), JSON.stringify(at), id);
  },
  // Read-time guard for the 6h re-request cooldown. This is the correctness
  // backstop: even if the scheduled cleanup job (scheduleUndeliver) never
  // fires — lost timer, failed sync, missing timestamp from an older row,
  // whatever — this check self-heals by clearing the stale entry the moment
  // someone requests the file again after the window has passed, instead of
  // leaving them permanently blocked.
  isDeliveryActive(id, chatId, windowMs) {
    const r = getDb().prepare(`SELECT delivered_to, delivered_at FROM file_records WHERE id=?`).get(id);
    if (!r) return false;
    const arr = JSON.parse(r.delivered_to||'[]');
    if (!arr.includes(chatId)) return false;
    const at = JSON.parse(r.delivered_at||'{}');
    const deliveredAt = at[chatId];
    // No timestamp on record (e.g. row synced in from before this fix, or from
    // a Mongo copy that never carried one) — can't prove it's still within the
    // window, so don't block: self-heal and allow the re-request.
    if (!deliveredAt || (Date.now() - deliveredAt) >= windowMs) {
      fileRecord.removeDeliveredTo(id, chatId);
      return false;
    }
    return true;
  },
  deleteByCode(code, uploadedBy) {
    return getDb().prepare(`DELETE FROM file_records WHERE code=? COLLATE NOCASE AND uploaded_by=?`).run(code, uploadedBy).changes > 0;
  },
  // All records that were mirrored into the storage channel — used by /migrate to
  // re-fetch a fresh, current-bot-valid file_id for every stored file.
  findAllWithChannelMsg() {
    return getDb().prepare(`SELECT * FROM file_records WHERE channel_msg_id IS NOT NULL`).all().map(_fileRow);
  },
  // Re-point a record at a fresh file_id (optionally correcting the stored name too).
  updateFileId(id, { file_id, file_name }) {
    if (file_name !== undefined) {
      getDb().prepare(`UPDATE file_records SET file_id=?, file_name=? WHERE id=?`).run(file_id, file_name, id);
    } else {
      getDb().prepare(`UPDATE file_records SET file_id=? WHERE id=?`).run(file_id, id);
    }
  },
};

function _fileRow(r) {
  return {
    ...r,
    _id: r.id,
    delivered_to: JSON.parse(r.delivered_to||'[]'),
    delivered_at: JSON.parse(r.delivered_at||'{}'),
    created_at: new Date(r.created_at),
    expires_at: r.expires_at ? new Date(r.expires_at) : null,
  };
}

// ── BULK BATCH Operations ─────────────────────────────────────────────────────

const bulkBatch = {
  create({ id, batch_code, user_id, files }) {
    getDb().prepare(`INSERT INTO bulk_batches(id,batch_code,user_id,files,created_at) VALUES(?,?,?,?,?)`)
      .run(id, batch_code, user_id, JSON.stringify(files||[]), Date.now());
  },
  findByCode(code) {
    const r = getDb().prepare(`SELECT * FROM bulk_batches WHERE batch_code=? COLLATE NOCASE`).get(code);
    return r ? _bulkRow(r) : null;
  },
  findByUser(userId) {
    return getDb().prepare(`SELECT * FROM bulk_batches WHERE user_id=?`).all(userId).map(_bulkRow);
  },
  countByUser(userId) {
    return getDb().prepare(`SELECT COUNT(*) as c FROM bulk_batches WHERE user_id=?`).get(userId).c;
  },
  count() {
    return getDb().prepare(`SELECT COUNT(*) as c FROM bulk_batches`).get().c;
  },
  deleteByCode(code, userId) {
    return getDb().prepare(`DELETE FROM bulk_batches WHERE batch_code=? COLLATE NOCASE AND user_id=?`).run(code, userId).changes > 0;
  },
  // All bulk batches — used by /migrate to walk every file inside every batch.
  findAll() {
    return getDb().prepare(`SELECT * FROM bulk_batches`).all().map(_bulkRow);
  },
  // Overwrite a batch's files array (e.g. after re-pointing file_ids during /migrate).
  updateFiles(id, files) {
    getDb().prepare(`UPDATE bulk_batches SET files=? WHERE id=?`).run(JSON.stringify(files||[]), id);
  },
};

function _bulkRow(r) {
  return { ...r, _id: r.id, files: JSON.parse(r.files||'[]'), created_at: new Date(r.created_at) };
}

// ── PENDING DELETE Operations ─────────────────────────────────────────────────

const pendingDelete = {
  create({ id, chat_id, message_id, delete_at }) {
    getDb().prepare(`INSERT INTO pending_deletes(id,chat_id,message_id,delete_at) VALUES(?,?,?,?)`)
      .run(id, chat_id, message_id, new Date(delete_at).getTime());
  },
  getAll() {
    return getDb().prepare(`SELECT * FROM pending_deletes`).all()
      .map(r => ({ ...r, _id: r.id, delete_at: new Date(r.delete_at) }));
  },
  // All still-pending (not-yet-auto-deleted) video messages for one chat — used
  // to immediately wipe a banned user's DM instead of waiting for the 6h timer.
  getByChatId(chat_id) {
    return getDb().prepare(`SELECT * FROM pending_deletes WHERE chat_id=?`).all(chat_id)
      .map(r => ({ ...r, _id: r.id, delete_at: new Date(r.delete_at) }));
  },
  deleteById(id) {
    getDb().prepare(`DELETE FROM pending_deletes WHERE id=?`).run(id);
  },
  deleteByChatMsg(chat_id, message_id) {
    getDb().prepare(`DELETE FROM pending_deletes WHERE chat_id=? AND message_id=?`).run(chat_id, message_id);
  },
};

// ── PENDING UNDELIVER Operations ──────────────────────────────────────────────
// Persists the "remove chatId from delivered_to after 6h" job, mirroring
// pendingDelete above, so it survives bot restarts (see recoverPendingUndelivers).

const pendingUndeliver = {
  create({ id, file_record_id, code, chat_id, undeliver_at }) {
    getDb().prepare(`INSERT INTO pending_undelivers(id,file_record_id,code,chat_id,undeliver_at) VALUES(?,?,?,?,?)`)
      .run(id, file_record_id, code, chat_id, new Date(undeliver_at).getTime());
  },
  getAll() {
    return getDb().prepare(`SELECT * FROM pending_undelivers`).all()
      .map(r => ({ ...r, _id: r.id, undeliver_at: new Date(r.undeliver_at) }));
  },
  deleteById(id) {
    getDb().prepare(`DELETE FROM pending_undelivers WHERE id=?`).run(id);
  },
  deleteByFileChat(file_record_id, chat_id) {
    getDb().prepare(`DELETE FROM pending_undelivers WHERE file_record_id=? AND chat_id=?`).run(file_record_id, chat_id);
  },
};

// ── DAILY VIDEO LIMIT Operations ──────────────────────────────────────────────

const dailyVideoLimit = {
  find(userId) {
    return getDb().prepare(`SELECT * FROM daily_video_limits WHERE userId=?`).get(userId);
  },
  upsert({ userId, count, resetDate }) {
    getDb().prepare(`INSERT INTO daily_video_limits(userId,count,resetDate) VALUES(?,?,?)
      ON CONFLICT(userId) DO UPDATE SET count=excluded.count, resetDate=excluded.resetDate`)
      .run(userId, count||0, resetDate);
  },
};

// ── ADS-FREE SUBSCRIPTION Operations ──────────────────────────────────────────
const adsFree = {
  find(userId) {
    return getDb().prepare(`SELECT * FROM ads_free_subscriptions WHERE userId=?`).get(String(userId));
  },
  upsert({ userId, expiresAt }) {
    getDb().prepare(`INSERT INTO ads_free_subscriptions(userId,expiresAt) VALUES(?,?)
      ON CONFLICT(userId) DO UPDATE SET expiresAt=excluded.expiresAt`)
      .run(String(userId), new Date(expiresAt).getTime());
  },
  // Everyone whose subscription hasn't lapsed yet, soonest-expiring first — used
  // by /adsfreeusers so the admin can see who's about to need a renewal reminder.
  getAllActive() {
    return getDb().prepare(`SELECT * FROM ads_free_subscriptions WHERE expiresAt > ? ORDER BY expiresAt ASC`).all(Date.now());
  },
};

// ── REWARD REDEMPTION Operations (points-spend ledger / history) ──────────────
// Points themselves are never stored as a balance column — they are always derived
// as (total referrals earned) - (total points spent here), so the numbers can
// never drift out of sync with the referral system.

const rewardRedemption = {
  insert({ id, userId, rewardType, batchId, batchName, pointsCost, redeemedAt, expiresAt }) {
    getDb().prepare(`INSERT INTO reward_redemptions(id,userId,rewardType,batchId,batchName,pointsCost,redeemedAt,expiresAt)
      VALUES(?,?,?,?,?,?,?,?)`)
      .run(id, userId, rewardType, batchId || null, batchName || '', pointsCost,
        new Date(redeemedAt || Date.now()).getTime(), new Date(expiresAt).getTime());
  },
  // Lifetime points a user has spent — subtract this from their referral count to get the spendable balance
  totalSpent(userId) {
    return getDb().prepare(`SELECT COALESCE(SUM(pointsCost),0) as total FROM reward_redemptions WHERE userId=?`)
      .get(userId).total;
  },
  history(userId, limit) {
    return getDb().prepare(`SELECT * FROM reward_redemptions WHERE userId=? ORDER BY redeemedAt DESC LIMIT ?`)
      .all(userId, limit || 20)
      .map(r => ({ ...r, redeemedAt: new Date(r.redeemedAt), expiresAt: new Date(r.expiresAt) }));
  },
  // How many times this user has redeemed a specific reward type — used for
  // non-points rewards (like the every-5-referrals Ads-Free perk) where
  // eligibility is "how many times have I already claimed this", not a balance.
  countByTypeForUser(userId, rewardType) {
    return getDb().prepare(`SELECT COUNT(*) as c FROM reward_redemptions WHERE userId=? AND rewardType=?`).get(userId, rewardType).c;
  },
  count() {
    return getDb().prepare(`SELECT COUNT(*) as c FROM reward_redemptions`).get().c;
  },
  // Total points redeemed across ALL users — dashboard metric (vs totalSpent which is per-user)
  totalSpentGlobal() {
    return getDb().prepare(`SELECT COALESCE(SUM(pointsCost),0) as total FROM reward_redemptions`).get().total;
  },
};

// ── BATCH REWARD ACCESS Operations (live, time-limited premium access via points) ──
// Separate from batches.premiumUsers on purpose — that array is permanent (paid/admin
// granted), this table is the temporary layer that quietly expires on its own.

const batchRewardAccess = {
  findOne(userId, batchId) {
    const r = getDb().prepare(`SELECT * FROM batch_reward_access WHERE userId=? AND batchId=?`).get(userId, batchId);
    if (!r) return null;
    return { ...r, expiresAt: new Date(r.expiresAt), grantedAt: new Date(r.grantedAt) };
  },
  // Fast boolean check used by access-gating logic — true only while not yet expired
  hasAccess(userId, batchId) {
    if (!userId || !batchId) return false;
    const r = getDb().prepare(`SELECT expiresAt FROM batch_reward_access WHERE userId=? AND batchId=?`).get(userId, batchId);
    return !!r && r.expiresAt > Date.now();
  },
  upsert({ userId, batchId, batchName, expiresAt, grantedAt }) {
    getDb().prepare(`INSERT INTO batch_reward_access(userId,batchId,batchName,expiresAt,grantedAt) VALUES(?,?,?,?,?)
      ON CONFLICT(userId,batchId) DO UPDATE SET expiresAt=excluded.expiresAt, batchName=excluded.batchName`)
      .run(userId, batchId, batchName || '', new Date(expiresAt).getTime(), new Date(grantedAt || Date.now()).getTime());
  },
  // All currently-active (non-expired) reward unlocks for a user — drives the "active access" UI
  listActiveByUser(userId) {
    return getDb().prepare(`SELECT * FROM batch_reward_access WHERE userId=? AND expiresAt>?`)
      .all(userId, Date.now())
      .map(r => ({ ...r, expiresAt: new Date(r.expiresAt), grantedAt: new Date(r.grantedAt) }));
  },
  countActive() {
    return getDb().prepare(`SELECT COUNT(*) as c FROM batch_reward_access WHERE expiresAt>?`).get(Date.now()).c;
  },
};

// ── SPIN TOKEN Operations (proves the spin's ad was watched — mirrors adToken exactly) ──

const spinToken = {
  create({ id, userId, token, issuedAt, expiresAt }) {
    getDb().prepare(`INSERT INTO spin_tokens(id,userId,token,issuedAt,expiresAt) VALUES(?,?,?,?,?)`)
      .run(id, userId, token, new Date(issuedAt || Date.now()).getTime(), new Date(expiresAt).getTime());
  },
  findOne({ userId, token }) {
    const r = getDb().prepare(`SELECT * FROM spin_tokens WHERE userId=? AND token=?`).get(userId, token);
    if (!r) return null;
    return { ...r, issuedAt: new Date(r.issuedAt), expiresAt: new Date(r.expiresAt) };
  },
  deleteByUser(userId) {
    getDb().prepare(`DELETE FROM spin_tokens WHERE userId=?`).run(userId);
  },
  deleteById(id) {
    getDb().prepare(`DELETE FROM spin_tokens WHERE id=?`).run(id);
  },
};

// ── SPIN HISTORY Operations (ledger of completed spins) ────────────────────────

const spinHistory = {
  insert({ id, userId, pointsWon, spunAt }) {
    getDb().prepare(`INSERT INTO spin_history(id,userId,pointsWon,spunAt) VALUES(?,?,?,?)`)
      .run(id, userId, pointsWon, new Date(spunAt || Date.now()).getTime());
  },
  // Lifetime points earned from spinning — feeds directly into the points balance formula
  totalEarned(userId) {
    return getDb().prepare(`SELECT COALESCE(SUM(pointsWon),0) as total FROM spin_history WHERE userId=?`).get(userId).total;
  },
  // Number of spins completed since a given timestamp (caller passes today's midnight for the daily cap)
  countSince(userId, sinceMs) {
    return getDb().prepare(`SELECT COUNT(*) as c FROM spin_history WHERE userId=? AND spunAt>=?`).get(userId, sinceMs).c;
  },
  // Timestamp of the most recent spin — used to enforce the cooldown
  lastSpinAt(userId) {
    const r = getDb().prepare(`SELECT MAX(spunAt) as t FROM spin_history WHERE userId=?`).get(userId);
    return (r && r.t) ? new Date(r.t) : null;
  },
  // ── Global (all-users) aggregates for the admin dashboard ──
  countSinceGlobal(sinceMs) {
    return getDb().prepare(`SELECT COUNT(*) as c FROM spin_history WHERE spunAt>=?`).get(sinceMs).c;
  },
  distinctSpinners() {
    return getDb().prepare(`SELECT COUNT(DISTINCT userId) as c FROM spin_history`).get().c;
  },
  totalEarnedGlobal() {
    return getDb().prepare(`SELECT COALESCE(SUM(pointsWon),0) as total FROM spin_history`).get().total;
  },
};

// ── WATCHED LECTURE Operations (server-side "have I seen this" marker) ────────

const watchedLecture = {
  // All lecture IDs this user has marked watched — returned as a plain array of strings
  listByUser(userId) {
    return getDb().prepare(`SELECT lectureId FROM watched_lectures WHERE userId=?`).all(userId).map(r => r.lectureId);
  },
  mark(userId, lectureId) {
    getDb().prepare(`INSERT INTO watched_lectures(userId,lectureId,watchedAt) VALUES(?,?,?)
      ON CONFLICT(userId,lectureId) DO NOTHING`)
      .run(userId, lectureId, Date.now());
  },
  unmark(userId, lectureId) {
    getDb().prepare(`DELETE FROM watched_lectures WHERE userId=? AND lectureId=?`).run(userId, lectureId);
  },
};

// ── BANNED USER Operations ──────────────────────────────────────────────────

const bannedUser = {
  isBanned(userId) {
    return !!getDb().prepare(`SELECT 1 FROM banned_users WHERE userId=?`).get(userId);
  },
  ban({ userId, reason, bannedBy }) {
    getDb().prepare(`INSERT INTO banned_users(userId,reason,bannedAt,bannedBy) VALUES(?,?,?,?)
      ON CONFLICT(userId) DO UPDATE SET reason=excluded.reason, bannedAt=excluded.bannedAt, bannedBy=excluded.bannedBy`)
      .run(String(userId), reason || '', Date.now(), String(bannedBy || ''));
  },
  // Returns true if the user was actually banned before (so callers can tell
  // "removed" apart from "wasn't banned in the first place").
  unban(userId) {
    const existed = !!getDb().prepare(`SELECT 1 FROM banned_users WHERE userId=?`).get(String(userId));
    getDb().prepare(`DELETE FROM banned_users WHERE userId=?`).run(String(userId));
    return existed;
  },
  findOne(userId) {
    const r = getDb().prepare(`SELECT * FROM banned_users WHERE userId=?`).get(String(userId));
    return r ? { ...r, bannedAt: new Date(r.bannedAt) } : null;
  },
  listAll() {
    return getDb().prepare(`SELECT * FROM banned_users ORDER BY bannedAt DESC`).all()
      .map(r => ({ ...r, bannedAt: new Date(r.bannedAt) }));
  },
};

// ── AD-BLOCKER GATE EXEMPTION Operations ────────────────────────────────────
// Users the owner has manually exempted from the ad-blocker hard-block gate
// in index.html (owner is always exempt regardless of this table).

const adblockExempt = {
  isExempt(userId) {
    return !!getDb().prepare(`SELECT 1 FROM adblock_exempt_users WHERE userId=?`).get(String(userId));
  },
  add({ userId, note, addedBy }) {
    getDb().prepare(`INSERT INTO adblock_exempt_users(userId,note,addedAt,addedBy) VALUES(?,?,?,?)
      ON CONFLICT(userId) DO UPDATE SET note=excluded.note, addedAt=excluded.addedAt, addedBy=excluded.addedBy`)
      .run(String(userId), note || '', Date.now(), String(addedBy || ''));
  },
  // Returns true if the user was actually exempt before (so callers can tell
  // "removed" apart from "wasn't exempt in the first place").
  remove(userId) {
    const existed = !!getDb().prepare(`SELECT 1 FROM adblock_exempt_users WHERE userId=?`).get(String(userId));
    getDb().prepare(`DELETE FROM adblock_exempt_users WHERE userId=?`).run(String(userId));
    return existed;
  },
  listAll() {
    return getDb().prepare(`SELECT * FROM adblock_exempt_users ORDER BY addedAt DESC`).all()
      .map(r => ({ ...r, addedAt: new Date(r.addedAt) }));
  },
};

// ── LECTURE REQUEST Operations (suspicious-activity / burst detection) ────────
// One row per successful lecture/video delivery via the bot. countRecent() powers
// the "N lectures within M minutes" burst check in server.js; pruneOlderThan()
// is called alongside every insert so the table stays small — a 5-minute rolling
// window never needs more than a day of history.

const lectureRequest = {
  insert({ id, userId, code, requestedAt }) {
    getDb().prepare(`INSERT INTO lecture_requests(id,userId,code,requestedAt) VALUES(?,?,?,?)`)
      .run(id, String(userId), code || '', requestedAt || Date.now());
  },
  countRecent(userId, windowMs) {
    const since = Date.now() - windowMs;
    return getDb().prepare(`SELECT COUNT(*) as c FROM lecture_requests WHERE userId=? AND requestedAt>=?`)
      .get(String(userId), since).c;
  },
  pruneOlderThan(ms) {
    getDb().prepare(`DELETE FROM lecture_requests WHERE requestedAt < ?`).run(Date.now() - ms);
  },
};

// ── SETTINGS Operations (generic JSON-encoded key/value store) ────────────────

const settings = {
  get(key, fallback) {
    const r = getDb().prepare(`SELECT value FROM bot_settings WHERE key=?`).get(key);
    if (!r) return fallback;
    try { return JSON.parse(r.value); } catch (e) { return fallback; }
  },
  set(key, value) {
    getDb().prepare(`INSERT INTO bot_settings(key,value) VALUES(?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
      .run(key, JSON.stringify(value));
  },
};

// ── DEVICE SIGHTING Operations (multi-account / shared-device detection) ──────

const deviceSighting = {
  insert({ id, userId, fingerprint, ip, seenAt }) {
    getDb().prepare(`INSERT INTO device_sightings(id,userId,fingerprint,ip,seenAt) VALUES(?,?,?,?,?)`)
      .run(id, String(userId), fingerprint || '', ip || '', seenAt || Date.now());
  },
  // Distinct userIds seen with this fingerprint within the window, most-recent first.
  distinctUsersForFingerprint(fingerprint, windowMs) {
    if (!fingerprint) return [];
    const since = Date.now() - windowMs;
    return getDb().prepare(`SELECT userId, MAX(seenAt) as lastSeen FROM device_sightings
      WHERE fingerprint=? AND seenAt>=? GROUP BY userId ORDER BY lastSeen DESC`)
      .all(fingerprint, since);
  },
  // Same, but by IP address instead of fingerprint.
  distinctUsersForIp(ip, windowMs) {
    if (!ip) return [];
    const since = Date.now() - windowMs;
    return getDb().prepare(`SELECT userId, MAX(seenAt) as lastSeen FROM device_sightings
      WHERE ip=? AND seenAt>=? GROUP BY userId ORDER BY lastSeen DESC`)
      .all(ip, since);
  },
  pruneOlderThan(ms) {
    getDb().prepare(`DELETE FROM device_sightings WHERE seenAt < ?`).run(Date.now() - ms);
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function generateId() {
  return require('crypto').randomBytes(12).toString('hex');
}

module.exports = {
  getDb,
  syncFromMongo,
  syncToMongo,
  batch,
  user,
  announcement,
  access,
  adToken,
  referral,
  coupon,
  autoLec,
  fileRecord,
  bulkBatch,
  pendingDelete,
  pendingUndeliver,
  dailyVideoLimit,
  adsFree,
  rewardRedemption,
  batchRewardAccess,
  spinToken,
  spinHistory,
  watchedLecture,
  pointAdjustment,
  spinAdjustment,
  bannedUser,
  adblockExempt,
  lectureRequest,
  settings,
  deviceSighting,
  generateId,
};
