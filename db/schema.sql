CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS roles (
  name TEXT PRIMARY KEY CHECK (name IN ('admin','manager','worker'))
);
INSERT INTO roles(name) VALUES ('admin'),('manager'),('worker') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL REFERENCES roles(name),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS users_role_idx ON users(role);
CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS products (sku TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS locations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code TEXT UNIQUE NOT NULL,
  capacity INTEGER NOT NULL CHECK (capacity > 0),
  sku TEXT REFERENCES products(sku)
);
CREATE TABLE IF NOT EXISTS routing_rules (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sku TEXT NOT NULL REFERENCES products(sku),
  priority INTEGER NOT NULL DEFAULT 1,
  location_code TEXT NOT NULL REFERENCES locations(code),
  capacity INTEGER NOT NULL CHECK (capacity > 0),
  active BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (sku, priority),
  UNIQUE (location_code)
);
CREATE TABLE IF NOT EXISTS boxes (
  box_id TEXT PRIMARY KEY,
  sku TEXT NOT NULL REFERENCES products(sku),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  received_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','received','cancelled'))
);
CREATE TABLE IF NOT EXISTS exceptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  box_id TEXT REFERENCES boxes(box_id),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
ALTER TABLE exceptions ADD COLUMN IF NOT EXISTS warehouse_date DATE;
ALTER TABLE exceptions ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE exceptions ADD COLUMN IF NOT EXISTS device_id TEXT;

-- Permanent physical slots. This is deliberately not configurable: DockFlow has
-- exactly 50 numbered sorting locations for every warehouse.
CREATE TABLE IF NOT EXISTS sorting_locations (
  location_number INTEGER PRIMARY KEY CHECK (location_number BETWEEN 1 AND 50),
  capacity INTEGER NOT NULL DEFAULT 100 CHECK (capacity > 0)
);
INSERT INTO sorting_locations(location_number)
SELECT n FROM generate_series(1,50) AS n
ON CONFLICT (location_number) DO NOTHING;
CREATE UNIQUE INDEX IF NOT EXISTS sorting_locations_exactly_fifty_idx
  ON sorting_locations(location_number);

CREATE TABLE IF NOT EXISTS daily_cycles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  warehouse_date DATE NOT NULL,
  cycle_number INTEGER NOT NULL DEFAULT 1 CHECK (cycle_number > 0),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_by TEXT NOT NULL DEFAULT 'system',
  start_mode TEXT NOT NULL DEFAULT 'auto' CHECK (start_mode IN ('auto','manual')),
  closed_at TIMESTAMPTZ,
  UNIQUE (warehouse_date, cycle_number)
);
ALTER TABLE daily_cycles ADD COLUMN IF NOT EXISTS started_by TEXT NOT NULL DEFAULT 'system';
ALTER TABLE daily_cycles ADD COLUMN IF NOT EXISTS start_mode TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE daily_cycles DROP CONSTRAINT IF EXISTS daily_cycles_start_mode_check;
ALTER TABLE daily_cycles ADD CONSTRAINT daily_cycles_start_mode_check CHECK (start_mode IN ('auto','manual'));
CREATE UNIQUE INDEX IF NOT EXISTS one_open_daily_cycle_idx
  ON daily_cycles(warehouse_date) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS daily_assignments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  cycle_id UUID NOT NULL REFERENCES daily_cycles(id),
  warehouse_date DATE NOT NULL,
  sku TEXT NOT NULL REFERENCES products(sku),
  location_number INTEGER NOT NULL REFERENCES sorting_locations(location_number),
  capacity INTEGER NOT NULL CHECK (capacity > 0),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  assigned_by TEXT NOT NULL DEFAULT 'system',
  UNIQUE (cycle_id, location_number)
);
CREATE INDEX IF NOT EXISTS daily_assignments_date_idx
  ON daily_assignments(warehouse_date, location_number);

CREATE TABLE IF NOT EXISTS scan_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  box_id TEXT NOT NULL REFERENCES boxes(box_id),
  sku TEXT NOT NULL REFERENCES products(sku),
  qty INTEGER NOT NULL CHECK(qty > 0),
  destination TEXT,
  location_number INTEGER REFERENCES sorting_locations(location_number),
  warehouse_date DATE,
  cycle_id UUID REFERENCES daily_cycles(id),
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  inbound_id TEXT,
  client_id TEXT,
  box_sequence INTEGER,
  scanned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(box_id)
);
CREATE INDEX IF NOT EXISTS scan_events_time_idx ON scan_events(scanned_at DESC);
CREATE INDEX IF NOT EXISTS scan_events_search_idx ON scan_events(box_id,sku);
CREATE INDEX IF NOT EXISTS scan_events_archive_date_idx
  ON scan_events(warehouse_date, scanned_at DESC);
CREATE INDEX IF NOT EXISTS scan_events_archive_inbound_idx
  ON scan_events(inbound_id);
CREATE INDEX IF NOT EXISTS exceptions_archive_date_idx
  ON exceptions(warehouse_date, created_at DESC);

-- Idempotent migration for databases created by the earlier fixed-location build.
ALTER TABLE scan_events ADD COLUMN IF NOT EXISTS location_number INTEGER;
ALTER TABLE scan_events ADD COLUMN IF NOT EXISTS warehouse_date DATE;
ALTER TABLE scan_events ADD COLUMN IF NOT EXISTS cycle_id UUID;
ALTER TABLE scan_events ALTER COLUMN destination DROP NOT NULL;
ALTER TABLE daily_assignments DROP CONSTRAINT IF EXISTS daily_assignments_cycle_id_sku_key;
CREATE INDEX IF NOT EXISTS scan_events_location_idx ON scan_events(warehouse_date, location_number);
