const Cards = require('./hands')

class GameState{
    constructor(gameId, maxPlayers, smallBlind, bigBlind, dealerSeat) {
        this.game_id = gameId;
        this.maxPlayers = maxPlayers;
        this.dealerSeat = dealerSeat;
        this.smallBlind = smallBlind;
        this.bigBlind = bigBlind;
        this.hotseat = (dealerSeat + 3) % maxPlayers;
        this.sbSeat = (dealerSeat + 1) % maxPlayers;
        this.bbSeat = (dealerSeat + 2) % maxPlayers;
        this.aggRounds = maxPlayers - 1;

        this.pot = 0;
        this.stage = 0;
        this.currentBet = 0;
        this.bets = [];
        this.communityCards = [];
    }

    // Getter
    getGameState() {
        return {
            game_id: this.game_id,
            maxPlayer: this.maxPlayers,
            dealerSeat: this.dealerSeat,
            smallBlind: this.smallBlind,
            bigBlind: this.bigBlind,
            hotseat: this.hotseat,
            sbSeat: this.sbSeat,
            bbSeat: this.bbSeat,
            aggRounds: this.aggRounds,
            pot: this.pot,
            stage: this.stage,
            currentBet: this.currentBet,
            bets: this.bets,
            communityCards: this.communityCards
        };
    }

    // Setter
    set(field, value) {
        if (!(field in this)) {
            throw new Error(`Field ${field} does not exist in GameState`);
        }
        this[field] = value;
    }

    // Calculators
    interrogateHotSeat() {
        const hotSeatBet = this.bets.find(bet => bet.seat === this.hotseat) - this.currentBet;
        if (hotSeatBet > 0) {
            
    }
}

module.exports = new GameState();