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

// --- Configuration ---
const MAX_DROPS_PER_SPAWNER = 64;
const VOID_Y_LEVEL = -20;

// Island Layout (4 Teams)
const ISLANDS = [
    { id: 'red', color: 'Red', hex: 0xff4444, x: -25, z: -25, owner: null },
    { id: 'blue', color: 'Blue', hex: 0x4444ff, x: 25, z: -25, owner: null },
    { id: 'green', color: 'Green', hex: 0x44ff44, x: -25, z: 25, owner: null },
    { id: 'yellow', color: 'Yellow', hex: 0xffff44, x: 25, z: 25, owner: null }
];

const BLOCK_TYPES = {
    'Grass': { buyAmount: 8, cost: { iron: 4 } },
    'Wood': { buyAmount: 16, cost: { gold: 4 } },
    'Stone': { buyAmount: 16, cost: { iron: 10 } },
    'Obsidian': { buyAmount: 1, cost: { emerald: 4 } },
    'Bed': { buyAmount: 0, cost: { emerald: 999 } } // Not buyable
};

// --- Game State ---
const blocks = new Map(); // Key: "x,y,z" -> type
const pickups = new Map(); // Key: id -> {x,y,z,type,spawnerId}
const players = new Map(); // Key: socket.id -> Player Object
const spawners = [];

// Helper to generate map key
const getKey = (x, y, z) => `${x},${y},${z}`;

// --- World Generation ---
function initWorld() {
    // Generate 4 Islands
    ISLANDS.forEach(island => {
        const startX = island.x;
        const startZ = island.z;
        const startY = 0;

        // Platform 5x5
        for (let x = -2; x <= 2; x++) {
            for (let z = -2; z <= 2; z++) {
                blocks.set(getKey(startX + x, startY, startZ + z), 'Grass');
            }
        }

        // Place Bed (Hardcoded position on island)
        const bedX = startX; 
        const bedY = startY + 1;
        const bedZ = startZ - 1;
        blocks.set(getKey(bedX, bedY, bedZ), 'Bed');
        island.bedLocation = { x: bedX, y: bedY, z: bedZ };

        // Add Generator (Iron)
        spawners.push({
            id: `gen_${island.id}`,
            x: startX, y: startY + 1.5, z: startZ + 1,
            type: 'iron',
            interval: 2000,
            lastSpawn: Date.now()
        });
    });

    // Middle Islands (Gold/Diamond)
    const midSpawners = [
        { x: 0, z: 10, type: 'gold', interval: 5000 },
        { x: 0, z: -10, type: 'gold', interval: 5000 },
        { x: 0, z: 0, type: 'emerald', interval: 12000 }
    ];

    midSpawners.forEach((s, i) => {
        // Small platform
        for(let x=-1; x<=1; x++) {
            for(let z=-1; z<=1; z++) {
                blocks.set(getKey(s.x + x, 0, s.z + z), 'Stone');
            }
        }
        spawners.push({
            id: `mid_${i}`,
            x: s.x, y: 1.5, z: s.z,
            type: s.type,
            interval: s.interval,
            lastSpawn: Date.now()
        });
    });
}

initWorld();

// --- Functions ---

function getDropCountForSpawner(spawnerId) {
    let count = 0;
    for (const p of pickups.values()) {
        if (p.spawnerId === spawnerId) count++;
    }
    return count;
}

function killPlayer(socket, final) {
    const player = players.get(socket.id);
    if (!player) return;

    if (final) {
        player.dead = true;
        // Teleport to spectator box
        player.pos = { x: 0, y: 30, z: 0 };
        socket.emit('notification', 'ELIMINATED! You are now a spectator.', '#ff0000', 0); // 0 = permanent
        socket.emit('setSpectator');
        io.emit('chatMessage', `Player ${player.team ? player.team.color : 'Unknown'} was ELIMINATED!`);
    } else {
        // Respawn
        const island = player.team;
        if (island) {
            player.pos = { x: island.x, y: 5, z: island.z };
            player.velocity = { x: 0, y: 0, z: 0 };
            socket.emit('teleport', player.pos);
            socket.emit('notification', 'You died! Respawning...', '#ffaa00', 3000);
        }
    }
}

