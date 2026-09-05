/** Fences new transport work while retaining already admitted work through cleanup. */
export class WebSocketWorkTracker {
  private stopped = false;
  private readonly pending = new Set<Promise<unknown>>();

  canStart(): boolean { return !this.stopped; }
  stop(): void { this.stopped = true; }

  track<T>(work: Promise<T>): Promise<T> {
    this.pending.add(work);
    const remove = () => { this.pending.delete(work); };
    void work.then(remove, remove);
    return work;
  }

  async drain(): Promise<void> {
    // Admitted work may enqueue its own cleanup before it settles.
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }
}
