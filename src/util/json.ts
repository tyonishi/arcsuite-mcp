export function assertObject(value: unknown, label = "value"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function assertExactKeys(obj: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const extras = Object.keys(obj).filter((key) => !allowedSet.has(key));
  if (extras.length) throw new TypeError(`${label} contains unsupported fields: ${extras.join(", ")}`);
}

export function stringValue(value: unknown, label: string, min = 0, max = Number.MAX_SAFE_INTEGER): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  if (value.length < min || value.length > max) throw new TypeError(`${label} length must be ${min}..${max}`);
  return value;
}

export function optionalString(value: unknown, label: string, max = Number.MAX_SAFE_INTEGER): string | undefined {
  if (value === undefined || value === null) return undefined;
  return stringValue(value, label, 0, max);
}

export function intValue(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isInteger(value)) throw new TypeError(`${label} must be an integer`);
  const n = Number(value);
  if (n < min || n > max) throw new TypeError(`${label} must be ${min}..${max}`);
  return n;
}

export function optionalInt(value: unknown, label: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  return intValue(value, label, min, max);
}

export function boolValue(value: unknown, defaultValue: boolean): boolean {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== "boolean") throw new TypeError("value must be boolean");
  return value;
}

export function enumValue<T extends string>(value: unknown, allowed: readonly T[], defaultValue?: T): T {
  if (value === undefined || value === null) {
    if (defaultValue !== undefined) return defaultValue;
    throw new TypeError(`value must be one of ${allowed.join(", ")}`);
  }
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new TypeError(`value must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(item).sort()) sorted[key] = (item as Record<string, unknown>)[key];
      return sorted;
    }
    return item;
  });
}
