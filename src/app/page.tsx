"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { collection, query, where, getDocs, updateDoc, doc, limit, addDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { getAudioEngine, ScriptSegment } from "@/lib/audioEngine";
import {
  acquireLeadership,
  releaseLeadership,
  getRunwayEndMs,
  publishProgram,
  subscribeToBroadcast,
  cleanupExpiredSegments,
  getRecentNewsHeadlines,
  claimNews,
  claimGenericAnnouncement,
  writePresence,
  clearPresence,
  withTimeout,
  PublishItem,
} from "@/lib/broadcastBus";
import { RadioVisualizer } from "@/components/RadioVisualizer";
import { ChatBox } from "@/components/ChatBox";
import { LetterModal } from "@/components/LetterModal";
import {
  Radio, Play, Square, Plus, Loader2, Sparkles,
  HelpCircle, Rss
} from "lucide-react";

interface Letter {
  id: string;
  sender?: string;
  content?: string;
  createdAt?: number;
}

// Producer pacing
const RUNWAY_THRESHOLD_MS = 45_000; // generate the next corner when less air time than this remains
const GEN_RETRY_MS = 15_000; // minimum interval between generation attempts
const NEWS_CHECK_INTERVAL_MS = 10 * 60_000; // breaking-news check cadence
const CLEANUP_INTERVAL_MS = 60_000; // expired-segment cleanup cadence
const PRODUCER_TICK_MS = 5_000;

const BACKUP_SCRIPTS: { segments: ScriptSegment[] }[] = [
  {
    segments: [
      { speaker: "ずんだもん", text: "リスナーのみんな、えーあいらじおを聞いてくれてありがとうなのだ！", emotion: "happy" },
      { speaker: "ずんだもん", text: "只今、最新ニュースの取得システムがちょっと混み合っているみたいなのだ。", emotion: "calm" },
      { speaker: "ずんだもん", text: "そんな時もあるのだ。ということで、少しの間、ボクのフリートークをお届けするのだ！", emotion: "excited" },
      { speaker: "ずんだもん", text: "みんなは最近、どんなテクノロジーに注目しているのだ？ぜひチャットで教えてほしいのだ。", emotion: "calm" },
      { speaker: "ずんだもん", text: "それでは、引き続きえーあいらじおのLofi BGMとともに、ゆったり楽しんでほしいのだ！", emotion: "happy" }
    ]
  },
  {
    segments: [
      { speaker: "ずんだもん", text: "さて、お便りのコーナーにいきたいところなのだけど、ただいま電波の調子が悪いみたいなのだ。", emotion: "sad" },
      { speaker: "ずんだもん", text: "インターネットの宇宙を漂っているお便りを、いま一生懸命サーチ中なのだ。", emotion: "calm" },
      { speaker: "ずんだもん", text: "お便りはいつでも大歓迎だから、ぜひ上のボタンから送ってみてほしいのだ！", emotion: "excited" },
      { speaker: "ずんだもん", text: "もらったメッセージは、電波が回復し次第、順番に読み上げるのだ。", emotion: "calm" }
    ]
  },
  {
    segments: [
      { speaker: "ずんだもん", text: "ここでちょっとした雑談なのだ。AIがリアルタイムでラジオをやるって、本当に不思議なのだ。", emotion: "happy" },
      { speaker: "ずんだもん", text: "ボクのこのおしゃべりも、その場で生成されて声になっているのがおもしろいところなのだ。", emotion: "calm" },
      { speaker: "ずんだもん", text: "たまに言葉が詰まったりするかもしれないけど、それもラジオの醍醐味として楽しんでもらえるとうれしいのだ！", emotion: "excited" },
      { speaker: "ずんだもん", text: "温かい目で見守ってほしいのだ。次のニュースの準備が整うまで、フリートークをお送りしたのだ。", emotion: "calm" }
    ]
  }
];

