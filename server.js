const express = require('express');
const expressWs = require('express-ws');

const app = express();
expressWs(app);

// Serve static files from the public directory
app.use(express.static('public'));

// In-memory storage for game rooms
const rooms = new Map();

// Safe squares on the main track (global board indices)
const SAFE_INDICES = [0, 8, 13, 21, 26, 34, 39, 47];

// Starting offset for each color on the main track
const COLOR_START = {
  red: 0,
  green: 13,
  yellow: 26,
  blue: 39,
};

// Utility to generate a random unique id for a new player
function makeId() {
  return Math.random().toString(36).substr(2, 9);
}

// Create a new game room
function createRoom(roomId) {
  return {
    id: roomId,
    players: [],
    turnIndex: 0,
    currentRoll: 0,
    consecutiveSixes: 0,
    gameStarted: false,
  };
}

// Get or create a room
function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, createRoom(roomId));
  }
  return rooms.get(roomId);
}

// Broadcast a message to all players in a room
function broadcast(room, data) {
  const message = JSON.stringify(data);
  room.players.forEach((player) => {
    if (player.ws && player.ws.readyState === 1) {
      try {
        player.ws.send(message);
      } catch (err) {
        console.error('Send error:', err);
      }
    }
  });
}

// Compute the global board index for a player's token position
function computeGlobalIndex(color, pos) {
  if (pos < 0) return -1; // home
  if (pos <= 51) {
    // Main track
    const start = COLOR_START[color];
    return (start + pos) % 52;
  } else {
    // Final path positions are offset to avoid collisions with main track
    // We offset final path indices by 100 + color-specific offset so they never conflict with others
    const colorOffset = { red: 0, green: 10, yellow: 20, blue: 30 };
    return 100 + colorOffset[color] + (pos - 52);
  }
}

// Determine possible moves for a player given a roll
function computeMovableTokens(room, player, roll) {
  const moves = [];
  const positions = player.positions;
  for (let i = 0; i < positions.length; i++) {
    const pos = positions[i];
    if (pos === -1) {
      // At home; can only move out on a six
      if (roll === 6) {
        // Starting position always available
        moves.push(i);
      }
      continue;
    }
    let newPos = pos + roll;
    if (pos < 52) {
      // Currently on main track
      if (newPos <= 51) {
        moves.push(i);
      } else {
        // entering final path
        const diff = newPos - 51; // how many steps into final path
        if (diff <= 6) {
          moves.push(i);
        }
      }
    } else {
      // Currently on final path (52..57)
      if (newPos <= 57) {
        moves.push(i);
      }
    }
  }
  return moves;
}

// Advance the turn to the next active player
function nextTurn(room) {
  if (room.players.length === 0) return;
  // Advance turn index skipping finished players
  const startIndex = room.turnIndex;
  let idx = (room.turnIndex + 1) % room.players.length;
  let iterations = 0;
  while (iterations < room.players.length) {
    const p = room.players[idx];
    // A player is considered active if not all tokens are finished
    const finishedCount = p.positions.filter((pos) => pos === 57).length;
    if (finishedCount < 4) {
      room.turnIndex = idx;
      return;
    }
    idx = (idx + 1) % room.players.length;
    iterations++;
  }
  // All players finished; keep index
}

