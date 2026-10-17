import { GoogleGenAI } from "@google/genai";
import { logger } from "./logger";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let aiClient: any = null;

function getClient() {
  if (aiClient) return aiClient;
  const baseUrl = process.env["AI_INTEGRATIONS_GEMINI_BASE_URL"];
  const apiKey = process.env["AI_INTEGRATIONS_GEMINI_API_KEY"];
  if (!baseUrl || !apiKey) {
    logger.warn("Gemini env vars missing — image captcha OCR disabled");
    return null;
  }
  aiClient = new GoogleGenAI({
    apiKey,
    httpOptions: { apiVersion: "", baseUrl },
  });
  return aiClient;
}

/**
 * OCR the katabump post-OTP "Security check" image captcha.
 * Takes a PNG buffer of the captcha image element and returns the read code.
 * Gemini 2.5-flash reads these distorted text captchas reliably; OpenAI refuses.
 */
export async function ocrCaptcha(pngBuffer: Buffer): Promise<string | null> {
  const ai = getClient();
  if (!ai) return null;
  try {
    const b64 = pngBuffer.toString("base64");
    const resp = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        {
          role: "user",
          parts: [
            {
              text: "Transcribe the exact characters shown in this stylized decorative text image. It is a short security code of 4-8 letters and digits. Output ONLY the characters, uppercase, with no spaces, punctuation, or extra words.",
            },
            { inlineData: { mimeType: "image/png", data: b64 } },
          ],
        },
      ],
    });
    const raw: string = resp.text ?? "";
    const cleaned = raw.trim().replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    return cleaned || null;
  } catch (err) {
    logger.warn({ err }, "captcha OCR failed");
    return null;
  }
}
