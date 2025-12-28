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
    'Bed': { color: 0xff0000, breakTime: 1 }
};

const MAX_STACK = 64;
const INVENTORY_SIZE = 9;

// State
const blocks = new Map();
const pickups = new Map();
const spawners = [];
const players = new Map();

// --- ISLANDS & BEDS ---
const ISLANDS = [];
const PLAYER_ISLAND = new Map(); // playerId -> island

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
    blocks.delete(key);
    io.emit('removeBlock', { x, y, z });
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

// --- Island Registration ---
function registerIsland(cx, cz) {
    ISLANDS.push({
        cx,
        cz,
        owner: null,
        bedDestroyed: false
    });

    // Base platform
    for (let x = 0; x < 6; x++) {
        for (let z = 0; z < 6; z++) {
            addBlock(cx + x, 0, cz + z, 'Grass');
        }
    }

    // Bed
    addBlock(cx + 2, 1, cz + 2, 'Bed');
}

// Islands
registerIsland(-15, -15);
registerIsland(33, -15);
registerIsland(-15, 33);
registerIsland(33, 33);

registerIsland(9, -15);
registerIsland(9, 33);
registerIsland(9, 9);

// Spawners
function createSpawner(x, z, type, interval) {
    spawners.push({
        x,
        y: 1,
        z,
        resourceType: type,
        interval: interval * 1000,
        lastSpawn: Date.now()
    });
}

createSpawner(-12, -12, 'iron', 3);
createSpawner(36, -12, 'iron', 3);
createSpawner(-12, 36, 'iron', 3);
createSpawner(36, 36, 'iron', 3);
createSpawner(12, -12, 'gold', 8);
createSpawner(12, 36, 'gold', 8);
createSpawner(12, 12, 'emerald', 10);

// Socket connections
io.on('connection', (socket) => {
    console.log(`New connection: ${socket.id}`);

    // Assign island
    let island = ISLANDS.find(i => i.owner === null) || ISLANDS[0];
    island.owner = socket.id;
    PLAYER_ISLAND.set(socket.id, island);

    const playerState = {
        pos: { x: island.cx + 2.5, y: 5, z: island.cz + 2.5 },
        rot: { yaw: 0, pitch: 0 },
        crouch: false,
        inventory: new Array(INVENTORY_SIZE).fill(null),
        currency: { iron: 0, gold: 0, emerald: 0 },
        selected: 0
    };
    players.set(socket.id, playerState);

    // Initial world
    const initBlocks = Array.from(blocks, ([key, type]) => {
        const [x, y, z] = key.split(',').map(Number);
        return { x, y, z, type };
    });
    const initPickups = Array.from(pickups, ([id, data]) => ({ id, ...data }));
    socket.emit('initWorld', { blocks: initBlocks, pickups: initPickups, spawners });

    socket.emit('yourId', socket.id);

    const otherPlayers = Array.from(players.entries())
        .filter(([id]) => id !== socket.id)
        .map(([id, p]) => ({ id, pos: p.pos, rot: p.rot, crouch: p.crouch }));
    socket.emit('playersSnapshot', otherPlayers);

    socket.broadcast.emit('newPlayer', { id: socket.id, pos: playerState.pos, rot: playerState.rot, crouch: playerState.crouch });

    socket.on('playerUpdate', (data) => {
        const p = players.get(socket.id);
        if (p) Object.assign(p, data);
    });

    socket.on('claimPickupAttempt', (id) => {
        if (!pickups.has(id)) return;
        const pickup = pickups.get(id);
        const p = players.get(socket.id);
        const dist = Math.hypot(p.pos.x - pickup.x, p.pos.y - pickup.y, p.pos.z - pickup.z);
        if (dist >= 1.5) return;

        p.currency[pickup.resourceType]++;
        pickups.delete(id);
        io.emit('removePickup', id);
        socket.emit('updateCurrency', { ...p.currency });
    });

    socket.on('breakAttempt', ({ x, y, z }) => {
        const key = blockKey(x, y, z);
        if (!blocks.has(key)) return;

        const type = blocks.get(key);

        // Bed logic
        if (type === 'Bed') {
            const island = ISLANDS.find(i =>
                Math.abs(i.cx + 2 - x) <= 3 &&
                Math.abs(i.cz + 2 - z) <= 3
            );
            if (island) island.bedDestroyed = true;
        }

        const p = players.get(socket.id);
        if (addToInventory(p.inventory, type, 1)) {
            removeBlock(x, y, z);
            socket.emit('updateInventory', p.inventory);
        }
    });

    socket.on('placeAttempt', ({ x, y, z, type }) => {
        if (blocks.has(blockKey(x, y, z))) return;

        const p = players.get(socket.id);
        const slot = p.inventory[p.selected];
        if (!slot || slot.type !== type || slot.count < 1) return;

        slot.count--;
        if (slot.count === 0) p.inventory[p.selected] = null;

        addBlock(x, y, z, type);
        socket.emit('updateInventory', p.inventory);
    });

    socket.on('respawnRequest', () => {
        const island = PLAYER_ISLAND.get(socket.id);
        if (!island || island.bedDestroyed) {
            socket.emit('respawnDenied');
            return;
        }
        const p = players.get(socket.id);
        p.pos = { x: island.cx + 2.5, y: 5, z: island.cz + 2.5 };
        socket.emit('respawnAt', p.pos);
    });

    socket.on('disconnect', () => {
        console.log(`Disconnected: ${socket.id}`);
        players.delete(socket.id);
        io.emit('removePlayer', socket.id);
    });
});

// Game loop
setInterval(() => {
    const now = Date.now();
    spawners.forEach((s) => {
        if (now - s.lastSpawn >= s.interval) {

            // LIMIT resources to 64
            const count = Array.from(pickups.values())
                .filter(p => p.resourceType === s.resourceType)
                .length;

            if (count < 64) {
                spawnPickup(s.x, s.y + 0.8, s.z, s.resourceType);
            }

            s.lastSpawn = now;
        }
    });

    const states = Array.from(players.entries()).map(([id, p]) =>
        ({ id, pos: p.pos, rot: p.rot, crouch: p.crouch })
    );
    io.emit('playersUpdate', states);
}, 50);
