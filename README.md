# srecord

A small, zero-dependency TypeScript-free ESM library for parsing, validating, and rebuilding Motorola S-record (S19/S28/S37) lines.

## Install / use

No registry package is published; copy `src/` into your project. Then:

```js
import { parseSRecord, validateChecksum, buildSRecord } from "./src/index.js";

const rec = parseSRecord("S1130000285F245F2212226A004244BF0948033752");
console.log(rec.type, rec.address.toString(16), rec.data.length);
console.log(validateChecksum(rec));

const fresh = buildSRecord("S1", 0x1000, new Uint8Array([1, 2, 3]));
console.log(fresh);
```

## Exports

- `parseSRecord(line: string)` — returns `{ type, byteCount, address, data, checksum, addressWidth, raw }`. Throws `SyntaxError` on malformed input.
- `validateChecksum(rec)` — returns `boolean`.
- `computeChecksum(byteCount, address, addressWidth, data)` — returns the single checksum byte.
- `buildSRecord(type, address, data)` — returns a canonical record string with a computed checksum.

## Why

Firmware toolchains occasionally emit records with a bad checksum, and tooling that round-trips records (e.g. address remapping for bootloaders) needs to recompute them. This library does one thing: parse a line, check its checksum, and rebuild a line. It deliberately does not parse multi-record files, resolve address ranges, or guess record semantics — those concerns belong to a layer above.

## Edge cases you will hit

- **Address width is fixed by type, not inferred from the byte count.** `S0`/`S1`/`S9` use 2 bytes, `S2`/`S8` use 3, `S3`/`S7` use 4. A record whose byte count implies a different width will fail validation, not silently shift the data window.
- **CRLF input is tolerated.** Trailing `\r` and surrounding whitespace are stripped; this is the single most common reason a naive parser rejects a real `.s19` file.
- **4-byte addresses are returned unsigned.** A 32-bit address with the high bit set would otherwise show up as negative in JavaScript's bitwise arithmetic.

## Design decision

The S-record format does not mandate whether `S0` carries a 2-byte address or none at all; in practice almost every toolchain uses 2 bytes with the value `0000`. This library treats `S0` as a 2-byte-address type. If your files use a different `S0` layout, they will not parse here.
