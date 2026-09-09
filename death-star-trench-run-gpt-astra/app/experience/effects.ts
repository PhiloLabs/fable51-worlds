import * as THREE from 'three';

// Every random layout is seeded, so scrubbing the cinematic gives the same frame.
function random(seed: number) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const clamp = THREE.MathUtils.clamp;
const smooth = THREE.MathUtils.smoothstep;

const noiseGLSL = /* glsl */`
float hash31(vec3 p) {
  p = fract(p * .1031); p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}
float noise3(vec3 p) {
  vec3 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(mix(hash31(i), hash31(i+vec3(1,0,0)), f.x),
                 mix(hash31(i+vec3(0,1,0)), hash31(i+vec3(1,1,0)), f.x), f.y),
             mix(mix(hash31(i+vec3(0,0,1)), hash31(i+vec3(1,0,1)), f.x),
                 mix(hash31(i+vec3(0,1,1)), hash31(i+vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 p) {
  float s = 0.0, a = .5;
  for(int i=0;i<5;i++) { s += noise3(p)*a; p = p*2.07 + vec3(3.2,1.7,4.9); a *= .5; }
  return s;
}
`;

export function createSpace() {
  const group = new THREE.Group();
  const rng = random(1927);
  const count = 5900;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const z = rng() * 2 - 1;
    const a = rng() * Math.PI * 2;
    const r = Math.sqrt(1 - z * z);
    positions.set([Math.cos(a) * r * 12000, z * 12000, Math.sin(a) * r * 12000], i * 3);
    const bright = Math.pow(rng(), 5);
    const c = new THREE.Color().setRGB(.35 + bright * .9, .42 + bright, .52 + bright * 1.25);
    if (rng() > .92) c.setRGB(.95, .72, .49);
    colors.set([c.r, c.g, c.b], i * 3);
    sizes[i] = .65 + bright * 2.25;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  const material = new THREE.ShaderMaterial({
    vertexColors: true, transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 } },
    vertexShader: /* glsl */`
      attribute float aSize; varying vec3 vColor; uniform float uTime;
      void main() {
        vColor = color; vec4 p = modelViewMatrix * vec4(position,1.);
        gl_Position = projectionMatrix * p;
        gl_PointSize = aSize * (1.1 + .05*sin(uTime*.3 + position.x));
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vColor;
      void main() {
        float d = length(gl_PointCoord-.5)*2.;
        float a = exp(-d*d*3.)*(1.-smoothstep(.65,1.,d));
        gl_FragColor = vec4(vColor, a*.8);
      }`,
  });
  const stars = new THREE.Points(geometry, material);
  stars.frustumCulled = false; stars.renderOrder = -98; group.add(stars);
  const dustMaterial = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, depthTest: false,
    vertexShader: 'varying vec3 vDirection; void main(){vDirection=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader: /* glsl */`
      varying vec3 vDirection;
      ${noiseGLSL}
      void main() {
        vec3 p = normalize(vDirection);
        float band = exp(-pow((p.y + p.x*.31 + .14)*3.1,2.));
        float n = fbm(p*7.8);
        float lanes = smoothstep(.36,.75,fbm(p*18.));
        vec3 c = vec3(.0007,.0014,.0032);
        c += vec3(.009,.014,.027) * band * n * lanes;
        c += vec3(.006,.002,.008) * pow(n,3.) * band;
        gl_FragColor = vec4(c,1.);
      }`,
  });
  const dust = new THREE.Mesh(new THREE.SphereGeometry(14000, 32, 20), dustMaterial);
  dust.frustumCulled = false; dust.renderOrder = -99; group.add(dust);
  return {
    group,
    update(time: number, camera: THREE.Camera) {
      group.position.copy(camera.position);
      material.uniforms.uTime.value = time;
    },
  };
}

type Bolt = { active: boolean; position: THREE.Vector3; direction: THREE.Vector3; target: THREE.Vector3; color: THREE.Color; speed: number; remaining: number; length: number };
type Spark = { life: number; maxLife: number; position: THREE.Vector3; velocity: THREE.Vector3; color: THREE.Color; size: number };

export class CombatEffects {
  group = new THREE.Group();
  private bolts: Bolt[] = [];
  private sparks: Spark[] = [];
  private boltCursor = 0;
  private sparkCursor = 0;
  private boltGeometry: THREE.BufferGeometry;
  private sparkGeometry: THREE.BufferGeometry;
  private rng = random(3344);
  private readonly boltCount = 100;
  private readonly sparkCount = 1300;
  constructor() {
    this.boltGeometry = new THREE.BufferGeometry();
    const starts = new Float32Array(this.boltCount * 12);
    const ends = new Float32Array(this.boltCount * 12);
    const colors = new Float32Array(this.boltCount * 12);
    const corners = new Float32Array(this.boltCount * 8);
    const indices: number[] = [];
    for (let i = 0; i < this.boltCount; i++) {
      corners.set([0, -1, 1, -1, 1, 1, 0, 1], i * 8);
      const k = i * 4; indices.push(k,k+1,k+2,k,k+2,k+3);
      this.bolts.push({ active: false, position: new THREE.Vector3(), direction: new THREE.Vector3(), target: new THREE.Vector3(), color: new THREE.Color(), speed: 0, remaining: 0, length: 0 });
    }
    this.boltGeometry.setAttribute('position', new THREE.BufferAttribute(starts.slice(), 3));
    this.boltGeometry.setAttribute('aStart', new THREE.BufferAttribute(starts, 3).setUsage(THREE.DynamicDrawUsage));
    this.boltGeometry.setAttribute('aEnd', new THREE.BufferAttribute(ends, 3).setUsage(THREE.DynamicDrawUsage));
    this.boltGeometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage));
    this.boltGeometry.setAttribute('aCorner', new THREE.BufferAttribute(corners, 2));
    this.boltGeometry.setIndex(indices);
    const laserMaterial = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */`
        attribute vec3 aStart, aEnd, aColor; attribute vec2 aCorner;
        varying vec2 vUv; varying vec3 vColor;
        void main() {
          vec4 a = modelViewMatrix * vec4(aStart,1.);
          vec4 b = modelViewMatrix * vec4(aEnd,1.);
          vec2 axis = normalize(b.xy-a.xy+vec2(.00001));
          vec4 p = mix(a,b,aCorner.x);
          p.xy += vec2(-axis.y,axis.x)*aCorner.y*.42;
          gl_Position = projectionMatrix*p;
          vUv=vec2(aCorner.x,aCorner.y);vColor=aColor;
        }`,
      fragmentShader: /* glsl */`
        varying vec2 vUv; varying vec3 vColor;
        void main(){
          float halo=exp(-vUv.y*vUv.y*5.);
          float core=exp(-vUv.y*vUv.y*110.);
          float ends=smoothstep(0.,.08,vUv.x)*(1.-smoothstep(.88,1.,vUv.x));
          gl_FragColor=vec4(vColor*(halo*2.+core*5.)+vec3(core*1.8),halo*ends);
        }`,
    });
    const lasers = new THREE.Mesh(this.boltGeometry, laserMaterial);
    lasers.frustumCulled = false; this.group.add(lasers);

    this.sparkGeometry = new THREE.BufferGeometry();
    this.sparkGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.sparkCount * 3),3).setUsage(THREE.DynamicDrawUsage));
    this.sparkGeometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.sparkCount * 3),3).setUsage(THREE.DynamicDrawUsage));
    this.sparkGeometry.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(this.sparkCount),1).setUsage(THREE.DynamicDrawUsage));
    this.sparkGeometry.setAttribute('aLife', new THREE.BufferAttribute(new Float32Array(this.sparkCount),1).setUsage(THREE.DynamicDrawUsage));
    for(let i=0;i<this.sparkCount;i++) this.sparks.push({life:0,maxLife:1,position:new THREE.Vector3(),velocity:new THREE.Vector3(),color:new THREE.Color(),size:0});
    const sparkMaterial = new THREE.ShaderMaterial({
      vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */`
        attribute float aSize,aLife; varying vec3 vColor; varying float vLife;
        void main(){
          vec4 mv=modelViewMatrix*vec4(position,1.);gl_Position=projectionMatrix*mv;
          gl_PointSize=clamp(aSize*650./max(1.,-mv.z),0.,100.);
          vColor=color;vLife=aLife;
        }`,
      fragmentShader: /* glsl */`
        varying vec3 vColor; varying float vLife;
        void main(){float d=length(gl_PointCoord-.5)*2.;
          float a=exp(-d*d*5.)*(1.-smoothstep(.75,1.,d))*vLife;
          gl_FragColor=vec4(vColor*(1.+2.*exp(-d*d*35.)),a);
        }`,
    });
    const particles = new THREE.Points(this.sparkGeometry,sparkMaterial);
    particles.frustumCulled = false; this.group.add(particles);
  }

  fire(from: THREE.Vector3, to: THREE.Vector3, color=0xff3820, speed=190) {
    const b = this.bolts[this.boltCursor++ % this.boltCount];
    b.active=true; b.position.copy(from); b.target.copy(to); b.direction.subVectors(to,from);
    b.remaining=b.direction.length(); b.direction.normalize(); b.color.set(color); b.speed=speed;
    b.length=clamp(speed*.045,3,21);
    this.emit(from,color,.2,4);
  }

  private emit(position: THREE.Vector3,color:number,scale:number,count:number) {
    for(let i=0;i<count;i++){
      const p=this.sparks[this.sparkCursor++ % this.sparkCount];
      p.position.copy(position); p.color.set(color);
      const a=this.rng()*Math.PI*2, z=this.rng()*2-1, r=Math.sqrt(1-z*z);
      p.velocity.set(Math.cos(a)*r,z,Math.sin(a)*r).multiplyScalar((3+this.rng()*19)*scale);
      p.maxLife=.18+this.rng()*.7; p.life=p.maxLife;
      p.size=(.22+this.rng()*.85)*scale;
      if(i<2){p.size=4.5*scale;p.velocity.multiplyScalar(.1);p.maxLife=.21;p.life=.21;}
    }
  }

  burst(position: THREE.Vector3,color=0xff8637,scale=1) { this.emit(position,color,scale,clamp(Math.floor(22+scale*5),20,110)); }

  update(dt:number,_time:number){
    const starts=this.boltGeometry.getAttribute('aStart') as THREE.BufferAttribute;
    const ends=this.boltGeometry.getAttribute('aEnd') as THREE.BufferAttribute;
    const colors=this.boltGeometry.getAttribute('aColor') as THREE.BufferAttribute;
    for(let i=0;i<this.boltCount;i++){
      const b=this.bolts[i];
      if(b.active){
        const step=dt*b.speed; b.remaining-=step;
        b.position.addScaledVector(b.direction,step);
        if(b.remaining<=0){b.active=false;this.burst(b.target,b.color.getHex(),.45);}
      }
      for(let k=0;k<4;k++){
        const id=i*4+k;
        if(b.active){
          starts.setXYZ(id,b.position.x-b.direction.x*b.length,b.position.y-b.direction.y*b.length,b.position.z-b.direction.z*b.length);
          ends.setXYZ(id,b.position.x,b.position.y,b.position.z);
          colors.setXYZ(id,b.color.r,b.color.g,b.color.b);
        } else { starts.setXYZ(id,0,0,0);ends.setXYZ(id,0,0,0);colors.setXYZ(id,0,0,0); }
      }
    }
    starts.needsUpdate=true;ends.needsUpdate=true;colors.needsUpdate=true;
    const pos=this.sparkGeometry.getAttribute('position') as THREE.BufferAttribute;
    const col=this.sparkGeometry.getAttribute('color') as THREE.BufferAttribute;
    const size=this.sparkGeometry.getAttribute('aSize') as THREE.BufferAttribute;
    const life=this.sparkGeometry.getAttribute('aLife') as THREE.BufferAttribute;
    for(let i=0;i<this.sparkCount;i++){
      const p=this.sparks[i];p.life=Math.max(0,p.life-dt);
      if(p.life>0){p.position.addScaledVector(p.velocity,dt);p.velocity.multiplyScalar(Math.exp(-dt*1.6));}
      pos.setXYZ(i,p.position.x,p.position.y,p.position.z);
      col.setXYZ(i,p.color.r,p.color.g,p.color.b);
      size.setX(i,p.life>0?p.size:0);life.setX(i,Math.pow(p.life/p.maxLife,.6));
    }
    pos.needsUpdate=true;col.needsUpdate=true;size.needsUpdate=true;life.needsUpdate=true;
  }
}

export function createDestruction(radius=300) {
  const group = new THREE.Group();
  const rng = random(113811);
  const coreUniforms = {
    uTime:{value:0},uAge:{value:0},uOpacity:{value:0},uHeat:{value:1},uDisplace:{value:.25},
  };
  const fireMaterial = new THREE.ShaderMaterial({
    uniforms:coreUniforms,transparent:true,depthWrite:false,side:THREE.FrontSide,
    vertexShader: /* glsl */`
      uniform float uTime,uAge,uDisplace;
      varying vec3 vP,vN,vView,vLocalCamera;
      ${noiseGLSL}
      void main(){
        vec3 p=position;
        float n=fbm(p*3.8+vec3(uTime*.13,-uTime*.18,uTime*.09));
        float ridge=noise3(p*5.+uAge*.13);
        p*=1.+(n-.38)*uDisplace+ridge*uDisplace*.08;
        vP=position;
        vec3 worldDelta=cameraPosition-modelMatrix[3].xyz;
        vLocalCamera=vec3(dot(worldDelta,modelMatrix[0].xyz)/dot(modelMatrix[0].xyz,modelMatrix[0].xyz),dot(worldDelta,modelMatrix[1].xyz)/dot(modelMatrix[1].xyz,modelMatrix[1].xyz),dot(worldDelta,modelMatrix[2].xyz)/dot(modelMatrix[2].xyz,modelMatrix[2].xyz));
        vec4 mv=modelViewMatrix*vec4(p,1.);
        vN=normalize(normalMatrix*normal);vView=normalize(-mv.xyz);
        gl_Position=projectionMatrix*mv;
      }`,
    fragmentShader: /* glsl */`
      uniform float uTime,uAge,uOpacity,uHeat;
      varying vec3 vP,vN,vView,vLocalCamera;
      ${noiseGLSL}
      void main(){
        vec3 ray=normalize(vP-vLocalCamera);
        vec3 drift=vec3(uAge*.095,-uAge*.14,uAge*.065);
        float jitter=hash31(vec3(gl_FragCoord.xy,1.731))*.14;
        vec3 p=vP+ray*jitter;
        vec3 emission=vec3(0.);float transmittance=1.;
        for(int i=0;i<14;i++){
          float r=length(p);
          vec3 q=p*5.5+drift;
          float coarse=noise3(q);
          float n=coarse*.56+noise3(q*2.03+7.3)*.29+noise3(q*4.17-drift)*.15;
          float shell=1.-smoothstep(.65,1.05,r+(coarse-.5)*.27);
          float density=smoothstep(.24,.72,n)*shell*2.6;
          float heat=(.13+(1.-r)*.43+n*.62)*uHeat;
          vec3 c=mix(vec3(.035,.016,.015),vec3(.8,.092,.009),smoothstep(.12,.48,heat));
          c=mix(c,vec3(2.1,.53,.045),smoothstep(.42,.73,heat));
          c=mix(c,vec3(3.1,1.58,.3),smoothstep(.68,.95,heat));
          // Dense outer convection cells absorb the core's light.
          float smoke=smoothstep(.5,.68,n)*smoothstep(.25,.9,r);
          c=mix(c,vec3(.048,.029,.025),smoke*(.62+(1.-min(1.,uHeat))*.24));
          float alpha=1.-exp(-density*.24);
          emission+=transmittance*alpha*c;
          transmittance*=1.-alpha;
          p+=ray*.145;
          if(transmittance<.025)break;
        }
        float opacity=(1.-transmittance)*uOpacity;
        if(opacity<.008)discard;
        gl_FragColor=vec4(emission/max(.001,1.-transmittance),opacity);
      }`,
  });
  const core = new THREE.Mesh(new THREE.SphereGeometry(1,112,80),fireMaterial);
  group.add(core);

  // Uneven billowing lobes retain a complex silhouette when the fireball fills the screen.
  const lobes = new THREE.Group(); group.add(lobes);
  const lobeGeo = new THREE.SphereGeometry(1,72,48);
  const lobeMaterial=fireMaterial.clone();
  lobeMaterial.uniforms=coreUniforms;
  lobeMaterial.fragmentShader=/* glsl */`
    uniform float uTime,uAge,uOpacity,uHeat;varying vec3 vP,vN,vView,vLocalCamera;
    ${noiseGLSL}
    void main(){
      float n=fbm(vP*4.5+vec3(uAge*.08,-uAge*.16,uAge*.07));
      float fine=noise3(vP*19.-uAge*.08);
      float facing=abs(dot(normalize(vN),normalize(vView)));
      float heat=smoothstep(.3,.72,n)*uHeat;
      vec3 c=mix(vec3(.041,.022,.023),vec3(.9,.14,.012),heat);
      c=mix(c,vec3(1.8,.58,.067),smoothstep(.52,1.,heat));
      c*=.6+fine*.55;
      float alpha=smoothstep(.08,.64,facing)*smoothstep(.36,.67,n)*.58*uOpacity;
      gl_FragColor=vec4(c,alpha);
    }`;
  const lobeSeeds:{mesh:THREE.Mesh;direction:THREE.Vector3;size:number;stretch:THREE.Vector3}[]=[];
  for(let i=0;i<16;i++){
    const z=rng()*2-1,a=rng()*Math.PI*2,r=Math.sqrt(1-z*z);
    const direction=new THREE.Vector3(Math.cos(a)*r,z,Math.sin(a)*r);
    const mesh=new THREE.Mesh(lobeGeo,lobeMaterial);mesh.rotation.set(rng()*6,rng()*6,rng()*6);
    lobes.add(mesh);lobeSeeds.push({mesh,direction,size:.18+rng()*.26,stretch:new THREE.Vector3(.75+rng()*.5,.8+rng()*.6,.8+rng()*.4)});
  }

  const coronaMaterial=new THREE.ShaderMaterial({
    uniforms:{uTime:{value:0},uOpacity:{value:0},uHeat:{value:1}},transparent:true,depthWrite:false,
    blending:THREE.AdditiveBlending,side:THREE.BackSide,
    vertexShader: /* glsl */`varying vec3 vN,vView,vP;void main(){vP=position;vec4 mv=modelViewMatrix*vec4(position,1.);vN=normalize(normalMatrix*normal);vView=normalize(-mv.xyz);gl_Position=projectionMatrix*mv;}`,
    fragmentShader: /* glsl */`
      varying vec3 vN,vView,vP;uniform float uTime,uOpacity,uHeat;
      ${noiseGLSL}
      void main(){float rim=pow(1.-abs(dot(normalize(vN),normalize(vView))),3.2);
        float n=fbm(vP*5.+uTime*.08);
        vec3 c=mix(vec3(.32,.027,.002),vec3(.85,.23,.025),uHeat);
        gl_FragColor=vec4(c,rim*uOpacity*(.2+n*.8));}
    `,
  });
  const corona=new THREE.Mesh(new THREE.SphereGeometry(1,64,40),coronaMaterial);group.add(corona);

  const shockMaterial=new THREE.ShaderMaterial({
    uniforms:{uTime:{value:0},uOpacity:{value:0},uProgress:{value:0}},transparent:true,depthWrite:false,
    blending:THREE.AdditiveBlending,side:THREE.DoubleSide,
    vertexShader:'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader: /* glsl */`
      varying vec2 vUv;uniform float uTime,uOpacity,uProgress;
      ${noiseGLSL}
      void main(){
        vec2 p=(vUv-.5)*2.;float r=length(p),a=atan(p.y,p.x);
        float n=fbm(vec3(p*14.,uTime*.17));
        float edge=.82+sin(a*13.+uTime*.2)*.002+n*.012;
        float d=abs(r-edge);
        float band=exp(-d*d*2700.);
        float razor=exp(-d*d*98000.);
        float inner=exp(-abs(r-.785)*65.)*(1.-smoothstep(.78,.83,r));
        float ripples=pow(.5+.5*sin(r*360.-n*5.),6.)*exp(-abs(r-.77)*26.)*.22;
        vec3 c=vec3(.13,.26,.5)*band+vec3(1.8,1.5,1.1)*razor;
        c+=vec3(.23,.37,.65)*(inner+ripples);
        gl_FragColor=vec4(c,clamp((band+razor+inner+ripples)*uOpacity,0.,1.));
      }`,
  });
  const shock=new THREE.Mesh(new THREE.PlaneGeometry(2,2),shockMaterial);
  shock.rotation.set(1.27,-.08,-.12);group.add(shock);
  const shock2=new THREE.Mesh(new THREE.PlaneGeometry(2,2),shockMaterial);
  shock2.rotation.set(1.29,-.08,-.12);group.add(shock2);

  const waveMaterial=new THREE.ShaderMaterial({
    uniforms:{uOpacity:{value:0},uTime:{value:0}},transparent:true,depthWrite:false,
    blending:THREE.AdditiveBlending,side:THREE.DoubleSide,
    vertexShader: /* glsl */`varying vec3 vN,vEye,vP;void main(){vP=position;vec4 p=modelViewMatrix*vec4(position,1.);vN=normalize(normalMatrix*normal);vEye=normalize(-p.xyz);gl_Position=projectionMatrix*p;}`,
    fragmentShader: /* glsl */`
      uniform float uOpacity,uTime;varying vec3 vN,vEye,vP;
      ${noiseGLSL}
      void main(){
        float rim=pow(1.-abs(dot(normalize(vN),normalize(vEye))),7.);
        float n=fbm(vP*18.+vec3(uTime*.07));
        gl_FragColor=vec4(vec3(.26,.47,.85)*(1.+n),rim*uOpacity*(.5+n));
      }`,
  });
  const wave=new THREE.Mesh(new THREE.SphereGeometry(1,72,48),waveMaterial);group.add(wave);

  const streakGeometry=new THREE.BufferGeometry();
  const streakCount=190,streakDirs=new Float32Array(streakCount*12),streakSeeds=new Float32Array(streakCount*12),streakCorners=new Float32Array(streakCount*8),streakIndices:number[]=[];
  for(let i=0;i<streakCount;i++){
    const z=rng()*2-1,a=rng()*Math.PI*2,r=Math.sqrt(1-z*z),seed=[rng(),rng(),rng()];
    for(let k=0;k<4;k++){streakDirs.set([Math.cos(a)*r,z,Math.sin(a)*r],i*12+k*3);streakSeeds.set(seed,i*12+k*3);}
    streakCorners.set([0,-1,1,-1,1,1,0,1],i*8);
    const k=i*4;streakIndices.push(k,k+1,k+2,k,k+2,k+3);
  }
  streakGeometry.setAttribute('position',new THREE.BufferAttribute(streakDirs,3));
  streakGeometry.setAttribute('aSeed',new THREE.BufferAttribute(streakSeeds,3));
  streakGeometry.setAttribute('aCorner',new THREE.BufferAttribute(streakCorners,2));
  streakGeometry.setIndex(streakIndices);
  const streakMaterial=new THREE.ShaderMaterial({
    uniforms:{uAge:{value:0},uRadius:{value:radius}},transparent:true,depthWrite:false,side:THREE.DoubleSide,blending:THREE.AdditiveBlending,
    vertexShader: /* glsl */`
      attribute vec3 aSeed;attribute vec2 aCorner;uniform float uAge,uRadius;
      varying vec2 vUv;varying float vOpacity,vHeat;
      void main(){
        float age=max(0.,uAge-6.7-aSeed.x*2.3);
        float speed=.14+aSeed.y*aSeed.y*.6;
        float head=uRadius*(.95+age*speed);
        float tail=max(uRadius*.8,head-uRadius*(.04+age*.045)*(1.+aSeed.z));
        vec4 a=modelViewMatrix*vec4(position*tail,1.);
        vec4 b=modelViewMatrix*vec4(position*head,1.);
        vec2 axis=normalize(b.xy-a.xy+vec2(.0001));
        vec4 p=mix(a,b,aCorner.x);
        p.xy+=vec2(-axis.y,axis.x)*aCorner.y*(.5+aSeed.z*1.6)*uRadius/300.;
        gl_Position=projectionMatrix*p;vUv=aCorner;
        vOpacity=smoothstep(0.,.3,age)*(1.-smoothstep(4.+aSeed.z*5.,15.+aSeed.z*7.,age));
        vHeat=1.-smoothstep(1.,16.,age);
      }`,
    fragmentShader: /* glsl */`
      varying vec2 vUv;varying float vOpacity,vHeat;
      void main(){
        float core=exp(-vUv.y*vUv.y*9.);
        float tail=pow(vUv.x,.8)*(1.-smoothstep(.94,1.,vUv.x));
        vec3 c=mix(vec3(1.,.08,.005),vec3(5.,2.2,.4),vHeat);
        gl_FragColor=vec4(c,core*tail*vOpacity);
      }`,
  });
  const streaks=new THREE.Mesh(streakGeometry,streakMaterial);streaks.frustumCulled=false;group.add(streaks);

  // GPU-driven debris is deterministic and costs one draw call for thousands of embers.
  const emberCount=3800;
  const emberGeometry=new THREE.BufferGeometry();
  const dirs=new Float32Array(emberCount*3),seeds=new Float32Array(emberCount*4);
  for(let i=0;i<emberCount;i++){
    const z=rng()*2-1,a=rng()*Math.PI*2,r=Math.sqrt(1-z*z);
    dirs.set([Math.cos(a)*r,z,Math.sin(a)*r],i*3);
    seeds.set([rng(),rng(),rng(),rng()],i*4);
  }
  emberGeometry.setAttribute('position',new THREE.BufferAttribute(dirs,3));
  emberGeometry.setAttribute('aSeed',new THREE.BufferAttribute(seeds,4));
  const emberMaterial=new THREE.ShaderMaterial({
    uniforms:{uAge:{value:0},uRadius:{value:radius},uOpacity:{value:0}},transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,
    vertexShader: /* glsl */`
      attribute vec4 aSeed;uniform float uAge,uRadius,uOpacity;varying float vHeat,vAlpha;
      void main(){
        float age=max(0.,uAge-5.5-aSeed.w*3.);
        float velocity=1.6+pow(aSeed.x,3.)*8.;
        float distance=uRadius*(.82+age*velocity*.26);
        vec3 p=position*distance;
        p+=vec3(sin(aSeed.z*36.+age*.1),cos(aSeed.z*41.+age*.2),sin(aSeed.y*37.))*age*uRadius*.009;
        vec4 mv=modelViewMatrix*vec4(p,1.);gl_Position=projectionMatrix*mv;
        float size=(.8+pow(aSeed.y,6.)*8.)*uRadius/300.;
        gl_PointSize=clamp(size*1100./max(1.,-mv.z),1.,32.);
        vHeat=clamp(1.-age/(8.+aSeed.z*20.),.06,1.);
        vAlpha=smoothstep(0.,.3,age)*uOpacity*(.3+aSeed.y*.7);
      }`,
    fragmentShader: /* glsl */`
      varying float vHeat,vAlpha;
      void main(){float r=length(gl_PointCoord-.5)*2.;
        float halo=exp(-r*r*5.)*(1.-smoothstep(.65,1.,r));
        vec3 c=mix(vec3(.7,.035,.004),vec3(5.,1.5,.2),vHeat);
        c=mix(c,vec3(8.,6.,2.5),pow(vHeat,8.));
        gl_FragColor=vec4(c,halo*vAlpha);
      }`,
  });
  const embers=new THREE.Points(emberGeometry,emberMaterial);embers.frustumCulled=false;group.add(embers);

  // Actual tumbling metal plates survive the flash and catch the receding light.
  const debrisMaterial=new THREE.MeshStandardMaterial({color:0x81746c,metalness:.8,roughness:.72,emissive:0xff3c06,emissiveIntensity:1});
  const debris=new THREE.InstancedMesh(new THREE.BoxGeometry(1,1,.17),debrisMaterial,280);
  debris.instanceMatrix.setUsage(THREE.DynamicDrawUsage);debris.frustumCulled=false;group.add(debris);
  const debrisSeeds:{dir:THREE.Vector3;speed:number;size:number;spin:THREE.Vector3;delay:number}[]=[];
  for(let i=0;i<280;i++){
    const z=rng()*2-1,a=rng()*Math.PI*2,r=Math.sqrt(1-z*z);
    debrisSeeds.push({dir:new THREE.Vector3(Math.cos(a)*r,z,Math.sin(a)*r),speed:.5+rng()*2.4,size:1+rng()*7,spin:new THREE.Vector3(rng()-.5,rng()-.5,rng()-.5),delay:rng()*3});
  }
  const dummy=new THREE.Object3D();
  const surfaceFlashes=new THREE.InstancedMesh(new THREE.SphereGeometry(1,12,8),new THREE.MeshBasicMaterial({color:0xffb551,transparent:true,blending:THREE.AdditiveBlending,depthWrite:false}),48);
  const flashSeeds:{dir:THREE.Vector3;delay:number;size:number}[]=[];
  for(let i=0;i<48;i++){
    const z=rng()*2-1,a=rng()*Math.PI*2,r=Math.sqrt(1-z*z);
    flashSeeds.push({dir:new THREE.Vector3(Math.cos(a)*r,z,Math.sin(a)*r),delay:rng()*7,size:4+rng()*15});
  }
  surfaceFlashes.frustumCulled=false;group.add(surfaceFlashes);
  const light=new THREE.PointLight(0xff9b3c,0,radius*22,1.3);group.add(light);

  return {
    group,
    update(elapsed:number,time:number){
      group.visible=elapsed>=0;
      if(elapsed<0)return;
      const e=elapsed;
      const ignition=smooth(e,3.6,8.3);
      const blast=smooth(e,7.3,13.5);
      const cooling=smooth(e,13,29);
      const expansion=radius*(.05+ignition*.8+blast*2.45+Math.max(0,e-13)*.09);
      core.visible=e>3.6;
      core.scale.set(expansion*(1+blast*.18),expansion*(1-blast*.08),expansion);
      core.rotation.set(e*.015,e*.024,e*.006);
      coreUniforms.uTime.value=time;
      coreUniforms.uAge.value=e;
      coreUniforms.uOpacity.value=ignition*(1-smooth(e,25,34));
      coreUniforms.uHeat.value=(1-cooling*.92)*(1+Math.exp(-Math.pow((e-9.1)*.7,2))*.22);
      coreUniforms.uDisplace.value=.12+blast*.34;
      lobes.visible=e>6.5;
      for(const l of lobeSeeds){
        l.mesh.position.copy(l.direction).multiplyScalar(expansion*(.64+blast*.09));
        l.mesh.scale.copy(l.stretch).multiplyScalar(expansion*l.size*(.3+blast));
      }
      corona.visible=e>4;
      corona.scale.setScalar(expansion*1.14);
      coronaMaterial.uniforms.uTime.value=time;
      coronaMaterial.uniforms.uOpacity.value=ignition*(1-cooling)*.035;
      coronaMaterial.uniforms.uHeat.value=1-cooling;
      const shockAge=Math.max(0,e-9.6);
      const shockRadius=radius*(1.3+shockAge*1.7+shockAge*shockAge*.021);
      shock.visible=e>9.6;shock2.visible=e>9.9;
      shock.scale.setScalar(shockRadius);
      shock2.scale.setScalar(shockRadius*.925);
      shockMaterial.uniforms.uTime.value=time;
      shockMaterial.uniforms.uProgress.value=shockAge/15;
      shockMaterial.uniforms.uOpacity.value=smooth(shockAge,0,.6)*(1-smooth(shockAge,12,24));
      wave.visible=e>9.6;
      wave.scale.setScalar(radius*(1.2+shockAge*1.15));
      waveMaterial.uniforms.uTime.value=time;
      waveMaterial.uniforms.uOpacity.value=smooth(shockAge,0,.4)*(1-smooth(shockAge,8,16))*.022;
      streakMaterial.uniforms.uAge.value=e;
      emberMaterial.uniforms.uAge.value=e;
      emberMaterial.uniforms.uOpacity.value=smooth(e,5,9)*(1-smooth(e,27,38));
      debris.visible=e>5.5;
      debrisMaterial.emissiveIntensity=(1-smooth(e,9,24))*2;
      for(let i=0;i<debrisSeeds.length;i++){
        const d=debrisSeeds[i],age=Math.max(0,e-5.5-d.delay);
        dummy.position.copy(d.dir).multiplyScalar(radius*(.92+age*d.speed*.2));
        dummy.rotation.set(d.spin.x*age,d.spin.y*age,d.spin.z*age);
        dummy.scale.setScalar(age>0?d.size*(radius/300):0);
        dummy.updateMatrix();debris.setMatrixAt(i,dummy.matrix);
      }
      debris.instanceMatrix.needsUpdate=true;
      surfaceFlashes.visible=e<10;
      for(let i=0;i<flashSeeds.length;i++){
        const f=flashSeeds[i],age=e-f.delay;
        const size=age>0&&age<1.3?Math.sin(age/1.3*Math.PI)*f.size*(radius/300):0;
        dummy.position.copy(f.dir).multiplyScalar(radius*1.008);
        dummy.scale.setScalar(size);dummy.rotation.set(0,0,0);dummy.updateMatrix();surfaceFlashes.setMatrixAt(i,dummy.matrix);
      }
      surfaceFlashes.instanceMatrix.needsUpdate=true;
      light.intensity=ignition*(1-cooling)*radius*9;
      light.color.setRGB(1,.32+(1-cooling)*.22,.055+(1-cooling)*.13);
    },
  };
}
