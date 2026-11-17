import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
  googleId: { type: String, required: true, unique: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 40 },
  email: { type: String, required: true, lowercase: true, trim: true, unique: true },
  avatar: { type: String, default: '' },
  lastSeenAt: { type: Date, default: Date.now }
}, { timestamps: true });

export default mongoose.model('User', userSchema);
