// 만료시간이 있는 소형 메모리 저장소. 용량을 넘으면 가장 오래 안 쓴 항목부터 버린다.

interface Slot<V> {
  value: V;
  expiresAt: number;
}

export class TtlStore<V> {
  private readonly slots = new Map<string, Slot<V>>();

  constructor(private readonly capacity = 500, private readonly now: () => number = Date.now) {}

  get(key: string): V | undefined {
    const slot = this.slots.get(key);
    if (!slot) return undefined;
    if (slot.expiresAt <= this.now()) {
      this.slots.delete(key);
      return undefined;
    }
    // 최근 사용으로 재배치
    this.slots.delete(key);
    this.slots.set(key, slot);
    return slot.value;
  }

  put(key: string, value: V, ttlSec: number): void {
    if (this.slots.has(key)) this.slots.delete(key);
    this.slots.set(key, { value, expiresAt: this.now() + ttlSec * 1000 });
    while (this.slots.size > this.capacity) {
      const oldest = this.slots.keys().next().value;
      if (oldest === undefined) break;
      this.slots.delete(oldest);
    }
  }

  get size(): number {
    return this.slots.size;
  }
}
