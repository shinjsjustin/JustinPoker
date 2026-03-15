
-- Sessions table (optional, for database-backed sessions)
CREATE TABLE IF NOT EXISTS sessions (
    session_id VARCHAR(128) COLLATE utf8mb4_bin NOT NULL,
    expires INT(11) UNSIGNED NOT NULL,
    data MEDIUMTEXT COLLATE utf8mb4_bin,
    PRIMARY KEY (session_id)
);

-- ─────────────────────────────────────────
-- POKER APP — MySQL Schema v1.0
-- ─────────────────────────────────────────

-- 1. PLAYERS
CREATE TABLE players (
  player_id     INT          NOT NULL AUTO_INCREMENT,
  username      VARCHAR(50)  NOT NULL,
  email         VARCHAR(100) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  chip_balance  INT          NOT NULL DEFAULT 1000,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,

  table_id      INT          NULL,
  seat_number   TINYINT      NULL,
  status        ENUM('active','sitting_out','offline') NULL,
  joined_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  game_id       INT          NULL,
  hole_cards    JSON         NULL,
  is_folded     BOOLEAN      NULL,
  is_all_in     BOOLEAN      NULL,
  current_bet   INT          NULL,

  PRIMARY KEY (player_id),
  UNIQUE KEY uq_username (username),
  UNIQUE KEY uq_email    (email),
  FOREIGN KEY (table_id) REFERENCES tables(table_id),
  FOREIGN KEY (game_id)  REFERENCES games(game_id)
);

-- 2. TABLES
CREATE TABLE tables (
  table_id    INT          NOT NULL AUTO_INCREMENT,
  name        VARCHAR(100) NOT NULL,
  max_players TINYINT      NOT NULL DEFAULT 9,
  small_blind INT          NOT NULL DEFAULT 10,
  big_blind   INT          NOT NULL DEFAULT 20,
  dealer_seat TINYINT      NOT NULL DEFAULT 1,
  seats       JSON         NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (table_id)
);

-- 4. GAMES (one row per hand dealt)
CREATE TABLE games (
  game_id         INT     NOT NULL AUTO_INCREMENT,
  table_id        INT     NOT NULL,
  dealer_seat     TINYINT NOT NULL DEFAULT 0,
  hot_seat        TINYINT NULL,
  stage           TINYINT NOT NULL DEFAULT 0,
  aggrounds       TINYINT NULL, 

  pot             INT     NOT NULL DEFAULT 0,
  current_bet     INT     NOT NULL DEFAULT 0,
  bets            JSON    NULL,
  community_cards JSON    NULL,

  started_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at        TIMESTAMP NULL,

  PRIMARY KEY (game_id),
  FOREIGN KEY (table_id) REFERENCES tables(table_id)
);

-- ─────────────────────────────────────────
-- PERFORMANCE INDEXES
-- ─────────────────────────────────────────

-- Authentication indexes - speed up login/registration queries
-- Most frequently used for WHERE clauses in user lookup
CREATE INDEX idx_players_username ON players(username);
CREATE INDEX idx_players_email ON players(email);

-- Game performance indexes
-- Speed up finding active games and player lookup
CREATE INDEX idx_games_table_id ON games(table_id);
CREATE INDEX idx_games_stage ON games(stage);
CREATE INDEX idx_games_started_at ON games(started_at);

-- Action log indexes  
-- Essential for game replay, analysis, and action history
CREATE INDEX idx_actions_game_id ON actions(game_id);
CREATE INDEX idx_actions_player_id ON actions(player_id);
CREATE INDEX idx_actions_acted_at ON actions(acted_at);
-- Composite index for common query pattern (game + stage)
CREATE INDEX idx_actions_game_stage ON actions(game_id, stage);