// Handle a move for a given token index
function performMove(room, player, tokenIndex, roll) {
  const pos = player.positions[tokenIndex];
  let newPos;
  let captured = false;
  if (pos === -1) {
    // Move out of home to starting cell
    newPos = 0;
  } else {
    newPos = pos + roll;
    if (pos < 52 && newPos > 51) {
      // entering final path
      const diff = newPos - 51; // steps into final path
      newPos = 51 + diff;
    }
  }
  // Check capturing: if moving on main track (newPos <= 51)
  if (newPos <= 51) {
    const targetGlobal = computeGlobalIndex(player.color, newPos);
    room.players.forEach((opponent) => {
      if (opponent.id !== player.id) {
        opponent.positions.forEach((oppPos, idx) => {
          // Only capture opponent tokens on main track
          if (oppPos >= 0 && oppPos <= 51) {
            const oppGlobal = computeGlobalIndex(opponent.color, oppPos);
            if (oppGlobal === targetGlobal && !SAFE_INDICES.includes(targetGlobal)) {
              // Capture: send opponent token back to home
              opponent.positions[idx] = -1;
              captured = true;
            }
          }
        });
      }
    });
  }
  // Update player's token position
  player.positions[tokenIndex] = newPos;
  // Check for finishing: if reached final cell (57)
  const finishedNow = newPos === 57;
  return { captured, finishedNow };
}

