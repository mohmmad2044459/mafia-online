import mongoose from 'mongoose';

const roomSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, index: true },
  host: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  status: { type: String, enum: ['waiting', 'playing', 'finished'], default: 'waiting' },
  maxPlayers: { type: Number, default: 12, min: 4, max: 20 },
  isPrivate: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
  lastActivityAt: { type: Date, default: Date.now }
});

export default mongoose.model('Room', roomSchema);
