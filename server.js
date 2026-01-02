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

// Config - Updated with Wind Charge
const BLOCK_TYPES = {
    'Grass': { color: 0x4d9043, cost: { iron: 5 }, breakTime: 1.2, buyAmount: 8, hasTexture: true },
    'Glass': { color: 0xade8f4, cost: { iron: 5 }, breakTime: 0.4, buyAmount: 16, opacity: 0.6 },
    'Wood': { color: 0x5d4037, cost: { gold: 5 }, breakTime: 3, buyAmount: 32, hasTexture: true },
    'Stone': { color: 0x777777, cost: { gold: 5 }, breakTime: 6, buyAmount: 8, hasTexture: true },
    'Obsidian': { color: 0x111111, cost: { emerald: 1 }, breakTime: 12, buyAmount: 1, hasTexture: true },
    'Bed': { color: 0xff0000, breakTime: 0.8, buyAmount: 1, hasTexture: false },
    'Enderpearl': { color: 0x00ff88, cost: { emerald: 2 }, buyAmount: 1, isItem: true, hasTexture: true },
    'Fireball': { color: 0xff5500, cost: { iron: 48 }, buyAmount: 1, isItem: true, hasTexture: true },
    'Wind Charge': { color: 0x88ccff, cost: { gold: 24 }, buyAmount: 1, isItem: true, hasTexture: true },
    'Wooden Sword': { color: 0x8B4513, cost: { iron: 20 }, buyAmount: 1, isItem: true, isWeapon: true, damage: 2, hasTexture: true },
    'Iron Sword': { color: 0xC0C0C0, cost: { gold: 10 }, buyAmount: 1, isItem: true, isWeapon: true, damage: 3, hasTexture: true },
    'Emerald Sword': { color: 0x00FF00, cost: { emerald: 5 }, buyAmount: 1, isItem: true, isWeapon: true, damage: 4, hasTexture: true },
    'Axe': { color: 0x8B4513, cost: { gold: 20 }, buyAmount: 1, isItem: true, isTool: true, toolType: 'axe', breakMultiplier: 0.5, hasTexture: true },
    'Pickaxe': { color: 0xC0C0C0, cost: { gold: 20 }, buyAmount: 1, isItem: true, isTool: true, toolType: 'pickaxe', breakMultiplier: 0.5, hasTexture: true }
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
const windcharges = new Map();
const breakingAnimations = new Map();
const activeBreaking = new Map();

let gameActive = false;
let countdownTimer = null;
let roundStartTime = null;
let suddenDeath = false;
let roundTimerInterval = null;
let playerCheckInterval = null;

// Iron island positions
const ironIslands = [
    {offsetX: -15, offsetZ: -15, bedX: -14, bedY: 1, bedZ: -14},
    {offsetX: 33, offsetZ: -15, bedX: 34, bedY: 1, bedZ: -14},
    {offsetX: -15, offsetZ: 33, bedX: -14, bedY: 1, bedZ: 34},
    {offsetX: 33, offsetZ: 33, bedX: 34, bedY: 1, bedZ: 34}
];

// Gold island positions
const goldIslands = [
    {offsetX: 9, offsetZ: -15, spawnerX: 11.5, spawnerY: 1, spawnerZ: -12.5},
    {offsetX: 9, offsetZ: 33, spawnerX: 11.5, spawnerY: 1, spawnerZ: 35.5}
];

// Emerald island position
const emeraldIsland = {offsetX: 9, offsetZ: 9, spawnerX: 11.5, spawnerY: 1, spawnerZ: 11.5};

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
    blocks.clear();
    pickups.clear();
    spawners.length = 0;
    enderpearls.clear();
    fireballs.clear();
    windcharges.clear();
    breakingAnimations.clear();
    activeBreaking.clear();
    
    ironIslands.forEach(island => {
        createIsland(island.offsetX, island.offsetZ, { type: 'iron', interval: 3 });
    });
    
    goldIslands.forEach(island => {
        createIsland(island.offsetX, island.offsetZ, { type: 'gold', interval: 8 });
    });
    
    createIsland(emeraldIsland.offsetX, emeraldIsland.offsetZ, { type: 'emerald', interval: 10 });
    
    occupiedIronIslands = [];
}

initWorld();

