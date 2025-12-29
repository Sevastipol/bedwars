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
    'Bed': { color: 0xff0000, breakTime: 2, buyAmount: 1, hasTexture: false },
    'Enderpearl': { color: 0x00ff88, cost: { emerald: 2 }, buyAmount: 1, isItem: true, hasTexture: true }
};
const MAX_STACK = 64;
const INVENTORY_SIZE = 9;
const BED_DESTRUCTION_TIME = 10 * 60 * 1000;
const ROUND_DURATION = 15 * 60 * 1000;
const REQUIRED_PLAYERS = 2;

// State
const blocks = new Map();
const pickups = new Map();
const spawners = [];
const players = new Map();
const projectiles = new Map(); // For Enderpearls
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
                io.emit('gameEnd', { winner: winnerId });
            } else {
                io.emit('gameEnd', { winner: null });
            }
            
            setTimeout(resetGame, 5000);
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
    projectiles.clear();
    
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
        p.pos = { x: 9 + 2.5, y: 50, z: 9 + 2.5 };
        
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
                                    assignedPlayers.push(id);
                                    
                                    io.to(id).emit('assignBed', assignment);
                                    io.to(id).emit('setSpectator', false);
                                }
                            }
                        });
                        
                        // Check if we have enough players after assignment
                        const activeAfterAssignment = getActivePlayers();
                        if (activeAfterAssignment.length >= REQUIRED_PLAYERS) {
                            gameActive = true;
                            roundStartTime = Date.now();
                            
                            // Start resource spawning
                            spawners.forEach(s => s.lastSpawn = Date.now());
                            
                            // Start round timer
                            startRoundTimer();
                            
                            io.emit('gameStart');
                        } else {
                            // Not enough players, cancel game
                            io.emit('notification', 'Not enough players assigned. Waiting...');
                            assignedPlayers.forEach(id => {
                                const p = players.get(id);
                                p.spectator = true;
                                p.bedPos = null;
                                io.to(id).emit('setSpectator', true);
                            });
                            // Free up occupied islands
                            occupiedIronIslands = [];
                            // Reset world
                            initWorld();
                        }
                    }
                }, 1000);
            }
        }
    }, 1000);
}

