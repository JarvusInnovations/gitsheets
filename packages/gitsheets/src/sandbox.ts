// The deterministic `node:vm` realm for definition snippets on the Node
// binding — path-template expression components (the exported `Template`) and
// raw-JS sort comparators (`Sheet.normalizeRecord`'s `buildSorter`).
//
// Spec: specs/rust-core.md "Determinism rule for definition snippets". The
// core's embedded boa engine is the reference (rust/gitsheets-core/src/
// engine.rs: pinned UTC host hooks + the `DENY_NONDETERMINISM` bootstrap);
// while those two snippet kinds still run host-side in `node:vm`, this realm
// must produce the same results and the same denial messages:
//
// - no `Math.random`, no `Date.now`, no argument-less `Date` (TypeError);
// - local-time `Date` methods read UTC (`getHours`, `getTimezoneOffset` → 0,
//   `toString` in boa's `… GMT+0000` form), the multi-argument constructor and
//   offset-less ISO date-time strings are taken at UTC, `toLocale*String`
//   throws;
// - `Date.parse` / `new Date(string)` accept ISO 8601 and the `toString()` /
//   `toUTCString()` forms only (anything else is NaN, as in boa).
//
// V8 has no per-context time zone, so the UTC reading is done by patching the
// realm's own `Date.prototype`. A host `Date` handed in from a record still
// carries the HOST prototype, so every argument crosses `toRealm`, which
// rebuilds plain objects / arrays and turns each `Date` into a realm `Date` of
// the same instant (the core marshals a record into the engine the same way).

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

  // String parsing: ISO 8601 (offset-less date-time read at UTC, like boa with
  // its local offset pinned to 0), plus the toString / toUTCString forms, whose
  // zone is explicit. Anything else is NaN — boa parses nothing else.
  const ISO = /^(?:[+-]\d{6}|\d{4})(?:-\d{2}(?:-\d{2})?)?(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?)?$/;
  const TO_STRING = /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{2} -?\d{4,} \d{2}:\d{2}:\d{2} GMT[+-]\d{4}$/;
  const TO_UTC_STRING = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} -?\d{4,} \d{2}:\d{2}:\d{2} GMT$/;
  const parse = (input) => {
    const s = String(input);
    const iso = ISO.exec(s);
    if (iso) return s.includes('T') && iso[1] === undefined ? D.parse(s + 'Z') : D.parse(s);
    if (TO_STRING.test(s) || TO_UTC_STRING.test(s)) return D.parse(s);
    return NaN;
  };

  const SafeDate = function Date(...args) {
    if (new.target === undefined) {
      throw new TypeError('Date() is not available in a gitsheets snippet: it reads the clock' + why);
    }
    if (args.length === 0) {
      throw new TypeError('new Date() with no arguments is not available in a gitsheets snippet: it reads the clock' + why);
    }
    if (args.length === 1) {
      const v = args[0];
      return Reflect.construct(D, [typeof v === 'string' ? parse(v) : v], new.target);
    }
    // new Date(y, m, …) reads local time; local is UTC here.
    return Reflect.construct(D, [D.UTC(...args)], new.target);
  };
  SafeDate.prototype = P;
  define(P, 'constructor', SafeDate);
  SafeDate.UTC = D.UTC;
  SafeDate.parse = parse;
  SafeDate.now = deny('Date.now()');
  define(globalThis, 'Date', SafeDate);
  Math.random = deny('Math.random()');

  // Local-time accessors and setters → their UTC twins.
  for (const name of ['FullYear', 'Month', 'Date', 'Day', 'Hours', 'Minutes', 'Seconds', 'Milliseconds']) {
    define(P, 'get' + name, P['getUTC' + name]);
    if (name !== 'Day') define(P, 'set' + name, P['setUTC' + name]);
  }
  define(P, 'getYear', function getYear() {
    return P.getUTCFullYear.call(this) - 1900;
  });
  define(P, 'getTimezoneOffset', function getTimezoneOffset() {
    return Number.isNaN(P.getTime.call(this)) ? NaN : 0;
  });

  // toString / toDateString / toTimeString in boa's UTC form
  // ('Wed Mar 04 2026 05:06:07 GMT+0000').
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
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

  // Copy a host value into this realm: plain objects and arrays are rebuilt,
  // a Date becomes a realm Date of the same instant, everything else passes.
  const isHostDate = (v) => {
    try {
      P.getTime.call(v);
      return true;
    } catch {
      return false;
    }
  };
  const toRealm = (v, seen = new Map()) => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v)) return seen.get(v);
    if (isHostDate(v)) return Reflect.construct(D, [P.getTime.call(v)]);
    if (Array.isArray(v)) {
      const out = [];
      seen.set(v, out);
      for (const item of v) out.push(toRealm(item, seen));
      return out;
    }
    const proto = Object.getPrototypeOf(v);
    if (proto !== null && Object.getPrototypeOf(proto) !== null) return v;
    const out = {};
    seen.set(v, out);
    for (const key of Object.keys(v)) out[key] = toRealm(v[key], seen);
    return out;
  };
  return toRealm;
})()`;

/**
 * Compile `source` (which must evaluate to a function) in a fresh
 * deterministic realm. The returned function copies every argument into the
 * realm (`Date`s included) before calling the snippet. Errors thrown by the
 * snippet are the realm's own error objects — match them by `name`, not
 * `instanceof`.
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
