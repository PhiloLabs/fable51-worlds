/** Minimal, allocation-free object pool. */
export class Pool<T> {
  private free: T[] = [];
  readonly active: T[] = [];
  constructor(private factory: () => T, private onGet?: (o: T) => void, private onRelease?: (o: T) => void, prealloc = 0) {
    for (let i = 0; i < prealloc; i++) this.free.push(factory());
  }
  get(): T {
    const o = this.free.pop() ?? this.factory();
    this.active.push(o);
    this.onGet?.(o);
    return o;
  }
  release(o: T) {
    const i = this.active.indexOf(o);
    if (i >= 0) this.active.splice(i, 1);
    this.onRelease?.(o);
    this.free.push(o);
  }
  releaseAt(i: number) {
    const o = this.active[i];
    this.active.splice(i, 1);
    this.onRelease?.(o);
    this.free.push(o);
    return o;
  }
  releaseAll() { while (this.active.length) this.releaseAt(this.active.length - 1); }
  get activeCount() { return this.active.length; }
}
