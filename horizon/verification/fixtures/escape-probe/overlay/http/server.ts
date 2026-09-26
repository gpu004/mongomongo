import { readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DocumentService } from "../application/document-service.ts";
import type { HealthResponse, InsertRequest, UpdateRequest } from "../domain/contracts.ts";

// ADVERSARIAL PROBE: the search contract is untouched; GET /__probe attempts every escape the
// sandbox must deny and reports the raw outcome so the harness can record it as evidence.

interface ProbeAttempt {
  ok: boolean;
  detail: string;
}

export interface ProbeReport {
  uid: number | null;
  gid: number | null;
  cwd: string;
  /** Names of every environment variable visible to the candidate. */
  envKeys: string[];
  /** Each requested host path: readable (ok) or the error code. */
  hostReads: Record<string, ProbeAttempt>;
  writeInSnapshot: ProbeAttempt;
  writeInRoot: ProbeAttempt;
  symlinkToRoot: ProbeAttempt;
  /** Each requested URL: reachable (ok, with status) or the failure cause. */
  network: Record<string, ProbeAttempt>;
}

function attempt(fn: () => string): ProbeAttempt {
  try {
    return { ok: true, detail: fn() };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, detail: code ?? (error instanceof Error ? error.message : String(error)) };
  }
}

async function probe(url: URL): Promise<ProbeReport> {
  const hostReads: Record<string, ProbeAttempt> = {};
  for (const path of url.searchParams.getAll("path")) {
    hostReads[path] = attempt(() => {
      const content = readFileSync(path, "utf8");
      return `read ${content.length} chars`;
    });
  }
  const network: Record<string, ProbeAttempt> = {};
  const timeoutMs = Number(url.searchParams.get("timeoutMs") ?? 3000);
  for (const target of url.searchParams.getAll("url")) {
    try {
      const response = await fetch(target, { signal: AbortSignal.timeout(timeoutMs) });
      network[target] = { ok: true, detail: `status ${response.status}` };
    } catch (error) {
      const cause = (error as Error & { cause?: NodeJS.ErrnoException }).cause;
      network[target] = {
        ok: false,
        detail: cause?.code ?? (error instanceof Error ? error.name : String(error)),
      };
    }
  }
  return {
    uid: process.getuid?.() ?? null,
    gid: process.getgid?.() ?? null,
    cwd: process.cwd(),
    envKeys: Object.keys(process.env).sort(),
    hostReads,
    writeInSnapshot: attempt(() => {
      writeFileSync(resolve(process.cwd(), "src", "__escape.txt"), "tampered");
      return "wrote src/__escape.txt";
    }),
    writeInRoot: attempt(() => {
      writeFileSync("/__escape.txt", "tampered");
      return "wrote /__escape.txt";
    }),
    symlinkToRoot: attempt(() => {
      symlinkSync("/", resolve(process.cwd(), "src", "__root"));
      return `linked; / has ${readdirSync(resolve(process.cwd(), "src", "__root")).length} entries`;
    }),
    network,
  };
}

/**
 * HTTP adapter. Routes:
 *   GET    /health
 *   POST   /documents            {id,title,body}
 *   GET    /documents/:id
 *   PATCH  /documents/:id        {title?,body?}
 *   DELETE /documents/:id
 *   GET    /search?q=...&limit=N
 */
export function createApp(service = new DocumentService()) {
  return createServer((req, res) => {
    handle(service, req, res).catch((error: unknown) => {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });
}

async function handle(
  service: DocumentService,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = req.method ?? "GET";

  if (method === "GET" && url.pathname === "/__probe") {
    return sendJson(res, 200, await probe(url));
  }

  if (method === "GET" && url.pathname === "/health") {
    const body: HealthResponse = { ok: true, documents: service.documentCount };
    return sendJson(res, 200, body);
  }

  if (method === "GET" && url.pathname === "/search") {
    const q = url.searchParams.get("q") ?? "";
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw === null ? undefined : Number(limitRaw);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
      return sendJson(res, 400, { error: "limit must be a non-negative integer" });
    }
    return sendJson(res, 200, { ids: service.search(limit === undefined ? { q } : { q, limit }) });
  }

  if (method === "POST" && url.pathname === "/documents") {
    const payload = await readJson(req);
    if (!isInsertRequest(payload)) {
      return sendJson(res, 400, { error: "expected {id,title,body} strings" });
    }
    if (service.get(payload.id)) {
      return sendJson(res, 409, { error: `document ${payload.id} already exists` });
    }
    const record = service.insert(payload);
    return sendJson(res, 201, record);
  }

  const documentMatch = /^\/documents\/([^/]+)$/u.exec(url.pathname);
  if (documentMatch) {
    const id = decodeURIComponent(documentMatch[1] ?? "");
    if (method === "GET") {
      const record = service.get(id);
      return record ? sendJson(res, 200, record) : sendJson(res, 404, { error: "not found" });
    }
    if (method === "PATCH") {
      const payload = await readJson(req);
      if (!isUpdateRequest(payload)) {
        return sendJson(res, 400, { error: "expected {title?,body?} strings" });
      }
      if (!service.get(id)) {
        return sendJson(res, 404, { error: "not found" });
      }
      return sendJson(res, 200, service.update(id, payload));
    }
    if (method === "DELETE") {
      return service.delete(id)
        ? sendJson(res, 204, null)
        : sendJson(res, 404, { error: "not found" });
    }
  }

  sendJson(res, 404, { error: "no route" });
}

function isInsertRequest(value: unknown): value is InsertRequest {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    record.id.length > 0 &&
    typeof record.title === "string" &&
    typeof record.body === "string"
  );
}

function isUpdateRequest(value: unknown): value is UpdateRequest {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const titleOk = record.title === undefined || typeof record.title === "string";
  const bodyOk = record.body === undefined || typeof record.body === "string";
  return titleOk && bodyOk && (record.title !== undefined || record.body !== undefined);
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (text.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve(undefined);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (body === null) {
    res.writeHead(status);
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

let invokedPath: string | null = null;
if (process.argv[1] !== undefined) {
  try {
    invokedPath = realpathSync(resolve(process.argv[1]));
  } catch {}
}
// realpath both sides: a symlinked TMPDIR (macOS /var -> /private/var) makes the two spellings differ.
const isMain = invokedPath !== null && invokedPath === realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  const port = Number(process.env.PORT ?? 0);
  const host = process.env.HOST ?? "127.0.0.1";
  const server = createApp();
  server.listen(port, host, () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    process.stdout.write(`${JSON.stringify({ listening: true, host, port: actualPort })}\n`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