// Socket connections
io.on('connection', (socket) => {
    console.log(`New connection: ${socket.id}`);
    
    // New players always start as spectators
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
        id: socket.id
    };
    
    players.set(socket.id, playerState);

    // Send initial world
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

    // Send your ID
    socket.emit('yourId', socket.id);
    
    // Set spectator mode
    socket.emit('setSpectator', true);

    // Send other players (excluding spectators)
    const otherPlayers = Array.from(players.entries())
        .filter(([id]) => id !== socket.id)
        .filter(([_, p]) => !p.spectator)
        .map(([id, p]) => ({ 
            id, 
            pos: p.pos, 
            rot: p.rot, 
            crouch: p.crouch,
            spectator: p.spectator 
        }));
    socket.emit('playersSnapshot', otherPlayers);

    // Broadcast new player (as spectator)
    socket.broadcast.emit('newPlayer', { 
        id: socket.id, 
        pos: playerState.pos, 
        rot: playerState.rot, 
        crouch: playerState.crouch,
        spectator: playerState.spectator 
    });

    // Update waiting message
    updateWaitingMessages();

    // If this is first player, start player check
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
        
        if (type === 'Bed') {
            // Check if it's the player's own bed
            if (p.bedPos && p.bedPos.x === x && p.bedPos.y === y && p.bedPos.z === z) {
                socket.emit('notification', 'You cannot break your own bed!');
                socket.emit('revertBreak', { x, y, z, type: 'Bed' });
                return;
            }
            
            removeBlock(x, y, z);
            return;
        }
        
        const dist = Math.hypot(
            p.pos.x - (x + 0.5),
            (p.pos.y - (p.crouch ? 1.3 : 1.6)) - (y + 0.5),
            p.pos.z - (z + 0.5)
        );
        
        if (dist > 5) {
            socket.emit('revertBreak', { x, y, z, type });
            return;
        }
        
        if (addToInventory(p.inventory, type, 1)) {
            removeBlock(x, y, z);
            socket.emit('updateInventory', p.inventory.map(slot => slot ? { ...slot } : null));
        } else {
            socket.emit('revertBreak', { x, y, z, type });
        }
    });

    socket.on('placeAttempt', ({ x, y, z, type }) => {
        const p = players.get(socket.id);
        if (p.spectator) return;
        
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
    });

    // Enderpearl throwing
    socket.on('throwEnderpearl', () => {
        const p = players.get(socket.id);
        if (p.spectator) return;
        
        // Check if player has an enderpearl in selected slot
        const slot = p.inventory[p.selected];
        if (!slot || slot.type !== 'Enderpearl' || slot.count < 1) {
            socket.emit('notification', 'No Enderpearl in selected slot!');
            return;
        }
        
        // Remove one enderpearl from inventory
        slot.count--;
        if (slot.count === 0) {
            p.inventory[p.selected] = null;
        }
        
        // Update player inventory
        socket.emit('updateInventory', p.inventory.map(slot => slot ? { ...slot } : null));
        
        // Calculate throw direction based on player rotation
        const throwPower = 1.2; // Adjust this value for throw distance
        const velocity = {
            x: -Math.sin(p.rot.yaw) * Math.cos(p.rot.pitch) * throwPower,
            y: Math.sin(p.rot.pitch) * throwPower,
            z: -Math.cos(p.rot.yaw) * Math.cos(p.rot.pitch) * throwPower
        };
        
        // Create projectile
        const projectileId = `pearl-${socket.id}-${Date.now()}-${Math.random()}`;
        const projectile = {
            id: projectileId,
            owner: socket.id,
            x: p.pos.x,
            y: p.pos.y + (p.crouch ? 1.3 : 1.6), // Eye height
            z: p.pos.z,
            vx: velocity.x,
            vy: velocity.y,
            vz: velocity.z,
            gravity: 0.05,
            createdAt: Date.now(),
            landed: false
        };
        
        projectiles.set(projectileId, projectile);
        
        // Broadcast to all clients
        io.emit('addProjectile', projectile);
    });

    socket.on('disconnect', () => {
        console.log(`Disconnected: ${socket.id}`);
        
        const p = players.get(socket.id);
        if (p) {
            // Remove player's bed if they have one
            if (p.bedPos) {
                removeBlock(p.bedPos.x, p.bedPos.y, p.bedPos.z);
                
                // Find and free the occupied island
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
            
            players.delete(socket.id);
            io.emit('removePlayer', socket.id);
            
            updateWaitingMessages();
            
            // Check if we need to cancel countdown
            if (!gameActive && countdownTimer) {
                const activePlayers = getActivePlayers();
                if (activePlayers.length < REQUIRED_PLAYERS) {
                    clearInterval(countdownTimer);
                    countdownTimer = null;
                    io.emit('notification', 'Player left. Countdown cancelled.');
                    occupiedIronIslands = [];
                    initWorld();
                }
            } else if (gameActive) {
                // Check if game should end due to lack of players
                const activePlayers = getActivePlayers();
                if (activePlayers.length <= 1) {
                    gameActive = false;
                    if (activePlayers.length === 1) {
                        const winnerId = Array.from(players.entries()).find(([id, p]) => !p.spectator)[0];
                        io.emit('gameEnd', { winner: winnerId });
                    } else {
                        io.emit('gameEnd', { winner: null });
                    }
                    stopRoundTimer();
                    setTimeout(resetGame, 5000);
                }
            }
        }
    });
});

