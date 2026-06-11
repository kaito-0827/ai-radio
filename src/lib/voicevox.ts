// Server-side VOICEVOX synthesis helper (Zundamon voice).
//
// Produces raw PCM16 mono @24kHz base64 — the same wire format as the Gemini
// TTS path — so the client playback pipeline needs no changes. Used by the
// /api/radio-tts route when VOICEVOX_URL is configured (typically pointing at
// the VPS-hosted engine); the VPS worker has its own copy talking to
// localhost.

// VOICEVOX style IDs for ずんだもん
const ZUNDAMON_STYLE_BY_EMOTION: Record<string, number> = {
  happy: 1, // あまあま
  calm: 3, // ノーマル
  excited: 7, // ツンツン
  sad: 22, // ささやき
};

export function zundamonStyleId(emotion?: string): number {
  return ZUNDAMON_STYLE_BY_EMOTION[emotion ?? "calm"] ?? 3;
}

// Extracts the PCM payload from a RIFF/WAV container as base64
export function wavToPcmBase64(wav: Buffer): string {
  if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error("VOICEVOX response is not a RIFF/WAV file");
  }
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const chunkId = wav.toString("ascii", offset, offset + 4);
    const chunkSize = wav.readUInt32LE(offset + 4);
    if (chunkId === "data") {
      return wav.subarray(offset + 8, offset + 8 + chunkSize).toString("base64");
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  throw new Error("WAV data chunk not found in VOICEVOX response");
}

export async function synthesizeWithVoicevox(
  baseUrl: string,
  token: string | undefined,
  text: string,
  emotion?: string
): Promise<string> {
  const styleId = zundamonStyleId(emotion);
  const authHeaders: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

  const queryRes = await fetch(
    `${baseUrl}/audio_query?speaker=${styleId}&text=${encodeURIComponent(text)}`,
    { method: "POST", headers: authHeaders }
  );
  if (!queryRes.ok) {
    throw new Error(`VOICEVOX audio_query failed: ${queryRes.status}`);
  }

  const audioQuery = await queryRes.json();
  // Match the broadcast pipeline's PCM format (mono 24kHz)
  audioQuery.outputSamplingRate = 24000;
  audioQuery.outputStereo = false;

  const synthesisRes = await fetch(`${baseUrl}/synthesis?speaker=${styleId}`, {
    method: "POST",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify(audioQuery),
  });
  if (!synthesisRes.ok) {
    throw new Error(`VOICEVOX synthesis failed: ${synthesisRes.status}`);
  }

  const wav = Buffer.from(await synthesisRes.arrayBuffer());
  return wavToPcmBase64(wav);
}
