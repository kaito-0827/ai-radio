// AI Radio — VPS producer worker
//
// A long-running Node process that acts as the station's dedicated producer:
//   - holds the producer lease (with priority) so browser clients defer to it;
//     if this worker dies, the existing browser-side election takes over
//   - keeps the shared Firestore broadcast timeline filled with new corners
//     (script via the deployed /api/radio-script, voice via local VOICEVOX)
//   - watches for breaking AI news every 10 minutes and cuts in bulletins
//   - pauses generation while nobody is listening (presence heartbeats)
//   - cleans up expired segments and stale presence docs
//
// Run via systemd (see ai-radio-worker.service) next to a VOICEVOX engine
// container (see docker-compose.yml).

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initializeApp } from "firebase/app";
import {
  addDoc,
  collection,
  doc,
  getDocs,
  getFirestore,
  limit,
  orderBy,
  query,
  runTransaction,
  updateDoc,
  deleteDoc,
  where,
  writeBatch,
} from "firebase/firestore";

// --- Environment -----------------------------------------------------------

const workerDir = dirname(fileURLToPath(import.meta.url));
const envFile = join(workerDir, ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

const env = (name, fallback) =>
  process.env[name] ?? process.env[`NEXT_PUBLIC_${name}`] ?? fallback;

const APP_BASE_URL = env("APP_BASE_URL", "https://ai-radio-five.vercel.app");
const VOICEVOX_URL = env("VOICEVOX_URL", "http://127.0.0.1:50021");
const WORKER_ID = env("WORKER_ID", "vps-worker");

const firebaseConfig = {
  apiKey: env("FIREBASE_API_KEY"),
  authDomain: env("FIREBASE_AUTH_DOMAIN"),
  projectId: env("FIREBASE_PROJECT_ID"),
  storageBucket: env("FIREBASE_STORAGE_BUCKET"),
  messagingSenderId: env("FIREBASE_MESSAGING_SENDER_ID"),
  appId: env("FIREBASE_APP_ID"),
};

if (!firebaseConfig.projectId) {
  console.error("FIREBASE_PROJECT_ID is not configured. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// --- Constants (mirror src/app/page.tsx and src/lib/broadcastBus.ts) --------

const BASE_PATH = ["artifacts", "ai-radio-default", "public", "data"];
const LEASE_MS = 45_000;
const CHUNK_CHARS = 700_000;
const SEGMENT_GAP_MS = 700;
const PCM_BYTES_PER_MS = 48;
const RUNWAY_THRESHOLD_MS = 90_000; // generate ahead so corners join without dead air
const GEN_RETRY_MS = 15_000;
const NEWS_CHECK_INTERVAL_MS = 10 * 60_000;
const CLEANUP_INTERVAL_MS = 60_000;
const TICK_MS = 5_000;
const PRESENCE_FRESH_MS = 90_000;
const ANNOUNCE_INTERVAL_MS = 5 * 60_000;

// VOICEVOX style IDs for ずんだもん
const ZUNDAMON_STYLE_BY_EMOTION = { happy: 1, calm: 3, excited: 7, sad: 22 };

// Short station-call lines aired the moment a listener tunes in to an empty
// timeline, so the radio starts talking within seconds while the first real
// corner is still being generated.
const STATION_FILLERS = [
  { speaker: "ずんだもん", text: "えーあいらじお、オンエア中なのだ！ここからはボク、ずんだもんがお届けするのだ。", emotion: "happy" },
  { speaker: "ずんだもん", text: "ようこそなのだ！いま、いちばんホットなエーアイニュースを集めているところなのだ。", emotion: "excited" },
  { speaker: "ずんだもん", text: "最新ニュースとお便りの準備中なのだ。少しの間、ゆったりBGMでまったりしてほしいのだ。", emotion: "calm" },
  { speaker: "ずんだもん", text: "このらじおは、ボクがリアルタイムで台本を作ってしゃべる、世界にひとつの生放送なのだ！", emotion: "happy" },
  { speaker: "ずんだもん", text: "お便りもチャットも大歓迎なのだ。画面のボタンから気軽に送ってほしいのだ！", emotion: "excited" },
];

const BACKUP_SCRIPTS = [
  {
    segments: [
      { speaker: "ずんだもん", text: "リスナーのみんな、えーあいらじおを聞いてくれてありがとうなのだ！", emotion: "happy" },
      { speaker: "ずんだもん", text: "只今、最新ニュースの取得システムがちょっと混み合っているみたいなのだ。", emotion: "calm" },
      { speaker: "ずんだもん", text: "そんな時もあるのだ。ということで、少しの間、ボクのフリートークをお届けするのだ！", emotion: "excited" },
      { speaker: "ずんだもん", text: "みんなは最近、どんなテクノロジーに注目しているのだ？ぜひチャットで教えてほしいのだ。", emotion: "calm" },
    ],
  },
  {
    segments: [
      { speaker: "ずんだもん", text: "さて、お便りのコーナーにいきたいところなのだけど、ただいま電波の調子が悪いみたいなのだ。", emotion: "sad" },
      { speaker: "ずんだもん", text: "お便りはいつでも大歓迎だから、ぜひ画面のボタンから送ってみてほしいのだ！", emotion: "excited" },
      { speaker: "ずんだもん", text: "もらったメッセージは、電波が回復し次第、順番に読み上げるのだ。", emotion: "calm" },
    ],
  },
];

// --- Small utilities ---------------------------------------------------------

const log = (...args) => console.log(new Date().toISOString(), ...args);
const logError = (...args) => console.error(new Date().toISOString(), ...args);

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

const audioDurationMs = (base64) => Math.round(Math.floor((base64.length * 3) / 4) / PCM_BYTES_PER_MS);

const col = (name) => collection(db, ...BASE_PATH, name);
const metaDoc = (id) => doc(db, ...BASE_PATH, "broadcast_meta", id);

// --- Leadership (priority lease) ---------------------------------------------
// The worker claims the lease even over a live browser leader (priority
// preemption); browsers already defer to any unexpired lease, so they fall
// back automatically only when this worker stops renewing.

async function acquireLeadership() {
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(metaDoc("leader"));
    const data = snap.data();
    const now = Date.now();
    const isMine = snap.exists() && data?.clientId === WORKER_ID;
    const expired = !snap.exists() || (data?.leaseUntil ?? 0) < now;
    const foreignPriority = snap.exists() && data?.priority === true && !isMine && !expired;

    if (foreignPriority) return false; // another priority worker is alive

    if (isMine && (data?.leaseUntil ?? 0) - now >= LEASE_MS / 2) return true;

    tx.set(metaDoc("leader"), { clientId: WORKER_ID, leaseUntil: now + LEASE_MS, priority: true });
    return true;
  });
}

// --- Presence -----------------------------------------------------------------

async function countActiveListeners() {
  const snap = await getDocs(col("broadcast_meta"));
  const now = Date.now();
  let count = 0;
  snap.forEach((d) => {
    if (d.id.startsWith("presence-") && (d.data().lastSeenAt ?? 0) > now - PRESENCE_FRESH_MS) count++;
  });
  return count;
}

async function cleanupStalePresence() {
  const snap = await getDocs(col("broadcast_meta"));
  const now = Date.now();
  for (const d of snap.docs) {
    if (d.id.startsWith("presence-") && (d.data().lastSeenAt ?? 0) < now - 10 * 60_000) {
      await deleteDoc(d.ref).catch(() => {});
    }
  }
}

// --- Timeline ------------------------------------------------------------------

async function getRunwayEndMs() {
  const q = query(col("broadcast"), orderBy("airAt", "desc"), limit(1));
  const snap = await getDocs(q);
  if (snap.empty) return Date.now();
  const data = snap.docs[0].data();
  return Math.max(Date.now(), (data.airAt ?? 0) + (data.durationMs ?? 0));
}

async function publishProgram(items, firstAirAt, opts = {}) {
  const batch = writeBatch(db);
  let airAt = firstAirAt;
  for (const { segment, audioBase64 } of items) {
    const durationMs = audioDurationMs(audioBase64);
    const segRef = doc(col("broadcast"));
    const chunks = [];
    for (let p = 0; p < audioBase64.length; p += CHUNK_CHARS) chunks.push(audioBase64.slice(p, p + CHUNK_CHARS));
    batch.set(segRef, {
      speaker: segment.speaker,
      text: segment.text,
      emotion: segment.emotion,
      isBreaking: opts.isBreaking ?? false,
      airAt,
      durationMs,
      chunkCount: chunks.length,
      createdAt: Date.now(),
    });
    chunks.forEach((data, index) => batch.set(doc(segRef, "chunks", String(index)), { index, data }));
    airAt += durationMs + SEGMENT_GAP_MS;
  }
  await batch.commit();
  return airAt;
}

async function cleanupExpiredSegments() {
  const q = query(col("broadcast"), where("airAt", "<", Date.now() - 10 * 60_000), limit(10));
  const snap = await getDocs(q);
  for (const segDoc of snap.docs) {
    const chunksSnap = await getDocs(collection(segDoc.ref, "chunks"));
    await Promise.all(chunksSnap.docs.map((c) => deleteDoc(c.ref)));
    await deleteDoc(segDoc.ref);
  }
}

// --- Chat announcements ----------------------------------------------------------

async function postChat(text) {
  await addDoc(col("chats"), { user: "System", text, createdAt: Date.now(), isSystem: true });
}

async function claimGenericAnnouncement() {
  return runTransaction(db, async (tx) => {
    const ref = metaDoc("announcements");
    const snap = await tx.get(ref);
    const now = Date.now();
    const lastAt = snap.data()?.lastGenericAnnouncementAt ?? 0;
    if (lastAt && now - lastAt < ANNOUNCE_INTERVAL_MS) return false;
    tx.set(ref, { lastGenericAnnouncementAt: now }, { merge: true });
    return true;
  });
}

// --- News dedupe -------------------------------------------------------------------

async function getRecentNewsHeadlines() {
  const q = query(col("broadcast_news"), orderBy("createdAt", "desc"), limit(10));
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data().headline).filter(Boolean);
}

