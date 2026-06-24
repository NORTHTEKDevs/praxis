export interface Embedder {
  embed(text: string): Promise<number[]>
}

function fnv1a(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h)
}

// Deterministic, dependency-free embedder for tests and offline use. Bag-of-token
// hashing into a fixed-dim L2-normalized vector. The prod embedder (transformers.js)
// implements the same interface and is swapped in later.
export class HashingEmbedder implements Embedder {
  dim: number
  constructor(dim = 256) {
    this.dim = dim
  }
  async embed(text: string): Promise<number[]> {
    const v = new Array(this.dim).fill(0)
    const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? []
    for (const t of tokens) v[fnv1a(t) % this.dim] += 1
    let norm = 0
    for (const x of v) norm += x * x
    norm = Math.sqrt(norm) || 1
    return v.map((x) => x / norm)
  }
}

export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? 0 : dot / denom
}
