import React, { useState, useEffect, useRef } from "react";
import { collection, query, orderBy, limit, onSnapshot, addDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { MessageSquare, Send } from "lucide-react";

interface ChatMessage {
  id: string;
  user: string;
  text: string;
  createdAt: number;
  isSystem?: boolean;
}

export const ChatBox: React.FC = () => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState("");
  const [userName, setUserName] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Initialize random anonymous username if not set in localStorage
  useEffect(() => {
    if (typeof window !== "undefined") {
      const storedName = localStorage.getItem("ai-radio-username");
      if (storedName) {
        setUserName(storedName);
      } else {
        const randName = `リスナー${Math.floor(100 + Math.random() * 900)}`;
        setUserName(randName);
        localStorage.setItem("ai-radio-username", randName);
      }
    }
  }, []);

  // Listen to Firestore chat collection
  useEffect(() => {
    // Nested Firestore Collection path: /artifacts/ai-radio-default/public/data/chats
    const chatsRef = collection(db, "artifacts", "ai-radio-default", "public", "data", "chats");
    const q = query(chatsRef, orderBy("createdAt", "asc"), limit(100));

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const msgs: ChatMessage[] = [];
      snapshot.forEach((doc) => {
        const data = doc.data();
        msgs.push({
          id: doc.id,
          user: data.user || "Unknown",
          text: data.text || "",
          createdAt: data.createdAt || Date.now(),
          isSystem: data.isSystem || false,
        });
      });
      setMessages(msgs);
    }, (error) => {
      console.error("Error reading chats from Firestore:", error);
    });

    return () => unsubscribe();
  }, []);

  // Auto-scroll to bottom when messages update
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim()) return;

    try {
      const chatsRef = collection(db, "artifacts", "ai-radio-default", "public", "data", "chats");
      await addDoc(chatsRef, {
        user: userName,
        text: inputText.trim(),
        createdAt: Date.now(),
        isSystem: false,
      });
      setInputText("");
    } catch (error) {
      console.error("Error sending message to Firestore:", error);
    }
  };

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newName = e.target.value.substring(0, 15);
    setUserName(newName);
    if (typeof window !== "undefined") {
      localStorage.setItem("ai-radio-username", newName);
    }
  };

  return (
    <div className="flex flex-col h-[450px] bg-slate-900/60 backdrop-blur-md rounded-2xl border border-slate-800 overflow-hidden shadow-2xl">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-slate-950/80 border-b border-slate-800">
        <div className="flex items-center space-x-2">
          <MessageSquare className="w-5 h-5 text-indigo-400" />
          <h2 className="text-sm font-semibold text-slate-200 tracking-wide">
            実況チャットルーム
          </h2>
        </div>
        <div className="flex items-center space-x-2">
          <span className="text-[10px] text-slate-400">ラジオネーム:</span>
          <input
            type="text"
            value={userName}
            onChange={handleNameChange}
            placeholder="名無し"
            className="text-xs bg-slate-900 border border-slate-700/60 rounded px-2 py-0.5 text-indigo-300 font-medium focus:outline-none focus:border-indigo-500 w-[100px] text-center"
          />
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3 scrollbar-thin scrollbar-thumb-slate-800 scrollbar-track-transparent">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-slate-500 text-xs space-y-1">
            <p>まだチャットメッセージはありません</p>
            <p>最初のメッセージを投稿して実況を盛り上げよう！</p>
          </div>
        ) : (
          messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex flex-col ${
                msg.isSystem
                  ? "items-center my-2"
                  : msg.user === userName
                  ? "items-end"
                  : "items-start"
              }`}
            >
              {msg.isSystem ? (
                <span className="text-[10px] text-slate-500 bg-slate-950/40 border border-slate-800/80 px-2.5 py-0.5 rounded-full">
                  {msg.text}
                </span>
              ) : (
                <div className="max-w-[85%]">
                  {msg.user !== userName && (
                    <span className="text-[10px] text-slate-400 font-medium ml-1 block mb-0.5">
                      {msg.user}
                    </span>
                  )}
                  <div
                    className={`text-xs px-3 py-2.5 rounded-2xl leading-relaxed break-words ${
                      msg.user === userName
                        ? "bg-indigo-600 text-white rounded-tr-none shadow-lg shadow-indigo-600/15"
                        : "bg-slate-850 border border-slate-800 text-slate-200 rounded-tl-none"
                    }`}
                  >
                    {msg.text}
                  </div>
                </div>
              )}
            </div>
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <form
        onSubmit={handleSendMessage}
        className="p-3 bg-slate-950/80 border-t border-slate-800 flex items-center space-x-2"
      >
        <input
          type="text"
          value={inputText}
          onChange={(e) => setInputText(e.target.value.substring(0, 100))}
          placeholder="実況メッセージを入力... (最大100文字)"
          className="flex-1 bg-slate-900 border border-slate-700/80 rounded-xl px-4 py-2.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
        />
        <button
          type="submit"
          disabled={!inputText.trim()}
          className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-xl p-2.5 transition-colors focus:outline-none shadow-md shadow-indigo-600/10"
        >
          <Send className="w-4 h-4" />
        </button>
      </form>
    </div>
  );
};
