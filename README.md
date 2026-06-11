# えーあいらじお (AI Radio)

Gemini が台本と音声をリアルタイム生成する 24/7 AI ラジオ局です。最新のテックニュースを Google Search グラウンディングで取得し、2 人の AI パーソナリティ (Aoede / Charon) が対話形式で放送します。リスナーはチャットで実況したり、番組内で読み上げられるお便りを投稿できます。

公開 URL: https://ai-radio-five.vercel.app/

## 主な機能

- **共有放送タイムライン** — 再生中のクライアントから1台が「番組生成担当」に自動選出され、生成した番組を Firestore のタイムラインに送出。全リスナーが同じ放送を同じタイミングで聴く、本物のラジオと同じ設計（途中参加はセグメントの途中から合流）
- **AI 台本生成** — Gemini 2.5 Flash + Google Search で最新ニュースとお便りを織り込んだ対話台本を生成 (`/api/radio-script`)
- **ニュース速報** — 重大な AI ニュース（大手の新モデル発表、大型発表会など）を定期監視し、ジングル付きの速報として番組に割り込み挿入 (`/api/breaking-news`)
- **お便りへのリアルタイム回答** — お便りの質問は Google Search で裏取りした上で番組内で回答。回答は全リスナーに放送される
- **ずんだもん音声** — パーソナリティは「ずんだもん」。VPS 上の VOICEVOX エンジンでローカル合成するためクォータ制限なし。VOICEVOX 不達時は Gemini TTS → 無音の順でフォールバック (`/api/radio-tts`)
- **VPS 常駐プロデューサー** — [worker/](worker/README.md) の Node ワーカーが優先プロデューサーとして24時間番組を生成。ワーカー停止時は再生中ブラウザの選出に自動フォールバック。リスナー不在時は生成を休止して API クォータを節約
- **Lo-Fi BGM シンセサイザー** — Web Audio API によるローカル生成 BGM。発話中は自動ダッキング
- **実況チャット / お便り投稿** — Firebase Firestore によるリアルタイム同期
- **フォールバック放送** — Gemini API の高需要 (429/503) 時はバックアップ台本・無音音声に自動切替し、放送が止まらない設計

## 技術スタック

- Next.js (App Router) / React / TypeScript / Tailwind CSS
- Gemini API (テキスト生成 + TTS)
- Firebase Firestore
- Vercel (ホスティング)

## 開発環境のセットアップ

1. 依存関係をインストール:

   ```bash
   npm install
   ```

2. `.env.example` を参考に `.env.local` を作成し、Gemini API キーと Firebase 設定を記入します (コミットしないでください)。

3. 開発サーバーを起動:

   ```bash
   npm run dev
   ```

   http://localhost:3000 を開き、「放送を開始する」を押すと放送が始まります。

## Firestore セキュリティルール

`firestore.rules` をプロジェクトにデプロイしてください。チャット (`chats`) とお便り (`letters`) のコレクションのみ読み書きを許可しています。

## デプロイ

Vercel にデプロイし、環境変数 (`GEMINI_API_KEY` と `NEXT_PUBLIC_FIREBASE_*`、任意で `VOICEVOX_URL` / `VOICEVOX_TOKEN`) をプロジェクト設定に登録してください。

VPS ワーカー (常駐プロデューサー + VOICEVOX) のセットアップ手順は [worker/README.md](worker/README.md) を参照してください。

## クレジット

音声合成: VOICEVOX:ずんだもん (https://voicevox.hiroshiba.jp/)
