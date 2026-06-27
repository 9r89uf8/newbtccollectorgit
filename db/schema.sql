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

create table if not exists agg_trades (
  source text not null,
  instrument_type text not null,
  symbol text not null,
  agg_trade_id bigint not null,
  event_time timestamptz,
  trade_time timestamptz not null,
  price numeric(20, 8) not null,
  quantity numeric(30, 12) not null,
  quote_notional numeric(30, 8) not null,
  buyer_is_maker boolean not null,
  taker_side text not null check (taker_side in ('buy', 'sell')),
  first_trade_id bigint,
  last_trade_id bigint,
  collected_at timestamptz not null default now(),
  primary key (source, symbol, agg_trade_id)
);

create index if not exists agg_trades_symbol_source_time_idx
  on agg_trades (symbol, source, trade_time desc);

create index if not exists agg_trades_trade_time_idx
  on agg_trades (trade_time desc);

create table if not exists book_samples (
  id bigserial not null,
  scheduled_at timestamptz not null,
  collected_at timestamptz not null default now(),
  source text not null,
  instrument_type text not null,
  symbol text not null,
  sample_type text not null check (sample_type in ('normal', 'final_ramp', 'close')),
  last_update_id bigint,
  exchange_time timestamptz,
  best_bid_price numeric(20, 8) not null,
  best_bid_qty numeric(30, 12) not null,
  best_ask_price numeric(20, 8) not null,
  best_ask_qty numeric(30, 12) not null,
  mid_price numeric(20, 8) not null,
  spread_bps numeric(14, 8) not null,
  bid_depth_5bps numeric(30, 8),
  ask_depth_5bps numeric(30, 8),
  book_imbalance_5bps numeric(14, 8),
  bid_depth_10bps numeric(30, 8),
  ask_depth_10bps numeric(30, 8),
  book_imbalance_10bps numeric(14, 8),
  bid_depth_25bps numeric(30, 8),
  ask_depth_25bps numeric(30, 8),
  book_imbalance_25bps numeric(14, 8),
  latency_ms integer not null,
  created_at timestamptz not null default now(),
  primary key (id, scheduled_at)
);

create unique index if not exists book_samples_one_per_slot
  on book_samples (scheduled_at, source, symbol);

create index if not exists book_samples_symbol_source_time_idx
  on book_samples (symbol, source, scheduled_at desc);

create index if not exists book_samples_time_idx
  on book_samples (scheduled_at desc);

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

create table if not exists market_features (
  market_id text not null references markets(id) on delete cascade,
  source text not null,
  symbol text not null,
  total_volume_quote numeric(30, 8) not null default 0,
  taker_buy_quote numeric(30, 8) not null default 0,
  taker_sell_quote numeric(30, 8) not null default 0,
  net_taker_quote numeric(30, 8) not null default 0,
  taker_imbalance numeric(14, 8),
  agg_trade_count integer not null default 0,
  large_trade_count integer not null default 0,
  large_trade_threshold numeric(20, 8) not null,
  max_trade_quote numeric(30, 8),
  book_sample_count integer not null default 0,
  avg_spread_bps numeric(14, 8),
  max_spread_bps numeric(14, 8),
  avg_book_imbalance_5bps numeric(14, 8),
  min_book_imbalance_5bps numeric(14, 8),
  max_book_imbalance_5bps numeric(14, 8),
  avg_bid_depth_5bps numeric(30, 8),
  avg_ask_depth_5bps numeric(30, 8),
  min_bid_depth_5bps numeric(30, 8),
  min_ask_depth_5bps numeric(30, 8),
  avg_ask_bid_depth_ratio numeric(20, 8),
  feature_quality text not null check (feature_quality in ('complete', 'partial', 'missing')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (market_id, source)
);

create index if not exists market_features_source_updated_idx
  on market_features (source, updated_at desc);

create index if not exists market_features_symbol_source_idx
  on market_features (symbol, source);

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
