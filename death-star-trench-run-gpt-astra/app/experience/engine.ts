import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {createXWing,createTIE} from './vehicles';
import {createDeathStar,createTrench} from './environment';
import {createSpace,CombatEffects,createDestruction} from './effects';
import {MissionAudio} from './audio';

export const DURATION=190;
export const CHAPTERS=[{name:'Approach',time:0},{name:'Interception',time:29},{name:'Surface dive',time:46},{name:'Trench run',time:68},{name:'Targeting',time:120},{name:'Torpedoes',time:137},{name:'Escape',time:145},{name:'Destruction',time:158}];
export type FlightState={ready:boolean;time:number;started:boolean;paused:boolean;autopilot:boolean;phase:string;objective:string;speed:number;shield:number;lock:number;torpedoes:number;kills:number;fps:number;complete:boolean;message:string;roll:number;damage:number;quality:string;targetX:number;targetY:number};
const clamp=THREE.MathUtils.clamp;
const smooth=(a:number,b:number,t:number)=>THREE.MathUtils.smoothstep(t,a,b);
const vec=(x=0,y=0,z=0)=>new THREE.Vector3(x,y,z);
const PHASES=[['THE APPROACH','Rendezvous with Red Squadron.'],['RED SQUADRON','Lock S-foils in attack position.'],['HOSTILE CONTACT','Enemy fighters incoming. Stay in formation.'],['SURFACE APPROACH','Follow the flight path to the equatorial trench.'],['ENTER THE TRENCH','Hold your course. Keep below the towers.'],['THE TRENCH RUN','Evade surface defenses. Reach the exhaust port.'],['TARGET ACQUIRED','Hold steady. Fire torpedoes when the lock is complete.'],['PROTON TORPEDOES','Two torpedoes away. Tracking the exhaust port.'],['CLEAR THE STATION','All fighters, pull up. Get clear.'],['CHAIN REACTION','Reactor instability detected. Maximum thrust.'],['MISSION COMPLETE','The Force will be with you. Always.']];
const targetingPhase=(t:number)=>t>=120&&t<137;
const indexFor=(t:number)=>t<14?0:t<29?1:t<46?2:t<58?3:t<68?4:t<120?5:t<137?6:t<145?7:t<158?8:t<188?9:10;
const transmissions=[{t:0,end:7,who:'RED LEADER',line:'All wings, report in. Stay close and follow my lead.'},{t:15,end:22,who:'RED FIVE',line:'Red Five standing by. Locking S-foils in attack position.'},{t:30,end:38,who:'RED TWO',line:'Fighters coming in. Three marks at point five.'},{t:47,end:55,who:'RED LEADER',line:'We’re passing through the magnetic field. Prepare your approach.'},{t:62,end:70,who:'RED LEADER',line:'Accelerate to attack speed. Stay below the towers.'},{t:82,end:89,who:'RED TWO',line:'You’ve got one on your tail. Keep moving.'},{t:105,end:112,who:'RED LEADER',line:'Almost there. Keep your eyes on the target.'},{t:122,end:129,who:'TARGETING COMPUTER',line:'Exhaust port in range. Stabilize your approach.'},{t:133,end:137,who:'RED FIVE',line:'I have the shot. Holding steady.'},{t:137,end:143,who:'RED FIVE',line:'Torpedoes away. Tracking the reactor shaft.'},{t:147,end:154,who:'RED LEADER',line:'Pull up! All fighters, get clear of the station.'},{t:165,end:172,who:'RED TWO',line:'Reactor ignition. Red Five, don’t look back.'},{t:183,end:190,who:'RED LEADER',line:'Good shot, Red Five. Let’s go home.'}];
export function transmissionAt(time:number){return transmissions.find(x=>time>=x.t&&time<x.end)}