// WebSocket endpoint for realtime game communication
app.ws('/ws', (ws, req) => {
  let currentRoom = null;
  let currentPlayer = null;

  ws.on('message', (msg) => {
    let data;
    try {
      data = JSON.parse(msg);
    } catch (err) {
      console.error('Invalid message:', msg);
      return;
    }
    // Handle different message types
    if (data.type === 'join') {
      const { roomId, name, color } = data;
      const room = getRoom(roomId);
      // Check if game started
      if (room.gameStarted) {
        ws.send(
          JSON.stringify({ type: 'error', message: 'Game already started for this room' })
        );
        return;
      }
      // Check for duplicate color
      const takenColors = room.players.map((p) => p.color);
      let chosenColor = color;
      if (!color || takenColors.includes(color)) {
        // Assign first available color
        const available = ['red', 'green', 'yellow', 'blue'].find((c) => !takenColors.includes(c));
        chosenColor = available;
      }
      const playerId = makeId();
      const player = {
        id: playerId,
        name: name || `Player ${room.players.length + 1}`,
        color: chosenColor,
        ws,
        ready: false,
        positions: [-1, -1, -1, -1],
      };
      room.players.push(player);
      currentRoom = room;
      currentPlayer = player;
      // Notify the player of their assigned color and id
      ws.send(
        JSON.stringify({ type: 'joined', playerId, color: chosenColor, players: room.players.map((p) => ({ id: p.id, name: p.name, color: p.color, ready: p.ready })) })
      );
      // Broadcast updated player list to others
      broadcast(room, {
        type: 'player_list',
        players: room.players.map((p) => ({ id: p.id, name: p.name, color: p.color, ready: p.ready })),
      });
    }
    else if (data.type === 'ready' && currentRoom && currentPlayer) {
      currentPlayer.ready = true;
      broadcast(currentRoom, {
        type: 'player_list',
        players: currentRoom.players.map((p) => ({ id: p.id, name: p.name, color: p.color, ready: p.ready })),
      });
    }
    else if (data.type === 'start' && currentRoom && currentPlayer) {
      // Only allow starting if all players are ready and at least 2 players
      if (currentRoom.gameStarted) return;
      if (currentRoom.players.length < 2) {
        ws.send(JSON.stringify({ type: 'error', message: 'Need at least 2 players to start' }));
        return;
      }
      const allReady = currentRoom.players.every((p) => p.ready);
      if (!allReady) {
        ws.send(JSON.stringify({ type: 'error', message: 'All players must be ready' }));
        return;
      }
      currentRoom.gameStarted = true;
      currentRoom.turnIndex = 0;
      currentRoom.currentRoll = 0;
      currentRoom.consecutiveSixes = 0;
      // Notify players that the game has started and whose turn it is
      broadcast(currentRoom, {
        type: 'game_started',
        turnPlayerId: currentRoom.players[0].id,
        state: currentRoom.players.map((p) => ({ id: p.id, positions: p.positions }))
      });
    }
    else if (data.type === 'roll' && currentRoom && currentPlayer) {
      // Ensure it's this player's turn
      const currentTurnPlayer = currentRoom.players[currentRoom.turnIndex];
      if (currentTurnPlayer.id !== currentPlayer.id) return;
      // Generate a die roll 1..6
      const die = Math.floor(Math.random() * 6) + 1;
      currentRoom.currentRoll = die;
      if (die === 6) {
        currentRoom.consecutiveSixes += 1;
      } else {
        currentRoom.consecutiveSixes = 0;
      }
      // Compute movable tokens
      const moves = computeMovableTokens(currentRoom, currentPlayer, die);
      // If no moves, pass turn (unless we have multiple rolls)
      let mustPass = moves.length === 0;
      // If three consecutive sixes, skip this turn completely
      let skipTurn = false;
      if (die === 6 && currentRoom.consecutiveSixes >= 3) {
        skipTurn = true;
        currentRoom.consecutiveSixes = 0;
      }
      // Inform players of the roll result and available moves
      broadcast(currentRoom, {
        type: 'roll_result',
        playerId: currentPlayer.id,
        roll: die,
        moves,
      });
      if (skipTurn || mustPass) {
        // Pass the turn
        nextTurn(currentRoom);
        broadcast(currentRoom, { type: 'turn', playerId: currentRoom.players[currentRoom.turnIndex].id });
      }
    }
    else if (data.type === 'move' && currentRoom && currentPlayer) {
      const { tokenIndex } = data;
      // Ensure it's current player's turn
      const currentTurnPlayer = currentRoom.players[currentRoom.turnIndex];
      if (currentTurnPlayer.id !== currentPlayer.id) return;
      const roll = currentRoom.currentRoll;
      // Validate that tokenIndex is an available move
      const available = computeMovableTokens(currentRoom, currentPlayer, roll);
      if (!available.includes(tokenIndex)) return;
      // Perform the move
      const result = performMove(currentRoom, currentPlayer, tokenIndex, roll);
      // Broadcast updated state
      broadcast(currentRoom, {
        type: 'state_update',
        playerId: currentPlayer.id,
        positions: currentPlayer.positions,
        move: { tokenIndex, roll },
        captured: result.captured,
        finished: result.finishedNow,
      });
      // Check if current player has all tokens finished
      const finishedCount = currentPlayer.positions.filter((p) => p === 57).length;
      if (finishedCount === 4) {
        // Mark player as finished (they are effectively out of turn rotation)
        // We do not remove them to keep consistent indexes; just treat them as finished
        broadcast(currentRoom, { type: 'player_finished', playerId: currentPlayer.id });
      }
      // Determine if player gets another turn
      let extraTurn = false;
      if (roll === 6 && currentRoom.consecutiveSixes > 0) {
        // Already handled consecutive six logic; if not skip this time, but it's a six so extra turn
        extraTurn = true;
      }
      if (result.captured || result.finishedNow) {
        extraTurn = true;
      }
      if (!extraTurn) {
        // Move to next turn
        currentRoom.consecutiveSixes = 0;
        nextTurn(currentRoom);
      }
      // Reset current roll (so next roll is fresh)
      currentRoom.currentRoll = 0;
      // Notify players of the next turn
      broadcast(currentRoom, { type: 'turn', playerId: currentRoom.players[currentRoom.turnIndex].id });
    }
  });

  ws.on('close', () => {
  // Remove player from room
  if (currentRoom && currentPlayer) {
    currentRoom.players = currentRoom.players.filter((p) => p.id !== currentPlayer.id);
    // Adjust turn index if needed
    if (currentRoom.turnIndex >= currentRoom.players.length) {
      currentRoom.turnIndex = 0;
    }
    // Inform other players
    broadcast(currentRoom, {
      type: 'player_list',
      players: currentRoom.players.map((p) => ({ id: p.id, name: p.name, color: p.color, ready: p.ready }))
    });
    // If no players left, remove room
    if (currentRoom.players.length === 0) {
      rooms.delete(currentRoom.id);
    }
  }
  });
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Ludo server listening on port ${PORT}`);
});
