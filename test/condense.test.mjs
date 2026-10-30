import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULTS,
  condense,
  isSignal,
  markerFor,
  normalize,
  receipt,
  shapeOf,
  signalKinds,
} from "../src/condense.mjs";

const WORDS = ["alpha", "beta", "gamma", "delta", "epsilon"];

const uniqueLines = (count, width = 40) =>
  Array.from(
    { length: count },
    (_, index) => `entry ${index} ${WORDS[index % WORDS.length]} ${"x".repeat(width)}`,
  );

const repeat = (count, value) => Array.from({ length: count }, () => value);

test("normalize strips ANSI colour and normalises CRLF", () => {
  const input = "\u001b[31mFAIL\u001b[0m src/a.test.ts\u001b[39m\r\nsecond\u001b[0m\r\n";
  assert.equal(normalize(input), "FAIL src/a.test.ts\nsecond");
});

test("normalize removes OSC hyperlinks without leaving escape residue", () => {
  const input = "\u001b]8;;https://example.com\u0007click\u001b]8;;\u0007 ok";
  assert.equal(normalize(input), "click ok");
});

test("classifies signal lines and ignores zero-summary lines", () => {
  assert.equal(isSignal("PASS src/a.test.ts"), false);
  assert.ok(isSignal("FAIL src/checkout/session.test.ts > rejects expired token"));
  assert.ok(isSignal("   at validateSession (src/auth/session.ts:88:11)"));
  assert.ok(isSignal("TypeError: Cannot read properties of undefined"));
  assert.ok(isSignal("npm error code ELIFECYCLE"));
  assert.equal(isSignal("0 errors"), false);
  assert.equal(isSignal("Tests  7 failed | 1841 passed (1848)"), true);
  assert.deepEqual(signalKinds("error: Nope (src/a.ts:12:3)"), ["error", "location"]);
});

test("shapeOf collapses digits and progress bars", () => {
  assert.equal(shapeOf("[00:12] compiling module 12/900 ... ok"), shapeOf("[01:03] compiling module 63/900 ... ok"));
  assert.equal(shapeOf("....####.... 42%"), shapeOf("##.......... 7%"));
});

test("folds consecutive duplicate lines and keeps the count", () => {
  const input = repeat(50, "npm warn deprecated inflight@1.0.6: This module is not supported").join("\n");
  const { text, stats } = condense(input, { maxChars: 8000 });

  assert.equal(stats.lines.kept, 1);
  assert.equal(stats.dropped.duplicate, 49);
  assert.match(text, /49 lines omitted \(49 duplicate\)/);
  assert.equal(text.split("\n").length, 2);
});

test("folds long progress runs to first and last line", () => {
  const input = Array.from(
    { length: 900 },
    (_, index) => `[${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}] compiling module ${index}/900 ... ok`,
  ).join("\n");
  const { text, stats } = condense(input, { maxChars: 20000 });

  assert.equal(stats.lines.kept, 2);
  assert.equal(stats.dropped.progress, 898);
  assert.match(text, /898 lines omitted \(898 progress\)/);
  assert.match(text, /compiling module 0\/900/);
  assert.match(text, /compiling module 899\/900/);
});

test("never drops a unique failure line buried in the middle", () => {
  const before = uniqueLines(400);
  const after = uniqueLines(400).map((line) => line.replace("entry", "tail"));
  const failure = "FAIL src/checkout/session.test.ts:142:9 > rejects expired token";
  const input = [...before, failure, ...after].join("\n");
  const { text, stats } = condense(input, { maxChars: 4000 });

  assert.ok(text.includes(failure), "failure line must survive");
  assert.equal(stats.signals.kept, 1);
  assert.ok(stats.reductionPercent > 80, `expected heavy reduction, got ${stats.reductionPercent}%`);
});

test("caps signal lines but reports how many were dropped", () => {
  const input = Array.from({ length: 200 }, (_, index) => `error ${index}: cannot resolve module ${index}`).join("\n");
  const { text, stats } = condense(input, { maxChars: 8000, signalMax: 10, keepHead: 2, keepTail: 2 });

  assert.ok(stats.signals.total >= 190, "all error lines are detected");
  assert.ok(stats.signals.kept <= 10, `kept ${stats.signals.kept} signals`);
  assert.match(text, /over signal cap/);
  assert.match(text, /error 0: cannot resolve/);
  assert.match(text, /error 199: cannot resolve/);
});

test("respects the character budget on many short lines", () => {
  const input = uniqueLines(300, 30).join("\n");
  const { text, stats } = condense(input, { maxChars: 600 });

  assert.ok(text.length <= 600, `output ${text.length} chars exceeds budget`);
  assert.equal(stats.overBudget, false);
  assert.ok(stats.lines.output < stats.lines.input);
});

test("clips a single enormous line and says how much was removed", () => {
  const input = `payload=${"a".repeat(5000)}`;
  const { text, stats } = condense(input, { maxChars: 1000 });

  assert.equal(stats.clipped.lines, 1);
  assert.ok(stats.clipped.chars > 4000);
  assert.match(text, /chars clipped/);
  assert.ok(text.length < 900, `clipped output is ${text.length} chars`);
});

