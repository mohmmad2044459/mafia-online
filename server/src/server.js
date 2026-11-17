import 'dotenv/config';
import http from 'node:http';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import mongoose from 'mongoose';
import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import User from './models/User.js';
import Room from './models/Room.js';
import authRoutes from './routes/auth.routes.js';
import roomRoutes from './routes/rooms.routes.js';
import { createGameState, publicState, alivePlayers, addLog, startGame, resolveNight, advanceSpeaker, castVote, phaseDeadline, advanceTimedPhase } from './game/engine.js';

const required = ['MONGO_URI', 'JWT_SECRET', 'GOOGLE_CLIENT_ID'];
for (const key of required) if (!process.env[key]) { console.error(`Missing ${key} in .env`); process.exit(1); }
const app = express();
const server = http.createServer(app);
const clientUrl = process.env.CLIENT_URL || 'http://localhost:4200';
app.use(helmet({ crossOriginEmbedderPolicy: false }));
app.use(cors({ origin: clientUrl, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.get('/api/health', (_req, res) => res.json({ status: 'ok', app: 'Mafia Online API' }));
app.use('/api/auth', authRoutes);
app.use('/api/rooms', roomRoutes);

const io = new Server(server, { cors: { origin: clientUrl, methods: ['GET', 'POST'] }, maxHttpBufferSize: 1e6 });
const games = new Map();
const roomLoads = new Map();
const socketsByUser = new Map();
const timers = new Map();
const emitState = (g) => { for (const [uid, sockets] of socketsByUser) if ([...sockets].some(s => s.data.roomCode === g.code)) [...sockets].filter(s=>s.data.roomCode===g.code).forEach(s=>s.emit('game:state', publicState(g, uid))); };
const roomGame = async (code) => {
  const normalized = String(code || '').toUpperCase();
  if (games.has(normalized)) return games.get(normalized);
  // Simultaneous first joins must share one game and one player map.
  if (!roomLoads.has(normalized)) roomLoads.set(normalized, (async () => {
    const room = await Room.findOne({ code: normalized });
    if (!room) return null;
    const g = createGameState(room, room.host);
    games.set(normalized, g);
    return g;
  })());
  try { return await roomLoads.get(normalized); }
  finally { roomLoads.delete(normalized); }
};
const clearTimer = (code) => { if (timers.has(code)) clearTimeout(timers.get(code).handle); timers.delete(code); };
// One server-owned timer per room, unchanged by media updates or repeated votes.
const syncTimer = (g) => {
  const deadline=phaseDeadline(g);
  const existing=timers.get(g.code);
  if(existing?.deadline===deadline && existing?.phase===g.phase)return;
  clearTimer(g.code);
  if(!deadline)return;
  const phase=g.phase;
  const handle=setTimeout(()=>{
    timers.delete(g.code);
    if(g.phase===phase && phaseDeadline(g)===deadline)advanceTimedPhase(g);
    syncTimer(g);emitState(g);
  },Math.max(0,deadline-Date.now()));
  timers.set(g.code,{handle,deadline,phase});
};
const handleAction = async (socket, action) => {
  if (!action || typeof action.type !== 'string' || !socket.data.roomCode) return;
  const { user, roomCode } = socket.data;
  const g = await roomGame(roomCode);
  if (!g) return socket.emit('game:error', 'الغرفة غير موجودة');
  const p = g.players.get(user.id);
  if(!p) return;
  const host = user.id === g.hostId;
  try {
    if (action.type === 'game:start' && host && g.phase === 'lobby') {
      startGame(g); await Room.updateOne({ code: g.code }, { status: 'playing' });
      syncTimer(g); emitState(g); return;
    }
    if (action.type === 'game:config' && host && g.phase === 'lobby') {
      for (const key of ['mafia', 'doctor', 'detective']) if (Number.isInteger(action.config?.[key])) g.rolesConfig[key] = Math.max(0, Math.min(5, action.config[key]));
    } else if (action.type === 'night:act' && p?.alive && g.phase === 'night') {
      const target = g.players.get(action.targetId);
      if (!target?.alive) throw new Error('اللاعب المختار غير متاح');
      if (p.role === 'mafia' && (target.role === 'mafia' || target.id === p.id)) throw new Error('لا يمكنك اختيار هذا اللاعب');
      if (p.role === 'detective' && target.id === p.id) throw new Error('لا يمكنك التحقيق مع نفسك');
      if (!['mafia', 'doctor', 'detective'].includes(p.role)) throw new Error('ليس لديك إجراء ليلي');
      g.nightActions[p.id] = target.id;
      const special = alivePlayers(g).filter(x => ['mafia', 'doctor', 'detective'].includes(x.role));
      if (special.every(x => g.nightActions[x.id])) { resolveNight(g); syncTimer(g); }
    } else if (action.type === 'host:resolve-night' && host && g.phase === 'night') {
      resolveNight(g); syncTimer(g);
    } else if (action.type === 'speech:next' && host && g.phase === 'discussion') {
      clearTimer(g.code); g.speakerIndex += 1; advanceSpeaker(g); syncTimer(g);
    } else if (action.type === 'vote:cast') {
      castVote(g,p.id,action.targetId,action.voteRound);
    } else if (action.type === 'game:reset' && host && ['finished', 'lobby'].includes(g.phase)) {
      clearTimer(g.code); g.phase = 'lobby'; g.day = 0; g.winner = null; g.votes = {}; g.nightActions = {}; g.voteEndsAt=null;g.voteRound=0;g.announcement=null; g.defensePlayerId = null; g.defenseEndsAt=null; g.speakerEndsAt=null; g.speakerId=null; g.log = [];
      for(const [id,player] of g.players)if(!player.online)g.players.delete(id);
      for (const player of g.players.values()) { player.role = null; player.alive = true; player.revealed = false; player.results = []; }
      await Room.updateOne({ code: g.code }, { status: 'waiting' });
    } else if (action.type === 'chat:message' && p?.alive && ['discussion', 'defense'].includes(g.phase)) {
      const allowed = g.phase === 'discussion' ? g.speakerId === p.id : g.defensePlayerId === p.id;
      if (!allowed) throw new Error('ليس دورك للكلام');
      const message = String(action.message || '').trim().slice(0, 300);
      if (message) io.to(g.code).emit('chat:message', { userId: p.id, name: p.name, message, at: Date.now() });
    }
    syncTimer(g);
    emitState(g);
  } catch (e) { socket.emit('game:error', e.message || 'حدث خطأ'); }
};

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(payload.sub).select('name email avatar');
    if (!user) return next(new Error('UNAUTHORIZED'));
    socket.data.user = { id: user.id, name: user.name, avatar: user.avatar };
    next();
  } catch { next(new Error('UNAUTHORIZED')); }
});

