// The web app's server: serves the page, runs searches, and scans categories in the background.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { transformSync } from "amaro";
import type {
  ApiResult,
  ApiScanProgress,
  ApiScanRequest,
  ApiScanResult,
  ApiSearchResponse,
  ApiState,
} from "./api-types.ts";
import { ROOT } from "./config.ts";
import type { Size } from "./config.ts";
import { loadEmbedder } from "./embedders.ts";
import type { Embedder } from "./embedders.ts";
import { embedScan, fetchScan, finishScan } from "./indexer.ts";
import { listCategories, loadSearchable } from "./library.ts";
import { MODELS } from "./models.ts";
import type { Device, ModelName } from "./models.ts";
import { rank } from "./search.ts";
import { categoryDir } from "./store.ts";
import type { Snapshot, StreamRecord } from "./store.ts";
import type { TwitchClient } from "./twitch.ts";

const WEB_DIR = path.join(ROOT, "web");
const MAX_RESULTS = 60;
const MAX_SCAN_LIMIT = 500;

const STATIC_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
  "/favicon.svg": { file: "favicon.svg", type: "image/svg+xml" },
};

export interface ServerOptions {
  host: string;
  port: number;
  model: ModelName;
  device: Device;
  detail: number;
  size: Size;
  twitch: () => TwitchClient;
}

export async function startServer(options: ServerOptions): Promise<http.Server> {
  const app = new App(options);
  const server = http.createServer((req, res) => {
    app.handle(req, res).catch((error: Error) => {
      if (!res.headersSent) sendJson(res, 500, { error: error.message });
      else res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      reject(error.code === "EADDRINUSE" ? new Error(`Port ${options.port} is in use. Try --port ${options.port + 1}`) : error);
    });
    server.listen(options.port, options.host, resolve);
  });
  return server;
}

class App {
  #opts: ServerOptions;
  #embedder: Promise<Embedder>;
  #ready = false;
  #modelError: string | undefined;
  #device: Device;
  #queue: Promise<unknown> = Promise.resolve();
  #scan: ApiScanProgress | null = null;
  #lastScan: ApiScanResult | null = null;

