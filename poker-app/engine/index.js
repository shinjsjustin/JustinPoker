/**
 * Poker Engine Module Index
 * Exports all engine-related modules
 */

const PokerGameLogic = require('./hands');
const gamestate = require('./gamestate');

// Re-export named exports from gamestate
const {
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
} = gamestate;

module.exports = {
  // Main classes
  PokerGameLogic,
  
  // GameState functions
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
  resetBettingRound,
  
  // Full module reference
  gamestate
};
