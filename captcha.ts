import { logger } from "./logger";

const PAX_API_BASE = "https://api.paxsenix.org/tools";

export async function solveTurnstile(
  pageUrl: string,
  siteKey: string,
): Promise<string | null> {
  const apiKey = process.env.PAX_API_KEY;
  if (!apiKey) {
    logger.warn("PAX_API_KEY not set — captcha solving disabled");
    return null;
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(
        `${PAX_API_BASE}/cf-turnstile-solver?url=${encodeURIComponent(pageUrl)}&sitekey=${encodeURIComponent(siteKey)}`,
        {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(25_000),
        },
      );
      const data = (await res.json()) as { ok?: boolean; solution_token?: string };
      if (data.ok && data.solution_token) {
        return data.solution_token;
      }
    } catch (err) {
      logger.warn({ err, attempt }, "captcha solve attempt failed");
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }

  return null;
}
