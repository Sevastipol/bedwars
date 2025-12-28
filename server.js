const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => console.log(`Server on port ${PORT}`));

// Config
const BLOCK_TYPES = {
    'Grass': { color: 0x4d9043, cost: { iron: 5 }, breakTime: 1.2, buyAmount: 8, hasTexture: true },
    'Glass': { color: 0xade8f4, cost: { iron: 5 }, breakTime: 0.4, buyAmount: 16, opacity: 0.6 },
    'Wood': { color: 0x5d4037, cost: { gold: 5 }, breakTime: 3, buyAmount: 32, hasTexture: true },
    'Stone': { color: 0x777777, cost: { gold: 5 }, breakTime: 6, buyAmount: 8, hasTexture: true },
    'Obsidian': { color: 0x111111, cost: { emerald: 1 }, breakTime: 12, buyAmount: 1, hasTexture: true },
    'Bed': { color: 0xff0000, breakTime: 2, buyAmount: 1, hasTexture: false }
};
const MAX_STACK = 64;
const INVENTORY_SIZE = 9;
const BED_DESTRUCTION_TIME = 10 * 60 * 1000;
const ROUND_DURATION = 15 * 60 * 1000;

// State
const blocks = new Map();
const pickups = new Map();
const spawners = [];
const players = new Map();
const chatMessages = [];
let gameState = 'waiting';
let countdownTimer = null;
let roundStartTime = null;
let suddenDeath = false;

function blockKey(x, y, z) {
    return `${x},${y},${z}`;
}

function addBlock(x, y, z, type) {
    const key = blockKey(x, y, z);
    if (blocks.has(key)) return false;
    blocks.set(key, type);
    io.emit('addBlock', { x, y, z, type });
    return true;
}

function removeBlock(x, y, z) {
    const key = blockKey(x, y, z);
    if (!blocks.has(key)) return false;
    const type = blocks.get(key);
    blocks.delete(key);
    io.emit('removeBlock', { x, y, z });
    if (type === 'Bed') {
        players.forEach((p, id) => {
            if (p.bedPos && p.bedPos.x === x && p.bedPos.y === y && p.bedPos.z === z) {
                p.bedPos = null;
                io.to(id).emit('bedDestroyed');
            }
        });
    }
    return true;
}

function spawnPickup(x, y, z, resourceType) {
    const id = `${Date.now()}-${Math.random().toString(36).substring(7)}`;
    pickups.set(id, { x, y, z, resourceType });
    io.emit('addPickup', { id, x, y, z, resourceType });
}

function addToInventory(inv, type, amount) {
    let remaining = amount;
    for (let i = 0; i < INVENTORY_SIZE; i++) {
        if (inv[i] && inv[i].type === type && inv[i].count < MAX_STACK) {
            const space = MAX_STACK - inv[i].count;
            const add = Math.min(space, remaining);
            inv[i].count += add;
            remaining -= add;
            if (remaining === 0) return true;
        }
    }
    for (let i = 0; i < INVENTORY_SIZE; i++) {
        if (!inv[i]) {
            const add = Math.min(MAX_STACK, remaining);
            inv[i] = { type, count: add };
            remaining -= add;
            if (remaining === 0) return true;
        }
    }
    return remaining === 0;
}

function canAfford(currency, cost) {
    for (const [res, amt] of Object.entries(cost)) {
        if ((currency[res] || 0) < amt) return false;
    }
    return true;
}

function deductCurrency(currency, cost) {
    for (const [res, amt] of Object.entries(cost)) {
        currency[res] -= amt;
    }
}

function generatePlayerName() {
    const adjectives = ['Quick', 'Brave', 'Silent', 'Clever', 'Mighty', 'Swift', 'Wise', 'Fierce', 'Noble', 'Cunning'];
    const nouns = ['Fox', 'Wolf', 'Eagle', 'Bear', 'Lion', 'Tiger', 'Dragon', 'Phoenix', 'Shark', 'Panther'];
    const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const noun = nouns[Math.floor(Math.random() * nouns.length)];
    const num = Math.floor(Math.random() * 99) + 1;
    return `${adj}${noun}${num}`;
}

