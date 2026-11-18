// Phase lengths (ms): normal speaker 1:15, vote 0:45, defense 1:30.
export const SPEAK_MS = 75000;
export const VOTE_MS = 45000;
export const DEFENSE_MS = 90000;
const ROLE_NAMES = { mafia: 'مافيا', mafia_boss: 'زعيم المافيا', silencer: 'المُسكِت', mayor: 'العمدة', doctor: 'الدكتور', detective: 'المحقق', citizen: 'مواطن' };
const shuffle = (items) => { const a = [...items]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

export function createGameState(room, hostId) {
  return { code: room.code, hostId: String(hostId), maxPlayers: room.maxPlayers, phase: 'lobby', day: 0,
    players: new Map(), rolesConfig: { mafia: 1, doctor: 1, detective: 1, mayor: 0 }, nightActions: {}, votes: {},
    speakerIndex: 0, speakerEndsAt: null, defensePlayerId: null, defenseEndsAt: null,
    voteRound: 0, voteEndsAt: null, announcement: null, announcementSeq: 0, log: [], winner: null, timer: null };
}
export const isMafia = role => ['mafia','mafia_boss','silencer'].includes(role);
export const isSilenced = (g,p) => Boolean(p && p.silencedDay===g.day && !['lobby','finished'].includes(g.phase));
export const voteWeight = p => p?.role==='mayor' && p.revealed ? 3 : 1;
export function revealMayor(g,id) {
 const p=g.players.get(id);
 if(!p?.alive || p.role!=='mayor' || ['lobby','finished'].includes(g.phase))throw new Error('لا يمكنك كشف بطاقة العمدة الآن');
 if(p.revealed)return;
 p.revealed=true;addLog(g,'كشف '+p.name+' بطاقة العمدة. صوته يساوي ثلاثة أصوات.');
}
export const alivePlayers = (g) => [...g.players.values()].filter(p => p.alive);
export const addLog = (g, text) => { g.log.push({ text, at: Date.now(), day: g.day }); g.log = g.log.slice(-40); };
export const roleName = (role) => ROLE_NAMES[role] || 'مواطن';
export function publicState(g, userId) {
  const me = g.players.get(String(userId));
  return { serverTime: Date.now(), code: g.code, phase: g.phase, day: g.day, maxPlayers: g.maxPlayers, winner: g.winner,
    hostId: g.hostId, isHost: String(userId) === g.hostId,
    players: [...g.players.values()].map(p => ({ id: p.id, name: p.name, avatar: p.avatar, alive: p.alive, online: p.online, silenced: isSilenced(g,p), revealed: Boolean(p.revealed), voteWeight: voteWeight(p), cameraOn: Boolean(p.online && p.cameraOn), micOn: Boolean(p.online && p.micOn && !isSilenced(g,p)),
      role: String(userId) === p.id || g.phase === 'finished' || p.revealed || (isMafia(me?.role) && isMafia(p.role)) ? p.role : null })),
    announcement: g.announcement, voteRound: g.voteRound, voteEndsAt: g.voteEndsAt, voteTotal: alivePlayers(g).length, voteCount: Object.keys(g.votes).filter(id=>g.players.get(id)?.alive).length,
    rolesConfig: g.rolesConfig, log: g.log, votes: g.phase === 'vote' ? g.votes : null,
    speakerId: g.phase === 'discussion' ? g.speakerId : null, speakerEndsAt: g.speakerEndsAt,
    defensePlayerId: g.defensePlayerId, defenseEndsAt: g.defenseEndsAt,
    me: me ? { id: me.id, role: me.role, alive: me.alive, silenced: isSilenced(g,me), revealed: Boolean(me.revealed), results: me.results || [],
      canSpeak: me.online && me.alive && !isSilenced(g,me) && (g.phase === 'lobby' || (g.phase === 'discussion' && g.speakerId === me.id) || (g.phase === 'defense' && g.defensePlayerId === me.id)),
      nightAction: g.nightActions[me.id] || null, lastProtectedId: me.role === 'doctor' ? (me.lastProtectedId || null) : null, myVote: g.votes[me.id] || null } : null };
}
export function checkWinner(g) {
  const mafia = alivePlayers(g).filter(p => isMafia(p.role)).length;
  const citizens = alivePlayers(g).length - mafia;
  if (!mafia) g.winner = 'citizens'; else if (mafia >= citizens) g.winner = 'mafia';
  if (g.winner) { g.phase = 'finished'; addLog(g, g.winner === 'mafia' ? 'فازت المافيا!' : 'فاز المواطنون!'); }
  return Boolean(g.winner);
}
export function startGame(g) {
  const players = [...g.players.values()];
  if(players.some(p=>!p.online)) throw new Error('انتظر اتصال اللاعبين أو أعد ضبط الردهة لإزالة الغائبين');
  if (players.length < 4) throw new Error('تحتاج اللعبة إلى 4 لاعبين على الأقل');
  const c = g.rolesConfig;
  if(['mafia','doctor','detective','mayor'].some(key=>!Number.isInteger(c[key] ?? 0) || (c[key] ?? 0)<0) || (c.mayor || 0)>1)throw new Error('أعداد الأدوار غير صالحة');
  if (c.mafia < 1 || c.mafia * 2 >= players.length || c.mafia + c.doctor + c.detective + (c.mayor || 0) > players.length) throw new Error('توزيع الأدوار غير مناسب لعدد اللاعبين');
  const roles = shuffle([...(c.mafia===1?['mafia']:['mafia_boss','silencer',...Array(c.mafia-2).fill('mafia')]), ...Array(c.doctor).fill('doctor'), ...Array(c.detective).fill('detective'), ...Array(c.mayor || 0).fill('mayor'), ...Array(players.length - c.mafia - c.doctor - c.detective - (c.mayor || 0)).fill('citizen')]);
  players.forEach((p, i) => { p.role = roles[i]; p.alive = true; p.revealed = false; p.silencedDay = null; p.results = []; });
  g.announcement=null; g.voteRound=0; g.voteEndsAt=null; g.defensePlayerId=null; g.defenseEndsAt=null; for (const pl of g.players.values()) pl.lastProtectedId = null; g.phase = 'night'; g.day = 1; g.winner = null; g.votes = {}; g.nightActions = {}; addLog(g, 'بدأت اللعبة. حان الليل.');
}
export function resolveNight(g) {
  const mafiaVotes = {};
  for (const [id, target] of Object.entries(g.nightActions)) if (g.players.get(id)?.alive && ['mafia','mafia_boss'].includes(g.players.get(id)?.role) && g.players.get(target)?.alive) mafiaVotes[target] = (mafiaVotes[target] || 0) + 1;
  const high = Math.max(0, ...Object.values(mafiaVotes));
  const targetIds = Object.keys(mafiaVotes).filter(id => mafiaVotes[id] === high);
  const victimId = targetIds.length ? targetIds[Math.floor(Math.random() * targetIds.length)] : null;
  for(const [id,target] of Object.entries(g.nightActions)) {
 if(g.players.get(id)?.alive && g.players.get(id)?.role==='silencer' && g.players.get(target)?.alive){g.players.get(target).silencedDay=g.day;addLog(g,'تم إسكات '+g.players.get(target).name+' حتى نهاية الجولة. يمكنه التصويت.');}
 }
 const protectedIds = Object.entries(g.nightActions).filter(([id]) => g.players.get(id)?.alive && g.players.get(id)?.role === 'doctor').map(([, target]) => target);
  for (const [id, target] of Object.entries(g.nightActions)) {
    const player = g.players.get(id), chosen = g.players.get(target);
    if (player?.alive && player.role === 'detective' && chosen) player.results.push({ day: g.day, name: chosen.name, isMafia: isMafia(chosen.role) });
  }
  if (victimId && !protectedIds.includes(victimId)) {
    const victim = g.players.get(victimId); victim.alive = false; victim.revealed = true;
    announce(g, 'assassinated', `تم اغتيال ${victim.name}`, `بطاقته: ${roleName(victim.role)}`, victim);
  } else if(victimId) {
    announce(g, 'protected', 'محاولة اغتيال فاشلة', 'نجحت حماية الطبيب. الجميع بقي على قيد الحياة.');
  } else {
    announce(g, 'peaceful', 'انتهى الليل دون اغتيال', 'لم تُنفّذ المافيا عملية اغتيال هذه الليلة.');
  }
  for (const pl of g.players.values()) if (pl.role === 'doctor') pl.lastProtectedId = pl.alive ? (g.nightActions[pl.id] || null) : null;
  g.nightActions = {};
  if (!checkWinner(g)) { g.phase = 'discussion'; g.speakerIndex = 0; advanceSpeaker(g); }
}
export function advanceSpeaker(g) {
  const speakers = alivePlayers(g);
  while (g.speakerIndex < speakers.length && !speakers[g.speakerIndex].online) g.speakerIndex += 1;
  if (g.speakerIndex >= speakers.length) { g.speakerId = null; g.speakerEndsAt = null; beginVote(g); return; }
  g.speakerId = speakers[g.speakerIndex].id;
  g.speakerEndsAt = Date.now() + SPEAK_MS;
}
// Each ballot is identified by a round number, so delayed clicks cannot vote in a later round.
export function beginVote(g) {
  g.phase = 'vote'; g.voteRound += 1; g.votes = {}; g.voteEndsAt = Date.now() + VOTE_MS;
  g.defenseEndsAt = null;
  addLog(g, g.defensePlayerId ? 'انتهى الدفاع. صوّتوا مجددًا على جميع اللاعبين.' : 'بدأ التصويت.');
}
export function castVote(g, voterId, targetId, round) {
  if(g.phase !== 'vote' || round !== g.voteRound) throw new Error('انتهت جولة التصويت هذه.');
  if(Date.now() >= g.voteEndsAt) throw new Error('انتهى وقت التصويت.');
  if(!g.players.get(voterId)?.alive) throw new Error('المشاهد لا يستطيع التصويت.');
  if(targetId !== 'skip' && (!g.players.get(targetId)?.alive || targetId===voterId)) throw new Error('التصويت غير صالح.');
  g.votes[voterId] = targetId;
  if(alivePlayers(g).every(p=>Object.hasOwn(g.votes,p.id))) resolveVote(g);
}
export function resolveVote(g) {
  if(g.phase !== 'vote') return;
  const counts = {};
  for(const [voter,target] of Object.entries(g.votes))
    if(g.players.get(voter)?.alive && g.players.get(target)?.alive) counts[target]=(counts[target]||0)+voteWeight(g.players.get(voter));
  const max=Math.max(0,...Object.values(counts));
  const top=Object.keys(counts).filter(id=>counts[id]===max);
  g.voteEndsAt=null;
  if(!max || top.length!==1) {
    announce(g,'tie',max?'تعادل في التصويت':'لا يوجد مرشح للإخراج','لم يخرج أحد. ننتقل إلى الليل.');
    finishDay(g); return;
  }
  const target=g.players.get(top[0]);
  if(g.defensePlayerId===target.id) {
    target.alive=false;target.revealed=true;
    announce(g,'eliminated',`تم إخراج ${target.name}`,`تصدّر التصويت بعد دفاعه. بطاقته: ${roleName(target.role)}`,target);
    g.defenseEndsAt=null;
    if(!checkWinner(g))finishDay(g);
  } else {
    g.phase='defense';g.defensePlayerId=target.id;g.defenseEndsAt=Date.now()+DEFENSE_MS;
    addLog(g,`${target.name} لديه دقيقة ونصف للدفاع، ثم يصوّت الجميع مجددًا.`);
  }
}
export function announce(g, kind, title, message, player=null) {
  g.announcement={id:++g.announcementSeq,day:g.day,kind,title,message,playerId:player?.id||null,role:player?.role||null};
  addLog(g,`${title}. ${message}`);
}
export function phaseDeadline(g) {
  return g.phase==='discussion'?g.speakerEndsAt:g.phase==='defense'?g.defenseEndsAt:g.phase==='vote'?g.voteEndsAt:null;
}
export function advanceTimedPhase(g, now=Date.now()) {
  const end=phaseDeadline(g);if(!end || now<end)return false;
  if(g.phase==='discussion'){g.speakerIndex++;advanceSpeaker(g);}
  else if(g.phase==='defense')beginVote(g);
  else if(g.phase==='vote')resolveVote(g);
  return true;
}
export function finishDay(g) {
  g.speakerId=null;g.speakerEndsAt=null;g.voteEndsAt=null;
  g.day++;g.phase='night';g.nightActions={};g.votes={};g.defensePlayerId=null;g.defenseEndsAt=null;
  addLog(g,`بدأ الليل ${g.day}.`);
}
