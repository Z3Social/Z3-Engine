import { XRPCError } from './validator.js';

/**
 * Calculates UTF-8 byte length of a string
 * @param {string} str
 * @returns {number}
 */
export function utf8ByteLength(str) {
  return Buffer.byteLength(str, 'utf8');
}

/**
 * Calculates grapheme length using Intl.Segmenter (if supported) or code point count
 * @param {string} str
 * @returns {number}
 */
export function graphemeLength(str) {
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    let count = 0;
    for (const _ of segmenter.segment(str)) {
      count++;
    }
    return count;
  }
  return Array.from(str).length;
}

/**
 * Formats supported by AT Protocol Lexicon specs:
 * 'datetime', 'uri', 'at-uri', 'did', 'handle', 'nsid', 'cid', 'tid', 'record-key', 'at-identifier', 'language'
 */
const FORMAT_REGEXES = {
  datetime: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/,
  did: /^did:[a-z0-9]+:[a-zA-Z0-9._:%-]*[a-zA-Z0-9._-]$/,
  handle: /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/,
  nsid: /^[a-zA-Z]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/,
  'at-uri': /^at:\/\/[a-zA-Z0-9._:%-]+\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/,
  'at-identifier': /^(did:[a-z0-9]+:[a-zA-Z0-9._:%-]*[a-zA-Z0-9._-]+|([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)$/,
  tid: /^[234567abcdefghijklmnopqrstuvwxyz]{13}$/,
  'record-key': /^[a-zA-Z0-9._~-]{1,512}$/,
  language: /^[a-z]{2,3}(-[A-Z]{2})?$/,
};

/**
 * Validates a string according to @atproto/lex-schema rules
 * @param {string} val
 * @param {object} schema
 * @param {string} path
 */
export function validateStringFormat(val, schema, path) {
  if (typeof val !== 'string') {
    throw XRPCError.invalidRequest(`${path} must be a string.`);
  }

  // UTF-8 byte length
  const bytes = utf8ByteLength(val);
  if (typeof schema.maxLength === 'number' && bytes > schema.maxLength) {
    throw XRPCError.invalidRequest(`${path} exceeds maximum UTF-8 byte length of ${schema.maxLength} (got ${bytes}).`);
  }
  if (typeof schema.minLength === 'number' && bytes < schema.minLength) {
    throw XRPCError.invalidRequest(`${path} is shorter than minimum UTF-8 byte length of ${schema.minLength}.`);
  }

  // Graphemes
  if (typeof schema.maxGraphemes === 'number' || typeof schema.minGraphemes === 'number') {
    const graphemes = graphemeLength(val);
    if (typeof schema.maxGraphemes === 'number' && graphemes > schema.maxGraphemes) {
      throw XRPCError.invalidRequest(`${path} exceeds maximum graphemes of ${schema.maxGraphemes} (got ${graphemes}).`);
    }
    if (typeof schema.minGraphemes === 'number' && graphemes < schema.minGraphemes) {
      throw XRPCError.invalidRequest(`${path} has fewer than minimum graphemes of ${schema.minGraphemes}.`);
    }
  }

  // Format regex check
  if (schema.format && FORMAT_REGEXES[schema.format]) {
    if (!FORMAT_REGEXES[schema.format].test(val)) {
      throw XRPCError.invalidRequest(`${path} does not match expected format "${schema.format}".`);
    }
  }

  // Const check
  if (schema.const !== undefined && val !== schema.const) {
    throw XRPCError.invalidRequest(`${path} must be exactly "${schema.const}".`);
  }
}

export default {
  utf8ByteLength,
  graphemeLength,
  validateStringFormat,
};
