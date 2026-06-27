create table if not exists markets (
  id text primary key,
  symbol text not null,
  start_time timestamptz not null,
  end_time timestamptz not null,
  status text not null check (status in ('open', 'closed', 'incomplete')),
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  unique (symbol, start_time)
);

create table if not exists price_samples (
  id bigserial not null,
  scheduled_at timestamptz not null,
  collected_at timestamptz not null default now(),
  source text not null,
  instrument_type text not null,
  symbol text not null,
  price_type text not null default 'last',
  price numeric(20, 8) not null,
  exchange_time timestamptz,
  latency_ms integer not null,
  sample_type text not null check (sample_type in ('normal', 'final_ramp', 'close')),
  created_at timestamptz not null default now(),
  primary key (id, scheduled_at)
);

create unique index if not exists price_samples_one_per_slot
  on price_samples (scheduled_at, source, symbol, sample_type);

create index if not exists price_samples_symbol_source_time_idx
  on price_samples (symbol, source, scheduled_at desc);

create index if not exists price_samples_time_idx
  on price_samples (scheduled_at desc);

create table if not exists market_labels (
  market_id text not null references markets(id) on delete cascade,
  source text not null,
  open_price numeric(20, 8) not null,
  close_price numeric(20, 8) not null,
  return_pct numeric(14, 8) not null,
  direction text not null check (direction in ('up', 'down', 'flat')),
  sample_count integer not null,
  quality text not null check (quality in ('complete', 'partial', 'missing')),
  created_at timestamptz not null default now(),
  primary key (market_id, source)
);

create index if not exists market_labels_source_created_idx
  on market_labels (source, created_at desc);

create table if not exists collector_heartbeats (
  collector_name text primary key,
  last_seen_at timestamptz not null,
  current_market_id text,
  status text not null check (status in ('running', 'paused', 'error', 'stopped')),
  message text,
  updated_at timestamptz not null default now()
);

create table if not exists collection_errors (
  id bigserial primary key,
  time timestamptz not null default now(),
  market_id text,
  source text,
  error_type text not null,
  message text not null,
  retry_count integer not null default 0
);

create index if not exists collection_errors_time_idx
  on collection_errors (time desc);
