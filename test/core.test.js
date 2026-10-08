import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseSRecord,
  validateChecksum,
  computeChecksum,
  buildSRecord,
} from "../src/index.js";

/** Returns a hex byte as two uppercase chars. */
const hex = (n) => n.toString(16).padStart(2, "0").toUpperCase();

/**
 * Builds a record line and then corrupts only the checksum field, so we can
 * test that the validator catches a bad checksum without re-testing parse logic.
 */
function withBadChecksum(type, address, data) {
  const good = buildSRecord(type, address, data);
  // Flip the last hex pair's first nibble; guarantees a different value while
  // staying valid hex.
  const last = good.slice(-2);
  const flipped = hex((parseInt(last, 16) ^ 0xff) & 0xff);
  return good.slice(0, -2) + flipped;
}

test("parseSRecord: S0 with empty data", () => {
  // A real S0 header record from a typical toolchain.
  const rec = parseSRecord("S0030002FC");
  assert.equal(rec.type, "S0");
  assert.equal(rec.byteCount, 3);
  assert.equal(rec.address, 0x0002);
  assert.equal(rec.addressWidth, 2);
  assert.equal(rec.data.length, 0);
  assert.equal(rec.checksum, 0xfc);
});

test("parseSRecord: S1 with data bytes", () => {
  const rec = parseSRecord("S1130000285F245F2212226A004244BF0948033752");
  assert.equal(rec.type, "S1");
  assert.equal(rec.byteCount, 0x13);
  assert.equal(rec.address, 0x0000);
  assert.equal(rec.addressWidth, 2);
  assert.equal(rec.data.length, 0x10);
  assert.equal(rec.data[0], 0x28);
  assert.equal(rec.data[15], 0x37);
});

test("parseSRecord: S3 uses a 4-byte address", () => {
  const data = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
  const line = buildSRecord("S3", 0xdeadbeef, data);
  const rec = parseSRecord(line);
  assert.equal(rec.type, "S3");
  assert.equal(rec.addressWidth, 4);
  assert.equal(rec.address, 0xdeadbeef);
  assert.equal(rec.data.length, 4);
});

test("parseSRecord: S2 uses a 3-byte address", () => {
  const data = new Uint8Array([0xaa]);
  const line = buildSRecord("S2", 0x123456, data);
  const rec = parseSRecord(line);
  assert.equal(rec.addressWidth, 3);
  assert.equal(rec.address, 0x123456);
});

test("parseSRecord: strips trailing CR and surrounding whitespace", () => {
  // CRLF files are the common real-world case; a naive split leaves a CR.
  const rec = parseSRecord("  S1130000285F245F2212226A004244BF0948033752\r\n");
  assert.equal(rec.type, "S1");
  assert.equal(rec.data.length, 0x10);
});

test("parseSRecord: rejects non-S prefix", () => {
  assert.throws(
    () => parseSRecord("X0030002FC"),
    /must start with 'S'/,
  );
});

test("parseSRecord: rejects odd hex length", () => {
  assert.throws(
    () => parseSRecord("S113000"),
    /odd number of hex digits|too short/,
  );
});

test("parseSRecord: rejects non-hex payload", () => {
  assert.throws(
    () => parseSRecord("S1ZZ0000285F245F2212226A004244BF0948037"),
    /non-hex/, 
  );
});

test("parseSRecord: rejects byte count mismatch", () => {
  // Byte count says 0x13 (19 bytes follow) but we provide fewer.
  assert.throws(
    () => parseSRecord("S1130028"),
    /byte count/,
  );
});

test("validateChecksum: true for a built record", () => {
  const data = new Uint8Array([0x01, 0x02, 0x03]);
  const line = buildSRecord("S1", 0x1000, data);
  assert.equal(validateChecksum(parseSRecord(line)), true);
});

test("validateChecksum: false for a corrupted checksum", () => {
  const data = new Uint8Array([0x01, 0x02, 0x03]);
  const bad = withBadChecksum("S1", 0x1000, data);
  assert.equal(validateChecksum(parseSRecord(bad)), false);
});

test("computeChecksum: matches Motorola spec example", () => {
  // From a well-known reference: S1137AF00A0A0D0D5657545754534E4920534157
  // computed checksum byte is 0xB3. We re-derive the checksum from the
  // byte-count + address + data to confirm the formula.
  const line = "S1137AF00A0A0D0D5657545754534E4920534157B3";
  const rec = parseSRecord(line);
  const got = computeChecksum(rec.byteCount, rec.address, rec.addressWidth, rec.data);
  assert.equal(got, rec.checksum);
});

test("buildSRecord: round-trips through parseSRecord", () => {
  const data = new Uint8Array(Array.from({ length: 16 }, (_, i) => i));
  const line = buildSRecord("S1", 0x4000, data);
  const rec = parseSRecord(line);
  assert.equal(rec.type, "S1");
  assert.equal(rec.address, 0x4000);
  assert.equal(rec.data.length, 16);
  assert.deepEqual(Array.from(rec.data), Array.from(data));
  assert.equal(validateChecksum(rec), true);
});

test("buildSRecord: rejects address that does not fit the type's width", () => {
  // S1 has a 2-byte address; 0x10000 does not fit.
  assert.throws(
    () => buildSRecord("S1", 0x10000, new Uint8Array()),
    /does not fit in 2 bytes/,
  );
});

test("buildSRecord: rejects records longer than 255 payload bytes", () => {
  const big = new Uint8Array(251); // 1 + 2 + 251 + 1 = 255 ok, push past
  // 252 data bytes => total 255+1 = 256, byte count exceeds 255.
  // We use 253 to be safely over.
  const tooBig = new Uint8Array(253);
  assert.throws(
    () => buildSRecord("S1", 0, tooBig),
    /record too long/,
  );
});

test("parseSRecord: returns a Uint8Array for data, not a plain array", () => {
  const rec = parseSRecord("S1130000285F245F2212226A004244BF0948033752");
  assert.ok(rec.data instanceof Uint8Array);
});
