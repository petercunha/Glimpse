// Kept separate from embedders.ts so the CLI can list options without loading the AI runtime.

export const MODELS = {
  gemma: {
    repo: "onnx-community/embeddinggemma-2-ONNX",
    label: "EmbeddingGemma 2",
  },
  siglip: {
    repo: "onnx-community/siglip2-so400m-patch14-384-ONNX",
    label: "SigLIP 2",
  },
} as const;

export type ModelName = keyof typeof MODELS;
export const MODEL_NAMES = Object.keys(MODELS) as ModelName[];

// WebGPU runs on the GPU and is ~9x faster than CPU on an M1 Max. (CoreML can't run EmbeddingGemma 2.)
export const DEVICES = ["webgpu", "cpu"] as const;
export type Device = (typeof DEVICES)[number];

/** Image detail for EmbeddingGemma 2: how many tokens each image becomes. */
export const GEMMA_DETAIL_LEVELS = ["70", "140", "280", "560", "1120"] as const;
