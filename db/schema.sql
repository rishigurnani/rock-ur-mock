-- ============================================================================
-- Sleeperg schema — persistence for the four generalized primitives.
-- The live DraftEngine (src/engine) is the source of truth mid-draft; these
-- tables persist setup and results. JSONB is used only where the shape is
-- genuinely open-ended (tags, brains, modifier params).
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- gen_random_uuid()

CREATE TABLE users (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email      TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---- Base Data Swapper -----------------------------------------------------
CREATE TABLE datasets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    UUID REFERENCES users(id),      -- NULL => system dataset
  name        TEXT NOT NULL,
  season_year INT,
  is_system   BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE players (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id  UUID NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  full_name   TEXT NOT NULL,
  position    TEXT NOT NULL,                  -- promoted out of tags: filtered on
  team        TEXT,
  adp         NUMERIC(6,2),
  proj_points NUMERIC(7,2),
  tags        JSONB NOT NULL DEFAULT '[]',    -- ["QB","Rookie","College"]
  stats       JSONB NOT NULL DEFAULT '{}',
  UNIQUE (dataset_id, full_name, team)
);
CREATE INDEX idx_players_dataset_adp ON players (dataset_id, adp);
CREATE INDEX idx_players_tags_gin    ON players USING GIN (tags jsonb_path_ops);

-- ---- Drafts + Universal Modifier Engine ------------------------------------
CREATE TABLE drafts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      UUID NOT NULL REFERENCES users(id),
  dataset_id    UUID NOT NULL REFERENCES datasets(id),
  team_count    INT  NOT NULL,
  round_count   INT  NOT NULL,
  matrix_preset TEXT NOT NULL DEFAULT 'snake',
  roster_slots  JSONB NOT NULL,               -- {"QB":1,"RB":2,...,"BENCH":6}
  seed          BIGINT NOT NULL DEFAULT 42,   -- reproducible bot RNG
  human_slot    INT,                          -- NULL => full sim
  status        TEXT NOT NULL DEFAULT 'lobby',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE modifiers (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id  UUID NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  match_tag TEXT NOT NULL,                    -- "TE","QB","Rookie"  (If [Tag])
  action    TEXT NOT NULL CHECK (action IN ('score_mult','roster_max','adp_boost')),
  params    JSONB NOT NULL,                   -- {"factor":1.5}|{"limit":2}|{"pct":0.2}
  priority  INT NOT NULL DEFAULT 0,
  enabled   BOOLEAN NOT NULL DEFAULT true
);

-- Per-draft "what-if" overrides without mutating the shared dataset.
CREATE TABLE player_overrides (
  draft_id    UUID NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  player_id   UUID NOT NULL REFERENCES players(id),
  adp         NUMERIC(6,2),                   -- NULL => inherit
  proj_points NUMERIC(7,2),                   -- 0 => season-ending injury sim
  PRIMARY KEY (draft_id, player_id)
);

-- ---- Teams / bots ----------------------------------------------------------
CREATE TABLE teams (
  id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id UUID NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  slot     INT  NOT NULL,
  name     TEXT NOT NULL,
  is_bot   BOOLEAN NOT NULL DEFAULT true,
  brain    JSONB NOT NULL DEFAULT
           '{"adpBias":50,"chaos":20,"rosterNeed":40,"ageUpside":50}',
  UNIQUE (draft_id, slot)
);

-- ---- Pick Matrix (SPARSE: only cells deviating from preset) ----------------
CREATE TABLE matrix_cells (
  draft_id         UUID NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  round            INT  NOT NULL,
  team_slot        INT  NOT NULL,
  assigned_team_id UUID REFERENCES teams(id), -- traded pick
  timer_seconds    INT,
  keeper_player_id UUID REFERENCES players(id),
  PRIMARY KEY (draft_id, round, team_slot)
);

-- ---- Results (append-only event log) ---------------------------------------
CREATE TABLE picks (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id     UUID NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  overall_pick INT  NOT NULL,
  round        INT  NOT NULL,
  team_id      UUID NOT NULL REFERENCES teams(id),
  player_id    UUID NOT NULL REFERENCES players(id),
  score_trace  JSONB,                         -- God-Mode breakdown, replayable
  picked_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (draft_id, overall_pick)
);
