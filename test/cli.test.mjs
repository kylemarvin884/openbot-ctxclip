import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { VERSION } from "../src/condense.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const cli = path.join(root, "src", "cli.mjs");

function run(args, options = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: options.cwd ?? root,
    input: options.input,
    encoding: "utf8",
    timeout: 60000,
    windowsHide: true,
  });
}

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ctxclip-${label}-`));
}

function noisyLog(count, width = 40) {
  const lines = [];
  for (let i = 0; i < count; i++) lines.push(`test entry ${i} pass ${"x".repeat(width)}`);
  lines.push("FAIL src/some.test.ts:12:4 > keeps the failure");
  lines.push("Tests  1 failed | 999 passed (1000)");
  return `${lines.join("\n")}\n`;
}

test("--version prints the package version", () => {
  const result = run(["--version"]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), VERSION);
});

test("unknown command exits 2 with usage", () => {
  const result = run(["nope"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown|未知命令/);
});

test("run without a command is a usage error", () => {
  const result = run(["run", "--max-chars=1000"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage|用法/);
});

test("filter condenses a file, keeps failures, and prints a receipt", () => {
  const dir = tempDir("filter");
  const file = path.join(dir, "build.log");
  fs.writeFileSync(file, noisyLog(400), "utf8");

  const result = run(["filter", file]);
  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes("FAIL src/some.test.ts:12:4"), "failure line survives");
  assert.match(result.stdout, /\[ctxclip\] .* lines omitted/);
  assert.match(result.stderr, /^ctxclip: .*smaller/);
  assert.ok(result.stdout.length < 2000, `stdout is ${result.stdout.length} chars`);
});

test("filter reads stdin when the source is -", () => {
  const result = run(["filter", "-"], { input: noisyLog(300) });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /\[ctxclip\]/);
  assert.match(result.stderr, /stdin/);
});

test("filter --report writes machine-readable stats", () => {
  const dir = tempDir("report");
  const file = path.join(dir, "build.log");
  const report = path.join(dir, "stats.json");
  fs.writeFileSync(file, noisyLog(250), "utf8");

  const result = run(["filter", file, `--report=${report}`]);
  assert.equal(result.status, 0);

  const stats = JSON.parse(fs.readFileSync(report, "utf8"));
  assert.equal(stats.command, "filter");
  assert.equal(stats.output.lines.input, 252);
  assert.ok(stats.output.reductionPercent > 50);
  assert.equal(stats.output.lines.kept + stats.output.dropped.total, stats.output.lines.input);
});

test("filter honours --max-chars", () => {
  const dir = tempDir("budget");
  const file = path.join(dir, "build.log");
  fs.writeFileSync(file, noisyLog(500), "utf8");

  const result = run(["filter", file, "--max-chars=900"]);
  assert.equal(result.status, 0);
  assert.ok(result.stdout.length <= 950, `stdout is ${result.stdout.length} chars`);
});

test("run wraps a command, preserves its exit code, and spills the full output", () => {
  const dir = tempDir("run");
  const result = run(["run", "--", process.execPath, path.join(here, "fixtures", "emit.mjs"), "7", "150"], { cwd: dir });

  assert.equal(result.status, 7, "child exit code is passed through");
  assert.match(result.stdout, /error: fixture failure/);
  assert.match(result.stderr, /exit 7/);

  const spillDir = path.join(dir, ".ctxclip");
  const [runName] = fs.readdirSync(spillDir);
  const full = fs.readFileSync(path.join(spillDir, runName, "stdout.log"), "utf8");
  assert.equal(full.split("\n").length, 152, "spill file holds every line");
  assert.ok(full.includes("test entry 149"));
});

test("run condenses stderr separately and reports it", () => {
  const dir = tempDir("run-stderr");
  const result = run(
    ["run", "--", process.execPath, path.join(here, "fixtures", "emit.mjs"), "0", "20", "noisy-stderr"],
    { cwd: dir },
  );

  assert.equal(result.status, 0);
  assert.match(result.stderr, /ctxclip: stderr/);
  assert.match(result.stderr, /warning: stderr noise 39/, "last stderr line is kept");
});

test("run --no-spill writes nothing to disk", () => {
  const dir = tempDir("no-spill");
  const result = run(["run", "--no-spill", "--", process.execPath, path.join(here, "fixtures", "emit.mjs"), "0", "30"], {
    cwd: dir,
  });

  assert.equal(result.status, 0);
  assert.equal(fs.existsSync(path.join(dir, ".ctxclip")), false);
  assert.match(result.stderr, /--no-spill/);
});

test("run --quiet suppresses the receipt but keeps the condensed output", () => {
  const dir = tempDir("quiet");
  const result = run(["run", "--quiet", "--no-spill", "--", process.execPath, path.join(here, "fixtures", "emit.mjs"), "0", "30"], {
    cwd: dir,
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr.trim(), "");
  assert.match(result.stdout, /\[ctxclip\]/);
});

test("run drops markers for timestamps but keeps the full log address", () => {
  const dir = tempDir("run-label");
  const result = run(["run", "--", process.execPath, path.join(here, "fixtures", "emit.mjs"), "0", "200"], { cwd: dir });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /full text: \.ctxclip/);
});
