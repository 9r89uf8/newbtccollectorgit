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

create table if not exists futures_basis_samples (
  id bigserial not null,
  basis_time timestamptz not null,
  collected_at timestamptz not null default now(),
  source text not null,
  instrument_type text not null,
  symbol text not null,
  pair text not null,
  contract_type text not null,
  period text not null,
  index_price numeric(20, 8) not null,
  futures_price numeric(20, 8) not null,
  basis numeric(20, 8) not null,
  basis_rate numeric(20, 12) not null,
  basis_bps numeric(14, 8) not null,
  raw_timestamp_ms bigint not null,
  basis_latency_ms integer not null,
  created_at timestamptz not null default now(),
  primary key (id, basis_time)
);

create unique index if not exists futures_basis_samples_one_per_slot
  on futures_basis_samples (basis_time, source, pair, contract_type, period);

create index if not exists futures_basis_samples_pair_source_time_idx
  on futures_basis_samples (pair, source, contract_type, period, basis_time desc);

create index if not exists futures_basis_samples_time_idx
  on futures_basis_samples (basis_time desc);

create table if not exists polymarket_5m_btc_markets (
  source text not null default 'polymarket_gamma',
  market_id text not null references markets(id) on delete cascade,
  symbol text not null,
  slug text not null,
  polymarket_market_id text,
  condition_id text,
  start_time timestamptz not null,
  end_time timestamptz not null,
  gamma_start_date timestamptz,
  gamma_end_date timestamptz,
  up_token_id text,
  down_token_id text,
  price_to_beat numeric(20, 8),
  end_price numeric(20, 8),
  winning_outcome text check (winning_outcome in ('up', 'down', 'unknown') or winning_outcome is null),
  active boolean,
  closed boolean,
  accepting_orders boolean,
  automatically_resolved boolean,
  gamma_status text,
  discovered_at timestamptz not null default now(),
  last_metadata_refresh_at timestamptz,
  resolved_at timestamptz,
  raw_gamma jsonb,
  primary key (source, market_id),
  unique (source, slug),
  constraint polymarket_5m_btc_markets_window_check
    check (end_time = start_time + interval '5 minutes')
);

create index if not exists polymarket_5m_btc_markets_symbol_source_time_idx
  on polymarket_5m_btc_markets (symbol, source, start_time desc);

create index if not exists polymarket_5m_btc_markets_slug_idx
  on polymarket_5m_btc_markets (slug);

create index if not exists polymarket_5m_btc_markets_refresh_idx
  on polymarket_5m_btc_markets (end_time desc, last_metadata_refresh_at)
  where closed is distinct from true
     or end_price is null
     or winning_outcome is null
     or winning_outcome = 'unknown';

create table if not exists polymarket_probability_samples (
  source text not null default 'polymarket_clob_midpoints',
  market_id text not null references markets(id) on delete cascade,
  symbol text not null,
  slug text not null,
  scheduled_at timestamptz not null,
  collected_at timestamptz not null default now(),
  sample_type text not null check (sample_type in ('normal', 'final_ramp')),
  up_token_id text,
  down_token_id text,
  up_probability numeric(20, 12),
  down_probability numeric(20, 12),
  up_probability_normalized numeric(20, 12),
  down_probability_normalized numeric(20, 12),
  probability_sum numeric(20, 12),
  request_latency_ms integer,
  data_delay_ms integer,
  availability_status text check (availability_status in ('on_time', 'delayed_open', 'missing', 'metadata_missing', 'timeout')),
  quality text not null check (quality in ('complete', 'partial', 'missing')),
  raw_response jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (source, market_id, scheduled_at)
);

alter table polymarket_probability_samples
  alter column up_token_id drop not null,
  alter column down_token_id drop not null,
  add column if not exists data_delay_ms integer,
  add column if not exists availability_status text;

alter table polymarket_probability_samples
  drop constraint if exists polymarket_probability_samples_availability_status_check;

