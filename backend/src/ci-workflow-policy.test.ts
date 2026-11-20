import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import test from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const workflowsDir = resolve(__dirname, "../../.github/workflows");

// Workflows that run on pull requests. Each job must cap its runtime so a hung
// process cannot run until GitHub's multi-hour default job timeout.
const pullRequestWorkflows = ["backend.yml", "frontend.yml", "e2e.yml", "contract.yml"];

test("every pull request CI job sets timeout-minutes", () => {
  for (const workflow of pullRequestWorkflows) {
    const content = readFileSync(resolve(workflowsDir, workflow), "utf8");
    const jobs = content.match(/^ {4}runs-on:/gm) ?? [];
    const timeouts = content.match(/^ {4}timeout-minutes: \d+$/gm) ?? [];

    assert.ok(jobs.length > 0, `${workflow} should define at least one job`);
    assert.equal(timeouts.length, jobs.length, `${workflow}: every job should set timeout-minutes`);
  }
});