// Game loop
setInterval(() => {
    const now = Date.now();
    
    if (gameActive) {
        // Spawn resources
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

        // Update projectiles (Enderpearls)
        projectiles.forEach((projectile, id) => {
            if (projectile.landed) return;
            
            // Apply gravity
            projectile.vy -= projectile.gravity;
            
            // Update position
            projectile.x += projectile.vx;
            projectile.y += projectile.vy;
            projectile.z += projectile.vz;
            
            // Check for collision with ground or blocks
            const checkX = Math.floor(projectile.x);
            const checkY = Math.floor(projectile.y);
            const checkZ = Math.floor(projectile.z);
            
            // Check if hit ground
            if (projectile.y <= 0) {
                projectile.landed = true;
                projectile.landTime = now;
                projectile.landX = projectile.x;
                projectile.landY = 0.5; // Slightly above ground
                projectile.landZ = projectile.z;
                
                // Teleport player after short delay
                setTimeout(() => {
                    const player = players.get(projectile.owner);
                    if (player && !player.spectator) {
                        player.pos.x = projectile.landX;
                        player.pos.y = projectile.landY + 1;
                        player.pos.z = projectile.landZ;
                        
                        io.to(projectile.owner).emit('teleport', {
                            x: player.pos.x,
                            y: player.pos.y,
                            z: player.pos.z
                        });
                        
                        // Remove projectile
                        projectiles.delete(id);
                        io.emit('removeProjectile', id);
                    }
                }, 100); // Small delay for visual effect
            }
            // Check for collision with blocks
            else if (blocks.has(blockKey(checkX, checkY, checkZ))) {
                projectile.landed = true;
                projectile.landTime = now;
                projectile.landX = projectile.x;
                projectile.landY = projectile.y;
                projectile.landZ = projectile.z;
                
                // Teleport player after short delay
                setTimeout(() => {
                    const player = players.get(projectile.owner);
                    if (player && !player.spectator) {
                        // Teleport to a safe spot near the impact
                        player.pos.x = projectile.landX;
                        player.pos.y = projectile.landY + 1;
                        player.pos.z = projectile.landZ;
                        
                        io.to(projectile.owner).emit('teleport', {
                            x: player.pos.x,
                            y: player.pos.y,
                            z: player.pos.z
                        });
                        
                        // Remove projectile
                        projectiles.delete(id);
                        io.emit('removeProjectile', id);
                    }
                }, 100);
            }
            
            // Remove old projectiles (safety)
            if (now - projectile.createdAt > 10000) { // 10 seconds max
                projectiles.delete(id);
                io.emit('removeProjectile', id);
            }
        });
        
        // Send projectile updates to clients
        if (projectiles.size > 0) {
            const projectileUpdates = Array.from(projectiles.values())
                .filter(p => !p.landed)
                .map(p => ({
                    id: p.id,
                    x: p.x,
                    y: p.y,
                    z: p.z
                }));
            
            if (projectileUpdates.length > 0) {
                io.emit('updateProjectiles', projectileUpdates);
            }
        }

        // Check for death/respawn
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
                    // Player eliminated
                    p.spectator = true;
                    p.pos = { x: 9 + 2.5, y: 50, z: 9 + 2.5 };
                    io.to(id).emit('setSpectator', true);
                    io.to(id).emit('respawn', { pos: p.pos, rot: p.rot });
                    io.to(id).emit('notification', 'Eliminated! You are now a spectator.');
                    
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
                    
                    // Check if game should end
                    const activePlayers = getActivePlayers();
                    if (activePlayers.length <= 1) {
                        gameActive = false;
                        let winnerId = null;
                        if (activePlayers.length === 1) {
                            winnerId = Array.from(players.entries()).find(([id, p]) => !p.spectator)[0];
                        }
                        io.emit('gameEnd', { winner: winnerId });
                        stopRoundTimer();
                        setTimeout(resetGame, 5000);
                    }
                }
                p.lastRespawn = now;
            }
        });
    }

    // Sync players (20 FPS)
    const states = Array.from(players.entries()).map(([id, p]) => ({
        id,
        pos: p.pos,
        rot: p.rot,
        crouch: p.crouch,
        spectator: p.spectator
    }));
    io.emit('playersUpdate', states);
}, 50);

// Start player check on server start
startPlayerCheck();
