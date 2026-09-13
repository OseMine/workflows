// Security-Gate scorer for GitHub Actions.
// Aggregates scanner results from security-results/, computes a categorized
// report plus a 0-10 rating, writes step outputs/summary and emits run
// annotations. Deterministic - no findings means rating 10.
//
// Inputs (env):
//   MIN_RATING       minimum rating to pass (default 7)
//   MAX_DEDUCTIONS   optional cap per severity source is not used; simple sum
//   GITHUB_OUTPUT / GITHUB_STEP_SUMMARY  written when present (CI), else stdout
import fs from "node:fs";
import path from "node:path";

const RES_DIR = process.env.RES_DIR || "security-results";
const MIN_RATING = Number.isFinite(parseFloat(process.env.MIN_RATING))
  ? parseFloat(process.env.MIN_RATING)
  : 7;

const SEVERITIES = ["critical", "high", "medium", "low"];
const WEIGHTS = { critical: 4, high: 2, medium: 1, low: 0.25 };
const MAX_ANNOTATIONS = 15;
const MAX_DETAIL_ROWS = 25;

function readJson(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(RES_DIR, name), "utf8"));
  } catch {
    return null;
  }
}

function normSev(raw, fallback) {
  const s = String(raw ?? "").trim().toLowerCase();
  if (SEVERITIES.includes(s)) return s;
  if (s === "moderate") return "medium";
  if (s === "unknown" || s === "") return fallback ?? "low";
  return fallback ?? "low";
}

const findings = [];
function add(source, category, severity, title, target) {
  const clean = (v) => String(v ?? "").replace(/[\r\n]+/g, " ").slice(0, 200);
  findings.push({
    source,
    category,
    severity,
    title: clean(title),
    target: clean(target),
  });
}

// --- Trivy filesystem scan (dependencies + secrets across all components) ---
const trivy = readJson("trivy.json");
for (const result of Array.isArray(trivy?.Results) ? trivy.Results : []) {
  const target = result.Target ?? "";
  for (const v of result.Vulnerabilities ?? []) {
    add(
      "trivy",
      "dependency-vuln",
      normSev(v.Severity),
      `${v.VulnerabilityID ?? "?"} (${v.PkgName ?? "?"}) ${v.Title ?? ""}`.trim(),
      target,
    );
  }
  // Never echo secret contents - rule id and location only.
  for (const sec of result.Secrets ?? []) {
    add(
      "trivy",
      "secret",
      normSev(sec.Severity, "high"),
      `Hardcoded secret detected (${sec.RuleID ?? "rule"})`,
      `${target}${sec.StartLine != null ? `:${sec.StartLine}` : ""}`,
    );
  }
}

// --- npm audit (frontend lockfile) ---
const npmAudit = readJson("npm-audit.json");
for (const [name, entry] of Object.entries(npmAudit?.vulnerabilities ?? {})) {
  const viaTitles = (Array.isArray(entry?.via) ? entry.via : [])
    .filter((via) => typeof via === "object")
    .map((via) => via.title)
    .filter(Boolean)
    .join("; ");
  add(
    "npm-audit",
    "dependency-vuln",
    normSev(entry?.severity),
      `${name}: ${viaTitles || "vulnerable dependency"}`,
    "package-lock.json",
  );
}

// --- cargo audit (Rust lockfile) ---
const cargoAudit = readJson("cargo-audit.json");
for (const item of cargoAudit?.vulnerabilities?.list ?? []) {
  const advisory = item.advisory ?? {};
  const pkg = advisory.package ?? item.package?.name ?? "?";
  add(
    "cargo-audit",
    "dependency-vuln",
    normSev(advisory.severity, "medium"),
    `${advisory.id ?? "?"} (${pkg}) ${advisory.title ?? ""}`.trim(),
    "Cargo.lock",
  );
}
for (const key of ["unmaintained", "yanked", "soundness", "informational"]) {
  for (const item of cargoAudit?.warnings?.[key] ?? []) {
    const advisory = item.advisory ?? {};
    add(
      "cargo-audit",
      key,
      "low",
      `${advisory.id ?? key} (${advisory.package ?? item.package?.name ?? "?"})`,
      "Cargo.lock",
    );
  }
}

// --- PHP lint (flutcloud-app) ---
try {
  const raw = fs.readFileSync(path.join(RES_DIR, "php-lint.txt"), "utf8");
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const idx = line.indexOf(":");
    add(
      "php-lint",
      "syntax-error",
      "high",
      (idx > 0 ? line.slice(idx + 1) : line).trim(),
      idx > 0 ? line.slice(0, idx).trim() : "",
    );
  }
} catch {
  /* no php results */
}

// --- VirusTotal artifact reputation scan (optional) ---
const vt = readJson("virustotal.json");
for (const f of Array.isArray(vt?.findings) ? vt.findings : []) {
  add(
    "virustotal",
    "malware",
    normSev(f.severity, "medium"),
    f.title ?? "VirusTotal-Finding",
    f.file ?? "",
  );
}

