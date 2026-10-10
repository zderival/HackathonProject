// Flattens TypeBox/JSON schemas into editable-field descriptors. Used by the
// capabilities endpoint (so clients can generate property controls) and by the
// assistant prompt (so the model knows exact fields and bounds).

export interface FieldDescriptor {
  path: string;
  type: 'number' | 'integer' | 'string' | 'boolean' | 'color' | 'enum' | 'vec2' | 'vec3' | 'quat' | 'assetId' | 'nodeId' | 'object' | 'array';
  nullable?: boolean;
  min?: number;
  max?: number;
  maxLength?: number;
  enum?: (string | null)[];
  items?: { min?: number; max?: number }[];
  description?: string;
}

const isColor = (s: any) => s?.type === 'string' && s.pattern === '^#[0-9a-fA-F]{6}$';

function leaf(path: string, s: any): FieldDescriptor | null {
  let nullable = false;
  let schema = s;
  if (Array.isArray(s.anyOf)) {
    const nonNull = s.anyOf.filter((x: any) => x.type !== 'null');
    nullable = nonNull.length < s.anyOf.length;
    if (nonNull.every((x: any) => x.const !== undefined))
      return withDesc({ path, type: 'enum', enum: [...nonNull.map((x: any) => x.const), ...(nullable ? [null] : [])] }, s);
    schema = nonNull[0];
    if (nonNull.length !== 1) return withDesc({ path, type: 'object', nullable }, s);
  }
  const d: FieldDescriptor = { path, type: 'object' };
  if (nullable) d.nullable = true;
  if (isColor(schema)) d.type = 'color';
  else if (schema.type === 'string' && schema.format === 'uuid') d.type = 'assetId';
  else if (schema.type === 'string' && schema.pattern === '^[A-Za-z0-9_-]{1,64}$') d.type = 'nodeId';
  else if (schema.type === 'string') {
    d.type = 'string';
    if (schema.maxLength !== undefined) d.maxLength = schema.maxLength;
  } else if (schema.type === 'number' || schema.type === 'integer') {
    d.type = schema.type;
    if (schema.minimum !== undefined) d.min = schema.minimum;
    if (schema.maximum !== undefined) d.max = schema.maximum;
  } else if (schema.type === 'boolean') d.type = 'boolean';
  else if (schema.type === 'array' && Array.isArray(schema.items)) {
    d.type = schema.items.length === 4 ? 'quat' : schema.items.length === 3 ? 'vec3' : schema.items.length === 2 ? 'vec2' : 'array';
    d.items = schema.items.map((i: any) => ({ min: i.minimum, max: i.maximum }));
  } else if (schema.type === 'array') d.type = 'array';
  else return null;
  return withDesc(d, schema.description ? schema : s);
}

function withDesc(d: FieldDescriptor, s: any): FieldDescriptor {
  if (s?.description) d.description = s.description;
  return d;
}

export function describeFields(schema: any, prefix = ''): FieldDescriptor[] {
  const out: FieldDescriptor[] = [];
  for (const [key, sub] of Object.entries<any>(schema.properties ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (sub.type === 'object' && sub.properties) out.push(...describeFields(sub, path));
    else {
      const d = leaf(path, sub);
      if (d) out.push(d);
    }
  }
  return out;
}

// One-line text form for prompts, e.g. "props.width: number 1..200 (Interior size along X (m).)".
export function fieldLine(f: FieldDescriptor): string {
  let t: string = f.type;
  if (f.type === 'enum') t = `one of ${f.enum!.map((v) => JSON.stringify(v)).join('|')}`;
  else if (f.min !== undefined || f.max !== undefined) t += ` ${f.min ?? ''}..${f.max ?? ''}`;
  if (f.nullable && f.type !== 'enum') t += ' or null';
  if (f.maxLength) t += ` (max ${f.maxLength} chars)`;
  return `${f.path}: ${t}${f.description ? ` - ${f.description}` : ''}`;
}
