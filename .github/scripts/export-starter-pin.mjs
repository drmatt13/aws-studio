import { appendFileSync, readFileSync } from "node:fs";

const { commit } = JSON.parse(readFileSync(new URL("../../scripts/starters.json", import.meta.url), "utf8"));
if (typeof commit !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) {
  throw new Error("The starter selection must pin an exact Git commit.");
}
appendFileSync(process.env.GITHUB_OUTPUT, `commit=${commit}\n`);
