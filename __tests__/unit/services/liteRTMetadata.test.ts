import { installNativeBoundary } from '../../harness/nativeBoundary';
import { liteRTModelFile } from '../../utils/liteRTModelFile';

describe('LiteRT file context metadata', () => {
  async function read(bytes: Buffer) {
    const boundary = installNativeBoundary({ fs: true });
    await boundary.fs!.module.writeFile('/models/test.litertlm', bytes.toString('base64'), 'base64');
    const { readLiteRTMaxTokens } = require('../../../src/services/liteRTMetadata');
    return readLiteRTMaxTokens('/models/test.litertlm');
  }

  it('reads the model limit without loading an engine and skips unrelated protobuf fields', async () => {
    expect(await read(liteRTModelFile([10, 2, 1, 2, 40, 128, 64]))).toBe(8192);
  });

  it.each([
    [10, 2, 1, 2], // No max_num_tokens, as in the curated Gemma 4 file.
    [40, 0],
    [40, 128], // Truncated varint.
    [40, 128, 64, 10, 99], // Valid limit followed by damaged metadata.
    [15], // Unsupported wire type.
  ])('does not invent a limit for missing or damaged metadata: %j', async (...proto) => {
    expect(await read(liteRTModelFile(proto))).toBeNull();
  });

  it('rejects unsupported containers and oversized metadata', async () => {
    const version = liteRTModelFile([40, 128, 64]);
    version.writeUInt32LE(2, 8);
    expect(await read(version)).toBeNull();
    const hugeHeader = liteRTModelFile([40, 128, 64]);
    hugeHeader.writeUInt32LE(0x7fffffff, 24);
    expect(await read(hugeHeader)).toBeNull();
    const hugeProto = liteRTModelFile([40, 128, 64]);
    hugeProto.writeUInt32LE(0x7fffffff, 32 + 80);
    expect(await read(hugeProto)).toBeNull();
  });

  it('returns unknown for truncated files and invalid table offsets', async () => {
    expect(await read(liteRTModelFile([40, 128, 64]).subarray(0, 20))).toBeNull();
    const badTable = liteRTModelFile([40, 128, 64]);
    badTable.writeUInt32LE(0x7fffffff, 32);
    expect(await read(badTable)).toBeNull();
  });
});
