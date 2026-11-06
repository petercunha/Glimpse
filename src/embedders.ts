import {
  AutoConfig,
  AutoModel,
  AutoProcessor,
  AutoTokenizer,
  LogLevel,
  RawImage,
  SiglipTextModel,
  SiglipVisionModel,
  env,
} from "@huggingface/transformers";
import type { PreTrainedModel, PreTrainedTokenizer, Processor, ProgressInfo, Tensor } from "@huggingface/transformers";
import { MODEL_CACHE_DIR } from "./config.ts";
import { MODELS } from "./models.ts";
import type { Device, ModelName } from "./models.ts";

env.cacheDir = MODEL_CACHE_DIR;
env.allowLocalModels = false;
env.logLevel = LogLevel.ERROR;

export interface LoadOptions {
  device: Device;
  /** Also load the image side of the model (only needed for indexing). */
  images: boolean;
  /** EmbeddingGemma 2 image detail, see GEMMA_DETAIL_LEVELS. */
  detail?: number;
  /** Quantization to load; defaults to a good choice for the device. */
  dtype?: string;
}

export interface Embedder {
  readonly name: ModelName;
  /** Where the model actually runs (WebGPU falls back to CPU when unavailable). */
  readonly device: Device;
  readonly options: Record<string, unknown>;
  embedImages(paths: string[], onProgress?: (done: number) => void): Promise<Float32Array[]>;
  embedQuery(text: string): Promise<Float32Array>;
  dispose(): Promise<void>;
}

const BATCH_SIZE = 8;

// WebGPU fails on batches over ~2,700 tokens, so EmbeddingGemma batches shrink as image detail grows.
const GEMMA_BATCH_TOKENS = 2240;

export async function loadEmbedder(name: ModelName, options: LoadOptions): Promise<Embedder> {
  const load = (opts: LoadOptions) => {
    const dtype = opts.dtype ?? defaultDtype(opts.device);
    return name === "gemma" ? GemmaEmbedder.load(opts, dtype) : SiglipEmbedder.load(opts, dtype);
  };
  if (options.device !== "webgpu") return load(options);
  try {
    return await load(options);
  } catch (error) {
    process.stderr.write(`WebGPU isn't available (${(error as Error).message.split("\n")[0]}). Using the CPU instead, which is slower.\n`);
    return load({ ...options, device: "cpu", dtype: undefined });
  }
}

// Measured on 16 thumbnails: fp16 on WebGPU matches full precision (cosine 0.9995) at 0.36 s/image.
// On CPU, q8 was no faster than fp32 and less accurate, so CPU uses fp32.
function defaultDtype(device: Device): string {
  return device === "webgpu" ? "fp16" : "fp32";
}

// Callable models: Transformers.js models are invoked like functions.
type CallableModel = PreTrainedModel & ((inputs: unknown) => Promise<Record<string, Tensor>>);

class GemmaEmbedder implements Embedder {
  readonly name = "gemma" as const;
  readonly device: Device;
  readonly options: Record<string, unknown>;
  #processor: Processor;
  #model: CallableModel;
  #batchSize: number;

  private constructor(
    processor: Processor,
    model: CallableModel,
    device: Device,
    detail: number,
    options: Record<string, unknown>,
  ) {
    this.#processor = processor;
    this.#model = model;
    this.device = device;
    this.#batchSize = Math.max(1, Math.min(16, Math.floor(GEMMA_BATCH_TOKENS / detail)));
    this.options = options;
  }

  static async load(options: LoadOptions, dtype: string): Promise<GemmaEmbedder> {
    const { repo } = MODELS.gemma;
    const progress_callback = downloadProgress();

    // Only load the encoders we need: never audio, and vision only when indexing.
    const config = (await AutoConfig.from_pretrained(repo, { progress_callback })) as unknown as Record<string, unknown>;
    config.audio_config = null;
    if (!options.images) config.vision_config = null;

    const processor = await AutoProcessor.from_pretrained(repo, { progress_callback });
    const detail = options.detail ?? 280;
    (processor as unknown as { image_processor: { max_soft_tokens: number } }).image_processor.max_soft_tokens = detail;

    const model = (await AutoModel.from_pretrained(repo, {
      config: config as never,
      device: options.device,
      dtype: dtype as never,
      progress_callback,
    })) as CallableModel;

    return new GemmaEmbedder(processor, model, options.device, detail, options.images ? { dtype, detail } : { dtype });
  }

  async embedQuery(text: string): Promise<Float32Array> {
    const inputs = await this.#processor([`task: search result | query: ${text}`]);
    const { sentence_embedding } = await this.#model(inputs);
    return rows(sentence_embedding)[0];
  }

