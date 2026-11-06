import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { styleText } from "node:util";
import { Command, InvalidArgumentError, Option } from "commander";
import { RESULTS_DIR, loadEnv, parseSize, requireEnv } from "./config.ts";
import { NoStreamsError, embedScan, fetchScan, finishScan, savedScan } from "./indexer.ts";
import type { PendingScan } from "./indexer.ts";
import { STALE_AFTER_MINUTES, listCategories, loadSearchable, minutesSince } from "./library.ts";
import { DEVICES, GEMMA_DETAIL_LEVELS, MODELS, MODEL_NAMES } from "./models.ts";
import type { Device, ModelName } from "./models.ts";
import { comparePage, searchPage } from "./report.ts";
import type { CompareColumn } from "./report.ts";
import { rank } from "./search.ts";
import type { Hit, SearchableCategory } from "./search.ts";
import { TOKEN_FILE } from "./store.ts";
import { TwitchClient } from "./twitch.ts";

interface IndexOptions {
  limit: number;
  lang?: string;
  model: ModelName | "all";
  size: string;
  detail: string;
  device: Device;
  refresh: boolean;
  cache: boolean;
}

interface SearchOptions {
  category?: string[];
  top: number;
  model: ModelName;
  device: Device;
  open?: boolean;
  json?: boolean;
}

interface CompareOptions {
  category?: string[];
  top: number;
  device: Device;
  open: boolean;
}

interface ServeOptions {
  port: number;
  host: string;
  model: ModelName;
  device: Device;
  detail: string;
  size: string;
  open?: boolean;
}

// ---------- index ----------

async function indexCommand(inputs: string[], opts: IndexOptions): Promise<void> {
  const models = opts.model === "all" ? MODEL_NAMES : [opts.model];
  const scans: PendingScan[] = [];

  if (opts.refresh) {
    const twitch = twitchClient();
    const scanOptions = { limit: opts.limit, lang: opts.lang, size: parseSize(opts.size) };
    for (const input of inputs) {
      try {
        scans.push(await fetchScan(twitch, input, scanOptions, (status, category) => info(`${category.name}: ${status}`)));
      } catch (error) {
        if (!(error instanceof NoStreamsError)) throw error;
        warn(`${error.message} Skipping.`);
      }
    }
  } else {
    for (const input of inputs) {
      const scan = savedScan(input);
      const { category, streams, capturedAt } = scan.snapshot;
      info(`${category.name}: re-using the ${streams.length} thumbnails from ${ago(capturedAt)}`);
      scans.push(scan);
    }
  }
  if (scans.length === 0) return;

  const { loadEmbedder } = await import("./embedders.ts");
  for (const model of models) {
    info(`Loading ${MODELS[model].label} (${opts.device})…`);
    const embedder = await loadEmbedder(model, { device: opts.device, images: true, detail: Number(opts.detail) });
    for (const scan of scans) {
      const { name } = scan.snapshot.category;
      const started = performance.now();
      const result = await embedScan(embedder, scan, {
        reuse: opts.cache,
        onProgress: (done, total) => progress(`${name}: embedding ${done}/${total}`),
      });
      progress("");
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      const reused = result.reused ? `, reused ${result.reused} unchanged` : "";
      info(`${name}: embedded ${result.embedded} thumbnails${reused} in ${seconds}s`);
    }
    await embedder.dispose();
  }

  for (const scan of scans) finishScan(scan);
  info(styleText("green", `Done. Try: glimpse search "someone wearing headphones"`));
}

// ---------- search ----------

async function searchCommand(query: string, opts: SearchOptions): Promise<void> {
  const categories = searchableOrExplain(opts.category, opts.model);
  const { loadEmbedder } = await import("./embedders.ts");
  const embedder = await loadEmbedder(opts.model, { device: opts.device, images: false });
  const vector = await embedder.embedQuery(query);
  await embedder.dispose();
  const hits = rank(vector, categories, opts.top);

  if (opts.json) {
    console.log(JSON.stringify(hits.map(hitJson), null, 2));
    return;
  }

  printHits(hits, categories.length > 1);
  const file = writeResultsPage("search.html", searchPage({ query, modelLabel: MODELS[opts.model].label, hits }));
  if (opts.open) openFile(file);
  else info(styleText("dim", `\nThumbnails: ${file}  (add --open to view them in your browser)`));
}

function hitJson(hit: Hit) {
  const { stream } = hit;
  return {
    score: Number(hit.score.toFixed(4)),
    login: stream.login,
    displayName: stream.displayName,
    url: `https://www.twitch.tv/${stream.login}`,
    title: stream.title,
    viewers: stream.viewers,
    category: hit.snapshot.category.name,
    capturedAt: hit.snapshot.capturedAt,
    thumbnail: hit.thumbPath,
  };
}

