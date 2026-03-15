class Announcements {
    constructor() {
        this.io = null;
    }

    init(io) {
        this.io = io;
    }

    announceToTable(message, tableId) {
      io.to(`table_${tableId}`).emit('table_message', {
        type: 'announcement',
        message,
        timestamp: Date.now()
      });
    }

    announceToPlayer(message, playerId) {
      io.to(`player_${playerId}`).emit('player_message', {
        type: 'announcement',
        message,
        timestamp: Date.now()
      });
    }

    
}

module.exports = new Announcements();