CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE TABLE IF NOT EXISTS products (sku TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS locations (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), code TEXT UNIQUE NOT NULL, capacity INTEGER NOT NULL CHECK (capacity > 0), sku TEXT REFERENCES products(sku));
CREATE TABLE IF NOT EXISTS boxes (box_id TEXT PRIMARY KEY, sku TEXT NOT NULL REFERENCES products(sku), quantity INTEGER NOT NULL CHECK (quantity > 0), received_at TIMESTAMPTZ, status TEXT NOT NULL DEFAULT 'pending');
CREATE TABLE IF NOT EXISTS receipts (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), box_id TEXT NOT NULL REFERENCES boxes(box_id), location_id UUID REFERENCES locations(id), quantity INTEGER NOT NULL, scanned_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(box_id));
CREATE TABLE IF NOT EXISTS exceptions (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), box_id TEXT REFERENCES boxes(box_id), reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', resolved_at TIMESTAMPTZ);
CREATE INDEX IF NOT EXISTS receipts_scanned_at_idx ON receipts(scanned_at);
