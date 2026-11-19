import test from 'node:test';
import assert from 'node:assert/strict';
import {createGameState,startGame,resolveNight,advanceSpeaker,resolveVote,publicState,beginVote,castVote,phaseDeadline,advanceTimedPhase} from './engine.js';

function game(){const g=createGameState({code:'ABC123',maxPlayers:8},'0');for(let i=0;i<5;i++)g.players.set(String(i),{id:String(i),name:'Player '+i,alive:true,online:true,role:i===0?'mafia':'citizen',results:[]});return g;}
function voteFor(g,target){const round=g.voteRound;for(const p of [...g.players.values()].filter(p=>p.alive))castVote(g,p.id,p.id===target?'skip':target,round);}
function finishDefense(g){assert.equal(g.phase,'defense');assert.equal(advanceTimedPhase(g,g.defenseEndsAt-1),false);assert.equal(advanceTimedPhase(g,g.defenseEndsAt),true);assert.equal(g.phase,'vote');}

test('start assigns configured roles and keeps them private',()=>{const g=game();startGame(g);assert.equal(g.phase,'night');assert.equal([...g.players.values()].filter(p=>p.role==='mafia').length,1);assert.equal(publicState(g,'0').players.filter(p=>p.role).length,1);});
test('discussion allows 45 seconds per online living player then starts timed ballot',()=>{const g=game();g.players.get('1').online=false;resolveNight(g);assert.equal(g.speakerId,'0');assert.ok(Math.abs(g.speakerEndsAt-Date.now()-45000)<100);assert.equal(publicState(g,'0').me.canSpeak,true);assert.equal(publicState(g,'2').me.canSpeak,false);advanceTimedPhase(g,g.speakerEndsAt);assert.equal(g.speakerId,'2');g.speakerIndex=5;advanceSpeaker(g);assert.equal(g.phase,'vote');assert.ok(g.voteEndsAt>Date.now());});
test('all ballots automatically open defense, same nominee after the 60-second defense is eliminated',()=>{const g=game();beginVote(g);voteFor(g,'2');assert.equal(g.phase,'defense');assert.equal(g.defensePlayerId,'2');assert.ok(Math.abs(g.defenseEndsAt-Date.now()-60000)<100);assert.equal(publicState(g,'2').me.canSpeak,true);finishDefense(g);voteFor(g,'2');assert.equal(g.players.get('2').alive,false);assert.equal(g.players.get('2').revealed,true);assert.equal(g.phase,'night');assert.equal(g.announcement.kind,'eliminated');assert.equal(publicState(g,'3').players.find(p=>p.id==='2').role,'citizen');});
test('different nominee receives fresh defense; earlier defense is not enough to eject later',()=>{const g=game();beginVote(g);voteFor(g,'2');finishDefense(g);voteFor(g,'3');assert.equal(g.defensePlayerId,'3');assert.equal(g.players.get('2').alive,true);finishDefense(g);voteFor(g,'2');assert.equal(g.phase,'defense');assert.equal(g.players.get('2').alive,true);finishDefense(g);voteFor(g,'2');assert.equal(g.players.get('2').alive,false);assert.equal(g.players.get('3').alive,true);});
test('timeout resolves votes even when host and one voter disconnected',()=>{const g=game();beginVote(g);g.players.get('0').online=false;castVote(g,'1','2',g.voteRound);castVote(g,'3','2',g.voteRound);assert.equal(g.phase,'vote');advanceTimedPhase(g,phaseDeadline(g));assert.equal(g.phase,'defense');assert.equal(g.defensePlayerId,'2');});
test('tie or all abstaining ends day with no execution',()=>{for(const votes of [{'0':'2','1':'3'},{'0':'skip'}]){const g=game();beginVote(g);g.votes=votes;resolveVote(g);assert.equal(g.phase,'night');assert.equal([...g.players.values()].filter(p=>p.alive).length,5);assert.equal(g.defenseEndsAt,null);assert.equal(g.announcement.kind,'tie');}});
test('stale votes cannot affect a newer round; invalid, self, dead and late votes rejected',()=>{const g=game();beginVote(g);const old=g.voteRound;voteFor(g,'2');finishDefense(g);assert.throws(()=>castVote(g,'1','2',old));assert.throws(()=>castVote(g,'1','1',g.voteRound));assert.throws(()=>castVote(g,'1','missing',g.voteRound));g.players.get('4').alive=false;assert.throws(()=>castVote(g,'4','2',g.voteRound));assert.throws(()=>castVote(g,'1','4',g.voteRound));g.voteEndsAt=Date.now()-1;assert.throws(()=>castVote(g,'1','2',g.voteRound));assert.deepEqual(g.votes,{});});
test('changing vote replaces a ballot rather than adding another voter',()=>{const g=game();beginVote(g);castVote(g,'1','2',g.voteRound);castVote(g,'1','3',g.voteRound);assert.equal(publicState(g,'1').voteCount,1);assert.equal(g.votes['1'],'3');});
test('successful protection is announced identically to all without disclosing protected player or doctor',()=>{const g=game();g.players.get('1').role='doctor';g.nightActions={'0':'2','1':'2'};resolveNight(g);assert.equal(g.players.get('2').alive,true);assert.equal(g.announcement.kind,'protected');assert.equal(g.announcement.playerId,null);assert.equal(g.announcement.role,null);assert.deepEqual(publicState(g,'0').announcement,publicState(g,'4').announcement);});
test('assassination names the victim and reveals the card to all, no target is a distinct result',()=>{const g=game();g.nightActions={'0':'2'};resolveNight(g);assert.equal(g.announcement.kind,'assassinated');assert.equal(g.announcement.playerId,'2');assert.equal(g.players.get('2').alive,false);const peaceful=game();resolveNight(peaceful);assert.equal(peaceful.announcement.kind,'peaceful');});
test('last mafia elimination ends game after repeated vote',()=>{const g=game();beginVote(g);voteFor(g,'0');finishDefense(g);voteFor(g,'0');assert.equal(g.phase,'finished');assert.equal(g.winner,'citizens');assert.equal(phaseDeadline(g),null);});
test('camera state is shared; offline player cannot transmit or report camera on',()=>{const g=game();g.players.get('0').cameraOn=true;assert.equal(publicState(g,'1').players[0].cameraOn,true);g.phase='discussion';g.speakerId='0';g.players.get('0').online=false;assert.equal(publicState(g,'0').me.canSpeak,false);assert.equal(publicState(g,'1').players[0].cameraOn,false);});
test('doctor cannot protect same player (or self) two nights in a row, but can again after a gap',()=>{
  const g=game();g.players.get('1').role='doctor';g.players.get('1').lastProtectedId=null;
  g.nightActions={'1':'2'};resolveNight(g);assert.equal(g.players.get('1').lastProtectedId,'2');assert.equal(publicState(g,'1').me.lastProtectedId,'2');assert.equal(publicState(g,'2').me.lastProtectedId,null);
  g.nightActions={'1':'1'};resolveNight(g);assert.equal(g.players.get('1').lastProtectedId,'1');
  g.nightActions={};resolveNight(g);assert.equal(g.players.get('1').lastProtectedId,null);
});

