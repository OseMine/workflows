/* Workflow Builder — composes GitHub workflows from OseMine/workflows actions.
 * The action catalog is fetched live from catalog.json on @main, so the action
 * list auto-updates without redeploying this app.
 */
"use strict";

const RAW_BASE = "https://raw.githubusercontent.com/OseMine/workflows/main";
const CATALOG_URL = `${RAW_BASE}/catalog.json`;

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

let catalog = null;

const state = {
  steps: [],   // { id, action, label, overrides: { inputId: value } }
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[c]));

/* ── catalog loading (auto-updates from @main) ───────────────────── */
async function loadCatalog() {
  const info = $("#autoupdate-text");
  try {
    const res = await fetch(CATALOG_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    catalog = await res.json();
    info.innerHTML = `loaded from <b>@main</b> · ${catalog.actions.length} actions · ${new Date().toLocaleTimeString()}`;
    $("#autoupdate").classList.remove("error");
    renderCatalog();
  } catch (e) {
    $("#autoupdate").classList.add("error");
    info.innerHTML = "catalog failed to load — check network / GitHub access";
    console.error("catalog load failed", e);
    fallbackCatalog();
  }
}

/* tiny built-in fallback so the UI still works offline */
function fallbackCatalog() {
  if (catalog) return;
  catalog = {
    actions: [
      { id: "ci", name: "CI (language dispatcher)", description: "Setup, lint, and test a project based on its language.", uses: "OseMine/workflows/.github/actions/ci@v1", inputs: [
        { id: "language", description: "Main stack: auto, rust, node, python, flutter, kmp, php, lua", default: "auto", boolean: false },
      ], outputs: [] },
      { id: "build", name: "Build artifacts (language dispatcher)", description: "Detects languages and dispatches to all per-language build actions.", uses: "OseMine/workflows/.github/actions/build@v1", inputs: [
        { id: "language", description: "auto | rust | c | cpp | csharp | maven | gradle | python | flutter | android | ios | kmp", default: "auto", boolean: false },
        { id: "build", description: "cargo, tauri, python, flutter, android, ios, kmp, c, cpp, csharp, java, all", default: "all", boolean: false },
      ], outputs: [] },
      { id: "security", name: "Security gate", description: "Trivy + cargo-audit + npm audit + PHP lint + VirusTotal + AI review.", uses: "OseMine/workflows/.github/actions/security@v1", inputs: [
        { id: "min-rating", description: "Minimum rating 0-10 to pass", default: "7", boolean: false },
      ], outputs: [] },
    ],
    templates: [],
  };
  renderCatalog();
}

/* ── catalog rendering ───────────────────────────────────────────── */
function renderCatalog() {
  const list = $("#action-list");
  list.innerHTML = "";
  const q = $("#search").value.trim().toLowerCase();
  const actions = (catalog.actions || [])
    .filter((a) => !q || `${a.name} ${a.description} ${a.id}`.toLowerCase().includes(q));
  if (!actions.length) {
    list.appendChild(el("div", "no-results", "No actions match your search."));
    return;
  }
  actions.forEach((a) => {
    const card = el("div", "action");
    card.innerHTML = `
      <div class="a-name">${esc(a.name)}</div>
      <div class="a-desc">${esc(a.description)}</div>
      <div class="a-meta">
        <span class="a-tag">${esc(a.id)}</span>
        <span class="a-count">${a.inputs_count != null ? a.inputs_count : (a.inputs || []).length} input${(a.inputs || []).length === 1 ? "" : "s"}</span>
        <button class="a-add">+ add</button>
      </div>`;
    card.querySelector(".a-add").addEventListener("click", () => addStep(a));
    card.addEventListener("click", (e) => { if (!e.target.closest("button")) addStep(a); });
    list.appendChild(card);
  });
}

/* ── step management ─────────────────────────────────────────────── */
function addStep(action) {
  const inputs = (action.inputs || []).reduce((acc, i) => {
    acc[i.id] = i.default || "";
    return acc;
  }, {});
  state.steps.push({ action, label: action.name, overrides: inputs });
  renderSteps();
  renderYaml();
}

function removeStep(idx) {
  state.steps.splice(idx, 1);
  renderSteps();
  renderYaml();
}

function moveStep(idx, dir) {
  const j = idx + dir;
  if (j < 0 || j >= state.steps.length) return;
  [state.steps[idx], state.steps[j]] = [state.steps[j], state.steps[idx]];
  renderSteps();
  renderYaml();
}

function setOverride(stepIdx, inputId, value) {
  state.steps[stepIdx].overrides[inputId] = value;
  renderYaml();
}

function renderSteps() {
  const wrap = $("#steps");
  wrap.innerHTML = "";
  if (!state.steps.length) {
    wrap.appendChild(el("div", "empty",
      "No steps yet — click <b>+ add</b> on an action in the left panel. " +
      "<code>actions/checkout</code> is always prepended automatically."));
    return;
  }
  state.steps.forEach((s, idx) => {
    const step = el("div", "step");
    const head = el("div", "step-head");
    head.appendChild(el("span", "s-num", `#${idx + 1}`));
    const nameInput = el("input", "s-name");
    nameInput.type = "text";
    nameInput.value = s.label;
    nameInput.style.fontWeight = 600;
    nameInput.style.background = "transparent";
    nameInput.style.border = "1px solid transparent";
    nameInput.style.color = "var(--text)";
    nameInput.style.padding = "2px 4px";
    nameInput.addEventListener("change", () => { s.label = nameInput.value; renderYaml(); });
    head.appendChild(nameInput);
    const uses = el("span", "s-uses", `OseMine/workflows/.github/actions/${s.action.id}@${$("#ref").value}`);
    uses.title = uses.textContent;
    head.appendChild(uses);

    const up = el("button", "", "↑");
    up.title = "move up";
    up.addEventListener("click", () => moveStep(idx, -1));
    const down = el("button", "", "↓");
    down.title = "move down";
    down.addEventListener("click", () => moveStep(idx, 1));
    const del = el("button", "danger", "✕");
    del.title = "remove step";
    del.addEventListener("click", () => removeStep(idx));
    if (idx === 0) up.style.opacity = 0.3;
    if (idx === state.steps.length - 1) down.style.opacity = 0.3;
    head.append(up, down, del);
    step.appendChild(head);

    const body = el("div", "step-body");
    (s.action.inputs || []).forEach((inp) => {
      const row = el("div", "input-row");
      const label = el("div", "i-label");
      label.appendChild(el("b", "", esc(inp.id)));
      if (inp.description) label.appendChild(el("span", "", esc(inp.description)));
      row.appendChild(label);

      const val = s.overrides[inp.id] ?? inp.default ?? "";
      if (inp.boolean) {
        const check = el("label", "step-check");
        const cb = el("input");
        cb.type = "checkbox";
        cb.checked = val === true || val === "true";
        cb.addEventListener("change", () => setOverride(idx, inp.id, cb.checked ? "true" : "false"));
        check.appendChild(cb);
        check.appendChild(el("span", "", "true / false"));
        row.appendChild(check);
      } else if (inp.secret_like) {
        const box = el("div", "secret-wrap");
        const field = el("input");
        field.type = "password";
        field.placeholder = inp.default ? `default: ${inp.default}` : "value (e.g. text or ${{ secrets.X }})";
        field.value = val;
        field.title = "trailing value in generated YAML";
        field.addEventListener("input", () => setOverride(idx, inp.id, field.value));
        const wrap = el("input");
        wrap.type = "checkbox";
        wrap.title = "wrap as a GitHub secret reference";
        wrap.checked = String(val).includes("secrets.");
        wrap.addEventListener("change", () => {
          const secretName = "${{ secrets." + inp.id.replace(/-|\./g, "_").toUpperCase() + " }}";
          const v = wrap.checked ? secretName : field.value;
          field.value = v;
          setOverride(idx, inp.id, v);
        });
        box.appendChild(wrap);
        box.appendChild(el("span", "", `\u221A secret`));
        box.prepend(field);
        box.style.flex = "1";
        box.style.display = "flex";
        box.style.justifyContent = "flex-end";
        box.style.gap = "6px";
        box.style.flexWrap = "wrap";
        row.appendChild(box);
      } else {
        const field = el("textarea");
        field.rows = 1;
        field.value = val;
        field.placeholder = inp.default ? `default: ${inp.default}` : "";
        field.addEventListener("input", () => { field.rows = Math.min(6, Math.max(1, field.value.split("\n").length)); setOverride(idx, inp.id, field.value); });
        field.style.flex = "1";
        row.appendChild(field);
      }
      body.appendChild(row);
    });
    if (!(s.action.inputs || []).length) {
      body.appendChild(el("div", "hint", "No configurable inputs for this action."));
    }
    step.appendChild(body);
    wrap.appendChild(step);
  });
  renderYaml();
}

/* ── YAML generation ─────────────────────────────────────────────── */
function yamlScalar(v) {
  if (v === true || v === "true") return "true";
  if (v === false || v === "false") return "false";
  if (v === "" || v == null) return "''";
  if (typeof v === "number") return String(v);
  const s = String(v);
  const needsMulti = s.includes("\n");
  if (needsMulti) {
    const body = s.split("\n").map((l) => `      ${l}`).join("\n");
    return "|-\n" + body;
  }
  if (/^[\w.@/\-${}[\]()\s]|^\$\{\{.*\}\}$/.test(s) && !/:[ ]|^\s|\s$/.test(s) && !/^[#&*!|>'"%@`]/.test(s) && !s.includes(": ")) {
    return s;
  }
  return `'${s.replace(/'/g, "''")}'`;
}

function renderYaml() {
  const name = $("#wf-name").value.trim() || "CI";
  const trigger = $("#wf-trigger").value;
  const branch = $("#wf-branch").value.trim();
  const cron = $("#wf-cron").value.trim();
  const runsOn = $("#wf-runs-on").value;
  const ref = $("#ref").value;

  const lines = [];
  lines.push(`name: ${yamlScalar(name)}`);
  lines.push("");
  lines.push("on:");
  if (trigger === "workflow_dispatch") {
    lines.push("  workflow_dispatch:");
  } else if (trigger === "push") {
    lines.push("  push:");
    lines.push(`    tags: ${yamlScalar(branch)}`);
  } else if (trigger === "push_branch") {
    lines.push("  push:");
    lines.push(`    branches: ${yamlScalar(branch)}`);
  } else if (trigger === "pull_request") {
    lines.push("  pull_request:");
    lines.push(`    branches: ${yamlScalar(branch)}`);
  } else if (trigger === "schedule") {
    lines.push("  schedule:");
    lines.push(`    - cron: ${yamlScalar(cron)}`);
  }
  lines.push("");
  lines.push("jobs:");
  const jobName = name.toLowerCase().replace(/[^a-z0-9_]+/g, "-").replace(/^-|-$/g, "") || "ci";
  lines.push(`  ${jobName}:`);
  lines.push("    name: General");
  lines.push(`    runs-on: ${runsOn}`);
  lines.push("");
  lines.push("    permissions:");
  lines.push("      contents: write");
  lines.push("      id-token: write");
  lines.push("");
  lines.push("    steps:");
  lines.push("      - uses: actions/checkout@v7");
  lines.push("        with:");
  lines.push("          fetch-depth: 0");

  state.steps.forEach((s) => {
    lines.push("");
    lines.push(`      - name: ${yamlScalar(s.label.replace(/["']/g, ""))}`);
    lines.push(`        uses: OseMine/workflows/.github/actions/${s.action.id}@${ref}`);
    const realWiths = (s.action.inputs || []).reduce((acc, inp) => {
      const v = s.overrides[inp.id];
      if (v === "" || v == null) return acc;
      if (v === inp.default) return acc;
      acc[inp.id] = v;
      return acc;
    }, {});
    const entries = Object.entries(realWiths);
    if (entries.length) {
      lines.push("        with:");
      entries.forEach(([k, v]) => lines.push(`          ${k}: ${yamlScalar(v)}`));
    }
  });

  $("#yaml").textContent = lines.join("\n");
}

/* ── presets ─────────────────────────────────────────────────────── */
const PRESETS = {
  ci: ["ci"],
  build: ["build"],
  release: ["release-all"],
  security: ["security"],
};

function applyPreset(preset) {
  const ids = PRESETS[preset];
  if (!ids || !catalog) return;
  state.steps = [];
  let ok = [];
  ids.forEach((id) => {
    const a = (catalog.actions || []).find((x) => x.id === id);
    if (a) {
      const inputs = (a.inputs || []).reduce((acc, i) => { acc[i.id] = i.default || ""; return acc; }, {});
      state.steps.push({ action: a, label: a.name, overrides: inputs });
      ok.push(id);
    }
  });
  if (preset === "release") $("#wf-name").value = "Release";
  if (preset === "ci") { $("#wf-name").value = "CI"; $("#wf-trigger").value = "push_branch"; $("#wf-branch").value = "main"; }
  if (preset === "security") $("#wf-name").value = "Security";
  if (preset === "build") $("#wf-name").value = "Build";
  toast(`Preset ${preset}: +${ok.join(", ")}`);
  renderSteps();
  renderYaml();
}

/* ── actions ─────────────────────────────────────────────────────── */
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove("show"), 1800);
}