function assignPlayerToIsland(playerId) {
    for (let i = 0; i < ironIslands.length; i++) {
        if (!occupiedIronIslands.includes(i)) {
            const island = ironIslands[i];
            
            addBlock(island.bedX, island.bedY, island.bedZ, 'Bed');
            
            occupiedIronIslands.push(i);
            
            const p = players.get(playerId);
            p.bedPos = { x: island.bedX, y: island.bedY, z: island.bedZ };
            // Send eye position (feet + eye height)
            p.pos = { x: island.bedX + 0.5, y: island.bedY + 2 + 1.6, z: island.bedZ + 0.5 };
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
    
    io.emit('gameEnd', { winner: winnerId });
    
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

function eliminatePlayer(playerId, eliminatorId) {
    const p = players.get(playerId);
    if (!p) return;
    
    console.log(`Eliminating player ${playerId}. Eliminator: ${eliminatorId}`);
    
    p.spectator = true;
    p.health = PLAYER_MAX_HEALTH;
    p.pos = { x: 9 + 2.5, y: 50, z: 9 + 2.5 };
    
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
    
    io.emit('removePlayer', playerId);
    
    checkWinCondition();
}

function resetGame() {
    console.log('Resetting game...');
    
    initWorld();
    
    const initBlocks = Array.from(blocks, ([key, type]) => {
        const [x, y, z] = key.split(',').map(Number);
        return { x, y, z, type };
    });
    const initPickups = Array.from(pickups, ([id, data]) => ({ id, ...data }));
    
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
        p.lastWindchargeThrow = 0;
        
        io.to(id).emit('setSpectator', true);
        io.to(id).emit('respawn', {
            pos: p.pos,
            rot: p.rot
        });
        io.to(id).emit('updateInventory', p.inventory);
        io.to(id).emit('updateCurrency', p.currency);
    });
    
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
    
    startPlayerCheck();
}

function startPlayerCheck() {
    if (playerCheckInterval) {
        clearInterval(playerCheckInterval);
    }
    
    playerCheckInterval = setInterval(() => {
        if (!gameActive) {
            const totalPlayers = players.size;
            const activePlayers = getActivePlayers();
            
            console.log(`Player check: ${totalPlayers} total, ${activePlayers.length} active`);
            
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
                                    io.to(id).emit('setSpectator', false);
                                }
                            }
                        });
                        
                        const activeAfterAssignment = getActivePlayers();
                        if (activeAfterAssignment.length >= REQUIRED_PLAYERS) {
                            gameActive = true;
                            roundStartTime = Date.now();
                            
                            spawners.forEach(s => s.lastSpawn = Date.now());
                            
                            startRoundTimer();
                            
                            io.emit('gameStart');
                        } else {
                            io.emit('notification', 'Not enough players assigned. Waiting...');
                            assignedPlayers.forEach(id => {
                                const p = players.get(id);
                                p.spectator = true;
                                p.bedPos = null;
                                io.to(id).emit('setSpectator', true);
                            });
                            occupiedIronIslands = [];
                            initWorld();
                        }
                    }
                }, 1000);
            }
        }
    }, 1000);
}

function validateBlockBreaking(playerId, x, y, z, type) {
    const p = players.get(playerId);
    if (!p || p.spectator) return false;
    
    const key = blockKey(x, y, z);
    if (!blocks.has(key)) return false;
    
    const blockType = blocks.get(key);
    if (blockType !== type) return false;
    
    // Calculate distance from player's eye position to block
    const eyeHeight = p.crouch ? 1.3 : 1.6;
    const playerEyeY = p.pos.y;
    const blockCenterY = y + 0.5;
    
    const dist = Math.hypot(
        p.pos.x - (x + 0.5),
        playerEyeY - blockCenterY,
        p.pos.z - (z + 0.5)
    );
    
    return dist <= 5.5;
}

function processBlockBreak(playerId, x, y, z) {
    const p = players.get(playerId);
    if (!p || p.spectator) return false;
    
    const key = blockKey(x, y, z);
    if (!blocks.has(key)) return false;
    
    const type = blocks.get(key);
    
    if (type === 'Bed') {
        if (p.bedPos && p.bedPos.x === x && p.bedPos.y === y && p.bedPos.z === z) {
            return false;
        }
        
        removeBlock(x, y, z);
        return true;
    }
    
    if (addToInventory(p.inventory, type, 1)) {
        removeBlock(x, y, z);
        io.to(playerId).emit('updateInventory', p.inventory.map(slot => slot ? { ...slot } : null));
        return true;
    }
    
    return false;
}

