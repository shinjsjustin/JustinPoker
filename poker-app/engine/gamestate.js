const Cards = require('./hands')

function BetDataPack(seat, amount, folded, allin){ 
    this.seat = seat;
    this.amount = amount;
    this.folded = folded;
    this.allIn = allin;
}

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
        this.bets = [BetDataPack];
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

    // Helper - reset aggressor
    resetAggro(){
        const n = this.maxPlayers;
        this.aggRounds = n;
        return n;
    }

    getNextActiveSeat(){
        const activeSeats = this.bets
            .filter(bet => !bet.folded && !bet.allIn)
            .map(bet => bet.seat)
            .sort((a, b) => a - b);

        if (activeSeats.length === 0) return -1;

        // Find next seat after current hotseat
        for (const seat of activeSeats) {
            if (seat > this.hotseat) return seat;
        }
        // Wrap around to the first active seat
        return activeSeats[0];
    }

    progress(){
        if(this.aggRounds > 0){
            this.aggRounds -= 1;
            const nextSeat = this.getNextActiveSeat();
            if (nextSeat !== -1) {
                return this.hotseat = nextSeat;
            }else{
                return this.stage = 3; // No active players, move to showdown
            }
        }else if(this.stage < 3){
            this.stage += 1;
             return this.resetAggro();
        }else {
            return this.stage = 3; // Move to showdown
        }
    }

    getToCall(){
        return this.bets.find(bet => bet.seat === this.hotseat)?.amount || 0;
    }

    call(playerSeat, amount){
        if(amount < this.currentBet){
            throw new Error('Call amount must be at least the current bet');
        }
        if(playerSeat !== this.hotseat){
            throw new Error('Only the hotseat can call');
        }
        this.pot += amount;
        this.bets.push(new Bet(playerSeat, amount, false, false));

        return this.progress();
    }

    raise(playerSeat, amount){
        if(amount <= this.currentBet){
            throw new Error('Raise amount must be greater than the current bet');
        }
        if(playerSeat !== this.hotseat){
            throw new Error('Only the hotseat can raise');
        }
        this.currentBet = amount;
        this.pot += amount;
        this.bets.push(new Bet(playerSeat, amount, false, false));

        return this.progress();
    }

    fold(playerSeat){
        if(playerSeat !== this.hotseat){
            throw new Error('Only the hotseat can fold');
        }
        this.bets.push(new Bet(playerSeat, 0, true, false));

        return this.progress();
    }

    allIn(playerSeat, amount){
        if(playerSeat !== this.hotseat){
            throw new Error('Only the hotseat can go all-in');
        }
        if(amount <= 0){
            throw new Error('All-in amount must be greater than zero');
        }
        this.pot += amount;
        this.bets.push(new Bet(playerSeat, amount, false, true));

        return this.progress();
    }
}

module.exports = new GameState();