"use client";

import React, { useState, useEffect, useRef } from "react";
import { collection, query, where, getDocs, updateDoc, doc, limit, addDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { getAudioEngine, ScriptSegment, AudioEngine } from "@/lib/audioEngine";
import { RadioVisualizer } from "@/components/RadioVisualizer";
import { ChatBox } from "@/components/ChatBox";
import { LetterModal } from "@/components/LetterModal";
import { 
  Radio, Play, Square, Volume2, Plus, Loader2, Sparkles, MessageCircle, 
  HelpCircle, User, Rss, ArrowRight 
} from "lucide-react";

export default function Home() {
  const [isPlaying, setIsPlaying] = useState(false);
  const [audioEngine, setAudioEngine] = useState<AudioEngine | null>(null);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  
  // UI states
  const [currentSegment, setCurrentSegment] = useState<ScriptSegment | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isLetterModalOpen, setIsLetterModalOpen] = useState(false);
  const [statusMessage, setStatusMessage] = useState("放送はスタンバイ状態です。開始ボタンを押してください。");
  const [letterCount, setLetterCount] = useState(0);

  // Background state to prevent overlapping script generations
  const isGeneratingRef = useRef(false);

  useEffect(() => {
    const engine = getAudioEngine();
    if (engine) {
      setAudioEngine(engine);
      engine.init();
      setAnalyser(engine.analyser);

      // Listen to engine callbacks
      engine.setCallbacks(
        (segment) => {
          setCurrentSegment(segment);
          setStatusMessage(`${segment.speaker} がお話し中 (${segment.emotion})`);
        },
        () => {
          setCurrentSegment(null);
          setStatusMessage("BGM演奏中...");
        },
        () => {
          // Trigger automatic next segment generation when queue runs empty
          setStatusMessage("次のニュース台本を読み込んでいます...");
          generateAndQueueNext();
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
  }, []);

  const handleStartBroadcast = async () => {
    if (!audioEngine) return;
    
    if (isPlaying) {
      // Stop broadcast
      audioEngine.stop();
      setIsPlaying(false);
      setCurrentSegment(null);
      setStatusMessage("放送はスタンバイ状態です。開始ボタンを押してください。");
    } else {
      // Start broadcast
      audioEngine.start();
      setIsPlaying(true);
      setStatusMessage("放送開始... BGM演奏中");
      
      // Auto trigger first script generation if queue is empty
      generateAndQueueNext();
    }
  };

  const BACKUP_SCRIPTS: { segments: ScriptSegment[] }[] = [
    {
      segments: [
        { speaker: "Aoede", text: "リスナーの皆さん、えーあいらじおをお聞きいただきありがとうございます！", emotion: "happy" },
        { speaker: "Charon", text: "はい、お聞きいただきありがとうございます。只今、最新ニュースの取得システムが少し混み合っているようです。", emotion: "calm" },
        { speaker: "Aoede", text: "そんな時もありますよね。ということで、少しの間、私たちのフリートークをお届けします！", emotion: "excited" },
        { speaker: "Charon", text: "そうですね。皆さんは最近、どんなテクノロジーに注目していますか？ぜひチャットで教えてくださいね。", emotion: "calm" },
        { speaker: "Aoede", text: "それでは、引き続きえーあいらじおのLofi BGMとともに、ゆったりとお楽しみください！", emotion: "happy" }
      ]
    },
    {
      segments: [
        { speaker: "Aoede", text: "さて、お便りのコーナーにいきたいところですが、ただいま電波の調子が悪いみたいです。", emotion: "sad" },
        { speaker: "Charon", text: "そうですね、インターネットの宇宙を漂っているお便りを現在サーチ中です。", emotion: "calm" },
        { speaker: "Aoede", text: "お便りはいつでも大歓迎ですので、ぜひ上のボタンから送ってみてくださいね！", emotion: "excited" },
        { speaker: "Charon", text: "お送りいただいたメッセージは、電波が回復し次第、順次読み上げさせていただきます。", emotion: "calm" }
      ]
    },
    {
      segments: [
        { speaker: "Aoede", text: "ここでちょっとした雑談ですが、AIによる対話って本当に不思議ですよね。", emotion: "happy" },
        { speaker: "Charon", text: "そうですね。私たちのこの掛け合いも、リアルタイムに生成されて声になっているのが面白いところです。", emotion: "calm" },
        { speaker: "Aoede", text: "たまに言葉が詰まったりするかもしれませんが、それもラジオの醍醐味として楽しんでもらえると嬉しいです！", emotion: "excited" },
        { speaker: "Charon", text: "温かい目で見守ってください。それでは次のニュースの準備が整うまで、フリートークをお送りしました。", emotion: "calm" }
      ]
    }
  ];

  const generateAndQueueNext = async () => {
    if (!audioEngine || isGeneratingRef.current) return;
    isGeneratingRef.current = true;
    setIsLoading(true);

    try {
      // 1. Fetch unread letters from Firestore
      const lettersRef = collection(db, "artifacts", "ai-radio-default", "public", "data", "letters");
      const q = query(lettersRef, where("used", "==", false), limit(3));
      const querySnapshot = await getDocs(q);
      
      const letters: any[] = [];
      const letterDocIds: string[] = [];
      querySnapshot.forEach((doc) => {
        letters.push({ id: doc.id, ...doc.data() });
        letterDocIds.push(doc.id);
      });

      // 2. Request new script script
      const scriptResponse = await fetch("/api/radio-script", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ letters }),
      });

      if (!scriptResponse.ok) {
        throw new Error(`Failed to generate script: ${scriptResponse.statusText}`);
      }

      const scriptData = await scriptResponse.json();
      const segments: ScriptSegment[] = scriptData.segments || [];

      if (segments.length === 0) {
        throw new Error("No segments generated in script");
      }

      // Mark letters as used so they are not repeated
      await Promise.all(
        letterDocIds.map((id) => 
          updateDoc(doc(db, "artifacts", "ai-radio-default", "public", "data", "letters", id), { used: true })
        )
      );
      setLetterCount(0);

      // Post system announcement to Firestore chats
      try {
        const chatsRef = collection(db, "artifacts", "ai-radio-default", "public", "data", "chats");
        await addDoc(chatsRef, {
          user: "System",
          text: `🎙️ 新しいニュースコーナー「AIトレンド情報」のオンエアが始まりました！`,
          createdAt: Date.now(),
          isSystem: true,
        });
      } catch (chatErr) {
        console.error("Failed to post system announcement to chat:", chatErr);
      }

      // 3. Parallel fetch TTS audio for all segments to prevent lagging
      const ttsPromises = segments.map(async (segment) => {
        const ttsResponse = await fetch("/api/radio-tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: segment.text, speaker: segment.speaker }),
        });

        if (!ttsResponse.ok) {
          throw new Error(`TTS generation failed for ${segment.speaker}`);
        }

        const ttsData = await ttsResponse.json();
        return {
          segment,
          audioContent: ttsData.audioContent as string,
        };
      });

      const ttsResults = await Promise.all(ttsPromises);

      // 4. Queue everything to the audio engine
      ttsResults.forEach((result) => {
        audioEngine.queueSegment(result.segment, result.audioContent);
      });

      setStatusMessage("新しい台本と音声をロードしました。順次放送します。");
    } catch (error: any) {
      console.error("Error in broadcasting sequence, falling back to backup script:", error);
      setStatusMessage(`一時的な通信エラーのため、バックアップ台本でお送りしています。`);
      
      try {
        // Fallback to random backup script
        const randomBackup = BACKUP_SCRIPTS[Math.floor(Math.random() * BACKUP_SCRIPTS.length)];
        const backupSegments = randomBackup.segments;

        // Post system announcement about fallback
        try {
          const chatsRef = collection(db, "artifacts", "ai-radio-default", "public", "data", "chats");
          await addDoc(chatsRef, {
            user: "System",
            text: `⚠️ 通信エラーが発生したため、自動フリートーク（バックアップモード）をオンエアしています。`,
            createdAt: Date.now(),
            isSystem: true,
          });
        } catch (chatErr) {}

        // Parallel fetch TTS audio for backup segments
        const ttsPromises = backupSegments.map(async (segment) => {
          const ttsResponse = await fetch("/api/radio-tts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: segment.text, speaker: segment.speaker }),
          });

          if (!ttsResponse.ok) {
            throw new Error(`TTS generation failed for backup ${segment.speaker}`);
          }

          const ttsData = await ttsResponse.json();
          return {
            segment,
            audioContent: ttsData.audioContent as string,
          };
        });

        const ttsResults = await Promise.all(ttsPromises);

        ttsResults.forEach((result) => {
          audioEngine.queueSegment(result.segment, result.audioContent);
        });

        setStatusMessage("バックアップ台本と音声をロードしました。順次放送します。");
      } catch (fallbackErr: any) {
        console.error("Critical error: Fallback script also failed.", fallbackErr);
        setStatusMessage(`完全なシステムエラーが発生しました。5秒後に再試行します。`);
        
        // Final fallback retry after delay
        setTimeout(() => {
          if (isPlaying) generateAndQueueNext();
        }, 5000);
      }
    } finally {
      setIsLoading(false);
      isGeneratingRef.current = false;
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
            <div className="mt-6 bg-slate-950/60 border border-slate-900 rounded-2xl p-6 min-h-[140px] flex flex-col justify-between relative">
              
              {currentSegment ? (
                <>
                  {/* Speaker Label */}
                  <div className="flex items-center space-x-2.5 mb-3">
                    <div className={`w-2.5 h-2.5 rounded-full ${
                      currentSegment.speaker === "Aoede" 
                        ? "bg-pink-500 shadow-[0_0_8px_#ec4899]" 
                        : "bg-cyan-400 shadow-[0_0_8px_#22d3ee]"
                    }`} />
                    <span className={`text-xs font-bold ${
                      currentSegment.speaker === "Aoede" ? "text-pink-400" : "text-cyan-400"
                    }`}>
                      {currentSegment.speaker} ({currentSegment.speaker === "Aoede" ? "女性" : "男性"})
                    </span>
                    <span className="text-[10px] text-slate-500 font-medium">
                      emotion: {currentSegment.emotion}
                    </span>
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
                  <span>Powered by Gemini 2.5 Flash & Search Grounding</span>
                </div>
                <span>ローカルLo-FiシンセサイザーBGM自動同調中</span>
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
                <h4 className="text-xs font-semibold text-slate-300">AIによるリアルタイム対話台本</h4>
                <p className="text-[11px] text-slate-400 leading-relaxed">
                  Google Searchを利用して、最新のITやテックトレンドニュースを収集し、AoedeとCharonの二人の対話台本を毎回完全に新規生成します。
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
        &copy; 2026 えーあいらじお (AI Radio). All rights reserved.
      </footer>

      {/* Letter Modal */}
      <LetterModal
        isOpen={isLetterModalOpen}
        onClose={() => setIsLetterModalOpen(false)}
      />
    </main>
  );
}
