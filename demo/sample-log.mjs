/**
 * Builds a deterministic, realistically noisy test log.
 * Same output on every platform and every run: no timestamps from Date.now().
 */

const ESC = "\u001b";
const paint = (text, code) => `${ESC}[${code}m${text}${ESC}[0m`;
const pad = (value, width = 2) => String(value).padStart(width, "0");

export const FAILURE_HEADERS = [];

export function buildSampleLog() {
  const lines = [];
  FAILURE_HEADERS.length = 0;

  lines.push(paint("> ctxclip-demo@0.1.0 test", "36"));
  lines.push(paint("> vitest run --reporter=verbose", "36"));
  lines.push("");

  // 40 test files, 12 passing cases each, a failure every 11th file.
  for (let file = 0; file < 40; file++) {
    lines.push(paint(` \u2713 src/unit/file-${file}.test.ts (12 tests) ${900 + file * 37}ms`, "32"));
    for (let test = 0; test < 12; test++) {
      lines.push(`   ${paint("\u2713", "32")} handles payload ${test} (${test + 1} ms)`);
    }
    if (file % 11 === 5) {
      const plainHeader = `   \u00d7 rejects expired token (round ${file})`;
      lines.push(`   ${paint("\u00d7", "31")} rejects expired token (round ${file})`);
      FAILURE_HEADERS.push(plainHeader);
      lines.push("     \u2192 expected 401, received 200");
      lines.push(`     at src/checkout/session.test.ts:${100 + file}:14`);
      for (let repeat = 0; repeat < 3; repeat++) {
        lines.push("       at validateSession (src/auth/session.ts:88:11)");
        lines.push(`       at Object.<anonymous> (src/checkout/session.test.ts:${100 + file}:5)`);
      }
    }
    const filled = (file * 3) % 20;
    lines.push(`   ... ${file}% done [${"#".repeat(filled)}${".".repeat(20 - filled)}] ${file * 37}ms`);
  }

  lines.push("");
  lines.push(paint("> tsc --noEmit", "36"));
  for (let step = 0; step < 900; step++) {
    lines.push(`[${pad(Math.floor(step / 60))}:${pad(step % 60)}] compiling module ${step}/900 ... ok`);
  }

  lines.push("");
  for (let repeat = 0; repeat < 200; repeat++) {
    lines.push("npm warn deprecated inflight@1.0.6: This module is not supported");
  }

  lines.push("");
  lines.push(paint(" FAIL  src/checkout/session.test.ts > session validation", "31"));
  lines.push(paint("  \u00d7 every failure above is kept, not truncated away", "31"));
  lines.push("");
  lines.push(" Test Files  4 failed | 36 passed (40)");
  lines.push("      Tests  4 failed | 476 passed (480)");
  lines.push("   Start at  10:04:12");
  lines.push("   Duration  18.42s (transform 3.11s, setup 0ms)");
  lines.push("");
  lines.push("error Command failed with exit code 1.");

  return `${lines.join("\n")}\n`;
}
