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

create table if not exists derivative_position_samples (
  id bigserial not null,
  scheduled_at timestamptz not null,
  collected_at timestamptz not null default now(),
  source text not null,
  instrument_type text not null,
  symbol text not null,
  sample_type text not null check (sample_type in ('normal', 'final_ramp', 'close')),
  mark_price numeric(20, 8) not null,
  index_price numeric(20, 8) not null,
  premium_bps numeric(14, 8) not null,
  funding_rate numeric(20, 12),
  interest_rate numeric(20, 12),
  next_funding_time timestamptz,
  open_interest_base numeric(30, 12) not null,
  open_interest_quote numeric(30, 8) not null,
  mark_exchange_time timestamptz,
  open_interest_exchange_time timestamptz,
  mark_latency_ms integer not null,
  open_interest_latency_ms integer not null,
  created_at timestamptz not null default now(),
  primary key (id, scheduled_at)
);

create unique index if not exists derivative_position_samples_one_per_slot
  on derivative_position_samples (scheduled_at, source, symbol);

create index if not exists derivative_position_samples_symbol_source_time_idx
  on derivative_position_samples (symbol, source, scheduled_at desc);

create index if not exists derivative_position_samples_time_idx
  on derivative_position_samples (scheduled_at desc);

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

create table if not exists market_position_features (
  market_id text not null references markets(id) on delete cascade,
  source text not null,
  symbol text not null,
  sample_count integer not null default 0,
  mark_price_start numeric(20, 8),
  mark_price_end numeric(20, 8),
  index_price_start numeric(20, 8),
  index_price_end numeric(20, 8),
  premium_bps_start numeric(14, 8),
  premium_bps_end numeric(14, 8),
  premium_bps_min numeric(14, 8),
  premium_bps_max numeric(14, 8),
  premium_bps_avg numeric(14, 8),
  premium_bps_change numeric(14, 8),
  funding_rate numeric(20, 12),
  minutes_to_funding numeric(14, 4),
  open_interest_base_start numeric(30, 12),
  open_interest_base_end numeric(30, 12),
  open_interest_base_min numeric(30, 12),
  open_interest_base_max numeric(30, 12),
  open_interest_quote_start numeric(30, 8),
  open_interest_quote_end numeric(30, 8),
  open_interest_quote_min numeric(30, 8),
  open_interest_quote_max numeric(30, 8),
  open_interest_change_base numeric(30, 12),
  open_interest_change_quote numeric(30, 8),
  open_interest_change_pct numeric(14, 8),
  position_quality text not null check (position_quality in ('complete', 'partial', 'missing')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (market_id, source)
);

create index if not exists market_position_features_source_updated_idx
  on market_position_features (source, updated_at desc);

create index if not exists market_position_features_symbol_source_idx
  on market_position_features (symbol, source);

create table if not exists market_behavior_labels (
  market_id text not null references markets(id) on delete cascade,
  source text not null,
  symbol text not null,
  high_price numeric(20, 8),
  high_time timestamptz,
  low_price numeric(20, 8),
  low_time timestamptz,
  range_bps numeric(14, 8),
  close_location numeric(14, 8),
  max_up_bps_from_open numeric(14, 8),
  max_down_bps_from_open numeric(14, 8),
  realized_vol_bps numeric(14, 8),
  trade_vwap numeric(20, 8),
  vwap_deviation_bps numeric(14, 8),
  largest_1s_return_bps numeric(14, 8),
  largest_5s_return_bps numeric(14, 8),
  price_reversal_count integer not null default 0,
  magnitude_class text not null check (magnitude_class in ('tiny', 'small', 'medium', 'large', 'extreme', 'unknown')),
  shape_class text not null check (shape_class in ('trend', 'range', 'spike_fade', 'reversal', 'unknown')),
  close_location_class text not null check (close_location_class in ('near_low', 'middle', 'near_high', 'unknown')),
  volatility_class text not null check (volatility_class in ('quiet', 'normal', 'volatile', 'shock', 'unknown')),
  label_quality text not null check (label_quality in ('complete', 'partial', 'missing')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (market_id, source)
);

create index if not exists market_behavior_labels_source_updated_idx
  on market_behavior_labels (source, updated_at desc);

create index if not exists market_behavior_labels_symbol_source_idx
  on market_behavior_labels (symbol, source);

create table if not exists market_feature_buckets (
  market_id text not null references markets(id) on delete cascade,
  source text not null,
  symbol text not null,
  bucket_start timestamptz not null,
  bucket_end timestamptz not null,
  bucket_seconds numeric(14, 3) not null,
  open_price numeric(20, 8),
  close_price numeric(20, 8),
  return_pct numeric(14, 8),
  direction text check (direction in ('up', 'down', 'flat')),
  total_volume_quote numeric(30, 8) not null default 0,
  taker_buy_quote numeric(30, 8) not null default 0,
  taker_sell_quote numeric(30, 8) not null default 0,
  net_taker_quote numeric(30, 8) not null default 0,
  taker_imbalance numeric(14, 8),
  agg_trade_count integer not null default 0,
  large_trade_count integer not null default 0,
  large_trade_threshold numeric(20, 8) not null,
  max_trade_quote numeric(30, 8),
  best_bid_price numeric(20, 8),
  best_ask_price numeric(20, 8),
  mid_price numeric(20, 8),
  spread_bps numeric(14, 8),
  bid_depth_5bps numeric(30, 8),
  ask_depth_5bps numeric(30, 8),
  book_imbalance_5bps numeric(14, 8),
  bid_depth_10bps numeric(30, 8),
  ask_depth_10bps numeric(30, 8),
  book_imbalance_10bps numeric(14, 8),
  bid_depth_25bps numeric(30, 8),
  ask_depth_25bps numeric(30, 8),
  book_imbalance_25bps numeric(14, 8),
  bucket_quality text not null check (bucket_quality in ('complete', 'partial', 'missing')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (market_id, source, bucket_start)
);

create index if not exists market_feature_buckets_source_time_idx
  on market_feature_buckets (source, bucket_start desc);

create index if not exists market_feature_buckets_symbol_source_time_idx
  on market_feature_buckets (symbol, source, bucket_start desc);

create table if not exists market_classifications (
  market_id text not null references markets(id) on delete cascade,
  source text not null,
  symbol text not null,
  primary_class text not null,
  secondary_tags text[] not null default array[]::text[],
  confidence numeric(6, 4) not null,
  feature_version text not null,
  reasons jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (market_id, source)
);

create index if not exists market_classifications_source_updated_idx
  on market_classifications (source, updated_at desc);

create index if not exists market_classifications_primary_class_idx
  on market_classifications (primary_class, updated_at desc);

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