test('mayor reveal is public, idempotent, and weights an existing ballot',async()=>{
 const {revealMayor}=await import('./engine.js');const g=game();g.players.get('1').role='mayor';beginVote(g);castVote(g,'1','2',g.voteRound);castVote(g,'0','3',g.voteRound);castVote(g,'4','3',g.voteRound);
 assert.equal(publicState(g,'0').players.find(p=>p.id==='1').role,null);
 revealMayor(g,'1');revealMayor(g,'1');assert.equal(g.log.filter(x=>x.text.includes('بطاقة العمدة')).length,1);
 assert.equal(publicState(g,'0').players.find(p=>p.id==='1').role,'mayor');assert.equal(publicState(g,'0').players.find(p=>p.id==='1').voteWeight,3);
 resolveVote(g);assert.equal(g.defensePlayerId,'2');assert.throws(()=>revealMayor(g,'0'));
 g.players.get('1').alive=false;assert.throws(()=>revealMayor(g,'1'));
});
test('silencer mutes either team through defense, allows voting, expires next night',async()=>{
 const {finishDay,isSilenced}=await import('./engine.js');for(const target of ['0','2']){const g=game();g.day=1;g.players.get('1').role='silencer';g.nightActions={'1':target};resolveNight(g);
 assert.equal(isSilenced(g,g.players.get(target)),true);g.phase='defense';g.defensePlayerId=target;assert.equal(publicState(g,target).me.canSpeak,false);
 beginVote(g);castVote(g,target,'4',g.voteRound);assert.equal(g.votes[target],'4');finishDay(g);assert.equal(isSilenced(g,g.players.get(target)),false);}
});
test('boss kills, silencer does not kill, detective recognizes both mafia roles',()=>{
 const g=game();g.players.set('5',{id:'5',name:'لاعب',alive:true,online:true,role:'citizen'});g.players.get('0').role='mafia_boss';g.players.get('1').role='silencer';g.players.get('4').role='detective';g.nightActions={'0':'2','1':'3','4':'1'};resolveNight(g);
 assert.equal(g.players.get('2').alive,false);assert.equal(g.players.get('3').alive,true);assert.equal(g.players.get('4').results[0].isMafia,true);
 assert.equal(publicState(g,'0').players.find(p=>p.id==='1').role,'silencer');assert.equal(publicState(g,'3').players.find(p=>p.id==='1').role,null);
});
test('multiple mafia allocation includes boss and silencer within configured total',()=>{
 const g=game();for(let i=5;i<8;i++)g.players.set(String(i),{id:String(i),alive:true,online:true});g.rolesConfig={mafia:2,doctor:1,detective:1,mayor:1};startGame(g);
 const roles=[...g.players.values()].map(p=>p.role);assert.equal(roles.filter(r=>r==='mafia_boss').length,1);assert.equal(roles.filter(r=>r==='silencer').length,1);assert.equal(roles.filter(r=>r==='mayor').length,1);
});
test('silencer counts toward mafia victory and does not leak to civilians',async()=>{
 const {checkWinner}=await import('./engine.js');const g=game();g.players.get('0').role='silencer';assert.equal(checkWinner(g),false);g.players.get('1').alive=false;g.players.get('2').alive=false;g.players.get('3').alive=false;assert.equal(checkWinner(g),true);assert.equal(g.winner,'mafia');
});


test('mayor can reveal in every active phase but not outside a running game',async()=>{
 const {revealMayor}=await import('./engine.js');for(const phase of ['night','discussion','vote','defense']){const g=game();g.phase=phase;g.players.get('1').role='mayor';revealMayor(g,'1');assert.equal(g.players.get('1').revealed,true);}
 for(const phase of ['lobby','finished']){const g=game();g.phase=phase;g.players.get('1').role='mayor';assert.throws(()=>revealMayor(g,'1'));}
});
test('starting a new game clears silence and prior reveal',()=>{const g=game();for(const p of g.players.values()){p.silencedDay=1;p.revealed=true;}startGame(g);assert.ok([...g.players.values()].every(p=>p.silencedDay===null && !p.revealed));});
