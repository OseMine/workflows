#!/usr/bin/env bash
# Shared build logic for gha-workflows composite build actions.
# Source this file from a run: block, then call the bb_* helpers.
# Requires bash 4+ (standard on GitHub hosted runners).

# Ensure a clean output directory exists. Prints the resolved path.
#   $1 = desired output dir (default: dist)
#   $2 = clear existing contents first (0/1, default 1)
bb_outdir() {
  local dir="${1:-dist}" clear="${2:-1}"
  if [ "$clear" = "1" ]; then
    rm -rf "$dir"
  fi
  mkdir -p "$dir"
  echo "$dir"
}

# Copy artifacts matching globs into an output directory.
# Glob precedence: `--include` globs (recursive find) then `--root` globs
# (single-level). Paths are relative to the working directory.
#   bb_collect <outdir> <glob> [glob...]
bb_collect() {
  local out="$1"; shift
  [ -n "$out" ] || out=dist
  mkdir -p "$out" || return 1
  local g founds any=0 flatten="${BB_FLATTEN:-1}"
  for g in "$@"; do
    [ -n "$g" ] || continue
    echo "::debug::bb_collect glob: $g"
    if [ -d "$g" ]; then
      # explicit directory -> copy everything inside
      find "$g" -type f \( -name '*.exe' -o -name '*.dll' -o -name '*.dylib' \
        -o -name '*.so' -o -name '*.a' -o -name '*.lib' -o -name '*.jar' \
        -o -name '*.war' -o -name '*.apk' -o -name '*.aab' -o -name '*.ipa' \
        -o -name '*.deb' -o -name '*.rpm' -o -name '*.AppImage' -o -name '*.dmg' \
        -o -name '*.msi' -o -name '*.zip' -o -name '*.tar.gz' -o -name '*.whl' \
        -o -name '*.exe' -o -perm -u+x -type f \) 2>/dev/null -print0 |
        while IFS= read -r -d '' f; do
          bb_copy_one "$f" "$out" "$flatten"
        done
      any=1
      continue
    fi
    while IFS= read -r -d '' f; do
      bb_copy_one "$f" "$out" "$flatten"
      any=1
    done < <(find . -path "./$g" -not -path "./$out/*" 2>/dev/null -print0 2>/dev/null || true)
    # also try it as a plain relative filename
    if [ "$any" = "0" ]; then
      bb_copy_one "$g" "$out" "$flatten" && any=1
    fi
  done
  [ "$any" = "1" ] || echo "::warning::bb_collect: no artifacts matched"
}

bb_copy_one() {
  local f="$1" out="$2" flatten="$3"
  [ -f "$f" ] || return 1
  if [ "$flatten" = "1" ]; then
    cp -n "$f" "$out/" 2>/dev/null && echo "  collected: $(basename "$f")"
  else
    cp -n --parents "$f" "$out/" 2>/dev/null && echo "  collected: $f"
  fi
}

# Write SHA256SUMS.txt + a JSON manifest for an output dir.
#   bb_checksums <dir>
bb_checksums() {
  local out="${1:-dist}"
  [ -d "$out" ] || return 1
  if command -v sha256sum >/dev/null 2>&1; then
    ( cd "$out" && sha256sum * > SHA256SUMS.txt 2>/dev/null; echo "SHA256SUMS.txt updated" )
  else
    echo "::warning::sha256sum not available - skipping checksums"
  fi
}

# Print whether a command/binary exists on PATH.
#   bb_have <cmd>
bb_have() {
  command -v "$1" >/dev/null 2>&1
}

# Run a build command inside a group with timing.
#   bb_run <name> <cmd...>
bb_run() {
  local name="$1"; shift
  echo "::group::$name"
  "$@"
  local rc=$?
  echo "::endgroup::"
  return $rc
}

# Resolve the actual build command: prefer an explicit override, else default.
#   $1 = override command (may be empty)
#   $2+ = default command words
# Prints the command to eval.
bb_cmd() {
  local override="$1"; shift
  if [ -n "$override" ]; then
    echo "$override"
  else
    printf '%q ' "$@"
  fi
}