alter table polymarket_probability_samples
  add constraint polymarket_probability_samples_availability_status_check
    check (availability_status in ('on_time', 'delayed_open', 'missing', 'metadata_missing', 'timeout') or availability_status is null);

create index if not exists polymarket_probability_samples_symbol_source_time_idx
  on polymarket_probability_samples (symbol, source, scheduled_at desc);

create index if not exists polymarket_probability_samples_slug_time_idx
  on polymarket_probability_samples (slug, scheduled_at desc);

create index if not exists polymarket_probability_samples_market_idx
  on polymarket_probability_samples (market_id, scheduled_at);

create table if not exists chainlink_btc_price_samples (
  source text not null default 'polymarket_rtds_chainlink',
  instrument_type text not null default 'oracle',
  symbol text not null,
  market_id text not null references markets(id) on delete cascade,
  feed_id text not null,
  topic text not null default 'crypto_prices_chainlink',
  rtds_symbol text not null default 'btc/usd',
  scheduled_at timestamptz not null,
  collected_at timestamptz not null default now(),
  sample_type text not null check (sample_type in ('normal', 'final_ramp', 'close')),
  price numeric(20, 8),
  bid numeric(20, 8),
  ask numeric(20, 8),
  valid_from_timestamp timestamptz,
  observations_timestamp timestamptz,
  price_timestamp timestamptz,
  server_timestamp timestamptz,
  expires_at timestamptz,
  native_fee text,
  link_fee text,
  request_latency_ms integer,
  report_latency_ms integer,
  tick_age_ms integer,
  quality text not null default 'missing' check (quality in ('complete', 'partial', 'missing')),
  decode_status text not null default 'missing' check (decode_status in ('decoded', 'raw_only', 'missing')),
  raw_response jsonb,
  full_report text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (source, market_id, scheduled_at)
);

alter table chainlink_btc_price_samples
  alter column source set default 'polymarket_rtds_chainlink';

alter table chainlink_btc_price_samples
  add column if not exists topic text not null default 'crypto_prices_chainlink',
  add column if not exists rtds_symbol text not null default 'btc/usd',
  add column if not exists price_timestamp timestamptz,
  add column if not exists server_timestamp timestamptz,
  add column if not exists tick_age_ms integer;

create index if not exists chainlink_btc_price_samples_symbol_source_time_idx
  on chainlink_btc_price_samples (symbol, source, scheduled_at desc);

create index if not exists chainlink_btc_price_samples_market_idx
  on chainlink_btc_price_samples (market_id, scheduled_at);

