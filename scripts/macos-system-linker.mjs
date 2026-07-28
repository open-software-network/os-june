#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function rewriteMacOSLinkerArgs(args) {
  return args.flatMap((argument) =>
    argument === "-ldispatch" ? ["-framework", "System"] : [argument],
  );
}

// CC-convention values may carry flags ("ccache clang", "clang -arch arm64");
// spawnSync needs the command and its arguments separated.
export function splitLinkerCommand(value) {
  const [command, ...args] = value.split(/\s+/).filter(Boolean);
  return { command: command || "/usr/bin/clang", args };
}

function main() {
  const { command, args } = splitLinkerCommand(
    process.env.JUNE_MACOS_SYSTEM_LINKER || "/usr/bin/clang",
  );
  const result = spawnSync(command, [...args, ...rewriteMacOSLinkerArgs(process.argv.slice(2))], {
    stdio: "inherit",
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.signal) {
    process.kill(process.pid, result.signal);
    return;
  }
  process.exit(result.status ?? 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
