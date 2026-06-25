export class RateLimitError extends Error {}

// Sliding-window rate limiter.
export class RateLimiter {
  max: number
  windowMs: number
  hits: number[]
  constructor(max: number, windowMs: number) {
    this.max = max
    this.windowMs = windowMs
    this.hits = []
  }
  allow(now = Date.now()): boolean {
    this.hits = this.hits.filter((t) => now - t < this.windowMs)
    if (this.hits.length >= this.max) return false
    this.hits.push(now)
    return true
  }
}

// Bounds concurrent work (e.g. sandbox workers) so a flood cannot spawn unbounded threads.
export class Semaphore {
  max: number
  active: number
  queue: Array<() => void>
  constructor(max: number) {
    this.max = Math.max(1, max) // max < 1 would deadlock (active>=max true before any run starts)
    this.active = 0
    this.queue = []
  }
  async run(fn: () => Promise<unknown>): Promise<unknown> {
    if (this.active >= this.max) await new Promise<void>((res) => this.queue.push(res))
    this.active++
    try {
      return await fn()
    } finally {
      this.active--
      const next = this.queue.shift()
      if (next) next()
    }
  }
}
