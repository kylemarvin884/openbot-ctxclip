import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

/** Per-stream capture ceiling. Beyond this the stream is marked as clipped. */
export const CAPTURE_LIMIT = 8 * 1024 * 1024;

/** Joins already-split argv tokens back into a shell command, quoting unsafe tokens. */
export function shellCommand(tokens) {
  const safe = /^[A-Za-z0-9_./:=@+,-]+$/;
  return tokens
    .map((token) => (safe.test(token) ? token : `"${String(token).replace(/"/g, '\\"')}"`))
    .join(" ");
}

function collector() {
  const chunks = [];
  let bytes = 0;
  let truncated = false;
  return {
    push(chunk) {
      bytes += chunk.length;
      if (bytes <= CAPTURE_LIMIT) {
        chunks.push(chunk);
        return;
      }
      truncated = true;
      const room = CAPTURE_LIMIT - (bytes - chunk.length);
      if (room > 0) chunks.push(chunk.subarray(0, room));
    },
    result() {
      return { text: Buffer.concat(chunks).toString("utf8"), bytes, truncated };
    },
  };
}

function killTree(child) {
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true }).unref();
    return;
  }
  child.kill("SIGKILL");
}

/**
 * Runs a shell command and captures both streams (capped at CAPTURE_LIMIT each).
 * Never throws for a non-zero exit code; that is data, not an error.
 */
export function runCommand({ command, cwd = process.cwd(), timeoutMs = 0, env = process.env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true, env });
    const stdout = collector();
    const stderr = collector();
    let settled = false;
    let timer = null;

    const snapshot = (extra) => ({
      stdout: stdout.result(),
      stderr: stderr.result(),
      ...extra,
    });

    const settle = (payload) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(payload);
    };

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        killTree(child);
        settle(
          snapshot({
            code: 1,
            signal: "SIGKILL",
            timedOut: true,
          }),
        );
      }, timeoutMs);
      timer.unref?.();
    }

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      settle(
        snapshot({
          code: code ?? (signal ? 1 : 0),
          signal: signal ?? null,
          timedOut: false,
        }),
      );
    });
  });
}

export function runDirName(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

export async function writeSpill(dir, name, text) {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await fs.writeFile(file, text, "utf8");
  return file;
}
