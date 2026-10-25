import { logger } from "./logger";

const PAX_API_BASE = "https://api.paxsenix.org/tools";

export async function solveTurnstile(
  pageUrl: string,
  siteKey: string,
): Promise<string | null> {
  const apiKey = process.env.PAX_API_KEY;

  // ── Env sanity check (masked, printed once per call) ─────────────────
  if (!apiKey) {
    logger.error("PAX_API_KEY not set — captcha solving disabled");
    console.error(
      "❌ [Pax] PAX_API_KEY is MISSING from environment.\n" +
        "   Add it to .env:  PAX_API_KEY=sk-paxsenix-...\n" +
        "   Then restart the process.",
    );
    return null;
  }
  const masked =
    apiKey.length > 12
      ? `${apiKey.slice(0, 10)}…${apiKey.slice(-4)} (len=${apiKey.length})`
      : "(too short — suspicious)";
  console.error(`🔑 [Pax] Using key: ${masked}`);

  for (let attempt = 1; attempt <= 5; attempt++) {
    const url =
      `${PAX_API_BASE}/cf-turnstile-solver` +
      `?url=${encodeURIComponent(pageUrl)}` +
      `&sitekey=${encodeURIComponent(siteKey)}`;
    const started = Date.now();

    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(45_000), // was 25s — give it headroom
      });

      const raw = await res.text();
      const elapsed = Date.now() - started;

      // Always log status + body snippet so we never fail silently again
      logger.info(
        { attempt, status: res.status, elapsed, body: raw.slice(0, 400) },
        "Paxsenix solve attempt",
      );

      let data: {
        ok?: boolean;
        solution_token?: string;
        message?: string;
        error?: string;
      } = {};
      try {
        data = JSON.parse(raw);
      } catch {
        /* non-JSON — will be reported below */
      }

      if (!res.ok) {
        // 401 / 403 / 429 / 5xx — print the raw body so you see the message
        console.error(
          `❌ [Pax] attempt ${attempt}: HTTP ${res.status} (${elapsed}ms)\n` +
            `   body: ${raw.slice(0, 300)}`,
        );
      } else if (data.ok && data.solution_token) {
        console.error(
          `✅ [Pax] attempt ${attempt}: token received ` +
            `(${data.solution_token.length} chars, ${elapsed}ms)`,
        );
        return data.solution_token;
      } else {
        // HTTP 200 but no token — quota / rate-limit / invalid sitekey etc.
        console.error(
          `⚠️  [Pax] attempt ${attempt}: HTTP 200 but no token (${elapsed}ms)\n` +
            `   ok=${data.ok}  message=${data.message ?? "(none)"}\n` +
            `   body: ${raw.slice(0, 300)}`,
        );
      }
    } catch (err) {
      const elapsed = Date.now() - started;
      logger.warn({ err, attempt, elapsed }, "captcha solve attempt threw");
      console.error(
        `💥 [Pax] attempt ${attempt}: ${(err as Error).message ?? String(err)} ` +
          `(${elapsed}ms)`,
      );
    }

    if (attempt < 5) await new Promise((r) => setTimeout(r, 3_000));
  }

  console.error("❌ [Pax] All 5 attempts failed — returning null");
  return null;
}