function copyYaml() {
  const txt = $("#yaml").textContent;
  if (!txt) return;
  navigator.clipboard.writeText(txt).then(
    () => toast("Copied YAML to clipboard"),
    () => { /* fallback */ const a = document.createElement("textarea"); a.value = txt; document.body.appendChild(a); a.select(); document.execCommand("copy"); a.remove(); toast("Copied YAML to clipboard"); }
  );
}

function downloadYaml() {
  const txt = $("#yaml").textContent;
  if (!txt) return;
  const name = ($("#wf-name").value.trim() || "workflow").toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  const blob = new Blob([txt], { type: "text/yaml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = el("a");
  a.href = url;
  a.download = `${name}.yml`;
  a.click();
  URL.revokeObjectURL(url);
  toast("Downloaded " + a.download);
}

/* ── wire up events ──────────────────────────────────────────────── */
function wireEvents() {
  $("#search").addEventListener("input", renderCatalog);

  $("#ref").addEventListener("change", renderYaml);

  ["#wf-name", "#wf-branch", "#wf-cron"].forEach((sel) => {
    $(sel).addEventListener("input", renderYaml);
  });
  ["#wf-trigger", "#wf-runs-on"].forEach((sel) => {
    $(sel).addEventListener("change", renderYaml);
  });

  $("#wf-trigger").addEventListener("change", () => {
    const t = $("#wf-trigger").value;
    $("#lbl-branch").classList.toggle("hidden", t === "workflow_dispatch" || t === "schedule");
    $("#lbl-cron").classList.toggle("hidden", t !== "schedule");
  });

  $("#btn-copy").addEventListener("click", copyYaml);
  $("#btn-download").addEventListener("click", downloadYaml);
  $("#btn-clear").addEventListener("click", () => {
    state.steps = [];
    renderSteps();
    renderYaml();
  });
  document.querySelectorAll("[data-preset]").forEach((b) =>
    b.addEventListener("click", () => applyPreset(b.dataset.preset)));
}

wireEvents();
renderYaml();
loadCatalog();