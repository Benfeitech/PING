import { createTempEmail, getOTPFromMailTm, type TmailResult } from "./tmail";
import { solveTurnstile } from "./captcha";
import { ocrCaptcha } from "./captcha-ocr";
import { logger } from "./logger";

const REG_URL = "https://dashboard.katabump.com/auth/register";
const SITE_KEY = "0x4AAAAAAA1IssKDXD0TRMjP";
const MAX_CONCURRENT_BROWSERS = 1;

// ─── Proxy pool ─────────────────────────────────────────────────────────────
// Every account-creation flow picks ONE random proxy from this pool and runs
// the whole browser session through it, so all Katabump requests (page loads,
// Turnstile, OTP, security-check captcha, form submit) originate from a
// randomized IP. Retries in runJob() call createOneAccount() again, so each
// retry naturally gets a fresh random IP as well.
interface ProxyConfig {
  label: string;
  server: string;
  username: string;
  password: string;
}

const PROXY_SERVER = "http://dc.oxylabs.io:8000";
const PROXIES: ProxyConfig[] = [
  {
    label: "oxylabs-1",
    server: PROXY_SERVER,
    username: "user-gsigis53875_oGmVP-country-US",
    password: "I624pa5U1VP_RIOY",
  },
  {
    label: "oxylabs-2",
    server: PROXY_SERVER,
    username: "user-benfeiproxy1_N3Vvw-country-US",
    password: "Gdiyavaksg2usgshsi+",
  },
  {
    label: "oxylabs-3",
    server: PROXY_SERVER,
    username: "user-benfeiproxy2_GR3FX-country-US",
    password: "Oshhsuhe+7377gdid",
  },
  {
    label: "oxylabs-4",
    server: PROXY_SERVER,
    username: "user-benfeiproxy3_EL6lL-country-US",
    password: "Gsiyg+36uhdisuvs",
  },
  {
    label: "oxylabs-5",
    server: PROXY_SERVER,
    username: "user-benfeiproxy4_RoMBf-country-US",
    password: "hsoygssoyg+36gGs",
  },
];

/** Pick a random proxy from the pool for one account-creation flow. */
function pickProxy(): ProxyConfig {
  return PROXIES[Math.floor(Math.random() * PROXIES.length)];
}

let activeBrowsers = 0;

export interface Job {
  id: string;
  status: "pending" | "running" | "completed" | "failed" | "stopped";
  refUrl: string;
  count: number;
  successCount: number;
  failCount: number;
  logs: string[];
  accounts: { email: string; password: string }[];
  createdAt: string;
  cancelRequested?: boolean;
}

/** Request graceful cancellation of a running job. Returns false if not found. */
export function stopJob(jobId: string): boolean {
  const job = jobs.get(jobId);
  if (!job) return false;
  if (job.status === "running" || job.status === "pending") {
    job.cancelRequested = true;
    appendLog(job, "🛑 Stop requested — finishing current step and halting...");
  }
  return true;
}

// In-memory job store — ephemeral, no DB needed
export const jobs = new Map<string, Job>();