io.on('connection', socket => {
  const user = socket.data.user;
  if (!socketsByUser.has(user.id)) socketsByUser.set(user.id, new Set());
  socketsByUser.get(user.id).add(socket);
  socket.on('room:join', async (payload = {}) => {
    try {
    const code = payload?.code;
    if(socket.data.roomCode && socket.data.roomCode!==String(code||'').toUpperCase()) return socket.emit('game:error','غادر الغرفة الحالية أولاً');
    const g = await roomGame(code);
    if (!g) return socket.emit('game:error', 'الغرفة غير موجودة');
    for(const other of socketsByUser.get(user.id)||[]) if(other!==socket && other.data.roomCode) other.disconnect(true);
    if (!g.players.has(user.id)) {
      if (g.phase !== 'lobby') return socket.emit('game:error', 'اللعبة بدأت بالفعل');
      if (g.players.size >= g.maxPlayers) return socket.emit('game:error', 'الغرفة ممتلئة');
      g.players.set(user.id, { id: user.id, name: user.name, avatar: user.avatar, role: null, alive: true, revealed: false, online: true, results: [] });
      addLog(g, `انضم ${user.name} إلى الغرفة.`);
    } else g.players.get(user.id).online = true;
    if(!g.players.get(g.hostId)?.online)g.hostId=user.id;
    socket.data.roomCode = g.code; socket.join(g.code); socket.join(`user:${user.id}`);
    syncTimer(g);
    socket.emit('game:joined', { code: g.code, hostId: g.hostId, isHost: user.id === g.hostId });
    emitState(g);
    socket.to(g.code).emit('media:peer-joined', { userId: user.id, name: user.name });
    } catch {socket.emit('game:error','تعذر الانضمام. حاول مجددًا.');}
  });
  socket.on('media:state', (payload={}) => {
    const g=games.get(socket.data.roomCode),p=g?.players.get(user.id);
    if(!p)return;
    p.cameraOn=payload?.cameraOn===true;p.micOn=payload?.micOn===true;
    emitState(g);
  });
  socket.on('game:action', action => handleAction(socket, action));
  // WebRTC signaling: offers, answers and ICE candidates are relayed only within the same room.
  for (const event of ['webrtc:ready', 'webrtc:offer', 'webrtc:answer', 'webrtc:ice']) socket.on(event, payload => {
    const target = String(payload?.targetId || '');
    const peers = socketsByUser.get(target);
    if (!peers || !socket.data.roomCode) return;
    for (const peer of peers) if (peer.data.roomCode === socket.data.roomCode) peer.emit(event, { ...payload, fromId: user.id });
  });
  socket.on('disconnect', () => {
    const set = socketsByUser.get(user.id); set?.delete(socket); if (set?.size === 0) socketsByUser.delete(user.id);
    const g = games.get(socket.data.roomCode); if (g) { const player = g.players.get(user.id); if (player) player.online = [...(socketsByUser.get(user.id)||[])].some(s=>s.data.roomCode===g.code);
      if(!player?.online && g.hostId===user.id){const next=[...g.players.values()].find(p=>p.online);if(next){g.hostId=next.id;addLog(g,`أصبح ${next.name} المضيف بعد انقطاع الاتصال.`);}}
      emitState(g); }
  });
});

await mongoose.connect(process.env.MONGO_URI);
console.log('MongoDB connected');
const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, () => console.log(`Mafia Online API running on http://localhost:${PORT}`));
