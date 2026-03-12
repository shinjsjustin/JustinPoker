
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

  PRIMARY KEY (player_id),
  UNIQUE KEY uq_username (username),
  UNIQUE KEY uq_email    (email)
);

-- 2. TABLES
CREATE TABLE tables (
  table_id    INT          NOT NULL AUTO_INCREMENT,
  name        VARCHAR(100) NOT NULL,
  max_players TINYINT      NOT NULL DEFAULT 9,
  small_blind INT          NOT NULL DEFAULT 10,
  big_blind   INT          NOT NULL DEFAULT 20,
  status      ENUM('waiting','active','closed') NOT NULL DEFAULT 'waiting',
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (table_id)
);

-- 3. TABLE_PLAYERS (join table — who is seated where)
CREATE TABLE table_players (
  table_player_id INT     NOT NULL AUTO_INCREMENT,
  table_id        INT     NOT NULL,
  player_id       INT     NOT NULL,
  seat_number     TINYINT NOT NULL,
  chip_stack      INT     NOT NULL DEFAULT 0,
  status          ENUM('active','sitting_out','left') NOT NULL DEFAULT 'active',
  joined_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (table_player_id),
  UNIQUE KEY uq_seat             (table_id, seat_number),
  UNIQUE KEY uq_player_at_table  (table_id, player_id),
  FOREIGN KEY (table_id)  REFERENCES tables(table_id),
  FOREIGN KEY (player_id) REFERENCES players(player_id)
);

-- 4. GAMES (one row per hand dealt)
CREATE TABLE games (
  game_id         INT     NOT NULL AUTO_INCREMENT,
  table_id        INT     NOT NULL,
  pot             INT     NOT NULL DEFAULT 0,
  community_cards JSON,
  stage           ENUM('pre_flop','flop','turn','river','showdown') NOT NULL DEFAULT 'pre_flop',
  dealer_seat     TINYINT NOT NULL,
  active_seat     TINYINT,
  started_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at        TIMESTAMP NULL,

  PRIMARY KEY (game_id),
  FOREIGN KEY (table_id) REFERENCES tables(table_id)
);

-- 5. GAME_PLAYERS (each player's state within a hand)
CREATE TABLE game_players (
  game_player_id INT     NOT NULL AUTO_INCREMENT,
  game_id        INT     NOT NULL,
  player_id      INT     NOT NULL,
  hole_cards     JSON,
  chips_start    INT     NOT NULL,
  chips_end      INT     NULL,
  is_folded      BOOLEAN NOT NULL DEFAULT FALSE,
  is_all_in      BOOLEAN NOT NULL DEFAULT FALSE,
  current_bet    INT     NOT NULL DEFAULT 0,

  PRIMARY KEY (game_player_id),
  UNIQUE KEY uq_player_in_game (game_id, player_id),
  FOREIGN KEY (game_id)   REFERENCES games(game_id),
  FOREIGN KEY (player_id) REFERENCES players(player_id)
);

-- 6. ACTIONS (event log — source of truth for replays & recovery)
CREATE TABLE actions (
  action_id   INT  NOT NULL AUTO_INCREMENT,
  game_id     INT  NOT NULL,
  player_id   INT  NOT NULL,
  action_type ENUM('fold','check','call','raise','all_in','blind') NOT NULL,
  amount      INT  NOT NULL DEFAULT 0,
  stage       ENUM('pre_flop','flop','turn','river') NOT NULL,
  acted_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (action_id),
  FOREIGN KEY (game_id)   REFERENCES games(game_id),
  FOREIGN KEY (player_id) REFERENCES players(player_id)
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

-- Table player lookup indexes  
-- Critical for finding who's at what table and seat management
CREATE INDEX idx_table_players_table_id ON table_players(table_id);
CREATE INDEX idx_table_players_player_id ON table_players(player_id);
CREATE INDEX idx_table_players_status ON table_players(status);

-- Game player indexes
-- Fast lookup for player states within games
CREATE INDEX idx_game_players_game_id ON game_players(game_id);
CREATE INDEX idx_game_players_player_id ON game_players(player_id);

-- Action log indexes  
-- Essential for game replay, analysis, and action history
CREATE INDEX idx_actions_game_id ON actions(game_id);
CREATE INDEX idx_actions_player_id ON actions(player_id);
CREATE INDEX idx_actions_acted_at ON actions(acted_at);
-- Composite index for common query pattern (game + stage)
CREATE INDEX idx_actions_game_stage ON actions(game_id, stage);