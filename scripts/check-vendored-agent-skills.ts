import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

type SkillLockEntry = {
  computedHash: string;
  ref?: string;
  skillPath?: string;
  source: string;
  sourceType: string;
};

type SkillLockFile = {
  skills: Record<string, SkillLockEntry>;
  version: number;
};

const vendoredSkills = [
  { name: "archify", source: "tt-a1i/archify", skillPath: "archify/SKILL.md" },
  { name: "typesafe-ai", source: "typesafe-ai/skills", skillPath: "skills/typesafe-ai/SKILL.md" },
] as const;
const lockPath = resolve("skills-lock.json");

async function collectFiles(
  baseDirectory: string,
  currentDirectory: string,
  files: Array<{ content: Buffer; relativePath: string }>,
): Promise<void> {
  const entries = await readdir(currentDirectory, { withFileTypes: true });

  await Promise.all(
    entries.map(async (entry) => {
      const fullPath = resolve(currentDirectory, entry.name);

      if (entry.isDirectory()) {
        if (entry.name === ".git" || entry.name === "node_modules") return;
        await collectFiles(baseDirectory, fullPath, files);
        return;
      }

      if (!entry.isFile()) return;

      const content = await readFile(fullPath);
      const relativePath = relative(baseDirectory, fullPath).split(sep).join("/");
      files.push({ content, relativePath });
    }),
  );
}

async function computeSkillFolderHash(directory: string): Promise<string> {
  const files: Array<{ content: Buffer; relativePath: string }> = [];
  await collectFiles(directory, directory, files);
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.relativePath);
    hash.update(file.content);
  }

  return hash.digest("hex");
}

function verifyArchifyRuntime(): void {
  execFileSync(process.execPath, [resolve(".agents/skills/archify/bin/archify.mjs"), "doctor"], {
    encoding: "utf8",
    stdio: "pipe",
  });
}

export async function verifyVendoredAgentSkills(): Promise<void> {
  const lock = JSON.parse(await readFile(lockPath, "utf8")) as SkillLockFile;
  for (const skill of vendoredSkills) {
    const entry = lock.skills[skill.name];
    if (!entry) {
      throw new Error(`${skill.name} is missing from skills-lock.json`);
    }
    if (entry.source !== skill.source || entry.sourceType !== "github") {
      throw new Error(`Unexpected ${skill.name} source in skills-lock.json`);
    }
    if (!entry.ref || entry.skillPath !== skill.skillPath) {
      throw new Error(`${skill.name} must be pinned to an explicit upstream ref and skill path`);
    }
    if (skill.name === "typesafe-ai" && !/^[a-f0-9]{40}$/u.test(entry.ref)) {
      throw new Error("typesafe-ai must be pinned to a full upstream commit SHA");
    }

    const actualHash = await computeSkillFolderHash(resolve(".agents/skills", skill.name));
    if (actualHash !== entry.computedHash) {
      throw new Error(
        `${skill.name} vendored content does not match skills-lock.json: expected ${entry.computedHash}, got ${actualHash}`,
      );
    }
  }

  verifyArchifyRuntime();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await verifyVendoredAgentSkills();
    console.log("Vendored agent skills match skills-lock.json and pass their runtime check.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
