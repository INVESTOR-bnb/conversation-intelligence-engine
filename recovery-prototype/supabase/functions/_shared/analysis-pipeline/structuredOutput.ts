// Stage 2A-6b — the structured-output schemas, checked twice.
//
// 1. schemaProblems(): the schema we send must stay inside what the provider's
//    structured outputs accept (Anthropic, `output_config.format` json_schema, as
//    documented at platform.claude.com/docs/en/build-with-claude/structured-outputs):
//      * every object has additionalProperties: false;
//      * no keyword outside the small subset below (so no minimum/maximum,
//        minLength/maxLength, pattern, minItems > 1, $ref/recursion, ...);
//      * at most 24 optional properties and 16 union-typed parameters in total.
//    A schema outside these limits is refused before any reservation.
// 2. validateOutput(): the answer is checked against the same schema on our side,
//    after its usage was reported. A provider's grammar is not trusted to have held
//    (a refusal or a cut-off answer may not match it): anything outside the schema
//    fails closed as SCHEMA_INVALID_<ROLE>. The database contract still judges every
//    rule the schema cannot express (citations, quotes, consistency).

const KEYWORDS = new Set(['type', 'enum', 'properties', 'required', 'additionalProperties', 'items']);
const TYPES = new Set(['object', 'array', 'string', 'integer', 'number', 'boolean', 'null']);
export const MAX_OPTIONAL_PROPERTIES = 24;
export const MAX_UNION_PARAMETERS = 16;

type Schema = Record<string, unknown>;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const typesOf = (s: Schema): string[] => (Array.isArray(s.type) ? (s.type as string[]) : typeof s.type === 'string' ? [s.type] : []);

/** Problems that would make the provider reject the schema (empty when it is acceptable). */
export function schemaProblems(schema: unknown): string[] {
  const problems: string[] = [];
  let optional = 0;
  let unions = 0;
  const walk = (s: unknown, path: string) => {
    if (!isObj(s)) { problems.push(`${path}: not a schema object`); return; }
    for (const k of Object.keys(s)) if (!KEYWORDS.has(k)) problems.push(`${path}: unsupported keyword ${k}`);
    const types = typesOf(s);
    if (types.length === 0 || types.some((t) => !TYPES.has(t))) problems.push(`${path}: missing or unknown type`);
    if (types.length > 1) unions += 1;
    if (s.enum !== undefined) {
      if (!Array.isArray(s.enum) || s.enum.length === 0) problems.push(`${path}: empty enum`);
      else if (s.enum.some((v) => v !== null && typeof v !== 'string')) problems.push(`${path}: enum values must be strings or null`);
    }
    if (types.includes('object')) {
      if (s.additionalProperties !== false) problems.push(`${path}: additionalProperties must be false`);
      if (!isObj(s.properties)) { problems.push(`${path}: object without properties`); return; }
      const required = Array.isArray(s.required) ? (s.required as unknown[]) : [];
      for (const r of required) if (typeof r !== 'string' || !(r in s.properties)) problems.push(`${path}: required ${String(r)} is not a property`);
      for (const [k, v] of Object.entries(s.properties)) {
        if (!required.includes(k)) optional += 1;
        walk(v, `${path}.${k}`);
      }
    } else if (s.properties !== undefined || s.required !== undefined || s.additionalProperties !== undefined) {
      problems.push(`${path}: object keywords on a non-object`);
    }
    if (types.includes('array')) walk(s.items, `${path}[]`);
    else if (s.items !== undefined) problems.push(`${path}: items on a non-array`);
  };
  walk(schema, '$');
  if (optional > MAX_OPTIONAL_PROPERTIES) problems.push(`$: ${optional} optional properties (limit ${MAX_OPTIONAL_PROPERTIES})`);
  if (unions > MAX_UNION_PARAMETERS) problems.push(`$: ${unions} union-typed parameters (limit ${MAX_UNION_PARAMETERS})`);
  return problems;
}

function typeMatches(v: unknown, t: string): boolean {
  switch (t) {
    case 'null': return v === null;
    case 'string': return typeof v === 'string';
    case 'boolean': return typeof v === 'boolean';
    case 'integer': return typeof v === 'number' && Number.isSafeInteger(v);
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'array': return Array.isArray(v);
    case 'object': return isObj(v);
    default: return false;
  }
}

/** The first place the value leaves the schema (a path only, never the value), or null when it conforms. */
export function validateOutput(value: unknown, schema: Schema, path = '$'): string | null {
  const types = typesOf(schema);
  if (!types.some((t) => typeMatches(value, t))) return `${path}: wrong type`;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value as never)) return `${path}: not an allowed value`;
  if (isObj(value) && isObj(schema.properties)) {
    const props = schema.properties as Record<string, Schema>;
    for (const k of Object.keys(value)) if (!(k in props)) return `${path}: unexpected property`;
    for (const r of (schema.required as string[] | undefined) ?? []) if (!(r in value)) return `${path}.${r}: missing`;
    for (const [k, v] of Object.entries(value)) {
      const p = validateOutput(v, props[k], `${path}.${k}`);
      if (p) return p;
    }
  }
  if (Array.isArray(value) && isObj(schema.items)) {
    for (let i = 0; i < value.length; i++) {
      const p = validateOutput(value[i], schema.items as Schema, `${path}[${i}]`);
      if (p) return p;
    }
  }
  return null;
}
