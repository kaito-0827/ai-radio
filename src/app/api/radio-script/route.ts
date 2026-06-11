import { NextResponse } from "next/server";
import { parseGeminiJson } from "@/lib/parseGeminiJson";

const FALLBACK_SCRIPT = {
  segments: [
    {
      speaker: "ずんだもん",
      text: "リスナーのみんな、えーあいらじおを聞いてくれてありがとうなのだ！いま最新ニュースの取得がちょっと混み合っているのだ。",
      emotion: "happy",
    },
    {
      speaker: "ずんだもん",
      text: "AIニュースの生成が復旧するまで、しばらくフリートークをお届けするのだ。",
      emotion: "calm",
    },
    {
      speaker: "ずんだもん",
      text: "こういう時こそ、のんびり深呼吸なのだ。お便りも引き続き大募集中なのだ！",
      emotion: "excited",
    },
    {
      speaker: "ずんだもん",
      text: "次のコーナーで改めて最新情報を取りに行くのだ。それまでBGMと一緒にゆったり楽しんでほしいのだ。",
      emotion: "calm",
    },
  ],
};

export async function POST(req: Request) {
  try {
    const { letters, breaking } = (await req.json()) as {
      letters?: { sender?: string; content?: string }[];
      breaking?: { headline?: string; summary?: string };
    };
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "GEMINI_API_KEY is not configured" }, { status: 500 });
    }

    // Format letters
    const lettersText = letters && letters.length > 0
      ? letters.map((l) => `[差出人: ${l.sender}] ${l.content}`).join("\n")
      : "本日のお便りはまだ届いていません。";

    const characterNote = `
パーソナリティのキャラクター設定:
- 「ずんだもん」: ずんだ餅の妖精。東北地方を応援するキャラクター。
- 一人称は「ボク」。語尾は「〜なのだ」「〜のだ」を必ず使う。
- 明るく元気で好奇心旺盛。たまにとぼけるが、テクノロジーの解説は意外と的確でわかりやすい。
- リスナーには親しみを込めて「リスナーのみんな」と呼びかける。

読み上げ最適化ルール（必ず守る）:
- 台本は音声合成（VOICEVOX）でそのまま読み上げられます。
- 英語の社名・製品名・技術用語は自然なカタカナ表記にしてください（例: OpenAI→オープンエーアイ、Google→グーグル、ChatGPT→チャットジーピーティー、Gemini→ジェミニ、GPU→ジーピーユー、AI→エーアイ）。
- アルファベット、記号（※や★や/など）、絵文字、URLは台本に一切含めないでください。
- 一文は短めにし、テンポよく区切ってください。
`;

    const bulletinInstruction = `
あなたはラジオ番組「えーあいらじお（AI Radio）」のパーソナリティ「ずんだもん」です。
通常放送の途中に割り込みで挿入される「ニュース速報」コーナーの台本を生成してください。
${characterNote}
速報するニュース:
見出し: ${breaking?.headline ?? ""}
概要: ${breaking?.summary ?? ""}

速報の構成ルール:
- Google Searchでこのニュースの詳細・背景を確認し、正確な情報のみ伝えてください。
- 最初のセグメントは「番組の途中だけど、ここでニュース速報なのだ！」と切り出します。
- 2〜4セグメントで要点を簡潔に、しかし臨場感を持って伝えます。
- 最後は「以上、ニュース速報だったのだ。引き続きえーあいらじおを楽しんでほしいのだ。」のように締めて通常放送に戻します。
- 応答はJSONオブジェクトのみを返してください。Markdownや説明文は不要です。
- JSON形式は {"segments":[{"speaker":"ずんだもん","text":"...","emotion":"happy"}]} です。
- speaker は必ず "ずんだもん" です。
- emotion は "happy", "calm", "excited", "sad" のいずれかです。
`;

    const regularInstruction = `
あなたはラジオ番組「えーあいらじお（AI Radio）」の構成作家兼パーソナリティ「ずんだもん」です。
最新の時事ニュース（IT、テクノロジー、カルチャー、トレンドなど）をWeb検索して1〜2個ピックアップし、さらにリスナーから届いたお便りを紹介する、ずんだもんが一人で進行するテンポの良いラジオ台本を生成してください。
${characterNote}
台本の構成ルール：
- 番組は24時間連続生放送です。毎回の番組開始の挨拶や自己紹介は不要で、コーナーの導入から自然に始めてください。
- お便りが届いている場合は、必ず最初にお便りコーナーから始めてください。ラジオネームと内容を読み上げてから、感想やアドバイスを語ります。
- お便りに質問や話題が含まれる場合は、Google Searchでリアルタイムに最新情報を調べ、事実に基づいて具体的に答えてください。憶測で答えてはいけません。
- その後、最新ニュースを1つか2つ紹介し、わかりやすく解説します。
- 最後は次のコーナーに自然につながる一言で締めます（番組全体の終了の挨拶はしない）。
- 一人語りですが、リスナーへの問いかけや独り言、小ボケを交えてテンポよく、退屈させないようにしてください。
- 1セグメントは1〜3文程度にしてください。
- 応答はJSONオブジェクトのみを返してください。Markdownや説明文は不要です。
- JSON形式は {"segments":[{"speaker":"ずんだもん","text":"...","emotion":"happy"}]} です。
- speaker は必ず "ずんだもん" です。
- emotion は "happy", "calm", "excited", "sad" のいずれかです。

届いたお便り:
${lettersText}
`;

    const systemInstruction = breaking ? bulletinInstruction : regularInstruction;
    const prompt = breaking
      ? "このニュースを検索で確認し、ラジオのニュース速報台本（2〜4セグメント）をJSONで作ってください。"
      : "最新のテクノロジーニュースを検索して取り入れつつ、お便りにも答える面白いラジオ台本（4〜8セグメント）を作ってください。お便りがある場合は必ず冒頭で回答してください。";

    let response: Response | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: prompt }]
            }
          ],
          systemInstruction: {
            parts: [{ text: systemInstruction }]
          },
          tools: [
            {
              googleSearch: {}
            }
          ]
        })
      });

      if (![429, 503].includes(response.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 1200 * (attempt + 1)));
    }

    // On quota pressure: regular corners fall back to a canned script, but a
    // bulletin must never air canned content — return no segments instead so
    // the producer skips this bulletin and the news stays unclaimed.
    const quotaFallback = breaking ? { segments: [] } : { ...FALLBACK_SCRIPT, degraded: true };

    if (!response) {
      return NextResponse.json(quotaFallback);
    }

    if (!response.ok) {
      const errorText = await response.text();
      if ([429, 503].includes(response.status)) {
        return NextResponse.json(quotaFallback);
      }
      return NextResponse.json({ error: `Gemini API Error: ${errorText}` }, { status: response.status });
    }

    const data = await response.json();
    const scriptText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!scriptText) {
      return NextResponse.json({ error: "Failed to parse script from Gemini response" }, { status: 500 });
    }

    const scriptJson = parseGeminiJson(scriptText);
    if (!Array.isArray(scriptJson.segments)) {
      return NextResponse.json({ error: "Gemini response did not include segments" }, { status: 500 });
    }
    // Cap generously: letter answers sit mid-script, so a tight cap would
    // silently drop consumed letters without ever airing them
    scriptJson.segments = scriptJson.segments.slice(0, 8);

    return NextResponse.json(scriptJson);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal Server Error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
