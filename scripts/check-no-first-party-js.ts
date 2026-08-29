import { execFileSync } from "node:child_process";

const vendoredJavaScriptPrefixes = [".agents/skills/archify/"] as const;

const trackedFiles = execFileSync(
  "git",
  ["ls-files", "-z", "--", "*.js", "*.mjs", "*.cjs", "*.jsx"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean)
  .filter(
    (file) => !vendoredJavaScriptPrefixes.some((prefix) => file.startsWith(prefix)),
  )
  .sort();

if (trackedFiles.length > 0) {
  console.error("Tracked first-party JavaScript source/config is forbidden after Phase 2.5:");
  for (const file of trackedFiles) console.error(` - ${file}`);
  process.exitCode = 1;
} else {
  console.log("No tracked first-party JavaScript source/config files found.");
}
