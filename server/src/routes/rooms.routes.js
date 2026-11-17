import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import Room from '../models/Room.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);
const makeCode = () => randomBytes(3).toString('hex').toUpperCase();

router.post('/', async (req, res) => {
  try {
    const maxPlayers = Math.min(20, Math.max(4, Number(req.body.maxPlayers) || 12));
    let code = makeCode();
    while (await Room.exists({ code })) code = makeCode();
    const room = await Room.create({ code, host: req.user._id, maxPlayers, isPrivate: req.body.isPrivate !== false });
    res.status(201).json({ room: { code: room.code, maxPlayers: room.maxPlayers, status: room.status, hostId: String(room.host) } });
  } catch (e) { res.status(500).json({ message: 'تعذر إنشاء الغرفة' }); }
});

router.get('/public', async (_req, res) => {
  const rooms = await Room.find({ status: 'waiting', isPrivate: false }).populate('host', 'name').sort({ createdAt: -1 }).limit(30).lean();
  res.json({ rooms: rooms.map(r => ({ code: r.code, maxPlayers: r.maxPlayers, hostName: r.host?.name || 'لاعب' })) });
});

router.post('/:code/join', async (req, res) => {
  const room = await Room.findOne({ code: req.params.code.toUpperCase() });
  if (!room) return res.status(404).json({ message: 'الغرفة غير موجودة' });
  // Existing players may reconnect after the game starts; the socket layer rejects new late joiners.
  res.json({ room: { code: room.code, maxPlayers: room.maxPlayers, status: room.status, hostId: String(room.host) } });
});
export default router;
