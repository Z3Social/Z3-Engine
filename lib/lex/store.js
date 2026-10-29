import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class LexiconStore {
  constructor() {
    /** @type {Map<string, object>} */
    this.schemas = new Map();
  }

  /**
   * Registers a Lexicon schema document
   * @param {object} doc - Lexicon document
   */
  register(doc) {
    if (!doc || !doc.id) {
      throw new Error('Lexicon document must have an "id" property');
    }
    this.schemas.set(doc.id, doc);
  }

  /**
   * Gets a schema document by NSID
   * @param {string} nsid
   * @returns {object|undefined}
   */
  get(nsid) {
    return this.schemas.get(nsid);
  }

  /**
   * Checks if schema exists
   * @param {string} nsid
   * @returns {boolean}
   */
  has(nsid) {
    return this.schemas.has(nsid);
  }

  /**
   * Loads all JSON files recursively from a directory
   * @param {string} dirPath
   */
  loadFromDirectory(dirPath) {
    if (!fs.existsSync(dirPath)) return;

    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        this.loadFromDirectory(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        try {
          const raw = fs.readFileSync(fullPath, 'utf8');
          const doc = JSON.parse(raw);
          if (doc.id) {
            this.register(doc);
          }
        } catch (err) {
          console.warn(`[LexiconStore] Failed to load schema ${fullPath}:`, err.message);
        }
      }
    }
  }
}

export const defaultStore = new LexiconStore();
