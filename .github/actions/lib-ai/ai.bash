#!/usr/bin/env bash
# Shared AI provider logic for gha-workflows composite actions.
# Source this file from a run: block, then call the ai_* helpers.
# Requires bash 4+ (standard on GitHub hosted runners).
#
# Env vars consumed (caller maps action inputs into these):
#   PROV1 MODEL1 KEY1  - primary provider / model / api-key
#   PROV2 MODEL2 KEY2  - fallback provider / model / api-key
#   CUSTOM_BASE        - base URL for provider=custom (OpenAI-compatible)
#   CUSTOM_KEY         - api key for provider=custom
#   CUSTOM_MODEL       - model id override for provider=custom

# Ordered provider preference list for auto / auto-free model resolution.
# Format per entry: "<provider> <free_tier 0|1>"
#   - only providers present in the models.dev catalog are auto-resolvable
#     (they ship real, current model ids we discover at runtime).
#   - free_tier=1 -> eligible for auto-free (skips paid providers).
# There are NO hardcoded models here: the concrete model id for an auto-
# resolved provider is discovered live from https://models.dev/api.json.
AI_PROVIDERS=(
  "opencode 1"
  "groq 1"
  "google 1"
  "openrouter 1"
  "mistral 1"
  "cerebras 1"
  "xai 0"
  "deepseek 0"
  "openai 0"
  "anthropic 0"
  "togetherai 0"
  "huggingface 0"
)
AI_FALLBACK="opencode"

# Canonical models.dev provider ids used by aliases above.
AI_PROVIDER_IDS=(
  "opencode opencode"
  "groq groq"
  "google google"
  "openrouter openrouter"
  "mistral mistral"
  "cerebras cerebras"
  "openai openai"
  "anthropic anthropic"
  "deepseek deepseek"
  "x x"
  "xai xai"
  "together togetherai"
  "togetherai togetherai"
  "huggingface huggingface"
  "hf huggingface"
)

# Print the standard env var that stores the API key for a provider
# (empty = provider uses no key, or key handled via custom config).
ai_provider_key_env() {
  case "$1" in
    opencode)    echo "OPENCODE_API_KEY" ;;
    google)      echo "GOOGLE_API_KEY" ;;
    openai)      echo "OPENAI_API_KEY" ;;
    mistral)     echo "MISTRAL_API_KEY" ;;
    anthropic)   echo "ANTHROPIC_API_KEY" ;;
    x|xai)       echo "XAI_API_KEY" ;;
    deepseek)    echo "DEEPSEEK_API_KEY" ;;
    groq)        echo "GROQ_API_KEY" ;;
    puter)       echo "PUTER_AUTH_TOKEN" ;;
    together|togetherai) echo "TOGETHER_API_KEY" ;;
    cerebras)    echo "CEREBRAS_API_KEY" ;;
    openrouter)  echo "OPENROUTER_API_KEY" ;;
    huggingface|hf) echo "HUGGINGFACE_API_KEY" ;;
    *);;
  esac
}

# Export the API key so the provider SDK inside opencode finds it.
ai_apply_key() {
  local p="$1" k="$2"
  case "$p" in
    opencode)    export OPENCODE_API_KEY="$k" ;;
    google)      export GOOGLE_API_KEY="$k"; export GEMINI_API_KEY="$k" ;;
    openai)      export OPENAI_API_KEY="$k" ;;
    mistral)     export MISTRAL_API_KEY="$k" ;;
    anthropic)   export ANTHROPIC_API_KEY="$k" ;;
    x|xai)       export XAI_API_KEY="$k" ;;
    deepseek)    export DEEPSEEK_API_KEY="$k" ;;
    groq)        export GROQ_API_KEY="$k" ;;
    puter)       export PUTER_AUTH_TOKEN="$k" ;;
    together|togetherai) export TOGETHER_API_KEY="$k"; export TOGETHERAI_API_KEY="$k" ;;
    cerebras)    export CEREBRAS_API_KEY="$k" ;;
    openrouter)  export OPENROUTER_API_KEY="$k" ;;
    huggingface|hf) export HUGGINGFACE_API_KEY="$k" ;;
    ollama|lmstudio) : ;; # local, no key
    custom)      export CUSTOM_API_KEY="$k" ;;
    *) echo "::warning::unknown AI provider '$p'" ;;
  esac
}

# 0 = provider requires an API key to work.
ai_requires_key() {
  case "$1" in
    ollama|opencode|puter|lmstudio|custom) return 1 ;;
    *) return 0 ;;
  esac
}

