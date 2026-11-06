// Scanning a category: fetch live streams, download thumbnails, embed them. Shared by the CLI and web server.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Size } from "./config.ts";
import type { Embedder } from "./embedders.ts";
import { MODELS } from "./models.ts";
import {
  categoryDir,
  createStagingDir,
  listIndexedSlugs,
  loadEmbeddings,
  loadSnapshot,
  promoteStagingDir,
  saveEmbeddings,
  writeSnapshot,
} from "./store.ts";
import type { Snapshot, StreamRecord } from "./store.ts";
import { categorySlug, thumbnailUrl } from "./twitch.ts";
import type { Category, Stream, TwitchClient } from "./twitch.ts";

export interface ScanOptions {
  limit: number;
  lang?: string;
  size: Size;
}

/** A scan being built: a fresh one in a staging folder, or a saved one being re-embedded. */
export interface PendingScan {
  slug: string;
  dir: string;
  snapshot: Snapshot;
  staged: boolean;
}

export class NoStreamsError extends Error {}

type StatusCallback = (status: string, category: Category) => void;

/** Scans Twitch into a staging folder. Call embedScan, then finishScan to make it live. */
export async function fetchScan(
  twitch: TwitchClient,
  input: string,
  opts: ScanOptions,
  onStatus: StatusCallback = () => {},
): Promise<PendingScan> {
  const category = await twitch.findCategory(input);
  const lang = opts.lang ? ` (${opts.lang})` : "";
  onStatus(`fetching the top ${opts.limit} live streams${lang}…`, category);
  const streams = await twitch.getStreams(category.id, opts.limit, opts.lang);
  if (streams.length === 0) throw new NoStreamsError(`No one is live in ${category.name}${lang} right now.`);

  onStatus(`downloading ${streams.length} thumbnails…`, category);
  const dir = createStagingDir(category.slug);
  const records = await downloadThumbnails(streams, dir, opts.size);
  if (records.length === 0) throw new NoStreamsError(`None of the ${category.name} thumbnails were ready.`);
  const missing = streams.length - records.length;
  onStatus(`saved ${records.length} thumbnails${missing ? ` (${missing} not ready yet)` : ""}`, category);

  const snapshot: Snapshot = {
    category,
    capturedAt: new Date().toISOString(),
    thumbSize: `${opts.size.width}x${opts.size.height}`,
    limit: opts.limit,
    language: opts.lang,
    streams: records,
  };
  writeSnapshot(dir, snapshot);
  return { slug: category.slug, dir, snapshot, staged: true };
}

/** The saved scan for a category, to embed again with another model or setting. */
export function savedScan(input: string): PendingScan {
  const slug = categorySlug(input);
  const snapshot = loadSnapshot(slug);
  if (!snapshot) throw new Error(`"${slug}" hasn't been indexed yet. Run: glimpse index ${slug}`);
  return { slug, dir: categoryDir(slug), snapshot, staged: false };
}

// Measured on WebGPU: 2 images per call is as fast as 8 (~0.37 s/image) but holds the model for
// 0.75 s instead of 3 s, so web searches made during a scan stay quick.
const EMBED_CHUNK = 2;

export interface EmbedResult {
  /** Thumbnails run through the model. */
  embedded: number;
  /** Thumbnails byte-identical to one embedded before, whose embedding was reused. */
  reused: number;
}