async function claimNews(slug, headline) {
  return runTransaction(db, async (tx) => {
    const ref = doc(col("broadcast_news"), slug);
    const snap = await tx.get(ref);
    if (snap.exists()) return false;
    tx.set(ref, { headline, createdAt: Date.now() });
    return true;
  });
}

// --- TTS (local VOICEVOX, with the deployed route as a fallback) ----------------------

function wavToPcmBase64(wav) {
  if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error("VOICEVOX response is not a RIFF/WAV file");
  }
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const chunkId = wav.toString("ascii", offset, offset + 4);
    const chunkSize = wav.readUInt32LE(offset + 4);
    if (chunkId === "data") return wav.subarray(offset + 8, offset + 8 + chunkSize).toString("base64");
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  throw new Error("WAV data chunk not found in VOICEVOX response");
}

async function synthesizeVoicevox(text, emotion) {
  const styleId = ZUNDAMON_STYLE_BY_EMOTION[emotion] ?? 3;
  const queryRes = await fetch(
    `${VOICEVOX_URL}/audio_query?speaker=${styleId}&text=${encodeURIComponent(text)}`,
    { method: "POST" }
  );
  if (!queryRes.ok) throw new Error(`VOICEVOX audio_query failed: ${queryRes.status}`);
  const audioQuery = await queryRes.json();
  audioQuery.outputSamplingRate = 24000;
  audioQuery.outputStereo = false;

  const synthRes = await fetch(`${VOICEVOX_URL}/synthesis?speaker=${styleId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(audioQuery),
  });
  if (!synthRes.ok) throw new Error(`VOICEVOX synthesis failed: ${synthRes.status}`);
  return wavToPcmBase64(Buffer.from(await synthRes.arrayBuffer()));
}

async function synthesizeSegments(segments) {
  const items = [];
  for (const segment of segments) {
    let audioBase64;
    try {
      audioBase64 = await withTimeout(synthesizeVoicevox(segment.text, segment.emotion), 60_000, "voicevox");
    } catch (err) {
      logError("VOICEVOX failed, falling back to /api/radio-tts:", err.message);
      const res = await fetch(`${APP_BASE_URL}/api/radio-tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: segment.text, speaker: segment.speaker, emotion: segment.emotion }),
      });
      if (!res.ok) throw new Error(`TTS fallback failed for segment: ${res.status}`);
      audioBase64 = (await res.json()).audioContent;
    }
    items.push({ segment, audioBase64 });
  }
  return items;
}

