#!/usr/bin/env node
// Generic VirusTotal artifact scanner for GitHub Actions security gates.
//
// Scans files against the VirusTotal v3 API:
//   1. sha256 hash lookup - instant verdict for known files.
//   2. Unknown files are uploaded (<= --max-size, public API limit 32 MiB)
//      and the analysis is polled until completion or --timeout.
//
// Results JSON (consumed by score.mjs):
//   { tool, scanned, malicious, suspicious, files: [...], errors: [...], findings: [...] }
//
// Usage:
//   node virustotal.mjs --api-key KEY [--files "glob1 glob2"] --results PATH
//        [--max-size 33554432] [--timeout 600] [--poll-secs 15]
//        [--spacing-ms 16000] [--fail-on malicious|suspicious|never]
//
// Exit codes: 0 = clean / nothing to scan / pending; 1 = findings at or above
// --fail-on; 2 = usage or runtime error.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const API = "https://www.virustotal.com/api/v3";
const DEFAULT_MAX_SIZE = 32 * 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const opts = {
    apiKey: process.env.VT_API_KEY || "",
    patterns: [],
    results: "",
    maxSize: DEFAULT_MAX_SIZE,
    timeoutSecs: 600,
    pollSecs: 15,
    spacingMs: 16000,
    failOn: "malicious",
  };
  const args = [...argv];
  const take = () => {
    const v = args.shift();
    if (v === undefined) throw new Error(`missing value for flag`);
    return v;
  };
  while (args.length > 0) {
    const flag = args.shift();
    switch (flag) {
      case "--api-key": opts.apiKey = take(); break;
      case "--files":
        opts.patterns.push(...take().split(/\s+/).filter(Boolean));
        break;
      case "--results": opts.results = take(); break;
      case "--max-size": opts.maxSize = Number(take()); break;
      case "--timeout": opts.timeoutSecs = Number(take()); break;
      case "--poll-secs": opts.pollSecs = Number(take()); break;
      case "--spacing-ms": opts.spacingMs = Number(take()); break;
      case "--fail-on": opts.failOn = take(); break;
      default: throw new Error(`unknown flag: ${flag}`);
    }
  }
  if (!opts.apiKey) throw new Error("--api-key required");
  return opts;
}

function annotate(kind, message) {
  console.log(
    `::${kind} title=Security [virustotal]::${message.replaceAll("\n", " ")}`,
  );
}

async function apiFetch(pathname, init, key) {
  const res = await fetch(`${API}${pathname}`, {
    ...init,
    headers: { "x-apikey": key, ...(init.headers ?? {}) },
  });
  // Free tier allows ~4 requests/min - honour Retry-After instead of failing.
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after")) || 30;
    await sleep(Math.min(retryAfter, 90) * 1000);
    return apiFetch(pathname, init, key);
  }
  return res;
}

function statsOf(body) {
  const s = body?.data?.attributes?.last_analysis_stats ?? {};
  return {
    malicious: s.malicious ?? 0,
    suspicious: s.suspicious ?? 0,
    undetected: s.undetected ?? 0,
    harmless: s.harmless ?? 0,
    timeout: s.timeout ?? 0,
  };
}

async function lookup(sha256, key) {
  const res = await apiFetch(`/files/${sha256}`, {}, key);
  if (res.status === 200) {
    return { status: "found", stats: statsOf(await res.json()) };
  }
  if (res.status === 404) return { status: "unknown" };
  return { status: "error", detail: `HTTP ${res.status}` };
}

async function uploadAndPoll(file, size, key, opts, deadline) {
  if (size > opts.maxSize) {
    return { status: "skipped-too-large", detail: `${size} bytes > limit` };
  }
  const data = new FormData();
  data.append("file", new Blob([fs.readFileSync(file)]), path.basename(file));
  const res = await apiFetch("/files", { method: "POST", body: data }, key);
  if (!res.ok) return { status: "error", detail: `upload failed: HTTP ${res.status}` };
  const analysisId = (await res.json())?.data?.id;
  if (!analysisId) return { status: "error", detail: "no analysis id" };

  while (Date.now() < deadline) {
    await sleep(opts.pollSecs * 1000);
    let pbody;
    try {
      const poll = await apiFetch(`/analyses/${analysisId}`, {}, key);
      if (!poll.ok) continue;
      pbody = await poll.json();
    } catch {
      continue;
    }
    if (pbody?.data?.attributes?.status !== "completed") continue;
    await sleep(opts.spacingMs); // file report can lag behind the analysis
    const sha256 = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    const final = await lookup(sha256, key);
    return final.status === "found"
      ? final
      : { status: "pending", detail: "completed, report not yet available" };
  }
  return { status: "pending", detail: "analysis not finished before timeout" };
}

