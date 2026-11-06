// Glimpse web app. Served as plain JavaScript: the server strips the types (see src/server.ts).
import type { ApiCategory, ApiResult, ApiScanResult, ApiSearchResponse, ApiState } from "../src/api-types.ts";

const STALE_AFTER_MINUTES = 30;
const SEARCH_DELAY_MS = 250;
const POLL_MS = 800;
const EXAMPLES = ["someone playing guitar", "person wearing headphones", "cat on camera", "cosplay", "cooking", "outdoors"];
const POPULAR = ["Just Chatting", "Fortnite", "League of Legends", "VALORANT", "Grand Theft Auto V", "Minecraft"];
const LANGUAGES: [code: string, name: string][] = [
  ["", "Any language"],
  ["en", "English"],
  ["es", "Spanish"],
  ["pt", "Portuguese"],
  ["fr", "French"],
  ["de", "German"],
  ["it", "Italian"],
  ["ru", "Russian"],
  ["ja", "Japanese"],
  ["ko", "Korean"],
  ["zh", "Chinese"],
];
// Matches the server's cap (MAX_SCAN_LIMIT in src/server.ts).
const MAX_STREAMS = 500;
// Measured scan speed per thumbnail, used for the time estimate when rescanning.
const SECONDS_PER_THUMB: Record<string, number> = { webgpu: 0.4, cpu: 3.4 };

const REFRESH_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>';

