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

// Config (copied from client)
const BLOCK_TYPES = {
    'Grass': { color: 0x4d9043, cost: { iron: 5 }, breakTime: 1.2, buyAmount: 8, hasTexture: true },
    'Glass': { color: 0xade8f4, cost: { iron: 5 }, breakTime: 0.4, buyAmount: 16, opacity: 0.6 },
    'Wood': { color: 0x5d4037, cost: { gold: 5 }, breakTime: 3, buyAmount: 32, hasTexture: true },
    'Stone': { color: 0x777777, cost: { gold: 5 }, breakTime: 6, buyAmount: 8, hasTexture: true },
    'Obsidian': { color: 0x111111, cost: { emerald: 1 }, breakTime: 12, buyAmount: 1, hasTexture: true },
    'Bed': { color: 0xff4444, cost: {}, breakTime: 2, buyAmount: 1, isBed: true } // Bed cannot be bought
};
const MAX_STACK = 64;
const INVENTORY_SIZE = 9;
const MAX_RESOURCES_PER_GENERATOR = 64;
const ISLAND_SPACING = 48;
const ISLAND_GRID_SIZE = 7;

// State
const blocks = new Map(); // `${x},${y},${z}` -> type
const pickups = new Map(); // id -> {x, y, z, resourceType}
const spawners = [];
const players = new Map(); // id -> {pos: {x,y,z}, rot: {yaw, pitch}, crouch: bool, inventory: array, currency: obj, selected: num, bedPosition: {x,y,z}, hasBed: bool, health: number, isDead: bool}
const islandOwners = new Map(); // islandKey -> playerId
const playerIslands = new Map(); // playerId -> islandKey

function blockKey(x, y, z) {
    return `${x},${y},${z}`;
}

function islandKey(x, z) {
    return `${Math.floor((x + 144) / ISLAND_SPACING)},${Math.floor((z + 144) / ISLAND_SPACING)}`;
}

function getAvailableIsland() {
    // ISLAND_GRID_SIZE x ISLAND_GRID_SIZE grid of possible islands
    for (let ix = 0; ix < ISLAND_GRID_SIZE; ix++) {
        for (let iz = 0; iz < ISLAND_GRID_SIZE; iz++) {
            const key = `${ix},${iz}`;
            if (!islandOwners.has(key)) {
                const x = ix * ISLAND_SPACING - 144;
                const z = iz * ISLAND_SPACING - 144;
                return { x, z, key };
            }
        }
    }
    // If all islands taken, use a random position far away
    const x = 300 + Math.floor(Math.random() * 100);
    const z = 300 + Math.floor(Math.random() * 100);
    return { x, z, key: 'overflow' };
}

function addBlock(x, y, z, type) {
    const key = blockKey(x, y, z);
    if (blocks.has(key)) return false;
    blocks.set(key, type);
    
    // If this is a bed, check if it's on an island and assign to player
    if (type === 'Bed') {
        const islandKeyForBed = islandKey(x, z);
        // Find player who owns this island
        for (const [playerId, island] of playerIslands.entries()) {
            if (island === islandKeyForBed) {
                const player = players.get(playerId);
                if (player) {
                    player.bedPosition = { x, y: y + 1, z }; // Spawn above bed
                    player.hasBed = true;
                }
                break;
            }
        }
    }
    
    io.emit('addBlock', { x, y, z, type });
    return true;
}

function removeBlock(x, y, z) {
    const key = blockKey(x, y, z);
    if (!blocks.has(key)) return false;
    const type = blocks.get(key);
    
    // If removing a bed, update player's bed status
    if (type === 'Bed') {
        const islandKeyForBed = islandKey(x, z);
        for (const [playerId, island] of playerIslands.entries()) {
            if (island === islandKeyForBed) {
                const player = players.get(playerId);
                if (player && player.bedPosition && 
                    Math.abs(player.bedPosition.x - x) < 1 && 
                    Math.abs(player.bedPosition.z - z) < 1) {
                    player.hasBed = false;
                    player.bedPosition = null;
                    io.to(playerId).emit('bedDestroyed');
                }
                break;
            }
        }
    }
    
    blocks.delete(key);
    io.emit('removeBlock', { x, y, z });
    return true;
}

function spawnPickup(x, y, z, resourceType) {
    // Check resource limit for this spawner area
    const nearbyResources = Array.from(pickups.values()).filter(p => 
        Math.abs(p.x - x) < 5 && Math.abs(p.z - z) < 5 && p.resourceType === resourceType
    );
    
    if (nearbyResources.length >= MAX_RESOURCES_PER_GENERATOR) {
        return null;
    }
    
    const id = `${Date.now()}-${Math.random().toString(36).substring(7)}`;
    pickups.set(id, { x, y, z, resourceType });
    io.emit('addPickup', { id, x, y, z, resourceType });
    return id;
}

