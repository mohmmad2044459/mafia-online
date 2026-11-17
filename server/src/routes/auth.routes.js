import { Router } from 'express';
import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

router.post('/google', async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) return res.status(400).json({ message: 'بيانات Google غير موجودة' });
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: process.env.GOOGLE_CLIENT_ID });
    const p = ticket.getPayload();
    if (!p?.sub || !p.email || !p.email_verified) return res.status(401).json({ message: 'تعذر التحقق من حساب Google' });
    const user = await User.findOneAndUpdate(
      { googleId: p.sub },
      { $set: { name: p.name || p.email.split('@')[0], email: p.email, avatar: p.picture || '', lastSeenAt: new Date() }, $setOnInsert: { googleId: p.sub } },
      { new: true, upsert: true, runValidators: true }
    );
    const token = jwt.sign({ sub: user.id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, avatar: user.avatar } });
  } catch (error) {
    console.error('Google auth error:', error.message);
    res.status(401).json({ message: 'فشل تسجيل الدخول باستخدام Google' });
  }
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: { id: req.user.id, name: req.user.name, email: req.user.email, avatar: req.user.avatar } });
});
export default router;
