export class History {
  constructor(initial, limit = 80) { this.limit = limit; this.reset(initial); }
  reset(value) { this.items = [structuredClone(value)]; this.index = 0; }
  push(value) {
    if (JSON.stringify(this.items[this.index]) === JSON.stringify(value)) return;
    this.items.splice(this.index + 1); this.items.push(structuredClone(value));
    if (this.items.length > this.limit) this.items.shift(); this.index = this.items.length - 1;
  }
  get canUndo() { return this.index > 0; }
  get canRedo() { return this.index < this.items.length - 1; }
  undo() { if (this.canUndo) this.index--; return structuredClone(this.items[this.index]); }
  redo() { if (this.canRedo) this.index++; return structuredClone(this.items[this.index]); }
}
