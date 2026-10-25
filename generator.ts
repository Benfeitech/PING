import { createTempEmail, getOTPFromMailTm, type TmailResult } from "./tmail";
import { solveTurnstile } from "./captcha";
import { ocrCaptcha } from "./captcha-ocr";
import { logger } from "./logger";

const REG_URL = "https://dashboard.katabump.com/auth/register";
const SITE_KEY = "0x4AAAAAAA1IssKDXD0TRMjP";
const MAX_CONCURRENT_BROWSERS = 1;
const OTP_CHECKS = 40;              // was 20 — 40 × 3s = 120s, covers slow delivery
const OTP_POLL_INTERVAL_MS = 3_000;

// ─── Proxy pool ─────────────────────────────────────────────────────────────
interface ProxyConfig {
  label: string;
  server: string;
  username: string;
  password: string;
}

const PROXY_SERVER = "http://dc.oxylabs.io:8000";
const PROXIES: ProxyConfig[] = [
  { label: "oxylabs-1", server: PROXY_SERVER, username: "user-gsigis53875_oGmVP-country-US", password: "I624pa5U1VP_RIOY" },
  { label: "oxylabs-2", server: PROXY_SERVER, username: "user-benfeiproxy1_N3Vvw-country-US", password: "Gdiyavaksg2usgshsi+" },
  { label: "oxylabs-3", server: PROXY_SERVER, username: "user-benfeiproxy2_GR3FX-country-US", password: "Oshhsuhe+7377gdid" },
  { label: "oxylabs-4", server: PROXY_SERVER, username: "user-benfeiproxy3_EL6lL-country-US", password: "Gsiyg+36uhdisuvs" },
  { label: "oxylabs-5", server: PROXY_SERVER, username: "user-benfeiproxy4_RoMBf-country-US", password: "hsoygssoyg+36gGs" },
];

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