function createIsland(offsetX, offsetZ, spawnerType = null) {
    for (let x = 0; x < 6; x++) {
        for (let z = 0; z < 6; z++) {
            addBlock(offsetX + x, 0, offsetZ + z, 'Grass');
        }
    }
    if (spawnerType) {
        const s = {
            x: offsetX + 2.5, y: 1, z: offsetZ + 2.5,
            resourceType: spawnerType.type,
            interval: spawnerType.interval * 1000,
            lastSpawn: Date.now()
        };
        spawners.push(s);
    }
}

const playerIslands = [
    {offsetX: -15, offsetZ: -15, bedX: -14, bedY: 1, bedZ: -14},
    {offsetX: 33, offsetZ: -15, bedX: 34, bedY: 1, bedZ: -14},
    {offsetX: -15, offsetZ: 33, bedX: -14, bedY: 1, bedZ: 34},
    {offsetX: 33, offsetZ: 33, bedX: 34, bedY: 1, bedZ: 34}
];

function initWorld() {
    blocks.clear();
    pickups.clear();
    spawners.length = 0;
    createIsland(-15, -15, { type: 'iron', interval: 3 });
    createIsland(33, -15, { type: 'iron', interval: 3 });
    createIsland(-15, 33, { type: 'iron', interval: 3 });
    createIsland(33, 33, { type: 'iron', interval: 3 });
    createIsland(9, -15, { type: 'gold', interval: 8 });
    createIsland(9, 33, { type: 'gold', interval: 8 });
    createIsland(9, 9, { type: 'emerald', interval: 10 });
}

initWorld();

function resetGame() {
    initWorld();
    const initBlocks = Array.from(blocks, ([key, type]) => {
        const [x, y, z] = key.split(',').map(Number);
        return { x, y, z, type };
    });
    const initPickups = Array.from(pickups, ([id, data]) => ({ id, ...data }));
    let availableIslands = [...playerIslands];
    players.forEach((p, id) => {
        if (p.spectator) return;
        
        p.inventory = new Array(INVENTORY_SIZE).fill(null);
        p.currency = { iron: 0, gold: 0, emerald: 0 };
        p.selected = 0;
        p.rot = { yaw: 0, pitch: 0 };
        p.crouch = false;
        p.lastRespawn = 0;
        p.bedPos = null;
        p.spectator = false;
        
        if (availableIslands.length > 0) {
            const island = availableIslands.shift();
            addBlock(island.bedX, island.bedY, island.bedZ, 'Bed');
            p.bedPos = { x: island.bedX, y: island.bedY, z: island.bedZ };
            p.pos = { x: island.bedX + 0.5, y: island.bedY + 2, z: island.bedZ + 0.5 };
        } else {
            p.pos = { x: 9 + 2.5, y: 5, z: 9 + 2.5 };
        }
        io.to(id).emit('playerReset', {
            pos: p.pos,
            rot: p.rot,
            inventory: p.inventory,
            currency: p.currency,
            spectator: false
        });
    });
    io.emit('worldReset', { blocks: initBlocks, pickups: initPickups, spawners });
    gameState = 'waiting';
    suddenDeath = false;
    roundStartTime = null;
    
    // Clear any existing countdown
    if (countdownTimer) {
        clearInterval(countdownTimer);
        countdownTimer = null;
    }
}

// Helper to count active (non-spectator) players
function getActivePlayerCount() {
    return Array.from(players.values()).filter(p => !p.spectator).length;
}

// Function to check if we should start the game
function checkGameStart() {
    // Only start if we're in waiting state and have at least 2 active players
    if (gameState === 'waiting' && getActivePlayerCount() >= 2) {
        startGameCountdown();
    }
}

// Function to start the game countdown
function startGameCountdown() {
    if (countdownTimer) {
        clearInterval(countdownTimer);
    }
    
    let count = 10;
    io.emit('notification', 'Game starting in 10 seconds!');
    countdownTimer = setInterval(() => {
        if (getActivePlayerCount() < 2) {
            // Not enough players, cancel countdown
            clearInterval(countdownTimer);
            countdownTimer = null;
            io.emit('notification', 'Not enough players to start game!');
            return;
        }
        
        io.emit('countdown', count);
        count--;
        if (count < 0) {
            clearInterval(countdownTimer);
            countdownTimer = null;
            gameState = 'playing';
            roundStartTime = Date.now();
            io.emit('gameStart');
            io.emit('notification', 'Game started!');
        }
    }, 1000);
}

