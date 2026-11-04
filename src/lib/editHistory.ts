/** Snapshot transactions keep restoration, multi-edge drags and grouped edits atomic. */
export class EditHistory<T extends { id: string; group?: { id: string } }> {
  current: T[] = [];
  private past: T[][] = [];
  private future: T[][] = [];
  private group: string | undefined;

  hydrate(actions: T[]) {
    this.current = [];
    this.past = [];
    this.future = [];
    for (const action of actions) this.set([...this.current, action]);
    this.group = undefined;
  }
  set(next: T[]) {
    if (next.length === this.current.length && next.every((a, i) => a === this.current[i])) return;
    const appending = next.length > this.current.length && this.current.every((a, i) => next[i] === a);
    const added = appending ? next.slice(this.current.length) : [];
    const group = added[0]?.group?.id;
    const sameGroup = group && added.every(a => a.group?.id === group);
    if (!sameGroup || this.group !== group || this.future.length) this.past.push(this.current);
    this.past = this.past.slice(-200);
    this.current = next;
    this.group = sameGroup ? group : undefined;
    this.future = [];
  }
  undo() {
    const previous = this.past.pop();
    if (!previous) return;
    this.future.push(this.current);
    this.current = previous;
    this.group = undefined;
  }
  redo() {
    const next = this.future.pop();
    if (!next) return;
    this.past.push(this.current);
    this.current = next;
    this.group = undefined;
  }
}
