const gameLogic = require('../gamelogic');
const BettingRound = require('./betting-round');
const PotManager = require('./pot-manager');

// ─────────────────────────────────────────
// POKER ENGINE — Master game controller
// ─────────────────────────────────────────

class PokerEngine {
    constructor(players, options = {}) {
        // Game configuration
        this.gameId = options.gameId || `game_${Date.now()}`;
        this.tableId = options.tableId || `table_${Date.now()}`;
        this.smallBlind = options.smallBlind || 10;
        this.bigBlind = options.bigBlind || 20;
        
        // Game state
        this.stage = 'waiting'; // waiting, pre_flop, flop, turn, river, showdown, complete
        this.handNumber = 0;
        this.deck = [];
        this.communityCards = [];
        this.dealerSeat = 0;
        
        // Components
        this.potManager = new PotManager();
        this.bettingRound = null;
        
        // Players setup
        this.initializePlayers(players);
        
        // Event callbacks
        this.onHandComplete = null;
        this.onPlayerAction = null;
        this.onStageChange = null;
    }

    /**
     * Initialize players with proper poker player structure
     */
    initializePlayers(playersData) {
        this.players = playersData.map((playerData, index) => ({
            player_id: playerData.player_id,
            username: playerData.username,
            seat_number: playerData.seat_number || index,
            stack: playerData.chips || playerData.stack || 1000,
            
            // Hand-specific state (reset each hand)
            hole_cards: [],
            bet: 0,
            acted: false,
            folded: false,
            allIn: false,
            isDealer: false,
            
            // Session state 
            hands_played: 0,
            hands_won: 0,
            total_winnings: 0,
            
            // Last action for history
            lastAction: null
        }));

        // Validate minimum players
        if (this.players.length < 2 || this.players.length > 9) {
            throw new Error('Game requires 2-9 players');
        }

        // Set initial dealer to last seat, so first hand starts at seat 0
        this.dealerSeat = this.players.length - 1;
        this.players[0].isDealer = true;
    }

    /**
     * Start a new hand
     */
    startHand() {
        if (this.stage !== 'waiting' && this.stage !== 'complete') {
            throw new Error(`Cannot start hand in stage: ${this.stage}`);
        }

        this.handNumber++;
        console.log(`\n🃏 STARTING NEW HAND #${this.handNumber}`);
        console.log(`├─ Players: ${this.players.length}`);
        console.log(`├─ Small Blind: ${this.smallBlind}`);
        console.log(`└─ Big Blind: ${this.bigBlind}`);
        
        this.resetHandState();
        
        // Move dealer button
        this.advanceDealer();
        console.log(`🎲 Dealer advanced to seat ${this.dealerSeat}`);
        
        // Deal hole cards
        const gameState = gameLogic.dealHoldemGame(this.players);
        this.deck = gameState.deck;
        this.communityCards = gameState.communityCards;
        
        console.log('🂠 Dealing hole cards to players...');
        // Assign hole cards to players
        for (const player of this.players) {
            player.hole_cards = gameState.playerCards[player.player_id];
            console.log(`   ├─ ${player.username}: [HIDDEN] (${player.hole_cards.length} cards)`);
        }

        // Start preflop betting
        this.stage = 'pre_flop';
        console.log('🎯 Starting pre-flop betting round');
        this.startBettingRound(true);

        this.emitEvent('handStarted', {
            hand_number: this.handNumber,
            dealer_seat: this.dealerSeat,
            players: this.getPublicPlayerInfo()
        });

        return this.getGameState();
    }

    /**
     * Start a betting round
     */
    startBettingRound(isPreflop = false) {
        const activePlayers = this.players.filter(p => !p.folded);
        
        if (activePlayers.length <= 1) {
            // Skip betting if only one player left
            this.advanceToShowdown();
            return;
        }

        this.bettingRound = new BettingRound(
            this.players,
            this.smallBlind,
            this.bigBlind,
            isPreflop
        );

        this.emitEvent('bettingStarted', {
            stage: this.stage,
            current_player: this.bettingRound.getCurrentPlayer().player_id,
            available_actions: this.bettingRound.getAvailableActions()
        });
    }