  constructor(opts: ServerOptions) {
    this.#opts = opts;
    this.#device = opts.device;
    // Load the model up front (images too, for scans) so the first search is fast.
    this.#embedder = loadEmbedder(opts.model, { device: opts.device, images: true, detail: opts.detail });
    this.#embedder.then(
      (embedder) => {
        this.#ready = true;
        this.#device = embedder.device;
      },
      (error: Error) => {
        this.#modelError = error.message;
      },
    );
  }

  async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const { pathname } = url;

    if (req.method === "GET") {
      const staticFile = STATIC_FILES[pathname];
      if (staticFile) return sendFile(res, path.join(WEB_DIR, staticFile.file), staticFile.type);
      if (pathname === "/app.js") return this.#sendScript(res);
      if (pathname === "/api/state") return sendJson(res, 200, this.#state());
      if (pathname === "/api/search") return this.#search(url, res);
      if (pathname.startsWith("/thumbs/")) return this.#sendThumb(pathname, res);
    }
    if (req.method === "POST" && pathname === "/api/scan") return this.#startScan(req, res);
    sendJson(res, 404, { error: "Not found" });
  }

  #state(): ApiState {
    return {
      model: {
        label: MODELS[this.#opts.model].label,
        device: this.#device,
        ready: this.#ready,
        error: this.#modelError,
      },
      categories: listCategories().map(({ models, ...category }) => ({
        ...category,
        searchable: models.includes(this.#opts.model),
      })),
      scan: this.#scan,
      lastScan: this.#lastScan,
    };
  }

  async #search(url: URL, res: http.ServerResponse): Promise<void> {
    const query = (url.searchParams.get("q") ?? "").trim().slice(0, 300);
    const slugs = (url.searchParams.get("c") ?? "").split(",").filter(Boolean);
    const { found, missingModel } = loadSearchable(slugs.length ? slugs : undefined, this.#opts.model);
    const total = found.reduce((sum, { snapshot }) => sum + snapshot.streams.length, 0);

    let results: ApiResult[];
    if (query) {
      const embedder = await this.#embedder;
      const vector = await this.#exclusive(() => embedder.embedQuery(query));
      results = rank(vector, found, MAX_RESULTS).map((hit) => toResult(hit.stream, hit.snapshot, hit.score));
    } else {
      // No query: show everything that's live, most viewers first.
      const seen = new Set<string>();
      results = found
        .flatMap(({ snapshot }) => snapshot.streams.map((stream) => toResult(stream, snapshot, null)))
        .sort((a, b) => b.viewers - a.viewers)
        .filter((result) => !seen.has(result.login) && seen.add(result.login));
    }

    const body: ApiSearchResponse = { query, total, results, skipped: missingModel };
    sendJson(res, 200, body);
  }

  async #startScan(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Requiring JSON stops other websites from triggering scans with a plain form post.
    if (!req.headers["content-type"]?.startsWith("application/json")) {
      return sendJson(res, 415, { error: "Expected JSON" });
    }
    const body = (await readJson(req)) as Partial<ApiScanRequest>;
    const category = typeof body.category === "string" ? body.category.trim() : "";
    if (!category || category.length > 200) return sendJson(res, 400, { error: "Enter a category name or URL." });
    const limit = Math.min(MAX_SCAN_LIMIT, Math.max(1, Math.round(Number(body.limit) || 50)));
    const lang = typeof body.lang === "string" && /^[a-z]{2}$/i.test(body.lang) ? body.lang.toLowerCase() : undefined;

    if (this.#scan) {
      return sendJson(res, 409, { error: `Already scanning ${this.#scan.label}. Try again when it's done.` });
    }
    this.#scan = { label: category, message: "Finding the category…", done: 0, total: 0 };
    void this.#runScan(category, limit, lang);
    sendJson(res, 202, { ok: true });
  }

  async #runScan(input: string, limit: number, lang: string | undefined): Promise<void> {
    const update = (patch: Partial<ApiScanProgress>) => {
      if (this.#scan) this.#scan = { ...this.#scan, ...patch };
    };
    try {
      const scan = await fetchScan(this.#opts.twitch(), input, { limit, lang, size: this.#opts.size }, (status, category) =>
        update({ label: category.name, message: capitalize(status) }),
      );
      const { category, streams } = scan.snapshot;
      update({ message: "Analyzing thumbnails…", done: 0, total: streams.length });
      const embedder = await this.#embedder;
      const result = await embedScan(embedder, scan, {
        exclusive: (fn) => this.#exclusive(fn),
        onProgress: (done, total, reused) =>
          update({ message: reused ? `Analyzing new thumbnails (${reused} unchanged)…` : "Analyzing thumbnails…", done, total }),
      });
      finishScan(scan);
      const reused = result.reused ? ` (reused ${result.reused} unchanged thumbnails)` : "";
      this.#lastScan = {
        ok: true,
        slug: category.slug,
        message: `Scanned ${streams.length} live streams in ${category.name}${reused}`,
        finishedAt: new Date().toISOString(),
      };
    } catch (error) {
      this.#lastScan = { ok: false, message: (error as Error).message, finishedAt: new Date().toISOString() };
    } finally {
      this.#scan = null;
    }
  }

  /** Runs model calls one at a time; scans release the model between batches so searches stay quick. */
  #exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => {});
    return run;
  }

  // The browser script is TypeScript too; strip the types on the way out (no build step).
  #sendScript(res: http.ServerResponse): void {
    const source = fs.readFileSync(path.join(WEB_DIR, "app.ts"), "utf8");
    const { code } = transformSync(source, { mode: "strip-only" });
    res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(code);
  }

  #sendThumb(pathname: string, res: http.ServerResponse): void {
    const match = pathname.match(/^\/thumbs\/([a-z0-9-]+)\/([a-z0-9_]+\.jpg)$/);
    if (!match) return sendJson(res, 404, { error: "Not found" });
    fs.readFile(path.join(categoryDir(match[1]), "thumbs", match[2]), (error, data) => {
      if (error) return sendJson(res, 404, { error: "Not found" });
      // URLs include the scan time, so a cached copy never goes stale.
      res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=31536000, immutable" });
      res.end(data);
    });
  }
}

function toResult(stream: StreamRecord, snapshot: Snapshot, score: number | null): ApiResult {
  const { slug, name } = snapshot.category;
  return {
    score: score === null ? null : Number(score.toFixed(4)),
    login: stream.login,
    displayName: stream.displayName,
    title: stream.title,
    viewers: stream.viewers,
    language: stream.language,
    category: name,
    slug,
    thumb: `/thumbs/${slug}/${path.basename(stream.thumbFile)}?v=${Date.parse(snapshot.capturedAt)}`,
    url: `https://www.twitch.tv/${stream.login}`,
  };
}

function sendFile(res: http.ServerResponse, file: string, type: string): void {
  fs.readFile(file, (error, data) => {
    if (error) return sendJson(res, 404, { error: "Not found" });
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
    res.end(data);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 16_384) throw new Error("Request too large");
  }
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
