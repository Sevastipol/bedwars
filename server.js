const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// Config
const BLOCK_TYPES = {
    'Grass': { color: 0x4d9043, cost: { iron: 5 }, breakTime: 1.2, buyAmount: 8, hasTexture: true },
    'Glass': { color: 0xade8f4, cost: { iron: 5 }, breakTime: 0.4, buyAmount: 16, opacity: 0.6 },
    'Wood': { color: 0x5d4037, cost: { gold: 5 }, breakTime: 3, buyAmount: 32, hasTexture: true },
    'Stone': { color: 0x777777, cost: { gold: 5 }, breakTime: 6, buyAmount: 8, hasTexture: true },
    'Obsidian': { color: 0x111111, cost: { emerald: 1 }, breakTime: 12, buyAmount: 1, hasTexture: true },
    'Bed': { color: 0xff0000, breakTime: 0.8, buyAmount: 1, hasTexture: false },
    'Enderpearl': { color: 0x00ff88, cost: { emerald: 2 }, buyAmount: 1, isItem: true, hasTexture: true },
    'Fireball': { color: 0xff5500, cost: { iron: 48 }, buyAmount: 1, isItem: true, hasTexture: true },
    'Wooden Sword': { color: 0x8B4513, cost: { iron: 20 }, buyAmount: 1, isItem: true, isWeapon: true, damage: 2, hasTexture: true },
    'Iron Sword': { color: 0xC0C0C0, cost: { gold: 10 }, buyAmount: 1, isItem: true, isWeapon: true, damage: 3, hasTexture: true },
    'Emerald Sword': { color: 0x00FF00, cost: { emerald: 5 }, buyAmount: 1, isItem: true, isWeapon: true, damage: 4, hasTexture: true }
};
const MAX_STACK = 64;
const INVENTORY_SIZE = 9;
const BED_DESTRUCTION_TIME = 10 * 60 * 1000;
const ROUND_DURATION = 15 * 60 * 1000;
const REQUIRED_PLAYERS = 2;
const PLAYER_MAX_HEALTH = 10;

// State
const blocks = new Map();
const pickups = new Map();
const spawners = [];
const players = new Map();
const enderpearls = new Map();
const fireballs = new Map();
let gameActive = false;
let countdownTimer = null;
let roundStartTime = null;
let suddenDeath = false;
let roundTimerInterval = null;
let playerCheckInterval = null;

// Iron island positions (4 islands)
const ironIslands = [
    {offsetX: -15, offsetZ: -15, bedX: -14, bedY: 1, bedZ: -14},
    {offsetX: 33, offsetZ: -15, bedX: 34, bedY: 1, bedZ: -14},
    {offsetX: -15, offsetZ: 33, bedX: -14, bedY: 1, bedZ: 34},
    {offsetX: 33, offsetZ: 33, bedX: 34, bedY: 1, bedZ: 34}
];

// Gold island positions (2 islands)
const goldIslands = [
    {offsetX: 9, offsetZ: -15, spawnerX: 11.5, spawnerY: 1, spawnerZ: -12.5},
    {offsetX: 9, offsetZ: 33, spawnerX: 11.5, spawnerY: 1, spawnerZ: 35.5}
];

// Emerald island position (1 island)
const emeraldIsland = {offsetX: 9, offsetZ: 9, spawnerX: 11.5, spawnerY: 1, spawnerZ: 11.5};

// Track which iron islands are occupied
let occupiedIronIslands = [];

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
                
                // Check if player should be eliminated immediately
                if (!suddenDeath && gameActive) {
                    io.to(id).emit('notification', 'Your bed was destroyed! You will not respawn!');
                }
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

function getActivePlayers() {
    return Array.from(players.values()).filter(p => !p.spectator);
}

function getPlayersNeeded() {
    const activePlayers = getActivePlayers().length;
    return Math.max(0, REQUIRED_PLAYERS - activePlayers);
}

function updateWaitingMessages() {
    const playersNeeded = getPlayersNeeded();
    io.emit('updateWaiting', playersNeeded);
}

