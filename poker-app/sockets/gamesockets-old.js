/**
 * Game Socket Utilities
 * Server-side socket functions for poker game communication
 * 
 * Usage: Requires the Socket.io `io` instance to be passed in
 */

const { serializeGameState } = require('../engine/gamestate');

/**
 * Creates a game sockets handler with the given io instance
 * @param {Object} io - Socket.io server instance
 * @returns {Object} Socket utility functions
 */
function createGameSockets(io) {
  return {
    /**
     * Announces a message to all players at a table
     * @param {string} message - The message to announce
     * @param {number} tableId - The table ID
     */
    announceToTable(message, tableId) {
      io.to(`table_${tableId}`).emit('table_message', {
        type: 'announcement',
        message,
        timestamp: Date.now()
      });
    },

    /**
     * Announces a message to a specific player
     * @param {string} message - The message to announce
     * @param {number} playerId - The player ID
     */
    announceToPlayer(message, playerId) {
      io.to(`player_${playerId}`).emit('player_message', {
        type: 'announcement',
        message,
        timestamp: Date.now()
      });
    },

    /**
     * Announces a game state update to all players at a table
     * @param {Object} gameState - The game state object
     * @param {number} tableId - The table ID
     */
    announceGameState(gameState, tableId) {
      const serialized = serializeGameState(gameState);
      io.to(`table_${tableId}`).emit('game_state_update', {
        type: 'state_update',
        gameState: serialized,
        timestamp: Date.now()
      });
    },

    /**
     * Announces to a player that it's their turn to bet
     * @param {number} playerId - The player ID
     * @param {Object} options - Turn options
     * @param {number} options.toCall - Amount to call
     * @param {number} options.minRaise - Minimum raise amount
     * @param {number} options.pot - Current pot size
     * @param {number} options.timeLimit - Time limit in seconds (optional)
     */
    announcePlayerTurn(playerId, options = {}) {
      io.to(`player_${playerId}`).emit('your_turn', {
        type: 'turn_notification',
        toCall: options.toCall || 0,
        minRaise: options.minRaise || 0,
        pot: options.pot || 0,
        timeLimit: options.timeLimit || 30,
        timestamp: Date.now()
      });
    },

    /**
     * Broadcasts a player action to all players at a table
     * @param {number} tableId - The table ID
     * @param {Object} action - Action details
     * @param {number} action.playerId - Player who acted
     * @param {string} action.playerName - Player's name
     * @param {string} action.actionType - Type of action (fold, check, call, raise)
     * @param {number} action.amount - Amount (for call/raise)
     */
    announcePlayerAction(tableId, action) {
      io.to(`table_${tableId}`).emit('player_action', {
        type: 'action',
        playerId: action.playerId,
        playerName: action.playerName,
        actionType: action.actionType,
        amount: action.amount || 0,
        timestamp: Date.now()
      });
    },

    /**
     * Announces stage change (flop, turn, river) to all players
     * @param {number} tableId - The table ID
     * @param {string} stageName - Name of the new stage
     * @param {Array} communityCards - Current community cards
     */
    announceStageChange(tableId, stageName, communityCards) {
      io.to(`table_${tableId}`).emit('stage_change', {
        type: 'stage',
        stage: stageName,
        communityCards,
        timestamp: Date.now()
      });
    },

    /**
     * Announces hand winner(s) to all players at a table
     * @param {number} tableId - The table ID
     * @param {Array} winners - Array of winner objects {playerId, playerName, amount, hand}
     */
    announceWinners(tableId, winners) {
      io.to(`table_${tableId}`).emit('hand_winners', {
        type: 'winners',
        winners,
        timestamp: Date.now()
      });
    },

    /**
     * Announces new hand starting
     * @param {number} tableId - The table ID
     * @param {Object} handInfo - Hand information
     * @param {number} handInfo.handNumber - Hand number
     * @param {number} handInfo.dealerSeat - Dealer position
     * @param {number} handInfo.sbSeat - Small blind position
     * @param {number} handInfo.bbSeat - Big blind position
     */
    announceNewHand(tableId, handInfo) {
      io.to(`table_${tableId}`).emit('new_hand', {
        type: 'new_hand',
        handNumber: handInfo.handNumber,
        dealerSeat: handInfo.dealerSeat,
        sbSeat: handInfo.sbSeat,
        bbSeat: handInfo.bbSeat,
        timestamp: Date.now()
      });
    },

    /**
     * Sends private hole cards to a specific player
     * @param {number} playerId - The player ID
     * @param {Array} cards - The player's hole cards
     */
    sendHoleCards(playerId, cards) {
      io.to(`player_${playerId}`).emit('hole_cards', {
        type: 'private_cards',
        cards,
        timestamp: Date.now()
      });
    },

    /**
     * Joins a socket to a table room
     * @param {Object} socket - The socket to join
     * @param {number} tableId - The table ID
     */
    joinTableRoom(socket, tableId) {
      socket.join(`table_${tableId}`);
    },

    /**
     * Removes a socket from a table room
     * @param {Object} socket - The socket to remove
     * @param {number} tableId - The table ID
     */
    leaveTableRoom(socket, tableId) {
      socket.leave(`table_${tableId}`);
    }
  };
}

module.exports = { createGameSockets };