  async embedImages(paths: string[], onProgress?: (done: number) => void): Promise<Float32Array[]> {
    const vectors: Float32Array[] = [];
    for (let i = 0; i < paths.length; i += this.#batchSize) {
      const images = await Promise.all(paths.slice(i, i + this.#batchSize).map((p) => RawImage.read(p)));
      // One inner list per input, so each image gets its own embedding.
      const inputs = await this.#processor(null, images.map((image) => [image]));
      const { sentence_embedding } = await this.#model(inputs);
      vectors.push(...rows(sentence_embedding));
      onProgress?.(vectors.length);
    }
    return vectors;
  }

  async dispose(): Promise<void> {
    await this.#model.dispose();
  }
}

class SiglipEmbedder implements Embedder {
  readonly name = "siglip" as const;
  readonly device: Device;
  readonly options: Record<string, unknown>;
  #dtype: string;
  // The text and image halves are separate files, so each is loaded only when needed.
  #text?: { tokenizer: PreTrainedTokenizer; model: CallableModel };
  #vision?: { processor: Processor; model: CallableModel };

  private constructor(device: Device, dtype: string) {
    this.device = device;
    this.#dtype = dtype;
    this.options = { dtype };
  }

  static async load(options: LoadOptions, dtype: string): Promise<SiglipEmbedder> {
    const embedder = new SiglipEmbedder(options.device, dtype);
    if (options.images) await embedder.#loadVision();
    else await embedder.#loadText();
    return embedder;
  }

  async #loadText() {
    const { repo } = MODELS.siglip;
    const progress_callback = downloadProgress();
    const tokenizer = await AutoTokenizer.from_pretrained(repo, { progress_callback });
    const model = (await SiglipTextModel.from_pretrained(repo, {
      device: this.device,
      dtype: this.#dtype as never,
      progress_callback,
    })) as CallableModel;
    return (this.#text = { tokenizer, model });
  }

  async #loadVision() {
    const { repo } = MODELS.siglip;
    const progress_callback = downloadProgress();
    const processor = await AutoProcessor.from_pretrained(repo, { progress_callback });
    const model = (await SiglipVisionModel.from_pretrained(repo, {
      device: this.device,
      dtype: this.#dtype as never,
      progress_callback,
    })) as CallableModel;
    return (this.#vision = { processor, model });
  }

  async embedQuery(text: string): Promise<Float32Array> {
    const { tokenizer, model } = this.#text ?? (await this.#loadText());
    // SigLIP 2 was trained on lowercase text padded to 64 tokens.
    const inputs = tokenizer([text.toLowerCase()], { padding: "max_length", truncation: true, max_length: 64 });
    const { pooler_output } = await model(inputs);
    return rows(pooler_output)[0];
  }

  async embedImages(paths: string[], onProgress?: (done: number) => void): Promise<Float32Array[]> {
    const { processor, model } = this.#vision ?? (await this.#loadVision());
    const vectors: Float32Array[] = [];
    for (let i = 0; i < paths.length; i += BATCH_SIZE) {
      const images = await Promise.all(paths.slice(i, i + BATCH_SIZE).map((p) => RawImage.read(p)));
      const { pooler_output } = await model(await processor(images));
      vectors.push(...rows(pooler_output));
      onProgress?.(vectors.length);
    }
    return vectors;
  }

  async dispose(): Promise<void> {
    await this.#text?.model.dispose();
    await this.#vision?.model.dispose();
  }
}

/** Splits a [n, dims] tensor into n unit-length vectors. */
function rows(tensor: Tensor): Float32Array[] {
  const [n, dims] = tensor.dims;
  const data = tensor.data as ArrayLike<number>;
  const out: Float32Array[] = [];
  for (let i = 0; i < n; i++) {
    const row = Float32Array.from({ length: dims }, (_, j) => Number(data[i * dims + j]));
    out.push(normalize(row));
  }
  return out;
}

export function normalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (const x of vector) sum += x * x;
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < vector.length; i++) vector[i] /= norm;
  return vector;
}

/** Prints download progress for large model files (first run only). */
function downloadProgress(): (info: ProgressInfo) => void {
  let lastLine = "";
  return (info) => {
    if (!process.stderr.isTTY) return;
    if (info.status === "progress" && info.total > 5_000_000) {
      const mb = (bytes: number) => Math.round(bytes / 1e6);
      const line = `  downloading ${info.file}: ${mb(info.loaded)}/${mb(info.total)} MB`;
      if (line !== lastLine) process.stderr.write(`\r\x1b[2K${line}`);
      lastLine = line;
    } else if (info.status === "done" && lastLine) {
      process.stderr.write("\r\x1b[2K");
      lastLine = "";
    }
  };
}
