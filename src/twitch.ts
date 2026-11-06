import fs from "node:fs";
import path from "node:path";
import type { Size } from "./config.ts";

const HELIX = "https://api.twitch.tv/helix";
const TOKEN_URL = "https://id.twitch.tv/oauth2/token";

export interface Category {
  id: string;
  name: string;
  slug: string;
}

export interface Stream {
  id: string;
  login: string;
  displayName: string;
  title: string;
  viewers: number;
  language: string;
  startedAt: string;
  tags: string[];
  thumbnailTemplate: string;
}

interface HelixStream {
  id: string;
  user_login: string;
  user_name: string;
  title: string;
  viewer_count: number;
  language: string;
  started_at: string;
  tags: string[] | null;
  thumbnail_url: string;
}

interface HelixGame {
  id: string;
  name: string;
}

interface HelixPage<T> {
  data: T[];
  pagination?: { cursor?: string };
}

interface CachedToken {
  clientId: string;
  accessToken: string;
  expiresAt: number;
}

/** "Pokémon Legends: Z-A" -> "pokemon-legends-z-a", matching Twitch's category URLs. */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Accepts a slug ("just-chatting"), a name ("Just Chatting") or a category URL. */
export function categoryInputText(input: string): string {
  const match = input.match(/twitch\.tv\/directory\/(?:category|game)\/([^/?#]+)/i);
  return match ? decodeURIComponent(match[1]) : input.trim();
}

export function categorySlug(input: string): string {
  return slugify(categoryInputText(input));
}

export function thumbnailUrl(template: string, size: Size): string {
  return template.replace("{width}", String(size.width)).replace("{height}", String(size.height));
}

export class TwitchClient {
  #clientId: string;
  #clientSecret: string;
  #tokenFile: string;
  #token: string | undefined;

  constructor(opts: { clientId: string; clientSecret: string; tokenFile: string }) {
    this.#clientId = opts.clientId;
    this.#clientSecret = opts.clientSecret;
    this.#tokenFile = opts.tokenFile;
  }

  async findCategory(input: string): Promise<Category> {
    const text = categoryInputText(input);

    if (/^\d+$/.test(text)) {
      const { data } = await this.#get<HelixGame>("/games", { id: text });
      if (!data[0]) throw new Error(`No Twitch category has the id ${text}.`);
      return { id: data[0].id, name: data[0].name, slug: slugify(data[0].name) };
    }

    const slug = slugify(text);
    const query = text.includes(" ") ? text : text.replace(/-/g, " ");
    const { data: results } = await this.#get<HelixGame>("/search/categories", { query, first: "25" });
    const exact = results.find((game) => slugify(game.name) === slug);
    if (exact) return { id: exact.id, name: exact.name, slug };

    const { data: byName } = await this.#get<HelixGame>("/games", { name: query });
    if (byName[0]) return { id: byName[0].id, name: byName[0].name, slug: slugify(byName[0].name) };

    const suggestions = results.slice(0, 5).map((game) => slugify(game.name));
    const hint = suggestions.length ? ` Did you mean: ${suggestions.join(", ")}?` : "";
    throw new Error(`Couldn't find a Twitch category matching "${input}".${hint}`);
  }

  /** Live streams in a category, most viewers first (same order as the category page). */
  async getStreams(categoryId: string, limit: number, language?: string): Promise<Stream[]> {
    const streams: Stream[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;

    while (streams.length < limit) {
      const page = await this.#get<HelixStream>("/streams", {
        game_id: categoryId,
        first: String(Math.min(100, limit - streams.length)),
        after: cursor,
        language,
      });
      for (const s of page.data) {
        // Viewer counts shift between pages, so the same stream can show up twice.
        if (seen.has(s.id)) continue;
        seen.add(s.id);
        streams.push({
          id: s.id,
          login: s.user_login,
          displayName: s.user_name,
          title: s.title,
          viewers: s.viewer_count,
          language: s.language,
          startedAt: s.started_at,
          tags: s.tags ?? [],
          thumbnailTemplate: s.thumbnail_url,
        });
        if (streams.length >= limit) break;
      }
      cursor = page.pagination?.cursor;
      if (!cursor || page.data.length === 0) break;
    }
    return streams;
  }

  async #get<T>(endpoint: string, params: Record<string, string | undefined>): Promise<HelixPage<T>> {
    const url = new URL(HELIX + endpoint);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, value);
    }

    let res = await this.#fetch(url, false);
    if (res.status === 401) res = await this.#fetch(url, true); // token expired or revoked
    if (!res.ok) {
      throw new Error(`Twitch API error ${res.status} on ${endpoint}: ${await res.text()}`);
    }
    return (await res.json()) as HelixPage<T>;
  }

  async #fetch(url: URL, refreshToken: boolean): Promise<Response> {
    const token = await this.#getToken(refreshToken);
    return fetch(url, { headers: { "Client-Id": this.#clientId, Authorization: `Bearer ${token}` } });
  }

  async #getToken(refresh: boolean): Promise<string> {
    if (!refresh) {
      if (this.#token) return this.#token;
      const cached = this.#readCachedToken();
      if (cached) return (this.#token = cached);
    }

    const res = await fetch(TOKEN_URL, {
      method: "POST",
      body: new URLSearchParams({
        client_id: this.#clientId,
        client_secret: this.#clientSecret,
        grant_type: "client_credentials",
      }),
    });
    if (!res.ok) {
      throw new Error(
        `Twitch login failed (${res.status}). Check TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET in .env.`,
      );
    }
    const body = (await res.json()) as { access_token: string; expires_in: number };
    const cached: CachedToken = {
      clientId: this.#clientId,
      accessToken: body.access_token,
      expiresAt: Date.now() + body.expires_in * 1000,
    };
    fs.mkdirSync(path.dirname(this.#tokenFile), { recursive: true });
    fs.writeFileSync(this.#tokenFile, JSON.stringify(cached), { mode: 0o600 });
    return (this.#token = body.access_token);
  }

  #readCachedToken(): string | undefined {
    try {
      const cached = JSON.parse(fs.readFileSync(this.#tokenFile, "utf8")) as CachedToken;
      const stillValid = cached.expiresAt - Date.now() > 60 * 60 * 1000;
      if (cached.clientId === this.#clientId && stillValid) return cached.accessToken;
    } catch {
      // No cached token yet.
    }
    return undefined;
  }
}
