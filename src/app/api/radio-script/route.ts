import { NextResponse } from "next/server";

const FALLBACK_SCRIPT = {
  segments: [
    {
      speaker: "Aoede",
      text: "リスナーの皆さん、えーあいらじおをお聞きいただきありがとうございます！ただいま最新ニュースの取得が混み合っています。",
      emotion: "happy",
    },
    {
      speaker: "Charon",
      text: "高需要のため、AIニュース生成を少し待っています。復旧まで、短いフリートークをお届けします。",
      emotion: "calm",
    },
    {
      speaker: "Aoede",
      text: "こういう時こそ、のんびり深呼吸ですね。お便りも引き続き募集しています！",
      emotion: "excited",
    },
    {
      speaker: "Charon",
      text: "次のコーナーで改めて最新情報を取りに行きます。それまでBGMと一緒にお楽しみください。",
      emotion: "calm",
    },
  ],
};

function parseScriptJson(text: string) {
  const trimmed = text.trim();
  const fencedJson = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fencedJson?.[1] ?? trimmed;
  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");

  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error("Gemini response did not contain a JSON object");
  }

  return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
}

export async function POST(req: Request) {
  try {
    const { letters } = await req.json();
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "GEMINI_API_KEY is not configured" }, { status: 500 });
    }

    // Format letters
    const lettersText = letters && letters.length > 0 
      ? letters.map((l: any) => `[差出人: ${l.sender}] ${l.content}`).join("\n")
      : "本日のお便りはまだ届いていません。";

    const systemInstruction = `
あなたはラジオ番組「えーあいらじお（AI Radio）」の構成作家およびパーソナリティです。
最新の時事ニュース（IT、テクノロジー、カルチャー、トレンドなど）をWeb検索して1〜2個ピックアップし、さらにリスナーから届いたお便りを紹介する、テンポの良いラジオの対話台本を生成してください。

登場人物：
1. Aoede (アオイデ - 女性パーソナリティ): 明るく知性的、お便りを読むのが得意、少しお茶目な面もある。声質は女性。
2. Charon (カロン - 男性パーソナリティ): 落ち着いたトーン、技術的な解説が得意、Aoedeのボケに冷静にツッコミを入れる。声質は男性。

台本の構成ルール：
- 最初は短いオープニングトークから入り、最新ニュースを1つか2つ紹介し、解説や議論を行います。
- その後、届いたお便り（以下に記載）を最低1つ読み上げ、それに対して二人が感想やアドバイスを語り合います。
- 最後にエンディングトークで締めます。
- 対話は自然で、相槌や軽い雑談を交え、リスナーを退屈させないようにしてください。
- 応答はJSONオブジェクトのみを返してください。Markdownや説明文は不要です。
- JSON形式は {"segments":[{"speaker":"Aoede","text":"...","emotion":"happy"}]} です。
- speaker は "Aoede" または "Charon" のみです。
- emotion は "happy", "calm", "excited", "sad" のいずれかです。

届いたお便り:
${lettersText}
`;

    const prompt = "最新のテクノロジーニュースを検索して取り入れつつ、お便りにも答える面白いラジオ台本（4セグメント程度）を作ってください。";

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

    if (!response) {
      return NextResponse.json(FALLBACK_SCRIPT);
    }

    if (!response.ok) {
      const errorText = await response.text();
      if ([429, 503].includes(response.status)) {
        return NextResponse.json(FALLBACK_SCRIPT);
      }
      return NextResponse.json({ error: `Gemini API Error: ${errorText}` }, { status: response.status });
    }

    const data = await response.json();
    const scriptText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!scriptText) {
      return NextResponse.json({ error: "Failed to parse script from Gemini response" }, { status: 500 });
    }

    const scriptJson = parseScriptJson(scriptText);
    if (!Array.isArray(scriptJson.segments)) {
      return NextResponse.json({ error: "Gemini response did not include segments" }, { status: 500 });
    }
    scriptJson.segments = scriptJson.segments.slice(0, 4);

    return NextResponse.json(scriptJson);
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Internal Server Error" }, { status: 500 });
  }
}
