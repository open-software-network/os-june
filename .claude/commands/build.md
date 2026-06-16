---
description: "Implement a repo feature or bug fix in a worktree, open a PR, and run the review loop"
argument-hint: "<feature, bug, screenshot, PR comment, or task prompt>"
---

# Build

Use the `repo-build-pr` skill.

Build prompt:

```text
$ARGUMENTS
```

Follow the skill exactly:

1. Study the prompt and relevant repo context before editing.
2. Create one or more dedicated worktrees based on task complexity.
3. Implement the feature, bug fix, or investigation result with focused validation.
4. Open a draft PR.
5. Wait for Greptile and Codex review when practical.
6. Address only feedback that is relevant and technically correct.
7. Request final Greptile and Codex review.
8. Mark the PR ready for review once there are no known blockers.
