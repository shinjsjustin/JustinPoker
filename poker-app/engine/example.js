const { PokerEngine } = require('./index');

// ─────────────────────────────────────────
// POKER ENGINE EXAMPLE — How to use the engine
// ─────────────────────────────────────────

function runPokerEngineExample() {
    console.log('🃏 Starting Poker Engine Example\n');

    // Create players
    const players = [
        { player_id: 'p1', username: 'Alice', chips: 1000 },
        { player_id: 'p2', username: 'Bob', chips: 1500 },
        { player_id: 'p3', username: 'Charlie', chips: 800 }
    ];

    // Create poker engine
    const engine = new PokerEngine(players, {
        gameId: 'example_game',
        smallBlind: 10,
        bigBlind: 20
    });

    // Set up event handlers
    engine.setEventHandlers({
        onHandComplete: (handSummary) => {
            console.log('✅ Hand Complete:', handSummary);
        },
        
        onPlayerAction: (eventData) => {
            console.log(`🎯 ${eventData.player_id} ${eventData.action.type} ${eventData.action.amount || ''}`);
        },
        
        onStageChange: (eventData) => {
            console.log(`🎪 Stage: ${eventData.stage}, Community: [${eventData.community_cards.join(', ')}]`);
        }
    });

    try {
        // Start first hand
        console.log('--- STARTING HAND 1 ---');
        let gameState = engine.startHand();
        console.log('Game State:', JSON.stringify(gameState, null, 2));

        // Simulate some actions
        console.log('\n--- PREFLOP BETTING ---');
        
        // UTG (Charlie) calls
        engine.handleAction('p3', 'call');
        
        // Alice raises
        engine.handleAction('p1', 'raise', 60);
        
        // Bob calls
        engine.handleAction('p2', 'call');
        
        // Charlie folds
        engine.handleAction('p3', 'fold');

        console.log('\n--- FLOP ---');
        // Betting round should automatically advance to flop
        
        // Alice bets
        let result = engine.handleAction('p1', 'bet', 100);
        if (!result.success) {
            console.log('Error:', result.error);
        }
        
        // Bob calls
        engine.handleAction('p2', 'call');

        console.log('\n--- TURN ---');
        // Should advance to turn
        
        // Alice checks
        engine.handleAction('p1', 'check');
        
        // Bob bets
        engine.handleAction('p2', 'bet', 150);
        
        // Alice calls
        engine.handleAction('p1', 'call');

        console.log('\n--- RIVER ---');
        // Should advance to river
        
        // Alice checks
        engine.handleAction('p1', 'check');
        
        // Bob bets all-in
        engine.handleAction('p2', 'all_in');
        
        // Alice folds
        engine.handleAction('p1', 'fold');

        console.log('\n--- FINAL GAME STATE ---');
        const finalState = engine.getGameState();
        console.log('Final Game State:', JSON.stringify(finalState, null, 2));

    } catch (error) {
        console.error('❌ Error:', error.message);
        console.error(error.stack);
    }
}

/**
 * Example of preventing infinite check loop
 */
function demonstrateInfiniteLoopPrevention() {
    console.log('\n🚫 INFINITE LOOP PREVENTION DEMO\n');

    const players = [
        { player_id: 'p1', username: 'Player1', chips: 1000 },
        { player_id: 'p2', username: 'Player2', chips: 1000 }
    ];

    const engine = new PokerEngine(players, {
        smallBlind: 10,
        bigBlind: 20
    });

    try {
        engine.startHand();
        
        console.log('Preflop: Player1 calls, Player2 checks');
        engine.handleAction('p1', 'call'); // Call the big blind
        engine.handleAction('p2', 'check'); // BB checks
        
        console.log('🎪 Flop dealt - now both players can check without loop');
        engine.handleAction('p2', 'check'); // BB checks first postflop
        engine.handleAction('p1', 'check'); // SB checks
        
        console.log('✅ No infinite loop! Betting round completed properly');
        
        const gameState = engine.getGameState();
        console.log('Current stage:', gameState.stage);
        
    } catch (error) {
        console.error('Error:', error.message);
    }
}

/**
 * Example with side pots (all-in scenario)
 */
function demonstrateSidePots() {
    console.log('\n💰 SIDE POTS DEMO\n');

    const players = [
        { player_id: 'p1', username: 'ShortStack', chips: 100 },
        { player_id: 'p2', username: 'MediumStack', chips: 500 },
        { player_id: 'p3', username: 'BigStack', chips: 1000 }
    ];

    const engine = new PokerEngine(players, {
        smallBlind: 10,
        bigBlind: 20
    });

    try {
        engine.startHand();
        
        // Create all-in scenario for side pots
        console.log('Creating side pot scenario...');
        engine.handleAction('p3', 'call'); // UTG calls
        engine.handleAction('p1', 'all_in'); // SB goes all-in with 90 more
        engine.handleAction('p2', 'call'); // BB calls all-in
        engine.handleAction('p3', 'raise', 300); // UTG raises
        engine.handleAction('p2', 'call'); // BB calls raise
        
        // This should create multiple pots
        const gameState = engine.getGameState();
        console.log('Pot Structure:', JSON.stringify(gameState.pot_structure, null, 2));
        
    } catch (error) {
        console.error('Error:', error.message);
    }
}

// Run examples if called directly
if (require.main === module) {
    runPokerEngineExample();
    demonstrateInfiniteLoopPrevention();
    demonstrateSidePots();
}

module.exports = {
    runPokerEngineExample,
    demonstrateInfiniteLoopPrevention,
    demonstrateSidePots
};