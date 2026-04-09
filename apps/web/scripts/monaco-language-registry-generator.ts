import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function sourceHasRegistrationBlock(source: string): boolean {
  return (
    source.includes("languages.register(") ||
    source.includes("registerLanguage(")
  );
}

export function extraContributionFilesForRoot(root: string): string[] {
  return readdirSync(root)
    .map((dirName) => join(root, dirName, "monaco.contribution.js"))
    .filter((file) => {
      try {
        const source = readFileSync(file, "utf8");
        return sourceHasRegistrationBlock(source);
      } catch {
        return false;
      }
    })
    .sort((left, right) => left.localeCompare(right));
}