# Assemble a full "provider/model" id.
ai_full_model() {
  case "$2" in */*) echo "$2" ;; *) echo "$1/$2" ;; esac
}

# 0 = the given key (or the provider's env var) is available for the provider.
ai_has_key() {
  local p="$1" k="$2"
  if ! ai_requires_key "$p"; then return 0; fi
  [ -n "$k" ] && return 0
  local env_name alt; env_name="$(ai_provider_key_env "$p")"
  case "$p" in
    google) alt="GEMINI_API_KEY" ;;
    x|xai)  alt="XAI_API_KEY" ;;
    together|togetherai) alt="TOGETHERAI_API_KEY" ;;
    *) alt="" ;;
  esac
  if [ -n "$env_name" ] && [ -n "${!env_name:-}" ]; then return 0; fi
  if [ -n "$alt" ] && [ -n "${!alt:-}" ]; then return 0; fi
  return 1
}

# Configure opencode (inline config) for an OpenAI-compatible provider.
# Prints nothing; sets OPENCODE_CONFIG_CONTENT env var. Returns 0 on success.
ai_setup_custom() {
  local base="$1" key="$2" model="$3"
  if [ -z "$base" ]; then
    echo "::error::provider 'custom' requires custom-api-base" >&2
    return 1
  fi
  if [ -z "$model" ]; then
    echo "::error::provider 'custom' requires custom-model (or a concrete model)" >&2
    return 1
  fi
  export CUSTOM_API_KEY="$key"
  local json config
  config='import json,sys
b,k,m = sys.argv[1], sys.argv[2], sys.argv[3]
print(json.dumps({"provider": {"custom": {"npm": "@ai-sdk/openai-compatible", "name": "Custom (OpenAI-compatible)", "options": {"baseURL": b, "apiKey": k}, "models": {m: {"name": m}}}}}))'
  json=$(python3 "$config" "$base" "$key" "$model") || {
    echo "::error::failed to build custom provider config (python3 required)" >&2
    return 1
  }
  export OPENCODE_CONFIG_CONTENT="$json"
}

# Resolve model input to a concrete "provider/model" id.
#   auto / auto-free  -> the best AVAILABLE provider (its model is then
#                        discovered at runtime; no hardcoded model).
#   concrete id       -> "provider/model" (or "custom/<model>" for custom).
#   fallback          -> pinned fallback model, else "$AI_FALLBACK".
ai_resolve() {
  local model="$1" prov="$2" key="$3" fb_prov="$4" fb_model="$5" fb_key="$6"
  if [ "$prov" = "custom" ]; then
    echo "custom/${CUSTOM_MODEL:-$model}"
    return 0
  fi
  if [ "$model" != "auto" ] && [ "$model" != "auto-free" ]; then
    echo "$(ai_full_model "$prov" "$model")"
    return 0
  fi
  local want_free=0
  [ "$model" = "auto-free" ] && want_free=1

  # An explicitly-configured provider (not "auto") with a usable key wins.
  # The default (opencode) is keyless so it keeps winning by default;
  # a paid provider with a valid key jumps ahead of the preference list.
  if [ "$prov" != "auto" ]; then
    local prov_free=1
    if [ "$want_free" = "1" ]; then
      for entry in "${AI_PROVIDERS[@]}"; do
        read -r p ft <<< "$entry"
        if [ "$p" = "$(ai_provider_id "$prov")" ]; then prov_free="$ft"; break; fi
      done
    fi
    if { [ "$want_free" = "0" ] || [ "$prov_free" = "1" ]; } && ai_has_key "$prov" "$key"; then
      echo "$(ai_provider_id "$prov")"
      return 0
    fi
  fi

  local p ft
  for entry in "${AI_PROVIDERS[@]}"; do
    read -r p ft <<< "$entry"
    if [ "$want_free" = "1" ] && [ "$ft" != "1" ]; then
      continue
    fi
    if ai_has_key "$p" "$key"; then
      echo "$(ai_provider_id "$p")"
      return 0
    fi
  done
  # nothing available: prefer a concretely-pinned fallback, else the safe default.
  if [ "$fb_prov" = "custom" ]; then
    echo "custom/${CUSTOM_MODEL:-$fb_model}"
    return 0
  fi
  if [ "$fb_model" != "auto" ] && [ "$fb_model" != "auto-free" ] && [ -n "$fb_prov" ]; then
    echo "$(ai_full_model "$fb_prov" "$fb_model")"
    return 0
  fi
  echo "$AI_FALLBACK"
}

# Canonical models.dev provider id for an alias.
ai_provider_id() {
  local aliases p id
  for aliases in "${AI_PROVIDER_IDS[@]}"; do
    read -r p id <<< "$aliases"
    if [ "$p" = "$1" ]; then echo "$id"; return 0; fi
  done
  echo "$1"
}

# Look up the model catalog, cache it, return JSON on stdout.
ai_fetch_models() {
  local cache="${RUNNER_TEMP:-/tmp}/models-dev.json"
  if [ ! -s "$cache" ]; then
    curl -fsSL --max-time 90 -o "$cache" "https://models.dev/api.json" 2>/dev/null || {
      rm -f "$cache"; return 1
    }
  fi
  cat "$cache"
}

# Discover the best model id for a provider from the live catalog.
# Prints "provider/model" or exits non-zero if the provider has no suitable model.
#   $1 = provider alias   $2 = "1" for auto-free (only zero-cost models)
ai_discover_model() {
  local prov="$1" free="$2" cache pid
  ai_fetch_models >/dev/null || return 1
  cache="${RUNNER_TEMP:-/tmp}/models-dev.json"
  python3 - "$prov" "$free" "$cache" <<'PYEOF'
import json, sys
prov, free, cache = sys.argv[1], sys.argv[2] == "1", sys.argv[3]
try:
    with open(cache, encoding="utf-8") as f:
        data = json.load(f)
except Exception:
    sys.exit(1)

aliases = {
    "opencode": ["opencode"],
    "groq": ["groq"],
    "google": ["google"],
    "openrouter": ["openrouter"],
    "mistral": ["mistral"],
    "cerebras": ["cerebras"],
    "openai": ["openai"],
    "anthropic": ["anthropic"],
    "deepseek": ["deepseek"],
    "x": ["x", "xai"],
    "xai": ["x", "xai"],
    "together": ["togetherai", "together"],
    "togetherai": ["togetherai", "together"],
    "huggingface": ["hf", "huggingface"],
    "hf": ["hf", "huggingface"],
    "puter": ["puter"],
    "ollama": ["ollama"],
    "lmstudio": ["lmstudio"],
}
pid = None
for cand in aliases.get(prov, [prov]):
    if cand in data:
        pid = cand
        break
if pid is None:
    sys.exit(1)

provider = data[pid]
cands = []
for mid, m in provider.get("models", {}).items():
    if m.get("status") == "deprecated":
        continue
    cost = m.get("cost") or {}
    input_cost = cost.get("input")
    output_cost = cost.get("output")
    if free:
        # free tier: cost explicitly zero, or absent (unknown -> treat as free)
        if input_cost is not None and input_cost != 0: continue
        if output_cost is not None and output_cost != 0: continue
    tool = m.get("tool_call", True)
    rel = m.get("release_date") or ""
    mid_lc = mid.lower()
    fam = 99
    for i, p in enumerate(["gpt-5", "claude-sonnet-4", "big-pickle", "gemini-3-pro"]):
        if p in mid_lc:
            fam = i
            break
    latest = 1 if "latest" in mid_lc else 0
    cands.append((fam, latest, rel, mid, tool))

def best(items):
    items = [c for c in items if c[4]] or items
    items = sorted(items, key=lambda c: (c[0], c[1]))
    topfam = items[0][0]
    items = [c for c in items if c[0] == topfam]
    return max(items, key=lambda c: (c[2], c[3]))

# A coding workflow runs an agent, so only tool-capable models make sense for
# the free tier. If the provider has no free agent-capable model, skip it
# (callers fall back to the next provider/model).
if free and not any(c[4] for c in cands):
    sys.exit(1)
if not cands:
    sys.exit(1)
out = best(cands)
print(f"{pid}/{out[3]}")
PYEOF
}

# Turn a resolved ref (alias or provider/model) into a concrete runnable model
# id with API keys applied. Prints "provider/model" for --model. Returns 1 on
# failure (with a warning) so callers fall back to the next model.
#   $1 = resolved ref from ai_resolve: "provider" (auto alias), "provider/mod",
#       or "custom/<model>".
#   $2 = api key (may be empty; an env-provided key is used as a fallback).
#   $3 = "1" when the discovery must only pick free-tier models.
ai_prepare() {
  local ref="$1" k="$2" free="$3" p m eff env_name
  p="${ref%%/*}"
  m="${ref#*/}"
  if [ "$ref" = "$p" ]; then
    # alias (no slash): need to discover the concrete model at runtime.
    if [ "$p" = "custom" ]; then
      echo "::error::custom provider requires CUSTOM_MODEL for auto/auto-free" >&2
      return 1
    fi
    echo "::debug::discovering best model for the provider '$p'" >&2
    m="$(ai_discover_model "$p" "$free")" || {
      echo "::warning::no discoverable model for provider '$p' - skipping" >&2
      return 1
    }
    p="${m%%/*}"
    m="${m#*/}"
  elif [ "$p" = "custom" ]; then
    # custom: build the inline config; model id must be concrete.
    if [ "$m" = "auto" ] || [ "$m" = "auto-free" ]; then
      echo "::error::custom provider requires CUSTOM_MODEL for 'auto' models" >&2
      return 1
    fi
    ai_setup_custom "${CUSTOM_BASE:-}" "${CUSTOM_KEY:-$k}" "$m" || return 1
    echo "custom/$m"
    return 0
  fi
  # concrete provider now; verify key availability, then apply it.
  if ai_requires_key "$p" && ! ai_has_key "$p" "$k"; then
    echo "::warning::provider '$p' requires an API key but none is available - skipping $p/$m" >&2
    return 1
  fi
  eff="$k"
  if [ -z "$eff" ]; then
    env_name="$(ai_provider_key_env "$p")"
    if [ -n "$env_name" ] && [ -n "${!env_name:-}" ]; then
      eff="${!env_name}"
    else
      case "$p" in
        google)      eff="${GEMINI_API_KEY:-}" ;;
        x|xai)       eff="${XAI_API_KEY:-}" ;;
        together|togetherai) eff="${TOGETHERAI_API_KEY:-}" ;;
      esac
    fi
  fi
  ai_apply_key "$p" "$eff"
  echo "$p/$m"
}

