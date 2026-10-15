/*
 * version-compare.js — tiny semver-ish compare, no dependencies.
 *
 * compareVersions('2.10.0', '2.9.9') > 0. A leading 'v' is ignored ('v2.1.2'
 * equals '2.1.2'), missing components count as 0 ('2.1' equals '2.1.0'), and
 * non-numeric tails ('2.1.0-beta') are treated as their numeric part.
 */
function parse(v) {
  return String(v || '').trim().replace(/^v/i, '').split('.').map(part => {
    const n = parseInt(part, 10);
    return Number.isFinite(n) ? n : 0;
  });
}

/** Returns -1, 0 or 1 like a classic comparator. */
function compareVersions(a, b) {
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

module.exports = { compareVersions };
