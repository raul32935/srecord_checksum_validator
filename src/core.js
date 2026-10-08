/**
 * SRecord core: parsing and checksum logic for Motorola S-record format.
 *
 * S-record lines look like:
 *   S0030002FC   (type S0, byte count 03, address 0002, no data, checksum FC)
 *   S1130000285F245F2212226A004244BF0948037   ... (S1, 16-byte data payload)
 *
 * The checksum is the one's complement (low byte) of the sum of the byte-count,
 * address, and data bytes — everything between the type field and the checksum
 * itself. We compute it byte-wise so the input need only be valid hex.
 *
 * Address widths are fixed by type: S1/S9 = 2 bytes, S2/S8 = 3 bytes, S3/S7 = 4
 * bytes. S0 uses 2 bytes by convention (the address is usually 0000). We follow
 * that convention rather than guessing.
 */

/**
 * Maps an S-record type character to its fixed address-field width in bytes.
 * Motorola's spec fixes these widths; we do not infer them from the byte count,
 * because a malformed byte count would otherwise silently shift the data window.
 *
 * @param {string} typeChar - The single-character type suffix ("0".."9").
 * @returns {number} Address width in bytes.
 */
function addressWidthForType(typeChar) {
  if (typeChar === "1" || typeChar === "9" || typeChar === "0") return 2;
  if (typeChar === "2" || typeChar === "8") return 3;
  if (typeChar === "3" || typeChar === "7") return 4;
  return 2;
}

/**
 * Throws a SyntaxError with a message that includes the line and a reason.
 * Centralised so error strings are consistent across the parser.
 *
 * @param {string} line - The offending record.
 * @param {string} reason - Why it failed.
 * @returns {never}
 */
function fail(line, reason) {
  throw new SyntaxError(`Invalid S-record: ${reason} (line: ${line})`);
}

const HEX = /^[0-9A-Fa-f]+$/;

/**
 * Parses a single S-record line into its constituent fields.
 *
 * The line may be surrounded by whitespace and a trailing CR (file written on a
 * CRLF system). We strip those before parsing because real-world .s19 files are
 * often CRLF and a naive split on '\n' leaves a dangling '\r'.
 *
 * @param {string} line - One S-record.
 * @returns {{
 *   type: string,
 *   byteCount: number,
 *   address: number,
 *   data: Uint8Array,
 *   checksum: number,
 *   addressWidth: number,
 *   raw: string
 * }}
 */
export function parseSRecord(line) {
  if (typeof line !== "string") {
    throw new TypeError("parseSRecord expects a string");
  }
  const trimmed = line.replace(/\s+$/g, "").replace(/^\s+/g, "");
  if (trimmed.length === 0) fail(line, "empty line");
  if (trimmed[0] !== "S") fail(line, "must start with 'S'");
  if (trimmed.length < 4) fail(line, "too short for type + byte count");

  const typeChar = trimmed[1];
  if (!/^[0-9]$/.test(typeChar)) fail(line, `unknown type 'S${typeChar}'`);
  const type = `S${typeChar}`;

  const rest = trimmed.slice(2);
  if (!HEX.test(rest)) fail(line, "non-hex characters after type");

  // Every pair of hex chars is one byte. The total byte count of the payload
  // (byte count + address + data + checksum) is stated in the first byte.
  // If the stated byte count disagrees with the actual hex length, the record
  // is internally inconsistent and we refuse to guess which is right.
  if (rest.length % 2 !== 0) fail(line, "odd number of hex digits");

  const bytes = new Uint8Array(rest.length / 2);
  for (let i = 0; i < rest.length; i += 2) {
    bytes[i / 2] = parseInt(rest.slice(i, i + 2), 16);
  }

  const byteCount = bytes[0];
  if (byteCount !== bytes.length - 1) {
    fail(line, `byte count ${byteCount} does not match payload ${bytes.length - 1}`);
  }

  const addressWidth = addressWidthForType(typeChar);
  if (bytes.length < 1 + addressWidth + 1) {
    fail(line, `too short for ${addressWidth}-byte address`);
  }

  let address = 0;
  for (let i = 0; i < addressWidth; i++) {
    address = (address << 8) | bytes[1 + i];
  }
  // Force unsigned — the left shifts above can produce a negative 32-bit int
  // for a 4-byte address with the high bit set.
  address >>>= 0;

  const checksum = bytes[bytes.length - 1];
  const data = bytes.slice(1 + addressWidth, bytes.length - 1);

  return { type, byteCount, address, data, checksum, addressWidth, raw: trimmed };
}

/**
 * Computes the expected S-record checksum for the given fields.
 *
 * The checksum is the one's complement of the 8-bit sum of the byte-count,
 * address, and data bytes, masked to a single byte. We sum into a JS number;
 * numbers are 64-bit floats and can hold any byte sum exactly, so there is no
 * overflow concern at JavaScript's scale.
 *
 * @param {number} byteCount - The stated byte count (the first payload byte).
 * @param {number} address - The address as an integer.
 * @param {number} addressWidth - Address width in bytes (2, 3, or 4).
 * @param {Uint8Array} data - The data bytes.
 * @returns {number} The single-byte checksum.
 */
export function computeChecksum(byteCount, address, addressWidth, data) {
  let sum = byteCount;
  for (let i = addressWidth - 1; i >= 0; i--) {
    sum += (address >>> (i * 8)) & 0xff;
  }
  for (let i = 0; i < data.length; i++) {
    sum += data[i];
  }
  return (~sum) & 0xff;
}

/**
 * Returns true if the checksum field of the given parsed record matches the
 * recomputed value.
 *
 * @param {ReturnType<typeof parseSRecord>} rec
 * @returns {boolean}
 */
export function validateChecksum(rec) {
  const expected = computeChecksum(
    rec.byteCount,
    rec.address,
    rec.addressWidth,
    rec.data,
  );
  return expected === rec.checksum;
}

/**
 * Builds a canonical S-record line from parts, computing the checksum itself.
 *
 * Useful when synthesising records or when "fixing" a record whose checksum is
 * wrong. The byte count is derived from the address and data lengths, so the
 * caller cannot lie about it.
 *
 * @param {string} type - "S0".."S9".
 * @param {number} address
 * @param {Uint8Array} data
 * @returns {string}
 */
export function buildSRecord(type, address, data) {
  if (!/^S[0-9]$/.test(type)) {
    throw new TypeError(`type must be S0..S9, got ${type}`);
  }
  const addressWidth = addressWidthForType(type[1]);
  if (!Number.isInteger(address) || address < 0 || address > 2 ** (8 * addressWidth) - 1) {
    throw new RangeError(
      `address ${address} does not fit in ${addressWidth} bytes`,
    );
  }
  const byteCount = addressWidth + data.length + 1;
  if (byteCount > 255) {
    throw new RangeError(`record too long: byte count ${byteCount} > 255`);
  }
  const hex = (n) => n.toString(16).padStart(2, "0").toUpperCase();
  let out = type + hex(byteCount);
  for (let i = addressWidth - 1; i >= 0; i--) {
    out += hex((address >>> (i * 8)) & 0xff);
  }
  for (let i = 0; i < data.length; i++) {
    out += hex(data[i]);
  }
  const sum = computeChecksum(byteCount, address, addressWidth, data);
  out += hex(sum);
  return out;
}