test("keeps every omission accounted for in the line total", () => {
  const input = [
    ...uniqueLines(60),
    ...repeat(30, "duplicate noise line"),
    ...Array.from({ length: 120 }, (_, index) => `   ... ${index}% done [##....] ${index}ms`),
    "error: something broke (src/a.ts:1:1)",
    ...uniqueLines(60).map((line) => `${line} tail`),
  ].join("\n");
  const { stats } = condense(input, { maxChars: 2500 });

  assert.equal(stats.lines.kept + stats.dropped.total, stats.lines.input);
  assert.equal(
    stats.dropped.total,
    stats.dropped.duplicate +
      stats.dropped.progress +
      stats.dropped.signalCap +
      stats.dropped.budget +
      stats.dropped.other,
  );
});

test("markers carry the spill label so the reader can get the original", () => {
  const input = uniqueLines(200, 10).join("\n");
  const { text } = condense(input, { maxChars: 500, label: ".ctxclip/2026/stdout.log" });
  assert.match(text, /full text: \.ctxclip\/2026\/stdout\.log/);
});

test("is deterministic", () => {
  const input = uniqueLines(150, 20).join("\n");
  const a = condense(input, { maxChars: 900 });
  const b = condense(input, { maxChars: 900 });
  assert.equal(a.text, b.text);
  assert.deepEqual(a.stats, b.stats);
});

test("empty and whitespace-only input is handled", () => {
  const empty = condense("");
  assert.equal(empty.text, "");
  assert.equal(empty.stats.lines.input, 0);
  assert.equal(empty.stats.reductionPercent, 0);

  const blank = condense("\n\n\n");
  assert.equal(blank.stats.lines.input, 3);
  assert.ok(blank.stats.lines.output <= 3);
});

test("markerFor numbers use one locale-stable format", () => {
  const marker = markerFor(1204, new Map([["duplicate", 1200], ["other", 4]]), "out.log");
  assert.match(marker, /1,204 lines omitted \(1,200 duplicate, 4 other\)/);
  assert.match(marker, /full text: out\.log/);
});

test("receipt reports both stream sizes and the estimate disclaimer", () => {
  const { stats } = condense(uniqueLines(100, 20).join("\n"), { maxChars: 500 });
  const line = receipt(stats, "stdout");
  assert.match(line, /^ctxclip: stdout /);
  assert.match(line, /smaller/);
  assert.match(stats.estimate.note, /estimate/);
});

test("default options are what the README claims", () => {
  assert.equal(DEFAULTS.maxChars, 8000);
  assert.equal(DEFAULTS.keepHead, 12);
  assert.equal(DEFAULTS.keepTail, 12);
  assert.equal(DEFAULTS.signalMax, 60);
});

test("keeps a one-line gap instead of paying for a marker", () => {
  const input = [
    ...uniqueLines(20),
    "progress 1 (1%)",
    "progress 2 (2%)",
    "progress 3 (3%)",
    ...uniqueLines(20).map((line) => `${line} tail`),
  ].join("\n");
  const { text, stats } = condense(input, { maxChars: 8000 });

  assert.ok(text.includes("progress 2 (2%)"), "the single folded line is cheaper to keep");
  assert.equal(/1 lines omitted/.test(text), false, "no marker is spent on one line");
  assert.equal(stats.dropped.total, stats.lines.input - stats.lines.kept);
});

test("duplicate signal lines do not exhaust the signal cap", () => {
  const warnings = repeat(100, "npm warn deprecated inflight@1.0.6: This module is not supported");
  const errors = Array.from({ length: 5 }, (_, index) => `error ${index}: cannot resolve (src/mod-${index}.ts:${index + 1}:3)`);
  const { text, stats } = condense([...warnings, ...errors].join("\n"), { maxChars: 8000, signalMax: 10 });

  for (const error of errors) assert.ok(text.includes(error), `missing ${error}`);
  assert.equal(stats.signals.kept, 6, "five errors plus the folded warning anchor");
  assert.equal(stats.dropped.duplicate, 99);
});

test("a tight budget thins sections but never silently loses the errors", () => {
  const errors = Array.from({ length: 6 }, (_, index) => `FAIL case ${index} (src/case-${index}.test.ts:${index + 1}:1)`);
  const input = [
    ...uniqueLines(200, 20),
    ...errors,
    ...uniqueLines(200, 20).map((line) => `${line} tail`),
  ].join("\n");

  const { text, stats } = condense(input, { maxChars: 2500 });
  assert.ok(text.length <= 2500, `output is ${text.length} chars`);
  assert.equal(stats.overBudget, false);
  for (const error of errors) assert.ok(text.includes(error), `missing ${error}`);
});

test("a generous budget keeps every unique signal", () => {
  const errors = Array.from({ length: 15 }, (_, index) => `TypeError: broke at step ${index}`);
  const { text, stats } = condense([...uniqueLines(100), ...errors].join("\n"), { maxChars: 20000 });
  assert.equal(stats.signals.kept, 15);
  for (const error of errors) assert.ok(text.includes(error));
});
