import { NextResponse } from "next/server";

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
- 応答は必ず指定のJSONスキーマに従ってください。スピーカー名は "Aoede" または "Charon" のみです。感情（emotion）も適切に割り当ててください。

届いたお便り:
${lettersText}
`;

    const prompt = "最新のテクノロジーニュースを検索して取り入れつつ、お便りにも答える面白いラジオ台本（5〜10往復程度のセグメント）を作ってください。";

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
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
        ],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              segments: {
                type: "ARRAY",
                items: {
                  type: "OBJECT",
                  properties: {
                    speaker: { type: "STRING", enum: ["Aoede", "Charon"] },
                    text: { type: "STRING" },
                    emotion: { type: "STRING", enum: ["happy", "calm", "excited", "sad"] }
                  },
                  required: ["speaker", "text", "emotion"]
                }
              }
            },
            required: ["segments"]
          }
        }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      return NextResponse.json({ error: `Gemini API Error: ${errorText}` }, { status: response.status });
    }

    const data = await response.json();
    const scriptText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!scriptText) {
      return NextResponse.json({ error: "Failed to parse script from Gemini response" }, { status: 500 });
    }

    const scriptJson = JSON.parse(scriptText);
    return NextResponse.json(scriptJson);
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Internal Server Error" }, { status: 500 });
  }
}