const newClientId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `client-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;

export default function Home() {
  const [isPlaying, setIsPlaying] = useState(false);
  // The engine singleton is created lazily; AudioContext init happens on user gesture in start()
  const [audioEngine] = useState(() => getAudioEngine());
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const [clientId] = useState(newClientId);

  // UI states
  const [currentSegment, setCurrentSegment] = useState<ScriptSegment | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isLeader, setIsLeader] = useState(false);
  const [isLetterModalOpen, setIsLetterModalOpen] = useState(false);
  const [statusMessage, setStatusMessage] = useState("放送はスタンバイ状態です。開始ボタンを押してください。");
  const [letterCount, setLetterCount] = useState(0);

  // Background state to prevent overlapping script generations
  const isGeneratingRef = useRef(false);
  // Ensures the fallback announcement is posted to chat only once per failure streak
  const fallbackAnnouncedRef = useRef(false);
  // Producer pacing timestamps
  const lastGenAttemptRef = useRef(0);
  const lastNewsCheckRef = useRef(0);
  const lastCleanupRef = useRef(0);

  // Generates TTS audio for each segment sequentially to avoid Gemini quota spikes
  const synthesizeSegments = useCallback(async (segments: ScriptSegment[]): Promise<PublishItem[]> => {
    const items: PublishItem[] = [];
    for (const segment of segments) {
      const ttsResponse = await fetch("/api/radio-tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: segment.text, speaker: segment.speaker, emotion: segment.emotion }),
      });
      if (!ttsResponse.ok) {
        throw new Error(`TTS generation failed for ${segment.speaker}`);
      }
      const ttsData = await ttsResponse.json();
      items.push({ segment, audioBase64: ttsData.audioContent as string });
    }
    return items;
  }, []);

  // Producer duty: generate the next regular corner (news + letters) and
  // publish it to the shared timeline that every listener plays.
  const produceNextCorner = useCallback(async () => {
    if (!audioEngine || isGeneratingRef.current) return;
    isGeneratingRef.current = true;
    setIsLoading(true);

    try {
      // 1. Fetch unread letters from Firestore, oldest first so nobody's
      // letter is starved by newer arrivals
      const lettersRef = collection(db, "artifacts", "ai-radio-default", "public", "data", "letters");
      const q = query(lettersRef, where("used", "==", false), limit(10));
      const querySnapshot = await withTimeout(getDocs(q), 8_000, "letters");

      const unread: Letter[] = [];
      querySnapshot.forEach((docSnap) => {
        unread.push({ id: docSnap.id, ...docSnap.data() });
      });
      unread.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
      const letters = unread.slice(0, 3);
      const letterDocIds = letters.map((l) => l.id);

      // 2. Generate the script (Gemini + Google Search, letters answered live)
      setStatusMessage("次のコーナーの台本を生成しています...");
      const scriptResponse = await fetch("/api/radio-script", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ letters }),
      });

      if (!scriptResponse.ok) {
        throw new Error(`Failed to generate script: ${scriptResponse.statusText}`);
      }

      const scriptData = await scriptResponse.json();
      const scriptDegraded = Boolean(scriptData.degraded);
      const segments: ScriptSegment[] = scriptData.segments || [];

      if (segments.length === 0) {
        throw new Error("No segments generated in script");
      }

      // 3. Synthesize all audio first; letters are only consumed once their
      // answers are actually ready to air
      const items = await synthesizeSegments(segments);

      try {
        if (!scriptDegraded && letterDocIds.length > 0) {
          await withTimeout(
            Promise.all(
              letterDocIds.map((id) =>
                updateDoc(doc(db, "artifacts", "ai-radio-default", "public", "data", "letters", id), { used: true })
              )
            ),
            8_000,
            "mark-letters"
          );
          setLetterCount(0);
        }
      } catch (markErr) {
        console.error("Failed to mark letters as used (they may repeat):", markErr);
      }

      // 4. Publish to the shared timeline
      const runwayEnd = await withTimeout(getRunwayEndMs(), 8_000, "runway");
      const startAt = Math.max(Date.now() + 2_000, runwayEnd);
      await withTimeout(publishProgram(items, startAt), 30_000, "publish");

      if (!scriptDegraded) fallbackAnnouncedRef.current = false;

      // Post system announcement to Firestore chats (best-effort; never block
      // the broadcast pipeline). Corners can be generated every few minutes —
      // announce letter corners always, generic corners at most every 5 min
      const shouldAnnounceLetter = letters.length > 0 && !scriptDegraded;
      let shouldAnnounceGeneric = false;
      if (!shouldAnnounceLetter && !scriptDegraded) {
        try {
          shouldAnnounceGeneric = await withTimeout(
            claimGenericAnnouncement(5 * 60_000),
            8_000,
            "announce-throttle"
          );
        } catch (announceErr) {
          console.error("Failed to check generic announcement throttle:", announceErr);
        }
      }

      if (scriptDegraded && !fallbackAnnouncedRef.current) {
        fallbackAnnouncedRef.current = true;
        const chatsRef = collection(db, "artifacts", "ai-radio-default", "public", "data", "chats");
        addDoc(chatsRef, {
          user: "System",
          text: `⚠️ 通信エラーが発生したため、自動フリートーク（バックアップモード）をオンエアしています。`,
          createdAt: Date.now(),
          isSystem: true,
        }).catch((chatErr) => {
          console.error("Failed to post fallback announcement to chat:", chatErr);
        });
      } else if (shouldAnnounceLetter || shouldAnnounceGeneric) {
        const chatsRef = collection(db, "artifacts", "ai-radio-default", "public", "data", "chats");
        addDoc(chatsRef, {
          user: "System",
          text:
            shouldAnnounceLetter
              ? `📮 お便りコーナーがオンエアされます！(${letters.length}通のお便りを読み上げ)`
              : `🎙️ 新しいニュースコーナー「AIトレンド情報」のオンエアが始まりました！`,
          createdAt: Date.now(),
          isSystem: true,
        }).catch((chatErr) => {
          console.error("Failed to post system announcement to chat:", chatErr);
        });
      }

      setStatusMessage("新しいコーナーを放送キューに送出しました。");
    } catch (error) {
      console.error("Error in broadcasting sequence, falling back to backup script:", error);
      setStatusMessage(`一時的な通信エラーのため、バックアップ台本でお送りしています。`);

      try {
        // Fallback to random backup script
        const randomBackup = BACKUP_SCRIPTS[Math.floor(Math.random() * BACKUP_SCRIPTS.length)];
        const items = await synthesizeSegments(randomBackup.segments);

        // Post system announcement about fallback (best-effort, once per failure streak)
        if (!fallbackAnnouncedRef.current) {
          fallbackAnnouncedRef.current = true;
          const chatsRef = collection(db, "artifacts", "ai-radio-default", "public", "data", "chats");
          addDoc(chatsRef, {
            user: "System",
            text: `⚠️ 通信エラーが発生したため、自動フリートーク（バックアップモード）をオンエアしています。`,
            createdAt: Date.now(),
            isSystem: true,
          }).catch(() => {
            // Chat announcement is best-effort; ignore failures
          });
        }

        try {
          const runwayEnd = await withTimeout(getRunwayEndMs(), 8_000, "runway");
          const startAt = Math.max(Date.now() + 2_000, runwayEnd);
          await withTimeout(publishProgram(items, startAt), 30_000, "publish");
          setStatusMessage("バックアップ台本を放送キューに送出しました。");
        } catch (publishErr) {
          // Firestore unreachable: keep at least this client's broadcast alive locally
          console.error("Publish failed; playing backup script locally only:", publishErr);
          items.forEach(({ segment, audioBase64 }) => audioEngine.queueSegment(segment, audioBase64));
          setStatusMessage("バックアップ台本をローカル再生でお送りしています。");
        }
      } catch (fallbackErr) {
        console.error("Critical error: Fallback script also failed.", fallbackErr);
        setStatusMessage(`完全なシステムエラーが発生しました。自動で再試行します。`);
        // The producer tick keeps retrying while the runway is empty
      }
    } finally {
      setIsLoading(false);
      isGeneratingRef.current = false;
    }
  }, [audioEngine, synthesizeSegments]);

  // Producer duty: look for major AI news and, if found, cut into the
  // broadcast with a bulletin
  const checkBreakingNews = useCallback(async () => {
    try {
      const seenHeadlines = await withTimeout(getRecentNewsHeadlines(), 8_000, "news-history");
      const newsResponse = await fetch("/api/breaking-news", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seenHeadlines }),
      });
      if (!newsResponse.ok) return;

      const news = await newsResponse.json();
      if (!news.hasBreaking || !news.id || !news.headline) return;

      // Generate and synthesize the bulletin before claiming the slug, so a
      // failed generation doesn't permanently swallow the news
      const scriptResponse = await fetch("/api/radio-script", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ breaking: { headline: news.headline, summary: news.summary } }),
      });
      if (!scriptResponse.ok) return;

      const scriptData = await scriptResponse.json();
      const segments: ScriptSegment[] = scriptData.segments || [];
      if (segments.length === 0) return;

      const items = await synthesizeSegments(segments);

      const slug = String(news.id).toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 80) || `news-${Date.now()}`;
      const isNew = await withTimeout(claimNews(slug, news.headline), 8_000, "news-claim");
      if (!isNew) return;

      const runwayEnd = await withTimeout(getRunwayEndMs(), 8_000, "runway");
      const startAt = Math.max(Date.now() + 2_000, runwayEnd);
      await withTimeout(publishProgram(items, startAt, { isBreaking: true }), 30_000, "publish-bulletin");

      const chatsRef = collection(db, "artifacts", "ai-radio-default", "public", "data", "chats");
      addDoc(chatsRef, {
        user: "System",
        text: `🚨 ニュース速報: ${news.headline}`,
        createdAt: Date.now(),
        isSystem: true,
      }).catch(() => {
        // Chat announcement is best-effort; ignore failures
      });
    } catch (error) {
      console.error("Breaking news check failed:", error);
    }
  }, [synthesizeSegments]);

  // Producer loop: elect a leader among playing clients; the leader keeps the
  // shared timeline filled and watches for breaking news
  useEffect(() => {
    if (!isPlaying || !audioEngine) return;

    let cancelled = false;

    const tick = async () => {
      try {
        const leading = await withTimeout(acquireLeadership(clientId), 8_000, "election");
        if (cancelled) return;
        setIsLeader(leading);
        if (!leading) return;

        const now = Date.now();

        if (now - lastCleanupRef.current > CLEANUP_INTERVAL_MS) {
          lastCleanupRef.current = now;
          cleanupExpiredSegments().catch(() => {
            // Housekeeping is best-effort
          });
        }

        const runwayEnd = await withTimeout(getRunwayEndMs(), 8_000, "runway");
        if (
          runwayEnd - Date.now() < RUNWAY_THRESHOLD_MS &&
          now - lastGenAttemptRef.current > GEN_RETRY_MS &&
          !isGeneratingRef.current
        ) {
          lastGenAttemptRef.current = now;
          await produceNextCorner();
        }

        if (Date.now() - lastNewsCheckRef.current > NEWS_CHECK_INTERVAL_MS) {
          lastNewsCheckRef.current = Date.now();
          await checkBreakingNews();
        }
      } catch (error) {
        console.error("Producer tick failed:", error);
      }
    };

    tick();
    const interval = setInterval(tick, PRODUCER_TICK_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
      setIsLeader(false);
      releaseLeadership(clientId);
    };
  }, [isPlaying, audioEngine, clientId, produceNextCorner, checkBreakingNews]);

  // Listener presence heartbeat: lets the VPS producer worker know someone is
  // tuned in (it pauses generation when the station has no listeners)
  useEffect(() => {
    if (!isPlaying) return;
    const beat = () => {
      writePresence(clientId).catch(() => {
        // Best effort; missing heartbeats only delay generation
      });
    };
    beat();
    const interval = setInterval(beat, 30_000);
    return () => {
      clearInterval(interval);
      clearPresence(clientId);
    };
  }, [isPlaying, clientId]);

  // Consumer loop: every playing client (producer included) receives the
  // shared timeline and schedules segments at their absolute air times
  useEffect(() => {
    if (!isPlaying || !audioEngine) return;
    const unsubscribe = subscribeToBroadcast((segment, audioBase64) => {
      audioEngine.scheduleSegmentAt(segment, audioBase64, segment.airAt);
    });
    return () => unsubscribe();
  }, [isPlaying, audioEngine]);

  useEffect(() => {
    if (audioEngine) {
      // Listen to engine callbacks
      audioEngine.setCallbacks(
        (segment) => {
          setCurrentSegment(segment);
          setStatusMessage(
            segment.isBreaking
              ? "🚨 ニュース速報をお伝えしています"
              : `${segment.speaker} がお話し中 (${segment.emotion})`
          );
        },
        () => {
          setCurrentSegment(null);
          setStatusMessage("BGM演奏中...");
        },
        () => {
          // Queue-empty events are unused in shared-broadcast mode; the
          // producer loop keeps the timeline filled
        }
      );
    }

    // Check count of unread letters in Firestore to show badge
    const checkUnreadLetters = async () => {
      try {
        const lettersRef = collection(db, "artifacts", "ai-radio-default", "public", "data", "letters");
        const q = query(lettersRef, where("used", "==", false), limit(10));
        const snap = await getDocs(q);
        setLetterCount(snap.size);
      } catch (e) {
        console.error("Failed to query unread letters:", e);
      }
    };

    checkUnreadLetters();
    const interval = setInterval(checkUnreadLetters, 10000); // Check every 10s
    return () => clearInterval(interval);
  }, [audioEngine]);

  const handleStartBroadcast = () => {
    if (!audioEngine) return;

    if (isPlaying) {
      // Stop broadcast
      audioEngine.stop();
      setIsPlaying(false);
      setCurrentSegment(null);
      setStatusMessage("放送はスタンバイ状態です。開始ボタンを押してください。");
    } else {
      // Start broadcast; the AudioContext is created here, on the user gesture
      audioEngine.start();
      setAnalyser(audioEngine.analyser);
      setIsPlaying(true);
      setStatusMessage("放送に接続しています... 番組表を同期中");
    }
  };

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 flex flex-col relative overflow-hidden">
      {/* Dynamic colorful aura backgrounds */}
      <div className="absolute top-[-10%] left-[-10%] w-[50%] h-[50%] bg-purple-900/20 rounded-full blur-[120px] pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] bg-indigo-900/20 rounded-full blur-[120px] pointer-events-none" />

      {/* Navigation Header */}
      <header className="border-b border-slate-900 bg-slate-950/80 backdrop-blur-md sticky top-0 z-40 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <div className="bg-gradient-to-tr from-purple-600 to-indigo-600 p-2 rounded-xl shadow-lg shadow-purple-500/25">
            <Radio className="w-6 h-6 text-white animate-pulse" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight bg-gradient-to-r from-white via-indigo-200 to-purple-300 bg-clip-text text-transparent">
              えーあいらじお (AI Radio)
            </h1>
            <p className="text-[10px] text-slate-400 font-medium tracking-wider uppercase">
              24/7 AI-Generated Dialogue & Synth
            </p>
          </div>
        </div>
        <div className="flex items-center space-x-4">
          <button
            onClick={() => setIsLetterModalOpen(true)}
            className="relative bg-slate-900 hover:bg-slate-850 border border-slate-800 text-xs font-semibold px-4 py-2.5 rounded-xl transition-all flex items-center space-x-2 shadow-lg shadow-slate-950/50 hover:border-slate-700 active:scale-95"
          >
            <Plus className="w-3.5 h-3.5 text-indigo-400" />
            <span>お便りを送る</span>
            {letterCount > 0 && (
              <span className="absolute -top-1.5 -right-1.5 flex h-4 w-4">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-pink-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-4 w-4 bg-pink-500 text-[9px] font-bold items-center justify-center text-white">
                  {letterCount}
                </span>
              </span>
            )}
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      <div className="flex-1 max-w-7xl w-full mx-auto p-4 md:p-6 grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">

        {/* Left 2 Columns: On-Air Status, Visualizer, Subtitles */}
        <div className="lg:col-span-2 space-y-6">

          {/* Main On-Air Console */}
          <div className="bg-slate-900/40 border border-slate-900 rounded-3xl p-6 backdrop-blur-md shadow-2xl relative overflow-hidden">
            <div className="absolute top-0 right-0 w-32 h-32 bg-indigo-500/5 rounded-full blur-2xl pointer-events-none" />

            <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 mb-6">
              <div className="space-y-1.5">
                <div className="flex items-center space-x-2">
                  <span className="text-[10px] bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 px-2 py-0.5 rounded-full font-bold">
                    SYSTEM STATUS
                  </span>
                  {isLeader && (
                    <span className="text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2 py-0.5 rounded-full font-bold">
                      BROADCAST PRODUCER
                    </span>
                  )}
                  {isLoading && (
                    <span className="text-[10px] bg-purple-500/10 text-purple-400 border border-purple-500/20 px-2 py-0.5 rounded-full font-bold flex items-center space-x-1">
                      <Loader2 className="w-2.5 h-2.5 animate-spin" />
                      <span>GENERATING SCRIPT...</span>
                    </span>
                  )}
                </div>
                <p className="text-sm font-medium text-slate-300">
                  {statusMessage}
                </p>
              </div>

              {/* Master Play Button */}
              <button
                onClick={handleStartBroadcast}
                className={`w-full md:w-auto px-6 py-4 rounded-2xl font-bold text-xs flex items-center justify-center space-x-3 transition-all transform active:scale-98 shadow-xl ${
                  isPlaying
                    ? "bg-rose-600 hover:bg-rose-500 text-white shadow-rose-600/10 border border-rose-500/20"
                    : "bg-indigo-600 hover:bg-indigo-500 text-white shadow-indigo-600/20 border border-indigo-500/20"
                }`}
              >
                {isPlaying ? (
                  <>
                    <Square className="w-4 h-4 fill-white" />
                    <span>放送を停止する</span>
                  </>
                ) : (
                  <>
                    <Play className="w-4 h-4 fill-white" />
                    <span>放送を開始する</span>
                  </>
                )}
              </button>
            </div>

            {/* Visualizer Panel */}
            <RadioVisualizer
              analyser={analyser}
              speaker={currentSegment?.speaker || null}
              isPlaying={isPlaying}
            />

            {/* Live Subtitles & Speaker indicator */}
            <div className={`mt-6 bg-slate-950/60 border rounded-2xl p-6 min-h-[140px] flex flex-col justify-between relative ${
              currentSegment?.isBreaking ? "border-rose-500/40" : "border-slate-900"
            }`}>

              {currentSegment ? (
                <>
                  {/* Speaker Label */}
                  <div className="flex items-center space-x-2.5 mb-3">
                    <div className="w-2.5 h-2.5 rounded-full bg-lime-400 shadow-[0_0_8px_#a3e635]" />
                    <span className="text-xs font-bold text-lime-300">
                      {currentSegment.speaker}
                    </span>
                    <span className="text-[10px] text-slate-500 font-medium">
                      emotion: {currentSegment.emotion}
                    </span>
                    {currentSegment.isBreaking && (
                      <span className="text-[10px] bg-rose-500/10 text-rose-400 border border-rose-500/30 px-2 py-0.5 rounded-full font-bold animate-pulse">
                        🚨 ニュース速報
                      </span>
                    )}
                  </div>

                  {/* Script Text */}
                  <p className="text-sm md:text-base text-slate-200 leading-relaxed font-medium flex-1">
                    {currentSegment.text}
                  </p>
                </>
              ) : (
                <div className="flex flex-col items-center justify-center h-full flex-1 py-4 text-slate-500 text-xs text-center space-y-2">
                  <Rss className="w-6 h-6 text-slate-700 animate-pulse" />
                  <div>
                    <p className="font-semibold text-slate-400">現在フリートークまたはBGMのみ放送中</p>
                    <p className="text-[10px]">自動で次の時事ニュースとお便りの台本が生成されます</p>
                  </div>
                </div>
              )}

              {/* Dynamic status helper */}
              <div className="mt-4 pt-3 border-t border-slate-900/60 flex items-center justify-between text-[10px] text-slate-500">
                <div className="flex items-center space-x-1">
                  <Sparkles className="w-3 h-3 text-indigo-400" />
                  <span>Powered by Gemini & VOICEVOX:ずんだもん</span>
                </div>
                <span>全リスナー同時放送 / ローカルLo-Fiシンセサイザー</span>
              </div>
            </div>
          </div>

          {/* Quick FAQ / Guide */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-slate-900/30 border border-slate-900 rounded-2xl p-4 flex items-start space-x-3">
              <div className="bg-purple-900/20 p-2 rounded-lg text-purple-400 shrink-0">
                <Sparkles className="w-4 h-4" />
              </div>
              <div className="space-y-1">
                <h4 className="text-xs font-semibold text-slate-300">ずんだもんのリアルタイム生成ラジオ</h4>
                <p className="text-[11px] text-slate-400 leading-relaxed">
                  パーソナリティ「ずんだもん」がGoogle Searchで最新のAI・テックニュースを収集して番組を進行。OpenAIの新モデル発表など重大ニュースは「ニュース速報」として割り込みます。お便りへの回答も検索で裏取りした上で、全リスナーに同じ放送として届きます。
                </p>
              </div>
            </div>

            <div className="bg-slate-900/30 border border-slate-900 rounded-2xl p-4 flex items-start space-x-3">
              <div className="bg-indigo-900/20 p-2 rounded-lg text-indigo-400 shrink-0">
                <HelpCircle className="w-4 h-4" />
              </div>
              <div className="space-y-1">
                <h4 className="text-xs font-semibold text-slate-300">BGM自動ダッキング</h4>
                <p className="text-[11px] text-slate-400 leading-relaxed">
                  Web Audio APIで生成されるLofiシンセサイザーBGMは、パーソナリティの発話タイミングに合わせて自動で音量が下がるダッキング機能を備えています。
                </p>
              </div>
            </div>

          </div>

        </div>

        {/* Right 1 Column: Chat Room */}
        <div className="lg:col-span-1">
          <ChatBox />
        </div>

      </div>

      {/* Footer */}
      <footer className="border-t border-slate-900/60 bg-slate-950/50 py-4 text-center text-[10px] text-slate-500 mt-auto">
        &copy; 2026 えーあいらじお (AI Radio). All rights reserved. / 音声合成: VOICEVOX:ずんだもん
      </footer>

      {/* Letter Modal (mounted on open so it re-reads the stored radio name) */}
      {isLetterModalOpen && (
        <LetterModal
          isOpen={isLetterModalOpen}
          onClose={() => setIsLetterModalOpen(false)}
        />
      )}
    </main>
  );
}
