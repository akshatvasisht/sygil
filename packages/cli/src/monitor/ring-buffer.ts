/**
 * Bounded ring buffer — pushes beyond capacity drop the oldest item.
 * Used to queue per-client WebSocket events without unbounded memory growth.
 */
export class RingBuffer<T> {
  private buf: (T | undefined)[];
  private head = 0; // index of next write
  private size = 0;
  private _dropped = 0;
  private readonly cap: number;

  constructor(capacity: number) {
    if (capacity < 1) throw new RangeError("RingBuffer capacity must be >= 1");
    this.cap = capacity;
    this.buf = new Array<T | undefined>(capacity);
  }

  /** Add an item. If the buffer is full, the oldest item is silently dropped. */
  push(item: T): void {
    if (this.size === this.cap) {
      // Overwrite oldest — head is already pointing at the oldest slot
      this.buf[this.head] = item;
      this.head = (this.head + 1) % this.cap;
      this._dropped++;
    } else {
      const writeIdx = (this.head + this.size) % this.cap;
      this.buf[writeIdx] = item;
      this.size++;
    }
  }

  /** Remove and return all items in insertion order, clearing the buffer. */
  drain(): T[] {
    if (this.size === 0) return [];
    const result: T[] = new Array(this.size);
    for (let i = 0; i < this.size; i++) {
      const idx = (this.head + i) % this.cap;
      result[i] = this.buf[idx]!;
      this.buf[idx] = undefined; // allow GC
    }
    this.head = 0;
    this.size = 0;
    return result;
  }

  /** Current number of items in the buffer. */
  get length(): number {
    return this.size;
  }

  /** Total number of items dropped due to overflow since creation. */
  get dropped(): number {
    return this._dropped;
  }

  /** Clear all items without affecting the dropped count. */
  clear(): void {
    for (let i = 0; i < this.size; i++) {
      const idx = (this.head + i) % this.cap;
      this.buf[idx] = undefined;
    }
    this.head = 0;
    this.size = 0;
  }
}