// Socket connections
io.on('connection', (socket) => {
    console.log(`New connection: ${socket.id}`);
    
    const playerState = {
        pos: { x: 9 + 2.5, y: 50, z: 9 + 2.5 },
        rot: { yaw: 0, pitch: 0 },
        crouch: false,
        inventory: new Array(INVENTORY_SIZE).fill(null),
        currency: { iron: 0, gold: 0, emerald: 0 },
        selected: 0,
        bedPos: null,
        lastRespawn: 0,
        spectator: true,
        health: PLAYER_MAX_HEALTH,
        id: socket.id,
        lastHitTime: 0,
        equippedWeapon: null,
        lastEnderpearlThrow: 0,
        lastFireballThrow: 0,
        lastWindchargeThrow: 0
    };
    
    players.set(socket.id, playerState);

    const initBlocks = Array.from(blocks, ([key, type]) => {
        const [x, y, z] = key.split(',').map(Number);
        return { x, y, z, type };
    });
    const initPickups = Array.from(pickups, ([id, data]) => ({ id, ...data }));
    
    socket.emit('initWorld', { 
        blocks: initBlocks, 
        pickups: initPickups, 
        spawners: spawners.map(s => ({
            x: s.x, y: s.y, z: s.z,
            resourceType: s.resourceType,
            interval: s.interval / 1000,
            lastSpawn: s.lastSpawn
        })),
        gameActive,
        playersNeeded: getPlayersNeeded()
    });

    socket.emit('yourId', socket.id);
    socket.emit('setSpectator', true);

    const otherPlayers = Array.from(players.entries())
        .filter(([id]) => id !== socket.id)
        .filter(([_, p]) => !p.spectator)
        .map(([id, p]) => ({ 
            id, 
            pos: p.pos, 
            rot: p.rot, 
            crouch: p.crouch,
            spectator: p.spectator,
            health: p.health,
            equippedWeapon: p.equippedWeapon
        }));
    socket.emit('playersSnapshot', otherPlayers);

    socket.broadcast.emit('newPlayer', { 
        id: socket.id, 
        pos: playerState.pos, 
        rot: playerState.rot, 
        crouch: playerState.crouch,
        spectator: playerState.spectator,
        health: playerState.health,
        equippedWeapon: playerState.equippedWeapon
    });

    updateWaitingMessages();

    if (!playerCheckInterval) {
        startPlayerCheck();
    }

    socket.on('playerUpdate', (data) => {
        const p = players.get(socket.id);
        if (p) {
            p.pos = data.pos;
            p.rot = data.rot;
            p.crouch = data.crouch;
            p.selected = data.selected;
            p.spectator = data.spectator;
            p.equippedWeapon = data.equippedWeapon;
        }
    });

    socket.on('claimPickupAttempt', (id) => {
        if (!pickups.has(id)) return;
        
        const p = players.get(socket.id);
        if (p.spectator) return;
        
        const pickup = pickups.get(id);
        const dist = Math.hypot(p.pos.x - pickup.x, p.pos.y - pickup.y, p.pos.z - pickup.z);
        
        if (dist >= 1.5) {
            socket.emit('revertPickup', { id, x: pickup.x, y: pickup.y, z: pickup.z, resourceType: pickup.resourceType });
            return;
        }
        
        const res = pickup.resourceType;
        p.currency[res] = (p.currency[res] || 0) + 1;
        pickups.delete(id);
        io.emit('removePickup', id);
        socket.emit('updateCurrency', { ...p.currency });
    });

    socket.on('breakAttempt', ({ x, y, z }) => {
        const p = players.get(socket.id);
        if (p.spectator) return;
        
        const key = blockKey(x, y, z);
        if (!blocks.has(key)) {
            socket.emit('revertBreak', { x, y, z, type: null });
            return;
        }
        
        const type = blocks.get(key);
        
        if (!validateBlockBreaking(socket.id, x, y, z, type)) {
            socket.emit('revertBreak', { x, y, z, type });
            return;
        }
        
        if (processBlockBreak(socket.id, x, y, z)) {
            return;
        } else {
            socket.emit('revertBreak', { x, y, z, type });
        }
    });

    socket.on('placeAttempt', ({ x, y, z, type }) => {
        const p = players.get(socket.id);
        if (p.spectator) return;
        
        // Prevent placing items (tools, weapons, throwables)
        const blockData = BLOCK_TYPES[type];
        if (blockData && (blockData.isItem || blockData.isWeapon || blockData.isTool)) {
            socket.emit('revertPlace', { x, y, z });
            socket.emit('notification', 'Cannot place items! Use Q to drop them.');
            return;
        }
        
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
        
        const eyeHeight = p.crouch ? 1.3 : 1.6;
        const playerEyeY = p.pos.y;
        const blockCenterY = y + 0.5;
        
        const dist = Math.hypot(
            p.pos.x - (x + 0.5),
            playerEyeY - blockCenterY,
            p.pos.z - (z + 0.5)
        );
        
        if (dist > 5.5) {
            socket.emit('revertPlace', { x, y, z });
            socket.emit('notification', 'Too far away!');
            return;
        }
        
        slot.count--;
        if (slot.count === 0) {
            p.inventory[p.selected] = null;
            if (BLOCK_TYPES[type] && BLOCK_TYPES[type].isWeapon && p.selected === p.selected) {
                p.equippedWeapon = null;
            }
        }
        addBlock(x, y, z, type);
        socket.emit('updateInventory', p.inventory.map(slot => slot ? { ...slot } : null));
    });

    // Q key - Drop item from inventory
    socket.on('dropItem', () => {
        const p = players.get(socket.id);
        if (p.spectator || !p.inventory[p.selected]) return;
        
        const slot = p.inventory[p.selected];
        if (!slot) return;
        
        // Remove one item from the slot
        slot.count--;
        
        if (slot.count <= 0) {
            p.inventory[p.selected] = null;
            
            // Clear equipped weapon if it was dropped
            if (BLOCK_TYPES[slot.type] && BLOCK_TYPES[slot.type].isWeapon) {
                p.equippedWeapon = null;
            }
        }
        
        // Emit inventory update
        socket.emit('updateInventory', p.inventory.map(slot => slot ? { ...slot } : null));
        
        // Emit notification
        socket.emit('notification', `Dropped ${slot.type}`);
    });

    socket.on('buyAttempt', (btype) => {
        const p = players.get(socket.id);
        if (p.spectator) return;
        
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
        
        if (data.isWeapon && p.selected !== null) {
            const slot = p.inventory[p.selected];
            if (slot && slot.type === btype) {
                p.equippedWeapon = btype;
            }
        }
    });

    socket.on('hitPlayer', (targetId) => {
        const attacker = players.get(socket.id);
        const target = players.get(targetId);
        
        if (!attacker || !target || attacker.spectator || target.spectator) return;
        if (attacker.id === target.id) return;
        
        const now = Date.now();
        if (now - attacker.lastHitTime < 500) return;
        
        const dx = attacker.pos.x - target.pos.x;
        const dy = attacker.pos.y - target.pos.y;
        const dz = attacker.pos.z - target.pos.z;
        const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
        
        if (dist > 5) {
            socket.emit('notification', 'Too far away!');
            return;
        }
        
        let damage = 1;
        if (attacker.equippedWeapon) {
            const weaponData = BLOCK_TYPES[attacker.equippedWeapon];
            if (weaponData && weaponData.isWeapon) {
                damage = weaponData.damage;
            }
        }
        
        target.health -= damage;
        attacker.lastHitTime = now;
        
        // Emit screen shake for the target only
        io.to(targetId).emit('screenShake', {
            intensity: 0.4,
            duration: 0.6
        });
        
        io.emit('playerHit', {
            attackerId: attacker.id,
            targetId: target.id,
            newHealth: target.health
        });
        
        if (target.health <= 0) {
            const bedKey = target.bedPos ? blockKey(target.bedPos.x, target.bedPos.y, target.bedPos.z) : null;
            const hasBed = target.bedPos && blocks.get(bedKey) === 'Bed';
            
            if (hasBed) {
                target.health = PLAYER_MAX_HEALTH;
                target.pos.x = target.bedPos.x + 0.5;
                target.pos.y = target.bedPos.y + 2 + 1.6; // Eye position
                target.pos.z = target.bedPos.z + 0.5;
                target.rot.yaw = 0;
                target.rot.pitch = 0;
                
                io.to(targetId).emit('respawn', { 
                    pos: target.pos, 
                    rot: target.rot 
                });
                
                io.emit('playerHit', {
                    attackerId: null,
                    targetId: target.id,
                    newHealth: target.health
                });
                
                io.to(targetId).emit('notification', 'You died and respawned at your bed!');
            } else {
                eliminatePlayer(targetId, attacker.id);
            }
        }
    });

    socket.on('throwEnderpearl', (targetPos) => {
        const p = players.get(socket.id);
        if (p.spectator) return;
        
        const slot = p.inventory[p.selected];
        if (!slot || slot.type !== 'Enderpearl' || slot.count < 1) {
            socket.emit('notification', 'No Enderpearl in selected slot!');
            return;
        }
        
        const now = Date.now();
        if (now - p.lastEnderpearlThrow < 1000) {
            socket.emit('notification', 'Enderpearl cooldown!');
            return;
        }
        
        slot.count--;
        if (slot.count === 0) {
            p.inventory[p.selected] = null;
        }
        
        p.lastEnderpearlThrow = now;
        
        socket.emit('updateInventory', p.inventory.map(slot => slot ? { ...slot } : null));
        
        const pearlId = `pearl-${socket.id}-${now}-${Math.random().toString(36).substr(2, 9)}`;
        
        const startPos = {
            x: p.pos.x,
            y: p.pos.y,
            z: p.pos.z
        };
        
        const direction = {
            x: targetPos.x - startPos.x,
            y: targetPos.y - startPos.y,
            z: targetPos.z - startPos.z
        };
        
        const length = Math.sqrt(direction.x * direction.x + direction.y * direction.y + direction.z * direction.z);
        const speed = 25;
        const velocity = {
            x: (direction.x / length) * speed,
            y: (direction.y / length) * speed,
            z: (direction.z / length) * speed
        };
        
        const pearl = {
            id: pearlId,
            owner: socket.id,
            pos: startPos,
            velocity: velocity,
            createdAt: now,
            lastUpdate: now,
            arrived: false,
            hit: false
        };
        
        enderpearls.set(pearlId, pearl);
        
        io.emit('addEnderpearl', {
            id: pearl.id,
            x: startPos.x,
            y: startPos.y,
            z: startPos.z,
            velocity: velocity,
            owner: socket.id
        });
    });

    socket.on('throwFireball', (targetPos) => {
        const p = players.get(socket.id);
        if (p.spectator) return;
        
        const slot = p.inventory[p.selected];
        if (!slot || slot.type !== 'Fireball' || slot.count < 1) {
            socket.emit('notification', 'No Fireball in selected slot!');
            return;
        }
        
        const now = Date.now();
        if (now - p.lastFireballThrow < 100) {
            socket.emit('notification', 'Fireball cooldown!');
            return;
        }
        
        slot.count--;
        if (slot.count === 0) {
            p.inventory[p.selected] = null;
        }
        
        p.lastFireballThrow = now;
        
        socket.emit('updateInventory', p.inventory.map(slot => slot ? { ...slot } : null));
        
        const fireballId = `fireball-${socket.id}-${now}-${Math.random().toString(36).substr(2, 9)}`;
        
        const startPos = {
            x: p.pos.x,
            y: p.pos.y,
            z: p.pos.z
        };
        
        const direction = {
            x: targetPos.x - startPos.x,
            y: targetPos.y - startPos.y,
            z: targetPos.z - startPos.z
        };
        
        const length = Math.sqrt(direction.x * direction.x + direction.y * direction.y + direction.z * direction.z);
        const speed = 20;
        const velocity = {
            x: (direction.x / length) * speed,
            y: (direction.y / length) * speed,
            z: (direction.z / length) * speed
        };
        
        const fireball = {
            id: fireballId,
            owner: socket.id,
            pos: startPos,
            velocity: velocity,
            createdAt: now,
            lastUpdate: now,
            arrived: false,
            hit: false
        };
        
        fireballs.set(fireballId, fireball);
        
        io.emit('addFireball', {
            id: fireball.id,
            x: startPos.x,
            y: startPos.y,
            z: startPos.z,
            velocity: velocity,
            owner: socket.id
        });
    });

    socket.on('throwWindcharge', (targetPos) => {
        const p = players.get(socket.id);
        if (p.spectator) return;
        
        const slot = p.inventory[p.selected];
        if (!slot || slot.type !== 'Wind Charge' || slot.count < 1) {
            socket.emit('notification', 'No Wind Charge in selected slot!');
            return;
        }
        
        const now = Date.now();
        if (now - p.lastWindchargeThrow < 100) {
            socket.emit('notification', 'Wind Charge cooldown!');
            return;
        }
        
        slot.count--;
        if (slot.count === 0) {
            p.inventory[p.selected] = null;
        }
        
        p.lastWindchargeThrow = now;
        
        socket.emit('updateInventory', p.inventory.map(slot => slot ? { ...slot } : null));
        
        const windchargeId = `windcharge-${socket.id}-${now}-${Math.random().toString(36).substr(2, 9)}`;
        
        const startPos = {
            x: p.pos.x,
            y: p.pos.y,
            z: p.pos.z
        };
        
        const direction = {
            x: targetPos.x - startPos.x,
            y: targetPos.y - startPos.y,
            z: targetPos.z - startPos.z
        };
        
        const length = Math.sqrt(direction.x * direction.x + direction.y * direction.y + direction.z * direction.z);
        const speed = 22;
        const velocity = {
            x: (direction.x / length) * speed,
            y: (direction.y / length) * speed,
            z: (direction.z / length) * speed
        };
        
        const windcharge = {
            id: windchargeId,
            owner: socket.id,
            pos: startPos,
            velocity: velocity,
            createdAt: now,
            lastUpdate: now,
            arrived: false,
            hit: false
        };
        
        windcharges.set(windchargeId, windcharge);
        
        io.emit('addWindcharge', {
            id: windcharge.id,
            x: startPos.x,
            y: startPos.y,
            z: startPos.z,
            velocity: velocity,
            owner: socket.id
        });
    });

    socket.on('fireballHitBlock', ({ fireballId, x, y, z }) => {
        const fireball = fireballs.get(fireballId);
        if (!fireball) return;
        
        const blocksDestroyed = [];
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (let dz = -1; dz <= 1; dz++) {
                    const blockX = x + dx;
                    const blockY = y + dy;
                    const blockZ = z + dz;
                    const key = blockKey(blockX, blockY, blockZ);
                    
                    if (blocks.has(key)) {
                        const blockType = blocks.get(key);
                        
                        if (blockType === 'Bed') {
                            const player = players.get(fireball.owner);
                            if (player && player.bedPos && 
                                player.bedPos.x === blockX && 
                                player.bedPos.y === blockY && 
                                player.bedPos.z === blockZ) {
                                continue;
                            }
                        }
                        
                        removeBlock(blockX, blockY, blockZ);
                        blocksDestroyed.push({ x: blockX, y: blockY, z: blockZ, type: blockType });
                    }
                }
            }
        }
        
        io.emit('fireballExplosion', {
            x: x,
            y: y,
            z: z,
            blocksDestroyed: blocksDestroyed
        });
        
        fireballs.delete(fireballId);
        io.emit('removeFireball', fireballId);
    });

    socket.on('windchargeHitPlayer', ({ windchargeId, targetId }) => {
        const windcharge = windcharges.get(windchargeId);
        const target = players.get(targetId);
        
        if (!windcharge || !target || target.spectator) return;
        
        // Apply 4 block knockback
        const knockbackDistance = 4;
        const direction = {
            x: target.pos.x - windcharge.pos.x,
            y: 0,
            z: target.pos.z - windcharge.pos.z
        };
        
        const length = Math.sqrt(direction.x * direction.x + direction.z * direction.z);
        if (length > 0) {
            const normalizedDir = {
                x: direction.x / length,
                y: direction.y / length,
                z: direction.z / length
            };
            
            target.pos.x += normalizedDir.x * knockbackDistance;
            target.pos.z += normalizedDir.z * knockbackDistance;
            
            // Add a bit of vertical knockback
            target.pos.y += 1;
            
            // Emit screen shake for the target
            io.to(targetId).emit('screenShake', {
                intensity: 0.6,
                duration: 0.8
            });
            
            io.to(targetId).emit('notification', 'Knocked back by Wind Charge!');
            
            // Emit to all players for visual effect
            io.emit('windchargeExplosion', {
                x: windcharge.pos.x,
                y: windcharge.pos.y,
                z: windcharge.pos.z,
                targetId: targetId
            });
        }
        
        windcharges.delete(windchargeId);
        io.emit('removeWindcharge', windchargeId);
    });

    socket.on('startBreaking', ({ x, y, z, breakTime }) => {
        const p = players.get(socket.id);
        if (p.spectator) return;
        
        breakingAnimations.set(socket.id, {
            x, y, z,
            progress: 0,
            lastUpdate: Date.now(),
            breakTime
        });
        
        socket.broadcast.emit('startBreaking', {
            x, y, z,
            playerId: socket.id,
            breakTime
        });
    });

    socket.on('breakingProgress', ({ x, y, z, progress }) => {
        const p = players.get(socket.id);
        if (p.spectator) return;
        
        if (breakingAnimations.has(socket.id)) {
            const anim = breakingAnimations.get(socket.id);
            anim.x = x;
            anim.y = y;
            anim.z = z;
            anim.progress = progress;
            anim.lastUpdate = Date.now();
            
            socket.broadcast.emit('breakingProgress', {
                x, y, z,
                playerId: socket.id,
                progress
            });
        }
    });

    socket.on('stopBreaking', ({ x, y, z }) => {
        if (breakingAnimations.has(socket.id)) {
            breakingAnimations.delete(socket.id);
            
            socket.broadcast.emit('stopBreaking', {
                x, y, z,
                playerId: socket.id
            });
        }
    });

    socket.on('disconnect', () => {
        console.log(`Disconnected: ${socket.id}`);
        
        const p = players.get(socket.id);
        if (p) {
            if (gameActive && !p.spectator) {
                if (p.bedPos) {
                    removeBlock(p.bedPos.x, p.bedPos.y, p.bedPos.z);
                    
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
                }
                
                io.emit('removePlayer', socket.id);
                
                players.delete(socket.id);
                
                const activePlayers = getActivePlayers();
                console.log(`Active players after disconnect: ${activePlayers.length}`);
                
                if (activePlayers.length <= 1) {
                    endGame(activePlayers.length === 1 ? activePlayers[0].id : null);
                }
            } else {
                players.delete(socket.id);
                io.emit('removePlayer', socket.id);
            }
            
            if (breakingAnimations.has(socket.id)) {
                const anim = breakingAnimations.get(socket.id);
                socket.broadcast.emit('stopBreaking', {
                    x: anim.x,
                    y: anim.y,
                    z: anim.z,
                    playerId: socket.id
                });
                breakingAnimations.delete(socket.id);
            }
            
            updateWaitingMessages();
            
            if (!gameActive && countdownTimer) {
                const activePlayers = getActivePlayers();
                if (activePlayers.length < REQUIRED_PLAYERS) {
                    clearInterval(countdownTimer);
                    countdownTimer = null;
                    io.emit('notification', 'Player left. Countdown cancelled.');
                    occupiedIronIslands = [];
                    initWorld();
                }
            }
        }
    });
});

