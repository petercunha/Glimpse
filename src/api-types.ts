// Shapes of the web server's JSON responses, shared by src/server.ts and web/app.ts.

export interface ApiCategory {
  slug: string;
  name: string;
  streams: number;
  capturedAt: string;
  /** How many streams the last scan asked for, reused when rescanning. */
  limit: number;
  language?: string;
  /** False when the category has no embeddings for the server's model yet. */
  searchable: boolean;
}

export interface ApiScanProgress {
  label: string;
  message: string;
  done: number;
  total: number;
}

export interface ApiScanResult {
  ok: boolean;
  message: string;
  slug?: string;
  finishedAt: string;
}

export interface ApiState {
  model: { label: string; device: string; ready: boolean; error?: string };
  categories: ApiCategory[];
  scan: ApiScanProgress | null;
  lastScan: ApiScanResult | null;
}

export interface ApiResult {
  /** Similarity to the query, or null when browsing without a query. */
  score: number | null;
  login: string;
  displayName: string;
  title: string;
  viewers: number;
  language: string;
  category: string;
  slug: string;
  thumb: string;
  url: string;
}

export interface ApiSearchResponse {
  query: string;
  /** Streams searched across the selected categories. */
  total: number;
  results: ApiResult[];
  /** Selected categories that couldn't be searched (no embeddings for this model). */
  skipped: string[];
}

export interface ApiScanRequest {
  category: string;
  limit?: number;
  lang?: string;
}
