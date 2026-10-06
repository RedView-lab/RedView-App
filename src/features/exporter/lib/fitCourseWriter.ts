import { CrcCalculator, Profile, Utils } from '@garmin/fitsdk';

/**
 * FIT file writer for the course export: the same bytes as @garmin/fitsdk's
 * `Encoder` (checked byte for byte against it by fitCourseWriter.test.ts),
 * ~50× faster. The SDK rebuilds the definition of every message, scanning
 * the ~100 fields of the RECORD profile for each of its fields: 1 s for a
 * 50 000-point course, and an ultra counts twice as many. Here a definition is
 * built once per message shape and reused; the field profiles, enum values,
 * date conversion and CRC still come from the SDK.
 */

interface BaseType {
  /** Base type byte of the field definition (endian flag included). */
  id: number;
  size: number;
  mask?: number;
  set?: (view: DataView, offset: number, value: number) => void;
}

// FIT protocol base types (§ 4.2) used by the course messages. Enum fields
// are declared uint8, as the SDK's `FieldTypeToBaseType` does.
const BASE_TYPES: Record<string, BaseType> = {
  enum: { id: 0x02, size: 1, mask: 0xff, set: (v, o, x) => v.setUint8(o, x) },
  sint8: { id: 0x01, size: 1, mask: 0xff, set: (v, o, x) => v.setInt8(o, x) },
  uint8: { id: 0x02, size: 1, mask: 0xff, set: (v, o, x) => v.setUint8(o, x) },
  sint16: { id: 0x83, size: 2, mask: 0xffff, set: (v, o, x) => v.setInt16(o, x, true) },
  uint16: { id: 0x84, size: 2, mask: 0xffff, set: (v, o, x) => v.setUint16(o, x, true) },
  sint32: { id: 0x85, size: 4, mask: 0xffffffff, set: (v, o, x) => v.setInt32(o, x, true) },
  uint32: { id: 0x86, size: 4, mask: 0xffffffff, set: (v, o, x) => v.setUint32(o, x, true) },
  string: { id: 0x07, size: 1 },
  float32: { id: 0x88, size: 4, set: (v, o, x) => v.setFloat32(o, x, true) },
  float64: { id: 0x89, size: 8, set: (v, o, x) => v.setFloat64(o, x, true) },
  uint8z: { id: 0x0a, size: 1, mask: 0xff, set: (v, o, x) => v.setUint8(o, x) },
  uint16z: { id: 0x8b, size: 2, mask: 0xffff, set: (v, o, x) => v.setUint16(o, x, true) },
  uint32z: { id: 0x8c, size: 4, mask: 0xffffffff, set: (v, o, x) => v.setUint32(o, x, true) },
  byte: { id: 0x0d, size: 1, mask: 0xff, set: (v, o, x) => v.setUint8(o, x) },
};

const NUMERIC_TYPES = new Set(Object.keys(BASE_TYPES).filter((type) => type !== 'enum' && type !== 'string'));
const FLOAT_TYPES = new Set(['float32', 'float64']);
const HEADER_SIZE = 14;
const textEncoder = new TextEncoder();

interface FieldPlan {
  name: string;
  num: number;
  size: number;
  base: BaseType;
  /** Profile field type: numeric, `dateTime`, `string` or a FIT enum type. */
  type: string;
  scale: number;
  offset: number;
}

interface Definition {
  mesgNum: number;
  fields: FieldPlan[];
}

interface FieldProfile {
  num: number;
  name: string;
  type: string;
  baseType: string;
  scale: number | number[];
  offset: number | number[];
  components: unknown[];
}

const fieldsByName = new Map<number, Map<string, FieldProfile>>();
const enumValues = new Map<string, Map<string, number>>();

/** First profile field of that name, as the SDK's `Object.entries(...).find`. */
function fieldProfile(mesgNum: number, name: string): FieldProfile | undefined {
  let byName = fieldsByName.get(mesgNum);
  if (!byName) {
    byName = new Map();
    const fields = Profile.messages[mesgNum]?.fields as Record<string, FieldProfile> | undefined;
    if (!fields) throw new Error(`FIT message ${mesgNum} is not in the profile`);
    for (const field of Object.values(fields)) if (!byName.has(field.name)) byName.set(field.name, field);
    fieldsByName.set(mesgNum, byName);
  }
  return byName.get(name);
}

function enumValue(type: string, value: string): number {
  let values = enumValues.get(type);
  if (!values) {
    values = new Map();
    for (const [key, label] of Object.entries(Profile.types[type] ?? {})) {
      if (!values.has(label)) values.set(label, Number(key));
    }
    enumValues.set(type, values);
  }
  const resolved = values.get(value);
  if (resolved === undefined) throw new Error(`Could not convert "${value}" to "${type}"`);
  return resolved;
}

/** Field order, numbers, sizes and base types exactly as `MesgDefinition`. */
function buildDefinition(mesgNum: number, mesg: Record<string, unknown>): Definition {
  const fields: FieldPlan[] = [];
  for (const name of Object.keys(mesg)) {
    const value = mesg[name];
    if (value == null) continue;
    const profile = fieldProfile(mesgNum, name);
    if (!profile) continue;
    const base = BASE_TYPES[profile.baseType];
    if (!base) throw new Error(`Unsupported FIT base type ${profile.baseType}`);
    let scale = profile.components.length > 1 ? 1 : profile.scale;
    let offset = profile.components.length > 1 ? 0 : profile.offset;
    scale = Array.isArray(scale) ? scale[0]! : scale ?? 1;
    offset = Array.isArray(offset) ? offset[0]! : offset ?? 0;
    const size = profile.baseType === 'string' ? textEncoder.encode(String(value)).length + 1 : base.size;
    fields.push({ name, num: profile.num, size, base, type: profile.type, scale, offset });
  }
  if (fields.length === 0) throw new Error('No valid fields were found in the message');
  return { mesgNum, fields };
}