// Game loop
setInterval(() => {
    const now = Date.now();
    
    if (gameActive) {
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

        // Enderpearl updates
        const pearlUpdates = [];
        const pearlRemovals = [];
        
        enderpearls.forEach((pearl, id) => {
            if (pearl.arrived || pearl.hit) return;
            
            const deltaTime = (now - pearl.lastUpdate) / 1000;
            pearl.lastUpdate = now;
            
            const GRAVITY = 20;
            pearl.velocity.y -= GRAVITY * deltaTime;
            
            pearl.pos.x += pearl.velocity.x * deltaTime;
            pearl.pos.y += pearl.velocity.y * deltaTime;
            pearl.pos.z += pearl.velocity.z * deltaTime;
            
            const blockX = Math.floor(pearl.pos.x);
            const blockY = Math.floor(pearl.pos.y);
            const blockZ = Math.floor(pearl.pos.z);
            const blockKeyStr = blockKey(blockX, blockY, blockZ);
            
            if (blocks.has(blockKeyStr) && now - pearl.createdAt > 200) {
                pearl.hit = true;
                
                const player = players.get(pearl.owner);
                if (player && !player.spectator) {
                    const safePos = {
                        x: pearl.pos.x - pearl.velocity.x * deltaTime,
                        y: pearl.pos.y - pearl.velocity.y * deltaTime + 1.0,
                        z: pearl.pos.z - pearl.velocity.z * deltaTime
                    };
                    
                    let teleportY = safePos.y;
                    const checkX = Math.floor(safePos.x);
                    const checkZ = Math.floor(safePos.z);
                    
                    for (let y = Math.floor(teleportY); y < Math.floor(teleportY) + 3; y++) {
                        if (blocks.has(blockKey(checkX, y, checkZ))) {
                            teleportY = y + 1.5;
                        }
                    }
                    
                    player.pos.x = safePos.x;
                    player.pos.y = teleportY;
                    player.pos.z = safePos.z;
                    
                    io.to(pearl.owner).emit('teleport', {
                        x: player.pos.x,
                        y: player.pos.y,
                        z: player.pos.z
                    });
                    
                    io.to(pearl.owner).emit('notification', 'Ender pearl teleport!');
                }
                
                pearl.arrived = true;
                pearlRemovals.push(id);
            } else if (pearl.pos.y < -30 || now - pearl.createdAt > 10000) {
                pearl.arrived = true;
                pearlRemovals.push(id);
            } else {
                pearlUpdates.push({
                    id: pearl.id,
                    x: pearl.pos.x,
                    y: pearl.pos.y,
                    z: pearl.pos.z
                });
            }
        });
        
        if (pearlUpdates.length > 0) {
            io.emit('updateEnderpearl', pearlUpdates);
        }
        
        pearlRemovals.forEach(id => {
            enderpearls.delete(id);
            io.emit('removeEnderpearl', id);
        });

        // Fireball updates
        const fireballUpdates = [];
        const fireballRemovals = [];
        
        fireballs.forEach((fireball, id) => {
            if (fireball.arrived || fireball.hit) return;
            
            const deltaTime = (now - fireball.lastUpdate) / 1000;
            fireball.lastUpdate = now;
            
            const prevPos = { ...fireball.pos };
            
            const GRAVITY = 10;
            fireball.velocity.y -= GRAVITY * deltaTime;
            
            fireball.pos.x += fireball.velocity.x * deltaTime;
            fireball.pos.y += fireball.velocity.y * deltaTime;
            fireball.pos.z += fireball.velocity.z * deltaTime;
            
            const dx = fireball.pos.x - prevPos.x;
            const dy = fireball.pos.y - prevPos.y;
            const dz = fireball.pos.z - prevPos.z;
            const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
            
            if (distance > 0) {
                const steps = Math.ceil(distance * 2);
                let hitBlock = null;
                
                for (let i = 0; i <= steps; i++) {
                    const t = i / steps;
                    const checkX = prevPos.x + dx * t;
                    const checkY = prevPos.y + dy * t;
                    const checkZ = prevPos.z + dz * t;
                    
                    const blockX = Math.floor(checkX);
                    const blockY = Math.floor(checkY);
                    const blockZ = Math.floor(checkZ);
                    const blockKeyStr = blockKey(blockX, blockY, blockZ);
                    
                    if (blocks.has(blockKeyStr)) {
                        hitBlock = { x: blockX, y: blockY, z: blockZ };
                        break;
                    }
                }
                
                if (hitBlock) {
                    fireball.hit = true;
                    
                    const blocksDestroyed = [];
                    for (let dx = -1; dx <= 1; dx++) {
                        for (let dy = -1; dy <= 1; dy++) {
                            for (let dz = -1; dz <= 1; dz++) {
                                const x = hitBlock.x + dx;
                                const y = hitBlock.y + dy;
                                const z = hitBlock.z + dz;
                                const key = blockKey(x, y, z);
                                
                                if (blocks.has(key)) {
                                    const blockType = blocks.get(key);
                                    
                                    if (blockType === 'Bed') {
                                        const player = players.get(fireball.owner);
                                        if (player && player.bedPos && 
                                            player.bedPos.x === x && 
                                            player.bedPos.y === y && 
                                            player.bedPos.z === z) {
                                            continue;
                                        }
                                    }
                                    
                                    removeBlock(x, y, z);
                                    blocksDestroyed.push({ x, y, z, type: blockType });
                                }
                            }
                        }
                    }
                    
                    io.emit('fireballExplosion', {
                        x: hitBlock.x,
                        y: hitBlock.y,
                        z: hitBlock.z,
                        blocksDestroyed: blocksDestroyed
                    });
                    
                    fireball.arrived = true;
                    fireballRemovals.push(id);
                } else if (fireball.pos.y < -30 || now - fireball.createdAt > 10000) {
                    fireball.arrived = true;
                    fireballRemovals.push(id);
                } else {
                    fireballUpdates.push({
                        id: fireball.id,
                        x: fireball.pos.x,
                        y: fireball.pos.y,
                        z: fireball.pos.z
                    });
                }
            } else if (fireball.pos.y < -30 || now - fireball.createdAt > 10000) {
                fireball.arrived = true;
                fireballRemovals.push(id);
            } else {
                fireballUpdates.push({
                    id: fireball.id,
                    x: fireball.pos.x,
                    y: fireball.pos.y,
                    z: fireball.pos.z
                });
            }
        });
        
        if (fireballUpdates.length > 0) {
            io.emit('updateFireball', fireballUpdates);
        }
        
        fireballRemovals.forEach(id => {
            fireballs.delete(id);
            io.emit('removeFireball', id);
        });

        // Wind Charge updates
        const windchargeUpdates = [];
        const windchargeRemovals = [];
        
        windcharges.forEach((windcharge, id) => {
            if (windcharge.arrived || windcharge.hit) return;
            
            const deltaTime = (now - windcharge.lastUpdate) / 1000;
            windcharge.lastUpdate = now;
            
            const prevPos = { ...windcharge.pos };
            
            const GRAVITY = 8;
            windcharge.velocity.y -= GRAVITY * deltaTime;
            
            windcharge.pos.x += windcharge.velocity.x * deltaTime;
            windcharge.pos.y += windcharge.velocity.y * deltaTime;
            windcharge.pos.z += windcharge.velocity.z * deltaTime;
            
            const dx = windcharge.pos.x - prevPos.x;
            const dy = windcharge.pos.y - prevPos.y;
            const dz = windcharge.pos.z - prevPos.z;
            const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
            
            if (distance > 0) {
                // Check for player collisions
                let hitPlayer = null;
                let closestDistance = 1.5; // Hit radius
                
                players.forEach((player, playerId) => {
                    if (player.spectator || playerId === windcharge.owner) return;
                    
                    const playerDist = Math.sqrt(
                        Math.pow(windcharge.pos.x - player.pos.x, 2) +
                        Math.pow(windcharge.pos.y - player.pos.y, 2) +
                        Math.pow(windcharge.pos.z - player.pos.z, 2)
                    );
                    
                    if (playerDist < closestDistance) {
                        closestDistance = playerDist;
                        hitPlayer = playerId;
                    }
                });
                
                if (hitPlayer) {
                    windcharge.hit = true;
                    io.emit('windchargeHitPlayer', {
                        windchargeId: id,
                        targetId: hitPlayer
                    });
                    windcharge.arrived = true;
                    windchargeRemovals.push(id);
                } else {
                    // Check for block collisions
                    const steps = Math.ceil(distance * 2);
                    let hitBlock = null;
                    
                    for (let i = 0; i <= steps; i++) {
                        const t = i / steps;
                        const checkX = prevPos.x + dx * t;
                        const checkY = prevPos.y + dy * t;
                        const checkZ = prevPos.z + dz * t;
                        
                        const blockX = Math.floor(checkX);
                        const blockY = Math.floor(checkY);
                        const blockZ = Math.floor(checkZ);
                        const blockKeyStr = blockKey(blockX, blockY, blockZ);
                        
                        if (blocks.has(blockKeyStr)) {
                            hitBlock = { x: blockX, y: blockY, z: blockZ };
                            break;
                        }
                    }
                    
                    if (hitBlock) {
                        windcharge.hit = true;
                        
                        // Wind Charge doesn't destroy blocks, just creates a wind effect
                        io.emit('windchargeExplosion', {
                            x: hitBlock.x,
                            y: hitBlock.y,
                            z: hitBlock.z,
                            targetId: null
                        });
                        
                        windcharge.arrived = true;
                        windchargeRemovals.push(id);
                    } else if (windcharge.pos.y < -30 || now - windcharge.createdAt > 10000) {
                        windcharge.arrived = true;
                        windchargeRemovals.push(id);
                    } else {
                        windchargeUpdates.push({
                            id: windcharge.id,
                            x: windcharge.pos.x,
                            y: windcharge.pos.y,
                            z: windcharge.pos.z
                        });
                    }
                }
            } else if (windcharge.pos.y < -30 || now - windcharge.createdAt > 10000) {
                windcharge.arrived = true;
                windchargeRemovals.push(id);
            } else {
                windchargeUpdates.push({
                    id: windcharge.id,
                    x: windcharge.pos.x,
                    y: windcharge.pos.y,
                    z: windcharge.pos.z
                });
            }
        });
        
        if (windchargeUpdates.length > 0) {
            io.emit('updateWindcharge', windchargeUpdates);
        }
        
        windchargeRemovals.forEach(id => {
            windcharges.delete(id);
            io.emit('removeWindcharge', id);
        });

        const breakingAnimationsToRemove = [];
        breakingAnimations.forEach((anim, playerId) => {
            if (now - anim.lastUpdate > 5000) {
                breakingAnimationsToRemove.push(playerId);
            }
        });
        
        breakingAnimationsToRemove.forEach(playerId => {
            const anim = breakingAnimations.get(playerId);
            if (anim) {
                io.emit('stopBreaking', {
                    x: anim.x,
                    y: anim.y,
                    z: anim.z,
                    playerId: playerId
                });
                breakingAnimations.delete(playerId);
            }
        });

        players.forEach((p, id) => {
            if (p.spectator) return;
            
            if (p.pos.y < -30 && now - p.lastRespawn > 2000) {
                const bedKey = p.bedPos ? blockKey(p.bedPos.x, p.bedPos.y, p.bedPos.z) : null;
                const hasBed = p.bedPos && blocks.get(bedKey) === 'Bed';
                
                if (hasBed) {
                    p.pos.x = p.bedPos.x + 0.5;
                    p.pos.y = p.bedPos.y + 2 + 1.6; // Eye position
                    p.pos.z = p.bedPos.z + 0.5;
                    p.rot.yaw = 0;
                    p.rot.pitch = 0;
                    io.to(id).emit('respawn', { pos: p.pos, rot: p.rot });
                    io.to(id).emit('notification', 'You fell into the void and respawned at your bed!');
                } else {
                    eliminatePlayer(id, null);
                }
                p.lastRespawn = now;
            }
        });
        
        if (Math.random() < 0.1) {
            checkWinCondition();
        }
    }

    const states = Array.from(players.entries()).map(([id, p]) => ({
        id,
        pos: p.pos,
        rot: p.rot,
        crouch: p.crouch,
        spectator: p.spectator,
        health: p.health,
        equippedWeapon: p.equippedWeapon
    }));
    io.emit('playersUpdate', states);
}, 50);

startPlayerCheck();