    /**
     * Handle player action
     */
    handleAction(playerId, action, amount = 0) {
        if (!this.bettingRound) {
            throw new Error('No active betting round');
        }

        if (['complete', 'showdown'].includes(this.stage)) {
            throw new Error('Hand is complete');
        }
        
        const player = this.players.find(p => p.player_id === playerId);
        console.log(`\n🎯 PLAYER ACTION: ${player ? player.username : playerId}`);
        console.log(`├─ Action: ${action}`);
        console.log(`├─ Amount: ${amount}`);
        console.log(`├─ Stage: ${this.stage}`);
        console.log(`└─ Current pot: ${this.potManager.getTotalPot()}`);

        try {
            const result = this.bettingRound.handleAction(playerId, action, amount);
            
            console.log(`✅ Action processed successfully`);
            if (result.bettingComplete) {
                console.log(`🏁 Betting round completed`);
            }
            
            this.emitEvent('playerAction', {
                player_id: playerId,
                action: result.action,
                stage: this.stage,
                betting_complete: result.bettingComplete
            });

            // Check if betting round is complete
            if (result.bettingComplete) {
                this.completeBettingRound();
            }

            return {
                success: true,
                result: result,
                game_state: this.getGameState()
            };

        } catch (error) {
            return {
                success: false,
                error: error.message,
                game_state: this.getGameState()
            };
        }
    }

    /**
     * Complete current betting round and advance game
     */
    completeBettingRound() {
        if (!this.bettingRound) {
            return;
        }

        // Collect bets into pot
        const potStructure = this.potManager.collectBets(this.players);
        
        this.emitEvent('bettingComplete', {
            stage: this.stage,
            pot_structure: potStructure
        });

        // Clear betting round
        this.bettingRound = null;

        // Advance to next stage
        this.advanceStage();
    }

    /**
     * Advance to next game stage
     */
    advanceStage() {
        const activePlayers = this.players.filter(p => !p.folded);
        
        console.log(`\n📈 STAGE ADVANCEMENT`);
        console.log(`├─ Current stage: ${this.stage}`);
        console.log(`├─ Active players: ${activePlayers.length}`);
        
        if (activePlayers.length <= 1) {
            console.log(`└─ Only ${activePlayers.length} player(s) remaining, advancing to showdown`);
            this.advanceToShowdown();
            return;
        }

        switch (this.stage) {
            case 'pre_flop':
                console.log(`└─ Advancing to flop`);
                this.dealFlop();
                break;
            case 'flop':
                console.log(`└─ Advancing to turn`);
                this.dealTurn();
                break;
            case 'turn':
                console.log(`└─ Advancing to river`);
                this.dealRiver();
                break;
            case 'river':
                console.log(`└─ Advancing to showdown`);
                this.advanceToShowdown();
                break;
            default:
                throw new Error(`Cannot advance from stage: ${this.stage}`);
        }
    }

    /**
     * Deal flop (3 community cards)
     */
    dealFlop() {
        console.log('\n🃏 DEALING FLOP');
        const result = gameLogic.dealCommunityCards(this.deck, this.communityCards, 'flop');
        this.deck = result.deck;
        this.communityCards = result.communityCards;
        this.stage = 'flop';
        
        console.log(`├─ Community cards: ${this.communityCards.join(', ')}`);
        console.log(`├─ Cards remaining: ${this.deck.length}`);
        console.log('└─ Starting flop betting round');

        this.emitEvent('stageAdvanced', {
            stage: this.stage,
            community_cards: this.communityCards
        });

        this.startBettingRound(false);
    }

    /**
     * Deal turn (4th community card)
     */
    dealTurn() {
        console.log('\n🃏 DEALING TURN');
        const result = gameLogic.dealCommunityCards(this.deck, this.communityCards, 'turn');
        this.deck = result.deck;
        this.communityCards = result.communityCards;
        this.stage = 'turn';
        
        console.log(`├─ Community cards: ${this.communityCards.join(', ')}`);
        console.log(`├─ Cards remaining: ${this.deck.length}`);
        console.log('└─ Starting turn betting round');

        this.emitEvent('stageAdvanced', {
            stage: this.stage,
            community_cards: this.communityCards
        });

        this.startBettingRound(false);
    }

    /**
     * Deal river (5th community card)
     */
    dealRiver() {
        console.log('\n🃏 DEALING RIVER');
        const result = gameLogic.dealCommunityCards(this.deck, this.communityCards, 'river');
        this.deck = result.deck;
        this.communityCards = result.communityCards;
        this.stage = 'river';
        
        console.log(`├─ Community cards: ${this.communityCards.join(', ')}`);
        console.log(`├─ Cards remaining: ${this.deck.length}`);
        console.log('└─ Starting river betting round');

        this.emitEvent('stageAdvanced', {
            stage: this.stage,
            community_cards: this.communityCards
        });

        this.startBettingRound(false);
    }