export async function embedScan(
  embedder: Embedder,
  scan: PendingScan,
  opts: {
    /** Called as new thumbnails are embedded; `total` counts only the ones that weren't reused. */
    onProgress?: (done: number, total: number, reused: number) => void;
    /** Wraps each model call, so the web server can let searches run between batches. */
    exclusive?: <T>(fn: () => Promise<T>) => Promise<T>;
    /** Reuse embeddings of identical thumbnails (default true). */
    reuse?: boolean;
  } = {},
): Promise<EmbedResult> {
  const exclusive = opts.exclusive ?? (<T>(fn: () => Promise<T>) => fn());
  const streams = scan.snapshot.streams.map((stream) => ({
    ...stream,
    hash: stream.hash ?? hashFile(path.join(scan.dir, stream.thumbFile)),
  }));

  // Look up each thumbnail by hash; group the rest so identical images are embedded once.
  const known = opts.reuse === false ? new Map<string, Float32Array>() : knownEmbeddings(embedder);
  const vectors: (Float32Array | undefined)[] = streams.map((stream) => known.get(stream.hash));
  const todo = new Map<string, number[]>();
  streams.forEach((stream, i) => {
    if (vectors[i]) return;
    const indices = todo.get(stream.hash) ?? [];
    indices.push(i);
    todo.set(stream.hash, indices);
  });
  const reused = vectors.filter(Boolean).length;
  const pending = [...todo.values()];
  opts.onProgress?.(0, pending.length, reused);

  for (let i = 0; i < pending.length; i += EMBED_CHUNK) {
    const chunk = pending.slice(i, i + EMBED_CHUNK);
    const paths = chunk.map((indices) => path.join(scan.dir, streams[indices[0]].thumbFile));
    const embedded = await exclusive(() => embedder.embedImages(paths));
    chunk.forEach((indices, j) => indices.forEach((index) => (vectors[index] = embedded[j])));
    opts.onProgress?.(Math.min(i + EMBED_CHUNK, pending.length), pending.length, reused);
    // Model calls block the event loop; pause so waiting web requests get their turn first.
    await new Promise((resolve) => setImmediate(resolve));
  }

  const done = vectors as Float32Array[]; // every slot is filled by now
  scan.snapshot = { ...scan.snapshot, streams };
  writeSnapshot(scan.dir, scan.snapshot); // saves the hashes for next time
  saveEmbeddings(
    scan.dir,
    {
      model: embedder.name,
      repo: MODELS[embedder.name].repo,
      dims: done[0].length,
      ids: streams.map((stream) => stream.id),
      createdAt: new Date().toISOString(),
      options: { ...embedder.options, device: embedder.device },
    },
    done,
  );
  return { embedded: streams.length - reused, reused };
}

/**
 * Embeddings already saved for this model, keyed by thumbnail hash, across every indexed category.
 * Only reused when the image detail matches; precision differences between GPU and CPU are
 * negligible (cosine 0.9995), so those are reused too.
 */
function knownEmbeddings(embedder: Embedder): Map<string, Float32Array> {
  const known = new Map<string, Float32Array>();
  for (const slug of listIndexedSlugs()) {
    const snapshot = loadSnapshot(slug);
    const embeddings = loadEmbeddings(slug, embedder.name);
    if (!snapshot || !embeddings || embeddings.options.detail !== embedder.options.detail) continue;
    const streams = new Map(snapshot.streams.map((stream) => [stream.id, stream]));
    embeddings.ids.forEach((id, i) => {
      const stream = streams.get(id);
      if (!stream) return;
      const hash = stream.hash ?? hashFile(path.join(categoryDir(slug), stream.thumbFile));
      if (hash) known.set(hash, embeddings.vectors[i]);
    });
  }
  return known;
}

function hashBytes(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function hashFile(file: string): string {
  try {
    return hashBytes(fs.readFileSync(file));
  } catch {
    return ""; // thumbnail missing; never matches
  }
}

/** Makes a fresh scan live, replacing the category's previous one. */
export function finishScan(scan: PendingScan): void {
  if (scan.staged) promoteStagingDir(scan.slug);
}

async function downloadThumbnails(streams: Stream[], dir: string, size: Size): Promise<StreamRecord[]> {
  const results = await mapWithConcurrency(streams, 8, async (stream) => {
    try {
      const res = await fetch(thumbnailUrl(stream.thumbnailTemplate, size));
      // Twitch redirects to a placeholder image when a stream's preview isn't ready yet.
      if (!res.ok || res.url.includes("404_preview")) return undefined;
      const bytes = new Uint8Array(await res.arrayBuffer());
      const thumbFile = `thumbs/${stream.login}.jpg`;
      fs.writeFileSync(path.join(dir, thumbFile), bytes);
      return { ...stream, thumbFile, hash: hashBytes(bytes) };
    } catch {
      return undefined;
    }
  });
  return results.filter((record) => record !== undefined);
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
