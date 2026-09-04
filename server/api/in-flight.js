class InFlightSet extends Set {
  constructor() {
    super();
    /** @type {Map<string, Array<() => void>>} */
    this.waiters = new Map();
  }

  delete(id) {
    const result = super.delete(id);
    const list = this.waiters.get(id);
    if (list && list.length > 0) {
      const next = list.shift();
      if (list.length === 0) this.waiters.delete(id);
      next();
    }
    return result;
  }

  async waitFor(id, timeoutMs = 10000) {
    if (!this.has(id)) return true;
    return new Promise((resolve) => {
      let resolved = false;
      const timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        const list = this.waiters.get(id);
        if (list) {
          const idx = list.indexOf(onTurn);
          if (idx !== -1) list.splice(idx, 1);
        }
        resolve(false);
      }, timeoutMs);
      const onTurn = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        resolve(true);
      };
      if (!this.waiters.has(id)) this.waiters.set(id, []);
      this.waiters.get(id).push(onTurn);
    });
  }
}

module.exports = new InFlightSet();
