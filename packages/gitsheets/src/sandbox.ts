// The deterministic `node:vm` realm for definition snippets on the Node
// binding — path-template expression components (the exported `Template`) and
// raw-JS sort comparators (`Sheet.normalizeRecord`'s `buildSorter`).
//
// Spec: specs/rust-core.md "Determinism rule for definition snippets". The
// core's embedded boa engine is the reference (rust/gitsheets-core/src/
// engine.rs: pinned UTC host hooks + the `DENY_NONDETERMINISM` bootstrap);
// while those two snippet kinds still run host-side in `node:vm`, this realm
// must produce the same results and the same denial messages. What it covers:
//
// - globals: no `Math.random`, `Date.now`, argument-less `Date` (TypeError);
//   the V8-only globals boa lacks (`Intl`, `WebAssembly`, `console`, …) and
//   the shared-memory pair both realms drop are deleted;
// - `Date`: local-time getters/setters (incl. Annex B `getYear`/`setYear`)
//   read and write UTC, `getTimezoneOffset` is 0, `toString` /
//   `toDateString` / `toTimeString` use boa's `… GMT+0000` form, the
//   multi-argument constructor is UTC, `toLocale*String` throws;
// - string → time (`Date.parse`, `new Date(x)` after ToPrimitive): computed
//   here, never by V8's parser — ISO 8601 (3-digit fractions, offset-less at
//   UTC), and boa's `toString()` / `toUTCString()` forms, field-validated;
//   anything else is NaN, as in boa;
// - locale methods: `localeCompare` is code-unit order, `toLocaleUpper/
//   LowerCase` ignore the locale, `Number`/`BigInt#toLocaleString` are
//   `String(x)`, `Array`/typed-array `toLocaleString` join with `', '`.
//
// V8 has no per-context time zone, so the UTC reading is done by patching the
// realm's own prototypes. A value handed in from the host carries the HOST
// prototypes, so every argument crosses `toRealm`, which copies it into the
// realm the way the napi marshaller copies it into the core (own enumerable
// keys; a `Date` becomes a realm `Date` of the same instant). A snippet
// therefore never mutates its caller's values — as in the core.

import { createContext, runInContext } from 'node:vm';