function printHits(hits: Hit[], showCategory: boolean): void {
  if (hits.length === 0) {
    console.log("No results.");
    return;
  }
  const width = process.stdout.columns || 120;
  const loginWidth = Math.max(8, ...hits.map((hit) => hit.stream.login.length));
  const catWidth = showCategory ? Math.min(18, Math.max(...hits.map((hit) => hit.snapshot.category.name.length))) : 0;
  const fixed = 3 + 2 + 5 + 2 + loginWidth + 2 + 7 + 2 + (showCategory ? catWidth + 2 : 0);

  hits.forEach((hit, i) => {
    const { stream } = hit;
    const cols = [
      styleText("dim", String(i + 1).padStart(3)),
      styleText("cyan", hit.score.toFixed(3)),
      stream.login.padEnd(loginWidth),
      styleText("dim", compactNumber(stream.viewers).padStart(7)),
    ];
    if (showCategory) cols.push(styleText("dim", truncate(hit.snapshot.category.name, catWidth).padEnd(catWidth)));
    cols.push(truncate(stream.title.replace(/\s+/g, " ").trim(), Math.max(20, width - fixed)));
    console.log(cols.join("  "));
  });
}

// ---------- compare ----------

async function compareCommand(queries: string[], opts: CompareOptions): Promise<void> {
  const { loadEmbedder } = await import("./embedders.ts");
  const columns: CompareColumn[] = [];
  for (const model of MODEL_NAMES) {
    const categories = searchableOrExplain(opts.category, model, model === MODEL_NAMES[0]);
    const embedder = await loadEmbedder(model, { device: opts.device, images: false });
    const results: Hit[][] = [];
    for (const query of queries) results.push(rank(await embedder.embedQuery(query), categories, opts.top));
    await embedder.dispose();
    columns.push({ label: MODELS[model].label, results });
  }

  queries.forEach((query, q) => {
    console.log(styleText("bold", `\n“${query}”`));
    for (const column of columns) {
      const top = column.results[q].slice(0, 3).map((hit) => `${hit.stream.login} ${styleText("dim", hit.score.toFixed(3))}`);
      console.log(`  ${column.label.padEnd(18)} ${top.join(", ")}`);
    }
  });

  const file = writeResultsPage("compare.html", comparePage({ queries, columns }));
  if (opts.open) openFile(file);
  info(styleText("dim", `\nSide-by-side thumbnails: ${file}`));
}

// ---------- list ----------

