-- Z3-Engine Sovereign Schema
-- PostgreSQL initialization script for Z3 Social sovereign engine

CREATE TABLE IF NOT EXISTS accounts (
    did VARCHAR(255) PRIMARY KEY, -- e.g. did:z3:ivanalbrieu or did:z3:<tid>
    handle VARCHAR(100) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    public_key TEXT,
    is_private BOOLEAN DEFAULT FALSE, -- Tracker #6: Private Accounts
    display_name VARCHAR(150),
    avatar_url TEXT,
    banner_url TEXT,
    bio TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ DEFAULT NULL -- Tracker #9: Disable & Delete Accounts
);

CREATE INDEX IF NOT EXISTS idx_accounts_handle ON accounts(handle);
CREATE INDEX IF NOT EXISTS idx_accounts_email ON accounts(email);
CREATE INDEX IF NOT EXISTS idx_accounts_deleted ON accounts(deleted_at);

-- Core sovereign record store (AT-Protocol sovereign derivative)
-- Holds posts, profiles, follows, reposts, likes, and custom records
CREATE TABLE IF NOT EXISTS records (
    id BIGSERIAL PRIMARY KEY,
    did VARCHAR(255) NOT NULL REFERENCES accounts(did) ON DELETE CASCADE,
    collection VARCHAR(255) NOT NULL, -- e.g. app.bsky.feed.post, org.z3social.group, etc.
    rkey VARCHAR(512) NOT NULL,       -- Record key (TID / slug)
    data JSONB NOT NULL,              -- Full Lexicon-validated record payload
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_records_did_collection_rkey UNIQUE (did, collection, rkey)
);

CREATE INDEX IF NOT EXISTS idx_records_did_collection ON records(did, collection);
CREATE INDEX IF NOT EXISTS idx_records_collection ON records(collection);
CREATE INDEX IF NOT EXISTS idx_records_created ON records(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_records_rkey ON records(rkey);
CREATE INDEX IF NOT EXISTS idx_records_data_gin ON records USING gin(data);

-- Circles and Circle Members (Tracker #10: Private Follower Circles / Nexpods)
CREATE TABLE IF NOT EXISTS circles (
    id VARCHAR(100) PRIMARY KEY, -- e.g. circle:<did>:<rkey>
    owner_did VARCHAR(255) NOT NULL REFERENCES accounts(did) ON DELETE CASCADE,
    name VARCHAR(150) NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_circles_owner ON circles(owner_did);

CREATE TABLE IF NOT EXISTS circle_members (
    circle_id VARCHAR(100) NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
    member_did VARCHAR(255) NOT NULL REFERENCES accounts(did) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (circle_id, member_did)
);

CREATE INDEX IF NOT EXISTS idx_circle_members_member ON circle_members(member_did);

-- 6. Social Graph & Relationships (Follows, Blocks, Mutes)
CREATE TABLE IF NOT EXISTS relationships (
    id BIGSERIAL PRIMARY KEY,
    source_did VARCHAR(255) NOT NULL REFERENCES accounts(did) ON DELETE CASCADE,
    target_did VARCHAR(255) NOT NULL REFERENCES accounts(did) ON DELETE CASCADE,
    relationship_type VARCHAR(32) NOT NULL, -- 'follow', 'block', 'mute'
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_relationships UNIQUE (source_did, target_did, relationship_type)
);

CREATE INDEX IF NOT EXISTS idx_relationships_source ON relationships(source_did, relationship_type);
CREATE INDEX IF NOT EXISTS idx_relationships_target ON relationships(target_did, relationship_type);

-- 5. Direct Messages (Tracker #15: Sovereign Direct Messages)
CREATE TABLE IF NOT EXISTS direct_messages (
    id BIGSERIAL PRIMARY KEY,
    sender_did VARCHAR(255) NOT NULL REFERENCES accounts(did) ON DELETE CASCADE,
    recipient_did VARCHAR(255) NOT NULL REFERENCES accounts(did) ON DELETE CASCADE,
    ciphertext TEXT NOT NULL,
    media_url TEXT,
    read_at TIMESTAMPTZ DEFAULT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dm_lookup ON direct_messages(sender_did, recipient_did, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dm_recipient ON direct_messages(recipient_did, read_at);