function startRoundTimer() {
    let timeRemaining = ROUND_DURATION / 1000;
    
    if (roundTimerInterval) {
        clearInterval(roundTimerInterval);
    }
    
    roundTimerInterval = setInterval(() => {
        timeRemaining--;
        io.emit('updateTimer', timeRemaining);
        
        if (timeRemaining <= 0) {
            clearInterval(roundTimerInterval);
            roundTimerInterval = null;
            
            const activePlayers = getActivePlayers();
            if (activePlayers.length > 0) {
                const winnerId = activePlayers[0].id || Array.from(players.entries()).find(([id, p]) => !p.spectator)[0];
                endGame(winnerId);
            } else {
                endGame(null);
            }
        }
    }, 1000);
}

function stopRoundTimer() {
    if (roundTimerInterval) {
        clearInterval(roundTimerInterval);
        roundTimerInterval = null;
    }
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

function initWorld() {
    // Clear all existing blocks
    blocks.clear();
    pickups.clear();
    spawners.length = 0;
    enderpearls.clear();
    fireballs.clear();
    
    // Create iron islands
    ironIslands.forEach(island => {
        createIsland(island.offsetX, island.offsetZ, { type: 'iron', interval: 3 });
    });
    
    // Create gold islands
    goldIslands.forEach(island => {
        createIsland(island.offsetX, island.offsetZ, { type: 'gold', interval: 8 });
    });
    
    // Create emerald island
    createIsland(emeraldIsland.offsetX, emeraldIsland.offsetZ, { type: 'emerald', interval: 10 });
    
    // Reset occupied islands
    occupiedIronIslands = [];
}

// Initialize world on server start
initWorld();

function assignPlayerToIsland(playerId) {
    // Find first unoccupied iron island
    for (let i = 0; i < ironIslands.length; i++) {
        if (!occupiedIronIslands.includes(i)) {
            const island = ironIslands[i];
            
            // Add bed at the island
            addBlock(island.bedX, island.bedY, island.bedZ, 'Bed');
            
            // Mark island as occupied
            occupiedIronIslands.push(i);
            
            // Update player state
            const p = players.get(playerId);
            p.bedPos = { x: island.bedX, y: island.bedY, z: island.bedZ };
            p.pos = { x: island.bedX + 0.5, y: island.bedY + 2, z: island.bedZ + 0.5 };
            p.rot = { yaw: 0, pitch: 0 };
            p.spectator = false;
            p.health = PLAYER_MAX_HEALTH;
            
            return {
                bedPos: p.bedPos,
                pos: p.pos,
                rot: p.rot,
                inventory: p.inventory,
                currency: p.currency
            };
        }
    }
    return null;
}

function endGame(winnerId) {
    if (!gameActive) return;
    
    gameActive = false;
    suddenDeath = false;
    roundStartTime = null;
    stopRoundTimer();
    
    console.log(`Game ended! Winner: ${winnerId || 'No winner'}`);
    
    // Announce winner
    io.emit('gameEnd', { winner: winnerId });
    
    // Reset game after delay
    setTimeout(() => {
        resetGame();
    }, 5000);
}

function checkWinCondition() {
    if (!gameActive) return;
    
    const activePlayers = getActivePlayers();
    console.log(`Checking win condition. Active players: ${activePlayers.length}`);
    
    if (activePlayers.length <= 1) {
        let winnerId = null;
        if (activePlayers.length === 1) {
            winnerId = activePlayers[0].id;
            console.log(`Win condition met! Winner: ${winnerId}`);
        } else {
            console.log('Win condition met! No winner.');
        }
        
        endGame(winnerId);
        return true;
    }
    return false;
}

// New function to properly eliminate a player
function eliminatePlayer(playerId, eliminatorId) {
    const p = players.get(playerId);
    if (!p) return;
    
    console.log(`Eliminating player ${playerId}. Eliminator: ${eliminatorId}`);
    
    p.spectator = true;
    p.health = PLAYER_MAX_HEALTH;
    p.pos = { x: 9 + 2.5, y: 50, z: 9 + 2.5 };
    
    // Free up island
    if (p.bedPos) {
        for (let i = 0; i < ironIslands.length; i++) {
            if (ironIslands[i].bedX === p.bedPos.x && 
                ironIslands[i].bedY === p.bedPos.y && 
                ironIslands[i].bedZ === p.bedPos.z) {
                const index = occupiedIronIslands.indexOf(i);
                if (index > -1) {
                    occupiedIronIslands.splice(index, 1);
                }
                break;
            }
        }
        p.bedPos = null;
    }
    
    io.to(playerId).emit('setSpectator', true);
    io.to(playerId).emit('respawn', { 
        pos: p.pos, 
        rot: p.rot 
    });
    io.to(playerId).emit('notification', 'Eliminated! You are now a spectator.');
    
    io.emit('playerEliminated', {
        eliminatedId: playerId,
        eliminatorId: eliminatorId
    });
    
    // Remove player body for all other players
    io.emit('removePlayer', playerId);
    
    // Check win condition
    checkWinCondition();
}

function resetGame() {
    console.log('Resetting game...');
    
    // Reset world
    initWorld();
    
    const initBlocks = Array.from(blocks, ([key, type]) => {
        const [x, y, z] = key.split(',').map(Number);
        return { x, y, z, type };
    });
    const initPickups = Array.from(pickups, ([id, data]) => ({ id, ...data }));
    
    // Reset all players to spectators
    players.forEach((p, id) => {
        p.inventory = new Array(INVENTORY_SIZE).fill(null);
        p.currency = { iron: 0, gold: 0, emerald: 0 };
        p.selected = 0;
        p.rot = { yaw: 0, pitch: 0 };
        p.crouch = false;
        p.lastRespawn = 0;
        p.bedPos = null;
        p.spectator = true;
        p.health = PLAYER_MAX_HEALTH;
        p.pos = { x: 9 + 2.5, y: 50, z: 9 + 2.5 };
        p.equippedWeapon = null;
        p.lastEnderpearlThrow = 0;
        p.lastFireballThrow = 0;
        
        io.to(id).emit('setSpectator', true);
        io.to(id).emit('respawn', {
            pos: p.pos,
            rot: p.rot
        });
        io.to(id).emit('updateInventory', p.inventory);
        io.to(id).emit('updateCurrency', p.currency);
    });
    
    // Send world reset to all clients
    io.emit('worldReset', { 
        blocks: initBlocks, 
        pickups: initPickups, 
        spawners: spawners.map(s => ({
            x: s.x, y: s.y, z: s.z,
            resourceType: s.resourceType,
            interval: s.interval / 1000,
            lastSpawn: s.lastSpawn
        }))
    });
    
    gameActive = false;
    suddenDeath = false;
    roundStartTime = null;
    stopRoundTimer();
    
    // Start checking for players
    startPlayerCheck();
}

function startPlayerCheck() {
    // Clear existing interval
    if (playerCheckInterval) {
        clearInterval(playerCheckInterval);
    }
    
    // Check every second if game should start
    playerCheckInterval = setInterval(() => {
        if (!gameActive) {
            const totalPlayers = players.size;
            const activePlayers = getActivePlayers();
            
            console.log(`Player check: ${totalPlayers} total, ${activePlayers.length} active`);
            
            // If we have enough players and countdown isn't running, start countdown
            if (totalPlayers >= REQUIRED_PLAYERS && activePlayers.length < REQUIRED_PLAYERS && !countdownTimer) {
                console.log('Starting countdown...');
                let count = 10;
                io.emit('notification', 'Game starting in 10 seconds!');
                
                countdownTimer = setInterval(() => {
                    io.emit('countdown', count);
                    count--;
                    
                    if (count < 0) {
                        clearInterval(countdownTimer);
                        countdownTimer = null;
                        
                        // Assign beds to all spectators
                        const assignedPlayers = [];
                        players.forEach((p, id) => {
                            if (p.spectator) {
                                const assignment = assignPlayerToIsland(id);
                                if (assignment) {
                                    p.spectator = false;
                                    p.pos = assignment.pos;
                                    p.rot = assignment.rot;
                                    p.bedPos = assignment.bedPos;
                                    p.health = PLAYER_MAX_HEALTH;
                                    assignedPlayers.push(id);
                                    
                                    io.to(id).emit('assignBed', assignment);
                                    io.to(id).emit('set
