import { appendFileSync, readFileSync } from "node:fs";

const { commit, repository } = JSON.parse(readFileSync(new URL("../../scripts/starters.json", import.meta.url), "utf8"));
if (typeof commit !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) {
  throw new Error("The starter selection must pin an exact Git commit.");
}
const slug = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\.git$/.exec(repository)?.[1];
if (!slug) throw new Error("The starter selection must name a GitHub repository.");
appendFileSync(process.env.GITHUB_OUTPUT, `repository=${slug}\ncommit=${commit}\n`);