# ── AI output sanitisation & quality checks ─────────────────────────
# Strips ANSI escape sequences, OSC title sequences, cursor show/hide
# sequences and non-printable control characters from stdin.  Useful for
# cleaning terminal/TUI garbage from opencode output before treating it as
# release notes or review findings.
ai_sanitize_ai_output() {
  perl -CS -pe '
    no warnings "utf8";
    s/\x1b\[\?[0-9;]*[hl]//g;    # cursor hide/show (?25l / ?25h)
    s/\x1b\][^\a\r]+(\a|\x1b\\)//g;  # OSC title/status (BEL or ESC-backslash end)
    s/\x1b\[[0-9;]*[A-Za-z]//g;   # CSI sequences
    s/\x1b\[[0-9;]*[~]//g;        # CSI with ~ suffix
    s/\x1b[()][AB012]//g;         # charset selects
    s/\x1b[=>]//g;                # keypad / locking shifts
    s/\r//g;                       # carriage returns
    s/[\x00-\x08\x0B\x0C\x0E-\x1F]//g;  # control chars (keep \t \n)
    s/[\x{2400}-\x{25FF}\x{2800}-\x{28FF}]//g;  # box-drawing + braille spinners
  '
}

# Extract the final assistant text from `opencode --format json` NDJSON event
# stream on stdin.  Prints only the text of the last non-temporary assistant
# text part - a deterministic final answer with zero TUI residue.
# (The program runs from a temp file: multi-line `node -e` args can break on
# Windows runners, so we never pass multi-line code through -e.)
ai_extract_text() {
  local tmp
  tmp=$(mktemp)
  cat > "$tmp" <<'NODE'
const fs = require("fs");
let out = "";
const rl = require("readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  try {
    const ev = JSON.parse(line);
    const part = ev && ev.part;
    if (part && part.type === "text" && !part.temporary &&
        (!part.role || part.role === "assistant") && part.text) out = part.text;
  } catch (_) {}
});
rl.on("close", () => fs.writeSync(1, out));
NODE
  node "$tmp"
  local rc=$?
  rm -f "$tmp"
  return "$rc"
}

# Validate that a release-notes file contains real note-like content after
# cleaning.  Returns 0 when the file looks usable, 1 when it is empty, too
# short, still full of TUI garbage, or has no markdown structure at all.
#   $1 = path to the notes file
ai_is_valid_notes() {
  local file="$1"
  [ -s "$file" ] || return 1
  local clean len
  clean=$(cat "$file" | ai_sanitize_ai_output)
  len=${#clean}
  # After cleaning, < 50 chars is almost certainly garbage or an error echo
  [ "$len" -lt 50 ] && return 1
  # No escape/control sequences or Unicode symbol-block chars may survive
  # (spinner/box-drawing residue would have been stripped above, but a file
  # that still carries them is a TUI dump, not notes).
  printf '%s\n' "$clean" | perl -CS -ne 'exit 1 if /[\x1b\x00-\x08\x0B\x0C\x0E-\x1F\x{2400}-\x{28FF}]/' || return 1
  # Must look like structured release notes: at least one markdown heading or
  # bullet, regardless of length (a long log/TUI dump has no markdown and must
  # be rejected even when it is hundreds of characters).
  echo "$clean" | grep -qE '^(#{1,6} |[*+-] )'
}