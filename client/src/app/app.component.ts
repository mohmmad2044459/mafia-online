import { CommonModule } from '@angular/common';
import { HttpClient, HttpClientModule } from '@angular/common/http';
import { AfterViewChecked, Component, ElementRef, NgZone, OnDestroy, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { io, Socket } from 'socket.io-client';
import { retry, throwError, timeout, timer } from 'rxjs';
import { environment } from '../environments/environment';

declare global { interface Window { google?: any; } }
interface User { id: string; name: string; email: string; avatar: string; }
interface Player { silenced:boolean; revealed:boolean; voteWeight:number; cameraOn:boolean; micOn:boolean; id: string; name: string; avatar: string; alive: boolean; online: boolean; role: string | null; }
interface SignalPayload { restart?: boolean; sessionId?:string; fromId: string; description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit; }
interface GameState { announcement:{id:number;day:number;kind:string;title:string;message:string;role:string|null}|null; voteRound:number; voteEndsAt:number|null; voteCount:number; voteTotal:number; serverTime: number; code: string; phase: string; day: number; maxPlayers: number; winner: string | null; hostId: string; isHost: boolean; players: Player[]; rolesConfig: {mafia:number;doctor:number;detective:number;mayor:number}; log: {text:string;at:number;day:number}[]; votes: Record<string,string>|null; speakerId: string|null; speakerEndsAt: number|null; defensePlayerId: string|null; defenseEndsAt: number|null; me: {silenced:boolean;revealed:boolean;lastProtectedId:string|null;id:string;role:string|null;alive:boolean;results:{day:number;name:string;isMafia:boolean}[];canSpeak:boolean;nightAction:string|null;myVote:string|null}|null; }

@Component({ selector: 'app-root', standalone: true, imports: [CommonModule, FormsModule, HttpClientModule], templateUrl: './app.component.html' })
export class AppComponent implements OnDestroy, AfterViewChecked {
  @ViewChild('localVideo') localVideo?: ElementRef<HTMLVideoElement>;
  readonly api = environment.apiUrl;
  readonly socketUrl = environment.socketUrl;
  user: User | null = null; token = localStorage.getItem('mafia_token') || '';
  roomCode = ''; newRoomMax = 12; isPrivate = true; state: GameState | null = null;
  socket: Socket | null = null; busy = false; error = ''; notice = '';
  localStream: MediaStream | null = null; cameraOn = false; micOn = false;
  remoteVideos: {id:string;name:string;stream:MediaStream}[] = [];
  private peers = new Map<string, RTCPeerConnection>(); chat: {name:string;message:string;at:number}[] = []; chatText = '';
  secondsLeft = 0; connected = false; mediaBusy = false; private clockOffset = 0; private mediaSession = 0; private pendingIce = new Map<string, RTCIceCandidateInit[]>(); private clock?: ReturnType<typeof setInterval>;
  loggingIn=false; restoring=false; private googleReady=false;
  constructor(private http: HttpClient, private zone:NgZone) {
    if (this.token) { this.restoring=true; this.loadMe(); }
    else this.http.get(`${this.api}/health`).subscribe({error:()=>{}}); // نصحّي السيرفر (Render) من أول ما تنفتح الصفحة
  }
  leaveConfirm = false;
  roomTab:'game'|'players'|'more'='game';
  dismissedAnnouncement=0;
  mediaStatus:Record<string,string>={};
  private sessions=new Map<string,string>();
  private retries=new Map<string,number>();
  private retryTimers=new Map<string,ReturnType<typeof setTimeout>>();
  get visibleAnnouncement(){const a=this.state?.announcement;return a && a.id!==this.dismissedAnnouncement?a:null;}
  castVote(targetId:string):void{this.action('vote:cast',{targetId,voteRound:this.state?.voteRound});}
  // مين صوّت على هاللاعب (أو على 'skip' يعني امتنع)
  votersFor(target:string):Player[]{const votes=this.state?.votes||{};return (this.state?.players||[]).filter(p=>votes[p.id]===target);}
  // أسماء المصوتين نصًا، والعمدة المكشوف بيطلع جنب اسمه (×3)
  votersText(target:string):string{return this.votersFor(target).map(p=>p.voteWeight>1?`${p.name} (×${p.voteWeight})`:p.name).join('، ');}
  votesLabel(n:number):string{return n===0?'0 أصوات':n===1?'صوت واحد':n===2?'صوتان':`${n} أصوات`;}
  get speechTotal():number{return this.state?.phase==='defense'?60:45;} // مدة المتحدث/الدفاع بالثواني (لشريط الوقت)
  publishMedia():void{this.socket?.emit('media:state',{cameraOn:this.cameraOn,micOn:this.micOn});}
  async playMedia():Promise<void>{
    const videos=document.querySelectorAll<HTMLMediaElement>('video,audio');
    const results=await Promise.allSettled(Array.from(videos).map(v=>v.play()));
    this.notice=results.some(r=>r.status==='rejected')?'تعذر تشغيل بعض الوسائط. جرّب إعادة الاتصال.':'تم تشغيل الصوت والفيديو المتاح.';
  }
  readonly phases = [{id:'lobby',label:'التجهيز'},{id:'night',label:'الليل'},{id:'discussion',label:'النقاش'},{id:'vote',label:'التصويت'},{id:'defense',label:'الدفاع'},{id:'finished',label:'النتيجة'}];
  trackPlayer(_index:number, player:Player):string { return player.id; }
  remoteStream(id:string):MediaStream|null { return id===this.user?.id?null:this.remoteVideos.find(v=>v.id===id)?.stream||null; }
  roleLabel(role:string|null|undefined):string { return ({mafia:'المافيا',mafia_boss:'زعيم المافيا',silencer:'المُسكِت',mayor:'العمدة',doctor:'الطبيب',detective:'المحقق',citizen:'المواطن'} as Record<string,string>)[role||'']||''; }
  get roleDescription():string { return ({mayor:'اكشف بطاقتك للجميع في أي مرحلة لتصبح قوة صوتك ثلاثة أصوات حتى نهاية اللعبة.',silencer:'اختر أي لاعب لإسكات ميكروفونه حتى نهاية الجولة؛ يبقى قادرًا على التصويت.',mafia_boss:'اختر ضحية للاغتيال ليلًا وتعاون مع المافيا.',mafia:'اختر ضحية في الليل وحافظ على هويتك سرًا خلال النقاش.',doctor:'احمِ لاعبًا كل ليلة. يمكنك اختيار نفسك.',detective:'تحقق من هوية لاعب كل ليلة؛ النتيجة تظهر لك وحدك.',citizen:'راقب النقاش وصوّت لاكتشاف المافيا. ليس لديك إجراء ليلي.'} as Record<string,string>)[this.state?.me?.role||'']||''; }
  get nightInstruction():string { return !this.state?.me?.alive?'تابع بصمت حتى تنتهي إجراءات الليل.':this.roleDescription; }
  get speakingOrder():Player[] { return this.state?.players.filter(p=>p.alive)||[]; }
  get citizenCount():number { const s=this.state;return s?Math.max(0,s.players.length-s.rolesConfig.mafia-s.rolesConfig.doctor-s.rolesConfig.detective-s.rolesConfig.mayor):0; }
  get configIssue():string { const s=this.state;if(!s)return '';const c=s.rolesConfig;if(s.players.length<4)return 'تحتاج اللعبة أربعة لاعبين على الأقل.';if(s.players.some(p=>!p.online))return 'يوجد لاعب غير متصل. انتظره أو أزله من إدارة الغرفة.';if(c.mafia<1||c.mafia*2>=s.players.length||c.mafia+c.doctor+c.detective+c.mayor>s.players.length)return 'عدّل توزيع الأدوار من إدارة الغرفة ليناسب عدد اللاعبين.';return ''; }
  get phaseName(): string { return ({lobby:'الردهة',night:'الليل',discussion:'النقاش',vote:'التصويت',defense:'الدفاع', 'final-vote':'التصويت النهائي',finished:'انتهت اللعبة'} as Record<string,string>)[this.state?.phase || ''] || ''; }
  get myName(): string { return this.user?.name || ''; }
  get currentSpeaker(): Player | undefined { return this.state?.players.find(p => p.id === this.state?.speakerId); }
  get defensePlayer(): Player | undefined { return this.state?.players.find(p => p.id === this.state?.defensePlayerId); }
  get voteCounts(): Record<string,number> { const result:Record<string,number>={}; Object.entries(this.state?.votes || {}).forEach(([voter,id]) => result[id]=(result[id]||0)+(this.state?.players.find(p=>p.id===voter)?.voteWeight||1)); return result; }
  private loadMe(): void { this.http.get<{user:User}>(`${this.api}/auth/me`, {headers:this.headers}).subscribe({next:r=>{this.restoring=false;this.user=r.user;const saved=localStorage.getItem('mafia_room_'+r.user.id);if(saved){this.roomCode=saved;this.busy=true;this.connectRoom();}},error:e=>{this.restoring=false;if(e.status===401)this.logout();else this.error='تعذر استعادة الجلسة. أعد المحاولة عند عودة الاتصال.';}}); }
  get headers(): {Authorization:string} { return {Authorization:`Bearer ${this.token}`}; }
  // ===== تسجيل الدخول بـ Google =====
  // زر Google الرسمي بنرسمه جوّا الـ div اللي اسمه googleBtn (موجود بملف الـ HTML)
  @ViewChild('googleBtn') set googleBtn(ref: ElementRef<HTMLElement> | undefined) {
    if (ref) this.setupGoogle(ref.nativeElement);
  }
  private setupGoogle(box: HTMLElement, tries = 0): void {
    const gsi = window.google?.accounts?.id;
    if (!gsi) { // سكربت Google لسا ما خلص تحميل: نعيد المحاولة كل 0.2 ثانية
      if (tries < 50) setTimeout(() => this.setupGoogle(box, tries + 1), 200);
      else this.error = 'تعذر تحميل خدمة Google. تأكد من الإنترنت وحدّث الصفحة.';
      return;
    }
    if (!this.googleReady) { // التجهيز بيصير مرة وحدة بس
      gsi.initialize({ client_id: environment.googleClientId, callback: (r: any) => this.zone.run(() => this.onGoogleCredential(r.credential)) });
      this.googleReady = true;
    }
    box.innerHTML = '';
    gsi.renderButton(box, { theme: 'filled_black', size: 'large', text: 'continue_with', shape: 'rectangular', locale: 'ar', width: 280 });
  }
  // Google رجّع لنا "credential" => منرسله للسيرفر ليتأكد منه ويعطينا token
  private onGoogleCredential(credential: string): void {
    this.loggingIn = true; this.error = ''; this.notice = '';
    // السيرفر المجاني بينام، فأول طلب ممكن ياخد وقت: منفهّم المستخدم إنه لازم يستنى
    const wakeNote = setTimeout(() => { if (this.loggingIn) this.notice = 'السيرفر عم يصحى من النوم، ممكن ياخد لحد دقيقة. لا تسكّر الصفحة.'; }, 4000);
    this.http.post<any>(`${this.api}/auth/google`, { credential }).pipe(
      timeout(90000),
      // لو السيرفر لسا بيصحى (خطأ 502/503/504 أو ما في اتصال) منعيد المحاولة تلقائيًا لحد 3 مرات
      retry({ count: 3, delay: (e: any) => [0, 502, 503, 504].includes(e?.status) ? timer(3000) : throwError(() => e) })
    ).subscribe({
      next: r => { clearTimeout(wakeNote); this.loggingIn = false; this.notice = ''; this.token = r.token; localStorage.setItem('mafia_token', this.token); this.user = r.user; this.error = ''; },
      error: e => { clearTimeout(wakeNote); this.loggingIn = false; this.notice = ''; this.error = e?.error?.message || 'السيرفر ما ردّ. جرّب مرة ثانية بعد شوي.'; }
    });
  }
  logout(): void { this.leaveRoom(); this.user=null;this.token='';localStorage.removeItem('mafia_token'); }
  createRoom(): void { this.busy=true;this.error='';this.http.post<any>(`${this.api}/rooms`,{maxPlayers:this.newRoomMax,isPrivate:this.isPrivate},{headers:this.headers}).subscribe({next:r=>{this.roomCode=r.room.code;this.connectRoom();},error:e=>{this.error=e.error?.message||'تعذر إنشاء الغرفة';this.busy=false;}}); }
  joinRoom(): void { const code=this.roomCode.trim().toUpperCase();if(!code)return;this.busy=true;this.error='';this.http.post<any>(`${this.api}/rooms/${code}/join`,{},{headers:this.headers}).subscribe({next:()=>{this.roomCode=code;this.connectRoom();},error:e=>{this.error=e.error?.message||'تعذر دخول الغرفة';this.busy=false;}}); }
  private connectRoom(): void {
    this.socket?.disconnect();this.state=null;
    this.socket=io(this.socketUrl,{auth:{token:this.token},transports:['websocket','polling']});
    this.socket.on('connect',()=>{this.connected=true;this.socket?.emit('room:join',{code:this.roomCode});});
    this.socket.on('disconnect',()=>{this.connected=false;this.closePeers();this.syncMediaPermissions();});
    this.socket.on('connect_error',()=>{this.error='تعذر الاتصال بالسيرفر. حاول مجددًا عند عودة الاتصال.';this.busy=false;});
    this.socket.on('game:joined',()=>{this.busy=false;this.error='';if(this.user)localStorage.setItem('mafia_room_'+this.user.id,this.roomCode);this.publishMedia();});
    this.socket.on('game:state',(s:GameState)=>{if(this.state?.phase!==s.phase || this.state?.day!==s.day)this.roomTab='game';this.state=s;this.clockOffset=s.serverTime-Date.now();this.updateClock();this.ensurePeerConnections();this.syncMediaPermissions();});
    this.socket.on('game:error',(m:string)=>{this.error=m;this.busy=false;});
    this.socket.on('chat:message',(m:any)=>{this.chat=[...this.chat.slice(-39),m];});
    this.socket.on('webrtc:ready',(p:SignalPayload)=>{
      if(this.user && this.user.id<p.fromId){
        if(p.restart)this.dropPeer(p.fromId);
        if(!this.peers.has(p.fromId))void this.makeOffer(p.fromId);
      }
    });
    this.socket.on('webrtc:offer',(p:SignalPayload)=>this.receiveOffer(p));this.socket.on('webrtc:answer',(p:SignalPayload)=>this.receiveAnswer(p));this.socket.on('webrtc:ice',(p:SignalPayload)=>this.receiveIce(p));
  }
  action(type:string, extra:Record<string,unknown>={}): void { if(!this.connected){this.error='الاتصال مقطوع، انتظر إعادة الاتصال.';return;}this.socket?.emit('game:action',{type,...extra}); }
  updateConfig(key:'mafia'|'doctor'|'detective'|'mayor',value:string):void { if(!this.state)return;this.state.rolesConfig[key]=Math.max(0,Number(value)||0);this.action('game:config',{config:this.state.rolesConfig}); }
  sendChat():void {const message=this.chatText.trim();if(!message)return;this.action('chat:message',{message});this.chatText='';}
  async toggleCamera():Promise<void>{await this.enableMedia(!this.cameraOn,this.micOn);}
  async toggleMic():Promise<void>{if(this.state?.me?.silenced)return;await this.enableMedia(this.cameraOn,!this.micOn);}
  ngAfterViewChecked():void { if(this.localVideo?.nativeElement)this.localVideo.nativeElement.muted=true; if(this.localVideo?.nativeElement && this.localStream && this.localVideo.nativeElement.srcObject!==this.localStream) this.localVideo.nativeElement.srcObject=this.localStream; }
  async copyRoomCode():Promise<void> { try { await navigator.clipboard.writeText(this.roomCode);this.notice='تم نسخ كود الغرفة'; } catch {this.notice='كود الغرفة: '+this.roomCode;} }
  get aliveCount():number { return this.state?.players.filter(p=>p.alive).length || 0; }
  get canTransmit():boolean { return this.connected && Boolean(this.state?.me?.canSpeak); }
  get micStatus():string { return this.state?.me?.silenced?'أُسكت ميكروفونك حتى نهاية الجولة — يمكنك التصويت':!this.micOn?'المايك مغلق':this.canTransmit?'المايك مفتوح الآن':this.state?.phase==='lobby'?'جاهز — يفتح تلقائيًا عند دورك':'مكتوم تلقائيًا حتى دورك'; }
  remoteMuted(id:string):boolean { return !this.connected || !this.state?.players.find(p=>p.id===id)?.alive || Boolean(this.state?.players.find(p=>p.id===id)?.silenced) || !(this.state?.phase==='lobby' || this.state?.phase==='discussion' && this.state.speakerId===id || this.state?.phase==='defense' && this.state.defensePlayerId===id); }
  private syncMediaPermissions():void { this.localStream?.getAudioTracks().forEach(t=>t.enabled=this.micOn && this.canTransmit); }
  private async enableMedia(video:boolean,audio:boolean):Promise<void>{
    if(this.mediaBusy)return;
    const session=this.mediaSession;this.mediaBusy=true;this.error='';
    try {
      if(!navigator.mediaDevices?.getUserMedia)throw new Error('unsupported');
      if(!this.localStream)this.localStream=new MediaStream();
      const needVideo=video&&!this.localStream.getVideoTracks().length;
      const needAudio=audio&&!this.localStream.getAudioTracks().length;
      if(needVideo||needAudio){
        const stream=await navigator.mediaDevices.getUserMedia({video:needVideo?{width:{ideal:640},height:{ideal:360},frameRate:{ideal:15,max:24},facingMode:'user'}:false,audio:needAudio?{echoCancellation:true,noiseSuppression:true,autoGainControl:true,channelCount:1}:false});
        if(session!==this.mediaSession){stream.getTracks().forEach(t=>t.stop());return;}
        stream.getTracks().forEach(track=>{
          track.enabled=false;this.localStream!.addTrack(track);
          track.onended=()=>this.zone.run(()=>{
            this.localStream?.removeTrack(track);
            if(track.kind==='video')this.cameraOn=false;else this.micOn=false;
            this.publishMedia();
          });
        });
      }
      this.cameraOn=video;this.micOn=audio;
      this.localStream.getVideoTracks().forEach(t=>t.enabled=video);this.syncMediaPermissions();
      for(const pc of this.peers.values())await this.attachTracks(pc);
      this.ensurePeerConnections();this.publishMedia();
    } catch {this.error='تعذر فتح الجهاز. اسمح بالمايك أو الكاميرا من إعدادات المتصفح واستخدم HTTPS أو localhost. يمكنك المتابعة بدونها.';}
    finally{this.mediaBusy=false;}
  }
  private async attachTracks(pc:RTCPeerConnection):Promise<void>{
    for(const transceiver of pc.getTransceivers()){
      // Reserve sending in the answer even if the user has not enabled a device yet.
      transceiver.direction='sendrecv';
      const track=this.localStream?.getTracks().find(t=>t.kind===transceiver.receiver.track.kind);
      if(track&&transceiver.sender.track!==track)await transceiver.sender.replaceTrack(track);
    }
  }
  private dropPeer(id:string):void{
    const pc=this.peers.get(id);if(pc){pc.onconnectionstatechange=null;pc.ontrack=null;pc.onicecandidate=null;pc.close();}
    this.peers.delete(id);this.sessions.delete(id);
    for(const key of this.pendingIce.keys())if(key.startsWith(id+':'))this.pendingIce.delete(key);
    const timer=this.retryTimers.get(id);if(timer)clearTimeout(timer);this.retryTimers.delete(id);
    this.remoteVideos=this.remoteVideos.filter(v=>v.id!==id);delete this.mediaStatus[id];
  }
  private closePeers():void {for(const id of this.peers.keys())this.dropPeer(id);this.pendingIce.clear();this.retries.clear();}
  private ensurePeerConnections():void {
    if(!this.state||!this.socket||!this.user||!this.connected)return;
    for(const id of this.peers.keys())if(!this.state.players.some(p=>p.id===id&&p.online))this.dropPeer(id);
    for(const p of this.state.players)if(p.id!==this.user.id&&p.online&&!this.peers.has(p.id)){
      this.socket.emit('webrtc:ready',{targetId:p.id});
      if(this.user.id<p.id)void this.makeOffer(p.id);
    }
  }
  private peer(id:string,sessionId:string):RTCPeerConnection {
    const pc=new RTCPeerConnection({iceServers:environment.iceServers});
    this.peers.set(id,pc);this.sessions.set(id,sessionId);this.mediaStatus[id]='connecting';
    pc.onicecandidate=e=>{if(e.candidate)this.socket?.emit('webrtc:ice',{targetId:id,sessionId,candidate:e.candidate});};
    pc.ontrack=e=>this.zone.run(()=>{
      if(this.peers.get(id)!==pc)return;
      const old=this.remoteVideos.find(v=>v.id===id);
      const stream=new MediaStream([...(old?.stream.getTracks()||[]).filter(t=>t.kind!==e.track.kind),e.track]);
      this.remoteVideos=[...this.remoteVideos.filter(v=>v.id!==id),{id,name:this.state?.players.find(p=>p.id===id)?.name||'لاعب',stream}];
    });
    pc.onconnectionstatechange=()=>this.zone.run(()=>{
      if(this.peers.get(id)!==pc)return;
      this.mediaStatus[id]=pc.connectionState;
      if(pc.connectionState==='connected'){
        const timer=this.retryTimers.get(id);if(timer)clearTimeout(timer);this.retryTimers.delete(id);
      } else if(['failed','disconnected'].includes(pc.connectionState) && !this.retryTimers.has(id)){
        this.retryTimers.set(id,setTimeout(()=>{
          this.retryTimers.delete(id);
          if(this.peers.get(id)!==pc || pc.connectionState==='connected')return;
          const attempt=this.retries.get(id)||0;
          if(attempt<2){this.retries.set(id,attempt+1);this.reconnectPeer(id);}
          else this.notice='تعذر اتصال الوسائط. اضغط إعادة المحاولة على بطاقة اللاعب.';
        },4000));
      }
    });
    return pc;
  }
  reconnectPeer(id:string):void{
    if(!this.connected || !this.state?.players.some(p=>p.id===id&&p.online))return;
    this.dropPeer(id);
    if(this.user && this.user.id<id)void this.makeOffer(id);
    else this.socket?.emit('webrtc:ready',{targetId:id,restart:true});
  }
  reconnectMedia():void {
    this.retries.clear();
    for(const p of this.state?.players||[])if(p.online && p.id!==this.user?.id)this.reconnectPeer(p.id);
    this.publishMedia();
  }
  private async flushIce(id:string,sessionId:string,pc:RTCPeerConnection):Promise<void>{
    const key=id+':'+sessionId,candidates=this.pendingIce.get(key)||[];this.pendingIce.delete(key);
    for(const candidate of candidates)await pc.addIceCandidate(candidate);
  }
  private async makeOffer(id:string):Promise<void>{
    try{
      if(this.peers.has(id))return;
      const sessionId=crypto.randomUUID(),pc=this.peer(id,sessionId);
      pc.addTransceiver('audio',{direction:'sendrecv'});pc.addTransceiver('video',{direction:'sendrecv'});
      await this.attachTracks(pc);await pc.setLocalDescription(await pc.createOffer());
      if(this.peers.get(id)===pc)this.socket?.emit('webrtc:offer',{targetId:id,sessionId,description:pc.localDescription});
    }catch{this.mediaStatus[id]='failed';}
  }
  private async receiveOffer(p:SignalPayload):Promise<void>{
    try{
      if(!p.description || !p.sessionId || !this.user || p.fromId>=this.user.id)return;
      if(this.sessions.get(p.fromId)===p.sessionId)return;
      // Preserve early ICE for the new session while disposing of an obsolete connection.
      const key=p.fromId+':'+p.sessionId,early=this.pendingIce.get(key)||[];
      this.dropPeer(p.fromId);this.pendingIce.set(key,early);
      const pc=this.peer(p.fromId,p.sessionId);
      await pc.setRemoteDescription(p.description);await this.attachTracks(pc);
      await this.flushIce(p.fromId,p.sessionId,pc);
      await pc.setLocalDescription(await pc.createAnswer());
      if(this.peers.get(p.fromId)===pc)this.socket?.emit('webrtc:answer',{targetId:p.fromId,sessionId:p.sessionId,description:pc.localDescription});
    }catch{this.mediaStatus[p.fromId]='failed';}
  }
  private async receiveAnswer(p:SignalPayload):Promise<void>{
    try{
      if(!p.description || !p.sessionId || this.sessions.get(p.fromId)!==p.sessionId)return;
      const pc=this.peers.get(p.fromId);if(!pc || pc.signalingState!=='have-local-offer')return;
      await pc.setRemoteDescription(p.description);await this.flushIce(p.fromId,p.sessionId,pc);
    }catch{this.mediaStatus[p.fromId]='failed';}
  }
  private async receiveIce(p:SignalPayload):Promise<void>{
    try{
      if(!p.candidate || !p.sessionId)return;
      const pc=this.peers.get(p.fromId),key=p.fromId+':'+p.sessionId;
      if(this.sessions.get(p.fromId)!==p.sessionId || !pc?.remoteDescription){
        if(this.pendingIce.size>40)this.pendingIce.clear();
        this.pendingIce.set(key,[...(this.pendingIce.get(key)||[]),p.candidate].slice(-60));return;
      }
      await pc.addIceCandidate(p.candidate);
    }catch{ /* Obsolete ICE can arrive while a connection is being replaced. */ }
  }
  private updateClock():void {const tick=()=>{const end=this.state?.phase==='discussion'?this.state.speakerEndsAt:this.state?.phase==='defense'?this.state.defenseEndsAt:this.state?.phase==='vote'?this.state.voteEndsAt:null;this.secondsLeft=end?Math.max(0,Math.ceil((end-Date.now()-this.clockOffset)/1000)):0;};tick();if(!this.clock)this.clock=setInterval(tick,1000);}
  leaveRoom(forget=true):void{if(forget && this.user)localStorage.removeItem('mafia_room_'+this.user.id);this.dismissedAnnouncement=0;this.roomTab='game';this.leaveConfirm=false;this.mediaSession++;this.connected=false;this.busy=false;if(this.clock)clearInterval(this.clock);this.clock=undefined;this.closePeers();this.socket?.disconnect();this.socket=null;this.peers.forEach(p=>p.close());this.peers.clear();this.remoteVideos=[];this.localStream?.getTracks().forEach(t=>t.stop());this.localStream=null;this.cameraOn=false;this.micOn=false;this.state=null;this.chat=[];}
  ngOnDestroy():void{this.leaveRoom(false);if(this.clock)clearInterval(this.clock);}
}

