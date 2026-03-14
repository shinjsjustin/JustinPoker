class Announcements {
    constructor() {
        this.io = null;
    }

    init(io) {
        this.io = io;
    }

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
    }

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
    }

}

module.exports = new Announcements();