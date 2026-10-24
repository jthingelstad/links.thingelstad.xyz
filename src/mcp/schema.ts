// Tool argument checking: the small part of JSON Schema the tool specs use
// (object, string, integer, boolean, enum, bounds, pattern, anyOf), so a
// refusal can name the argument and every argument the tool accepts. A
// digit string where an integer is wanted is read as the integer.

export interface Schema {
  type?: 'object' | 'string' | 'integer' | 'boolean';
  description?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean;
  enum?: readonly (string | number)[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  anyOf?: Schema[];
  default?: unknown;
}

export class ArgumentError extends Error {}

function check(name: string, value: unknown, schema: Schema): unknown {
  if (schema.anyOf) {
    for (const option of schema.anyOf) {
      try {
        return check(name, value, option);
      } catch {
        continue;
      }
    }
    throw new ArgumentError(`${name} must be ${describe(schema)}.`);
  }
  let v = value;
  switch (schema.type) {
    case 'string':
      if (typeof v !== 'string')
        throw new ArgumentError(`${name} must be a string.`);
      if (schema.minLength !== undefined && v.length < schema.minLength)
        throw new ArgumentError(`${name} must not be empty.`);
      if (schema.maxLength !== undefined && v.length > schema.maxLength)
        throw new ArgumentError(
          `${name} must be at most ${schema.maxLength} characters.`,
        );
      if (schema.pattern && !new RegExp(schema.pattern).test(v))
        throw new ArgumentError(`${name} must be ${describe(schema)}.`);
      break;
    case 'integer':
      if (typeof v === 'string' && /^-?\d{1,9}$/.test(v.trim())) v = Number(v);
      if (typeof v !== 'number' || !Number.isInteger(v))
        throw new ArgumentError(`${name} must be an integer.`);
      if (
        (schema.minimum !== undefined && v < schema.minimum) ||
        (schema.maximum !== undefined && v > schema.maximum)
      )
        throw new ArgumentError(
          `${name} must be from ${schema.minimum} to ${schema.maximum}.`,
        );
      break;
    case 'boolean':
      if (typeof v !== 'boolean')
        throw new ArgumentError(`${name} must be true or false.`);
      break;
  }
  if (schema.enum && !schema.enum.includes(v as string | number))
    throw new ArgumentError(
      `${name} must be one of ${schema.enum.join(', ')}.`,
    );
  return v;
}

function describe(schema: Schema): string {
  if (schema.anyOf) return schema.anyOf.map(describe).join(' or ');
  if (schema.type === 'integer')
    return `an integer from ${schema.minimum} to ${schema.maximum}`;
  if (schema.pattern) return `a string matching ${schema.pattern}`;
  if (schema.type === 'boolean') return 'true or false';
  return `a ${schema.type}`;
}

// The arguments, checked and with defaults filled in. Throws ArgumentError.
export function validate(
  args: unknown,
  schema: Schema,
): Record<string, unknown> {
  const given = args ?? {};
  if (typeof given !== 'object' || Array.isArray(given))
    throw new ArgumentError('The arguments must be an object.');
  const props = schema.properties ?? {};
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(given)) {
    if (!(name in props))
      throw new ArgumentError(`Unknown argument "${name}".`);
    if (value === null || value === undefined) continue;
    out[name] = check(name, value, props[name]);
  }
  for (const name of schema.required ?? [])
    if (!(name in out)) throw new ArgumentError(`${name} is required.`);
  for (const [name, prop] of Object.entries(props))
    if (!(name in out) && prop.default !== undefined) out[name] = prop.default;
  return out;
}
