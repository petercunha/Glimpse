// Builds the HTML pages that show search results as a thumbnail grid.
import fs from "node:fs";
import type { Hit } from "./search.ts";

export interface CompareColumn {
  label: string;
  /** One result list per query, in query order. */
  results: Hit[][];
}

export function searchPage(opts: { query: string; modelLabel: string; hits: Hit[] }): string {
  const body = `
    <header>
      <p class="eyebrow">Glimpse · ${escape(opts.modelLabel)}</p>
      <h1>${escape(opts.query)}</h1>
      <p class="sub">${opts.hits.length} best matches · ${escape(scanSummary(opts.hits))}</p>
    </header>
    <main class="grid">${opts.hits.map((hit, i) => card(hit, i + 1)).join("")}</main>`;
  return page(`Glimpse: ${opts.query}`, body);
}

export function comparePage(opts: { queries: string[]; columns: CompareColumn[] }): string {
  const allHits = opts.columns.flatMap((column) => column.results.flat());
  const sections = opts.queries
    .map((query, q) => {
      const rows = opts.columns
        .map(
          (column) => `
          <div class="model-row">
            <h3>${escape(column.label)}</h3>
            <div class="row">${column.results[q].map((hit, i) => card(hit, i + 1)).join("")}</div>
          </div>`,
        )
        .join("");
      return `<section><h2>“${escape(query)}”</h2>${rows}</section>`;
    })
    .join("");

  const body = `
    <header>
      <p class="eyebrow">Glimpse · model comparison</p>
      <h1>${opts.columns.map((column) => escape(column.label)).join(" vs ")}</h1>
      <p class="sub">${opts.queries.length} queries · ${escape(scanSummary(allHits))}</p>
    </header>
    <main>${sections}</main>`;
  return page("Glimpse: model comparison", body);
}

function card(hit: Hit, rank: number): string {
  const { stream } = hit;
  return `
    <a class="card" href="https://www.twitch.tv/${encodeURIComponent(stream.login)}" target="_blank" rel="noopener">
      <div class="thumb">
        <img src="${imageDataUri(hit.thumbPath)}" alt="" loading="lazy">
        <span class="badge rank">#${rank}</span>
        <span class="badge score" title="Similarity score">${hit.score.toFixed(3)}</span>
      </div>
      <div class="meta">
        <div class="name">${escape(stream.displayName)} <span>${stream.viewers.toLocaleString("en-US")} viewers</span></div>
        <div class="title" title="${escape(stream.title)}">${escape(stream.title)}</div>
        <div class="category">${escape(hit.snapshot.category.name)}</div>
      </div>
    </a>`;
}

// Thumbnails are copied into the page because the next scan deletes the old image files.
function imageDataUri(file: string): string {
  try {
    return `data:image/jpeg;base64,${fs.readFileSync(file).toString("base64")}`;
  } catch {
    return "";
  }
}

function scanSummary(hits: Hit[]): string {
  const snapshots = new Map(hits.map((hit) => [hit.snapshot.category.slug, hit.snapshot]));
  if (snapshots.size === 0) return "no results";
  const oldest = Math.min(...[...snapshots.values()].map((s) => Date.parse(s.capturedAt)));
  const names = [...snapshots.values()].map((s) => s.category.name).join(", ");
  return `${names} · scanned ${new Date(oldest).toLocaleString()}`;
}

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>
  :root {
    --bg: #f6f5f8; --surface: #ffffff; --text: #18161d; --muted: #6b6775;
    --border: #e4e1ea; --accent: #7c3aed; --badge-bg: rgba(15, 12, 20, 0.78); --badge-text: #fff;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f0e13; --surface: #1a1820; --text: #ece9f2; --muted: #9a95a6;
      --border: #2a2731; --accent: #a78bfa; --badge-bg: rgba(0, 0, 0, 0.72); --badge-text: #fff;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif; }
  header, main { max-width: 1400px; margin: 0 auto; padding: 0 16px; }
  header { padding-top: 32px; padding-bottom: 20px; }
  .eyebrow { margin: 0; color: var(--accent); font-weight: 600; font-size: 12px; letter-spacing: .06em; text-transform: uppercase; }
  h1 { margin: 6px 0 4px; font-size: 26px; font-weight: 650; }
  .sub { margin: 0; color: var(--muted); }
  .grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); padding-bottom: 48px; }
  section { padding: 8px 0 28px; border-top: 1px solid var(--border); }
  h2 { font-size: 18px; margin: 18px 0 12px; }
  h3 { font-size: 12px; margin: 14px 0 8px; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; }
  .row { display: grid; gap: 12px; grid-auto-flow: column; grid-auto-columns: minmax(220px, 1fr); overflow-x: auto; padding-bottom: 6px; }
  .card { display: block; background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
    overflow: hidden; color: inherit; text-decoration: none; transition: border-color .15s, transform .15s; }
  .card:hover { border-color: var(--accent); transform: translateY(-1px); }
  .thumb { position: relative; aspect-ratio: 16 / 9; background: var(--border); }
  .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .badge { position: absolute; top: 8px; padding: 2px 7px; border-radius: 6px; font-size: 12px; font-weight: 600;
    background: var(--badge-bg); color: var(--badge-text); font-variant-numeric: tabular-nums; }
  .rank { left: 8px; }
  .score { right: 8px; }
  .meta { padding: 10px 12px 12px; }
  .name { font-weight: 600; }
  .name span, .category { color: var(--muted); font-weight: 400; font-size: 12px; }
  .title { margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .category { margin-top: 4px; }
</style>
</head>
<body>${body}
</body>
</html>
`;
}
