import jwt from 'jsonwebtoken';
import User from '../models/User.js';

export async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) return res.status(401).json({ message: 'سجّل دخولك أولاً' });
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(payload.sub).select('-__v');
    if (!user) return res.status(401).json({ message: 'الحساب غير موجود' });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ message: 'انتهت جلسة الدخول، سجّل دخولك مرة ثانية' });
  }
}
