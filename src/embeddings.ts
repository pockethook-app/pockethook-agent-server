/**
 * Multi-provider embedding client + vector math utilities.
 *
 * Supports Ollama, LM Studio, and OpenAI-compatible APIs.
 * Provides cosine similarity and BLOB serialization for SQLite storage.
 */

import { logger } from "./logger.js";

export type EmbeddingProvider = "ollama" | "lm-studio" | "openai";

let provider: EmbeddingProvider = "ollama";
let baseUrl = "http://localhost:11434";
let model = "nomic-embed-text";
let apiKey = "";

export function configure(opts: {
  provider: EmbeddingProvider;
  baseUrl: string;
  model: string;
  apiKey?: string;
}): void {
  provider = opts.provider;
  baseUrl = opts.baseUrl;
  model = opts.model;
  apiKey = opts.apiKey ?? "";
}

export function getProviderInfo(): { provider: EmbeddingProvider; baseUrl: string; model: string } {
  return { provider, baseUrl, model };
}

/**
 * Get embedding vector for a text string.
 * Routes to the correct provider API automatically.
 */
export async function getEmbedding(text: string): Promise<Float32Array> {
  // Truncate to ~24K chars (~8K tokens) as safety limit for most embedding models
  const truncated = text.length > 24_000 ? text.slice(0, 24_000) : text;

  if (provider === "ollama") {
    return embedViaOllama(truncated);
  }
  // LM Studio and OpenAI both use the OpenAI-compatible /v1/embeddings endpoint
  return embedViaOpenAI(truncated);
}

/**
 * Ollama native endpoint: POST /api/embed
 */
async function embedViaOllama(text: string): Promise<Float32Array> {
  const res = await fetch(`${baseUrl}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: text }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Ollama embed failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as { embeddings: number[][] };
  if (!data.embeddings?.[0]) {
    throw new Error("Ollama returned empty embedding");
  }

  return new Float32Array(data.embeddings[0]);
}

/**
 * OpenAI-compatible endpoint: POST /v1/embeddings
 * Used by OpenAI, LM Studio, and other compatible APIs.
 */
async function embedViaOpenAI(text: string): Promise<Float32Array> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const res = await fetch(`${baseUrl}/v1/embeddings`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model, input: text }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Embedding API failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as { data: { embedding: number[] }[] };
  if (!data.data?.[0]?.embedding) {
    throw new Error("Embedding API returned empty result");
  }

  return new Float32Array(data.data[0].embedding);
}

/**
 * Cosine similarity between two vectors. Returns [-1, 1].
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    magA += a[i]! * a[i]!;
    magB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Serialize Float32Array to Buffer for SQLite BLOB storage.
 */
export function vectorToBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

/**
 * Deserialize Buffer from SQLite BLOB to Float32Array.
 */
export function blobToVector(b: Buffer): Float32Array {
  const copy = new ArrayBuffer(b.length);
  const view = new Uint8Array(copy);
  view.set(b);
  return new Float32Array(copy);
}

/**
 * Check if the embedding provider is reachable and the model is available.
 */
export async function checkEmbeddingAvailable(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3_000);

    if (provider === "ollama") {
      const res = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) return false;

      const data = (await res.json()) as { models?: { name: string }[] };
      const models = data.models || [];
      const hasModel = models.some(
        (m) => m.name === model || m.name.startsWith(`${model}:`),
      );
      if (!hasModel) {
        logger.warn(`Ollama reachable but model "${model}" not found. Run: ollama pull ${model}`);
        return false;
      }
      return true;
    }

    // OpenAI / LM Studio: try a small embedding to verify
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    const res = await fetch(`${baseUrl}/v1/embeddings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, input: "test" }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn(`Embedding API check failed (${res.status}): ${body}`);
      return false;
    }

    return true;
  } catch (err) {
    logger.warn(`Embedding provider unreachable: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}