// --- Production ------------------------------------------------------------------------

let fallbackAnnounced = false;

async function produceNextCorner() {
  // 1. Unread letters, oldest first
  const lettersQuery = query(col("letters"), where("used", "==", false), limit(10));
  const lettersSnap = await withTimeout(getDocs(lettersQuery), 8_000, "letters");
  const unread = [];
  lettersSnap.forEach((d) => unread.push({ id: d.id, ...d.data() }));
  unread.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  const letters = unread.slice(0, 3);

  // 2. Script via the deployed route (prompts live in one place)
  const scriptRes = await fetch(`${APP_BASE_URL}/api/radio-script`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ letters }),
  });
  if (!scriptRes.ok) throw new Error(`radio-script failed: ${scriptRes.status}`);
  const scriptData = await scriptRes.json();
  const scriptDegraded = Boolean(scriptData.degraded);
  const segments = scriptData.segments || [];
  if (segments.length === 0) throw new Error("No segments generated in script");

  // 3. Voice first; letters are only consumed once their answers can air
  const items = await synthesizeSegments(segments);

  if (!scriptDegraded && letters.length > 0) {
    await withTimeout(
      Promise.all(letters.map((l) => updateDoc(doc(col("letters"), l.id), { used: true }))),
      8_000,
      "mark-letters"
    ).catch((e) => logError("Failed to mark letters as used:", e.message));
  }

  // 4. Publish
  const runwayEnd = await withTimeout(getRunwayEndMs(), 8_000, "runway");
  const startAt = Math.max(Date.now() + 2_000, runwayEnd);
  await withTimeout(publishProgram(items, startAt), 30_000, "publish");

  // 5. Announce
  if (scriptDegraded) {
    if (!fallbackAnnounced) {
      fallbackAnnounced = true;
      postChat("⚠️ 通信エラーが発生したため、自動フリートーク（バックアップモード）をオンエアしています。").catch(() => {});
    }
  } else {
    fallbackAnnounced = false;
    if (letters.length > 0) {
      postChat(`📮 お便りコーナーがオンエアされます！(${letters.length}通のお便りを読み上げ)`).catch(() => {});
    } else if (await claimGenericAnnouncement().catch(() => false)) {
      postChat("🎙️ 新しいニュースコーナー「AIトレンド情報」のオンエアが始まりました！").catch(() => {});
    }
  }

  log(`Published corner: ${items.length} segments, letters=${letters.length}, degraded=${scriptDegraded}`);
}