    /**
     * Advance to showdown and determine winners
     */
    advanceToShowdown() {
        console.log('\n🏆 SHOWDOWN PHASE');
        console.log(`├─ Community cards: ${this.communityCards.join(', ')}`);
        console.log(`├─ Total pot: ${this.potManager.getTotalPot()}`);
        
        this.stage = 'showdown';

        const activePlayers = this.players.filter(p => !p.folded);
        console.log(`└─ Active players for showdown: ${activePlayers.length}`);
        
        activePlayers.forEach(player => {
            console.log(`   ├─ ${player.username}: ${player.hole_cards.join(', ')}`);
        });
        
        if (activePlayers.length <= 1) {
            // Single player wins uncontested
            const winner = activePlayers[0];
            console.log(`\n🥇 UNCONTESTED WIN: ${winner.username}`);
            this.distributeWinnings([{
                player_id: winner.player_id,
                username: winner.username,
                hand: null,
                share: 1.0,
                winType: 'uncontested'
            }]);
        } else {
            // Determine winners through hand evaluation
            console.log('\n🤝 EVALUATING HANDS...');
            const winners = gameLogic.determineWinners(activePlayers, this.communityCards);
            this.distributeWinnings(winners);
        }

        this.completeHand();
    }

    /**
     * Distribute winnings to winners
     */
    distributeWinnings(winners) {
        console.log('\n🥇 WINNERS DETERMINED:');
        winners.forEach(winner => {
            const handDesc = winner.hand ? `${winner.hand.descr} (${winner.hand.rank})` : 'Uncontested';
            console.log(`   ├─ ${winner.username}: ${handDesc}`);
        });
        
        const potStructure = this.potManager.getPotStructure();
        const distributions = this.potManager.distributePots(winners, potStructure);

        console.log('\n💰 POT DISTRIBUTION:');
        // Update player stacks
        for (const distribution of distributions) {
            const player = this.players.find(p => p.player_id === distribution.player_id);
            if (player) {
                const oldStack = player.stack;
                player.stack += distribution.amount;
                player.total_winnings += distribution.amount;
                player.hands_won++;
                console.log(`   ├─ ${player.username}: +${distribution.amount} chips (${oldStack} → ${player.stack})`);
            }
        }

        this.emitEvent('winningsDistributed', {
            winners: distributions,
            pot_structure: potStructure
        });

        return distributions;
    }

    /**
     * Complete current hand
     */
    completeHand() {
        this.stage = 'complete';
        
        console.log('\n📊 HAND SUMMARY:');
        console.log(`├─ Hand number: ${this.handNumber}`);
        console.log(`├─ Final pot: ${this.potManager.getTotalPot()}`);
        
        // Update hand counts
        for (const player of this.players) {
            player.hands_played++;
        }

        const handSummary = this.getHandSummary();
        console.log(`├─ Total hands played by each player: ${handSummary.players.map(p => `${p.username}:${p.hands_played}`).join(', ')}`);
        console.log(`└─ Winners: ${handSummary.winners.length}`);
        
        this.emitEvent('handComplete', handSummary);
        
        if (this.onHandComplete) {
            this.onHandComplete(handSummary);
        }

        // Check if game should continue
        const activePlayers = this.players.filter(p => p.stack > 0);
        console.log(`\n🔍 POST-HAND STATUS:`);
        console.log(`├─ Players with chips: ${activePlayers.length}`);
        
        if (activePlayers.length < 2) {
            console.log(`└─ Game ending - insufficient players`);
        } else {
            console.log(`└─ Game ready for next hand`);
        }
        if (activePlayers.length < 2) {
            this.endGame();
        } else {
            this.stage = 'waiting'; // Ready for next hand
        }
        console.log('🎊 HAND COMPLETED');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    }
        
    

    /**
     * End the game
     */
    endGame() {
        this.stage = 'game_over';
        
        const finalResults = this.players
            .sort((a, b) => b.stack - a.stack)
            .map((player, index) => ({
                player_id: player.player_id,
                username: player.username,
                final_position: index + 1,
                final_stack: player.stack,
                hands_played: player.hands_played,
                hands_won: player.hands_won,
                total_winnings: player.total_winnings
            }));

        this.emitEvent('gameEnded', {
            final_results: finalResults,
            total_hands: this.handNumber
        });
    }

    /**
     * Reset state for new hand
     */
    resetHandState() {
        this.communityCards = [];
        this.potManager.reset();
        this.bettingRound = null;

        for (const player of this.players) {
            player.hole_cards = [];
            player.bet = 0;
            player.acted = false;
            player.folded = false;
            player.allIn = false;
            player.lastAction = null;
        }
    }