function genPassword(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 12 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

function appendLog(job: Job, line: string): void {
  job.logs.push(line);
}

/**
 * Wait up to `timeoutMs` for Cloudflare's Turnstile widget to solve natively.
 * Native solve is best because the token is bound to the SAME IP / UA / session
 * as the form submission. Returns the token, or null if the widget never filled
 * the hidden field in time.
 */
async function waitForNativeTurnstile(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page: any,
  timeoutMs: number,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const token = await page.evaluate(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const doc = (globalThis as any).document;
        // Turnstile injects the token into a hidden input with this exact name
        const el = doc?.querySelector('input[name="cf-turnstile-response"]');
        if (!el) return null;
        const val = (el as HTMLInputElement).value;
        return typeof val === "string" && val.length > 20 ? val : null;
      });
      if (token) return token as string;
    } catch {
      // page may be navigating — just retry
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

/**
 * Inject a token obtained externally (Paxsenix) into the Turnstile hidden field
 * and fire the input/change events the site's JS listens for, so the form sees
 * a "solved" widget.
 */
async function injectToken(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page: any,
  token: string,
): Promise<void> {
  await page.evaluate((t: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doc = (globalThis as any).document;
    const el = doc?.querySelector('input[name="cf-turnstile-response"]');
    if (el) {
      (el as HTMLInputElement).value = t;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }, token);
}

async function createOneAccount(
  job: Job,
  index: number,
  total: number,
  refUrl: string,
): Promise<{ email: string; password: string } | null> {
  appendLog(job, `[${index}/${total}] Starting...`);

  let queuedLogged = false;
  while (activeBrowsers >= MAX_CONCURRENT_BROWSERS) {
    if (job.cancelRequested) return null;
    if (!queuedLogged) {
      appendLog(job, `[${index}/${total}] Queued — waiting for a free worker...`);
      queuedLogged = true;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  if (job.cancelRequested) return null;
  activeBrowsers++;

  // Pick a random proxy for THIS account-creation flow only.
  const proxy = pickProxy();

  try {
    appendLog(job, `[${index}/${total}] Creating temp email...`);
    const mailResult = await createTempEmail();
    if (!mailResult) {
      appendLog(job, `[${index}/${total}] ❌ Email creation failed`);
      return null;
    }

    const { email, token: mailToken, name } = mailResult;
    const password = genPassword();
    appendLog(job, `[${index}/${total}] 📧 ${email}`);
    appendLog(job, `[${index}/${total}] 🌍 Proxy: ${proxy.label}`);

    // Use playwright-extra + stealth to bypass Cloudflare bot detection
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let chromiumExtra: any;
    try {
      const pwExtra = await import("playwright-extra");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stealthMod = await import("puppeteer-extra-plugin-stealth") as any;
      const stealth = stealthMod.default ?? stealthMod;
      pwExtra.chromium.use(stealth());
      chromiumExtra = pwExtra.chromium;
    } catch (e) {
      appendLog(job, `[${index}/${total}] ❌ playwright-extra not available: ${String(e).slice(0,80)}`);
      return null;
    }

    const browser = await chromiumExtra.launch({
      headless: true,
      // Route the entire browser session through the randomly-picked proxy.
      proxy: {
        server: proxy.server,
        username: proxy.username,
        password: proxy.password,
      },
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });
    const page = await browser.newPage();

    try {
      // Determine the referral code. The ref link (e.g. rl.katabump.fr/ae49f4)
      // redirects to dashboard.katabump.com/auth/login#<code>. The site JS reads
      // location.hash and stores it as a `referral` cookie. We must load the
      // register page WITH that hash so the cookie is set before we submit.
      let refCode = "";
      try {
        const u = new URL(refUrl);
        refCode = u.pathname.split("/").filter(Boolean).pop() ?? "";
      } catch {
        // fall back to hash detection below
      }

      // Only pre-visit the referral link if we couldn't get the code from the
      // URL path (the pre-visit is a whole extra navigation). Normally the path
      // already gives us the code, so we skip straight to the register page.
      if (!refCode) {
        appendLog(job, `[${index}/${total}] 🔗 Visiting referral link...`);
        try {
          await page.goto(refUrl, { timeout: 40_000, waitUntil: "domcontentloaded" });
          await new Promise((r) => setTimeout(r, 1_000));
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const hash: string = await page.evaluate(() => (globalThis as any).location?.hash ?? "");
          if (hash && hash.length > 1) refCode = hash.slice(1);
        } catch {
          // referral URL errors are ok — we still have refCode from the path
        }
      }
      appendLog(job, `[${index}/${total}] 🎫 Referral code: ${refCode || "(none)"}`);

      // Load the register page WITH the ref hash so its JS sets the referral cookie
      appendLog(job, `[${index}/${total}] 🌐 Loading registration page...`);
      await page.goto(`${REG_URL}${refCode ? "#" + refCode : ""}`, {
        timeout: 40_000,
        waitUntil: "domcontentloaded",
      });
      await new Promise((r) => setTimeout(r, 600));

      // Confirm the referral cookie is set (so the account is actually credited)
      try {
        const cookies = await page.context().cookies();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const refCookie = cookies.find((c: any) => c.name === "referral");
        appendLog(
          job,
          `[${index}/${total}] 🍪 Referral cookie: ${refCookie ? refCookie.value : "NOT SET ⚠️"}`,
        );
        if (!refCookie && refCode) {
          // Force-set it if the site JS did not (belt and suspenders)
          await page.context().addCookies([
            {
              name: "referral",
              value: refCode,
              domain: "dashboard.katabump.com",
              path: "/",
            },
          ]);
          appendLog(job, `[${index}/${total}] 🍪 Referral cookie force-set to ${refCode}`);
        }
      } catch {
        // cookie inspection is best-effort
      }

      await page.fill('input[name="firstname"]', name.first);
      await page.fill('input[name="lastname"]', name.last);
      await page.fill('input[name="email"]', email);
      await page.fill('input[name="password"]', password);
      try {
        await page.click('input[type="checkbox"]');
      } catch {
        // checkbox might not exist
      }

      // ─── Turnstile: native-solve-first, external fallback ────────────────
      appendLog(job, `[${index}/${total}] 🧩 Waiting for native Turnstile solve...`);
      let token = await waitForNativeTurnstile(page, 30_000);

      if (token) {
        appendLog(job, `[${index}/${total}] ✅ Turnstile solved natively (${token.length} chars)`);
      } else {
        // Native solve timed out — the widget didn't auto-complete. Fall back
        // to Paxsenix. This token may be rejected if Cloudflare enforces
        // solver-IP == submit-IP correlation, but it's the only remaining path.
        appendLog(job, `[${index}/${total}] ⏳ Native solve timed out, calling Paxsenix fallback...`);
        token = await solveTurnstile(REG_URL, SITE_KEY);
        if (!token) {
          appendLog(job, `[${index}/${total}] ❌ Captcha solve failed (native + Paxsenix)`);
          await browser.close();
          return null;
        }
        await injectToken(page, token);
        appendLog(job, `[${index}/${total}] ⚠️ Turnstile solved via Paxsenix fallback (${token.length} chars) — may be rejected if IPs mismatch`);
      }
      // ─────────────────────────────────────────────────────────────────────

      await new Promise((r) => setTimeout(r, 500));

      // Click submit AND capture the network response so we log the real
      // reason if Cloudflare rejects the token (invalid-input-response,
      // timeout-or-duplicate, missing-input-response, etc.).
      let submitStatus = 0;
      let submitBodySnippet = "";
      try {
        const [response] = await Promise.all([
          page.waitForResponse(
            (r: any) =>
              typeof r.url === "function" &&
              r.url().includes("/auth/register") &&
              r.request().method() === "POST",
            { timeout: 30_000 },
          ),
          page.click('button[type="submit"]'),
        ]);
        submitStatus = response.status();
        try {
          const text = await response.text();
          submitBodySnippet = text.slice(0, 300).replace(/\s+/g, " ").trim();
        } catch {
          submitBodySnippet = "(could not read body)";
        }
        appendLog(
          job,
          `[${index}/${total}] 📡 Submit response: ${submitStatus} — ${submitBodySnippet}`,
        );
      } catch (e) {
        appendLog(job, `[${index}/${total}] ⚠️ Submit response not captured: ${String(e).slice(0, 80)}`);
        // Fallback: still click (in case waitForResponse raced with click)
        try { await page.click('button[type="submit"]'); } catch { /* ignore */ }
      }

      appendLog(job, `[${index}/${total}] 📩 Waiting for OTP...`);
      try {
        await page.waitForSelector('input[name="code"]', { timeout: 20_000 });
      } catch {
        appendLog(job, `[${index}/${total}] ❌ OTP form not found (submit ${submitStatus})`);
        await browser.close();
        return null;
      }

      let foundOTP: string | null = null;
      for (let check = 1; check <= 20; check++) {
        if (job.cancelRequested) { await browser.close(); return null; }
        foundOTP = await getOTPFromMailTm(mailToken, email);
        if (foundOTP) {
          appendLog(job, `[${index}/${total}] 🔑 OTP: ${foundOTP}`);
          break;
        }
        appendLog(job, `[${index}/${total}] ⏳ OTP check ${check}/20...`);
        await new Promise((r) => setTimeout(r, 3_000));
      }

      if (!foundOTP) {
        appendLog(job, `[${index}/${total}] ❌ OTP timed out`);
        await browser.close();
        return null;
      }

      await page.fill('input[name="code"]', foundOTP);
      await page.click('button[type="submit"]');
      await new Promise((r) => setTimeout(r, 2_000));

      // Post-OTP "Security check": distorted image captcha that must be solved
      // before the account is actually created. Read it with Gemini vision OCR,
      // retrying with a fresh captcha (page reload / Regenerate) on a misread.
      let securityCheck = false;
      try {
        await page.waitForSelector("#captcha_code", { timeout: 20_000 });
        securityCheck = true;
      } catch {
        // No security check — older flow, account already created
      }

      if (securityCheck) {
        appendLog(job, `[${index}/${total}] 🛡️ Solving security check...`);
        let passed = false;
        const MAX_SEC_ATTEMPTS = 8;
        for (let attempt = 1; attempt <= MAX_SEC_ATTEMPTS && !passed; attempt++) {
          if (job.cancelRequested) { await browser.close(); return null; }
          // The page may have reloaded a fresh captcha after a rejection, so
          // wait for the image each loop. If it's missing, regenerate & retry
          // instead of abandoning the whole account.
          try {
            await page.waitForSelector("#captcha-image", { timeout: 8_000 });
          } catch {
            appendLog(job, `[${index}/${total}] ⏳ Captcha image missing (try ${attempt}), regenerating...`);
            await page.click("#refresh-captcha").catch(() => {});
            await new Promise((r) => setTimeout(r, 800));
            continue;
          }

          // Fetch the ACTUAL image bytes from the element's src (via in-page
          // fetch so cookies/session are sent). element.screenshot() returns a
          // blank box on these lazy-loaded captcha images, so OCR always failed.
          const dataUrl: string | null = await page.evaluate(async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const doc = (globalThis as any).document;
            const img = doc?.querySelector("#captcha-image");
            if (!img || !img.src) return null;
            try {
              const resp = await fetch(img.src, { cache: "no-store" });
              const blob = await resp.blob();
              return await new Promise<string>((res, rej) => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const reader = new (globalThis as any).FileReader();
                reader.onloadend = () => res(reader.result);
                reader.onerror = rej;
                reader.readAsDataURL(blob);
              });
            } catch {
              return null;
            }
          });

          const b64 = dataUrl?.split(",")[1];
          const code = b64 ? await ocrCaptcha(Buffer.from(b64, "base64")) : null;

          if (!code) {
            appendLog(job, `[${index}/${total}] ⏳ OCR failed (try ${attempt}), regenerating...`);
            await page.click("#refresh-captcha").catch(() => {});
            await new Promise((r) => setTimeout(r, 700));
            continue;
          }

          appendLog(job, `[${index}/${total}] 🔤 Captcha read: ${code} (try ${attempt})`);
          await page.fill("#captcha_code", "");
          await page.fill("#captcha_code", code);
          await page.click("#captcha-btn");

          // Success = captcha input detaches. Resolves the instant it passes
          // instead of waiting a fixed 4s every time.
          const passedNow = await page
            .waitForSelector("#captcha_code", { state: "detached", timeout: 3_000 })
            .then(() => true)
            .catch(() => false);
          if (passedNow) {
            passed = true;
            break;
          }
          // Rejected — ask for a fresh captcha image before the next attempt.
          appendLog(job, `[${index}/${total}] ↻ Captcha rejected (try ${attempt}), regenerating...`);
          await page.click("#refresh-captcha").catch(() => {});
          await new Promise((r) => setTimeout(r, 600));
        }

        if (!passed) {
          appendLog(job, `[${index}/${total}] ❌ Could not pass security check after ${MAX_SEC_ATTEMPTS} tries`);
          await browser.close();
          return null;
        }
        appendLog(job, `[${index}/${total}] ✅ Security check passed`);
        await new Promise((r) => setTimeout(r, 1_000));
      }

      appendLog(job, `[${index}/${total}] ✅ Done: ${email} / ${password}`);
      await browser.close();
      return { email, password };
    } catch (err) {
      appendLog(job, `[${index}/${total}] ⚠️ Error: ${String(err).slice(0, 120)}`);
      try { await browser.close(); } catch { /* ignore */ }
      return null;
    }
  } finally {
    activeBrowsers--;
  }
}

export async function runJob(job: Job): Promise<void> {
  try {
    job.status = "running";
    appendLog(job, `🚀 Starting ${job.count} account(s) — running one at a time`);

    // Fire all accounts concurrently; the semaphore inside createOneAccount
    // ensures at most MAX_CONCURRENT_BROWSERS browsers run at the same time.
    await Promise.all(
      Array.from({ length: job.count }, (_, idx) => idx + 1).map(async (i) => {
        if (job.cancelRequested) return;

        let result: { email: string; password: string } | null = null;
        let retries = 0;

        while (!result && retries < 3 && !job.cancelRequested) {
          if (retries > 0) appendLog(job, `[${i}/${job.count}] 🔄 Retry #${retries}...`);
          result = await createOneAccount(job, i, job.count, job.refUrl);
          retries++;
          if (!result && retries < 3 && !job.cancelRequested)
            await new Promise((r) => setTimeout(r, 3_000));
        }

        if (result) {
          job.successCount++;
          job.accounts.push(result);
        } else if (!job.cancelRequested) {
          job.failCount++;
          appendLog(job, `[${i}/${job.count}] ❌ Failed after 3 retries`);
        }
      })
    );

    if (job.cancelRequested) {
      appendLog(job, `🛑 Stopped: ${job.successCount} created before stopping`);
      job.status = "stopped";
      return;
    }

    appendLog(job, `🏁 Finished: ${job.successCount}/${job.count} succeeded`);
    job.status = "completed";
  } catch (err) {
    logger.error({ err, jobId: job.id }, "generation job failed");
    appendLog(job, `💥 Crashed: ${String(err).slice(0, 100)}`);
    job.status = "failed";
  }
}

export function startJobAsync(job: Job): void {
  runJob(job).catch((err) => {
    logger.error({ err, jobId: job.id }, "unhandled error in generation job");
  });
}