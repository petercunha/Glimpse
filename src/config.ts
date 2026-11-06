import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = process.env.GLIMPSE_DATA_DIR ?? path.join(ROOT, "data");
export const RESULTS_DIR = path.join(ROOT, "results");
export const MODEL_CACHE_DIR = path.join(ROOT, ".cache", "models");

export function loadEnv(): void {
  const envFile = path.join(ROOT, ".env");
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Add it to ${path.join(ROOT, ".env")} (see README).`);
  }
  return value;
}

export interface Size {
  width: number;
  height: number;
}

export function parseSize(value: string): Size {
  const match = value.match(/^(\d+)x(\d+)$/);
  if (!match) throw new Error(`Size must look like 640x360, got "${value}"`);
  return { width: Number(match[1]), height: Number(match[2]) };
}
