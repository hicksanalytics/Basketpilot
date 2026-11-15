(function (root) {
  'use strict';
  const key = 'basketpilot.pending-product-search';
  const lifetime = 15 * 60 * 1000;
  const returnHash = '#resume-search';

  function create(getStorage = () => root.sessionStorage, now = Date.now) {
    function clear() {
      try { getStorage().removeItem(key); } catch {}
    }

    function read() {
      try {
        const entry = JSON.parse(getStorage().getItem(key));
        if (!entry) return null;
        if (typeof entry.query === 'string' && entry.query && entry.query.length <= 120
          && Number.isFinite(entry.expiresAt) && entry.expiresAt > now()) return entry;
      } catch {}
      clear();
      return null;
    }

    function write(entry) {
      try {
        getStorage().setItem(key, JSON.stringify(entry));
        return true;
      } catch {
        clear();
        return false;
      }
    }

    function remember(query) {
      const trimmed = query.trim();
      if (!trimmed || trimmed.length > 120) {
        clear();
        return false;
      }
      return write({ query: trimmed, expiresAt: now() + lifetime });
    }

    function hasPending() {
      return Boolean(read());
    }

    function prepareReturn(owner) {
      const entry = read();
      if (!entry || !owner || (entry.owner && entry.owner !== owner)) return false;
      return write({ ...entry, owner });
    }

    function take(owner) {
      const entry = read();
      clear();
      return owner && entry?.owner === owner ? entry.query : null;
    }

    return { remember, hasPending, prepareReturn, take, clear };
  }

  const api = { create, returnHash };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BasketPilotSearchResume = api;
})(typeof window === 'undefined' ? globalThis : window);
