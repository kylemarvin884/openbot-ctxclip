#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

import { DEFAULTS, VERSION, condense, receipt } from "./condense.mjs";
import { runCommand, runDirName, shellCommand, writeSpill } from "./run.mjs";

const USAGE = `ctxclip ${VERSION} \u2014 condense tool output before it reaches the model

Usage
  ctxclip run -- <command...> [options]     run a command, condense its output
  ctxclip filter <file|-> [options]         condense an existing log or stdin

Options
  --max-chars=N      output character budget (default ${DEFAULTS.maxChars})
  --keep-head=N      keep the first N lines (default ${DEFAULTS.keepHead})
  --keep-tail=N      keep the last N lines (default ${DEFAULTS.keepTail})
  --signal-max=N     max error/warning/stack lines kept (default ${DEFAULTS.signalMax})
  --min-fold-run=N   fold progress runs of at least N lines (default ${DEFAULTS.minFoldRun})
  --spill-dir=DIR    where full output is written (default ./.ctxclip/<run>)
  --no-spill         do not write full output to disk
  --report=FILE      write machine-readable stats as JSON
  --timeout=MS       kill the child after MS milliseconds (run only)
  --quiet            suppress the receipt line on stderr

Exit codes
  0        ok (filter) or the child command's own exit code (run)
  2        usage error              124  child command timed out (run)

Full output is never deleted silently: every omission is counted in a marker,
and the spill path is printed so the model or a human can read the original.
`;

function fail(message) {
  const error = new Error(message);
  error.usage = true;
  throw error;
}

function numberOf(flags, key, fallback) {
  const raw = flags[key];
  if (raw === undefined) return fallback;
  if (raw === true) fail(`--${key} 需要一个数字，例如 --${key}=12`);
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) fail(`--${key} 需要非负数字，收到：${raw}`);
  return Math.floor(value);
}

function optionsFrom(flags, label) {
  return {
    maxChars: Math.max(200, numberOf(flags, "max-chars", DEFAULTS.maxChars)),
    keepHead: numberOf(flags, "keep-head", DEFAULTS.keepHead),
    keepTail: numberOf(flags, "keep-tail", DEFAULTS.keepTail),
    signalMax: numberOf(flags, "signal-max", DEFAULTS.signalMax),
    minFoldRun: Math.max(2, numberOf(flags, "min-fold-run", DEFAULTS.minFoldRun)),
    label,
  };
}

function splitFlags(tokens) {
  const flags = {};
  const positional = [];
  for (const token of tokens) {
    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      if (eq === -1) flags[body] = true;
      else flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    positional.push(token);
  }
  return { flags, positional };
}

function splitRunArgs(tokens) {
  const flags = {};
  let index = 0;
  for (; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === "--") {
      index++;
      break;
    }
    if (!token.startsWith("--")) break;
    const body = token.slice(2);
    const eq = body.indexOf("=");
    if (eq === -1) flags[body] = true;
    else flags[body.slice(0, eq)] = body.slice(eq + 1);
  }
  return { flags, command: tokens.slice(index) };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function writeReport(file, payload) {
  if (!file || file === true) return;
  const target = path.resolve(String(file));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function emitText(text) {
  process.stdout.write(text.endsWith("\n") || text === "" ? text : `${text}\n`);
}

async function commandFilter(args) {
  const { flags, positional } = splitFlags(args);
  if (flags.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const source = positional[0] ?? "-";
  if (source === "--help" || source === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }
  const raw = source === "-" ? await readStdin() : await fs.readFile(path.resolve(source), "utf8");

  let label = source === "-" ? "stdin (not spilled)" : source;
  let spillPath = null;
  if (flags["spill-dir"] && flags["spill-dir"] !== true) {
    const dir = path.resolve(String(flags["spill-dir"]));
    const name = source === "-" ? "stdin.log" : path.basename(source);
    spillPath = await writeSpill(dir, name, raw);
    label = path.relative(process.cwd(), spillPath) || spillPath;
  }

  const options = optionsFrom(flags, label);
  const result = condense(raw, options);
  emitText(result.text);
  if (!flags.quiet) process.stderr.write(`${receipt(result.stats, source === "-" ? "stdin" : source)}\n`);
  await writeReport(flags.report, {
    version: VERSION,
    command: "filter",
    source,
    spill: spillPath,
    output: result.stats,
  });
  return 0;
}

async function commandRun(args) {
  const { flags, command } = splitRunArgs(args);
  if (flags.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!command.length) fail("用法：ctxclip run -- <command...>（例如 ctxclip run -- npm test）");
  if (command[0] === "--help" || command[0] === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }

  const cwd = process.cwd();
  const full = shellCommand(command);
  const spillDir =
    flags["no-spill"] === true
      ? null
      : path.resolve(String(flags["spill-dir"] ?? path.join(cwd, ".ctxclip", runDirName())));

  const started = Date.now();
  const result = await runCommand({
    command: full,
    cwd,
    timeoutMs: numberOf(flags, "timeout", 0),
  });
  const elapsedMs = Date.now() - started;

  let stdoutLabel = "stdout (not spilled)";
  let stderrLabel = "stderr (not spilled)";
  let stdoutFile = null;
  let stderrFile = null;
  if (spillDir) {
    if (result.stdout.text) {
      stdoutFile = await writeSpill(spillDir, "stdout.log", result.stdout.text);
      stdoutLabel = path.relative(cwd, stdoutFile) || stdoutFile;
    }
    if (result.stderr.text) {
      stderrFile = await writeSpill(spillDir, "stderr.log", result.stderr.text);
      stderrLabel = path.relative(cwd, stderrFile) || stderrFile;
    }
  }

  const out = condense(result.stdout.text, optionsFrom(flags, stdoutLabel));
  const err = condense(result.stderr.text, optionsFrom(flags, stderrLabel));

  emitText(out.text);
  if (err.text) process.stderr.write(err.text.endsWith("\n") ? err.text : `${err.text}\n`);

  if (!flags.quiet) {
    const exit = result.timedOut ? "timed out" : `exit ${result.code}`;
    process.stderr.write(`${receipt(out.stats, "stdout")} | ${exit} | ${elapsedMs}ms\n`);
    if (result.stderr.text) process.stderr.write(`${receipt(err.stats, "stderr")}\n`);
    if (result.stdout.truncated || result.stderr.truncated) {
      process.stderr.write(
        `ctxclip: capture capped at ${(8 * 1024 * 1024).toLocaleString("en-US")} bytes per stream; the spill file holds only what was captured\n`,
      );
    }
    if (!spillDir) process.stderr.write("ctxclip: --no-spill set; full output was not written to disk\n");
  }

  await writeReport(flags.report, {
    version: VERSION,
    command: "run",
    argv: command,
    shell: full,
    exitCode: result.code,
    signal: result.signal,
    timedOut: result.timedOut,
    elapsedMs,
    captureTruncated: { stdout: result.stdout.truncated, stderr: result.stderr.truncated },
    spill: { stdout: stdoutFile, stderr: stderrFile },
    output: { stdout: out.stats, stderr: err.stats },
  });

  if (result.timedOut) return 124;
  return result.code;
}

async function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (command === "--version" || command === "-v" || command === "version") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (command === "filter") return commandFilter(rest);
  if (command === "run") return commandRun(rest);
  process.stderr.write(`ctxclip: 未知命令 ${command}\n\n${USAGE}`);
  return 2;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`ctxclip: ${error.message}\n`);
    if (error.usage) process.stderr.write(`\n${USAGE}`);
    process.exitCode = error.usage ? 2 : 1;
  });
