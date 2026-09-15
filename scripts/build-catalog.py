#!/usr/bin/env python3
"""Generate catalog.json from every action.yml + templates/*.yml.

The web workflow builder fetches catalog.json (raw.githubusercontent,
@main) at runtime, so the UI stays current with the library with no
redeploy: this file is the single source of truth that script keeps fresh.

Usage: python3 scripts/build-catalog.py   (run from repo root)
"""
import json
import os
import re
import sys

try:
    import yaml
except ImportError:
    print("PyYAML required: pip install pyyaml", file=sys.stderr)
    sys.exit(1)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SECRET_HINT = re.compile(r"(api.?key|password|token|keystore|secret)", re.I)
BOOLEAN_HINT = re.compile(r"^(true|false)$", re.I)


def scan_actions():
    actions = []
    base = os.path.join(ROOT, ".github", "actions")
    for name in sorted(os.listdir(base)):
        adir = os.path.join(base, name)
        yml = os.path.join(adir, "action.yml")
        if not os.path.isfile(yml):
            continue
        try:
            data = yaml.safe_load(open(yml, encoding="utf-8"))
        except Exception as e:
            print("WARN", yml, e)
            continue
        inputs = []
        for key, val in (data.get("inputs") or {}).items():
            booleanish = BOOLEAN_HINT.match(str(val.get("default", "")))
            inputs.append(
                {
                    "id": key,
                    "description": (val.get("description") or "").strip(),
                    "default": val.get("default") or "",
                    "required": bool(val.get("required", False)),
                    "secret_like": bool(SECRET_HINT.search(key)),
                    "boolean": bool(booleanish),
                }
            )
        outputs = []
        for key, val in (data.get("outputs") or {}).items():
            outputs.append(
                {
                    "id": key,
                    "description": (val.get("description") or "").strip(),
                }
            )
        actions.append(
            {
                "id": name,
                "name": data.get("name") or name,
                "description": re.sub(r"\s+", " ", (data.get("description") or "").strip()),
                "uses": f"OseMine/workflows/.github/actions/{name}@v2",
                "inputs": inputs,
                "outputs": outputs,
                "inputs_count": len(inputs),
            }
        )
    return actions


def scan_templates():
    templates = []
    tdir = os.path.join(ROOT, "templates")
    for name in sorted(os.listdir(tdir)):
        path = os.path.join(tdir, name)
        if not name.endswith((".yml", ".yaml")) or not os.path.isfile(path):
            continue
        raw = open(path, encoding="utf-8").read()
        desc = ""
        m = re.match(r"\s*#+\s*(.+?)[\r\n]", raw)
        if m:
            desc = m.group(1).strip().rstrip(".")
        data = {}
        try:
            data = yaml.safe_load(raw) or {}
        except Exception:
            pass
        templates.append(
            {
                "id": os.path.splitext(name)[0],
                "file": name,
                "name": (data.get("name") or os.path.splitext(name)[0]).strip(),
                "description": desc,
                "content": raw,
            }
        )
    return templates


def main():
    catalog = {
        "schema": 1,
        "source": "OseMine/workflows",
        "actions": scan_actions(),
        "templates": scan_templates(),
    }
    out = os.path.join(ROOT, "catalog.json")
    json.dump(catalog, open(out, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
    print(f"wrote {out}: {len(catalog['actions'])} actions, "
          f"{len(catalog['templates'])} templates")


if __name__ == "__main__":
    main()