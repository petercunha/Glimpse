import path from "node:path";
import { categoryDir } from "./store.ts";
import type { EmbeddingSet, Snapshot, StreamRecord } from "./store.ts";

export interface SearchableCategory {
  snapshot: Snapshot;
  embeddings: EmbeddingSet;
}

export interface Hit {
  score: number;
  stream: StreamRecord;
  snapshot: Snapshot;
  thumbPath: string;
}

/** Ranks every indexed thumbnail by cosine similarity to the query vector. */
export function rank(query: Float32Array, categories: SearchableCategory[], top: number): Hit[] {
  const hits: Hit[] = [];
  for (const { snapshot, embeddings } of categories) {
    const streams = new Map(snapshot.streams.map((stream) => [stream.id, stream]));
    embeddings.ids.forEach((id, i) => {
      const stream = streams.get(id);
      if (!stream) return;
      hits.push({
        score: dot(query, embeddings.vectors[i]),
        stream,
        snapshot,
        thumbPath: path.join(categoryDir(snapshot.category.slug), stream.thumbFile),
      });
    });
  }
  hits.sort((a, b) => b.score - a.score);

  // A streamer can appear in two categories if they switched between scans.
  const seen = new Set<string>();
  return hits.filter((hit) => !seen.has(hit.stream.login) && seen.add(hit.stream.login)).slice(0, top);
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}