    /**
     * Advance dealer button
     */
    advanceDealer() {
        // Clear all dealer flags first
        for (const player of this.players) {
            player.isDealer = false;
        }

        // Find next active player with chips
        const eligiblePlayers = this.players.filter(p => p.stack > 0);
        
        if (eligiblePlayers.length < 2) {
            return; // Game will end
        }

        let nextDealerIndex = (this.dealerSeat + 1) % this.players.length;
        let attempts = 0;
        
        while (attempts < this.players.length) {
            if (this.players[nextDealerIndex].stack > 0) {
                this.dealerSeat = nextDealerIndex;
                this.players[nextDealerIndex].isDealer = true;
                break;
            }
            nextDealerIndex = (nextDealerIndex + 1) % this.players.length;
            attempts++;
        }
    }

    /**
     * Get current game state
     */
    getGameState() {
        return {
            game_id: this.gameId,
            table_id: this.tableId,
            stage: this.stage,
            hand_number: this.handNumber,
            dealer_seat: this.dealerSeat,
            small_blind: this.smallBlind,
            big_blind: this.bigBlind,
            
            community_cards: this.communityCards,
            pot_structure: this.potManager.getPotStructure(),
            
            players: this.getPublicPlayerInfo(),
            
            betting_round: this.bettingRound ? {
                current_player: this.bettingRound.getCurrentPlayer().player_id,
                highest_bet: this.bettingRound.highestBet,
                min_raise: this.bettingRound.minRaise,
                available_actions: this.bettingRound.getAvailableActions()
            } : null,
            
            is_hand_active: ['pre_flop', 'flop', 'turn', 'river', 'showdown'].includes(this.stage)
        };
    }

    /**
     * Get public player information (hide hole cards)
     */
    getPublicPlayerInfo() {
        return this.players.map(player => ({
            player_id: player.player_id,
            username: player.username,
            seat_number: player.seat_number,
            stack: player.stack,
            bet: player.bet,
            folded: player.folded,
            allIn: player.allIn,
            isDealer: player.isDealer,
            acted: player.acted,
            lastAction: player.lastAction,
            
            // Hide hole cards unless showdown
            hole_cards: this.stage === 'showdown' ? player.hole_cards : [],
            
            // Statistics
            hands_played: player.hands_played,
            hands_won: player.hands_won
        }));
    }

    /**
     * Get private player information (includes hole cards)
     */
    getPrivatePlayerInfo(playerId) {
        const player = this.players.find(p => p.player_id === playerId);
        if (!player) {
            throw new Error(`Player ${playerId} not found`);
        }

        return {
            ...this.getPublicPlayerInfo().find(p => p.player_id === playerId),
            hole_cards: player.hole_cards
        };
    }

    /**
     * Get hand summary for completed hand
     */
    getHandSummary() {
        return {
            hand_number: this.handNumber,
            dealer_seat: this.dealerSeat,
            community_cards: this.communityCards,
            final_pot: this.potManager.totalPot,
            players: this.players.map(p => ({
                player_id: p.player_id,
                username: p.username,
                hole_cards: p.hole_cards,
                final_stack: p.stack,
                folded: p.folded
            }))
        };
    }

    /**
     * Event emission helper
     */
    emitEvent(eventType, data) {
        const eventData = {
            event: eventType,
            timestamp: new Date().toISOString(),
            game_id: this.gameId,
            ...data
        };

        // Console logging for debugging
        console.log(`[PokerEngine] ${eventType}:`, eventData);

        // Call event-specific callbacks
        switch (eventType) {
            case 'playerAction':
                if (this.onPlayerAction) this.onPlayerAction(eventData);
                break;
            case 'stageAdvanced':
                if (this.onStageChange) this.onStageChange(eventData);
                break;
        }
    }

    /**
     * Set event callbacks
     */
    setEventHandlers(handlers) {
        if (handlers.onHandComplete) this.onHandComplete = handlers.onHandComplete;
        if (handlers.onPlayerAction) this.onPlayerAction = handlers.onPlayerAction;
        if (handlers.onStageChange) this.onStageChange = handlers.onStageChange;
    }

    /**
     * Validate game state integrity
     */
    validateGameState() {
        const errors = [];

        // Check player count
        if (this.players.length < 2 || this.players.length > 9) {
            errors.push('Invalid player count');
        }

        // Check dealer position
        if (this.dealerSeat < 0 || this.dealerSeat >= this.players.length) {
            errors.push('Invalid dealer position');
        }

        // Check community cards count
        const expectedCardCounts = {
            'waiting': 0,
            'pre_flop': 0,
            'flop': 3,
            'turn': 4,
            'river': 5,
            'showdown': 5,
            'complete': 5
        };

        const expected = expectedCardCounts[this.stage];
        if (expected !== undefined && this.communityCards.length !== expected) {
            errors.push(`Stage ${this.stage} should have ${expected} community cards, has ${this.communityCards.length}`);
        }

        return {
            valid: errors.length === 0,
            errors: errors
        };
    }
}

module.exports = PokerEngine;