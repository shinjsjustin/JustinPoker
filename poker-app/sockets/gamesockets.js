const GameState = require('../engine/gamestate');

function createGameSockets(io){
    return {
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
    }
}