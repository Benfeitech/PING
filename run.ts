import "dotenv/config";
import crypto from "crypto";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { jobs, startJobAsync, stopJob, type Job } from "./generator";

/**
 * Prompt the user for a referral URL. Falls back to a CLI arg if provided.
 */
async function askRefUrl(
  rl: readline.Interface,
  cliArg?: string,
): Promise<string> {
  if (cliArg && cliArg.trim()) return cliArg.trim();

  while (true) {
    const answer = (await rl.question("🔗 Enter referral link: ")).trim();
    if (!answer) {
      console.log("   ⚠️  Referral link cannot be empty. Try again.");
      continue;
    }
    try {
      // Basic URL sanity check — must be a valid http(s) URL
      const u = new URL(answer);
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        throw new Error("must be http(s)");
      }
      return answer;
    } catch {
      console.log(`   ⚠️  "${answer}" is not a valid URL. Example: https://rl.katabump.fr/ae49f4`);
    }
  }
}

/**
 * Prompt the user for a positive integer count. Falls back to a CLI arg.
 */
async function askCount(
  rl: readline.Interface,
  cliArg?: string,
): Promise<number> {
  if (cliArg && cliArg.trim()) {
    const n = Number(cliArg);
    if (Number.isInteger(n) && n > 0) return n;
  }

  while (true) {
    const answer = (await rl.question("🔢 How many accounts to create? ")).trim();
    const n = Number(answer);
    if (Number.isInteger(n) && n > 0 && n <= 1000) return n;
    console.log("   ⚠️  Please enter a whole number between 1 and 1000.");
  }
}

async function main(): Promise<void> {
  // Support both interactive prompts AND CLI args:
  //   npx tsx run.ts                      → prompts for both
  //   npx tsx run.ts <refUrl>             → prompts for count only
  //   npx tsx run.ts <refUrl> <count>     → no prompts
  const cliRefUrl = process.argv[2];
  const cliCount = process.argv[3];

  const rl = readline.createInterface({ input, output });

  let refUrl: string;
  let count: number;
  try {
    console.log("=== Katabump Account Generator ===\n");
    refUrl = await askRefUrl(rl, cliRefUrl);
    count = await askCount(rl, cliCount);
  } finally {
    // Close readline so SIGINT works cleanly and the process doesn't hang
    rl.close();
  }

  console.log(`\n✅ Referral: ${refUrl}`);
  console.log(`✅ Accounts to create: ${count}\n`);

  const job: Job = {
    id: crypto.randomUUID(),
    status: "pending",
    refUrl,
    count,
    successCount: 0,
    failCount: 0,
    logs: [],
    accounts: [],
    createdAt: new Date().toISOString(),
  };

  jobs.set(job.id, job);

  // Ctrl+C triggers the built-in graceful stop instead of hard-killing a browser
  process.on("SIGINT", () => {
    console.log("\nStopping...");
    stopJob(job.id);
  });

  let printed = 0;
  const tick = setInterval(() => {
    for (; printed < job.logs.length; printed++) console.log(job.logs[printed]);

    if (job.status === "completed" || job.status === "failed" || job.status === "stopped") {
      clearInterval(tick);
      console.log("\n=== ACCOUNTS CREATED ===");
      for (const a of job.accounts) console.log(`${a.email} : ${a.password}`);
      console.log(`\n${job.successCount} succeeded, ${job.failCount} failed.`);
      process.exit(0);
    }
  }, 500);

  startJobAsync(job);
}

main().catch((err) => {
  console.error("💥 Fatal:", err);
  process.exit(1);
});