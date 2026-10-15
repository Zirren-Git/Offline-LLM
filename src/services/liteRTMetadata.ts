import { Buffer } from 'buffer';
import RNFS from 'react-native-fs';

// LiteRT-LM v1 container and LlmMetadata field 5, without starting an engine.
// https://github.com/google-ai-edge/LiteRT-LM/tree/v0.17.1/schema/core
// Only metadata is read. Never allocate from an unchecked file offset/length.
const MAX_METADATA_BYTES = 1024 * 1024;

function uint64(bytes: Buffer, offset: number): number {
  const value = bytes.readUInt32LE(offset) + bytes.readUInt32LE(offset + 4) * 0x100000000;
  if (!Number.isSafeInteger(value)) throw new Error('Invalid metadata offset');
  return value;
}

function field(bytes: Buffer, table: number, index: number): number | null {
  const vtable = table - bytes.readInt32LE(table);
  const entry = 4 + index * 2;
  if (entry >= bytes.readUInt16LE(vtable)) return null;
  const offset = bytes.readUInt16LE(vtable + entry);
  return offset ? table + offset : null;
}

function reference(bytes: Buffer, offset: number | null): number {
  if (offset === null) throw new Error('Missing metadata table');
  const target = offset + bytes.readUInt32LE(offset);
  if (target <= offset || target >= bytes.length) throw new Error('Invalid metadata table');
  return target;
}

function protoMaxTokens(bytes: Buffer): number | null {
  let position = 0;
  const varint = (): number => {
    let value = 0;
    for (let i = 0; i < 10; i++) {
      if (position >= bytes.length) throw new Error('Truncated metadata');
      const byte = bytes[position++];
      value += (byte % 128) * 2 ** (7 * i);
      if (byte < 128) return value;
    }
    throw new Error('Invalid metadata varint');
  };
  let maxTokens: number | null = null;
  while (position < bytes.length) {
    const tag = varint();
    if (!Number.isSafeInteger(tag) || tag < 8) throw new Error('Invalid metadata tag');
    switch (tag % 8) {
      case 0: {
        const value = varint();
        if (tag === 40) maxTokens = Number.isSafeInteger(value) && value > 0 && value <= 0x7fffffff ? value : null;
        break;
      }
      case 1: position += 8; break;
      case 2: {
        const length = varint();
        if (!Number.isSafeInteger(length)) throw new Error('Invalid metadata length');
        position += length;
        break;
      }
      case 5: position += 4; break;
      default: throw new Error('Unsupported metadata wire type');
    }
    if (position > bytes.length) throw new Error('Truncated metadata field');
  }
  return maxTokens;
}

/** Unknown, unsupported and damaged files return null, never a guessed model limit. */
export async function readLiteRTMaxTokens(path: string): Promise<number | null> {
  try {
    const read = async (length: number, offset: number): Promise<Buffer> => {
      if (length <= 0 || length > MAX_METADATA_BYTES) throw new Error('Invalid metadata size');
      const bytes = Buffer.from(await RNFS.read(path, length, offset, 'base64'), 'base64');
      if (bytes.length !== length) throw new Error('Truncated model metadata');
      return bytes;
    };
    const prefix = await read(32, 0);
    if (prefix.toString('ascii', 0, 8) !== 'LITERTLM' || prefix.readUInt32LE(8) !== 1) return null;
    const headerEnd = uint64(prefix, 24);
    const header = await read(headerEnd - 32, 32);
    const root = reference(header, 0);
    const sections = reference(header, field(header, root, 1));
    const objects = reference(header, field(header, sections, 0));
    const count = header.readUInt32LE(objects);
    if (count > (header.length - objects - 4) / 4) return null;
    for (let i = 0; i < count; i++) {
      const section = reference(header, objects + 4 + i * 4);
      const type = field(header, section, 3);
      if (type === null || header.readUInt8(type) !== 5) continue;
      const beginField = field(header, section, 1);
      const endField = field(header, section, 2);
      if (beginField === null || endField === null) return null;
      const begin = uint64(header, beginField);
      const end = uint64(header, endField);
      if (begin < headerEnd) return null;
      return protoMaxTokens(await read(end - begin, begin));
    }
    return null;
  } catch {
    return null;
  }
}