// --- Socket Logic ---
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Assign Team/Island
    let team = ISLANDS.find(i => i.owner === null);
    
    // Default spawn (Hub/Spectator if full)
    let startPos = { x: 0, y: 10, z: 0 };
    let hasBed = false;

    if (team) {
        team.owner = socket.id;
        startPos = { x: team.x, y: 5, z: team.z };
        hasBed = true;
        socket.emit('notification', `You are on the ${team.color} Team!`, team.hex, 5000);
    } else {
        socket.emit('notification', 'Server Full! Spectator Mode.', '#ffffff', 5000);
        socket.emit('setSpectator');
    }

    const playerState = {
        id: socket.id,
        team: team, // Reference to island object
        pos: startPos,
        rot: { yaw: 0, pitch: 0 },
        crouch: false,
        inventory: new Array(9).fill(null),
        currency: { iron: 0, gold: 0, emerald: 0 },
        hasBed: hasBed,
        dead: !team // If no team, technically "dead"/spectator
    };
    players.set(socket.id, playerState);

    // Initial Data Send
    socket.emit('init', {
        id: socket.id,
        blocks: Array.from(blocks.entries()).map(([k, v]) => {
            const [x, y, z] = k.split(',').map(Number);
            return { x, y, z, type: v };
        }),
        pickups: Array.from(pickups.entries()).map(([k, v]) => ({ id: k, ...v })),
        position: startPos
    });

    // --- In-Game Events ---

    socket.on('playerUpdate', (data) => {
        const p = players.get(socket.id);
        if (!p) return;

        p.pos = data.pos;
        p.rot = data.rot;
        p.crouch = data.crouch;

        // Broadcast to others (throttled by client emit rate usually, but good to relay)
        socket.broadcast.emit('remotePlayerUpdate', {
            id: socket.id,
            pos: p.pos,
            rot: p.rot,
            crouch: p.crouch,
            teamColor: p.team ? p.team.hex : 0xffffff
        });

        // Void Check
        if (!p.dead && p.pos.y < VOID_Y_LEVEL) {
            if (p.hasBed) {
                killPlayer(socket, false);
            } else {
                killPlayer(socket, true);
            }
        }
    });

    socket.on('placeBlock', (data) => {
        const p = players.get(socket.id);
        if (!p || p.dead) return;

        // Check distance
        const dist = Math.hypot(data.x - p.pos.x, data.y - p.pos.y, data.z - p.pos.z);
        if (dist > 8) return;

        const key = getKey(data.x, data.y, data.z);
        if (blocks.has(key)) return;

        // Inventory check
        const item = p.inventory[data.slot];
        if (item && item.type === data.type && item.count > 0) {
            item.count--;
            if (item.count <= 0) p.inventory[data.slot] = null;
            
            blocks.set(key, data.type);
            io.emit('blockUpdate', { action: 'add', x: data.x, y: data.y, z: data.z, type: data.type });
            socket.emit('inventoryUpdate', p.inventory);
        }
    });

    socket.on('breakBlock', (data) => {
        const p = players.get(socket.id);
        if (!p || p.dead) return;

        const key = getKey(data.x, data.y, data.z);
        const type = blocks.get(key);
        
        if (!type) return;

        // Handle Bed Destruction
        if (type === 'Bed') {
            const victimTeam = ISLANDS.find(i => 
                i.bedLocation && 
                i.bedLocation.x === data.x && 
                i.bedLocation.y === data.y && 
                i.bedLocation.z === data.z
            );

            if (victimTeam) {
                // Notify Everyone
                io.emit('notification', `${victimTeam.color} Team's Bed was destroyed!`, '#ff0000', 4000);
                
                // Update Victim State
                const victimSocketId = victimTeam.owner;
                const victimPlayer = players.get(victimSocketId);
                if (victimPlayer) {
                    victimPlayer.hasBed = false;
                    // Specific alert for victim
                    io.to(victimSocketId).emit('notification', 'YOUR BED IS GONE! You will not respawn.', '#ff0000', 8000);
                }
            }
        }

        blocks.delete(key);
        io.emit('blockUpdate', { action: 'remove', x: data.x, y: data.y, z: data.z });
        
        // Add drop to inventory (if not bed)
        if (type !== 'Bed') {
            // Simplified: direct add for demo
            // In full game: drop item entity or check stack limit
        }
    });

    socket.on('buyItem', (type) => {
        const p = players.get(socket.id);
        if (!p || p.dead) return;

        const itemInfo = BLOCK_TYPES[type];
        if (!itemInfo) return;

        // Check Cost
        let canAfford = true;
        for (let [res, amt] of Object.entries(itemInfo.cost)) {
            if (p.currency[res] < amt) canAfford = false;
        }

        if (canAfford) {
            // Deduct
            for (let [res, amt] of Object.entries(itemInfo.cost)) {
                p.currency[res] -= amt;
            }
            // Add to Inventory
            let added = false;
            // Try stack
            for(let i=0; i<9; i++) {
                if (p.inventory[i] && p.inventory[i].type === type && p.inventory[i].count < 64) {
                    p.inventory[i].count += itemInfo.buyAmount;
                    added = true;
                    break;
                }
            }
            // Empty slot
            if (!added) {
                for(let i=0; i<9; i++) {
                    if (!p.inventory[i]) {
                        p.inventory[i] = { type: type, count: itemInfo.buyAmount };
                        added = true;
                        break;
                    }
                }
            }

            if (!added) {
                // Refund if full
                for (let [res, amt] of Object.entries(itemInfo.cost)) {
                    p.currency[res] += amt;
                }
                socket.emit('notification', 'Inventory Full!', 'orange', 2000);
            } else {
                socket.emit('currencyUpdate', p.currency);
                socket.emit('inventoryUpdate', p.inventory);
            }
        } else {
            socket.emit('notification', 'Not enough resources!', 'red', 2000);
        }
    });

    socket.on('pickup', (id) => {
        const p = players.get(socket.id);
        if (!p || p.dead) return;
        
        const pickup = pickups.get(id);
        if (pickup) {
            const dist = Math.hypot(pickup.x - p.pos.x, pickup.y - p.pos.y, pickup.z - p.pos.z);
            if (dist < 3) {
                p.currency[pickup.type]++;
                pickups.delete(id);
                io.emit('removePickup', id);
                socket.emit('currencyUpdate', p.currency);
            }
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        const p = players.get(socket.id);
        if (p && p.team) {
            p.team.owner = null; // Free up the island
        }
        players.delete(socket.id);
        io.emit('removePlayer', socket.id);
    });
});

// --- Game Loop (Spawners) ---
setInterval(() => {
    const now = Date.now();
    spawners.forEach(s => {
        if (now - s.lastSpawn > s.interval) {
            // Limit Check
            if (getDropCountForSpawner(s.id) < MAX_DROPS_PER_SPAWNER) {
                const id = Math.random().toString(36).substr(2, 9);
                const pickup = { x: s.x, y: s.y, z: s.z, type: s.type, spawnerId: s.id };
                pickups.set(id, pickup);
                io.emit('addPickup', { id, ...pickup });
            }
            s.lastSpawn = now;
        }
    });
}, 100);