io.on('connection', (socket) => {
    console.log(`New connection: ${socket.id}`);
    const playerName = generatePlayerName();
    
    const playerState = {
        pos: { x: 9 + 2.5, y: 5, z: 9 + 2.5 },
        rot: { yaw: 0, pitch: 0 },
        crouch: false,
        inventory: new Array(INVENTORY_SIZE).fill(null),
        currency: { iron: 0, gold: 0, emerald: 0 },
        selected: 0,
        bedPos: null,
        lastRespawn: 0,
        spectator: false,
        name: playerName
    };
    
    let availableIslands = playerIslands.filter(island => !blocks.has(blockKey(island.bedX, island.bedY, island.bedZ)));
    if (gameState === 'waiting' && availableIslands.length > 0 && !playerState.spectator) {
        const island = availableIslands[0];
        addBlock(island.bedX, island.bedY, island.bedZ, 'Bed');
        playerState.bedPos = { x: island.bedX, y: island.bedY, z: island.bedZ };
        playerState.pos = { x: island.bedX + 0.5, y: island.bedY + 2, z: island.bedZ + 0.5 };
    }
    players.set(socket.id, playerState);

    // Send initial world
    const initBlocks = Array.from(blocks, ([key, type]) => {
        const [x, y, z] = key.split(',').map(Number);
        return { x, y, z, type };
    });
    const initPickups = Array.from(pickups, ([id, data]) => ({ id, ...data }));
    socket.emit('initWorld', { blocks: initBlocks, pickups: initPickups, spawners });

    // Send your ID and name
    socket.emit('yourId', socket.id);
    socket.emit('playerName', playerName);

    // Send recent chat messages
    socket.emit('chatHistory', chatMessages.slice(-20));

    // Send other players
    const otherPlayers = Array.from(players.entries())
        .filter(([id]) => id !== socket.id)
        .map(([id, p]) => ({ 
            id, 
            pos: p.pos, 
            rot: p.rot, 
            crouch: p.crouch, 
            name: p.name,
            spectator: p.spectator 
        }));
    socket.emit('playersSnapshot', otherPlayers);

    // Broadcast new player
    socket.broadcast.emit('newPlayer', { 
        id: socket.id, 
        pos: playerState.pos, 
        rot: playerState.rot, 
        crouch: playerState.crouch,
        name: playerState.name,
        spectator: playerState.spectator
    });

    // Broadcast join message
    const joinMsg = {
        type: 'system',
        sender: 'Server',
        message: `${playerName} joined the game`,
        timestamp: Date.now()
    };
    chatMessages.push(joinMsg);
    io.emit('chatMessage', joinMsg);

    // Check if we should start the game (only for non-spectator players)
    if (!playerState.spectator) {
        checkGameStart();
    }

    socket.on('playerUpdate', (data) => {
        const p = players.get(socket.id);
        if (p) {
            p.pos = data.pos;
            p.rot = data.rot;
            p.crouch = data.crouch;
            p.selected = data.selected;
        }
    });

    socket.on('claimPickupAttempt', (id) => {
        const p = players.get(socket.id);
        if (p.spectator || gameState !== 'playing') return;
        
        if (!pickups.has(id)) return;
        const pickup = pickups.get(id);
        const dist = Math.hypot(p.pos.x - pickup.x, p.pos.y - pickup.y, p.pos.z - pickup.z);
        if (dist >= 1.5) {
            socket.emit('revertPickup', { id, x: pickup.x, y: pickup.y, z: pickup.z, resourceType: pickup.resourceType });
            return;
        }
        const res = pickup.resourceType;
        p.currency[res]++;
        pickups.delete(id);
        io.emit('removePickup', id);
        socket.emit('updateCurrency', { ...p.currency });
    });

    socket.on('breakAttempt', ({ x, y, z }) => {
        const p = players.get(socket.id);
        if (p.spectator || gameState !== 'playing') return;
        
        const key = blockKey(x, y, z);
        if (!blocks.has(key)) {
            socket.emit('revertBreak', { x, y, z, type: null });
            return;
        }
        const dist = Math.hypot(
            p.pos.x - (x + 0.5),
            (p.pos.y - (p.crouch ? 1.3 : 1.6)) - (y + 0.5),
            p.pos.z - (z + 0.5)
        );
        if (dist > 5) {
            socket.emit('revertBreak', { x, y, z, type: blocks.get(key) });
            return;
        }
        const type = blocks.get(key);
        if (addToInventory(p.inventory, type, 1)) {
            removeBlock(x, y, z);
            socket.emit('updateInventory', p.inventory.map(slot => slot ? { ...slot } : null));
        } else {
            socket.emit('revertBreak', { x, y, z, type });
        }
    });

    socket.on('placeAttempt', ({ x, y, z, type }) => {
        const p = players.get(socket.id);
        if (p.spectator || gameState !== 'playing') return;
        
        const key = blockKey(x, y, z);
        if (blocks.has(key)) {
            socket.emit('revertPlace', { x, y, z });
            return;
        }
        const slot = p.inventory[p.selected];
        if (!slot || slot.type !== type || slot.count < 1) {
            socket.emit('revertPlace', { x, y, z });
            return;
        }
        const dist = Math.hypot(
            p.pos.x - (x + 0.5),
            (p.pos.y - (p.crouch ? 1.3 : 1.6)) - (y + 0.5),
            p.pos.z - (z + 0.5)
        );
        if (dist > 5) {
            socket.emit('revertPlace', { x, y, z });
            return;
        }
        slot.count--;
        if (slot.count === 0) p.inventory[p.selected] = null;
        addBlock(x, y, z, type);
        socket.emit('updateInventory', p.inventory.map(slot => slot ? { ...slot } : null));
    });

    socket.on('buyAttempt', (btype) => {
        const p = players.get(socket.id);
        if (p.spectator || gameState !== 'playing') return;
        
        if (btype === 'Bed') {
            socket.emit('buyFailed');
            return;
        }
        const data = BLOCK_TYPES[btype];
        if (!data) {
            socket.emit('buyFailed');
            return;
        }
        if (!canAfford(p.currency, data.cost)) {
            socket.emit('buyFailed');
            return;
        }
        if (!addToInventory(p.inventory, btype, data.buyAmount)) {
            socket.emit('buyFailed');
            return;
        }
        deductCurrency(p.currency, data.cost);
        socket.emit('updateCurrency', { ...p.currency });
        socket.emit('updateInventory', p.inventory.map(slot => slot ? { ...slot } : null));
    });

    socket.on('chatMessage', (message) => {
        const p = players.get(socket.id);
        if (!message || message.trim() === '') return;
        
        const chatMsg = {
            type: 'player',
            sender: p.name,
            senderId: socket.id,
            message: message.trim(),
            timestamp: Date.now(),
            spectator: p.spectator
        };
        
        chatMessages.push(chatMsg);
        if (chatMessages.length > 100) {
            chatMessages.shift();
        }
        
        io.emit('chatMessage', chatMsg);
    });

    socket.on('toggleSpectator', () => {
        const p = players.get(socket.id);
        const wasSpectator = p.spectator;
        p.spectator = !p.spectator;
        
        if (p.spectator) {
            // Player became spectator
            socket.emit('notification', 'You are now a spectator (Flying enabled)');
            const specMsg = {
                type: 'system',
                sender: 'Server',
                message: `${p.name} became a spectator`,
                timestamp: Date.now()
            };
            chatMessages.push(specMsg);
            io.emit('chatMessage', specMsg);
            
            // If game hasn't started and we lose an active player, stop countdown
            if (gameState === 'waiting' && countdownTimer && !wasSpectator) {
                const activeCount = getActivePlayerCount();
                if (activeCount < 2) {
                    clearInterval(countdownTimer);
                    countdownTimer = null;
                    io.emit('notification', 'Game start cancelled: not enough players');
                }
            }
        } else {
            // Player became active player
            socket.emit('notification', 'You are now a player');
            const specMsg = {
                type: 'system',
                sender: 'Server',
                message: `${p.name} joined as a player`,
                timestamp: Date.now()
            };
            chatMessages.push(specMsg);
            io.emit('chatMessage', specMsg);
            
            // Check if we should start the game
            checkGameStart();
        }
        
        io.emit('playerSpectator', { id: socket.id, spectator: p.spectator });
    });

    socket.on('disconnect', () => {
        console.log(`Disconnected: ${socket.id}`);
        const p = players.get(socket.id);
        if (p) {
            const leaveMsg = {
                type: 'system',
                sender: 'Server',
                message: `${p.name} left the game`,
                timestamp: Date.now()
            };
            chatMessages.push(leaveMsg);
            io.emit('chatMessage', leaveMsg);
            
            // If game hasn't started and we lose an active player, stop countdown
            if (gameState === 'waiting' && countdownTimer && !p.spectator) {
                const activeCount = getActivePlayerCount() - 1; // -1 because player hasn't been removed yet
                if (activeCount < 2) {
                    clearInterval(countdownTimer);
                    countdownTimer = null;
                    io.emit('notification', 'Game start cancelled: not enough players');
                }
            }
        }
        players.delete(socket.id);
        io.emit('removePlayer', socket.id);
    });
});

