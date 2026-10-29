import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultStore, LexiconStore } from './store.js';
import { validateObject, XRPCError } from './validator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Pre-load default lexicons directory
const defaultLexiconsPath = path.resolve(__dirname, '../../lexicons');
defaultStore.loadFromDirectory(defaultLexiconsPath);

/**
 * Validates a record payload against a registered record Lexicon
 * @param {string} collectionNsid - e.g. 'app.bsky.feed.post'
 * @param {object} recordData - The record object
 * @param {LexiconStore} [store=defaultStore]
 */
export function assertValidRecord(collectionNsid, recordData, store = defaultStore) {
  const schemaDoc = store.get(collectionNsid);
  if (!schemaDoc) {
    // If schema is not known, AT-Proto allows unrecognized records or logs advisory
    return true;
  }

  const def = schemaDoc.defs?.main;
  if (!def) {
    throw XRPCError.invalidRequest(`Lexicon ${collectionNsid} is missing 'main' definition.`);
  }

  if (def.type !== 'record') {
    throw XRPCError.invalidRequest(`Lexicon ${collectionNsid} is not of type 'record'.`);
  }

  const recordSchema = def.record;
  if (!recordSchema) {
    throw XRPCError.invalidRequest(`Lexicon ${collectionNsid} has no record schema definition.`);
  }

  validateObject(recordData, recordSchema, collectionNsid);
  return true;
}

/**
 * Validates XRPC query parameters or procedure input
 * @param {string} nsid - Procedure or Query NSID
 * @param {object} inputData - Data payload
 * @param {'query'|'procedure'} [type='procedure']
 * @param {LexiconStore} [store=defaultStore]
 */
export function assertValidInput(nsid, inputData, type = 'procedure', store = defaultStore) {
  const schemaDoc = store.get(nsid);
  if (!schemaDoc) return true;

  const def = schemaDoc.defs?.main;
  if (!def) return true;

  const schema = def.input?.schema || (def.parameters?.properties ? def.parameters : null);
  if (schema) {
    validateObject(inputData, schema, nsid);
  }
  return true;
}

export {
  LexiconStore,
  defaultStore,
  XRPCError,
  validateObject,
};

export default {
  LexiconStore,
  defaultStore,
  assertValidRecord,
  assertValidInput,
  XRPCError,
};
