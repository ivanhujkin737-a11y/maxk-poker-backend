const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const rooms = {};
const suits = ['♥','♦','♣','♠'];
const ranks = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];

function shuffle(a) { for (let i = a.length-1; i > 0; i--) { const j = Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }

io.on('connection', socket => {
    socket.on('joinRoom', data => {
        let { roomId, userId, username, startingChips = 1000 } = data;
        roomId = roomId || uuidv4();

        if (!rooms[roomId]) {
            rooms[roomId] = { players: [], owner: userId, startingChips, pot: 0, phase: 'preflop' };
        }
        const room = rooms[roomId];

        if (room.players.length >= 12) return;
        if (!room.players.find(p => p.userId === userId)) {
            room.players.push({ userId, username, chips: room.startingChips, folded: false });
        }

        socket.join(roomId);
        socket.emit('roomJoined', { roomId, owner: room.owner, startingChips: room.startingChips, players: room.players });
        io.to(roomId).emit('playerUpdate', { players: room.players, pot: room.pot });

        if (room.players.length >= 2) startHand(roomId);
    });

    socket.on('action', data => {
        const room = rooms[data.roomId];
        if (!room) return;
        const player = room.players.find(p => p.userId === data.userId);
        if (!player || room.currentPlayer !== data.userId) return;

        if (data.action === 'fold') player.folded = true;
        if (data.action === 'check') player.called = true;
        if (data.action === 'bet') {
            if (data.amount <= player.chips) {
                player.chips -= data.amount;
                room.pot += data.amount;
                room.currentBet = Math.max(room.currentBet || 0, data.amount);
            }
        }

        io.to(data.roomId).emit('playerUpdate', { players: room.players, pot: room.pot });

        checkRoundEnd(room);
    });
});

function startHand(roomId) {
    const room = rooms[roomId];
    if (!room || room.players.length < 2) return;

    room.pot = 0;
    room.currentBet = 0;
    room.phase = 'preflop';
    room.players.forEach(p => { p.folded = false; p.called = false; });

    const deck = shuffle([...suits.flatMap(s => ranks.map(r => ({suit:s,rank:r})))]);
    const hands = {};
    room.players.forEach(p => hands[p.userId] = [deck.pop(), deck.pop()]);
    room.deck = deck;
    room.community = [];

    room.currentPlayer = room.players[0].userId;
    io.to(roomId).emit('gameStarted', { hands });
    io.to(roomId).emit('turn', { currentPlayer: room.currentPlayer, pot: 0 });
}

function checkRoundEnd(room) {
    const active = room.players.filter(p => !p.folded);
    if (active.length <= 1 || room.players.every(p => p.folded || p.called)) {
        if (room.phase === 'river' || active.length === 1) {
            const winner = active.length === 1 ? active[0] : active[Math.floor(Math.random()*active.length)];
            winner.chips += room.pot;
            io.to(room.roomId).emit('winner', { winner });
            setTimeout(() => startHand(room.roomId), 6000);
        } else {
            // next phase
            if (room.phase === 'preflop') room.community.push(...room.deck.splice(-3,3));
            else room.community.push(room.deck.pop());
            room.phase = room.phase === 'preflop' ? 'flop' : room.phase === 'flop' ? 'turn' : 'river';
            io.to(room.roomId).emit('dealCommunity', room.community);
            room.currentPlayer = room.players.find(p => !p.folded)?.userId || room.players[0].userId;
            io.to(room.roomId).emit('turn', { currentPlayer: room.currentPlayer, pot: room.pot });
        }
    } else {
        let idx = room.players.findIndex(p => p.userId === room.currentPlayer);
        do { idx = (idx + 1) % room.players.length; } while (room.players[idx].folded);
        room.currentPlayer = room.players[idx].userId;
        io.to(room.roomId).emit('turn', { currentPlayer: room.currentPlayer, pot: room.pot });
    }
}

const port = process.env.PORT || 3000;
server.listen(port, () => console.log('Сервер на порту ' + port));
