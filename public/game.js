(() => {
  // Board and game definitions must mirror the server
  const CELL_SIZE = 30;
  const COLOR_START = { red: 0, green: 13, yellow: 26, blue: 39 };
  const SAFE_INDICES = [0, 8, 13, 21, 26, 34, 39, 47];
  // Define the sequence of coordinates for the 52 main track positions
  const boardMapping = [
    [1, 6], [2, 6], [3, 6], [4, 6], [5, 6], [6, 6],
    [6, 5], [6, 4], [6, 3], [6, 2], [6, 1], [6, 0],
    [7, 0], [8, 0], [8, 1], [8, 2], [8, 3], [8, 4],
    [8, 5], [8, 6], [9, 6], [10, 6], [11, 6], [12, 6],
    [13, 6], [14, 6], [14, 7], [14, 8], [13, 8], [12, 8],
    [11, 8], [10, 8], [9, 8], [8, 8], [8, 9], [8, 10],
    [8, 11], [8, 12], [8, 13], [8, 14], [7, 14], [6, 14],
    [6, 13], [6, 12], [6, 11], [6, 10], [6, 9], [6, 8],
    [5, 8], [4, 8], [3, 8], [2, 8]
  ];
  // Final path coordinates for each color (6 cells to center)
  const finalMapping = {
    red:    [[1,7],[2,7],[3,7],[4,7],[5,7],[6,7]],
    green:  [[7,1],[7,2],[7,3],[7,4],[7,5],[7,6]],
    yellow: [[13,7],[12,7],[11,7],[10,7],[9,7],[8,7]],
    blue:   [[7,13],[7,12],[7,11],[7,10],[7,9],[7,8]],
  };
  // Home positions for each color (for 4 tokens)
  const homePositions = {
    red:    [[1,1],[1,3],[3,1],[3,3]],
    green:  [[1,11],[1,13],[3,11],[3,13]],
    yellow: [[11,1],[11,3],[13,1],[13,3]],
    blue:   [[11,11],[11,13],[13,11],[13,13]],
  };

  // State object to track game data
  const state = {
    ws: null,
    myId: null,
    myColor: null,
    players: {}, // playerId -> {id,name,color,ready,positions:[-1,..]}
    order: [],   // array of playerIds in join order
    turnPlayerId: null,
    gameStarted: false,
    currentRoll: 0,
    movableTokens: [],
  };

  // DOM elements
  const setupPanel = document.getElementById('setup');
  const serverInput = document.getElementById('serverUrl');
  const roomInput = document.getElementById('roomId');
  const nameInput = document.getElementById('playerName');
  const colorSelect = document.getElementById('playerColor');
  const joinBtn = document.getElementById('joinBtn');

  const gameArea = document.getElementById('game');
  const playersList = document.getElementById('playersList');
  const readyBtn = document.getElementById('readyBtn');
  const startBtn = document.getElementById('startBtn');
  const rollBtn = document.getElementById('rollBtn');
  const diceDisplay = document.getElementById('diceDisplay');
  const boardEl = document.getElementById('board');

  // Token DOM storage: playerId -> [token elements]
  const tokenElements = {};

  // Create board grid cells and assign classes
  function drawBoard() {
    // Clear existing
    boardEl.innerHTML = '';
    const cells = [];
    for (let r = 0; r < 15; r++) {
      for (let c = 0; c < 15; c++) {
        const cell = document.createElement('div');
        cell.classList.add('cell');
        cell.dataset.row = r;
        cell.dataset.col = c;
        boardEl.appendChild(cell);
        cells.push(cell);
      }
    }
    // Mark main track
    boardMapping.forEach(([r,c]) => {
      const idx = r * 15 + c;
      cells[idx].classList.add('main-track');
    });
    // Mark safe squares
    SAFE_INDICES.forEach((gi) => {
      const [r,c] = boardMapping[gi];
      const idx = r * 15 + c;
      cells[idx].classList.add('safe');
    });
    // Mark final paths
    Object.keys(finalMapping).forEach(color => {
      finalMapping[color].forEach(([r,c]) => {
        const idx = r * 15 + c;
        cells[idx].classList.add(`final-${color}`);
      });
    });
    // Mark home zones
    Object.keys(homePositions).forEach(color => {
      homePositions[color].forEach(([r,c]) => {
        const idx = r * 15 + c;
        cells[idx].classList.add(`home-${color}`);
      });
    });
  }

  // Compute screen coordinates for a token based on its game position
  function getCoordinates(color, tokenIndex) {
    const player = state.players[state.myId] || {};
    const positions = player.positions || [];
    const pos = positions[tokenIndex];
    if (pos === undefined) return {top:0,left:0};
    let row, col;
    if (pos < 0) {
      // Home
      const coords = homePositions[color][tokenIndex];
      [row,col] = coords;
    } else if (pos <= 51) {
      // Main track
      const globalIndex = (COLOR_START[color] + pos) % 52;
      [row,col] = boardMapping[globalIndex];
    } else {
      // Final path
      const offset = pos - 52;
      const coords = finalMapping[color][offset];
      [row,col] = coords;
    }
    const top = row * CELL_SIZE + 5; // center within cell
    const left = col * CELL_SIZE + 5;
    return { top, left };
  }

  // Update players list UI
  function updatePlayersList() {
    playersList.innerHTML = '';
    state.order.forEach((pid) => {
      const p = state.players[pid];
      if (!p) return;
      const li = document.createElement('li');
      const indicator = document.createElement('span');
      indicator.classList.add('color-indicator');
      indicator.style.background = tokenColor(p.color);
      li.appendChild(indicator);
      const nameSpan = document.createElement('span');
      nameSpan.textContent = `${p.name}`;
      if (p.id === state.turnPlayerId && state.gameStarted) {
        nameSpan.style.fontWeight = 'bold';
      }
      li.appendChild(nameSpan);
      if (p.ready && !state.gameStarted) {
        const r = document.createElement('span');
        r.textContent = ' ✅';
        li.appendChild(r);
      }
      playersList.appendChild(li);
    });
  }

  function tokenColor(color) {
    switch(color) {
      case 'red': return '#e53935';
      case 'green': return '#43a047';
      case 'yellow': return '#fbc02d';
      case 'blue': return '#1e88e5';
      default: return '#ccc';
    }
  }

  // Create token elements for all players
  function ensureTokens() {
    Object.values(state.players).forEach((player) => {
      if (!tokenElements[player.id]) {
        tokenElements[player.id] = [];
        for (let i = 0; i < 4; i++) {
          const token = document.createElement('div');
          token.classList.add('token', player.color);
          token.dataset.playerId = player.id;
          token.dataset.tokenIndex = i;
          token.addEventListener('click', onTokenClick);
          token.style.zIndex = 10; // ensure above cells
          boardEl.appendChild(token);
          tokenElements[player.id].push(token);
        }
      }
    });
  }

  // Update positions of tokens visually
  function updateTokenPositions() {
    Object.values(state.players).forEach((player) => {
      const tokens = tokenElements[player.id] || [];
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        const positions = player.positions || [];
        const pos = positions[i];
        let row, col;
        if (pos === -1) {
          [row,col] = homePositions[player.color][i];
        } else if (pos <= 51) {
          const globalIndex = (COLOR_START[player.color] + pos) % 52;
          [row,col] = boardMapping[globalIndex];
        } else {
          const offset = pos - 52;
          [row,col] = finalMapping[player.color][offset];
        }
        const top = row * CELL_SIZE + 5;
        const left = col * CELL_SIZE + 5;
        token.style.top = `${top}px`;
        token.style.left = `${left}px`;
        // Remove movable highlight for all tokens initially
        token.classList.remove('movable');
        // Slightly offset tokens of same color at same position to avoid overlap
        // We'll offset based on token index
        let offsetX = 0;
        let offsetY = 0;
        // Count how many tokens share this cell for this player
        const tokensAtSame = tokens.filter((t, idx) => {
          const posAt = positions[idx];
          let r2,c2;
          if (posAt === -1) {
            [r2,c2] = homePositions[player.color][idx];
          } else if (posAt <= 51) {
            const gi2 = (COLOR_START[player.color] + posAt) % 52;
            [r2,c2] = boardMapping[gi2];
          } else {
            const off2 = posAt - 52;
            [r2,c2] = finalMapping[player.color][off2];
          }
          return r2 === row && c2 === col;
        });
        const indexInStack = tokensAtSame.indexOf(token);
        if (tokensAtSame.length > 1) {
          // Spread in a small square
          const spacing = 4;
          const rowOffset = Math.floor(indexInStack / 2);
          const colOffset = indexInStack % 2;
          offsetX = colOffset * spacing;
          offsetY = rowOffset * spacing;
        }
        token.style.top = `${top + offsetY}px`;
        token.style.left = `${left + offsetX}px`;
      }
    });
  }

  function onTokenClick(e) {
    const token = e.currentTarget;
    if (!state.gameStarted) return;
    const tokenIndex = parseInt(token.dataset.tokenIndex);
    const playerId = token.dataset.playerId;
    if (playerId !== state.myId) return;
    // Only handle click if token is in movable list
    if (!state.movableTokens.includes(tokenIndex)) return;
    // Send move request
    state.ws.send(JSON.stringify({ type: 'move', tokenIndex }));
    // Disable further clicks until next roll
    state.movableTokens = [];
    hideRoll();
  }

  function showRoll() {
    rollBtn.classList.remove('hidden');
  }
  function hideRoll() {
    rollBtn.classList.add('hidden');
  }
  function showStart() {
    startBtn.classList.remove('hidden');
  }
  function hideStart() {
    startBtn.classList.add('hidden');
  }

  // Handle WebSocket messages from server
  function handleMessage(evt) {
    let data;
    try {
      data = JSON.parse(evt.data);
    } catch (err) {
      console.error('Invalid JSON:', evt.data);
      return;
    }
    switch(data.type) {
      case 'joined': {
        state.myId = data.playerId;
        state.myColor = data.color;
        // Initialize players list
        state.players = {};
        state.order = [];
        data.players.forEach(p => {
          state.players[p.id] = { id: p.id, name: p.name, color: p.color, ready: p.ready, positions: [-1,-1,-1,-1] };
          state.order.push(p.id);
        });
        // Prepare UI
        ensureTokens();
        updateTokenPositions();
        updatePlayersList();
        break;
      }
      case 'player_list': {
        // Update or add players
        data.players.forEach(p => {
          if (!state.players[p.id]) {
            state.players[p.id] = { id: p.id, name: p.name, color: p.color, ready: p.ready, positions: [-1,-1,-1,-1] };
            state.order.push(p.id);
          } else {
            state.players[p.id].name = p.name;
            state.players[p.id].color = p.color;
            state.players[p.id].ready = p.ready;
          }
        });
        ensureTokens();
        updatePlayersList();
        break;
      }
      case 'game_started': {
        state.gameStarted = true;
        hideStart();
        hideRoll();
        readyBtn.classList.add('hidden');
        diceDisplay.textContent = '';
        // Update state positions
        data.state.forEach((p) => {
          if (state.players[p.id]) {
            state.players[p.id].positions = p.positions.slice();
          }
        });
        state.turnPlayerId = data.turnPlayerId;
        updatePlayersList();
        updateTokenPositions();
        // Show roll if it's our turn
        if (state.turnPlayerId === state.myId) showRoll();
        break;
      }
      case 'roll_result': {
        state.currentRoll = data.roll;
        diceDisplay.textContent = `🎲 ${data.roll}`;
        state.movableTokens = [];
        if (data.playerId === state.myId) {
          state.movableTokens = data.moves;
          // Highlight movable tokens
          const tokens = tokenElements[state.myId];
          tokens.forEach((tk, idx) => {
            if (state.movableTokens.includes(idx)) {
              tk.classList.add('movable');
            } else {
              tk.classList.remove('movable');
            }
          });
          // If no moves or skipTurn, the server will handle next turn; hide roll immediately
          hideRoll();
        }
        break;
      }
      case 'state_update': {
        const { playerId, positions } = data;
        if (state.players[playerId]) {
          state.players[playerId].positions = positions.slice();
        }
        updateTokenPositions();
        break;
      }
      case 'turn': {
        state.turnPlayerId = data.playerId;
        updatePlayersList();
        // Clear movable highlights
        Object.values(tokenElements).forEach(arr => arr.forEach(el => el.classList.remove('movable')));
        // Show roll button only if it's our turn and game started
        if (state.turnPlayerId === state.myId && state.gameStarted) {
          showRoll();
        } else {
          hideRoll();
        }
        break;
      }
      case 'player_finished': {
        // Could mark player as finished; for now just update UI
        break;
      }
      case 'error': {
        alert(data.message);
        break;
      }
    }
  }

  // Event handlers for buttons
  joinBtn.addEventListener('click', () => {
    const server = serverInput.value.trim();
    const room = roomInput.value.trim();
    const name = nameInput.value.trim();
    const color = colorSelect.value;
    if (!server || !room) {
      alert('Please enter server URL and room ID');
      return;
    }
    // Connect websocket
    let ws;
    try {
      ws = new WebSocket(server.replace(/^http/,'ws'));
    } catch (err) {
      alert('Invalid server URL');
      return;
    }
    state.ws = ws;
    ws.onopen = () => {
      // Send join message
      ws.send(JSON.stringify({ type: 'join', roomId: room, name, color }));
      setupPanel.classList.add('hidden');
      gameArea.classList.remove('hidden');
      drawBoard();
    };
    ws.onmessage = handleMessage;
    ws.onclose = () => {
      alert('Disconnected from server');
      location.reload();
    };
    ws.onerror = (err) => {
      console.error('WebSocket error', err);
    };
  });

  readyBtn.addEventListener('click', () => {
    if (state.ws) {
      state.ws.send(JSON.stringify({ type: 'ready' }));
      readyBtn.disabled = true;
    }
  });

  startBtn.addEventListener('click', () => {
    if (state.ws) {
      state.ws.send(JSON.stringify({ type: 'start' }));
    }
  });

  rollBtn.addEventListener('click', () => {
    if (state.ws) {
      state.ws.send(JSON.stringify({ type: 'roll' }));
      // Prevent multiple rolls until server responds
      hideRoll();
    }
  });

  // Observe state to show start button for host (first player) when ready
  const observer = new MutationObserver(() => {
    // Determine if current user is the first player and all players ready
    if (!state.gameStarted) {
      const allReady = state.order.length >= 2 && state.order.every(pid => state.players[pid] && state.players[pid].ready);
      const isHost = state.order[0] === state.myId;
      if (isHost && allReady) {
        showStart();
      } else {
        hideStart();
      }
    }
  });
  observer.observe(playersList, { childList: true, subtree: true });

})();
