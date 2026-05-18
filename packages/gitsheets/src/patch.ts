// RFC 7396 JSON Merge Patch.
//
// Semantics (per RFC):
//   - null in the patch deletes the corresponding member of the target
//   - arrays in the patch replace the target's array entirely (no concat)
//   - objects merge recursively
//   - scalars in the patch replace the target's value
//
// Inline implementation (rather than a dependency) so @iarna/toml's custom
// Date subclasses round-trip cleanly through the merge without classification.

type Mergable = Record<string, unknown>;

function isPlainObject(value: unknown): value is Mergable {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  if (value instanceof Date) return false;
  // Treat anything with a non-Object prototype as a class instance (BlobObject, etc.)
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch)) {
    // Scalars, arrays, null, Dates, class instances — replace wholesale.
    return patch;
  }
  // Patch is an object — merge into a fresh plain object derived from target.
  const base: Mergable = isPlainObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete base[key];
    } else {
      base[key] = mergePatch(base[key], value);
    }
  }
  return base;
}
