import { NextResponse } from "next/server";
import { synthesizeWithVoicevox } from "@/lib/voicevox";

const sampleRate = 24000;

function silentPcmBase64(seconds: number = 1) {
  return Buffer.alloc(sampleRate * seconds * 2).toString("base64");
}

export async function POST(req: Request) {
  try {
    const { text, emotion } = (await req.json()) as {
      text?: string;
      speaker?: string;
      emotion?: string;
    };

    if (!text) {
      return NextResponse.json({ error: "Missing text" }, { status: 400 });
    }

    // 1. Preferred: VOICEVOX (Zundamon) hosted on the VPS
    const voicevoxUrl = process.env.VOICEVOX_URL;
    if (voicevoxUrl) {
      try {
        const audioContent = await synthesizeWithVoicevox(
          voicevoxUrl,
          process.env.VOICEVOX_TOKEN,
          text,
          emotion
        );
        return NextResponse.json({
          audioContent,
          mimeType: "audio/pcm;rate=24000",
          voice: "zundamon",
        });
      } catch (voicevoxErr) {
        console.error("VOICEVOX synthesis failed; falling back to Gemini TTS:", voicevoxErr);
      }
    }

    // 2. Fallback: Gemini TTS (voice will differ from Zundamon, but the
    // broadcast keeps talking)
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "No TTS backend configured" }, { status: 500 });
    }

    const requestAudio = () =>
      fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-tts-preview:generateContent?key=${apiKey}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: `Say in Japanese with a cheerful, cute radio host delivery: ${text}` }]
            }
          ],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: "Aoede"
                }
              }
            }
          }
        })
      });

    let response = await requestAudio();
    if (response.status === 503) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      response = await requestAudio();
    }

    if (!response.ok) {
      const errorText = await response.text();
      if ([429, 503].includes(response.status)) {
        // Size the silence to natural reading time so the broadcast keeps a
        // human pace under quota pressure: subtitles stay readable and the
        // producer doesn't churn out corners every few seconds
        const readingSeconds = Math.min(15, Math.max(3, Math.round(String(text).length * 0.15)));
        return NextResponse.json({
          audioContent: silentPcmBase64(readingSeconds),
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
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal Server Error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