/** `MesgDefinition.equals`: same fields (number, size, base type), any order. */
function sameDefinition(a: Definition, b: Definition): boolean {
  if (a.mesgNum !== b.mesgNum || a.fields.length !== b.fields.length) return false;
  return a.fields.every((lhs) => b.fields.some((rhs) => lhs.num === rhs.num && lhs.size === rhs.size && lhs.base.id === rhs.base.id));
}

/** Value written for a field, as the SDK's `#transformValue`. */
function encodeValue(value: unknown, field: FieldPlan): number | string {
  if (NUMERIC_TYPES.has(field.type)) {
    const number = typeof value === 'string' ? Number(value) : (value as number);
    if (field.scale === 1 && field.offset === 0) return number;
    const scaled = (number + field.offset) * field.scale;
    return FLOAT_TYPES.has(field.type) ? scaled : Math.round(scaled);
  }
  if (field.type === 'dateTime') return value instanceof Date ? Utils.convertDateToDateTime(value) : (value as number);
  if (field.type === 'string') return String(value);
  return typeof value === 'number' ? value : enumValue(field.type, String(value));
}

export class FitCourseWriter {
  private bytes = new Uint8Array(1 << 16);
  private view = new DataView(this.bytes.buffer);
  private length = HEADER_SIZE;
  private readonly slots: Array<Definition | null> = Array(16).fill(null);
  private nextLocal = 0;
  private readonly shapes = new Map<string, Definition>();

  /** Appends one message (same contract as `Encoder.onMesg`). */
  write(mesgNum: number, mesg: Record<string, unknown>): this {
    const definition = this.definitionFor(mesgNum, mesg);
    let local = this.slots.findIndex((slot) => slot != null && sameDefinition(slot, definition));
    local = (local !== -1 ? local : this.nextLocal++) & 0x0f;
    const active = this.slots[local];
    if (active == null || !sameDefinition(active, definition)) {
      this.writeDefinition(definition, local);
      this.slots[local] = definition;
    }
    this.reserve(1);
    this.bytes[this.length++] = local;
    for (const field of definition.fields) {
      const value = encodeValue(mesg[field.name], field);
      if (typeof value === 'string') {
        const text = textEncoder.encode(value);
        this.reserve(text.length + 1);
        this.bytes.set(text, this.length);
        this.length += text.length;
        this.bytes[this.length++] = 0;
      } else {
        this.reserve(field.base.size);
        const { mask, set } = field.base;
        set!(this.view, this.length, mask == null ? value : value & mask);
        this.length += field.base.size;
      }
    }
    return this;
  }

  /** The complete file: header, messages, CRC. */
  close(): Uint8Array {
    const header = new DataView(this.bytes.buffer, 0, HEADER_SIZE);
    header.setUint8(0, HEADER_SIZE);
    header.setUint8(1, 2); // protocol version
    header.setUint16(2, Profile.version.major * 1000 + Profile.version.minor, true);
    header.setUint32(4, this.length - HEADER_SIZE, true);
    this.bytes.set([0x2e, 0x46, 0x49, 0x54], 8); // ".FIT"
    header.setUint16(12, CrcCalculator.calculateCRC(this.bytes, 0, 12), true);
    this.reserve(2);
    this.view.setUint16(this.length, CrcCalculator.calculateCRC(this.bytes, 0, this.length), true);
    this.length += 2;
    return this.bytes.slice(0, this.length);
  }

  private definitionFor(mesgNum: number, mesg: Record<string, unknown>): Definition {
    let shape = `${mesgNum}`;
    for (const name of Object.keys(mesg)) {
      const value = mesg[name];
      if (value == null) continue;
      shape += typeof value === 'string' ? `|${name}:${textEncoder.encode(value).length}` : `|${name}`;
    }
    let definition = this.shapes.get(shape);
    if (!definition) {
      definition = buildDefinition(mesgNum, mesg);
      this.shapes.set(shape, definition);
    }
    return definition;
  }

  private writeDefinition(definition: Definition, local: number): void {
    this.reserve(6 + definition.fields.length * 3);
    const at = this.length;
    this.bytes[at] = 0x40 | local; // definition message
    this.bytes[at + 1] = 0; // reserved
    this.bytes[at + 2] = 0; // little endian
    this.view.setUint16(at + 3, definition.mesgNum, true);
    this.bytes[at + 5] = definition.fields.length;
    let offset = at + 6;
    for (const field of definition.fields) {
      this.bytes[offset] = field.num;
      this.bytes[offset + 1] = field.size;
      this.bytes[offset + 2] = field.base.id;
      offset += 3;
    }
    this.length = offset;
  }

  private reserve(count: number): void {
    if (this.length + count <= this.bytes.length) return;
    const grown = new Uint8Array(Math.max(this.bytes.length * 2, this.length + count));
    grown.set(this.bytes.subarray(0, this.length));
    this.bytes = grown;
    this.view = new DataView(grown.buffer);
  }
}
