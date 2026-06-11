// Extracts a JSON object from a Gemini text response that may be wrapped in
// Markdown code fences or surrounded by prose.
export function parseGeminiJson(text: string) {
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