function listCommand(): void {
  const categories = listCategories();
  if (categories.length === 0) {
    console.log("Nothing indexed yet. Try: glimpse index just-chatting");
    return;
  }
  const rows = categories.map((c) => [c.slug, String(c.streams), ago(c.capturedAt), c.models.join(", ")]);
  const header = ["CATEGORY", "STREAMS", "SCANNED", "MODELS"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const format = (row: string[]) => row.map((cell, i) => cell.padEnd(widths[i])).join("   ").trimEnd();
  console.log(styleText("dim", format(header)));
  for (const row of rows) console.log(format(row));
}

// ---------- serve ----------

async function serveCommand(opts: ServeOptions): Promise<void> {
  const { startServer } = await import("./server.ts");
  const server = await startServer({
    host: opts.host,
    port: opts.port,
    model: opts.model,
    device: opts.device,
    detail: Number(opts.detail),
    size: parseSize(opts.size),
    twitch: twitchClient,
  });
  const url = `http://${opts.host === "0.0.0.0" ? "localhost" : opts.host}:${opts.port}`;
  info(`Glimpse is running at ${styleText("cyan", url)}  ${styleText("dim", "(Ctrl+C to stop)")}`);
  if (opts.open) openFile(url);

  process.once("SIGINT", () => {
    server.close();
    process.exit(0);
  });
}

// ---------- shared helpers ----------

function twitchClient(): TwitchClient {
  loadEnv();
  return new TwitchClient({
    clientId: requireEnv("TWITCH_CLIENT_ID"),
    clientSecret: requireEnv("TWITCH_CLIENT_SECRET"),
    tokenFile: TOKEN_FILE,
  });
}

/** Loads the saved scans to search, with a clear message for whatever is missing. */
function searchableOrExplain(inputs: string[] | undefined, model: ModelName, warnIfStale = true): SearchableCategory[] {
  const { found, missingModel, notIndexed } = loadSearchable(inputs, model);
  if (notIndexed.length) throw new Error(`"${notIndexed[0]}" isn't indexed yet. Run: glimpse index ${notIndexed[0]}`);
  if (found.length === 0 && missingModel.length === 0) {
    throw new Error("Nothing indexed yet. Run: glimpse index just-chatting");
  }

  if (missingModel.length) {
    const fix = `glimpse index ${missingModel.join(" ")} --no-refresh -m ${model}`;
    const message = `${missingModel.join(", ")} ${missingModel.length > 1 ? "have" : "has"} no ${MODELS[model].label} embeddings yet. Run: ${fix}`;
    if (found.length === 0) throw new Error(message);
    warn(message);
  }

  const stale = found.filter(({ snapshot }) => minutesSince(snapshot.capturedAt) > STALE_AFTER_MINUTES);
  if (warnIfStale && stale.length) {
    const names = stale.map(({ snapshot }) => `${snapshot.category.slug} (${ago(snapshot.capturedAt)})`).join(", ");
    warn(`Heads up: some scans are old and those streams may have changed: ${names}`);
  }
  return found;
}

function writeResultsPage(name: string, html: string): string {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const file = path.join(RESULTS_DIR, name);
  fs.writeFileSync(file, html);
  return file;
}

function openFile(target: string): void {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [target]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", target]]
        : ["xdg-open", [target]];
  spawn(command, args, { detached: true, stdio: "ignore" }).unref();
}

function ago(iso: string): string {
  const minutes = Math.round(minutesSince(iso));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function compactNumber(n: number): string {
  return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

function truncate(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : chars.slice(0, max - 1).join("") + "…";
}

function info(message: string): void {
  console.error(message);
}

function warn(message: string): void {
  console.error(styleText("yellow", message));
}

function progress(message: string): void {
  if (process.stderr.isTTY) process.stderr.write(`\r\x1b[2K${message}`);
}

function positiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError("must be a positive whole number");
  return n;
}

function port(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new InvalidArgumentError("must be a port number");
  return n;
}

function run<A extends unknown[]>(action: (...args: A) => Promise<void> | void) {
  return async (...args: A) => {
    try {
      await action(...args);
    } catch (error) {
      progress("");
      console.error(styleText("red", `error: ${(error as Error).message}`));
      process.exitCode = 1;
    }
  };
}

// ---------- commands ----------

const deviceOption = () =>
  new Option("--device <device>", "where to run the model")
    .choices(DEVICES)
    .default((process.env.GLIMPSE_DEVICE as Device | undefined) ?? "webgpu");

const detailOption = () =>
  new Option("--detail <tokens>", "EmbeddingGemma image detail (higher = finer detail, slower)")
    .choices(GEMMA_DETAIL_LEVELS)
    .default("280");

const program = new Command()
  .name("glimpse")
  .description("Semantic search over live Twitch stream thumbnails")
  .version("0.1.0");

program
  .command("serve")
  .description("Start the web app")
  .option("-p, --port <port>", "port to listen on", port, 3737)
  .option("--host <host>", "address to listen on (0.0.0.0 shares it on your network)", "127.0.0.1")
  .addOption(new Option("-m, --model <name>", "embedding model").choices(MODEL_NAMES).default("gemma"))
  .addOption(deviceOption())
  .addOption(detailOption())
  .option("--size <WxH>", "thumbnail size to download when scanning", "640x360")
  .option("--open", "open the app in your browser")
  .action(run(serveCommand));

program
  .command("index")
  .description("Scan the top live streams in one or more categories and embed their thumbnails")
  .argument("<categories...>", 'category slugs, names, or URLs (e.g. just-chatting fortnite "League of Legends")')
  .option("-l, --limit <n>", "streams per category", positiveInt, 50)
  .option("--lang <code>", "only streams in this language, e.g. en")
  .addOption(new Option("-m, --model <name>", "embedding model").choices([...MODEL_NAMES, "all"]).default("gemma"))
  .option("--size <WxH>", "thumbnail size to download", "640x360")
  .addOption(detailOption())
  .addOption(deviceOption())
  .option("--no-refresh", "re-embed the saved thumbnails instead of scanning Twitch again")
  .option("--no-cache", "embed every thumbnail, even ones identical to a thumbnail embedded before")
  .action(run(indexCommand));

program
  .command("search")
  .description("Find the thumbnails that best match a description")
  .argument("<query>", 'what to look for, e.g. "guy wearing a green shirt"')
  .option("-c, --category <names...>", "only search these categories (default: everything indexed)")
  .option("-n, --top <n>", "number of results", positiveInt, 10)
  .addOption(new Option("-m, --model <name>", "embedding model").choices(MODEL_NAMES).default("gemma"))
  .addOption(deviceOption())
  .option("--open", "open the results as a thumbnail grid in your browser")
  .option("--json", "print results as JSON")
  .action(run(searchCommand));

program
  .command("compare")
  .description("Run queries with every model and show the results side by side")
  .argument("<queries...>", "one or more descriptions to search for")
  .option("-c, --category <names...>", "only search these categories")
  .option("-n, --top <n>", "results per model", positiveInt, 5)
  .addOption(deviceOption())
  .option("--no-open", "write the comparison page without opening it")
  .action(run(compareCommand));

program.command("list").description("Show which categories are indexed").action(run(listCommand));

await program.parseAsync();
