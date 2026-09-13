import { relative, resolve } from "node:path";

/** Evidence URIs use the repository root, independently of where the report is written. */
export function repositoryArtifact(path: string, root = process.cwd()): string {
  const uri = relative(resolve(root), resolve(root, path)).replaceAll("\\", "/");
  if (
    !/^[\w.-][\w./-]*$/u.test(uri) ||
    uri.split("/").some((part) => part === ".." || part === "." || part === "")
  )
    throw new Error("artifact_must_be_a_repository_relative_path");
  return uri;
}
