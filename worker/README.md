# AI Radio — VPSプロデューサーワーカー

VPS上で常駐し、番組の生成を一手に担うワーカーです。

- **常駐プロデューサー**: リース(優先フラグ付き)を保持し、ブラウザ側の選出ロジックは自動的にこのワーカーに譲ります。ワーカーが停止するとリースが切れ、従来どおり再生中のブラウザが生成を引き継ぎます(グレースフルデグラデーション)
- **ずんだもん音声**: 同居するVOICEVOXエンジン(Docker)でローカル合成。クォータ制限なし
- **台本・速報判定**: デプロイ済みの `/api/radio-script` / `/api/breaking-news` を呼ぶため、Gemini APIキーをVPSに置く必要はありません
- **リスナー不在時は生成休止**: 再生中のブラウザが書くプレゼンスハートビートを監視し、リスナー0なら生成を止めてクォータを節約します

## 必要環境

- Ubuntu 22.04/24.04 想定(他ディストリでも可)
- **RAM 2GB以上推奨**(VOICEVOX CPUエンジンが約1〜1.5GB使用。1GBプランの場合はスワップを2GB追加してください)
- Node.js 20以上 / Docker + Compose プラグイン

## セットアップ手順 (Ubuntu)

```bash
# 1. Node.js 22 と Docker のインストール
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs docker.io docker-compose-v2

# 2. リポジトリの配置
sudo git clone https://github.com/kaito-0827/ai-radio.git /opt/ai-radio
cd /opt/ai-radio/worker
sudo npm install --omit=dev

# 3. 環境変数 (FirebaseのWeb設定を記入。値はVercelのNEXT_PUBLIC_FIREBASE_*と同じ)
sudo cp .env.example .env
sudo nano .env

# 4. VOICEVOXエンジンの起動 (初回はイメージ取得に数分)
sudo docker compose up -d
curl -s http://127.0.0.1:50021/version   # バージョンが返ればOK

# 5. ワーカーの常駐化
sudo cp ai-radio-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ai-radio-worker

# 6. ログ確認
journalctl -u ai-radio-worker -f
```

正常に動いていると、リスナーがいる間は以下のようなログが流れます:

```
2026-06-12T00:00:00.000Z Listeners detected (1); resuming generation
2026-06-12T00:00:40.000Z Published corner: 6 segments, letters=1, degraded=false
```

## (任意) Vercel側もVOICEVOXの声にする

VPSワーカー停止時はブラウザがプロデューサーを引き継ぎ、Vercelの `/api/radio-tts` で合成します。そのときも声をずんだもんに保つには、VOICEVOXをトークン保護付きで外部公開し、Vercelの環境変数を設定します。

nginx の例 (`/etc/nginx/sites-available/voicevox`):

```nginx
server {
    listen 50080;
    location / {
        if ($http_authorization != "Bearer 任意の長いランダム文字列") { return 403; }
        proxy_pass http://127.0.0.1:50021;
    }
}
```

Vercel の環境変数:

- `VOICEVOX_URL` = `http://<VPSのIP>:50080`
- `VOICEVOX_TOKEN` = 上記のランダム文字列

未設定の場合、フォールバック時はGemini TTSの声(ずんだもんではない)になります。

## クレジット

音声合成: VOICEVOX:ずんだもん (https://voicevox.hiroshiba.jp/)
キャラクター利用ガイドラインに従い、クレジット表記を削除しないでください。