function addToInventory(inv, type, amount) {
    let remaining = amount;
    // Fill existing stacks
    for (let i = 0; i < INVENTORY_SIZE; i++) {
        if (inv[i] && inv[i].type === type && inv[i].count < MAX_STACK) {
            const space = MAX_STACK - inv[i].count;
            const add = Math.min(space, remaining);
            inv[i].count += add;
            remaining -= add;
            if (remaining === 0) return true;
        }
    }
    // New stacks
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

// Create player island with bed
function createPlayerIsland(offsetX, offsetZ, playerId) {
    // Create 8x8 grass island
    for (let x = 0; x < 8; x++) {
        for (let z = 0; z < 8; z++) {
            addBlock(offsetX + x, 0, offsetZ + z, 'Grass');
        }
    }
    
    // Add bed in center
    const bedX = offsetX + 4;
    const bedZ = offsetZ + 4;
    addBlock(bedX, 1, bedZ, 'Bed');
    
    // Add resource generators around the island
    const generators = [
        { x: offsetX + 1, z: offsetZ + 1, type: 'iron', interval: 3 },
        { x: offsetX + 6, z: offsetZ + 1, type: 'gold', interval: 8 },
        { x: offsetX + 1, z: offsetZ + 6, type: 'emerald', interval: 10 }
    ];
    
    generators.forEach(gen => {
        const s = {
            x: gen.x + 0.5, y: 1.5, z: gen.z + 0.5,
            resourceType: gen.type,
            interval: gen.interval * 1000,
            lastSpawn: Date.now()
        };
        spawners.push(s);
    });
    
    // Mark island as owned
    const key = islandKey(offsetX, offsetZ);
    islandOwners.set(key, playerId);
    playerIslands.set(playerId, key);
}

// Create initial resource islands (no beds)
function createResourceIsland(offsetX, offsetZ, spawnerType = null) {
    for (let x = 0; x < 6; x++) {
        for (let z = 0; z < 6; z++) {
            addBlock(offsetX + x, 0, offsetZ + z, 'Grass');
        }
    }
    if (spawnerType) {
        const s = {
            x: offsetX + 2.5, y: 1.5, z: offsetZ + 2.5,
            resourceType: spawnerType.type,
            interval: spawnerType.interval * 1000,
            lastSpawn: Date.now()
        };
        spawners.push(s);
    }
}

// Create resource islands in between player islands
createResourceIsland(-60, -60, { type: 'iron', interval: 3 });
createResourceIsland(12, -60, { type: 'gold', interval: 8 });
createResourceIsland(84, -60, { type: 'emerald', interval: 10 });
createResourceIsland(-60, 12, { type: 'iron', interval: 3 });
createResourceIsland(84, 12, { type: 'gold', interval: 8 });
createResourceIsland(-60, 84, { type: 'emerald', interval: 10 });
createResourceIsland(12, 84, { type: 'iron', interval: 3 });
createResourceIsland(84, 84, { type: 'gold', interval: 8 });

// Socket connections
io.on('connection', (socket) => {
    console.log(`New connection: ${socket.id}`);
    
    // Find available island for this player
    const island = getAvailableIsland();
    const spawnX = island.x + 4;
    const spawnZ = island.z + 4;
    
    createPlayerIsland(island.x, island.z, socket.id);
    
    const playerState = {
        pos: { x: spawnX + 0.5, y: 5, z: spawnZ + 0.5 },
        rot: { yaw: 0, pitch: 0 },
        crouch: false,
        inventory: new Array(INVENTORY_SIZE).fill(null),
        currency: { iron: 0, gold: 0, emerald: 0 },
        selected: 0,
        bedPosition: { x: spawnX + 4, y: 2, z: spawnZ + 4 },
        hasBed: true,
        health: 100,
        isDead: false
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
        spawners,
        bedPosition: playerState.bedPosition 
    });

    // Send your ID
    socket.emit('yourId', socket.id);

    // Send other players
    const otherPlayers = Array.from(players.entries())
        .filter(([id]) => id !== socket.id)
        .map(([id, p]) => ({ 
            id, 
            pos: p.pos, 
            rot: p.rot, 
            crouch: p.crouch,
            health: p.health,
            isDead: p.isDead
        }));
    socket.emit('playersSnapshot', otherPlayers);

    // Broadcast new player
    socket.broadcast.emit('newPlayer', { 
        id: socket.id, 
        pos: playerState.pos, 
        rot: playerState.rot, 
        crouch: playerState.crouch,
        health: playerState.health,
        isDead: playerState.isDead
    });

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
        if (!pickups.has(id)) return;
        const pickup = pickups.get(id);
        const p = players.get(socket.id);
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
        const key = blockKey(x, y, z);
        if (!blocks.has(key)) {
            socket.emit('revertBreak', { x, y, z, type: null });
            return;
        }
        const p = players.get(socket.id);
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
        
        // Check if player is breaking their own bed
        if (type === 'Bed') {
            const islandKeyForBlock = islandKey(x, z);
            const playerIsland = playerIslands.get(socket.id);
            if (islandKeyForBlock === playerIsland) {
                p.hasBed = false;
                p.bedPosition = null;
                socket.emit('bedDestroyed');
            }
        }
        
        if (addToInventory(p.inventory, type, 1)) {
            removeBlock(x, y, z);
            socket.emit('updateInventory', p.inventory.map(slot => slot ? { ...slot } : null));
        } else {
            socket.emit('revertBreak', { x, y, z, type });
            socket.emit('notification', { message: "Inventory full!", type: 'error' });
        }
    });

    socket.on('placeAttempt', ({ x, y, z, type }) => {
        const key = blockKey(x, y, z);
        if (blocks.has(key)) {
            socket.emit('revertPlace', { x, y, z });
            return;
        }
        const p = players.get(socket.id);
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
        
        // Check if placing on own island
        const islandKeyForPlace = islandKey(x, z);
        const playerIsland = playerIslands.get(socket.id);
        if (islandKeyForPlace !== playerIsland && islandOwners.has(islandKeyForPlace)) {
            socket.emit('revertPlace', { x, y, z });
            socket.emit('notification', { message: "Cannot build on other players' islands!", type: 'error' });
            return;
        }
        
        slot.count--;
        if (slot.count === 0) p.inventory[p.selected] = null;
        addBlock(x, y, z, type);
        socket.emit('updateInventory', p.inventory.map(slot => slot ? { ...slot } : null));
    });

    socket.on('buyAttempt', (btype) => {
        const data = BLOCK_TYPES[btype];
        if (!data) {
            socket.emit('buyFailed', 'Invalid block type');
            return;
        }
        const p = players.get(socket.id);
        if (!canAfford(p.currency, data.cost)) {
            socket.emit('buyFailed', 'Not enough resources');
            return;
        }
        if (!addToInventory(p.inventory, btype, data.buyAmount)) {
            socket.emit('buyFailed', 'Inventory full');
            return;
        }
        deductCurrency(p.currency, data.cost);
        socket.emit('updateCurrency', { ...p.currency });
        socket.emit('updateInventory', p.inventory.map(slot => slot ? { ...slot } : null));
        socket.emit('notification', { message: `Purchased ${data.buyAmount}x ${btype}`, type: 'success' });
    });

    socket.on('respawnRequest', () => {
        const p = players.get(socket.id);
        if (p) {
            p.isDead = false;
            p.health = 100;
            
            if (p.hasBed && p.bedPosition) {
                p.pos = { ...p.bedPosition };
                socket.emit('respawn', p.pos);
                socket.emit('updateHealth', { health: p.health, isDead: p.isDead });
                socket.emit('notification', { message: "Respawning at your bed", type: 'info' });
            } else {
                // Respawn at world spawn if no bed
                p.pos = { x: 0, y: 10, z: 0 };
                socket.emit('respawn', p.pos);
                socket.emit('updateHealth', { health: p.health, isDead: p.isDead });
                socket.emit('notification', { message: "No bed found. Respawning at world spawn.", type: 'warning' });
            }
            
            io.emit('playerRespawned', { id: socket.id, pos: p.pos, health: p.health });
        }
    });

    socket.on('damagePlayer', ({ damage, attackerId }) => {
        const p = players.get(socket.id);
        if (p && !p.isDead) {
            p.health = Math.max(0, p.health - damage);
            socket.emit('updateHealth', { health: p.health, isDead: p.health <= 0 });
            
            if (p.health <= 0) {
                p.isDead = true;
                socket.emit('death', { message: "You died! Press R to respawn." });
                io.emit('playerDied', { id: socket.id, attackerId });
            }
        }
    });

    socket.on('disconnect', () => {
        console.log(`Disconnected: ${socket.id}`);
        const player = players.get(socket.id);
        if (player) {
            // Free up the island for new players
            const islandKey = playerIslands.get(socket.id);
            if (islandKey) {
                islandOwners.delete(islandKey);
                playerIslands.delete(socket.id);
            }
            
            players.delete(socket.id);
            io.emit('removePlayer', socket.id);
        }
    });
});

// Game loop (spawns + player sync)
setInterval(() => {
    const now = Date.now();
    
    // Spawn resources from spawners
    spawners.forEach((s) => {
        if (now - s.lastSpawn >= s.interval) {
            const spawned = spawnPickup(s.x, s.y + 0.8, s.z, s.resourceType);
            if (spawned) {
                s.lastSpawn = now;
            }
        }
    });

    // Sync players (20 FPS)
    const states = Array.from(players.entries()).map(([id, p]) => {
        return { 
            id, 
            pos: p.pos, 
            rot: p.rot, 
            crouch: p.crouch,
            health: p.health,
            isDead: p.isDead
        };
    });
    if (states.length > 0) {
        io.emit('playersUpdate', states);
    }
}, 50);
