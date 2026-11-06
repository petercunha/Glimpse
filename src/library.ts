// Reading what's been indexed, for the CLI and web server.
import type { ModelName } from "./models.ts";
import type { SearchableCategory } from "./search.ts";
import { listEmbeddingModels, listIndexedSlugs, loadEmbeddings, loadSnapshot } from "./store.ts";
import { categorySlug } from "./twitch.ts";

// Thumbnails refresh every few minutes and streams end, so older scans drift from what's live.
export const STALE_AFTER_MINUTES = 30;

export interface CategorySummary {
  slug: string;
  name: string;
  streams: number;
  capturedAt: string;
  limit: number;
  language?: string;
  models: string[];
}

export function listCategories(): CategorySummary[] {
  const summaries: CategorySummary[] = [];
  for (const slug of listIndexedSlugs()) {
    const snapshot = loadSnapshot(slug);
    if (!snapshot) continue; // replaced mid-read by a scan finishing
    summaries.push({
      slug,
      name: snapshot.category.name,
      streams: snapshot.streams.length,
      capturedAt: snapshot.capturedAt,
      limit: snapshot.limit ?? Math.max(50, snapshot.streams.length),
      language: snapshot.language,
      models: listEmbeddingModels(slug),
    });
  }
  return summaries;
}

export interface SearchableSet {
  found: SearchableCategory[];
  /** Indexed, but not embedded with the requested model. */
  missingModel: string[];
  notIndexed: string[];
}

/** Loads the saved scans to search. `inputs` defaults to every indexed category. */
export function loadSearchable(inputs: string[] | undefined, model: ModelName): SearchableSet {
  const slugs = inputs?.length ? inputs.map(categorySlug) : listIndexedSlugs();
  const set: SearchableSet = { found: [], missingModel: [], notIndexed: [] };
  for (const slug of slugs) {
    const snapshot = loadSnapshot(slug);
    if (!snapshot) {
      set.notIndexed.push(slug);
      continue;
    }
    const embeddings = loadEmbeddings(slug, model);
    if (embeddings) set.found.push({ snapshot, embeddings });
    else set.missingModel.push(slug);
  }
  return set;
}

export function minutesSince(iso: string): number {
  return (Date.now() - Date.parse(iso)) / 60_000;
}
