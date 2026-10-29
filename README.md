# Z3-Engine

Lightweight, sovereign social engine built exclusively in Node.js (pure JavaScript, ES Modules, no TypeScript, no build steps) backed by PostgreSQL.

## Architecture

- **Protocol**: AT Protocol derivative (DIDs, TIDs, XRPC endpoints, Lexicons, JSON records, `at://` URIs).
- **Runtime**: Pure Node.js (ES Modules, `"type": "module"`).
- **Database**: PostgreSQL with strict connection pooling (`max: 10`, `idleTimeout: 30s`, `connTimeout: 2s`).
- **Zero Build Tools**: No Webpack, Babel, Vite, or TSC.
- **Frontend Compatibility**: Direct API bridge supporting `Z3-UI` (Mastodon / Soapbox REST contract) and native XRPC calls simultaneously.

## Directory Structure

```text
Z3-Engine/
├── config/
│   └── db.js                 # PostgreSQL connection pool with strict limits
├── lib/
│   ├── crypto.js             # Native Ed25519 keypair, sign/verify & scrypt
│   ├── syntax.js             # Crockford Base32 TID generator and at:// URI parser
│   └── lex/
│       ├── index.js          # Lexicon validation entrypoint
│       ├── store.js          # In-memory Lexicon registry & loader
│       └── validator.js      # Pure JS runtime schema validator & XRPCError
├── lexicons/                 # Standard JSON Lexicon schemas
│   ├── com/atproto/repo/     # putRecord, getRecord, listRecords, deleteRecord
│   ├── app/bsky/feed/        # post
│   └── org/z3social/         # group, circle, chat/message
├── middleware/
│   ├── auth.js               # Sovereign token verification & extraction
│   └── privacy.js            # Access control for private accounts, circles & DMs
├── routes/
│   ├── xrpc.js               # Wildcard XRPC dispatcher (ALL /xrpc/:nsid)
│   └── bridge.js             # Z3-UI frontend compatibility bridge
├── schemas/
│   └── init.sql              # Relational schema & performance indexes
├── scripts/
│   └── init-db.js            # Database migration and admin seeder
├── test/
│   └── core.test.js          # Native Node test runner test suite
└── server.js                 # Primary server entrypoint
```

## Getting Started

1. **Configure Environment**:
   ```sh
   cp .env.example .env
   ```

2. **Initialize Database**:
   ```sh
   npm run init-db
   ```

3. **Run Unit Tests**:
   ```sh
   npm test
   ```

4. **Start Engine**:
   ```sh
   npm start
   # or dev mode with native watcher
   npm run dev
   ```
