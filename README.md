# gha-workflows — reusable GitHub Actions library

A collection of reusable composite GitHub Actions you can consume from **any**
project. All logic lives in this repository; projects only copy a thin
workflow (set `language:`) and point actions at `OseMine/workflows@main`.

Update a composite action once → every consuming project inherits the fix.

## Usage (fast path)

1. **Copy a template** from `templates/` into your project's `.github/workflows/`.
2. Set `language:`, `build:` or `prompt:` as needed.
3. Commit, push, done.

The templates already point at `OseMine/workflows@main`, so no action ref
edits are needed. If you fork this repo, replace `OseMine/workflows` with your
own org/repo throughout `templates/` and `.github/actions/`.

### CI (push/PR quality gate)

```yaml
name: CI
on: [push, pull_request]
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: OseMine/workflows/.github/actions/ci@main
        with:
          language: rust    # auto | rust | tauri | node | python | flutter | kmp | php | lua
```

### Release (workflow dispatch)

Copy `templates/release.yml`. Run from the **Actions → Release → Run workflow** dialog: the version auto-detects from `pubspec.yaml` / `Cargo.toml` / `package.json` (or pick a tag / version), choose prerelease/draft, and the whole pipeline runs. `push: tags: ["v*"]` stays as a secondary trigger.

```yaml
name: Release
on:
  workflow_dispatch:
    inputs:
      version:      {description: Version, required: false, type: string}
      prerelease:   {description: Mark as prerelease, type: boolean, default: false}
      draft:        {description: Create as draft, type: boolean, default: false}
      build:        {description: Build flags, type: string, default: all}
  push: {tags: ["v*"]}
permissions: {contents: write, id-token: write}
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with: {fetch-depth: 0}
      - uses: OseMine/workflows/.github/actions/release-all@main
        with:
          language: rust
          build: ${{ github.event.inputs.build || 'all' }}
          release-tag: ${{ github.event.inputs.version && format('v{0}', github.event.inputs.version) || '' }}
          min-rating: "7"
          draft: ${{ github.event.inputs.draft || 'false' }}
          prerelease: ${{ github.event.inputs.prerelease || 'false' }}
          provider: ${{ vars.AI_PROVIDER || 'opencode' }}
          model: ${{ vars.AI_MODEL || 'auto-free' }}
          api-key: ${{ secrets.AI_API_KEY || secrets.OPENCODE_API_KEY }}   # optional, enables AI release notes
          fallback-provider: ${{ vars.AI_FALLBACK_PROVIDER || 'opencode' }}
          fallback-model: ${{ vars.AI_FALLBACK_MODEL || 'auto-free' }}
          fallback-api-key: ${{ secrets.AI_API_KEY || secrets.OPENCODE_API_KEY }}
```

### Security gate (PR/push)

```yaml
name: Security
on: [push, pull_request]
permissions: {contents: read}
jobs:
  security:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: OseMine/workflows/.github/actions/security@main
        with:
          min-rating: "7"
          provider: ${{ vars.AI_PROVIDER || 'opencode' }}            # opencode | google | openai | mistral | anthropic | x | deepseek | groq | puter | ollama
          model: ${{ vars.AI_MODEL || 'auto-free' }}
          api-key: ${{ secrets.AI_API_KEY || secrets.OPENCODE_API_KEY }}
          fallback-provider: ${{ vars.AI_FALLBACK_PROVIDER || 'opencode' }}
          fallback-model: ${{ vars.AI_FALLBACK_MODEL || 'auto-free' }}
          fallback-api-key: ${{ secrets.AI_API_KEY || secrets.OPENCODE_API_KEY }}
          virustotal-api-key: ${{ secrets.VIRUSTOTAL_API_KEY }}   # optional
```

## AI providers

Every action that uses AI (security review, release notes, OpenCode automation)
exposes the same provider/model/fallback API keys pattern, **and every template
defaults them from repo variables** so you configure your AI once per repo:

