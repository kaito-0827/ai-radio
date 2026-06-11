// Shared broadcast bus backed by Firestore.
//
// One playing client is elected "producer" via a lease document; it generates
// the program (script + TTS audio) and publishes segments with absolute air
// times. Every client — producer included — subscribes to the same timeline
// and plays it back in sync, so all listeners hear the same broadcast, like a
// real radio station. Late joiners start mid-segment at the correct offset.

import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  where,
  writeBatch,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { ScriptSegment } from "@/lib/audioEngine";

const BASE_PATH = ["artifacts", "ai-radio-default", "public", "data"] as const;

const segmentsCol = () => collection(db, ...BASE_PATH, "broadcast");
const newsCol = () => collection(db, ...BASE_PATH, "broadcast_news");
const leaderDoc = () => doc(db, ...BASE_PATH, "broadcast_meta", "leader");

// How long a producer lease lasts before another client may take over
const LEASE_MS = 45_000;
// Firestore documents are capped at 1MiB; keep audio chunks well under that
const CHUNK_CHARS = 700_000;
// Silence between consecutive segments on air
const SEGMENT_GAP_MS = 700;
// PCM16 mono @24kHz is 48,000 bytes per second; base64 expands bytes by 4/3
const PCM_BYTES_PER_MS = 48;

export interface AiredSegment extends ScriptSegment {
  id: string;
  airAt: number;
  durationMs: number;
}

export interface PublishItem {
  segment: ScriptSegment;
  audioBase64: string;
}

export function audioDurationMs(base64Audio: string): number {
  const bytes = Math.floor((base64Audio.length * 3) / 4);
  return Math.round(bytes / PCM_BYTES_PER_MS);
}

// Rejects if the underlying promise does not settle in time, so a slow or
// unreachable Firestore can never wedge the broadcast pipeline.
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

// Returns true if this client is (now) the producer. The lease must be
// re-acquired periodically; an expired lease can be claimed by anyone.
// Writes only when claiming or when the lease is past half-life, so the
// election costs roughly one Firestore write per ~20s instead of per tick.
export async function acquireLeadership(clientId: string): Promise<boolean> {
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(leaderDoc());
    const data = snap.data();
    const now = Date.now();
    const leaseUntil = data?.leaseUntil ?? 0;
    if (snap.exists() && data?.clientId === clientId) {
      if (leaseUntil - now < LEASE_MS / 2) {
        tx.set(leaderDoc(), { clientId, leaseUntil: now + LEASE_MS });
      }
      return true;
    }
    if (!snap.exists() || leaseUntil < now) {
      tx.set(leaderDoc(), { clientId, leaseUntil: now + LEASE_MS });
      return true;
    }
    return false;
  });
}

export async function releaseLeadership(clientId: string): Promise<void> {
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(leaderDoc());
      if (snap.exists() && snap.data()?.clientId === clientId) {
        tx.set(leaderDoc(), { clientId, leaseUntil: 0 });
      }
    });
  } catch {
    // Best effort; the lease expires on its own
  }
}

// Epoch ms when the last scheduled segment finishes airing (never in the past)
export async function getRunwayEndMs(): Promise<number> {
  const q = query(segmentsCol(), orderBy("airAt", "desc"), limit(1));
  const snap = await getDocs(q);
  if (snap.empty) return Date.now();
  const data = snap.docs[0].data();
  return Math.max(Date.now(), (data.airAt ?? 0) + (data.durationMs ?? 0));
}

// Writes a sequence of segments to the shared timeline, starting at
// firstAirAt. Audio is split into sub-1MiB chunks. The batch is atomic, so
// subscribers never observe a segment without its audio.
export async function publishProgram(
  items: PublishItem[],
  firstAirAt: number,
  opts?: { isBreaking?: boolean }
): Promise<number> {
  const batch = writeBatch(db);
  let airAt = firstAirAt;

  for (const { segment, audioBase64 } of items) {
    const durationMs = audioDurationMs(audioBase64);
    const segRef = doc(segmentsCol());
    const chunks: string[] = [];
    for (let p = 0; p < audioBase64.length; p += CHUNK_CHARS) {
      chunks.push(audioBase64.slice(p, p + CHUNK_CHARS));
    }
    batch.set(segRef, {
      speaker: segment.speaker,
      text: segment.text,
      emotion: segment.emotion,
      isBreaking: opts?.isBreaking ?? false,
      airAt,
      durationMs,
      chunkCount: chunks.length,
      createdAt: Date.now(),
    });
    chunks.forEach((data, index) => {
      batch.set(doc(segRef, "chunks", String(index)), { index, data });
    });
    airAt += durationMs + SEGMENT_GAP_MS;
  }

  await batch.commit();
  return airAt;
}

// Streams current and future segments (plus their audio) to the callback.
// Segments that already finished airing are skipped without fetching audio.
export function subscribeToBroadcast(
  onSegment: (segment: AiredSegment, audioBase64: string) => void
): () => void {
  const q = query(
    segmentsCol(),
    where("airAt", ">", Date.now() - 5 * 60_000),
    orderBy("airAt", "asc")
  );
  const seen = new Set<string>();

  return onSnapshot(
    q,
    (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type !== "added" || seen.has(change.doc.id)) return;
        seen.add(change.doc.id);

        const data = change.doc.data();
        const airAt = data.airAt ?? 0;
        const durationMs = data.durationMs ?? 0;
        if (airAt + durationMs < Date.now() + 250) return; // already aired

        void (async () => {
          try {
            const chunksSnap = await getDocs(collection(change.doc.ref, "chunks"));
            const audioBase64 = chunksSnap.docs
              .map((c) => ({ index: c.data().index ?? 0, data: c.data().data ?? "" }))
              .sort((a, b) => a.index - b.index)
              .map((c) => c.data)
              .join("");
            if (!audioBase64) return;
            onSegment(
              {
                id: change.doc.id,
                speaker: data.speaker,
                text: data.text,
                emotion: data.emotion,
                isBreaking: !!data.isBreaking,
                airAt,
                durationMs,
              },
              audioBase64
            );
          } catch (err) {
            console.error("Failed to load broadcast segment audio:", err);
          }
        })();
      });
    },
    (err) => {
      console.error("Broadcast subscription error:", err);
    }
  );
}

// Deletes segments that finished airing a while ago (producer housekeeping)
export async function cleanupExpiredSegments(): Promise<void> {
  const q = query(segmentsCol(), where("airAt", "<", Date.now() - 10 * 60_000), limit(10));
  const snap = await getDocs(q);
  for (const segDoc of snap.docs) {
    const chunksSnap = await getDocs(collection(segDoc.ref, "chunks"));
    await Promise.all(chunksSnap.docs.map((c) => deleteDoc(c.ref)));
    await deleteDoc(segDoc.ref);
  }
}

// Headlines already broadcast, newest first (fed back into the news check
// prompt to avoid re-reporting the same story under a different slug)
export async function getRecentNewsHeadlines(): Promise<string[]> {
  const q = query(newsCol(), orderBy("createdAt", "desc"), limit(10));
  const snap = await getDocs(q);
  return snap.docs
    .map((d) => d.data().headline as string | undefined)
    .filter((h): h is string => !!h);
}

// Atomically claims a news slug; returns false if it was already broadcast
export async function claimNews(slug: string, headline: string): Promise<boolean> {
  const ref = doc(newsCol(), slug);
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists()) return false;
    tx.set(ref, { headline, createdAt: Date.now() });
    return true;
  });
}
