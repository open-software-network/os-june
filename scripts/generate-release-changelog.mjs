import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import process from "node:process";

const RELEASE_SUBJECT_RE = /^release: v(\d+\.\d+\.\d+)(?:\b|[^0-9])/;
const FIELD_SEPARATOR = "\x1f";
const RECORD_SEPARATOR = "\x1e";

export function parsePreviousReleaseLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  const [hash, subject] = trimmed.split(FIELD_SEPARATOR);
  const match = RELEASE_SUBJECT_RE.exec(subject ?? "");
  if (!hash || !match) return undefined;
  return { hash, version: match[1] };
}

export function findPreviousRelease(log) {
  return log.split("\n").map(parsePreviousReleaseLine).find(Boolean);
}

export function parseGitLogRecords(log) {
  return log
    .split(RECORD_SEPARATOR)
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [hash = "", subject = "", body = ""] =
        record.split(FIELD_SEPARATOR);
      return {
        hash: hash.trim(),
        subject: subject.trim(),
        body: body.trim(),
      };
    })
    .filter((entry) => entry.hash && entry.subject);
}

export function releaseNoteTitleForCommit(commit) {
  const release = RELEASE_SUBJECT_RE.exec(commit.subject);
  if (release) return undefined;

  const merge = /^Merge pull request #(\d+) from .+/.exec(commit.subject);
  if (merge) {
    const title = commit.body
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean);
    return title ? `${title} (#${merge[1]})` : undefined;
  }

  return commit.subject;
}

export function formatChangelog({ version, previousVersion, commits }) {
  const lines = [`## June v${version}`, ""];
  if (previousVersion) {
    lines.push(`Changes since v${previousVersion}.`, "");
  } else {
    lines.push("Initial release changelog.", "");
  }

  const titles = commits
    .map(releaseNoteTitleForCommit)
    .filter((title) => title && !RELEASE_SUBJECT_RE.test(title));

  lines.push("### Changes");
  if (titles.length === 0) {
    lines.push("- No source changes recorded since the previous release.");
  } else {
    for (const title of titles) {
      lines.push(`- ${title}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function previousRelease() {
  const output = git([
    "log",
    "--first-parent",
    `--format=%H${FIELD_SEPARATOR}%s`,
    "HEAD",
  ]);
  return findPreviousRelease(output);
}

function commitsSince(hash) {
  const range = hash ? `${hash}..HEAD` : "HEAD";
  const output = git([
    "log",
    "--first-parent",
    "--reverse",
    `--format=%H${FIELD_SEPARATOR}%s${FIELD_SEPARATOR}%b${RECORD_SEPARATOR}`,
    range,
  ]);
  return parseGitLogRecords(output);
}

async function main() {
  const version = process.argv[2];
  const outputPath = process.argv[3];
  if (!version || !outputPath) {
    throw new Error(
      "Usage: node scripts/generate-release-changelog.mjs <version> <output-path>",
    );
  }

  const release = previousRelease();
  const changelog = formatChangelog({
    version,
    previousVersion: release?.version,
    commits: commitsSince(release?.hash),
  });
  await writeFile(outputPath, changelog);
  process.stdout.write(changelog);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