export class MissionEngine{
  scene=new THREE.Scene();camera=new THREE.PerspectiveCamera(48,1,.15,25000);renderer:THREE.WebGLRenderer;
  composer:EffectComposer;bloom:UnrealBloomPass;grade:ShaderPass;
  audio=new MissionAudio();state:FlightState={ready:false,time:0,started:false,paused:false,autopilot:true,phase:PHASES[0][0],objective:PHASES[0][1],speed:680,shield:100,lock:0,torpedoes:2,kills:0,fps:60,complete:false,message:'',roll:0,damage:0,quality:'balanced',targetX:.5,targetY:.43};
  star=createSpace();station=createDeathStar(300);trench=createTrench();explosion=createDestruction(300);effects=new CombatEffects();
  player=createXWing();squad=[createXWing(),createXWing()];enemies=Array.from({length:6},()=>createTIE());
  internal=new THREE.Group();torps:THREE.Group[]=[];torpTrails:THREE.Line[]=[];engineLight=new THREE.PointLight(0xff7b45,0,3000,1);
  private frame=0;private last=0;private displayTime=0;private lastState=0;private lastShot=-1;private lastEnemyShot=-1;private lastTurretShot=-1;private lastCollision=-5;private hitShake=0;private boost=0;private travel=0;private disposed=false;private keys=new Set<string>();private pointer={x:0,y:0,active:false};private input=vec();private cameraAim=vec();private targetCamera=vec();private targetLook=vec();private enemyRespawn:number[]=[0,0,0,0,0,0];private snap=true;private lastIndex=-1;private launched=false;private exploded=false;private motion=true;private sizeObserver:ResizeObserver;
  private onState:(s:FlightState)=>void;
  private down=(e:KeyboardEvent)=>{if((e.target as HTMLElement)?.matches('input,select,textarea'))return;if(['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Tab'].includes(e.code))e.preventDefault();this.keys.add(e.code);if(e.repeat)return;if(e.code==='KeyP'||e.code==='Escape')this.pause();if(e.code==='KeyC')this.setAutopilot(!this.state.autopilot);if(e.code==='KeyT')this.fireTorpedoes();if(e.code==='KeyR'&&this.state.complete)this.start(this.state.autopilot)};
  private up=(e:KeyboardEvent)=>this.keys.delete(e.code);
  private blur=()=>this.keys.clear();
  constructor(private container:HTMLElement,onState:(s:FlightState)=>void){
    this.onState=onState;
    this.renderer=new THREE.WebGLRenderer({antialias:true,alpha:false,powerPreference:'high-performance'});
    this.renderer.outputColorSpace=THREE.SRGBColorSpace;this.renderer.toneMapping=THREE.ACESFilmicToneMapping;this.renderer.toneMappingExposure=1.2;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio,1.35));this.renderer.setClearColor(0x04070b);container.appendChild(this.renderer.domElement);
    const sun=new THREE.DirectionalLight(0xd4e4ff,3.8);sun.position.set(-600,500,650);this.scene.add(sun);
    const fill=new THREE.DirectionalLight(0x6b8fae,1.2);fill.position.set(300,0,200);this.scene.add(fill,new THREE.HemisphereLight(0x97bad3,0x181824,1.25));
    const rim=new THREE.DirectionalLight(0xffb08a,1.0);rim.position.set(0,-90,-180);this.scene.add(rim,this.engineLight);
    const pmrem=new THREE.PMREMGenerator(this.renderer);const room=new RoomEnvironment();this.scene.environment=pmrem.fromScene(room,.03).texture;this.scene.environmentIntensity=.45;room.dispose();pmrem.dispose();
    this.scene.add(this.star.group,this.station.group,this.trench.group,this.explosion.group,this.effects.group,this.player.group,...this.squad.map(x=>x.group),...this.enemies.map(x=>x.group));
    // Broad surface aprons keep the modular trench embedded in a continuous station crust.
    const apronMaterial=new THREE.MeshStandardMaterial({color:0x222c37,roughness:.88,metalness:.35});
    for(const side of [-1,1]){const apron=new THREE.Mesh(new THREE.BoxGeometry(8000,3,16000),apronMaterial);apron.position.set(side*4055,26,-6500);this.trench.group.add(apron)}
    const crustDetails=new THREE.InstancedMesh(new THREE.BoxGeometry(1,1,1),apronMaterial,1500);const machine=new THREE.Object3D();
    for(let i=0;i<1500;i++){const r=(k:number)=>{const n=Math.sin((i+1)*k)*43758.5453;return n-Math.floor(n)};const height=3+r(3.42)*32;machine.position.set((i%2?1:-1)*(225+r(12.9898)*1200),29+height/2,100-r(45.23)*3600);machine.scale.set(5+r(78.23)*30,height,8+r(9.35)*35);machine.updateMatrix();crustDetails.setMatrixAt(i,machine.matrix);crustDetails.setColorAt(i,new THREE.Color().setScalar(.25+r(5.35)*.4));}this.trench.group.add(crustDetails);
    const tunnelMat=new THREE.MeshStandardMaterial({color:0x1e2631,metalness:.7,roughness:.6,side:THREE.BackSide});
    const tunnel=new THREE.Mesh(new THREE.CylinderGeometry(6,6,130,24,1,true),tunnelMat);tunnel.rotation.x=Math.PI/2;tunnel.position.set(0,-4,-250);this.internal.add(tunnel);
    const tunnelRingMat=new THREE.MeshBasicMaterial({color:0x8a3318});
    for(let i=0;i<17;i++){const ring=new THREE.Mesh(new THREE.TorusGeometry(5.8,.13,5,24),tunnelRingMat);ring.position.set(0,-4,-190-i*7);this.internal.add(ring)}
    const reactor=new THREE.Mesh(new THREE.SphereGeometry(5,16,12),new THREE.MeshBasicMaterial({color:new THREE.Color(3,.55,.04)}));reactor.position.set(0,-4,-315);this.internal.add(reactor);this.scene.add(this.internal);

    for(let i=0;i<2;i++){
      const g=new THREE.Group();const core=new THREE.Mesh(new THREE.SphereGeometry(.32,12,8),new THREE.MeshBasicMaterial({color:new THREE.Color(5,1.6,.4)}));g.add(core);
      const material=new THREE.ShaderMaterial({transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,uniforms:{uTime:{value:0}},vertexShader:'varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',fragmentShader:'varying vec2 vUv;uniform float uTime;void main(){vec2 p=vUv-.5;float d=length(p*vec2(1.,.23));float a=exp(-d*18.)*(.85+.15*sin(uTime*39.+p.y*40.));gl_FragColor=vec4(vec3(4.,1.0,.15),a*.8);}'});
      const glow=new THREE.Mesh(new THREE.PlaneGeometry(4,13),material);glow.rotation.x=-Math.PI/2;g.add(glow);this.scene.add(g);this.torps.push(g);
      const line=new THREE.Line(new THREE.BufferGeometry().setFromPoints(Array.from({length:40},()=>vec())),new THREE.LineBasicMaterial({color:0xff9a56,transparent:true,opacity:.65,blending:THREE.AdditiveBlending}));this.scene.add(line);this.torpTrails.push(line);
    }
    this.composer=new EffectComposer(this.renderer);this.composer.addPass(new RenderPass(this.scene,this.camera));this.bloom=new UnrealBloomPass(new THREE.Vector2(1,1),.48,.55,1.1);this.composer.addPass(this.bloom);
    this.grade=new ShaderPass({uniforms:{tDiffuse:{value:null},uTime:{value:0},uShake:{value:0},uFlash:{value:0},uSpeed:{value:0},uWave:{value:0}},vertexShader:'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',fragmentShader:`uniform sampler2D tDiffuse;uniform float uTime,uShake,uFlash,uSpeed,uWave;varying vec2 vUv;float hash(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453);}void main(){vec2 p=vUv-.5;float r=length(p);float shock=sin(r*65.-uTime*14.)*uWave*.008;vec2 uv=vUv+p*shock;vec3 col=texture2D(tDiffuse,uv).rgb;if(uSpeed>.1){vec2 velocity=p*uSpeed*.005;col=col*.64+texture2D(tDiffuse,uv+velocity).rgb*.22+texture2D(tDiffuse,uv+velocity*2.).rgb*.14;}col*=1.-.32*pow(length(p)*1.35,1.6);col+=vec3(hash(vUv*1000.+uTime)-.5)*.009;col+=vec3(.75,.13,.035)*uShake*.22;col+=vec3(1.,.7,.35)*uFlash;gl_FragColor=vec4(col,1.);}`});this.composer.addPass(this.grade);this.composer.addPass(new OutputPass());
    this.sizeObserver=new ResizeObserver(()=>this.resize());this.sizeObserver.observe(container);this.resize();
    window.addEventListener('keydown',this.down);window.addEventListener('keyup',this.up);window.addEventListener('blur',this.blur);
    this.motion=!window.matchMedia('(prefers-reduced-motion: reduce)').matches;this.state.ready=true;this.onState({...this.state});this.frame=requestAnimationFrame(this.animate);
  }
  resize(){const w=this.container.clientWidth,h=this.container.clientHeight;this.renderer.setSize(w,h);this.composer.setSize(w,h);this.camera.aspect=w/h;this.camera.updateProjectionMatrix()}
  start(autopilot:boolean){this.state={...this.state,time:0,started:true,paused:false,autopilot,shield:100,kills:0,torpedoes:2,complete:false};this.travel=0;this.input.set(0,0,0);this.snap=true;this.launched=false;this.exploded=false;this.enemyRespawn.fill(0);this.lastShot=this.lastEnemyShot=this.lastTurretShot=-1;this.lastCollision=-5;this.keys.clear();void this.audio.enable();this.onState({...this.state})}
  home(){this.state.started=false;this.state.paused=false;this.state.complete=false;this.snap=true;this.onState({...this.state})}
  pause(){if(!this.state.started||this.state.complete)return;this.state.paused=!this.state.paused;this.keys.clear();this.onState({...this.state})}
  setAutopilot(auto:boolean){this.state.autopilot=auto;this.keys.clear();this.onState({...this.state})}
  setPointer(x:number,y:number,active:boolean){this.pointer={x,y,active}}
  setKey(key:string,value:boolean){value?this.keys.add(key):this.keys.delete(key)}
  seek(time:number){this.state.time=clamp(time,0,DURATION);this.state.complete=time>=188;this.state.torpedoes=time>=137?0:2;this.launched=time>=137;this.exploded=time>=166;this.lastShot=this.lastEnemyShot=this.lastTurretShot=time;this.enemyRespawn.fill(0);this.travel=Math.max(0,time-58)*155;this.snap=true;this.onState({...this.state})}
  setQuality(quality:string){this.state.quality=quality;this.renderer.setPixelRatio(Math.min(devicePixelRatio,quality==='high'?1.75:quality==='performance'?.85:1.25));this.bloom.enabled=quality!=='performance';this.resize();this.onState({...this.state})}
  setMotion(value:boolean){this.motion=value}
  fireTorpedoes(){if(this.state.time>=128&&this.state.time<137&&this.state.lock>=.98){this.seek(137);this.audio.torpedo();this.launched=true}}
  private fire(){const t=this.state.time;if(t-this.lastShot<.15)return;this.lastShot=t;const origin=vec();this.player.group.updateMatrixWorld();for(let i=0;i<this.player.muzzlePoints.length;i+=2){this.player.muzzlePoints[i].getWorldPosition(origin);this.effects.fire(origin,origin.clone().add(vec(this.input.x*.9,0,-500)),0xff5136,520)}this.audio.laser();
    for(let i=0;i<this.enemies.length;i++){const e=this.enemies[i].group;if(e.visible&&e.position.z<0&&Math.abs(e.position.x-this.player.group.position.x)<10&&Math.abs(e.position.y-this.player.group.position.y)<13){this.effects.burst(e.position,0xff8035,5);this.enemyRespawn[i]=t+7;this.state.kills++;this.hitShake=.1;break}}
  }
  private animate=(now:number)=>{if(this.disposed)return;const raw=this.last?(now-this.last)/1000:1/60;const dt=Math.min(raw,.06);this.last=now;this.displayTime+=dt;
    if(this.state.started&&!this.state.paused&&!this.state.complete)this.state.time=Math.min(DURATION,this.state.time+dt);
    const t=this.state.time;const active=this.state.started;const simDt=this.state.paused||this.state.complete?0:dt;const idx=indexFor(t);
    this.state.phase=PHASES[idx][0];this.state.objective=PHASES[idx][1];this.state.complete=active&&t>=188;
    if(idx!==this.lastIndex){this.lastIndex=idx;if(idx===7&&!this.launched){this.launched=true;this.audio.torpedo()}if(idx===9)this.state.torpedoes=0}
    this.station.group.visible=!active||t<58||t>=151&&t<166;
    this.trench.group.visible=active&&t>=49&&t<151;
    this.explosion.group.visible=active&&t>=158;
    
    this.station.update(this.displayTime,active&&t>=158?clamp((t-158)/9,0,1):0);
    const attack=active?smooth(11,23,t):.92;
    this.player.update(this.displayTime,attack,this.boost);this.squad.forEach(x=>x.update(this.displayTime,attack,.4));
    this.internal.visible=active&&t>=137&&t<145;this.torps.forEach(x=>x.visible=active&&t>=137&&t<144.8);this.torpTrails.forEach(x=>x.visible=active&&t>=137&&t<144.8);
    this.enemies.forEach(x=>x.group.visible=false);this.squad.forEach(x=>x.group.visible=!active||t<58||t>=148);this.player.group.visible=!active||t<140||t>=145;
    if(!active)this.lobby(this.displayTime);else if(t<49)this.spaceFlight(t,idx);else if(t<58)this.dive(t);else if(t<137)this.trenchFlight(t,simDt);else if(t<145)this.torpedoShot(t);else this.escape(t);
    if(active&&!this.state.paused){this.combat(t,simDt);this.audio.update(t,this.boost,t>=29&&t<145)}
    if(active&&t>=158){this.explosion.update(t-158,t);if(t>=166&&!this.exploded){this.exploded=true;this.audio.explosion()}}
    this.hitShake=Math.max(0,this.hitShake-dt*1.5);this.state.damage=this.hitShake;
    const lerp=this.snap?1:1-Math.exp(-dt*(t>=58&&t<137?5:2.8));this.camera.position.lerp(this.targetCamera,lerp);this.cameraAim.lerp(this.targetLook,lerp);
    const shake=this.motion?(this.hitShake*.25+(active&&t>68&&t<137?.025+this.boost*.05:0)+(active&&t>168&&t<177?.7*Math.sin((t-168)/9*Math.PI):0)):0;
    this.camera.position.x+=Math.sin(this.displayTime*71)*shake;this.camera.position.y+=Math.sin(this.displayTime*83)*shake*.6;this.camera.lookAt(this.cameraAim);this.star.update(this.displayTime,this.camera);this.camera.rotation.z+=(this.motion&&active&&t>=58&&t<137?-this.input.x*.001:0);this.snap=false;
    if(targetingPhase(t)&&active){const portScreen=this.trench.port.getWorldPosition(vec()).project(this.camera);this.state.targetX=(portScreen.x+1)/2;this.state.targetY=(1-portScreen.y)/2}else{this.state.targetX=.5;this.state.targetY=.43}
    this.grade.uniforms.uTime.value=this.displayTime;this.grade.uniforms.uShake.value=this.hitShake;this.grade.uniforms.uSpeed.value=active&&t>58&&t<137?.4+this.boost*.8:0;this.grade.uniforms.uFlash.value=active?Math.max(0,1-Math.abs(t-166.4)*1.8)*.4:0;this.grade.uniforms.uWave.value=active?smooth(168,170,t)*(1-smooth(176,178,t)):0;
    this.engineLight.intensity=active&&t>=162&&t<=180?Math.max(0,Math.sin((t-162)/18*Math.PI))*850:0;
    this.state.fps=THREE.MathUtils.lerp(this.state.fps,1/Math.max(raw,.001),.025);this.state.roll=this.player.group.rotation.z;
    this.bloom.strength=active&&t>=165?.23:.48;this.renderer.toneMappingExposure=active&&t>=165?.95:1.2;this.composer.render(simDt);
    if(now-this.lastState>100){this.lastState=now;this.container.dataset.fps=String(Math.round(this.state.fps));this.container.dataset.drawcalls=String(this.renderer.info.render.calls);this.container.dataset.time=String(this.state.time);this.container.dataset.player=JSON.stringify(this.player.group.position.toArray());this.onState({...this.state})}
    this.frame=requestAnimationFrame(this.animate);
  }
  private lobby(t:number){
    this.station.group.position.set(410,140,-650);this.station.group.rotation.set(0,-.13,0);this.station.group.scale.setScalar(1);
    this.targetCamera.set(0,35,900);this.targetLook.set(0,15,-100);this.setFov(43);
    this.player.group.position.set(120+Math.sin(t*.14)*7,-23+Math.sin(t*.28)*3,430);this.player.group.scale.setScalar(9.1);this.player.group.rotation.set(.12,.83,-.27+Math.sin(t*.14)*.025);
    this.squad[0].group.position.set(40,45,-30);this.squad[1].group.position.set(285,-100,-120);this.squad.forEach((x,i)=>{x.group.scale.setScalar(2.5-i*.45);x.group.rotation.set(.08,.8,-.2)});
    if(this.camera.aspect<.9){this.station.group.position.set(100,300,-650);this.station.group.scale.setScalar(.8);this.player.group.position.set(20+Math.sin(t*.2)*3,125+Math.sin(t*.3)*3,430);this.player.group.scale.setScalar(6);this.squad[0].group.position.set(-50,200,-30);this.squad[1].group.visible=false;}
    this.state.speed=680;
  }
  private spaceFlight(t:number,idx:number){
    this.scene.fog=null;this.station.group.position.set(140,115,-1300+t*10);this.station.group.scale.setScalar(1);this.station.group.rotation.set(0,-.14,0);
    this.player.group.scale.setScalar(1);this.player.group.position.set(Math.sin(t*.32)*1.2,Math.sin(t*.42)*.55,0);this.player.group.rotation.set(Math.sin(t*.4)*.025,Math.sin(t*.2)*.025,Math.sin(t*.3)*.07);
    this.squad.forEach((x,i)=>{x.group.scale.setScalar(1);x.group.position.set(i===0?-25:28,6+i*5,-30-i*16);x.group.rotation.copy(this.player.group.rotation)});
    if(t<14){const q=smooth(0,14,t);this.targetCamera.set(70-q*38,25-q*11,115-q*58);this.targetLook.set(0,6,-95+q*50);this.setFov(47)}
    else if(t<29){const q=smooth(14,29,t);this.targetCamera.set(32-q*46,14-q*6,57-q*24);this.targetLook.set(0,2,-8);this.setFov(43+q*5)}
    else {const q=smooth(29,46,t);this.targetCamera.set(-14*(1-q),8+q*3,33+q*9);this.targetLook.set(0,1,-35);this.setFov(48+q*7);this.spawnEnemies(t,false)}
    this.state.speed=Math.round(650+t*4);
  }
  private dive(t:number){
    const p=smooth(49,58,t);this.scene.fog=new THREE.FogExp2(0x070c13,.0015*p);this.station.group.position.set(140*(1-p),115-4000*p,-810+(t-49)*20);this.station.group.scale.setScalar(1+4*p);this.trench.group.position.set(0,-600*(1-p),0);this.trench.update(t,(t-58)*155,vec());
    this.player.group.position.set(Math.sin(t)*.5,0,0);this.player.group.scale.setScalar(1);this.player.group.rotation.set(-.17*Math.sin(p*Math.PI),0,.1*Math.sin(p*Math.PI));
    this.targetCamera.set(0,11+10*Math.sin(p*Math.PI),42);this.targetLook.set(0,-80*Math.sin(p*Math.PI),-140);this.setFov(55+p*7);this.state.speed=Math.round(850+p*230);
  }
  private trenchFlight(t:number,dt:number){
    this.scene.fog=new THREE.FogExp2(0x070c13,.0015);this.trench.group.position.set(0,0,0);this.player.group.scale.setScalar(1);
    const playable=t>=68;const autopilot=this.state.autopilot||!playable;this.boost=THREE.MathUtils.lerp(this.boost,this.keys.has('ShiftLeft')||this.keys.has('ShiftRight')?1:0,1-Math.exp(-dt*5));
    let tx=autopilot?Math.sin(t*.37)*7+Math.sin(t*.13)*3:this.input.x;let ty=autopilot?Math.sin(t*.43)*3:this.input.y;
    if(!autopilot){const horiz=Number(this.keys.has('KeyD')||this.keys.has('ArrowRight'))-Number(this.keys.has('KeyA')||this.keys.has('ArrowLeft'));const vert=Number(this.keys.has('KeyW')||this.keys.has('ArrowUp'))-Number(this.keys.has('KeyS')||this.keys.has('ArrowDown'));tx+=horiz*28*dt;ty+=vert*22*dt;if(this.pointer.active){tx=this.pointer.x*23;ty=-this.pointer.y*10}}
    if(t>124&&autopilot){tx*=1-smooth(124,132,t);ty*=1-smooth(124,132,t)}
    this.input.x=clamp(tx,-23,23);this.input.y=clamp(ty,-9,17);const oldX=this.player.group.position.x;
    this.player.group.position.lerp(vec(this.input.x,this.input.y,0),1-Math.exp(-dt*8));this.player.group.rotation.z=THREE.MathUtils.lerp(this.player.group.rotation.z,-(this.input.x-oldX)*.05+(Number(this.keys.has('KeyQ'))-Number(this.keys.has('KeyE')))*.55,1-Math.exp(-dt*5));this.player.group.rotation.x=-(this.input.y-this.player.group.position.y)*.025;this.player.group.rotation.y=-(this.input.x-oldX)*.012;
    const speed=155+this.boost*80;this.travel+=dt*speed;this.trench.update(t,this.travel,this.player.group.position);this.trench.port.visible=t>=120;this.trench.port.position.z=-(740-(t-120)*32.6471);
    this.targetCamera.set(this.player.group.position.x*.58,this.player.group.position.y*.62+8,33+this.boost*4);this.targetLook.set(this.player.group.position.x*.85,this.player.group.position.y*.75+1,-105);this.setFov(62+this.boost*8-smooth(121,134,t)*6);
    this.state.speed=Math.round(960+this.boost*460+Math.sin(t*2)*14);this.state.lock=t>=120?clamp((t-123)/10,0,1):0;
    this.spawnEnemies(t,true);
    if(t>128)this.state.lock*=1-clamp((Math.abs(this.input.x)-12)/12,0,.55);
    if(this.keys.has('Space')||this.pointer.active&&this.keys.has('Mouse0')||autopilot&&t>71&&t<119&&Math.sin(t*1.2)>.65)this.fire();
    if(t-this.lastCollision>1.3){let collision=Math.abs(this.input.x)>22||this.input.y<-8.5;for(const o of this.trench.obstacles){if(o.position.distanceTo(this.player.group.position)<o.radius+2){collision=true;break}}if(collision){this.lastCollision=t;this.state.shield=Math.max(12,this.state.shield-11);this.effects.burst(this.player.group.position.clone().add(vec(5,-2,0)),0xffa54d,2);this.hitShake=1;this.audio.impact()}}
    this.state.shield=Math.min(100,this.state.shield+dt*.22);
  }
  private spawnEnemies(t:number,trench:boolean){
    this.enemies.forEach((enemy,i)=>{const e=enemy.group;e.visible=t>this.enemyRespawn[i]&&(!trench||i<3)&&t<128;if(!e.visible)return;enemy.update(t);e.scale.setScalar(trench?.9:1.2);
      if(trench){e.position.set(Math.sin(t*.5+i*2.1)*17,4+Math.cos(t*.7+i)*7,-105-i*98+Math.sin(t*.25+i)*35);e.rotation.set(Math.sin(t+i)*.05,Math.PI,Math.sin(t*.7+i)*.32)}
      else{const pass=(t-29+i*2.5)%17;e.position.set(Math.sin(t*.35+i*1.6)*(38+i*8),Math.cos(t*.6+i)*18+10,-240+pass*23-i*30);e.rotation.set(.04,Math.PI,Math.sin(t+i)*.4)}
    });
  }
  private combat(t:number,dt:number){
    this.effects.update(dt,t);if(t>=29&&t<132&&t-this.lastEnemyShot>.9){this.lastEnemyShot=t;const i=Math.floor(t*2)%this.enemies.length;const enemy=this.enemies[i].group;if(enemy.visible){const dest=this.player.group.position.clone().add(vec(Math.sin(t*9)*12,Math.cos(t*5)*8,15));this.effects.fire(enemy.position,dest,0x76ff65,190);if(t>68&&Math.sin(t*7)>.96&&!this.state.autopilot){this.state.shield=Math.max(12,this.state.shield-3);this.hitShake=.25}}}
    if(t>=66&&t<137&&t-this.lastTurretShot>.42){this.lastTurretShot=t;const source=vec(Math.sin(t*3)>0?31:-31,25,-160-(Math.floor(t*7)%6)*65);for(const turret of this.trench.turrets){const anchor=(turret.userData.muzzle as THREE.Object3D).getWorldPosition(vec());if(anchor.z < -70 && anchor.z > -650){source.copy(anchor);break}}this.effects.fire(source,this.player.group.position.clone().add(vec(Math.sin(t*8)*16,Math.cos(t*6)*9,40)),0x6bff89,225);if(Math.sin(t*4)>.3)this.effects.burst(vec(source.x>0?-33:33,Math.sin(t)*18, -60),0xff9944,1.5)}
  }
  private torpedoShot(t:number){
    this.scene.fog=new THREE.FogExp2(0x070c13,.0015);this.trench.group.position.set(0,0,0);this.trench.update(t,this.travel,vec());this.trench.port.visible=true;this.trench.port.position.z=-185;
    const p=clamp((t-137)/6.5,0,1);this.state.torpedoes=0;this.state.lock=1;this.player.group.position.set(0,0,0);this.player.group.rotation.set(0,0,0);
    this.torps.forEach((g,i)=>{const curve=new THREE.CubicBezierCurve3(vec((i===0?-1:1)*2,-1,-5),vec((i===0?-1:1)*5,0,-90),vec((i===0?-1:1)*3,-4,-167),vec(0,-4,-190));const progress=clamp(p-(i*.03),0,1);g.position.copy(curve.getPoint(progress));g.lookAt(curve.getPoint(Math.min(1,progress+.01)));const glow=g.children[1] as THREE.Mesh<THREE.PlaneGeometry,THREE.ShaderMaterial>;glow.material.uniforms.uTime.value=t;const points=Array.from({length:40},(_,j)=>curve.getPoint(Math.max(0,progress-j*.0028)));this.torpTrails[i].geometry.setFromPoints(points);});
    if(t>143.5){const q=clamp((t-143.5)/1.4,0,1);this.torps.forEach((g,i)=>{g.position.set((i===0?-1:1)*(.6-q*.6),-4,-190-q*120);g.scale.setScalar(.65)});this.targetCamera.set(0,-3,-182-q*105);this.targetLook.set(0,-4,-325);this.setFov(70);return;}else{this.torps.forEach(g=>g.scale.setScalar(1))}
    if(p<.3){this.targetCamera.set(16,8,23);this.targetLook.set(0,-1,-60)}else {const point=this.torps[0].position;this.targetCamera.copy(point).add(vec(12,9,25));this.targetLook.copy(point).add(vec(-5,-4,-32))}this.setFov(53);
    if(t>144.3)this.effects.burst(vec(0,-4,-190),0xff813c,3);
  }
  private escape(t:number){
    this.scene.fog=null;this.setFov(t<158?57:49);this.trench.group.position.set(0,-(t-145)*80,0);this.player.group.scale.setScalar(t>=158?8:1);
    if(t<151){const p=smooth(145,151,t);this.trench.update(t,this.travel+(t-145)*220,vec());this.player.group.position.set(0,p*30,-p*12);this.player.group.rotation.set(.3,0,-.15*Math.sin(p*Math.PI));this.targetCamera.set(18,10+p*52,42+p*48);this.targetLook.set(0,p*20,-70)}
    else if(t<158){const p=smooth(151,158,t);this.station.group.position.set(0,-540, -600);this.station.group.scale.setScalar(1.4);this.player.group.position.set(0,20,0);this.player.group.rotation.set(.15,Math.PI*.17,-.1);this.targetCamera.set(45+p*80,60+p*80,95+p*300);this.targetLook.set(0,-60-p*180,-280);}
    else {const e=t-158;this.station.group.position.set(0,0,0);this.station.group.scale.setScalar(1);this.explosion.group.position.set(0,0,0);this.engineLight.position.set(0,0,320);
      this.targetCamera.set(120+e*12,170+e*5,2400+e*100);this.targetLook.set(0,0,0);
      this.player.group.position.set(-270+e*13,-145+e*5,760+e*69);this.player.group.rotation.set(.05,2.5,-.18+Math.sin(e*.3)*.04);
      if(e>20){this.player.group.position.x+=Math.pow(e-20,2)*6;this.player.group.position.z+=Math.pow(e-20,2)*60}
    }
    this.squad.forEach((x,i)=>{x.group.scale.setScalar(t>=158?5:1);x.group.position.copy(this.player.group.position).add(vec(i===0?-85:78,28+i*24,-80-i*40));x.group.rotation.copy(this.player.group.rotation)});this.state.speed=Math.round(1400+Math.min(t-145,25)*30);this.boost=1;
  }
  private setFov(f:number){this.camera.fov=THREE.MathUtils.lerp(this.camera.fov,f,this.snap?1:.08);this.camera.updateProjectionMatrix()}
  dispose(){this.disposed=true;cancelAnimationFrame(this.frame);window.removeEventListener('keydown',this.down);window.removeEventListener('keyup',this.up);window.removeEventListener('blur',this.blur);this.sizeObserver.disconnect();const geometries=new Set<THREE.BufferGeometry>(),materials=new Set<THREE.Material>();this.scene.traverse(o=>{const m=o as THREE.Mesh;if(m.geometry)geometries.add(m.geometry);if(m.material)(Array.isArray(m.material)?m.material:[m.material]).forEach(x=>materials.add(x))});geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());this.scene.environment?.dispose();this.composer.dispose();this.renderer.dispose();this.renderer.domElement.remove();this.audio.dispose()}
}
