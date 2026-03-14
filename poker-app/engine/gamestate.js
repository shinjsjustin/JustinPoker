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

}