function $<T extends HTMLElement = HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element ${selector}`);
  return element;
}

const ui = {
  form: $<HTMLFormElement>("#search-form"),
  query: $<HTMLInputElement>("#q"),
  status: $("#model-status"),
  chips: $("#chips"),
  addForm: $<HTMLFormElement>("#add-form"),
  addCategory: $<HTMLInputElement>("#add-category"),
  addLimit: $<HTMLSelectElement>("#add-limit"),
  addLang: $<HTMLSelectElement>("#add-lang"),
  addCancel: $<HTMLButtonElement>("#add-cancel"),
  title: $("#results-title"),
  meta: $("#results-meta"),
  examples: $("#examples"),
  notice: $("#notice"),
  loading: $("#loading"),
  grid: $("#grid"),
  empty: $("#empty"),
  toast: $("#toast"),
  rescan: $<HTMLFormElement>("#rescan"),
  rescanTitle: $("#rescan-title"),
  rescanLimit: $<HTMLInputElement>("#rescan-limit"),
  rescanLang: $<HTMLSelectElement>("#rescan-lang"),
  rescanHint: $("#rescan-hint"),
  rescanCancel: $<HTMLButtonElement>("#rescan-cancel"),
};

let categories: ApiCategory[] = [];
let modelDevice = "webgpu";
let rescanSlug: string | null = null;
let selected = new Set<string>();
let scanning: ApiState["scan"] = null;
let lastScanSeen: string | undefined;
let chipsHtml = "";
let searchTimer = 0;
let pollTimer = 0;
let toastTimer = 0;
let searchController: AbortController | null = null;

// ---------- server state (categories, model, scans) ----------

async function loadState(initial = false): Promise<ApiState | null> {
  let state: ApiState;
  try {
    state = await getJson<ApiState>("/api/state");
  } catch {
    showToast("Can't reach the Glimpse server. Is it still running?", "error");
    return null;
  }

  categories = state.categories;
  for (const slug of selected) if (!categories.some((c) => c.slug === slug)) selected.delete(slug);
  scanning = state.scan;
  renderStatus(state.model);
  renderChips();

  if (state.scan) {
    const { label, message, done, total } = state.scan;
    const count = total ? ` ${done}/${total}` : "";
    showToast(`Scanning ${label}: ${message}${count}`, "info", { progress: total ? done / total : "indeterminate", scan: true });
  } else if (ui.toast.dataset.scan) {
    hideToast();
  }

  const last = state.lastScan;
  if (initial) lastScanSeen = last?.finishedAt;
  else if (last && last.finishedAt !== lastScanSeen) {
    lastScanSeen = last.finishedAt;
    scanFinished(last);
  }
  return state;
}

function startPolling(): void {
  if (pollTimer) return;
  pollTimer = window.setInterval(async () => {
    const state = await loadState();
    const settled = !state || (!state.scan && (state.model.ready || Boolean(state.model.error)));
    if (settled) {
      window.clearInterval(pollTimer);
      pollTimer = 0;
    }
  }, POLL_MS);
}

async function startScan(category: string, limit = 50, lang?: string): Promise<void> {
  try {
    const res = await fetch("/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category, limit, lang }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      showToast(body.error ?? "Couldn't start the scan.", "error", { timeout: 6000 });
      return;
    }
  } catch {
    showToast("Can't reach the Glimpse server. Is it still running?", "error");
    return;
  }
  scanning = { label: category, message: "Starting…", done: 0, total: 0 };
  showToast(`Scanning ${category}: starting…`, "info", { progress: "indeterminate", scan: true });
  renderChips();
  startPolling();
}

function scanFinished(result: ApiScanResult): void {
  if (result.ok) {
    showToast(result.message, "success", { timeout: 5000 });
    void search();
  } else {
    showToast(`Scan failed: ${result.message}`, "error", { timeout: 10000 });
  }
}

// ---------- search ----------

async function search(): Promise<void> {
  window.clearTimeout(searchTimer);
  searchController?.abort();
  const controller = new AbortController();
  searchController = controller;

  const query = ui.query.value.trim();
  updateUrl(query);
  if (categories.length === 0) {
    renderWelcome();
    return;
  }

  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (selected.size) params.set("c", [...selected].join(","));

  const loadingTimer = window.setTimeout(() => setLoading(true), 120);
  try {
    renderResults(await getJson<ApiSearchResponse>(`/api/search?${params}`, controller.signal));
  } catch (error) {
    if ((error as Error).name !== "AbortError") showToast(`Search failed: ${(error as Error).message}`, "error", { timeout: 6000 });
  } finally {
    window.clearTimeout(loadingTimer);
    if (searchController === controller) setLoading(false);
  }
}

function scheduleSearch(): void {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(search, SEARCH_DELAY_MS);
}

function setLoading(loading: boolean): void {
  ui.loading.hidden = !loading;
  ui.grid.classList.toggle("is-loading", loading);
}

function updateUrl(query: string): void {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (selected.size) params.set("c", [...selected].join(","));
  const next = params.size ? `?${params}` : location.pathname;
  if (next !== location.search) history.replaceState(null, "", next);
}

// ---------- rendering ----------

function renderStatus(model: ApiState["model"]): void {
  modelDevice = model.device;
  ui.status.classList.toggle("is-ready", model.ready);
  ui.status.classList.toggle("is-error", Boolean(model.error));
  const device = model.device === "webgpu" ? "GPU" : "CPU";
  const text = model.error ? "Model failed to load" : model.ready ? `${model.label} · ${device}` : `Loading ${model.label}…`;
  ui.status.querySelector(".status-text")!.textContent = text;
  ui.status.title = model.error ?? "The AI model that matches your words to thumbnails";
}

function renderChips(): void {
  const parts: string[] = [];
  if (categories.length > 1) {
    const total = categories.reduce((sum, c) => sum + c.streams, 0);
    parts.push(`
      <div class="chip ${selected.size === 0 ? "is-selected" : ""}">
        <button type="button" class="chip-main" data-all aria-pressed="${selected.size === 0}">
          All <span class="chip-meta">${total}</span>
        </button>
      </div>`);
  }
  for (const c of categories) {
    const isSelected = selected.has(c.slug);
    const stale = minutesSince(c.capturedAt) > STALE_AFTER_MINUTES;
    const isScanning = scanning !== null && (scanning.label === c.name || scanning.label === c.slug);
    const hint = !c.searchable
      ? "Not searchable with this model yet. Rescan to fix."
      : stale
        ? `Scanned ${longAgo(c.capturedAt)}. Thumbnails may be out of date, so rescan for fresh ones.`
        : `Scanned ${longAgo(c.capturedAt)}`;
    const classes = ["chip", isSelected && "is-selected", stale && "is-stale", !c.searchable && "is-unsearchable", isScanning && "is-scanning"];
    parts.push(`
      <div class="${classes.filter(Boolean).join(" ")}">
        <button type="button" class="chip-main" data-slug="${escapeHtml(c.slug)}" aria-pressed="${isSelected}" title="${escapeHtml(hint)}">
          <span class="chip-dot"></span>${escapeHtml(c.name)}
          <span class="chip-meta">${c.streams} · ${shortAgo(c.capturedAt)}</span>
        </button>
        <button type="button" class="chip-refresh" data-refresh="${escapeHtml(c.slug)}" aria-haspopup="dialog"
                title="Rescan ${escapeHtml(c.name)} or change how many streams it scans"
                aria-label="Rescan ${escapeHtml(c.name)}">${REFRESH_ICON}</button>
      </div>`);
  }
  if (categories.length) {
    parts.push(`<div class="chip chip-add"><button type="button" class="chip-main" data-add>+ Add category</button></div>`);
  }

  // Polling re-renders often; only touch the DOM when something changed.
  const html = parts.join("");
  if (html !== chipsHtml) {
    ui.chips.innerHTML = html;
    chipsHtml = html;
  }
}

function renderResults(data: ApiSearchResponse): void {
  ui.empty.hidden = true;
  ui.empty.innerHTML = "";

  if (data.query) {
    ui.title.textContent = `Best matches for “${data.query}”`;
    ui.meta.textContent =
      data.results.length < data.total
        ? `Top ${data.results.length} of ${data.total} live streams`
        : `All ${data.total} live streams, best match first`;
  } else {
    ui.title.textContent = "Live now";
    ui.meta.textContent = `${data.total} streams · most viewers first`;
  }

  ui.examples.hidden = Boolean(data.query);
  if (!data.query) {
    ui.examples.innerHTML =
      "Try: " +
      EXAMPLES.map((text) => `<button type="button" class="example" data-example="${escapeHtml(text)}">${escapeHtml(text)}</button>`).join("");
  }

  const skippedNames = data.skipped.map((slug) => categories.find((c) => c.slug === slug)?.name ?? slug);
  ui.notice.hidden = skippedNames.length === 0;
  ui.notice.textContent = skippedNames.length
    ? `${skippedNames.join(", ")} ${skippedNames.length > 1 ? "aren't" : "isn't"} searchable with this model yet. Rescan to include ${skippedNames.length > 1 ? "them" : "it"}.`
    : "";

  if (data.results.length === 0) {
    ui.grid.innerHTML = "";
    ui.empty.hidden = false;
    ui.empty.innerHTML = `<p class="empty-text">Nothing to show here yet. Try rescanning or picking another category.</p>`;
    return;
  }
  ui.grid.innerHTML = data.results.map(card).join("");
}

function card(result: ApiResult): string {
  const score = result.score === null ? "" : ` title="Match score ${result.score.toFixed(3)}"`;
  const language = result.language ? ` · ${escapeHtml(result.language.toUpperCase())}` : "";
  return `
    <a class="card" href="${escapeHtml(result.url)}" target="_blank" rel="noopener"${score}>
      <div class="thumb">
        <img src="${escapeHtml(result.thumb)}" alt="" loading="lazy" decoding="async">
        <span class="badge badge-viewers">${compactNumber(result.viewers)}</span>
      </div>
      <div class="card-body">
        <div class="card-name">${escapeHtml(result.displayName)}</div>
        <div class="card-title">${escapeHtml(result.title)}</div>
        <div class="card-sub">${escapeHtml(result.category)}${language}</div>
      </div>
    </a>`;
}

function renderWelcome(): void {
  ui.title.textContent = "";
  ui.meta.textContent = "";
  ui.examples.hidden = true;
  ui.notice.hidden = true;
  ui.grid.innerHTML = "";
  ui.empty.hidden = false;
  ui.empty.innerHTML = `
    <div class="empty-card">
      <h2>Scan a category to get started</h2>
      <p>Glimpse grabs the top live streams in a Twitch category, then lets you search them by what's on screen.</p>
      <div class="quick-add">
        ${POPULAR.map((name) => `<button class="btn" type="button" data-scan="${escapeHtml(name)}">${escapeHtml(name)}</button>`).join("")}
      </div>
      <button class="link" type="button" data-add>Or choose another category</button>
    </div>`;
}

// ---------- add-category form ----------

function openAddForm(): void {
  ui.addForm.hidden = false;
  ui.addCategory.focus();
}

function closeAddForm(): void {
  ui.addForm.hidden = true;
  ui.addForm.reset();
}

// ---------- rescan popover (stream count and language) ----------

function fillLanguages(select: HTMLSelectElement, current = ""): void {
  const options = [...LANGUAGES];
  if (current && !options.some(([code]) => code === current)) options.push([current, current.toUpperCase()]);
  select.innerHTML = options
    .map(([code, name]) => `<option value="${code}"${code === current ? " selected" : ""}>${escapeHtml(name)}</option>`)
    .join("");
}

function openRescan(category: ApiCategory, anchor: HTMLElement): void {
  rescanSlug = category.slug;
  ui.rescanTitle.textContent = `Rescan ${category.name}`;
  ui.rescanLimit.value = String(category.limit);
  fillLanguages(ui.rescanLang, category.language ?? "");
  updateRescanHint();

  // Show it under the chip, kept inside the window.
  ui.rescan.hidden = false;
  const rect = anchor.getBoundingClientRect();
  const maxLeft = document.documentElement.clientWidth - ui.rescan.offsetWidth - 16;
  ui.rescan.style.top = `${rect.bottom + window.scrollY + 8}px`;
  ui.rescan.style.left = `${Math.max(16, Math.min(rect.left, maxLeft)) + window.scrollX}px`;
  ui.rescanLimit.focus();
  ui.rescanLimit.select();
}

function closeRescan(): void {
  ui.rescan.hidden = true;
  rescanSlug = null;
}

function updateRescanHint(): void {
  const category = categories.find((c) => c.slug === rescanSlug);
  if (!category) return;
  const limit = Number(ui.rescanLimit.value);
  const last = `Last scanned ${longAgo(category.capturedAt)}: ${category.streams} streams.`;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_STREAMS) {
    ui.rescanHint.textContent = `${last} Pick a number from 1 to ${MAX_STREAMS}.`;
    return;
  }
  const seconds = Math.ceil(limit * (SECONDS_PER_THUMB[modelDevice] ?? 0.4) + 5);
  const estimate = seconds < 90 ? `${seconds} seconds` : `${Math.ceil(seconds / 60)} minutes`;
  ui.rescanHint.textContent = `${last} Rescanning ${limit} takes about ${estimate}.`;
}

// ---------- toast ----------

type ToastKind = "info" | "success" | "error";

function showToast(
  text: string,
  kind: ToastKind,
  opts: { timeout?: number; progress?: number | "indeterminate"; scan?: boolean } = {},
): void {
  window.clearTimeout(toastTimer);
  const { toast } = ui;
  toast.hidden = false;
  toast.className = `toast is-${kind}`;
  toast.classList.toggle("has-progress", opts.progress !== undefined);
  toast.classList.toggle("is-indeterminate", opts.progress === "indeterminate");
  toast.querySelector(".toast-text")!.textContent = text;
  const bar = toast.querySelector<HTMLElement>(".toast-progress span")!;
  bar.style.width = typeof opts.progress === "number" ? `${Math.round(opts.progress * 100)}%` : "";
  if (opts.scan) toast.dataset.scan = "1";
  else delete toast.dataset.scan;
  if (opts.timeout) toastTimer = window.setTimeout(hideToast, opts.timeout);
}

function hideToast(): void {
  ui.toast.hidden = true;
  delete ui.toast.dataset.scan;
}

// ---------- helpers ----------

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Server error ${res.status}`);
  return body as T;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

