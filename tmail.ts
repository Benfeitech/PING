import { logger } from "./logger";

const BASE = "https://www.tmail.pk";

export interface TmailResult {
  email: string;
  password: string;
  token: string;
  name: { first: string; last: string };
}

const FIRST_NAMES = [
  "James","John","Robert","Michael","William","David","Richard","Joseph","Thomas","Charles",
  "Christopher","Daniel","Matthew","Anthony","Mark","Ryan","Jacob","Brandon","Benjamin","Samuel",
  "Sohail","Ahmed","Hamza","Zain","Ali","Khan","Umer","Bilal","Marcus","Jason",
];
const LAST_NAMES = [
  "Smith","Johnson","Williams","Brown","Jones","Garcia","Miller","Davis","Rodriguez","Martinez",
  "Hernandez","Lopez","Gonzalez","Wilson","Anderson","Thomas","Taylor","Moore","Jackson","Martin",
  "Patel","Ross","Foster","Jimenez","Lewis","Robinson","Walker","Hall","Allen","Young",
];

function randomChoice<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function getRandomName(): { first: string; last: string } {
  return { first: randomChoice(FIRST_NAMES), last: randomChoice(LAST_NAMES) };
}

async function getAvailableDomains(): Promise<string[]> {
  try {
    const res = await fetch(`${BASE}/api/domains/list`, {
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json()) as Array<{ domain_name: string; is_verified: boolean; admin_approval: string }>;
    return data
      .filter((d) => d.is_verified && d.admin_approval === "approved")
      .map((d) => d.domain_name);
  } catch (err) {
    logger.warn({ err }, "tmail.pk getAvailableDomains failed");
    return [];
  }
}

export async function createTempEmail(): Promise<TmailResult | null> {
  try {
    const domains = await getAvailableDomains();
    if (domains.length === 0) return null;

    const headers = {
      "content-type": "application/json",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    };

    // Phase 1: prepare — returns a capability token
    const prepRes = await fetch(`${BASE}/api/mailbox/generate`, {
      method: "POST",
      headers,
      body: JSON.stringify({ phase: "prepare", domains }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!prepRes.ok) {
      logger.warn(
        { status: prepRes.status, body: await prepRes.text() },
        "tmail.pk generate prepare failed"
      );
      return null;
    }

    const prepData = (await prepRes.json()) as { capability: string; phase: string };
    if (!prepData.capability) {
      logger.warn({ prepData }, "tmail.pk prepare returned no capability");
      return null;
    }

    // Phase 2: commit — uses the capability to actually create the mailbox
    const genRes = await fetch(`${BASE}/api/mailbox/generate`, {
      method: "POST",
      headers,
      body: JSON.stringify({ phase: "commit", capability: prepData.capability }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!genRes.ok) {
      logger.warn(
        { status: genRes.status, body: await genRes.text() },
        "tmail.pk generate commit failed"
      );
      return null;
    }

    const commitData = (await genRes.json()) as {
      status: string;
      email: string;
      password: string;
      token: string;
      requestId: string;
    };

    if (!commitData.email || !commitData.password) return null;

    const name = getRandomName();
    return {
      email: commitData.email,
      password: commitData.password,
      token: commitData.token,
      name,
    };
  } catch (err) {
    logger.warn({ err }, "tmail.pk createTempEmail failed");
    return null;
  }
}



export async function getOTPFromMailTm(token: string, email: string): Promise<string | null> {
  try {
    const encoded = encodeURIComponent(email);
    const res = await fetch(
      `${BASE}/api/emails/list?recipient=${encoded}&token=${token}`,
      {
        headers: {
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "content-type": "application/json",
        },
        signal: AbortSignal.timeout(10_000),
      }
    );
    if (!res.ok) return null;

    const data = (await res.json()) as { emails: Array<{ subject: string; body?: string; html?: string; text?: string; preview?: string }> };
    if (!data.emails || data.emails.length === 0) return null;

    const email0 = data.emails[0];
    const combined = `${email0.body ?? ""} ${email0.html ?? ""} ${email0.text ?? ""} ${email0.preview ?? ""} ${email0.subject ?? ""}`;
    const match = combined.match(/\b\d{6}\b/);
    return match ? match[0] : null;
  } catch (err) {
    logger.warn({ err }, "tmail.pk getOTP failed");
    return null;
  }
}