export function stopJob(jobId: string): boolean {
  const job = jobs.get(jobId);
  if (!job) return false;
  if (job.status === "running" || job.status === "pending") {
    job.cancelRequested = true;
    appendLog(job, "🛑 Stop requested — finishing current step and halting...");
  }
  return true;
}

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
 * as the form submission.
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
    const emailDomain = email.split("@")[1] ?? "unknown";
    appendLog(job, `[${index}/${total}] 📧 ${email}`);
    appendLog(job, `[${index}/${total}] 🌍 Proxy: ${proxy.label}`);
    appendLog(job, `[${index}/${total}] 📮 Email domain: ${emailDomain}`);

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
      // ─── Referral code resolution ───────────────────────────────────────
      let refCode = "";
      try {
        const u = new URL(refUrl);
        refCode = u.pathname.split("/").filter(Boolean).pop() ?? "";
      } catch { /* fall through to hash detection */ }

      if (!refCode) {
        appendLog(job, `[${index}/${total}] 🔗 Visiting referral link...`);
        try {
          await page.goto(refUrl, { timeout: 40_000, waitUntil: "domcontentloaded" });
          await new Promise((r) => setTimeout(r, 1_000));
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const hash: string = await page.evaluate(() => (globalThis as any).location?.hash ?? "");
          if (hash && hash.length > 1) refCode = hash.slice(1);
        } catch { /* referral URL errors are ok */ }
      }
      appendLog(job, `[${index}/${total}] 🎫 Referral code: ${refCode || "(none)"}`);

      appendLog(job, `[${index}/${total}] 🌐 Loading registration page...`);
      await page.goto(`${REG_URL}${refCode ? "#" + refCode : ""}`, {
        timeout: 40_000,
        waitUntil: "domcontentloaded",
      });
      await new Promise((r) => setTimeout(r, 600));

      // ─── Referral cookie check ──────────────────────────────────────────
      try {
        const cookies = await page.context().cookies();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const refCookie = cookies.find((c: any) => c.name === "referral");
        appendLog(job, `[${index}/${total}] 🍪 Referral cookie: ${refCookie ? refCookie.value : "NOT SET ⚠️"}`);
        if (!refCookie && refCode) {
          await page.context().addCookies([{
            name: "referral",
            value: refCode,
            domain: "dashboard.katabump.com",
            path: "/",
          }]);
          appendLog(job, `[${index}/${total}] 🍪 Referral cookie force-set to ${refCode}`);
        }
      } catch { /* cookie inspection is best-effort */ }

      // ─── Fill form ──────────────────────────────────────────────────────
      await page.fill('input[name="firstname"]', name.first);
      await page.fill('input[name="lastname"]', name.last);
      await page.fill('input[name="email"]', email);
      await page.fill('input[name="password"]', password);
      try { await page.click('input[type="checkbox"]'); } catch { /* may not exist */ }

      // ─── Turnstile: native-solve-first, external fallback ───────────────
      appendLog(job, `[${index}/${total}] 🧩 Waiting for native Turnstile solve...`);
      let token = await waitForNativeTurnstile(page, 30_000);

      if (token) {
        appendLog(job, `[${index}/${total}] ✅ Turnstile solved natively (${token.length} chars)`);
      } else {
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

      await new Promise((r) => setTimeout(r, 500));

      // ─── Submit + capture response ──────────────────────────────────────
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
          submitBodySnippet = "(could not read body — likely a redirect)";
        }
        appendLog(job, `[${index}/${total}] 📡 Submit response: ${submitStatus} — ${submitBodySnippet}`);
      } catch (e) {
        appendLog(job, `[${index}/${total}] ⚠️ Submit response not captured: ${String(e).slice(0, 80)}`);
        try { await page.click('button[type="submit"]'); } catch { /* ignore */ }
      }

      // Give the browser a moment to follow any 302 redirects
      await new Promise((r) => setTimeout(r, 1_500));

      // ─── OTP diagnostics ────────────────────────────────────────────────
      const finalUrl = page.url();
      appendLog(job, `[${index}/${total}] 🧭 Final URL after submit: ${finalUrl}`);

      const otpInputCount = await page.locator('input[name="code"]').count().catch(() => 0);
      const stillOnRegister = finalUrl.includes("/auth/register");
      const errorTextOnPage = await page
        .locator(".error, .alert, [role='alert'], .text-red-500, .text-danger")
        .first()
        .textContent({ timeout: 500 })
        .catch(() => "");

      appendLog(job, `[${index}/${total}] 🔎 OTP input present: ${otpInputCount > 0 ? "YES" : "NO"}`);
      if (errorTextOnPage && errorTextOnPage.trim()) {
        appendLog(job, `[${index}/${total}] 🚨 Page error text: ${errorTextOnPage.trim().slice(0, 200)}`);
      }

      // If we bounced back to /auth/register, the form was rejected — no OTP was sent
      if (stillOnRegister && otpInputCount === 0) {
        appendLog(
          job,
          `[${index}/${total}] ❌ Form rejected — still on /auth/register. ` +
            `Likely causes: disposable domain (${emailDomain}) blocked, or Turnstile token rejected.`,
        );
        await browser.close();
        return null;
      }

      // ─── Wait for OTP input ─────────────────────────────────────────────
      appendLog(job, `[${index}/${total}] 📩 Waiting for OTP form...`);
      try {
        await page.waitForSelector('input[name="code"]', { timeout: 20_000 });
      } catch {
        appendLog(
          job,
          `[${index}/${total}] ❌ OTP form not found (submit=${submitStatus}, url=${finalUrl})`,
        );
        await browser.close();
        return null;
      }

      // ─── Poll mailbox for OTP ───────────────────────────────────────────
      let foundOTP: string | null = null;
      let mailboxEmptyChecks = 0;
      for (let check = 1; check <= OTP_CHECKS; check++) {
        if (job.cancelRequested) { await browser.close(); return null; }
        foundOTP = await getOTPFromMailTm(mailToken, email);
        if (foundOTP) {
          appendLog(job, `[${index}/${total}] 🔑 OTP: ${foundOTP}`);
          break;
        }
        mailboxEmptyChecks++;
        // Log every 5th check to reduce noise
        if (check === 1 || check % 5 === 0 || check === OTP_CHECKS) {
          appendLog(job, `[${index}/${total}] ⏳ OTP check ${check}/${OTP_CHECKS}...`);
        }
        await new Promise((r) => setTimeout(r, OTP_POLL_INTERVAL_MS));
      }

      if (!foundOTP) {
        appendLog(
          job,
          `[${index}/${total}] ❌ OTP timed out after ${OTP_CHECKS * (OTP_POLL_INTERVAL_MS / 1000)}s. ` +
            `If the OTP page rendered correctly, the email likely never arrived — ` +
            `domain "${emailDomain}" may be silently dropped by Katabump's mailer. ` +
            `Try a different temp-mail provider (mail.gw, custom-domain catch-all).`,
        );
        await browser.close();
        return null;
      }

      // ─── Enter OTP ──────────────────────────────────────────────────────
      await page.fill('input[name="code"]', foundOTP);
      await page.click('button[type="submit"]');
      await new Promise((r) => setTimeout(r, 2_000));

      // ─── Post-OTP security captcha (image OCR) ──────────────────────────
      let securityCheck = false;
      try {
        await page.waitForSelector("#captcha_code", { timeout: 20_000 });
        securityCheck = true;
      } catch { /* no security check — older flow */ }

      if (securityCheck) {
        appendLog(job, `[${index}/${total}] 🛡️ Solving security check...`);
        let passed = false;
        const MAX_SEC_ATTEMPTS = 8;
        for (let attempt = 1; attempt <= MAX_SEC_ATTEMPTS && !passed; attempt++) {
          if (job.cancelRequested) { await browser.close(); return null; }

          try {
            await page.waitForSelector("#captcha-image", { timeout: 8_000 });
          } catch {
            appendLog(job, `[${index}/${total}] ⏳ Captcha image missing (try ${attempt}), regenerating...`);
            await page.click("#refresh-captcha").catch(() => {});
            await new Promise((r) => setTimeout(r, 800));
            continue;
          }

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
            } catch { return null; }
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

          const passedNow = await page
            .waitForSelector("#captcha_code", { state: "detached", timeout: 3_000 })
            .then(() => true)
            .catch(() => false);
          if (passedNow) { passed = true; break; }

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