import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import test from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dependabotConfig = readFileSync(resolve(__dirname, "../../.github/dependabot.yml"), "utf8");

test("dependabot limits routine update noise across each ecosystem", () => {
  const limitMatches = dependabotConfig.match(/open-pull-requests-limit:\s*3/g) ?? [];

  assert.equal(limitMatches.length, 3);
  assert.match(dependabotConfig, /frontend-runtime-minor-patch:/);
  assert.match(dependabotConfig, /backend-runtime-minor-patch:/);
  assert.match(dependabotConfig, /contract-minor-patch:/);
});

test("dependabot ignores framework-critical major version bumps", () => {
  for (const dependency of [
    "next",
    "react",
    "react-dom",
    "express",
    "express-rate-limit",
    "prisma",
    "@prisma/client",
    "bullmq",
    "ioredis",
    "@stellar/stellar-sdk",
    "soroban-sdk",
  ]) {
    assert.match(dependabotConfig, new RegExp(`dependency-name: "${dependency.replace("/", "\\/")}"`));
  }

  const majorIgnoreMatches = dependabotConfig.match(/version-update:semver-major/g) ?? [];
  assert.ok(majorIgnoreMatches.length >= 12);
});

test("dependabot holds back major bumps for Tailwind packages grouped together", () => {
  // tailwindcss and @tailwindcss/* share the frontend-runtime-minor-patch group,
  // so both must also share the semver-major ignore rule.
  for (const dependency of ["tailwindcss", "@tailwindcss/*"]) {
    const escaped = dependency.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    assert.match(
      dependabotConfig,
      new RegExp(`dependency-name: "${escaped}"\\s*\\n\\s*update-types: \\["version-update:semver-major"\\]`),
    );
  }
});
