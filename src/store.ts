import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.ts";
import type { Category, Stream } from "./twitch.ts";

/** One saved scan of a category: the streams that were live and their thumbnails. */
export interface Snapshot {
  category: Category;
  capturedAt: string;
  thumbSize: string;
  /** How many streams were requested (older scans don't have it). */
  limit?: number;
  language?: string;
  streams: StreamRecord[];
}

export interface StreamRecord extends Stream {
  /** Path of the thumbnail, relative to the category folder. */
  thumbFile: string;
  /** SHA-256 of the thumbnail bytes, used to skip re-embedding identical images (older scans don't have it). */
  hash?: string;
}

export interface EmbeddingMeta {
  model: string;
  repo: string;
  dims: number;
  /** Stream ids, in the same order as the vectors. */
  ids: string[];
  createdAt: string;
  options: Record<string, unknown>;
}

export interface EmbeddingSet extends EmbeddingMeta {
  vectors: Float32Array[];
}

const CATEGORIES_DIR = path.join(DATA_DIR, "categories");
const STAGING_SUFFIX = ".staging";

export const TOKEN_FILE = path.join(DATA_DIR, "twitch-token.json");

export function categoryDir(slug: string): string {
  return path.join(CATEGORIES_DIR, slug);
}

/** A fresh folder to build a new scan in, so a failed run never breaks the existing index. */
export function createStagingDir(slug: string): string {
  const dir = categoryDir(slug) + STAGING_SUFFIX;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "thumbs"), { recursive: true });
  return dir;
}

export function promoteStagingDir(slug: string): void {
  const finalDir = categoryDir(slug);
  fs.rmSync(finalDir, { recursive: true, force: true });
  fs.renameSync(finalDir + STAGING_SUFFIX, finalDir);
}

export function listIndexedSlugs(): string[] {
  if (!fs.existsSync(CATEGORIES_DIR)) return [];
  return fs
    .readdirSync(CATEGORIES_DIR)
    .filter((name) => !name.endsWith(STAGING_SUFFIX))
    .filter((name) => fs.existsSync(path.join(CATEGORIES_DIR, name, "snapshot.json")))
    .sort();
}

export function writeSnapshot(dir: string, snapshot: Snapshot): void {
  fs.writeFileSync(path.join(dir, "snapshot.json"), JSON.stringify(snapshot, null, 2));
}

export function loadSnapshot(slug: string): Snapshot | undefined {
  const file = path.join(categoryDir(slug), "snapshot.json");
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, "utf8")) as Snapshot;
}

export function saveEmbeddings(dir: string, meta: EmbeddingMeta, vectors: Float32Array[]): void {
  const embDir = path.join(dir, "embeddings");
  fs.mkdirSync(embDir, { recursive: true });
  const flat = new Float32Array(vectors.length * meta.dims);
  vectors.forEach((vector, i) => flat.set(vector, i * meta.dims));
  fs.writeFileSync(path.join(embDir, `${meta.model}.f32`), flat);
  fs.writeFileSync(path.join(embDir, `${meta.model}.json`), JSON.stringify(meta, null, 2));
}

export function loadEmbeddings(slug: string, model: string): EmbeddingSet | undefined {
  const embDir = path.join(categoryDir(slug), "embeddings");
  const metaFile = path.join(embDir, `${model}.json`);
  if (!fs.existsSync(metaFile)) return undefined;
  const meta = JSON.parse(fs.readFileSync(metaFile, "utf8")) as EmbeddingMeta;
  const buffer = fs.readFileSync(path.join(embDir, `${model}.f32`));
  // Copy into a fresh buffer: Float32Array needs 4-byte alignment, which Node's Buffer doesn't promise.
  const flat = new Float32Array(new Uint8Array(buffer).buffer);
  const vectors = meta.ids.map((_, i) => flat.subarray(i * meta.dims, (i + 1) * meta.dims));
  return { ...meta, vectors };
}

export function listEmbeddingModels(slug: string): string[] {
  const embDir = path.join(categoryDir(slug), "embeddings");
  if (!fs.existsSync(embDir)) return [];
  return fs
    .readdirSync(embDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -".json".length))
    .sort();
}
