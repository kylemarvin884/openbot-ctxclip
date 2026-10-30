// Child process used by the CLI tests: prints noisy output, optionally to stderr,
// then exits with a caller-provided code.
const exitCode = Number(process.argv[2] ?? 0);
const count = Number(process.argv[3] ?? 120);
const verbose = count > 0;
const WORDS = ["alpha", "beta", "gamma", "delta", "epsilon"];

if (verbose) {
  for (let i = 0; i < count; i++) {
    const tag = i % 4 === 0 ? "ok" : "pass";
    console.log(`test entry ${i} ${tag} ${WORDS[i % WORDS.length]} ${"x".repeat(24)}`);
  }
}

if (process.argv[4] === "noisy-stderr") {
  for (let i = 0; i < 40; i++) console.error(`warning: stderr noise ${i}`);
}

console.log("error: fixture failure (test/fixtures/emit.mjs:9:1)");
process.exit(exitCode);
