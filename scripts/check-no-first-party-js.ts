import { execFileSync } from "node:child_process";

const trackedFiles = execFileSync(
  "git",
  ["ls-files", "-z", "--", "*.js", "*.mjs", "*.cjs", "*.jsx"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean)
  .sort();

if (trackedFiles.length > 0) {
  console.error("Tracked first-party JavaScript source/config is forbidden after Phase 2.5:");
  for (const file of trackedFiles) console.error(` - ${file}`);
  process.exitCode = 1;
} else {
  console.log("No tracked first-party JavaScript source/config files found.");
}
