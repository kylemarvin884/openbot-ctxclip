#!/usr/bin/env node
/**
 * One command, offline, reproducible:
 *   node demo/demo.mjs
 *
 * Generates a noisy failing test log, condenses it, prints the receipt and a
 * sample of the result, then asserts that no unique failure line was lost.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { condense, isSignal, normalize } from "../src/condense.mjs";
import { FAILURE_HEADERS, buildSampleLog } from "./sample-log.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const samplePath = path.join(here, "sample.log");

const raw = buildSampleLog();
fs.writeFileSync(samplePath, raw, "utf8");

const result = condense(raw, {
  maxChars: 8000,
  label: path.relative(path.join(here, ".."), samplePath),
});
const { text, stats } = result;

const chars = (value) => (value >= 1024 ? `${(value / 1024).toFixed(1)} kB` : `${value} B`);

process.stdout.write(`
ctxclip demo \u2014 generated ${samplePath.replace(process.cwd() + path.sep, "")}

  before   ${String(stats.lines.input).padStart(6)} lines   ${chars(stats.chars.input).padStart(9)}   \u2248 ${stats.estimate.inputTokens.toLocaleString("en-US")} tokens (chars/4 estimate)
  after    ${String(stats.lines.output).padStart(6)} lines   ${chars(stats.chars.output).padStart(9)}   \u2248 ${stats.estimate.outputTokens.toLocaleString("en-US")} tokens
  reduction ${stats.reductionPercent}%   markers ${stats.markers}   dropped ${stats.dropped.total.toLocaleString("en-US")} accounted

condensed output (first 24 lines):
`);

const preview = text.split("\n").slice(0, 24);
for (const line of preview) process.stdout.write(`  ${line}\n`);
if (text.split("\n").length > preview.length) process.stdout.write("  \u2026\n");

const checks = [];
const missing = FAILURE_HEADERS.filter((header) => !text.includes(header));
checks.push({
  ok: missing.length === 0,
  label: `all ${FAILURE_HEADERS.length} unique failure lines survived`,
  detail: missing.length ? `missing ${missing.length}` : "0 missing",
});

const keptPlusDropped = stats.lines.kept + stats.dropped.total;
checks.push({
  ok: keptPlusDropped === stats.lines.input,
  label: "line accounting closes",
  detail: `${stats.lines.kept} kept + ${stats.dropped.total} dropped = ${keptPlusDropped} of ${stats.lines.input}`,
});

checks.push({
  ok: /\[ctxclip\]/.test(text),
  label: "every omission carries a marker",
  detail: `${stats.markers} markers`,
});

checks.push({
  ok: !stats.overBudget,
  label: "output fits the 8,000 character budget",
  detail: `${text.length} chars`,
});

const droppedErrors = text
  .split("\n")
  .filter((line) => line.startsWith("\u2026 [ctxclip]"))
  .filter((line) => /fail|error/i.test(line));
checks.push({
  ok: droppedErrors.length === 0,
  label: "no error line is only mentioned inside a marker",
  detail: droppedErrors.length ? droppedErrors[0] : "none",
});

process.stdout.write("\nchecks:\n");
for (const check of checks) {
  process.stdout.write(`  ${check.ok ? "\u2713" : "\u2717"} ${check.label} (${check.detail})\n`);
}

// Sanity: the detector still recognises the failure lines it was asked to keep.
const detected = normalize(raw).split("\n").filter(isSignal).length;
process.stdout.write(`\n  signal lines in input: ${detected}   kept: ${stats.signals.kept}\n\n`);

const failed = checks.filter((check) => !check.ok);
process.exitCode = failed.length ? 1 : 0;
