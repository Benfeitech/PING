import "dotenv/config";
import crypto from "crypto";
import { jobs, startJobAsync, stopJob, type Job } from "./generator";

const refUrl = process.argv[2];
const count = Number(process.argv[3] ?? 1);

if (!refUrl) {
  console.error("Usage: npx tsx run.ts <referral-url> [count]");
  process.exit(1);
}

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