| Variable | Purpose | Default |
|----------|---------|---------|
| `AI_PROVIDER` | Primary provider | `opencode` |
| `AI_MODEL` | Primary model | `auto-free` |
| `AI_FALLBACK_PROVIDER` | Fallback provider | `opencode` |
| `AI_FALLBACK_MODEL` | Fallback model | `auto-free` |
| `CI_LANGUAGE` | CI language (templates/ci.yml) | `auto` |

Inputs (set in the workflow or left to the vars above):

| Input | Description | Default |
|-------|-------------|---------|
| `provider` | Primary AI provider | `${{ vars.AI_PROVIDER || 'opencode' }}` |
| `model` | Primary model | `${{ vars.AI_MODEL || 'auto-free' }}` |
| `api-key` | API key for primary provider | `${{ secrets.AI_API_KEY || secrets.OPENCODE_API_KEY }}` |
| `fallback-provider` | Fallback provider | `${{ vars.AI_FALLBACK_PROVIDER || 'opencode' }}` |
| `fallback-model` | Fallback model | `${{ vars.AI_FALLBACK_MODEL || 'auto-free' }}` |
| `fallback-api-key` | API key for fallback | `${{ secrets.AI_API_KEY || secrets.OPENCODE_API_KEY }}` |

**Supported providers:** `custom`, `opencode`, `google`, `openai`, `mistral`,
`anthropic`, `x` (xAI/Grok), `deepseek`, `groq`, `puter`, `together`,
`cerebras`, `openrouter`, `huggingface`, `lmstudio` (local, no key), `ollama`
(local, no key).

Note: `auto`/`auto-free` only work with providers in the models.dev catalog
(`opencode` … `huggingface` above). `custom`, `puter`, `lmstudio` and `ollama`
require a concrete `provider/model` (e.g. `model: llama3` with `provider: ollama`).

Each provider maps to its own API key environment variable (`GOOGLE_API_KEY`,
`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.) — the actions handle the mapping
so you only set one `api-key` per provider.

### `custom` provider (any OpenAI-compatible API)

Use `provider: custom` to point at your own LLM API endpoint (self-hosted
gateway, vLLM, LM Studio, Azure OpenAI, an internal proxy, etc.). Supply the
connection details as inputs (or the corresponding `CUSTOM_*` vars):

| Input | Purpose |
|-------|---------|
| `custom-api-base` | Base URL, OpenAI-compatible, ending in `/v1` (required) |
| `custom-api-key` | API key `Authorization: Bearer <key>` (optional) |
| `custom-model` | Model id sent in the request (overrides `model`) |

So `provider: custom`, `model: my-model`, `custom-api-base: https://api.example.com/v1`,
`custom-api-key: ${{ secrets.CUSTOM_API_KEY }}` calls
`https://api.example.com/v1/chat/completions` with model `my-model`.

### `auto` / `auto-free` model selection

Instead of a concrete model id, `model` accepts two special values that the
actions resolve at runtime based on which API keys are configured:

| Value | Behavior |
|-------|----------|
| `auto` | Pick the best available provider (any tier), then its best free-or-flagship model discovered live from the models.dev catalog |
| `auto-free` | Same, but only consider providers with a generous free tier, and only discover zero-cost models |

**How it works** — there is no hardcoded model table. At run time the action:

1. Scans `AI_PROVIDERS` in preference order and picks the first provider whose
   API key is available (a provider you set explicitly with a key wins):
   `opencode` (keyless) → `groq` → `google` → `openrouter` → `mistral` →
   `cerebras` → `xai` → `deepseek` → `openai` → `anthropic` → `togetherai` →
   `huggingface`. `auto-free` skips paid-tiers (xai, deepseek, openai,
   anthropic, togetherai, huggingface).
2. Downloads `https://models.dev/api.json` once (cached in `RUNNER_TEMP`),
   filters the provider's models (agent-capable = support tool calls;
   `auto-free` keeps only zero-cost ones), ranks them with the same priority
   opencode itself uses (gpt-5 family → claude-sonnet-4 → big-pickle →
   gemini-3-pro, then newest release), and uses that `provider/model` for the
   run.

