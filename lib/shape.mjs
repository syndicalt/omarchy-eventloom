// True for a JSON object: not null, not an array.
export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
