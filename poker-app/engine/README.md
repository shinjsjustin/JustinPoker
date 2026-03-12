# Poker Engine

A comprehensive Texas Hold'em poker engine that prevents infinite check loops and handles all aspects of poker game management.

## 🎯 Key Features

- **Infinite Loop Prevention**: Implements proper "last aggressor" rule to prevent endless checking
- **Side Pot Management**: Automatically handles all-in scenarios with multiple side pots
- **Complete Betting Logic**: All poker actions (fold, check, call, bet, raise, all-in)
- **Game Stage Progression**: Preflop → Flop → Turn → River → Showdown
- **Event System**: Subscribe to game events for real-time updates
- **Hand Evaluation**: Integration with pokersolver for accurate hand rankings

## 📁 Architecture

```
/engine/
├── poker-engine.js     # Main game controller
├── betting-round.js    # Betting logic & loop prevention
├── pot-manager.js      # Pot & side pot calculations
├── index.js           # Module exports
├── example.js         # Usage examples
├── test.js           # Basic tests
└── README.md         # This file
```

## 🚀 Quick Start

```javascript
const { PokerEngine } = require('./engine');

// Create players
const players = [
    { player_id: 'p1', username: 'Alice', chips: 1000 },
    { player_id: 'p2', username: 'Bob', chips: 1500 },
    { player_id: 'p3', username: 'Charlie', chips: 800 }
];

// Create engine
const engine = new PokerEngine(players, {
    smallBlind: 10,
    bigBlind: 20
});

// Start a hand
engine.startHand();

// Handle player actions
engine.handleAction('p3', 'call');      // UTG calls
engine.handleAction('p1', 'raise', 60); // SB raises
engine.handleAction('p2', 'fold');      // BB folds
engine.handleAction('p3', 'call');      // UTG calls
```

## 🎮 Player Actions

All actions go through: `engine.handleAction(playerId, action, amount)`

### Available Actions:
- **`fold`** - Player folds their hand
- **`check`** - Check (only if no bet to call)
- **`call`** - Call current bet
- **`bet`** - Make first bet on street
- **`raise`** - Raise existing bet
- **`all_in`** - Go all-in with remaining chips

### Action Validation:
```javascript
const result = engine.handleAction('p1', 'raise', 100);

if (result.success) {
    console.log('Action successful:', result.game_state);
} else {
    console.log('Action failed:', result.error);
}
```

## 🔄 Betting Round Logic

### The Golden Rule (Prevents Infinite Loops):
A betting round ends when:
1. Every active player has **matched the highest bet** OR is all-in OR has folded
2. **AND** action returns to the **last aggressor**

### Example Flow:
```
Player A bets 100  ← (becomes last aggressor)
Player B calls 100
Player C folds
→ Action returns to Player A
→ Player A has already acted since their aggression
→ Betting round complete ✅
```

### Turn Order:
- **Preflop**: Action starts left of big blind (UTG)
- **Postflop**: Action starts left of dealer button
- **Heads-up**: Dealer acts first preflop, big blind acts first postflop

## 💰 Pot Management

### Main Pot:
When all players bet the same amount, everything goes to main pot.

### Side Pots:
Created automatically when players go all-in with different amounts:

```javascript
// Example: 
// Player A has 100 chips, goes all-in
// Player B has 500 chips, calls all-in + raises to 300
// Player C calls 300

// Result:
// Main pot: 300 chips (all 3 players eligible)
// Side pot: 400 chips (only B and C eligible)
```

## 📊 Game State

Get complete game information:

```javascript
const gameState = engine.getGameState();

console.log(gameState);
// {
//   stage: 'flop',
//   community_cards: ['Ah', 'Kd', 'Qc'],
//   pot_structure: {
//     mainPot: 200,
//     sidePots: [],
//     totalPot: 200
//   },
//   players: [...],
//   betting_round: {
//     current_player: 'p2',
//     available_actions: [...]
//   }
// }
```

## 🎪 Event System

Subscribe to game events:

```javascript
engine.setEventHandlers({
    onHandComplete: (handSummary) => {
        console.log('Hand finished:', handSummary);
    },
    
    onPlayerAction: (eventData) => {
        console.log(`${eventData.player_id} ${eventData.action.type}`);
    },
    
    onStageChange: (eventData) => {
        console.log(`Stage: ${eventData.stage}`);
    }
});
```

## 🛡️ Error Handling

The engine validates all actions:

```javascript
// Wrong player's turn
engine.handleAction('p2', 'call'); 
// → { success: false, error: "Not p2's turn" }

// Invalid action
engine.handleAction('p1', 'check'); 
// → { success: false, error: "Cannot check - must call or raise" }

// Insufficient chips
engine.handleAction('p1', 'raise', 9999); 
// → { success: false, error: "Raise amount exceeds stack" }
```

## 🧪 Testing

Run basic tests:
```bash
node engine/test.js
```

Run examples:
```bash
node engine/example.js
```

## 🎯 Integration with Express API

```javascript
// In your routes/games.js
const { PokerEngine } = require('../engine');

app.post('/api/action', async (req, res) => {
    const { playerId, action, amount } = req.body;
    
    try {
        const result = engine.handleAction(playerId, action, amount);
        res.json(result);
        
        // Broadcast to other players via Socket.io
        io.emit('gameUpdate', result.game_state);
        
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});
```

## 📋 Game Stages

| Stage | Community Cards | Actions |
|-------|----------------|---------|
| `waiting` | 0 | Can start new hand |
| `pre_flop` | 0 | Initial betting with blinds |
| `flop` | 3 | Betting after flop |
| `turn` | 4 | Betting after turn |
| `river` | 5 | Final betting round |
| `showdown` | 5 | Determine winner |
| `complete` | 5 | Hand finished, ready for next |

## ⚙️ Configuration Options

```javascript
const engine = new PokerEngine(players, {
    gameId: 'custom_game_id',    // Unique game identifier
    tableId: 'table_1',          // Table identifier  
    smallBlind: 25,              // Small blind amount
    bigBlind: 50                 // Big blind amount
});
```

## 🔍 Private vs Public Information

```javascript
// Public info (for all players)
const publicState = engine.getGameState();

// Private info (includes hole cards)
const privateInfo = engine.getPrivatePlayerInfo('p1');
```

## 🚫 Common Pitfalls Prevented

1. **Infinite Check Loops**: ✅ Prevented by last aggressor rule
2. **Wrong Turn Order**: ✅ Proper heads-up and multi-player logic
3. **Incorrect Side Pots**: ✅ Automatic calculation
4. **Invalid Actions**: ✅ Comprehensive validation
5. **Missing Blinds**: ✅ Automatic blind posting
6. **Dealer Button**: ✅ Proper advancement between hands

## 📈 Performance Notes

- Designed for real-time play
- Minimal memory footprint
- Stateless validation (can be serialized/deserialized)
- Efficient side pot calculations
- Built-in game state validation

## 🔧 Extending the Engine

The modular design allows easy customization:

- `BettingRound`: Modify betting rules
- `PotManager`: Add jackpot/rake logic  
- `PokerEngine`: Add tournament features
- Event system: Add custom game events

---

Built with ❤️ for serious poker applications.