If nothing is available, the action falls back to the configured
`fallback-provider`/`fallback-model`, then to anonymous `opencode`. A provider
whose only models are paid or non-agent (e.g. groq speech) is skipped for
`auto-free` rather than run with a wrong model.

**Concrete models** are accepted too, in `provider/model` or bare `model-id`
(the `provider` input is prepended), e.g. `model: mixtral-8x7b` with
`provider: mistral`.

Recommended setup — create one repo secret per provider you use:

| Secret | Provider | Used by |
|--------|----------|---------|
| `AI_API_KEY` | Your preferred provider's key | opencode, security, release |
| `OPENCODE_API_KEY` | OpenCode (their API gateway) | fallback for all AI actions |
| `VIRUSTOTAL_API_KEY` | VirusTotal | security |
| `PUTER_AUTH_TOKEN` | Puter (needs a concrete `model`, not auto) | security, release |
| `CUSTOM_API_KEY` | Your own OpenAI-compatible API | all AI actions (provider: custom) |

`AI_API_KEY` (a single secret) is enough for every AI action — set it once and
the templates wire it everywhere, falling back to `OPENCODE_API_KEY` if you
prefer OpenCode's gateway instead.

The fallback ensures reliability — if the primary provider is down or has no
credits, the run continues with the fallback. The default `model: auto-free`
considers only free-tier providers, so AI features work even without any API
key (anonymous opencode). Set `AI_MODEL: auto` or a concrete model to
opt into paid providers.

### OpenCode automation

```yaml
name: OpenCode
on: {workflow_dispatch: {}, schedule: [{cron: "0 6 * * 1"}]}
permissions: {contents: write, issues: write, pull-requests: write}
jobs:
  opencode:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v7
        with: {fetch-depth: 0, persist-credentials: true}
      - uses: OseMine/workflows/.github/actions/opencode@main
        with:
          prompt: "Analyze this Rust project for dead code and suggest removals"
          provider: ${{ vars.AI_PROVIDER || 'opencode' }}
          model: ${{ vars.AI_MODEL || 'auto-free' }}
          api-key: ${{ secrets.AI_API_KEY || secrets.OPENCODE_API_KEY }}
          fallback-provider: ${{ vars.AI_FALLBACK_PROVIDER || 'opencode' }}
          fallback-model: ${{ vars.AI_FALLBACK_MODEL || 'auto-free' }}
          fallback-api-key: ${{ secrets.AI_API_KEY || secrets.OPENCODE_API_KEY }}
      - name: Commit changes (if any)
        shell: bash
        run: |
          if [ -n "$(git status --porcelain)" ]; then
            git add -A
            git commit -m "chore: opencode automation [skip ci]"
            git push origin HEAD
          else
            echo "no changes to commit"
          fi
```

## Available actions

