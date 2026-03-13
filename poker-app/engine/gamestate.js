/**
 * GameState Module
 * Handles game state management and progression for poker games
 * 
 * Stage progression: preflop (0) -> flop (1) -> turn (2) -> river (3)
 * Seat: cycles through active players (0 to maxPlayers - 1)
 * AggRounds: resets when aggressor found, ends betting when completes loop without raise
 */

// Stage constants
const STAGES = {
  PREFLOP: 0,
  FLOP: 1,
  TURN: 2,
  RIVER: 3
};

const STAGE_NAMES = ['preflop', 'flop', 'turn', 'river'];

/**
 * Creates a new GameState object
 * @param {number} gameId - The game identifier
 * @param {number} maxPlayers - Maximum players at the table
 * @param {number} smallBlind - Small blind amount
 * @param {number} bigBlind - Big blind amount
 * @returns {Object} GameState object
 */
function createGameState(gameId, maxPlayers, smallBlind, bigBlind) {
  return {
    game_id: gameId,
    pot: 0,
    stage: STAGES.PREFLOP,
    seat: 0,
    aggRounds: 0,
    maxPlayers: maxPlayers,
    smallBlind: smallBlind,
    bigBlind: bigBlind,
    currentBet: 0,           // The current bet amount to call
    lastAggressor: null,     // Seat of last player who raised
    bets: [],                // Array of {name, player_id, seat, bet, totalBet}
    communityCards: [],
    dealerSeat: 0,
    sbSeat: 1,
    bbSeat: 2
  };
}

/**
 * Calculates the amount a player needs to call
 * @param {Object} gameState - The current game state
 * @param {number} playerBet - The player's current bet this round
 * @returns {number} Amount to call
 */
function calculateToCall(gameState, playerBet) {
  return Math.max(0, gameState.currentBet - playerBet);
}

/**
 * Calculates the minimum raise amount
 * @param {Object} gameState - The current game state
 * @returns {number} Minimum raise amount
 */
function calculateMinRaise(gameState) {
  // Min raise is typically the big blind or the last raise amount
  return gameState.bigBlind;
}

/**
 * Advances to the next active seat
 * @param {Object} gameState - The current game state
 * @param {Array} activePlayers - Array of player objects with {seat, folded, allIn}
 * @returns {number} The next active seat, or -1 if no active players
 */
function getNextActiveSeat(gameState, activePlayers) {
  const activeSeats = activePlayers
    .filter(p => !p.folded && !p.allIn)
    .map(p => p.seat)
    .sort((a, b) => a - b);

  if (activeSeats.length === 0) return -1;

  // Find next seat after current
  for (const seat of activeSeats) {
    if (seat > gameState.seat) return seat;
  }
  
  // Wrap around to beginning
  return activeSeats[0];
}

/**
 * Advances the seat and aggRounds counters
 * @param {Object} gameState - The current game state
 * @param {Array} activePlayers - Array of active player objects
 * @param {boolean} isRaise - Whether the action was a raise
 * @returns {Object} Updated counters {seat, aggRounds, bettingComplete}
 */
function advanceBetting(gameState, activePlayers, isRaise) {
  let { seat, aggRounds, maxPlayers } = gameState;
  
  if (isRaise) {
    // Reset aggRounds when someone raises
    gameState.lastAggressor = seat;
    aggRounds = 0;
  } else {
    aggRounds++;
  }

  // Move to next active seat
  const nextSeat = getNextActiveSeat(gameState, activePlayers);
  
  if (nextSeat === -1) {
    // No active players left (all folded or all-in)
    return { seat: nextSeat, aggRounds, bettingComplete: true };
  }

  seat = nextSeat;

  // Check if we've completed a full round without a raise
  const activeCount = activePlayers.filter(p => !p.folded && !p.allIn).length;
  const bettingComplete = aggRounds >= activeCount;

  return { seat, aggRounds, bettingComplete };
}

/**
 * Advances to the next stage
 * @param {Object} gameState - The current game state
 * @returns {boolean} True if game is complete, false otherwise
 */
function advanceStage(gameState) {
  if (gameState.stage >= STAGES.RIVER) {
    return true; // Game complete, go to showdown
  }

  gameState.stage++;
  gameState.seat = 0;
  gameState.aggRounds = 0;
  gameState.currentBet = 0;
  gameState.lastAggressor = null;
  
  // Clear round bets but keep for history
  gameState.bets = [];

  return false;
}

/**
 * Records a bet action
 * @param {Object} gameState - The current game state
 * @param {string} name - Player name
 * @param {number} playerId - Player ID
 * @param {number} seat - Player seat
 * @param {number} betAmount - Amount bet this action
 * @param {number} totalBet - Player's total bet this round
 */
function recordBet(gameState, name, playerId, seat, betAmount, totalBet) {
  gameState.bets.push({
    name,
    player_id: playerId,
    seat,
    bet: betAmount,
    totalBet
  });

  // Update current bet if this is a raise
  if (totalBet > gameState.currentBet) {
    gameState.currentBet = totalBet;
  }

  // Add to pot
  gameState.pot += betAmount;
}

/**
 * Gets the current stage name
 * @param {Object} gameState - The current game state
 * @returns {string} Stage name
 */
function getStageName(gameState) {
  return STAGE_NAMES[gameState.stage] || 'unknown';
}

/**
 * Serializes game state for transmission
 * @param {Object} gameState - The current game state
 * @returns {Object} Serialized game state for client/backend
 */
function serializeGameState(gameState) {
  return {
    game_id: gameState.game_id,
    pot: gameState.pot,
    stage: gameState.stage,
    stageName: getStageName(gameState),
    seat: gameState.seat,
    aggRounds: gameState.aggRounds,
    currentBet: gameState.currentBet,
    bets: gameState.bets.map(b => ({
      name: b.name,
      player_id: b.player_id,
      bet: b.totalBet
    })),
    communityCards: gameState.communityCards,
    dealerSeat: gameState.dealerSeat,
    sbSeat: gameState.sbSeat,
    bbSeat: gameState.bbSeat
  };
}

/**
 * Checks if only one player remains (everyone else folded)
 * @param {Array} players - Array of player objects with folded status
 * @returns {Object|null} The winning player or null if multiple remain
 */
function checkForSingleWinner(players) {
  const activePlayers = players.filter(p => !p.folded);
  if (activePlayers.length === 1) {
    return activePlayers[0];
  }
  return null;
}

/**
 * Resets betting for a new round/stage
 * @param {Object} gameState - The current game state
 * @param {number} firstToActSeat - The seat that acts first
 */
function resetBettingRound(gameState, firstToActSeat) {
  gameState.seat = firstToActSeat;
  gameState.aggRounds = 0;
  gameState.currentBet = 0;
  gameState.lastAggressor = null;
  gameState.bets = [];
}

module.exports = {
  STAGES,
  STAGE_NAMES,
  createGameState,
  calculateToCall,
  calculateMinRaise,
  getNextActiveSeat,
  advanceBetting,
  advanceStage,
  recordBet,
  getStageName,
  serializeGameState,
  checkForSingleWinner,
  resetBettingRound
};
