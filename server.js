const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

app.get('/favicon.png', (req, res) => {
    res.sendFile(__dirname + '/favicon.png');
});

// --- RUM & SPEL DATA ---
// Map med RoomCode -> RoomObject
const rooms = new Map();

/**
 * Room Object Structure:
 * {
 *   code: "1234",
 *   adminId: "socketId",
 *   players: [ { id, name, isAdmin } ],
 *   gameState: {
 *      matches: [],
 *      participants: [],
 *      votersPerMatch: 1,
 *      isRunning: false
 *   }
 * }
 */

io.on('connection', (socket) => {
    console.log('Ny anslutning:', socket.id);

    // --- ROOM SETUP EVENTS ---

    // 1. Skapa ett nytt rum
    socket.on('createRoom', (playerName) => {
        const code = generateRoomCode();
        const room = {
            code: code,
            adminId: socket.id,
            players: [{ id: socket.id, name: playerName, isAdmin: true }],
            gameState: {
                matches: [],
                participants: [],
                votersPerMatch: 1,
                isRunning: false
            }
        };
        rooms.set(code, room);
        socket.join(code);

        // Spara rumskod på socketen för snabb åtkomst vid disconnect
        socket.data.roomCode = code;

        socket.emit('roomCreated', { code: code, isAdmin: true, name: playerName });
        io.to(code).emit('updateLobby', room.players);
    });

    // 2. Kontrollera om rum finns (för frontend validering)
    socket.on('checkRoom', (code, callback) => {
        callback(rooms.has(code));
    });

    // 3. Gå med i ett rum
    socket.on('joinRoom', ({ code, name }) => {
        // Trimma input
        code = (code || "").trim();
        const room = rooms.get(code);

        if (!room) {
            socket.emit('errorMsg', "Rummet hittades inte!");
            return;
        }

        const newPlayer = { id: socket.id, name: name, isAdmin: false };
        room.players.push(newPlayer);
        socket.join(code);
        socket.data.roomCode = code;

        socket.emit('joinedSuccess', {
            code: code,
            isAdmin: false,
            gameState: room.gameState
        });

        io.to(code).emit('updateLobby', room.players);
    });

    // 3.5 Uppdatera namn (för Admin i lobbyn)
    socket.on('updateName', (data) => {
        const code = socket.data.roomCode;
        const room = rooms.get(code);
        if (!room) return;

        const player = room.players.find(p => p.id === socket.id);
        if (player) {
            player.name = data.name;
            io.to(code).emit('updateLobby', room.players);
        }
    });

    // --- GAME EVENTS (Room Scoped) ---

    // 4. Admin startar spelet
    socket.on('startGame', (data) => {
        const code = socket.data.roomCode;
        const room = rooms.get(code);
        if (!room || room.adminId !== socket.id) return;

        // Räkna ut antal röstare
        let calculatedVoters = room.players.length;
        if (!data.adminParticipates) {
            calculatedVoters -= 1; // Admin räknas inte in om de inte deltar
        }

        if (calculatedVoters < 1) calculatedVoters = 1;

        room.gameState.participants = data.participants;
        room.gameState.votersPerMatch = calculatedVoters;
        room.gameState.adminParticipates = data.adminParticipates; // Spara flaggan

        room.gameState.matches = data.matches.map(m => ({
            ...m,
            voters: []
        }));
        room.gameState.isRunning = true;

        io.to(code).emit('gameStarted', room.gameState);
    });

    // 5. Rösta
    socket.on('vote', (data) => {
        const code = socket.data.roomCode;
        const room = rooms.get(code);
        if (!room || !room.gameState.isRunning) return;

        const match = room.gameState.matches.find(m => m.id === data.matchId);
        if (match) {
            // Check if user is allowed to vote
            let isVoteValid = !match.voters.includes(socket.id);

            // Special rule for admin:
            if (socket.id === room.adminId) {
                // If admin is participating, they vote like normal (checked above).
                // If admin is NOT participating, they cannot vote.
                if (!room.gameState.adminParticipates) {
                    isVoteValid = false;
                }
            }

            if (isVoteValid) {
                match.voters.push(socket.id);

                if (data.playerNum === 1) match.v1++;
                else match.v2++;

                checkWinner(room, match);
                io.to(code).emit('updateState', room.gameState);
            }
        }
    });

    // 6. Instant Win
    socket.on('instantWin', (data) => {
        const code = socket.data.roomCode;
        const room = rooms.get(code);
        if (!room || room.adminId !== socket.id) return;

        const match = room.gameState.matches.find(m => m.id === data.matchId);
        if (match) {
            advanceWinner(room, match, data.playerNum);
            io.to(code).emit('updateState', room.gameState);
        }
    });

    // 7. Reset
    socket.on('resetGame', () => {
        const code = socket.data.roomCode;
        const room = rooms.get(code);
        if (!room || room.adminId !== socket.id) return;

        room.gameState.isRunning = false;
        room.gameState.matches = [];
        io.to(code).emit('returnToLobby', room.players);
    });

    // Disconnect
    socket.on('disconnect', () => {
        const code = socket.data.roomCode;
        if (code && rooms.has(code)) {
            const room = rooms.get(code);
            room.players = room.players.filter(p => p.id !== socket.id);

            if (room.players.length === 0) {
                // Rummet är tomt, ta bort det
                rooms.delete(code);
            } else {
                // Om admin lämnade, utse ny admin
                if (socket.id === room.adminId) {
                    room.adminId = room.players[0].id;
                    room.players[0].isAdmin = true;
                    io.to(room.adminId).emit('youAreAdmin');
                }
                io.to(code).emit('updateLobby', room.players);
            }
        }
    });
});

// --- HJÄLPFUNKTIONER ---

function generateRoomCode() {
    // Generera 4 slumpmässiga siffror
    return Math.floor(1000 + Math.random() * 9000).toString();
}

function checkWinner(room, match) {
    const total = match.v1 + match.v2;
    if (total >= room.gameState.votersPerMatch) {
        if (match.v1 > match.v2) advanceWinner(room, match, 1);
        else if (match.v2 > match.v1) advanceWinner(room, match, 2);
    }
}

function advanceWinner(room, match, winnerNum) {
    match.winner = winnerNum;
    const wName = (winnerNum === 1) ? match.p1 : match.p2;

    if (match.next) {
        const nextMatch = room.gameState.matches.find(m => m.id === match.next);
        if (nextMatch) {
            if (nextMatch.src1 === match.id) nextMatch.p1 = wName;
            else if (nextMatch.src2 === match.id) nextMatch.p2 = wName;
        }
    }
}

server.listen(3000, () => {
    console.log('------------------------------------------------');
    console.log('✅ Servern är igång (Internt: 3000)');
    console.log('🌍 Gå till: http://<DIN-SERVER-IP>:3050');
    console.log('------------------------------------------------');
});