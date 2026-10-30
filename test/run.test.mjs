import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CAPTURE_LIMIT, runCommand, runDirName, shellCommand, writeSpill } from "../src/run.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const emit = path.join(here, "fixtures", "emit.mjs");

test("runCommand captures stdout and the exit code", async () => {
  const result = await runCommand({ command: `"${process.execPath}" "${emit}" 0 5` });
  assert.equal(result.code, 0);
  assert.equal(result.timedOut, false);
  assert.match(result.stdout.text, /error: fixture failure/);
  assert.equal(result.stdout.truncated, false);
});

test("runCommand separates stderr from stdout", async () => {
  const result = await runCommand({ command: `"${process.execPath}" "${emit}" 0 2 noisy-stderr` });
  assert.equal(result.stdout.text.includes("stderr noise"), false);
  assert.match(result.stderr.text, /stderr noise 0/);
});

test("runCommand reports a non-zero code instead of throwing", async () => {
  const result = await runCommand({ command: `"${process.execPath}" "${emit}" 3 1` });
  assert.equal(result.code, 3);
});

test("runCommand kills a command that exceeds the timeout", async () => {
  const script = "setTimeout(() => {}, 10000)";
  const started = Date.now();
  const result = await runCommand({
    command: `"${process.execPath}" -e "${script}"`,
    timeoutMs: 250,
  });
  const elapsed = Date.now() - started;

  assert.equal(result.timedOut, true);
  assert.ok(elapsed < 6000, `took ${elapsed}ms`);
});

test("runCommand rejects when the shell command does not exist", async () => {
  await assert.rejects(() => runCommand({ command: "", timeoutMs: 1000 }));
});

test("shellCommand quotes tokens containing spaces", () => {
  assert.equal(shellCommand(["npm", "test"]), "npm test");
  assert.equal(shellCommand(["node", "-e", "console.log(1)"]), 'node -e "console.log(1)"');
});

test("runDirName is filesystem safe and uses local time", () => {
  const name = runDirName(new Date(2026, 9, 31, 9, 4, 5));
  assert.equal(/[:.]/.test(name), false, name);
  assert.equal(name, "2026-10-31_09-04-05");
});

test("writeSpill creates nested directories and returns the path", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctxclip-spill-"));
  const file = await writeSpill(path.join(dir, "a", "b"), "stdout.log", "hello\n");
  assert.equal(fs.readFileSync(file, "utf8"), "hello\n");
});

test("capture limit is documented as 8 MB per stream", () => {
  assert.equal(CAPTURE_LIMIT, 8 * 1024 * 1024);
});
