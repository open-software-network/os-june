# Agent E2E QA run: onboarding preview permissions and trial

Environment:
- Date: 2026-06-26
- Worktree/branch: `/Users/junhohong/code/open-software/os-june-agent-e2e-qa`, `codex/agent-e2e-qa`
- Commit: `2cb4248`
- Command: `pnpm exec vite --host 127.0.0.1 --port 1422 --strictPort`
- Surface: Chrome plus Computer Use against web preview
- URL: `http://127.0.0.1:1422/onboarding-preview.html?step=permissions&perms=missing&theme=dark`
- Data mode: local stubbed onboarding preview. No live OS Accounts, Stripe checkout, native Tauri commands, audio hardware, or macOS permission prompts.

Checks:
- PASS - Preview server is reachable - `curl -I` returned `HTTP/1.1 200 OK` for the onboarding preview URL.
- PASS - Permissions step starts blocked - Computer Use observed `Setup progress: step 2 of 4`, the heading `Let June listen and type`, Microphone, Accessibility, and System audio rows, and a disabled `Continue` button.
- PASS - Stub permission grants unlock the step - after clicking `Allow accessibility access` and waiting for the preview's simulated permission events, Computer Use observed all rows without allow buttons and an enabled `Continue` button.
- PASS - Trial step is reachable - clicking `Continue` advanced to `Setup progress: step 3 of 4`, the heading `Start your free trial`, the `Start free trial` button, and `Due today: $0`.
- PASS - Stub trial activation completes - clicking `Start free trial` moved through `Waiting for trial...` with `Reopen`, then reached `You're good to go` with the privacy summary and a `Continue` button.
- PASS - Practice step is reachable - clicking `Continue` advanced to `Setup progress: step 4 of 4`, the heading `Talk to June`, the shortcut label `fn`, `Change key`, the prompt field `Tell June what to do...`, and a disabled `Start using June` button.
- PASS - Deterministic support check - `pnpm test -- src/test/onboarding.test.tsx` passed 28 tests.
- PASS - Skill structure check - `python3 /Users/junhohong/.codex/skills/.system/skill-creator/scripts/quick_validate.py .agents/skills/agent-e2e-qa` returned `Skill is valid!`.

Artifacts:
- Computer Use screenshots were captured during this run for the permissions, trial, activated trial, and practice states. They are not committed as binary artifacts to keep the PR docs-only.
- Terminal evidence is summarized above from the live run and supporting commands.

Gaps:
- The in-app Browser surface was unavailable in this Codex session (`Browser is not available: iab`), so this run used Chrome plus Computer Use for visible state instead.
- No native Tauri app, WKWebView, tray, menu bar, global hotkey, real microphone, real system-audio capture, OS permission prompt, OS Accounts login, or live Stripe checkout was exercised.
- The Chrome window had the Agentation overlay visible. It did not block the onboarding controls used in this pass, but it would be disabled for pixel-perfect visual QA.
