"""Regression matrix for require-sfw.py. Run: python3 scripts/hooks/test_require_sfw.py"""
import json
import subprocess
import sys

HOOK = sys.argv[1] if len(sys.argv) > 1 else __file__.replace('test_require_sfw.py', 'require-sfw.py')
cases = [
    ("pnpm add lodash", True),
    ("cd foo && pnpm add lodash", True),
    ("CI=true pnpm update", True),
    ("pnpm up", True),
    ("pnpm dlx create-thing", True),
    ("pnpm create vite", True),
    ("pnpm --dir packages/app add lodash", True),
    ("pnpm --filter web add lodash", True),
    ("pnpm --filter=web add lodash", True),
    ("command pnpm add lodash", True),
    ("env CI=true pnpm add lodash", True),
    ("env -u NODE_OPTIONS pnpm add lodash", True),
    ("pnpm install some-pkg", True),
    ("pnpm install -D some-pkg", True),
    ("pnpm i -D some-pkg", True),
    ("pnpm install --save-dev some-pkg", True),
    ("cd foo\npnpm add lodash", True),
    ("echo start\ncargo add serde", True),
    ("true\nbun add x", True),
    ("echo hi & pnpm add evil", True),
    ("echo $(pnpm add lodash)", True),
    ("true `cargo install cargo-edit`", True),
    ("diff <(pnpm dlx thing) /dev/null", True),
    ("echo $(sfw pnpm add lodash)", False),
    ("pnpm \\\nadd lodash", True),
    ("echo $(pnpm \\\n  add lodash)", True),
    ("cargo add serde", True),
    ("cargo install cargo-edit", True),
    ("cargo update", True),
    ("cargo +stable install cargo-edit", True),
    ("cargo --config net.git-fetch-with-cli=true install cargo-edit", True),
    ("bun install", True),
    ("bun run dev", True),
    ("bunx create-thing", True),
    ("yarn add x", True),
    ("npm install lodash", True),
    ("npm ci", True),
    ("sfw npm install lodash", True),
    ("sfw bun add lodash", True),
    ("npx -y skills update --project --yes", True),
    ("npm exec cowsay hi", True),
    ("npm create vite", True),
    ("npm init vite", True),
    ("pnpm audit --fix", True),
    ("pnpm audit --fix=update", True),
    ("sfw pnpm add lodash", False),
    ("sfw cargo add serde", False),
    ("sfw npx -y skills@1.5.15 update --project --yes", False),
    ("sfw pnpm audit --fix", False),
    ("npm i -g sfw", False),
    ("npm install --global sfw@latest", False),
    ("npm install --global sfw pnpm", True),
    ("npm install --global pnpm@11", True),
    ("npm install --location global pnpm@11", True),
    ("npm install --location global sfw@latest", False),
    ("sfw npm install --global pnpm@11", False),
    ("pnpm install", True),
    ("pnpm install --no-frozen-lockfile", True),
    ("pnpm install --offline", True),
    ("pnpm install --frozen-lockfile=false", True),
    ("pnpm install --frozen-lockfile --lockfile=false", True),
    ("pnpm install --frozen-lockfile --fix-lockfile", True),
    ("pnpm install lodash --frozen-lockfile", True),
    ("pnpm install --frozen-lockfile", False),
    ("pnpm --dir packages/app install --frozen-lockfile", False),
    ("pnpm i --offline", True),
    ("sfw pnpm install", False),
    ("sfw pnpm --filter web add lodash", False),
    ("sfw cargo +stable install cargo-edit", False),
    ("sfw npm create vite", False),
    ("sfw pnpm install -D some-pkg", False),
    ("cd foo\npnpm install --frozen-lockfile", False),
    ("pnpm test", False),
    ("pnpm audit", False),
    ("pnpm tauri:dev", False),
    ("cargo build", False),
    ("cargo test --manifest-path src-tauri/Cargo.toml", False),
    ("cargo fetch", False),
    ("git commit -m 'pnpm add docs'", False),
    ("echo pnpm add x", False),
    ("rg -n 'cargo add' spec/", False),
    ("make verify", False),
]
fails = 0
for cmd, expect_blocked in cases:
    payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": cmd}})
    p = subprocess.run(
        ["python3", HOOK], input=payload, capture_output=True, text=True
    )
    blocked = p.returncode == 2
    if blocked != expect_blocked:
        fails += 1
        print(f"FAIL {cmd!r}: blocked={blocked} expected={expect_blocked}")
print(f"{len(cases) - fails}/{len(cases)} cases pass")
sys.exit(1 if fails else 0)