create table if not exists futures_ws_1s_summaries (
  source text not null,
  instrument_type text not null,
  symbol text not null,
  bucket_start timestamptz not null,
  bucket_end timestamptz not null,
  first_event_time timestamptz,
  last_event_time timestamptz,
  event_count integer not null default 0,
  book_ticker_update_count integer not null default 0,
  bid_price_move_count integer not null default 0,
  ask_price_move_count integer not null default 0,
  mid_price_move_count integer not null default 0,
  best_bid_price_open numeric(20, 8),
  best_bid_price_close numeric(20, 8),
  best_bid_price_min numeric(20, 8),
  best_bid_price_max numeric(20, 8),
  best_bid_qty_open numeric(30, 12),
  best_bid_qty_close numeric(30, 12),
  best_bid_qty_min numeric(30, 12),
  best_bid_qty_max numeric(30, 12),
  best_ask_price_open numeric(20, 8),
  best_ask_price_close numeric(20, 8),
  best_ask_price_min numeric(20, 8),
  best_ask_price_max numeric(20, 8),
  best_ask_qty_open numeric(30, 12),
  best_ask_qty_close numeric(30, 12),
  best_ask_qty_min numeric(30, 12),
  best_ask_qty_max numeric(30, 12),
  mid_price_open numeric(20, 8),
  mid_price_close numeric(20, 8),
  mid_price_low numeric(20, 8),
  mid_price_high numeric(20, 8),
  mid_return_bps numeric(14, 8),
  spread_bps_open numeric(14, 8),
  spread_bps_close numeric(14, 8),
  spread_bps_avg numeric(14, 8),
  spread_bps_max numeric(14, 8),
  microprice_open numeric(20, 8),
  microprice_close numeric(20, 8),
  microprice_bps_from_mid_close numeric(14, 8),
  liquidation_count integer not null default 0,
  liquidation_buy_quote numeric(30, 8) not null default 0,
  liquidation_sell_quote numeric(30, 8) not null default 0,
  liquidation_net_quote numeric(30, 8) not null default 0,
  liquidation_max_quote numeric(30, 8),
  avg_event_lag_ms numeric(14, 3),
  max_event_lag_ms integer,
  summary_quality text not null check (summary_quality in ('complete', 'partial', 'missing')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (source, symbol, bucket_start)
);

create index if not exists futures_ws_1s_summaries_symbol_source_time_idx
  on futures_ws_1s_summaries (symbol, source, bucket_start desc);

create table if not exists market_forward_labels (
  market_id text not null references markets(id) on delete cascade,
  source text not null,
  symbol text not null,
  bucket_start timestamptz not null,
  horizon_seconds integer not null check (horizon_seconds > 0),
  price_now numeric(20, 8),
  future_price numeric(20, 8),
  forward_return_bps numeric(14, 8),
  future_max_up_bps numeric(14, 8),
  future_max_down_bps numeric(14, 8),
  threshold_bps numeric(14, 8) not null,
  hit_up_threshold boolean not null default false,
  hit_down_threshold boolean not null default false,
  hit_up_before_down boolean,
  direction_label text not null check (direction_label in ('up', 'down', 'flat', 'unknown')),
  path_sample_count integer not null default 0,
  quality text not null check (quality in ('complete', 'partial', 'missing')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (source, symbol, bucket_start, horizon_seconds)
);

create index if not exists market_forward_labels_market_idx
  on market_forward_labels (market_id, horizon_seconds, bucket_start);

create index if not exists market_forward_labels_symbol_source_time_idx
  on market_forward_labels (symbol, source, bucket_start desc);

create index if not exists market_forward_labels_direction_idx
  on market_forward_labels (horizon_seconds, direction_label, bucket_start desc);

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

create or replace view market_price_references as
select
  m.id as market_id,
  m.symbol,
  m.start_time,
  m.end_time,
  m.status,
  spot.open_price as binance_spot_open_price,
  spot.close_price as binance_spot_close_price,
  spot.return_pct as binance_spot_return_pct,
  spot.direction as binance_spot_direction,
  spot.quality as binance_spot_quality,
  futures.open_price as binance_futures_open_price,
  futures.close_price as binance_futures_close_price,
  futures.return_pct as binance_futures_return_pct,
  futures.direction as binance_futures_direction,
  futures.quality as binance_futures_quality,
  pm.price_to_beat as polymarket_open_price,
  pm.end_price as polymarket_close_price,
  case
    when pm.price_to_beat is not null and pm.end_price is not null and pm.price_to_beat > 0
      then ((pm.end_price - pm.price_to_beat) / pm.price_to_beat) * 100
    else null
  end as polymarket_return_pct,
  case
    when pm.winning_outcome in ('up', 'down') then pm.winning_outcome
    when pm.price_to_beat is not null and pm.end_price is not null and pm.end_price >= pm.price_to_beat then 'up'
    when pm.price_to_beat is not null and pm.end_price is not null and pm.end_price < pm.price_to_beat then 'down'
    else null
  end as polymarket_direction,
  pm.winning_outcome as polymarket_winning_outcome,
  pm.closed as polymarket_closed,
  pm.gamma_status as polymarket_gamma_status,
  pm.slug as polymarket_slug,
  pm.last_metadata_refresh_at as polymarket_last_metadata_refresh_at,
  pm.resolved_at as polymarket_resolved_at
from markets m
left join market_labels spot
  on spot.market_id = m.id
 and spot.source = 'binance_spot'
left join market_labels futures
  on futures.market_id = m.id
 and futures.source = 'binance_futures'
left join polymarket_5m_btc_markets pm
  on pm.market_id = m.id
 and pm.source = 'polymarket_gamma';

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
  basis_sample_count integer not null default 0,
  basis_time timestamptz,
  basis_index_price numeric(20, 8),
  basis_futures_price numeric(20, 8),
  basis numeric(20, 8),
  basis_rate numeric(20, 12),
  basis_bps numeric(14, 8),
  basis_bps_previous numeric(14, 8),
  basis_bps_change numeric(14, 8),
  basis_quality text not null default 'missing' check (basis_quality in ('complete', 'missing')),
  position_quality text not null check (position_quality in ('complete', 'partial', 'missing')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (market_id, source)
);

alter table if exists market_position_features
  add column if not exists basis_sample_count integer not null default 0,
  add column if not exists basis_time timestamptz,
  add column if not exists basis_index_price numeric(20, 8),
  add column if not exists basis_futures_price numeric(20, 8),
  add column if not exists basis numeric(20, 8),
  add column if not exists basis_rate numeric(20, 12),
  add column if not exists basis_bps numeric(14, 8),
  add column if not exists basis_bps_previous numeric(14, 8),
  add column if not exists basis_bps_change numeric(14, 8),
  add column if not exists basis_quality text not null default 'missing' check (basis_quality in ('complete', 'missing'));

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

create table if not exists market_cvd_buckets (
  market_id text not null references markets(id) on delete cascade,
  source text not null,
  symbol text not null,
  bucket_start timestamptz not null,
  bucket_end timestamptz not null,
  bucket_seconds numeric(14, 3) not null,
  open_price numeric(20, 8),
  close_price numeric(20, 8),
  return_pct numeric(14, 8),
  return_bps numeric(14, 8),
  taker_buy_quote numeric(30, 8) not null default 0,
  taker_sell_quote numeric(30, 8) not null default 0,
  delta_quote numeric(30, 8) not null default 0,
  cvd_market_quote numeric(30, 8) not null default 0,
  cvd_continuous_quote numeric(30, 8) not null default 0,
  cvd_change_5b numeric(30, 8),
  price_change_5b_bps numeric(14, 8),
  cvd_direction text,
  price_direction text,
  cvd_price_behavior text,
  cvd_divergence_5b text,
  bucket_quality text not null check (bucket_quality in ('complete', 'partial', 'missing')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (market_id, source, bucket_start)
);

create index if not exists market_cvd_buckets_source_time_idx
  on market_cvd_buckets (source, bucket_start desc);

create index if not exists market_cvd_buckets_symbol_source_time_idx
  on market_cvd_buckets (symbol, source, bucket_start desc);

create table if not exists market_trade_flow_1s (
  market_id text not null references markets(id) on delete cascade,
  source text not null,
  symbol text not null,
  bucket_start timestamptz not null,
  bucket_end timestamptz not null,
  bucket_seconds numeric(14, 3) not null default 1,
  mid_price numeric(20, 8),
  taker_buy_quote numeric(30, 8) not null default 0,
  taker_sell_quote numeric(30, 8) not null default 0,
  net_taker_quote numeric(30, 8) not null default 0,
  gross_taker_quote numeric(30, 8) not null default 0,
  taker_imbalance numeric(14, 8),
  cvd_market_quote numeric(30, 8) not null default 0,
  cvd_continuous_quote numeric(30, 8) not null default 0,
  cvd_change_5s numeric(30, 8),
  cvd_change_10s numeric(30, 8),
  cvd_change_30s numeric(30, 8),
  price_change_5s_bps numeric(14, 8),
  price_change_10s_bps numeric(14, 8),
  price_change_30s_bps numeric(14, 8),
  rolling_net_5s numeric(30, 8) not null default 0,
  rolling_net_10s numeric(30, 8) not null default 0,
  rolling_net_30s numeric(30, 8) not null default 0,
  rolling_gross_5s numeric(30, 8) not null default 0,
  rolling_gross_10s numeric(30, 8) not null default 0,
  rolling_gross_30s numeric(30, 8) not null default 0,
  rolling_imbalance_5s numeric(14, 8),
  rolling_imbalance_10s numeric(14, 8),
  rolling_imbalance_30s numeric(14, 8),
  large_buy_quote numeric(30, 8) not null default 0,
  large_sell_quote numeric(30, 8) not null default 0,
  large_trade_count integer not null default 0,
  large_trade_threshold numeric(20, 8) not null,
  max_trade_quote numeric(30, 8),
  trade_count integer not null default 0,
  bucket_quality text not null check (bucket_quality in ('complete', 'partial', 'missing')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (market_id, source, bucket_start)
);

create index if not exists market_trade_flow_1s_source_time_idx
  on market_trade_flow_1s (source, bucket_start desc);

create index if not exists market_trade_flow_1s_symbol_source_time_idx
  on market_trade_flow_1s (symbol, source, bucket_start desc);

create table if not exists market_microprice_buckets (
  market_id text not null references markets(id) on delete cascade,
  source text not null,
  symbol text not null,
  bucket_start timestamptz not null,
  bucket_end timestamptz not null,
  bucket_seconds numeric(14, 3) not null default 1,
  source_summary_quality text,
  book_ticker_update_count integer not null default 0,
  seconds_since_book_update numeric(14, 3),
  best_bid_price numeric(20, 8),
  best_bid_qty numeric(30, 12),
  best_ask_price numeric(20, 8),
  best_ask_qty numeric(30, 12),
  mid_price numeric(20, 8),
  spread_bps_close numeric(14, 8),
  spread_bps_avg numeric(14, 8),
  spread_bps_max numeric(14, 8),
  microprice numeric(20, 8),
  microprice_bps_from_mid numeric(14, 8),
  microprice_lean numeric(14, 8),
  microprice_delta numeric(14, 8) not null default 0,
  lean_delta_1s numeric(14, 8),
  ewma_lean_3s numeric(14, 8),
  avg_lean_5s numeric(14, 8),
  microprice_pressure_market numeric(30, 8) not null default 0,
  microprice_pressure_continuous numeric(30, 8) not null default 0,
  avg_lean_10s numeric(14, 8),
  avg_lean_30s numeric(14, 8),
  up_lean_share_10s numeric(14, 8),
  down_lean_share_10s numeric(14, 8),
  up_lean_share_30s numeric(14, 8),
  down_lean_share_30s numeric(14, 8),
  valid_sample_count_10s integer not null default 0,
  valid_sample_count_30s integer not null default 0,
  spread_stable_10s boolean,
  spread_stable_30s boolean,
  mid_change_10s_bps numeric(14, 8),
  mid_change_30s_bps numeric(14, 8),
  price_stalled_10s boolean,
  price_stalled_30s boolean,
  lean_direction text,
  persistence_signal text,
  flip_signal text,
  microprice_behavior text,
  bucket_quality text not null check (bucket_quality in ('complete', 'partial', 'missing', 'stale')),
  feature_version text not null default 'microprice_v2',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (market_id, source, bucket_start)
);

alter table if exists market_microprice_buckets
  add column if not exists lean_delta_1s numeric(14, 8),
  add column if not exists ewma_lean_3s numeric(14, 8),
  add column if not exists avg_lean_5s numeric(14, 8),
  add column if not exists feature_version text not null default 'microprice_v2',
  alter column feature_version set default 'microprice_v2';

create index if not exists market_microprice_buckets_source_time_idx
  on market_microprice_buckets (source, bucket_start desc);

create index if not exists market_microprice_buckets_symbol_source_time_idx
  on market_microprice_buckets (symbol, source, bucket_start desc);

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