async function scan(opts) {
  const deadline = Date.now() + opts.timeoutSecs * 1000;

  // Expand globs (Node >=22 fs.globSync), dedupe, keep regular files.
  const seen = new Set();
  const files = [];
  for (const pattern of opts.patterns) {
    let matched = [];
    try {
      matched = [...fs.globSync(pattern)];
    } catch (err) {
      annotate("warning", `glob failed for '${pattern}': ${err.message}`);
    }
    if (!matched.length && !pattern.includes("*")) matched = [pattern];
    for (const f of matched) {
      if (seen.has(f)) continue;
      seen.add(f);
      try {
        if (fs.statSync(f).isFile()) files.push(f);
      } catch {
        /* vanished between glob and stat */
      }
    }
  }

  const result = {
    tool: "virustotal",
    scanned: 0,
    malicious: 0,
    suspicious: 0,
    files: [],
    errors: [],
    findings: [],
  };

  if (files.length === 0) {
    annotate("notice", "no files to scan specified or found");
    writeResults(opts.results, result);
    process.exit(0);
  }

  console.log(`VirusTotal scan: ${files.length} file(s)`);

  for (const file of files) {
    const size = fs.statSync(file).size;
    const sha256 = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    let outcome = await lookup(sha256, opts.apiKey);
    if (outcome.status === "unknown") {
      await sleep(opts.spacingMs); // stay within the upload rate limit
      outcome = await uploadAndPoll(file, size, opts.apiKey, opts, deadline);
    }
    if (outcome.status === "found") {
      await sleep(opts.spacingMs); // free tier: ~4 requests/min
    }

    const stats = outcome.stats;
    const entry = {
      file,
      size,
      sha256,
      status: outcome.status,
      detail: outcome.detail ?? "",
      engines: stats ?? null,
    };

    if (outcome.status === "found") {
      result.scanned += 1;
      const { malicious, suspicious } = stats;
      result.malicious += malicious > 0 ? 1 : 0;
      result.suspicious += malicious === 0 && suspicious > 0 ? 1 : 0;
      entry.verdict = malicious > 0 ? "malicious" : suspicious > 0 ? "suspicious" : "clean";
      if (malicious > 0 || suspicious > 0) {
        annotate(
          malicious > 0 ? "error" : "warning",
          `${path.basename(file)}: ${malicious} malicious / ${suspicious} suspicious engines`,
        );
        result.findings.push({
          title: `VirusTotal: ${path.basename(file)} flagged by ${malicious} engine(s)`,
          severity: "medium",
          file,
          detail: `sha256=${sha256}, engines: ${JSON.stringify(stats)}`,
        });
      }
    } else if (outcome.status === "error") {
      result.errors.push(`${file}: ${outcome.detail}`);
      annotate("warning", `${path.basename(file)}: scan error (${outcome.detail})`);
    } else if (outcome.status === "pending") {
      annotate("notice", `${path.basename(file)}: analysis still running (${outcome.detail})`);
    }
    result.files.push(entry);
  }

  writeResults(opts.results, result);

  const fail =
    (opts.failOn === "malicious" && result.malicious > 0) ||
    (opts.failOn === "suspicious" && result.malicious + result.suspicious > 0);
  console.log(
    `VirusTotal done: ${result.scanned} scanned, ${result.malicious} malicious, ${result.suspicious} suspicious, ${result.errors.length} errors`,
  );
  if (fail) {
    annotate("error", `VirusTotal gate failed (${result.malicious} malicious)`);
    process.exit(1);
  }
  process.exit(0);
}

function writeResults(resultsPath, result) {
  if (!resultsPath) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  fs.mkdirSync(path.dirname(resultsPath), { recursive: true });
  fs.writeFileSync(resultsPath, JSON.stringify(result, null, 2));
}

try {
  await scan(parseArgs(process.argv.slice(2)));
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  console.error(
    'Usage: node virustotal.mjs --api-key KEY [--files "glob ..."] --results PATH',
  );
  process.exit(2);
}
