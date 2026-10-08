/**
 * Public entry point for the srecord library.
 *
 * Re-exports the parser, validator, and builder so consumers can import from a
 * single path. Keeping this file thin means the module graph is predictable.
 */
export { parseSRecord, validateChecksum, computeChecksum, buildSRecord } from "./core.js";
