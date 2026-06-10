import React, { useState, useEffect } from "react";
import { collection, addDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { X, Send, Heart } from "lucide-react";

interface LetterModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const LetterModal: React.FC<LetterModalProps> = ({ isOpen, onClose }) => {
  const [sender, setSender] = useState("");
  const [content, setContent] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");

  useEffect(() => {
    if (typeof window !== "undefined") {
      const storedName = localStorage.getItem("ai-radio-username");
      if (storedName) {
        setSender(storedName);
      }
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sender.trim() || !content.trim()) return;

    setIsSending(true);
    setStatusMessage("");

    try {
      // Nested Firestore Collection path: /artifacts/ai-radio-default/public/data/letters
      const lettersRef = collection(db, "artifacts", "ai-radio-default", "public", "data", "letters");
      
      await addDoc(lettersRef, {
        sender: sender.trim(),
        content: content.trim().substring(0, 200),
        createdAt: Date.now(),
        used: false,
      });

      // Save sender name
      if (typeof window !== "undefined") {
        localStorage.setItem("ai-radio-username", sender.trim());
      }

      setStatusMessage("お便りをお送りしました！番組で読まれるのをお楽しみに。");
      setContent("");
      
      // Auto close after 2 seconds
      setTimeout(() => {
        setStatusMessage("");
        onClose();
      }, 2000);
    } catch (error) {
      console.error("Error sending letter to Firestore:", error);
      setStatusMessage("送信中にエラーが発生しました。時間をおいて再度お試しください。");
    } finally {
      setIsSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-slate-950/70 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal Content */}
      <div className="relative w-full max-w-md bg-slate-900 border border-slate-800 rounded-3xl p-6 shadow-2xl z-10 overflow-hidden">
        {/* Glow effect */}
        <div className="absolute -top-20 -left-20 w-48 h-48 bg-purple-500/10 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute -bottom-20 -right-20 w-48 h-48 bg-pink-500/10 rounded-full blur-3xl pointer-events-none" />

        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center space-x-2">
            <Heart className="w-5 h-5 text-pink-500 fill-pink-500/20" />
            <h3 className="text-base font-semibold text-slate-100">お便りを送る</h3>
          </div>
          <button 
            onClick={onClose}
            className="text-slate-400 hover:text-slate-200 transition-colors p-1 rounded-full hover:bg-slate-800/50"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {statusMessage ? (
          <div className="flex flex-col items-center justify-center py-8 text-center space-y-3">
            <div className="bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 px-4 py-3 rounded-2xl text-xs max-w-xs leading-relaxed font-medium">
              {statusMessage}
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-1.5 ml-1">
                ラジオネーム
              </label>
              <input
                type="text"
                required
                value={sender}
                onChange={(e) => setSender(e.target.value.substring(0, 20))}
                placeholder="ラジオネームを入力"
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-xs text-slate-200 focus:outline-none focus:border-purple-500 placeholder-slate-600"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-1.5 ml-1">
                お便り内容 (最大200文字)
              </label>
              <textarea
                required
                value={content}
                onChange={(e) => setContent(e.target.value.substring(0, 200))}
                placeholder="パーソナリティに聞きたい質問や、最近の出来事、メッセージなどをご自由にどうぞ！"
                rows={4}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-xs text-slate-200 focus:outline-none focus:border-purple-500 placeholder-slate-600 resize-none leading-relaxed"
              />
              <div className="flex justify-between items-center mt-1 ml-1">
                <span className="text-[10px] text-slate-500">
                  ※ 放送時にリアルタイムに読み上げられます
                </span>
                <span className="text-[10px] text-slate-500 font-medium">
                  {content.length}/200
                </span>
              </div>
            </div>

            <button
              type="submit"
              disabled={isSending || !sender.trim() || !content.trim()}
              className="w-full bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-500 hover:to-pink-500 text-white font-semibold py-3 px-4 rounded-xl text-xs transition-colors flex items-center justify-center space-x-2 disabled:opacity-50 shadow-lg shadow-purple-600/20"
            >
              <Send className="w-4 h-4" />
              <span>{isSending ? "送信中..." : "お便りを投函する"}</span>
            </button>
          </form>
        )}
      </div>
    </div>
  );
};