| Action | Purpose | Primary language |
|--------|---------|-----------------|
| `ci` | Language auto-detect → lint + check + test | all |
| `release-all` | Meta/semver + builds + security gate + AI notes + GitHub release | all |
| `security` | Trivy + cargo-audit + npm audit + PHP lint + VirusTotal + AI review | all |
| `opencode` | Git identity + model fallback chain + AI task runner | all |
| `github-release` | Changelog + softprops release (SHA256SUMS, manifest) | all |
| `setup` | System dependencies (Linux) | all |
| `setup-rust` | Rust toolchain + ALSA (Linux) | rust / tauri |
| `setup-python` | Python 3.12 | python |
| `setup-node` | Node 22 + npm | node |
| `lint` | cargo fmt --check | rust |
| `checks` | cargo clippy + test | rust |
| `bundle` | Tauri bundle per OS matrix | tauri |
| `installer` | Inno Setup Windows installer | tauri |
| `python-build` | sdist + wheel + smoke test | python |
| `python-setup` | Python 3.12 + deps | python |
| `pyinstaller` | PyInstaller one-file binary build | python |
| `pypi-publish` | OIDC twine trusted publishing | python |
| `cargo-publish` | Idempotent crates.io publish | rust |
| `flutter-setup` | Flutter SDK + native deps | flutter |
| `flutter-build` | APK + AAB + unsigned IPA + SHA256SUMS | flutter |
| `kmp-setup` | Android SDK/NDK + Gradle cache | kmp |
| `kmp-android-build` | Signed APK | kmp |
| `kmp-ios-build` | Signed IPA (Xcode) | kmp |
| `android-build` | Native Android APK | android |
| `ios-build` | Native iOS unsigned IPA | ios |
| `php-lint` | PHP CodeSniffer / Psalm / PHPStan | php |
| `shell-lint` | shellcheck across all .sh files | bash |
| `nextcloud-app` | Nextcloud app packaging | nextcloud |

## Templates

Thin copy-paste workflows in `templates/` — set `language:` or `prompt:` and commit.
AI provider/model are configurable per repo via `vars` (`AI_PROVIDER`,
`AI_MODEL`, `AI_API_KEY`, `AI_FALLBACK_PROVIDER`, `AI_FALLBACK_MODEL`) and repo
secrets (`AI_API_KEY`, `OPENCODE_API_KEY`).

```
templates/
  ci.yml              ← push/PR quality gate (language auto-detect per repo variable CI_LANGUAGE)
  release.yml         ← workflow_dispatch release (version auto-detect, prerelease/draft/build inputs)
  security.yml        ← Trivy + audits + AI + VirusTotal
  opencode.yml        ← generic AI automation
  opencode-review.yml ← PR review + merge/proceed + branch cleanup
  opencode-todo-issues.yml ← sync open issues to todo.md
  nightly.yml         ← scheduled checks (reuses `ci`)
  codeql.yml          ← CodeQL static analysis
  deploy-web.yml      ← Vercel/web deploy
```

## Repository layout

```
.github/
  actions/   ← all composite action logic lives here (the library)
  workflows/
    library-ci.yml  ← self-tests this repo's actions YAML + bash syntax + JS
templates/  ← thin per-project workflows (copy-paste starters)
README.md
LICENSE
```

## Getting started

### 1. Publish this repo

This repo is already wired for `OseMine/workflows@main`. Push to GitHub and
templates work out of the box.

### 2. Forking?

If you fork this repo (e.g. into your own org), replace `OseMine/workflows`
with your GitHub `owner/repo` everywhere. A single sed for the whole repo:

```bash
find . -name '*.yml' -exec sed -i 's|OseMine/workflows|OWNER/REPO|g' {} +
```

### 3. Copy workflows into your project

Copy the appropriate `.yml` files from `templates/` into your project's
`.github/workflows/` and commit.

### 4. Set up secrets

In your project's repo, configure the secrets referenced in the workflows
(the templates list them). The most common are:

- `OPENCODE_API_KEY` — enables AI review + AI release notes
- `PUTER_AUTH_TOKEN` — token-gated Puter models
- `VIRUSTOTAL_API_KEY` — artifact reputation scanning

### 5. Update actions centrally

When you improve or fix a composite action in this library, push a commit
to `main` (or a version tag). Every project pointing at `@main` (or the tag)
gets the fix automatically — no per-project PRs required.

## Multi-OS builds

The composite `ci` and `release-all` actions run on a single runner. For
cross-OS builds (Tauri bundles, Rust tests on Linux + macOS + Windows), mount
a matrix in the thin caller and call the action per OS:

```yaml
jobs:
  ci:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v7
      - uses: OseMine/workflows/.github/actions/ci@main
        with:
          language: tauri
```

## License

MIT