const BOOTSTRAP = String.raw`(() => {
  const D = Date;
  const P = D.prototype;
  const why = ': gitsheets definition snippets must be a pure function of their inputs';
  const deny = (what) => function () {
    throw new TypeError(what + ' is not available in a gitsheets snippet: it is nondeterministic' + why);
  };
  const define = (obj, key, value) =>
    Object.defineProperty(obj, key, { value, writable: true, configurable: true, enumerable: false });
  const isObject = (v) => v !== null && (typeof v === 'object' || typeof v === 'function');
  const isDate = (v) => {
    if (!isObject(v)) return false;
    try {
      P.getTime.call(v);
      return true;
    } catch {
      return false;
    }
  };

  // --- globals boa does not have ---------------------------------------
  for (const name of ['Intl', 'WebAssembly', 'SharedArrayBuffer', 'Atomics', 'console', 'FinalizationRegistry', 'Iterator', 'escape', 'unescape']) {
    delete globalThis[name];
  }

  // --- string → time value ---------------------------------------------
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const leap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const monthDays = (y, m) => [31, leap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  const MAX = 8.64e15;
  // y/mo/d/h/mi/s/ms are integers; offset in minutes east of UTC.
  const timeOf = (y, mo, d, h, mi, s, ms, offset) => {
    const t0 = new D(0);
    P.setUTCFullYear.call(t0, y, mo - 1, d);
    P.setUTCHours.call(t0, h, mi, s, ms);
    const t = P.getTime.call(t0) - offset * 60000;
    return Math.abs(t) <= MAX ? t : NaN;
  };
  const ISO = /^([+-]\d{6}|\d{4})(?:-(\d{2})(?:-(\d{2}))?)?(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{3}))?)?(Z|([+-])(\d{2}):(\d{2}))?)?$/;
  const parseIso = (m) => {
    if (m[1] === '-000000') return NaN;
    const y = Number(m[1]);
    const mo = m[2] === undefined ? 1 : Number(m[2]);
    const d = m[3] === undefined ? 1 : Number(m[3]);
    const h = m[4] === undefined ? 0 : Number(m[4]);
    const mi = m[5] === undefined ? 0 : Number(m[5]);
    const s = m[6] === undefined ? 0 : Number(m[6]);
    const ms = m[7] === undefined ? 0 : Number(m[7]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return NaN;
    if (mi > 59 || s > 59) return NaN;
    // 24:00 is end-of-day only (boa also takes 24:01 / 24:00:00.001 — a boa
    // bug the spec records as a known divergence).
    if (h > 24 || (h === 24 && (mi !== 0 || s !== 0 || ms !== 0))) return NaN;
    let offset = 0;
    if (m[9] !== undefined) {
      const oh = Number(m[10]);
      const om = Number(m[11]);
      if (oh > 23 || om > 59) return NaN;
      offset = (m[9] === '-' ? -1 : 1) * (oh * 60 + om);
    }
    return timeOf(y, mo, d, h, mi, s, ms, offset);
  };
  const namedTime = (d, mo, y, h, mi, s, offset) => {
    const yn = Number(y);
    const mn = MONTHS.indexOf(mo) + 1;
    const dn = Number(d);
    const hn = Number(h);
    const min = Number(mi);
    const sn = Number(s);
    if (dn < 1 || dn > monthDays(yn, mn) || hn > 23 || min > 59 || sn > 59) return NaN;
    return timeOf(yn, mn, dn, hn, min, sn, 0, offset);
  };
  const DN = DAYS.join('|');
  const MN = MONTHS.join('|');
  const TO_STRING = new RegExp('^(?:' + DN + ') (' + MN + ') (\\d{2}) (-\\d{4,}|\\d{4}) (\\d{2}):(\\d{2}):(\\d{2}) GMT([+-])(\\d{2})(\\d{2})$');
  const TO_UTC_STRING = new RegExp('^(?:' + DN + '), (\\d{2}) (' + MN + ') (-\\d{4,}|\\d{4}) (\\d{2}):(\\d{2}):(\\d{2}) GMT$');
  const parse = (input) => {
    const s = String(input);
    let m = ISO.exec(s);
    if (m) return parseIso(m);
    m = TO_STRING.exec(s);
    if (m) {
      if (Number(m[9]) > 59) return NaN;
      const offset = (m[7] === '-' ? -1 : 1) * (Number(m[8]) * 60 + Number(m[9]));
      return namedTime(m[2], m[1], m[3], m[4], m[5], m[6], offset);
    }
    m = TO_UTC_STRING.exec(s);
    if (m) return namedTime(m[1], m[2], m[3], m[4], m[5], m[6], 0);
    return NaN;
  };

  // ToPrimitive(v, default), as the Date constructor applies it.
  const toPrimitive = (v) => {
    if (!isObject(v)) return v;
    const exotic = v[Symbol.toPrimitive];
    if (exotic !== undefined && exotic !== null) {
      const r = exotic.call(v, 'default');
      if (isObject(r)) throw new TypeError('Cannot convert object to primitive value');
      return r;
    }
    for (const name of ['valueOf', 'toString']) {
      const f = v[name];
      if (typeof f === 'function') {
        const r = f.call(v);
        if (!isObject(r)) return r;
      }
    }
    throw new TypeError('Cannot convert object to primitive value');
  };

  // --- the Date constructor ---------------------------------------------
  const SafeDate = function Date(...args) {
    if (new.target === undefined) {
      throw new TypeError('Date() is not available in a gitsheets snippet: it reads the clock' + why);
    }
    if (args.length === 0) {
      throw new TypeError('new Date() with no arguments is not available in a gitsheets snippet: it reads the clock' + why);
    }
    if (args.length === 1) {
      const v = args[0];
      if (isDate(v)) return Reflect.construct(D, [P.getTime.call(v)], new.target);
      const p = toPrimitive(v);
      return Reflect.construct(D, [typeof p === 'string' ? parse(p) : p], new.target);
    }
    // new Date(y, m, …) reads local time; local is UTC here.
    return Reflect.construct(D, [D.UTC(...args)], new.target);
  };
  SafeDate.prototype = P;
  define(P, 'constructor', SafeDate);
  SafeDate.UTC = D.UTC;
  SafeDate.parse = { parse(s) { return parse(s); } }.parse;
  SafeDate.now = deny('Date.now()');
  define(globalThis, 'Date', SafeDate);
  Math.random = deny('Math.random()');

  // --- Date.prototype: local time is UTC --------------------------------
  for (const name of ['FullYear', 'Month', 'Date', 'Day', 'Hours', 'Minutes', 'Seconds', 'Milliseconds']) {
    define(P, 'get' + name, P['getUTC' + name]);
    if (name !== 'Day') define(P, 'set' + name, P['setUTC' + name]);
  }
  define(P, 'getYear', function getYear() {
    return P.getUTCFullYear.call(this) - 1900;
  });
  // Annex B setYear, at UTC: a NaN time starts from +0; 0–99 means 1900+.
  define(P, 'setYear', function setYear(year) {
    let t = P.getTime.call(this);
    if (Number.isNaN(t)) t = 0;
    const y = Number(year);
    if (Number.isNaN(y)) return P.setTime.call(this, NaN);
    const yi = Math.trunc(y);
    const full = yi >= 0 && yi <= 99 ? 1900 + yi : y;
    const tmp = new D(t);
    P.setUTCFullYear.call(tmp, full);
    return P.setTime.call(this, P.getTime.call(tmp));
  });
  define(P, 'getTimezoneOffset', function getTimezoneOffset() {
    return Number.isNaN(P.getTime.call(this)) ? NaN : 0;
  });

  const pad = (n, w) => String(n).padStart(w, '0');
  const datePart = (d) => {
    const y = P.getUTCFullYear.call(d);
    return DAYS[P.getUTCDay.call(d)] + ' ' + MONTHS[P.getUTCMonth.call(d)] + ' ' +
      pad(P.getUTCDate.call(d), 2) + ' ' + (y < 0 ? '-' : '') + pad(Math.abs(y), 4);
  };
  const timePart = (d) =>
    pad(P.getUTCHours.call(d), 2) + ':' + pad(P.getUTCMinutes.call(d), 2) + ':' +
    pad(P.getUTCSeconds.call(d), 2) + ' GMT+0000';
  const invalid = (d) => Number.isNaN(P.getTime.call(d));
  define(P, 'toString', function toString() {
    return invalid(this) ? 'Invalid Date' : datePart(this) + ' ' + timePart(this);
  });
  define(P, 'toDateString', function toDateString() {
    return invalid(this) ? 'Invalid Date' : datePart(this);
  });
  define(P, 'toTimeString', function toTimeString() {
    return invalid(this) ? 'Invalid Date' : timePart(this);
  });
  for (const m of ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']) {
    define(P, m, function () {
      throw new TypeError('Date.prototype.' + m + '() is not available in a gitsheets snippet: it reads the host locale and time zone' + why);
    });
  }

  // --- locale-sensitive methods: boa's locale-free behavior ---------------
  define(String.prototype, 'localeCompare', function localeCompare(that) {
    if (this === null || this === undefined) {
      throw new TypeError('String.prototype.localeCompare called on null or undefined');
    }
    const a = String(this);
    const b = String(that);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const upper = String.prototype.toUpperCase;
  const lower = String.prototype.toLowerCase;
  define(String.prototype, 'toLocaleUpperCase', function toLocaleUpperCase() {
    return upper.call(this);
  });
  define(String.prototype, 'toLocaleLowerCase', function toLocaleLowerCase() {
    return lower.call(this);
  });
  const numberValue = Number.prototype.valueOf;
  define(Number.prototype, 'toLocaleString', function toLocaleString() {
    return String(numberValue.call(this));
  });
  const bigintValue = BigInt.prototype.valueOf;
  define(BigInt.prototype, 'toLocaleString', function toLocaleString() {
    return String(bigintValue.call(this));
  });
  const joinLocale = function toLocaleString() {
    const o = Object(this);
    const len = Math.min(Math.max(Math.trunc(Number(o.length)) || 0, 0), Number.MAX_SAFE_INTEGER);
    let out = '';
    for (let k = 0; k < len; k++) {
      if (k > 0) out += ', ';
      const e = o[k];
      if (e !== undefined && e !== null) out += String(e.toLocaleString());
    }
    return out;
  };
  define(Array.prototype, 'toLocaleString', joinLocale);
  define(Object.getPrototypeOf(Int8Array.prototype), 'toLocaleString', joinLocale);

  // --- copying arguments into the realm -----------------------------------
  const toRealm = (v, seen = new Map()) => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v)) return seen.get(v);
    if (isDate(v)) return Reflect.construct(D, [P.getTime.call(v)]);
    const out = Array.isArray(v) ? new Array(v.length) : {};
    seen.set(v, out);
    for (const key of Object.keys(v)) {
      Object.defineProperty(out, key, {
        value: toRealm(v[key], seen),
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    return out;
  };
  return toRealm;
})()`;

/**
 * Compile `source` (which must evaluate to a function) in a fresh
 * deterministic realm. The returned function copies every argument into the
 * realm (`Date`s included) before calling the snippet. Errors thrown by the
 * snippet — and a `SyntaxError` from compiling it — are the realm's own error
 * objects: match them by `name`, not `instanceof`.
 */
export function compileSnippet(source: string): (...args: unknown[]) => unknown {
  const context = createContext({});
  const toRealm = runInContext(BOOTSTRAP, context) as (v: unknown) => unknown;
  const fn = runInContext(source, context) as (...args: unknown[]) => unknown;
  return (...args: unknown[]) => fn(...args.map((a) => toRealm(a)));
}

/** The message of a value thrown by a snippet, whatever realm it came from. */
export function thrownMessage(err: unknown): string {
  if (err !== null && typeof err === 'object' && 'message' in err) {
    const name = 'name' in err ? String((err as { name: unknown }).name) : 'Error';
    return `${name}: ${String((err as { message: unknown }).message)}`;
  }
  return String(err);
}