// --- AI review (OpenCode) ---
const aiReport = readJson("ai-findings.json");
for (const f of Array.isArray(aiReport?.findings) ? aiReport.findings : []) {
  add(
    "ai-review",
    String(f.category ?? "code-review"),
    normSev(f.severity, "medium"),
    f.title ?? "AI-Finding",
    f.file ?? "",
  );
}
if (!Array.isArray(aiReport?.findings)) {
  try {
    if (
      fs.existsSync(path.join(RES_DIR, "ai-review.skipped")) ||
      fs.existsSync(path.join(RES_DIR, "ai-review.error"))
    ) {
      /* informational only - summary notes it below */
    }
  } catch {
    /* ignore */
  }
}

// --- Scoring ---
const counts = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
const bySourceCategory = new Map();
for (const f of findings) {
  counts[f.severity] += 1;
  const key = `${f.source}|${f.category}`;
  if (!bySourceCategory.has(key)) {
    bySourceCategory.set(key, {
      source: f.source,
      category: f.category,
      ...Object.fromEntries(SEVERITIES.map((s) => [s, 0])),
    });
  }
  bySourceCategory.get(key)[f.severity] += 1;
}
const totalDeduction = SEVERITIES.reduce(
  (sum, s) => sum + counts[s] * WEIGHTS[s],
  0,
);
const rating = Math.max(0, Math.round((10 - totalDeduction) * 10) / 10);
const verdict =
  counts.critical === 0 && rating >= MIN_RATING ? "pass" : "fail";

// --- Outputs ---
function writeOutputs() {
  const lines = [
    `rating=${rating}`,
    `verdict=${verdict}`,
    `critical=${counts.critical}`,
    `high=${counts.high}`,
    `medium=${counts.medium}`,
    `low=${counts.low}`,
    `total=${findings.length}`,
  ];
  const outPath = process.env.GITHUB_OUTPUT;
  if (outPath) fs.appendFileSync(outPath, lines.join("\n") + "\n");
  else console.log(lines.join("\n"));
}

// --- Annotations (workflow commands) ---
function esc(v) {
  return String(v)
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}
function annotate() {
  const ordered = [...findings].sort(
    (a, b) =>
      SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity),
  );
  const level = { critical: "error", high: "error", medium: "warning" };
  let shown = 0;
  for (const f of ordered) {
    if (shown >= MAX_ANNOTATIONS) break;
    const kind = level[f.severity];
    if (!kind) continue; // low -> table only
    const loc = f.target ? ` (${f.target})` : "";
    console.log(
      `::${kind} title=Security [${f.source}/${f.severity}]::${esc(f.title)}${esc(loc)}`,
    );
    shown += 1;
  }
  if (ordered.length > shown) {
    console.log(
      `::warning title=Security::${ordered.length - shown} more findings listed in step summary only`,
    );
  }
  if (verdict === "pass") {
    console.log(
      `::notice title=Security-Gate::Rating ${rating}/10 - Gate passed (threshold ${MIN_RATING}, critical: ${counts.critical})`,
    );
  } else {
    const reason =
      counts.critical > 0
        ? `${counts.critical} critical finding(s)`
        : `Rating below threshold`;
    console.log(
      `::error title=Security-Gate::Rating ${rating}/10 (minimum ${MIN_RATING}) - ${reason}; release blocked and tag deleted`,
    );
  }
}

// --- Step summary ---
function writeSummary() {
  const aiNote = fs.existsSync(path.join(RES_DIR, "ai-review.error"))
    ? "\n> Note: AI review could not be completed (non-blocking).\n"
    : fs.existsSync(path.join(RES_DIR, "ai-review.skipped"))
      ? "\n> Note: AI review disabled or no API key set.\n"
      : "";
  const rows = [...bySourceCategory.values()]
    .map(
      (r) =>
        `| ${r.source} | ${r.category} | ${r.critical} | ${r.high} | ${r.medium} | ${r.low} | ${r.critical + r.high + r.medium + r.low} |`,
    )
    .join("\n");
  const details = [...findings]
    .sort(
      (a, b) =>
        SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity),
    )
    .slice(0, MAX_DETAIL_ROWS)
    .map(
      (f) => `| ${f.severity} | ${f.source} | ${f.title} | ${f.target} |`,
    )
    .join("\n");
  const md = `# Security Gate - Rating: **${rating} / 10** [${verdict.toUpperCase()}]

Threshold: ${MIN_RATING} | Total findings: ${findings.length} (critical ${counts.critical}, high ${counts.high}, medium ${counts.medium}, low ${counts.low})
${aiNote}
## Findings by Source/Category

| Source | Category | Critical | High | Medium | Low | Total |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
${rows || "| - | - | 0 | 0 | 0 | 0 | 0 |"}

## Detailed Findings (max. ${MAX_DETAIL_ROWS})

| Severity | Source | Title | Location |
| --- | --- | --- | --- |
${details || "| - | - | none | - |"}
`;
  const sumPath = process.env.GITHUB_STEP_SUMMARY;
  if (sumPath) fs.appendFileSync(sumPath, md);
  else console.log(md);
}

writeSummary();
annotate();
writeOutputs();
process.exitCode = verdict === "fail" ? 1 : 0;