// Airs a couple of station-call lines right away when a listener tunes in to
// an empty timeline, covering the wait while the first corner is generated
async function publishStationFiller() {
  const runwayEnd = await withTimeout(getRunwayEndMs(), 8_000, "runway");
  if (runwayEnd > Date.now() + 5_000) return; // something is already on air

  const fillers = [...STATION_FILLERS].sort(() => Math.random() - 0.5).slice(0, 3);
  const items = await synthesizeSegments(fillers);
  await withTimeout(publishProgram(items, Date.now() + 1_500), 30_000, "publish-filler");
  log("Published station filler while the first corner is generated");
}

async function produceBackupCorner() {
  const backup = BACKUP_SCRIPTS[Math.floor(Math.random() * BACKUP_SCRIPTS.length)];
  const items = await synthesizeSegments(backup.segments);
  const runwayEnd = await withTimeout(getRunwayEndMs(), 8_000, "runway");
  await withTimeout(publishProgram(items, Math.max(Date.now() + 2_000, runwayEnd)), 30_000, "publish-backup");
  if (!fallbackAnnounced) {
    fallbackAnnounced = true;
    postChat("⚠️ 通信エラーが発生したため、自動フリートーク（バックアップモード）をオンエアしています。").catch(() => {});
  }
  log("Published backup corner");
}