const compactFormat = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
function compactNumber(n: number): string {
  return compactFormat.format(n);
}

function minutesSince(iso: string): number {
  return (Date.now() - Date.parse(iso)) / 60_000;
}

function shortAgo(iso: string): string {
  const minutes = Math.floor(minutesSince(iso));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

function longAgo(iso: string): string {
  const minutes = Math.floor(minutesSince(iso));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

// ---------- events ----------

function bindEvents(): void {
  ui.form.addEventListener("submit", (event) => {
    event.preventDefault();
    void search();
  });
  ui.query.addEventListener("input", scheduleSearch);
  ui.query.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && ui.query.value) {
      ui.query.value = "";
      void search();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "/" && !isTyping(event.target)) {
      event.preventDefault();
      ui.query.focus();
      ui.query.select();
    }
  });

  ui.chips.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-slug], [data-all], [data-add], [data-refresh]");
    if (!target) return;
    const { slug, refresh } = target.dataset;
    if (refresh) {
      const category = categories.find((c) => c.slug === refresh);
      const chip = target.closest<HTMLElement>(".chip");
      if (category && chip) {
        if (rescanSlug === category.slug) closeRescan();
        else openRescan(category, chip);
      }
      return;
    }
    if ("add" in target.dataset) return openAddForm();
    if ("all" in target.dataset) selected.clear();
    else if (slug) {
      if (selected.has(slug)) selected.delete(slug);
      else selected.add(slug);
    }
    renderChips();
    void search();
  });

  ui.addForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const category = ui.addCategory.value.trim();
    if (!category) return;
    void startScan(category, Number(ui.addLimit.value), ui.addLang.value || undefined);
    closeAddForm();
  });
  ui.addCancel.addEventListener("click", closeAddForm);
  ui.addForm.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeAddForm();
  });

  ui.rescan.addEventListener("submit", (event) => {
    event.preventDefault();
    const category = categories.find((c) => c.slug === rescanSlug);
    const limit = Number(ui.rescanLimit.value);
    if (!category || !Number.isInteger(limit) || limit < 1 || limit > MAX_STREAMS) return;
    void startScan(category.name, limit, ui.rescanLang.value || undefined);
    closeRescan();
  });
  ui.rescanLimit.addEventListener("input", updateRescanHint);
  ui.rescanCancel.addEventListener("click", closeRescan);
  ui.rescan.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeRescan();
  });
  // Close when clicking elsewhere (clicks on a chip's ↻ button are handled by the chips listener).
  document.addEventListener("pointerdown", (event) => {
    const target = event.target as HTMLElement;
    if (!ui.rescan.hidden && !ui.rescan.contains(target) && !target.closest("[data-refresh]")) closeRescan();
  });
  window.addEventListener("resize", closeRescan);

  ui.examples.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>("[data-example]");
    if (!button) return;
    ui.query.value = button.dataset.example ?? "";
    void search();
  });

  ui.empty.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>("[data-scan], [data-add]");
    if (!button) return;
    if (button.dataset.scan) void startScan(button.dataset.scan);
    else openAddForm();
  });

  // Show a blank tile instead of a broken image if a thumbnail disappears.
  ui.grid.addEventListener(
    "error",
    (event) => {
      if (event.target instanceof HTMLImageElement) event.target.closest(".thumb")?.classList.add("is-missing");
    },
    true,
  );

  ui.toast.querySelector(".toast-close")!.addEventListener("click", hideToast);

  // Keep the "scanned 5m ago" labels current.
  window.setInterval(renderChips, 60_000);
}

async function init(): Promise<void> {
  const params = new URLSearchParams(location.search);
  ui.query.value = params.get("q") ?? "";
  selected = new Set((params.get("c") ?? "").split(",").filter(Boolean));
  fillLanguages(ui.addLang);
  bindEvents();
  const state = await loadState(true);
  await search();
  if (state && (state.scan || !state.model.ready)) startPolling();
}

void init();
