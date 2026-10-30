/**
 * ctxclip core: deterministic condensation of tool / command output.
 *
 * Nothing here calls a model, reads the network, or guesses semantics. Every
 * dropped line is counted and every omission is marked with a receipt line.
 */

export const VERSION = "0.1.0";

export const DEFAULTS = {
  maxChars: 8000,
  keepHead: 12,
  keepTail: 12,
  signalMax: 60,
  minFoldRun: 3,
  label: null,
};

const ANSI_OSC = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
const ANSI_CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const ANSI_OTHER = /\x1b[@-Z\\-_]/g;

/** Strips colour codes and normalises line endings without touching visible text. */
export function normalize(text) {
  const value = String(text ?? "")
    .replace(/^\uFEFF/, "")
    .replace(ANSI_OSC, "")
    .replace(ANSI_CSI, "")
    .replace(ANSI_OTHER, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n");
  // "a\nb\n" is two lines, not three. Keep intentional blank lines in the middle.
  return value.endsWith("\n") ? value.slice(0, -1) : value;
}

const SIGNALS = [
  ["error", /\berrors?\b|\bERR!|\b[A-Z][\w.]*(?:Error|Exception)\b|\b(?:uncaught|unhandled|fatal)\b/i],
  ["fail", /^\s*[\u00d7\u2717\u2718]\s|\bnot ok\b|\bfail(?:s|ed|ing|ure|ures)?\b|\bFAIL\b/i],
  ["exception", /\b(?:exception|traceback|panic|stack trace|segmentation fault)\b/i],
  ["warn", /\bwarn(?:ing|ings)?\b/i],
  ["denied", /\b(?:denied|forbidden|unauthorized|EACCES|EPERM)\b/i],
  ["timeout", /\b(?:timed? ?out|ETIMEDOUT|deadline exceeded)\b/i],
  ["assert", /\bAssertionError\b|\bexpected\b.*\breceived\b|\bassert(?:ion)? failed\b/i],
  ["diff", /^(?:\+\+\+|---|@@|diff --git)\s/],
  ["location", /(?:^|[\s(\[{'"])[\w./\\@-]+\.(?:mjs|cjs|jsx?|tsx?|py|go|rs|java|kt|rb|php|cs|sh|sql|json|ya?ml|toml|md|log):\d+/],
];

// Lines that mention errors only to say there were none ("0 errors", "no failures").
const ZERO_SUMMARY =
  /^\s*(?:\d+\s+(?:tests?|suites?|specs?)\s+)?(?:0|no)\s+(?:errors?|failures?|warnings?|problems?)\b/i;

/** Returns the signal kinds a line carries, e.g. ["fail", "location"]. */
export function signalKinds(line) {
  if (!line || ZERO_SUMMARY.test(line)) return [];
  const kinds = [];
  for (const [name, pattern] of SIGNALS) {
    if (pattern.test(line)) kinds.push(name);
  }
  return kinds;
}

export function isSignal(line) {
  return signalKinds(line).length > 0;
}

// Non-global for .test() (a global regex carries lastIndex state between calls).
const LONG_RUN = /[#\u2550=\u2500~_.\u00b7\u2022-]{4,}/;
const LONG_RUN_G = new RegExp(LONG_RUN.source, "g");

/**
 * Shape of a line with volatile parts replaced: digits, hex ids, bar runs.
 * Two lines with the same shape are "the same kind of line" for folding.
 */
export function shapeOf(line) {
  return line
    .replace(/[0-9a-f]{6,}/gi, "#")
    .replace(/\d+(?:\.\d+)?/g, "#")
    .replace(LONG_RUN_G, "#")
    .replace(/\s+/g, " ")
    .trim();
}

const hasVolatile = (line) => /\d/.test(line) || LONG_RUN.test(line);

/**
 * Decides, per line, whether it is dropped and why.
 * Reasons are only assigned to dropped lines; kept lines stay null.
 */
function classify(lines, { minFoldRun }) {
  const reason = new Array(lines.length).fill(null);
  const anchors = new Set();

  let i = 0;
  while (i < lines.length) {
    // R2: consecutive identical lines -> keep one, count the rest.
    let j = i + 1;
    while (j < lines.length && lines[j] === lines[i]) j++;
    if (j - i >= 2 && lines[i].trim() !== "") {
      anchors.add(i);
      for (let k = i + 1; k < j; k++) reason[k] = "duplicate";
      i = j;
      continue;
    }

    // R3: progress / timestamp shake -> keep first and last, fold the middle.
    // Signal lines are never folded here: a folded error line is an invisible error.
    const shape = shapeOf(lines[i]);
    if (shape && hasVolatile(lines[i]) && lines[i].trim() !== "" && !isSignal(lines[i])) {
      let k = i + 1;
      while (
        k < lines.length &&
        shapeOf(lines[k]) === shape &&
        lines[k] !== lines[i] &&
        !isSignal(lines[k])
      ) {
        k++;
      }
      if (k - i >= minFoldRun) {
        anchors.add(i);
        anchors.add(k - 1);
        for (let m = i + 1; m < k - 1; m++) reason[m] = "progress";
        i = k;
        continue;
      }
    }

    i++;
  }

  return { anchors, reason };
}

function countBy(list) {
  const counts = new Map();
  for (const item of list) counts.set(item, (counts.get(item) ?? 0) + 1);
  return counts;
}

function formatCounts(counts, total) {
  const order = ["duplicate", "progress", "signalCap", "budget", "other"];
  const labels = {
    duplicate: "duplicate",
    progress: "progress",
    signalCap: "over signal cap",
    budget: "budget",
    other: "other",
  };
  const parts = [];
  for (const key of order) {
    const value = counts.get(key) ?? 0;
    if (value) parts.push(`${value.toLocaleString("en-US")} ${labels[key]}`);
  }
  if (!parts.length) return `${total.toLocaleString("en-US")} lines`;
  return parts.join(", ");
}

export function markerFor(total, counts, label, { includeLabel = true } = {}) {
  const detail = formatCounts(counts, total);
  const where = includeLabel && label ? ` \u2014 full text: ${label}` : "";
  return `\u2026 [ctxclip] ${total.toLocaleString("en-US")} lines omitted (${detail})${where}`;
}

/** Applies the head / tail / signal-cap policy and renders kept lines plus markers. */
function emit(lines, allSignals, options) {
  const { keepHead, keepTail, signalMax, label, minFoldRun, anchorRatio = 1 } = options;
  const { anchors, reason } = classify(lines, { minFoldRun });
  let kept = new Set(anchors);

  // Under a tight budget, thin the anchors from the middle out instead of
  // jumping straight to "signals only": the beginning and the end stay readable.
  if (anchorRatio < 1 && anchors.size > 2) {
    const sorted = [...anchors].sort((a, b) => a - b);
    const target = Math.max(2, Math.round(sorted.length * anchorRatio));
    const headCount = Math.ceil(target / 2);
    const tailCount = Math.floor(target / 2);
    kept = new Set([...sorted.slice(0, headCount), ...sorted.slice(sorted.length - tailCount)]);
    for (const index of sorted) {
      if (!kept.has(index) && reason[index] === null) reason[index] = "budget";
    }
  }

  // Folded runs (duplicates, progress) are never resurrected by head/tail windows:
  // that would undo the whole point of folding.
  const add = (index) => {
    if (reason[index] === null) kept.add(index);
  };
  // R5: head and tail windows.
  for (let i = 0; i < Math.min(keepHead, lines.length); i++) add(i);
  for (let i = Math.max(0, lines.length - keepTail); i < lines.length; i++) add(i);

  // R4: signals get priority, but only up to the cap. Lines folded as duplicates
  // are not candidates: they are already represented by one kept line plus a count.
  const signals = allSignals.filter((index) => reason[index] === null);
  if (signals.length > signalMax) {
    const half = Math.max(1, Math.floor(signalMax / 2));
    const allowed = new Set([
      ...signals.slice(0, half),
      ...signals.slice(signals.length - (signalMax - half)),
    ]);
    for (const index of signals) {
      if (allowed.has(index)) add(index);
      else if (!kept.has(index)) reason[index] = "signalCap";
    }
  } else {
    for (const index of signals) add(index);
  }

  // A marker is only worth it when the omitted lines cost more than the marker,
  // and never for one or two lines: that is noise, not condensation.
  for (let changed = true; changed; ) {
    changed = false;
    let i = 0;
    while (i < lines.length) {
      if (kept.has(i)) {
        i++;
        continue;
      }
      let j = i;
      let cost = 0;
      const runReasons = [];
      while (j < lines.length && !kept.has(j)) {
        cost += lines[j].length + 1;
        runReasons.push(reason[j] ?? "other");
        j++;
      }
      const markerCost = markerFor(runReasons.length, countBy(runReasons), null).length + 1;
      if (j - i < 3 || cost <= markerCost) {
        for (let k = i; k < j; k++) kept.add(k);
        changed = true;
      }
      i = j;
    }
  }

  const signalKept = allSignals.filter((index) => kept.has(index)).length;

  const out = [];
  const droppedCounts = new Map();
  let droppedTotal = 0;
  let keptLines = 0;
  let markers = 0;

  let i = 0;
  while (i < lines.length) {
    if (kept.has(i)) {
      out.push(lines[i]);
      keptLines++;
      i++;
      continue;
    }
    let j = i;
    const runReasons = [];
    while (j < lines.length && !kept.has(j)) {
      runReasons.push(reason[j] ?? "other");
      j++;
    }
    const counts = countBy(runReasons);
    for (const [key, value] of counts) droppedCounts.set(key, (droppedCounts.get(key) ?? 0) + value);
    droppedTotal += runReasons.length;
    out.push(markerFor(runReasons.length, counts, label, { includeLabel: runReasons.length >= 20 }));
    markers++;
    i = j;
  }

  return {
    text: out.join("\n"),
    keptLines,
    droppedTotal,
    droppedCounts,
    signalKept,
    markers,
    anchors,
    anchorRatio,
    reason,
  };
}

function clipLongLines(text, maxChars) {
  const perLine = Math.max(400, Math.floor(maxChars / 6));
  let clippedLines = 0;
  let clippedChars = 0;
  const lines = text.split("\n").map((line) => {
    if (line.length <= perLine) return line;
    const head = Math.floor(perLine * 0.6);
    const tail = Math.floor(perLine * 0.3);
    const removed = line.length - head - tail;
    clippedLines++;
    clippedChars += removed;
    return `${line.slice(0, head)}\u2026 [ctxclip] ${removed.toLocaleString("en-US")} chars clipped \u2026${line.slice(-tail)}`;
  });
  return { text: lines.join("\n"), clippedLines, clippedChars };
}

const BUDGET_LADDER = [
  {},
  { keepHead: 6, keepTail: 6 },
  { keepHead: 3, keepTail: 3 },
  { anchorRatio: 0.6 },
  { anchorRatio: 0.3, signalMax: 40 },
  { anchorRatio: 0.1, signalMax: 20 },
  { anchorRatio: 0, signalMax: 12 },
];

/**
 * Condenses text. Pure function: same input + options -> same output.
 *
 * @param {string} input
 * @param {Partial<typeof DEFAULTS>} [options]
 */
export function condense(input, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const normalized = normalize(input);
  const lines = normalized === "" ? [] : normalized.split("\n");
  const signals = [];
  for (let i = 0; i < lines.length; i++) if (isSignal(lines[i])) signals.push(i);

  let best = null;
  let attempts = 0;
  for (const step of BUDGET_LADDER) {
    attempts++;
    const effective = {
      ...opts,
      signalMax: Math.min(opts.signalMax, step.signalMax ?? opts.signalMax),
      keepHead: Math.min(opts.keepHead, step.keepHead ?? opts.keepHead),
      keepTail: Math.min(opts.keepTail, step.keepTail ?? opts.keepTail),
      anchorRatio: step.anchorRatio ?? 1,
    };
    best = emit(lines, signals, effective);
    if (best.text.length <= opts.maxChars) break;
  }

  let clipped = { text: best.text, clippedLines: 0, clippedChars: 0 };
  if (best.text.length > opts.maxChars) clipped = clipLongLines(best.text, opts.maxChars);

  const text = clipped.text;
  const inputChars = normalized.length;
  const dropped = {
    total: best.droppedTotal,
    duplicate: best.droppedCounts.get("duplicate") ?? 0,
    progress: best.droppedCounts.get("progress") ?? 0,
    signalCap: best.droppedCounts.get("signalCap") ?? 0,
    budget: best.droppedCounts.get("budget") ?? 0,
    other: best.droppedCounts.get("other") ?? 0,
  };

  return {
    text,
    stats: {
      version: VERSION,
      chars: { input: inputChars, output: text.length, bytesIn: Buffer.byteLength(normalized, "utf8") },
      lines: { input: lines.length, output: text === "" ? 0 : text.split("\n").length, kept: best.keptLines },
      dropped,
      markers: best.markers,
      signals: { total: signals.length, kept: best.signalKept },
      clipped: { lines: clipped.clippedLines, chars: clipped.clippedChars },
      reductionPercent: inputChars === 0 ? 0 : Math.round((1 - text.length / inputChars) * 1000) / 10,
      overBudget: text.length > opts.maxChars,
      budgetAttempts: attempts,
      estimate: {
        note: "chars/4 estimate, not a billing figure",
        inputTokens: Math.round(inputChars / 4),
        outputTokens: Math.round(text.length / 4),
      },
      options: {
        maxChars: opts.maxChars,
        keepHead: opts.keepHead,
        keepTail: opts.keepTail,
        signalMax: opts.signalMax,
        minFoldRun: opts.minFoldRun,
        anchorRatio: best.anchorRatio,
        label: opts.label ?? null,
      },
    },
  };
}

/** One-line receipt for stderr. */
export function receipt(stats, stream = "output") {
  const chars = (value) => (value >= 1024 ? `${(value / 1024).toFixed(1)} kB` : `${value} B`);
  const parts = [
    `${stream} ${chars(stats.chars.input)} \u2192 ${chars(stats.chars.output)} (${stats.reductionPercent}% smaller)`,
    `${stats.lines.input.toLocaleString("en-US")} \u2192 ${stats.lines.output.toLocaleString("en-US")} lines`,
    `signals kept ${stats.signals.kept}/${stats.signals.total}`,
    `dropped ${stats.dropped.total.toLocaleString("en-US")} accounted`,
  ];
  if (stats.clipped.lines) parts.push(`${stats.clipped.lines} long line(s) clipped`);
  if (stats.overBudget) parts.push("still over budget");
  return `ctxclip: ${parts.join(" | ")}`;
}
