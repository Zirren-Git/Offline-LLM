import { Buffer } from 'buffer';

/** A v1 LiteRT-LM container with a real FlatBuffer header and LlmMetadata protobuf. */
export function liteRTModelFile(proto: number[]): Buffer {
  const bytes = Buffer.alloc(16384 + proto.length);
  bytes.write('LITERTLM');
  bytes.writeUInt32LE(1, 8);
  bytes.writeUInt32LE(128, 24);
  const h = bytes.subarray(32, 128);
  h.writeUInt32LE(16, 0); // root table
  [8, 8, 0, 4].forEach((v, i) => h.writeUInt16LE(v, 8 + i * 2));
  h.writeInt32LE(8, 16);
  h.writeUInt32LE(12, 20); // section metadata table at 32
  [6, 8, 4].forEach((v, i) => h.writeUInt16LE(v, 24 + i * 2));
  h.writeInt32LE(8, 32);
  h.writeUInt32LE(4, 36); // vector at 40
  h.writeUInt32LE(1, 40);
  h.writeUInt32LE(20, 44); // section table at 64
  [12, 24, 0, 8, 16, 4].forEach((v, i) => h.writeUInt16LE(v, 48 + i * 2));
  h.writeInt32LE(16, 64);
  h.writeUInt8(5, 68); // LlmMetadataProto
  h.writeUInt32LE(16384, 72);
  h.writeUInt32LE(bytes.length, 80);
  Buffer.from(proto).copy(bytes, 16384);
  return bytes;
}