async function checkBreakingNews() {
  const seenHeadlines = await withTimeout(getRecentNewsHeadlines(), 8_000, "news-history");
  const newsRes = await fetch(`${APP_BASE_URL}/api/breaking-news`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ seenHeadlines }),
  });
  if (!newsRes.ok) return;
  const news = await newsRes.json();
  if (!news.hasBreaking || !news.id || !news.headline) return;

  const scriptRes = await fetch(`${APP_BASE_URL}/api/radio-script`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ breaking: { headline: news.headline, summary: news.summary } }),
  });
  if (!scriptRes.ok) return;
  const scriptData = await scriptRes.json();
  const segments = scriptData.segments || [];
  if (segments.length === 0) return;

  const items = await synthesizeSegments(segments);

  const slug =
    String(news.id).toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 80) || `news-${Date.now()}`;
  const isNew = await withTimeout(claimNews(slug, news.headline), 8_000, "news-claim");
  if (!isNew) return;

  const runwayEnd = await withTimeout(getRunwayEndMs(), 8_000, "runway");
  await withTimeout(
    publishProgram(items, Math.max(Date.now() + 2_000, runwayEnd), { isBreaking: true }),
    30_000,
    "publish-bulletin"
  );
  postChat(`🚨 ニュース速報: ${news.headline}`).catch(() => {});
  log(`Published breaking bulletin: ${news.headline}`);
}

// --- Main loop ------------------------------------------------------------------------------

let isGenerating = false;
let lastGenAttempt = 0;
let lastNewsCheck = 0;
let lastCleanup = 0;
let wasIdle = true;

async function tick() {
  try {
    const now = Date.now();

    if (now - lastCleanup > CLEANUP_INTERVAL_MS) {
      lastCleanup = now;
      cleanupExpiredSegments().catch((e) => logError("Cleanup failed:", e.message));
      cleanupStalePresence().catch(() => {});
    }

    // Check presence BEFORE touching the lease: while nobody is listening the
    // worker must not hold leadership, so browser-side election (including
    // clients running older builds without presence heartbeats) keeps working
    const listeners = await withTimeout(countActiveListeners(), 8_000, "presence");
    if (listeners === 0) {
      if (!wasIdle) log("No listeners; pausing generation and letting the lease lapse");
      wasIdle = true;
      return;
    }
    const resumed = wasIdle;
    if (wasIdle) {
      log(`Listeners detected (${listeners}); resuming generation`);
      wasIdle = false;
    }

    const leading = await withTimeout(acquireLeadership(), 8_000, "election");
    if (!leading) {
      log("Another priority worker holds the lease; standing by");
      return;
    }

    // First listener after an idle period: get a voice on air within seconds
    if (resumed) {
      await publishStationFiller().catch((e) => logError("Station filler failed:", e.message));
    }

    const runwayEnd = await withTimeout(getRunwayEndMs(), 8_000, "runway");
    if (runwayEnd - Date.now() < RUNWAY_THRESHOLD_MS && now - lastGenAttempt > GEN_RETRY_MS && !isGenerating) {
      lastGenAttempt = now;
      isGenerating = true;
      try {
        await produceNextCorner();
      } catch (err) {
        logError("Corner production failed, trying backup:", err.message);
        await produceBackupCorner().catch((e) => logError("Backup production also failed:", e.message));
      } finally {
        isGenerating = false;
      }
    }

    if (Date.now() - lastNewsCheck > NEWS_CHECK_INTERVAL_MS) {
      lastNewsCheck = Date.now();
      await checkBreakingNews().catch((e) => logError("Breaking news check failed:", e.message));
    }
  } catch (err) {
    logError("Tick failed:", err.message);
  }
}

log(`AI Radio worker starting (id=${WORKER_ID}, app=${APP_BASE_URL}, voicevox=${VOICEVOX_URL})`);
tick();
setInterval(tick, TICK_MS);