setInterval(() => {
    const now = Date.now();
    
    // Only spawn resources and run game logic when game is playing
    if (gameState === 'playing') {
        // Spawn resources from spawners
        spawners.forEach((s) => {
            if (now - s.lastSpawn >= s.interval) {
                spawnPickup(s.x, s.y + 0.8, s.z, s.resourceType);
                s.lastSpawn = now;
            }
        });

        const elapsed = now - roundStartTime;
        if (!suddenDeath && elapsed >= BED_DESTRUCTION_TIME) {
            Array.from(blocks.entries()).filter(([_, type]) => type === 'Bed').forEach(([key]) => {
                const [x, y, z] = key.split(',').map(Number);
                removeBlock(x, y, z);
            });
            io.emit('notification', 'Beds destroyed - SUDDEN DEATH');
            suddenDeath = true;
        }

        players.forEach((p, id) => {
            if (p.spectator) return;
            
            if (p.pos.y < -30 && now - p.lastRespawn > 2000) {
                if (p.bedPos && blocks.get(blockKey(p.bedPos.x, p.bedPos.y, p.bedPos.z)) === 'Bed') {
                    p.pos.x = p.bedPos.x + 0.5;
                    p.pos.y = p.bedPos.y + 2;
                    p.pos.z = p.bedPos.z + 0.5;
                    p.rot.yaw = 0;
                    p.rot.pitch = 0;
                    io.to(id).emit('respawn', { pos: p.pos, rot: p.rot });
                } else {
                    io.to(id).emit('notification', 'Eliminated! No bed. You can now spectate (Press P).');
                    p.spectator = true;
                    io.emit('playerSpectator', { id, spectator: true });
                    
                    const elimMsg = {
                        type: 'system',
                        sender: 'Server',
                        message: `${p.name} was eliminated`,
                        timestamp: now
                    };
                    chatMessages.push(elimMsg);
                    io.emit('chatMessage', elimMsg);
                }
                p.lastRespawn = now;
            }
        });

        const activePlayers = Array.from(players.values()).filter(p => !p.spectator);
        if (activePlayers.length === 1) {
            const winnerId = Array.from(players.entries())
                .find(([id, p]) => !p.spectator)[0];
            const winnerName = players.get(winnerId).name;
            io.emit('gameEnd', { winner: winnerId, winnerName });
            setTimeout(resetGame, 5000);
        } else if (activePlayers.length === 0) {
            resetGame();
        }
    }

    const states = Array.from(players.entries()).map(([id, p]) => {
        return { 
            id, 
            pos: p.pos, 
            rot: p.rot, 
            crouch: p.crouch,
            spectator: p.spectator 
        };
    });
    io.emit('playersUpdate', states);
}, 50);
