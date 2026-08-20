import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

export interface HttpResponse {
  status: number;
  body: string;
  /** Raw response header block. */
  headerBlock: string;
}

export interface CurlRequestOptions {
  cookieJar: string;
  userAgent?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Milliseconds to sleep before issuing the request (rate limiting). */
  throttleMs?: number;
  maxTimeMs?: number;
  /** Extra raw curl flags, appended before the URL. */
  extraArgs?: string[];
}

export class CurlError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body: string,
  ) {
    super(message);
    this.name = "CurlError";
  }
}

export function isChallenge(body: string): boolean {
  return body.includes("Just a moment") || body.includes("challenges.cloudflare.com");
}

function execCurl(args: string[], timeoutMs: number): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("curl", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("curl timed out"));
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (stderr.trim()) stdout += `\n[stderr] ${stderr.trim()}`;
      resolve({ code: code ?? -1, stdout });
    });
  });
}

function parseStatus(headerBlock: string): number {
  const m = headerBlock.match(/^HTTP\/\S+\s+(\d{3})/m);
  return m ? Number(m[1]) : 0;
}

/**
 * Issues an HTTP request using the `curl` binary.
 *
 * We shell out to curl (instead of Node's fetch / undici) because the Festzelt OS
 * portals sit behind Cloudflare bot protection that rejects Node's TLS fingerprint
 * (HTTP 403 "Just a moment...") while allowing curl with a browser user agent.
 */
export async function curlRequest(
  url: string,
  options: CurlRequestOptions,
): Promise<HttpResponse> {
  const dir = mkdtempSync(join(tmpdir(), "fza-"));
  const bodyFile = join(dir, "body");
  const headerFile = join(dir, "headers");

  const args = [
    "-sS",
    "--compressed",
    "--max-time",
    String(Math.floor((options.maxTimeMs ?? 30000) / 1000)),
    "-b",
    options.cookieJar,
    "-c",
    options.cookieJar,
    "-A",
    options.userAgent ?? DEFAULT_USER_AGENT,
    "-D",
    headerFile,
    "-o",
    bodyFile,
  ];

  if (options.body !== undefined) {
    args.push("-X", "POST", "-H", "Content-Type: application/json", "--data-binary", options.body);
  }

  for (const [name, value] of Object.entries(options.headers ?? {})) {
    args.push("-H", `${name}: ${value}`);
  }

  args.push(...(options.extraArgs ?? []), url);

  try {
    if (options.throttleMs) {
      await new Promise((r) => setTimeout(r, options.throttleMs));
    }
    await execCurl(args, options.maxTimeMs ?? 30000);
    const { readFile } = await import("node:fs/promises");
    const [body, headerBlock] = await Promise.all([
      readFile(bodyFile, "utf8"),
      readFile(headerFile, "utf8"),
    ]);
    return { status: parseStatus(headerBlock), body, headerBlock };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}