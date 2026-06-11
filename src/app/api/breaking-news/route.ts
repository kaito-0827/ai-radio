import { NextResponse } from "next/server";
import { parseGeminiJson } from "@/lib/parseGeminiJson";

const NO_NEWS = { hasBreaking: false };

export async function POST(req: Request) {
  try {
    const { seenHeadlines } = (await req.json()) as { seenHeadlines?: string[] };
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "GEMINI_API_KEY is not configured" }, { status: 500 });
    }

    const seenList =
      seenHeadlines && seenHeadlines.length > 0
        ? seenHeadlines.map((h) => `- ${h}`).join("\n")
        : "（まだありません）";

    const systemInstruction = `
あなたはラジオ局の報道デスクで、AI業界の重大ニュースを監視しています。
Google Searchを使って、過去6時間以内に発生したAI関連の重大ニュースがあるか調べてください。

「重大ニュース」の基準（通常放送を中断して速報する価値があるもののみ）:
- 主要AI企業（OpenAI、Google、Anthropic、Meta、xAIなど）の新モデル・新製品の正式発表
- Google I/O、OpenAI DevDayのような大型発表会の開催と主要発表内容
- 業界を大きく揺るがす買収・提携・規制決定

対象外（hasBreaking: false にする）:
- マイナーアップデート、噂・リーク、解説記事・考察、過去ニュースの再報道
- 確信が持てない情報

既に速報済みのニュース（これらと同じ内容は絶対に再報道しない）:
${seenList}

応答はJSONオブジェクトのみを返してください。形式:
{"hasBreaking": true または false, "id": "英小文字とハイフンのみの短いスラッグ", "headline": "見出し（日本語）", "summary": "200字以内の要約（日本語）"}
hasBreaking が false の場合、他のフィールドは省略可です。
`;

    const prompt =
      "今、通常放送を中断して伝えるべきAI業界の重大ニュースはありますか？検索して最重要の1件だけをJSONで返してください。";

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          systemInstruction: { parts: [{ text: systemInstruction }] },
          tools: [{ googleSearch: {} }],
        }),
      }
    );

    if (!response.ok) {
      // Quota pressure or transient errors: report "no news" so the radio
      // keeps running; the producer checks again on the next cycle
      if ([429, 500, 503].includes(response.status)) {
        return NextResponse.json(NO_NEWS);
      }
      const errorText = await response.text();
      return NextResponse.json({ error: `Gemini API Error: ${errorText}` }, { status: response.status });
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      return NextResponse.json(NO_NEWS);
    }

    const news = parseGeminiJson(text);
    if (!news.hasBreaking || typeof news.id !== "string" || typeof news.headline !== "string") {
      return NextResponse.json(NO_NEWS);
    }

    return NextResponse.json({
      hasBreaking: true,
      id: news.id,
      headline: news.headline,
      summary: typeof news.summary === "string" ? news.summary : news.headline,
    });
  } catch (error) {
    console.error("breaking-news check failed:", error);
    // Never break the broadcast over a failed news check
    return NextResponse.json(NO_NEWS);
  }
}
