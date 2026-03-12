const { PokerEngine } = require('./index');

// ─────────────────────────────────────────
// BASIC POKER ENGINE TESTS
// ─────────────────────────────────────────

function runBasicTests() {
    console.log('🧪 Running Basic Poker Engine Tests\n');
    
    let testsPassed = 0;
    let testsTotal = 0;

    function test(name, testFn) {
        testsTotal++;
        try {
            testFn();
            console.log(`✅ ${name}`);
            testsPassed++;
        } catch (error) {
            console.log(`❌ ${name}: ${error.message}`);
        }
    }

    // Test 1: Engine Creation
    test('Engine Creation', () => {
        const players = [
            { player_id: 'p1', username: 'Alice', chips: 1000 },
            { player_id: 'p2', username: 'Bob', chips: 1000 }
        ];
        
        const engine = new PokerEngine(players);
        
        if (engine.players.length !== 2) {
            throw new Error('Wrong number of players');
        }
        
        if (engine.stage !== 'waiting') {
            throw new Error('Wrong initial stage');
        }
    });

    // Test 2: Hand Start
    test('Hand Start', () => {
        const players = [
            { player_id: 'p1', username: 'Alice', chips: 1000 },
            { player_id: 'p2', username: 'Bob', chips: 1000 }
        ];
        
        const engine = new PokerEngine(players);
        const gameState = engine.startHand();
        
        if (gameState.stage !== 'pre_flop') {
            throw new Error('Wrong stage after hand start');
        }
        
        if (gameState.community_cards.length !== 0) {
            throw new Error('Should have no community cards preflop');
        }
        
        // Check players have hole cards
        const player1 = engine.getPrivatePlayerInfo('p1');
        if (player1.hole_cards.length !== 2) {
            throw new Error('Player should have 2 hole cards');
        }
    });

    // Test 3: Basic Action Handling
    test('Basic Action Handling', () => {
        const players = [
            { player_id: 'p1', username: 'Alice', chips: 1000 },
            { player_id: 'p2', username: 'Bob', chips: 1000 }
        ];
        
        const engine = new PokerEngine(players, { smallBlind: 10, bigBlind: 20 });
        engine.startHand();
        
        // SB should be current player in heads-up preflop
        const currentPlayer = engine.bettingRound.getCurrentPlayer();
        if (currentPlayer.player_id !== 'p1') {
            throw new Error('Wrong current player');
        }
        
        // SB calls
        const result = engine.handleAction('p1', 'call');
        if (!result.success) {
            throw new Error('Call action should succeed');
        }
    });

    // Test 4: Fold Action
    test('Fold Action', () => {
        const players = [
            { player_id: 'p1', username: 'Alice', chips: 1000 },
            { player_id: 'p2', username: 'Bob', chips: 1000 }
        ];
        
        const engine = new PokerEngine(players);
        engine.startHand();
        
        // SB folds
        const result = engine.handleAction('p1', 'fold');
        if (!result.success) {
            throw new Error('Fold action should succeed');
        }
        
        // Game should advance to waiting (ready for next hand)
        const gameState = engine.getGameState();
        if (gameState.stage !== 'waiting') {
            throw new Error('Game should be waiting for next hand after fold');
        }
    });

    // Test 5: Infinite Loop Prevention
    test('Infinite Loop Prevention', () => {
        const players = [
            { player_id: 'p1', username: 'Alice', chips: 1000 },
            { player_id: 'p2', username: 'Bob', chips: 1000 }
        ];
        
        const engine = new PokerEngine(players, { smallBlind: 10, bigBlind: 20 });
        engine.startHand();
        
        // Complete preflop
        engine.handleAction('p1', 'call'); // SB calls
        engine.handleAction('p2', 'check'); // BB checks
        
        // Should advance to flop
        if (engine.stage !== 'flop') {
            throw new Error('Should advance to flop');
        }
        
        // Both players check on flop - should not loop infinitely
        engine.handleAction('p2', 'check'); // BB checks first postflop
        const result = engine.handleAction('p1', 'check'); // SB checks
        
        if (!result.success) {
            throw new Error('Check should succeed');
        }
        
        // Should advance to turn
        if (engine.stage !== 'turn') {
            throw new Error('Should advance to turn after both check');
        }
    });

    // Test 6: All-in Handling
    test('All-in Handling', () => {
        const players = [
            { player_id: 'p1', username: 'Alice', chips: 100 },
            { player_id: 'p2', username: 'Bob', chips: 1000 }
        ];
        
        const engine = new PokerEngine(players, { smallBlind: 10, bigBlind: 20 });
        engine.startHand();
        
        // Alice (SB) goes all-in
        const result = engine.handleAction('p1', 'all_in');
        if (!result.success) {
            throw new Error('All-in should succeed');
        }
        
        const alice = engine.players.find(p => p.player_id === 'p1');
        if (!alice.allIn || alice.stack !== 0) {
            throw new Error('Alice should be all-in with 0 stack');
        }
    });

    console.log(`\n📊 Tests Results: ${testsPassed}/${testsTotal} passed`);
    
    if (testsPassed === testsTotal) {
        console.log('🎉 All tests passed!');
        return true;
    } else {
        console.log('❌ Some tests failed');
        return false;
    }
}

// Run tests if called directly
if (require.main === module) {
    runBasicTests();
}

module.exports = { runBasicTests };