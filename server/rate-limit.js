'use strict';

// Einfacher Sliding-Window-Limiter im Speicher. Reicht für eine einzelne
// Server-Instanz; bei mehreren Instanzen bräuchte es einen geteilten Speicher.
class RateLimiter {
  constructor() {
    this.hits = new Map();
  }

  allow(key, max, windowMs, now = Date.now()) {
    const list = (this.hits.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length >= max) {
      this.hits.set(key, list);
      return false;
    }
    list.push(now);
    this.hits.set(key, list);
    return true;
  }

  // Wie allow(), zählt aber keinen Treffer (z. B. nur Fehlversuche zählen, vorher prüfen).
  wouldAllow(key, max, windowMs, now = Date.now()) {
    const list = this.hits.get(key);
    if (!list) return true;
    return list.filter((t) => now - t < windowMs).length < max;
  }

  prune(now = Date.now(), maxAgeMs = 15 * 60_000) {
    for (const [key, list] of this.hits) {
      if (!list.length || now - list[list.length - 1] > maxAgeMs) this.hits.delete(key);
    }
  }
}

module.exports = { RateLimiter };
