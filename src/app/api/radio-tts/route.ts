import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const { text, speaker } = await req.json();
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "GEMINI_API_KEY is not configured" }, { status: 500 });
    }

    if (!text || !speaker) {
      return NextResponse.json({ error: "Missing text or speaker" }, { status: 400 });
    }

    // Aoede (Female), Charon (Male)
    const voiceName = speaker === "Aoede" ? "Aoede" : "Charon";

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-tts-preview:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: `Say in Japanese with a natural radio host delivery: ${text}` }]
          }
        ],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: voiceName
              }
            }
          }
        }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      return NextResponse.json({ error: `Gemini API Error: ${errorText}` }, { status: response.status });
    }

    const data = await response.json();
    const inlineData = data.candidates?.[0]?.content?.parts?.[0]?.inlineData;
    if (!inlineData || !inlineData.data) {
      return NextResponse.json({ error: "Failed to generate audio from Gemini response. Check model capabilities or request parameters." }, { status: 500 });
    }

    return NextResponse.json({
      audioContent: inlineData.data,
      mimeType: inlineData.mimeType || "audio/pcm;rate=24000"
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Internal Server Error" }, { status: 500 });
  }
}
