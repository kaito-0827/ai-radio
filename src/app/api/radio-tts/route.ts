import { NextResponse } from "next/server";

const sampleRate = 24000;

function silentPcmBase64(seconds: number = 1) {
  return Buffer.alloc(sampleRate * seconds * 2).toString("base64");
}

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

    let response: Response | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-tts-preview:generateContent?key=${apiKey}`, {
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

      if (![429, 503].includes(response.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
    }

    if (!response) {
      return NextResponse.json({
        audioContent: silentPcmBase64(),
        mimeType: "audio/pcm;rate=24000",
        degraded: true,
      });
    }

    if (!response.ok) {
      const errorText = await response.text();
      if ([429, 503].includes(response.status)) {
        return NextResponse.json({
          audioContent: silentPcmBase64(),
          mimeType: "audio/pcm;rate=24000",
          degraded: true,
        });
      }
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
