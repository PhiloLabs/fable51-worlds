import * as THREE from 'three';

/** All coordinates are in metres. Environment meshes share materials and geometry. */
function random(seed: number) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let n = Math.imul(seed ^ seed >>> 15, 1 | seed); n ^= n + Math.imul(n ^ n >>> 7, 61 | n); return ((n ^ n >>> 14) >>> 0) / 4294967296; };
}

const box = new THREE.BoxGeometry(1, 1, 1);
const cylinder = new THREE.CylinderGeometry(1, 1, 1, 8);
const dummy = new THREE.Object3D();
const color = new THREE.Color();

type Instance = { p: number[]; s: number[]; r?: number[]; order?: THREE.EulerOrder; c?: number };
function instances(items: Instance[], material: THREE.Material, geometry: THREE.BufferGeometry = box) {
  const mesh = new THREE.InstancedMesh(geometry, material, items.length);
  items.forEach((item, i) => {
    dummy.position.set(item.p[0], item.p[1], item.p[2]);
    dummy.scale.set(item.s[0], item.s[1], item.s[2]);
    dummy.rotation.set(item.r?.[0] || 0, item.r?.[1] || 0, item.r?.[2] || 0, item.order || 'XYZ');
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    if (item.c !== undefined) mesh.setColorAt(i, color.setHex(item.c));
  });
  mesh.computeBoundingSphere();
  return mesh;
}

const surfaceVertex = `
varying vec2 vUV;
varying vec3 vLocal;
varying vec3 vNormal;
varying vec3 vWorld;
uniform float uFailure;
void main() {
  vUV=uv; vLocal=position; vNormal=normalize(mat3(modelMatrix)*normal);
  vec3 p=position;
  float h=fract(sin(dot(floor(normal*100.),vec3(41.7,173.3,23.5)))*43758.5453);
  p += normal * pow(max(0.,uFailure-.62)*2.63,2.)*h*length(position)*.09;
  vec4 world=modelMatrix*vec4(p,1.); vWorld=world.xyz;
  gl_Position=projectionMatrix*viewMatrix*world;
}`;

const surfaceFragment = `
precision highp float;
varying vec2 vUV;
varying vec3 vLocal;
varying vec3 vNormal;
varying vec3 vWorld;
uniform vec3 uDish;
uniform float uTime;
uniform float uFailure;
uniform float uRadius;
float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453123); }
float line(float a,float width){ return 1.-smoothstep(width,width+fwidth(a)*1.2,min(fract(a),1.-fract(a))); }
float noise(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);float n=dot(i,vec3(1.,57.,113.));return mix(mix(mix(fract(sin(n)*43758.5453),fract(sin(n+1.)*43758.5453),f.x),mix(fract(sin(n+57.)*43758.5453),fract(sin(n+58.)*43758.5453),f.x),f.y),mix(mix(fract(sin(n+113.)*43758.5453),fract(sin(n+114.)*43758.5453),f.x),mix(fract(sin(n+170.)*43758.5453),fract(sin(n+171.)*43758.5453),f.x),f.y),f.z);}
void main(){
  vec3 n=normalize(vNormal), localN=normalize(vLocal);
  if(dot(localN,uDish)>.9715) discard;
  if(abs(localN.y)<.009) discard;
  float lat=vUV.y;
  float row=floor(lat*112.);
  vec2 grid=vec2(vUV.x*256.,lat*112.);
  grid.x+=hash(vec2(row,2.))*3.;
  vec2 id=floor(grid), cell=fract(grid);
  float panel=hash(id);
  float fine=line(grid.x,.045)+line(grid.y,.04);
  vec2 sector=vec2(vUV.x*31.+floor(lat*19.)*.371,lat*19.);
  float sectorID=hash(floor(sector));
  float macroRow=line(sector.y,.017);
  float macroCol=line(sector.x,.013);
  float channels=step(.88,hash(vec2(floor(grid.x/2.),floor(grid.y/5.))))*step(cell.x,.22);
  float band=1.-smoothstep(.015,.048,abs(localN.y));
  vec3 steel=mix(vec3(.26,.275,.29),vec3(.32,.335,.35),panel);
  // Broad, irregular assembly regions carry the form; the tiny grid stays subordinate.
  steel*=mix(.76,1.02,smoothstep(.10,.64,sectorID));
  float serviceRegion=step(.81,hash(floor(vec2(vUV.x*58.+floor(lat*10.)*.7,lat*10.))));
  steel*=1.-serviceRegion*.14;
  steel*=1.-clamp(fine*.13+macroRow*.48+macroCol*.27+channels*.24,0.,.74);
  steel*=1.-band*.66;
  float subPanel=hash(floor(grid*vec2(3.,2.)));
  steel*=.94+.08*subPanel;
  vec3 sun=normalize(vec3(-1.,.45,.28));
  float diffuse=max(dot(n,sun),0.);
  float rim=pow(1.-max(dot(n,normalize(cameraPosition-vWorld)),0.),3.5);
  vec3 light=vec3(.017,.025,.04)+vec3(1.32,1.27,1.16)*diffuse;
  float spec=pow(max(dot(reflect(-sun,n),normalize(cameraPosition-vWorld)),0.),38.)*.035;
  vec3 result=steel*light+vec3(spec)+vec3(.065,.10,.16)*rim*.08;
  // Windows are sparse, grouped into believable little inhabited strips.
  vec2 tiny=grid*vec2(6.,3.);
  float windows=step(.996,hash(floor(tiny)))*step(.30,fract(tiny.x))*step(fract(tiny.x),.66)*step(.40,fract(tiny.y))*step(fract(tiny.y),.61);
  result+=windows*vec3(.12,.18,.25)*(.8+.2*sin(uTime*.8+panel*80.));
  float fractures=noise(localN*42.)*.65+noise(localN*103.)*.35;
  float crack=1.-smoothstep(.014,.033,abs(fractures-.50));
  float ignition=smoothstep(.15,.8,uFailure)*smoothstep(.56-uFailure*.47,.70-uFailure*.38,noise(localN*5.8+uTime*.08));
  result+=crack*ignition*vec3(12.,2.1,.15)*(1.+sin(uTime*15.+panel*20.)*.2);
  result=mix(result,vec3(.025,.017,.018),smoothstep(.79,1.,uFailure)*.62);
  gl_FragColor=vec4(result,1.);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/** Lighting shared by the orbital hardware, with the same planetary terminator. */
function stationMetal(base: number, sphericalShadow = false) {
  return new THREE.ShaderMaterial({
    uniforms: {uColor:{value:new THREE.Color(base)},uSpherical:{value:sphericalShadow?1:0}},
    vertexShader:`varying vec3 vN;varying vec3 vRadial;varying vec3 vW;varying vec3 vTint;varying vec2 vUV;
      void main(){vec4 p=vec4(position,1.);vec3 n=normal;vTint=vec3(1.);vUV=uv;
      #ifdef USE_INSTANCING
        p=instanceMatrix*p;n=mat3(instanceMatrix)*n;
      #endif
      #ifdef USE_INSTANCING_COLOR
        vTint=instanceColor;
      #endif
      vN=normalize(mat3(modelMatrix)*n);vRadial=normalize(mat3(modelMatrix)*p.xyz);vec4 w=modelMatrix*p;vW=w.xyz;gl_Position=projectionMatrix*viewMatrix*w;}`,
    fragmentShader:`uniform vec3 uColor;uniform float uSpherical;varying vec3 vN;varying vec3 vRadial;varying vec3 vW;varying vec3 vTint;varying vec2 vUV;
      void main(){vec3 sun=normalize(vec3(-1.,.45,.28));vec3 n=normalize(vN);
      float shadow=mix(1.,smoothstep(-.07,.08,dot(normalize(vRadial),sun)),uSpherical);
      float diffuse=max(dot(n,sun),0.)*shadow;
      float spec=pow(max(dot(reflect(-sun,n),normalize(cameraPosition-vW)),0.),24.)*.06*shadow;
      vec3 albedo=uColor*mix(vec3(1.),vTint,.45);
      vec3 col=albedo*(vec3(.025,.034,.049)+vec3(1.35,1.28,1.16)*diffuse)+spec;
      gl_FragColor=vec4(col,1.);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      }`,
  });
}

function dishMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader:`varying vec2 vUV;varying vec3 vN;void main(){vUV=uv;vN=normalize(mat3(modelMatrix)*normal);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
    fragmentShader:`varying vec2 vUV;varying vec3 vN;
    float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
    void main(){vec3 sun=normalize(vec3(-1.,.45,.28));float diffuse=max(dot(normalize(vN),sun),0.);
      float r=vUV.y;float occlusion=mix(.13,1.,pow(r,.72));
      float circular=1.-smoothstep(.02,.08,min(fract(r*22.),1.-fract(r*22.)));
      float segments=hash(floor(vUV*vec2(48.,12.)));
      float seams=1.-smoothstep(.014,.06,min(fract(vUV.x*48.),1.-fract(vUV.x*48.)));
      vec3 steel=vec3(.20,.22,.245)*(.8+segments*.18)*(1.-circular*.34-seams*.25);
      vec3 light=vec3(.045,.052,.065)+vec3(1.50,1.39,1.20)*diffuse;
      gl_FragColor=vec4(steel*light*occlusion,1.);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
  });
}

/** A kilometre-scale spherical station with a genuine aperture and concave dish. */
export function createDeathStar(radius = 300) {
  const group = new THREE.Group();
  group.name = 'DEATH STAR / orbital battle station';
  const dishDirection = new THREE.Vector3(-.31, .29, .905).normalize();
  const uniforms = {
    uTime: { value: 0 }, uFailure: { value: 0 }, uDish: { value: dishDirection }, uRadius: { value: radius },
  };
  const shellMaterial = new THREE.ShaderMaterial({ uniforms, vertexShader: surfaceVertex, fragmentShader: surfaceFragment });
  const shell = new THREE.Mesh(new THREE.SphereGeometry(radius, 192, 128), shellMaterial);
  group.add(shell);

  const steel = stationMetal(0x889098);
  const dark = stationMetal(0x303943,true);
  const deep = new THREE.MeshStandardMaterial({ color: 0x080f18, metalness: .6, roughness: .78 });
  const machinery = stationMetal(0x959ea5,true);
  const dishMachinery = stationMetal(0x737b83);
  const equator = new THREE.Mesh(new THREE.CylinderGeometry(radius * .985, radius * .985, radius * .021, 256, 1, true), dark);
  group.add(equator);
  const grooves: Instance[] = [];
  const rng = random(7018);
  for (let i = 0; i < 850; i++) {
    const angle = i / 850 * Math.PI * 2;
    const r = radius * (.985 + rng() * .008);
    grooves.push({ p: [Math.cos(angle)*r, (rng()-.5)*radius*.015, Math.sin(angle)*r], s: [radius*.004, radius*(.001+rng()*.003), radius*.006], r: [0, -angle, 0], c: i%9===0?0x7b858a:0x37414b });
  }
  group.add(instances(grooves, machinery));
  for (const y of [-1, 1]) {
    const rim = new THREE.Mesh(new THREE.TorusGeometry(radius*.99991, radius*.0008, 4, 256), machinery);
    rim.rotation.x = Math.PI / 2; rim.position.y = y * radius*.0105; group.add(rim);
  }

  const dish = new THREE.Group();
  dish.name = 'Recessed superlaser focus array';
  dish.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,1), dishDirection);
  const dishRadius = radius*Math.sqrt(1-.9715*.9715);
  dish.position.copy(dishDirection).multiplyScalar(radius*.9715);
  const dishDepth = radius*.071;
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [], indices: number[] = [];
  const rings = 22, sides = 96;
  for (let j=0; j<=rings; j++) {
    const t=j/rings, r=t*dishRadius;
    for (let k=0;k<=sides;k++) {
      const a=k/sides*Math.PI*2;
      positions.push(Math.cos(a)*r,Math.sin(a)*r,-dishDepth*(1-t*t));
      const norm=new THREE.Vector3(-2*dishDepth*r/dishRadius**2*Math.cos(a),-2*dishDepth*r/dishRadius**2*Math.sin(a),1).normalize();
      normals.push(norm.x,norm.y,norm.z); uvs.push(k/sides,t);
      if(j<rings&&k<sides){const i=j*(sides+1)+k;indices.push(i,i+sides+2,i+1,i,i+sides+1,i+sides+2);}
    }
  }
  const bowlGeometry=new THREE.BufferGeometry();
  bowlGeometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  bowlGeometry.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3));
  bowlGeometry.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2)); bowlGeometry.setIndex(indices);
  dish.add(new THREE.Mesh(bowlGeometry,dishMaterial()));
  for(let i=0;i<7;i++){
    const t=.18+i*.133;
    const ring=new THREE.Mesh(new THREE.TorusGeometry(dishRadius*t,radius*(i===6?.003:.0009),6,96),i===6?steel:dishMachinery);
    ring.position.z=-dishDepth*(1-t*t)+radius*.001; dish.add(ring);
  }
  const rim=new THREE.Mesh(new THREE.TorusGeometry(dishRadius,radius*.0024,8,128),steel); dish.add(rim);
  const radial:Instance[]=[];
  for(let k=0;k<48;k++){
    const angle=k/48*Math.PI*2;
    for(let j=0;j<8;j++){
      const t=.16+(j+.5)*.10, r=t*dishRadius;
      const dz=2*dishDepth*t/dishRadius;
      radial.push({p:[Math.cos(angle)*r,Math.sin(angle)*r,-dishDepth*(1-t*t)+radius*.001],s:[dishRadius*.105*Math.sqrt(1+dz*dz),radius*(k%6===0?.0025:.0008),radius*.0018],r:[0,-Math.atan(dz),angle],order:'ZYX'});
    }
  }
  dish.add(instances(radial,dishMachinery));
  const centre=new THREE.Mesh(new THREE.CylinderGeometry(radius*.020,radius*.026,radius*.013,32),deep);
  centre.rotation.x=Math.PI/2; centre.position.z=-dishDepth+radius*.005; dish.add(centre);
  const focusRing=new THREE.Mesh(new THREE.TorusGeometry(radius*.026,radius*.002,6,48),steel);
  focusRing.position.z=-dishDepth+radius*.012; dish.add(focusRing);
  group.add(dish);

  // Real silhouette-breaking hardware is only a handful of draw calls.
  const greebles=new THREE.InstancedMesh(box,machinery,4200);
  let used=0;
  for(let i=0;i<4700&&used<4200;i++){
    const y=rng()*1.97-.985, a=rng()*Math.PI*2, s=Math.sqrt(1-y*y);
    const n=new THREE.Vector3(Math.cos(a)*s,y,Math.sin(a)*s);
    if(n.dot(dishDirection)>.968 || Math.abs(y)<.016) continue;
    const h=radius*(.0005+rng()**3*.006);
    dummy.position.copy(n).multiplyScalar(radius+h*.5);
    dummy.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),n);
    dummy.rotateY(rng()>.5?0:Math.PI/2);
    dummy.scale.set(radius*(.001+rng()*.006),h,radius*(.002+rng()*.009)); dummy.updateMatrix();
    greebles.setMatrixAt(used,dummy.matrix);
    greebles.setColorAt(used,color.setHSL(.57,.04,.26+rng()*.2)); used++;
  }
  greebles.count=used;greebles.computeBoundingSphere();group.add(greebles);
  const surfaceMeshes=[shell,dish,equator,greebles];
  return {
    group,
    update(time:number,destruction:number){
      uniforms.uTime.value=time; uniforms.uFailure.value=THREE.MathUtils.clamp(destruction,0,1);
      // The final burst is handled by VFX; the physical crust remains during failure.
      const show=destruction<.94;
      for(const mesh of surfaceMeshes)mesh.visible=show;
      // Scene visibility belongs to the camera director; never re-enable a hidden station here.
    },
  };
}

function buildTurret(material: THREE.Material, dark: THREE.Material) {
  const group = new THREE.Group(); group.name='Tracking turbolaser';
  const base=new THREE.Mesh(new THREE.CylinderGeometry(2.0,2.9,2.1,12),dark); base.position.y=1.05;group.add(base);
  const yaw=new THREE.Group();yaw.position.y=2.2;group.add(yaw);
  const body=new THREE.Mesh(box,material);body.scale.set(3.7,2.1,3.7);yaw.add(body);
  const head=new THREE.Group();head.position.set(0,.5,1);yaw.add(head);
  for(const x of [-1.0,1.0]){
    const barrel=new THREE.Mesh(cylinder,material);barrel.rotation.x=Math.PI/2;barrel.position.set(x,0,3.2);barrel.scale.set(.23,6.6,.23);head.add(barrel);
    const jacket=new THREE.Mesh(cylinder,dark);jacket.rotation.x=Math.PI/2;jacket.position.set(x,0,1.1);jacket.scale.set(.45,2.9,.45);head.add(jacket);
  }
  const muzzle=new THREE.Object3D();muzzle.position.set(-1,0,6.5);head.add(muzzle);
  group.userData.yaw=yaw;group.userData.head=head;group.userData.muzzle=muzzle;
  return group;
}

/** Pooled 1.5 km trench. Travel is cumulative; the starfighter remains near z=0. */
export function createTrench() {
  const group=new THREE.Group(); group.name='Meridian trench / modular surface';
  const alloy=new THREE.MeshStandardMaterial({color:0x717984,roughness:.77,metalness:.63});
  const dark=new THREE.MeshStandardMaterial({color:0x242e3a,roughness:.86,metalness:.60});
  const foundation=dark.clone();
  foundation.onBeforeCompile=shader=>{
    shader.vertexShader='varying vec3 vMechanicalPosition;varying vec3 vMechanicalNormal;\n'+shader.vertexShader;
    shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>',`#include <begin_vertex>
      vec4 mechanicalPosition=vec4(transformed,1.);vec3 mechanicalNormal=normal;
      #ifdef USE_INSTANCING
        mechanicalPosition=instanceMatrix*mechanicalPosition;mechanicalNormal=mat3(instanceMatrix)*mechanicalNormal;
      #endif
      vMechanicalPosition=mechanicalPosition.xyz;vMechanicalNormal=normalize(mechanicalNormal);`);
    shader.fragmentShader='varying vec3 vMechanicalPosition;varying vec3 vMechanicalNormal;\n'+shader.fragmentShader;
    shader.fragmentShader=shader.fragmentShader.replace('#include <map_fragment>',`#include <map_fragment>
      vec2 floorGrid=vMechanicalPosition.xz/vec2(5.5,9.);
      vec2 panelCell=fract(floorGrid),edge=min(panelCell,1.-panelCell);
      float panelHash=fract(sin(dot(floor(floorGrid),vec2(12.9898,78.233)))*43758.5453);
      vec2 panelAA=fwidth(floorGrid)*1.15;
      float seams=1.-smoothstep(.012,.012+panelAA.x,edge.x);
      seams=max(seams,1.-smoothstep(.012,.012+panelAA.y,edge.y));
      float ventArea=step(.84,panelHash)*step(.15,panelCell.x)*step(panelCell.x,.85)*step(.16,panelCell.y)*step(panelCell.y,.84);
      float grate=step(.3,fract(panelCell.y*18.));
      float flooring=(.73+panelHash*.34)*(1.-seams*.70)*(1.-ventArea*(.37+grate*.37));
      float upperFace=smoothstep(.65,.95,vMechanicalNormal.y);
      diffuseColor.rgb*=mix(.96,flooring,upperFace);`);
  };
  foundation.customProgramCacheKey=()=> 'mechanical-foundation-v1';
  const piping=new THREE.MeshStandardMaterial({color:0x86909a,roughness:.48,metalness:.88});
  const lamps=new THREE.MeshStandardMaterial({color:0x96ccff,emissive:0x71b7fa,emissiveIntensity:2.6,toneMapped:false});
  const amber=new THREE.MeshStandardMaterial({color:0xffba72,emissive:0xff751e,emissiveIntensity:2.8,toneMapped:false});
  const segmentLength=108,segmentCount=15;
  const modules:THREE.Group[]=[];
  const turrets:THREE.Group[]=[];
  const obstacles:{position:THREE.Vector3,radius:number}[]=[];
  const obstacleBindings:{item:{position:THREE.Vector3,radius:number};module:THREE.Group;local:THREE.Vector3}[]=[];
  const moving:THREE.Object3D[]=[];
  for(let index=0;index<segmentCount;index++){
    const rng=random(312+index*751);
    const module=new THREE.Group();module.name=`Trench module ${index+1}`;modules.push(module);group.add(module);
    const shells:Instance[]=[
      {p:[0,-17,0],s:[70,4,segmentLength]},
      {p:[-47,7,0],s:[26,44,segmentLength]},
      {p:[47,7,0],s:[26,44,segmentLength]},
      {p:[-127,27,0],s:[160,4,segmentLength]},
      {p:[127,27,0],s:[160,4,segmentLength]},
    ];
    module.add(instances(shells,foundation));
    const detail:Instance[]=[],recesses:Instance[]=[],pipes:Instance[]=[],light:Instance[]=[],warning:Instance[]=[];
    for(const side of [-1,1]){
      // Large stepped wall plates, inset service panels, then fine raised greebles.
      for(let col=0;col<12;col++){
        const z=-49.5+col*9;
        for(let row=0;row<5;row++){
          const y=-10+row*8;
          const protrusion=.3+rng()*1.9;
          detail.push({p:[side*(33.9-protrusion*.5),y,z],s:[protrusion,7.5,8.5],c:rng()>.45?0x69737e:0x475563});
          if(rng()>.33)recesses.push({p:[side*(33.2-protrusion),y+.5,z+1],s:[.28,3.5,5.1],c:0x18222e});
          for(let j=0;j<3;j++){
            const width=.25+rng()*.65,height=.4+rng()*2.4,depth=.8+rng()*4;
            detail.push({p:[side*(32.9-protrusion),y-2+rng()*4,z-2+rng()*4],s:[width,height,depth],c:0x71808d});
          }
          if(rng()>.84)light.push({p:[side*(32.4-protrusion),y+2.8,z],s:[.12,.14,3.3]});
        }
        // Flush strips on the trench bed, with longitudinal mechanical channels.
        detail.push({p:[0,-14.85,z],s:[65,.28,.7],c:0x65727e});
        recesses.push({p:[side*19,-14.66,z],s:[6,.36,8.0],c:0x17212d});
        for(let k=0;k<4;k++)detail.push({p:[side*(17.3+k*1.05),-14.35,z],s:[.32,.32,6.8],c:0x6b7782});
        if(col%3===index%3){
          recesses.push({p:[side*8.5,-14.86,z],s:[5.3,.18,6.7],c:0x101924});
          for(let slat=0;slat<8;slat++)detail.push({p:[side*8.5,-14.7,z-2.8+slat*.8],s:[4.9,.18,.17],c:0x414d59});
          for(const offset of [-2.65,2.65])detail.push({p:[side*8.5+offset,-14.66,z],s:[.14,.22,6.9],c:0x596875});
        }
      }
      for(let p=0;p<7;p++){
        const y=-12+p*6.2;
        pipes.push({p:[side*(31.5-rng()*.65),y,0],s:[p%3===0?.40:.18,segmentLength,p%3===0?.40:.18],r:[Math.PI/2,0,0]});
        for(let z=-45;z<=45;z+=18)detail.push({p:[side*31.5,y,z],s:[1.1,1.2,.35],c:0x414e5b});
      }
      // Above the canyon: dense irregular city-scale mechanical surface.
      for(let i=0;i<58;i++){
        const x=side*(40+rng()*152),z=(rng()-.5)*segmentLength;
        const height=1.5+rng()**3*30,width=3+rng()*13,depth=3+rng()*16;
        detail.push({p:[x,29+height*.5,z],s:[width,height,depth],c:rng()>.5?0x465360:0x65727c});
        if(i%3===0){
          detail.push({p:[x,29+height+1,z],s:[width*.69,2,depth*.7],c:0x7e878d});
          recesses.push({p:[x,30+height+1.1,z],s:[width*.5,.25,depth*.46],c:0x1c2732});
        }
        if(i%9===0){pipes.push({p:[x,29+height+5,z],s:[.12,10,.12]});warning.push({p:[x,39+height,z],s:[.35,.45,.35]});}
      }
      // Floor-mounted technical equipment remains outside the central flight corridor.
      for(let i=0;i<3;i++){
        const x=side*(23+rng()*4),z=-35+i*34,height=4+rng()*5;
        detail.push({p:[x,-15+height*.5,z],s:[5,height,8],c:0x717982});
        for(let vent=0;vent<5;vent++)recesses.push({p:[x-side*2.55,-13.8+vent*.65,z],s:[.18,.25,6],c:0x131e29});
        const local=new THREE.Vector3(x,-15+height*.5,z),item={position:local.clone(),radius:4};obstacles.push(item);obstacleBindings.push({item,module,local});
      }
      warning.push({p:[side*31.0,-5,-32],s:[.25,.4,2.5]});
      light.push({p:[side*32,26,0],s:[.2,.3,31]});
    }
    // Ribbed mechanical bridges cast a strong overhead silhouette.
    if(index%3===1){
      const z=-13+rng()*26;
      detail.push({p:[0,21,z],s:[70,4.5,8],c:0x55616c});
      recesses.push({p:[0,18.4,z],s:[62,.7,6.2],c:0x17232f});
      for(let i=-4;i<=4;i++)detail.push({p:[i*7,17.8,z],s:[.9,2,7.8],c:0x79838a});
      for(const x of [-27,27])detail.push({p:[x,11,z],s:[4,17,6],c:0x53616e});
      warning.push({p:[0,18,z+4.1],s:[16,.45,.12]});
      const local=new THREE.Vector3(0,21,z),item={position:local.clone(),radius:5};obstacles.push(item);obstacleBindings.push({item,module,local});
    }
    if(index%2===0){
      const side=index%4===0?-1:1;
      const turret=buildTurret(alloy,dark);turret.position.set(side*31,29,8);module.add(turret);turrets.push(turret);
      const rotor=new THREE.Mesh(new THREE.TorusGeometry(2,.16,5,24),piping);rotor.rotation.y=Math.PI/2;rotor.position.set(-side*31.2,8,-22);module.add(rotor);moving.push(rotor);
    }
    module.add(instances(detail,alloy),instances(recesses,dark),instances(pipes,piping,cylinder),instances(light,lamps),instances(warning,amber));
  }

  const port=new THREE.Group();port.name='Thermal exhaust port / target';port.position.set(0,-4,-700);port.visible=false;
  const backing=new THREE.Mesh(box,alloy);backing.scale.set(18,18,2);backing.position.z=-2;port.add(backing);
  const inner=new THREE.Mesh(new THREE.CircleGeometry(4.25,64),new THREE.MeshBasicMaterial({color:0x010308}));inner.position.z=-.5;port.add(inner);
  for(const [r,w,z] of [[4.5,.45,0],[5.45,.22,-.2],[7.35,.16,-.7]]){
    const ring=new THREE.Mesh(new THREE.TorusGeometry(r,w,8,64),piping);ring.position.z=z;port.add(ring);
  }
  const portPieces:Instance[]=[],portLights:Instance[]=[];
  // The exhaust housing is bolted to the floor rather than floating in the lane.
  portPieces.push({p:[0,-10.25,-2],s:[20,1.5,8],c:0x45515f});
  for(const side of [-1,1])portPieces.push({p:[side*7.5,-9,-2],s:[2,3.5,5],c:0x697683});
  for(let i=0;i<16;i++){
    const a=i/16*Math.PI*2;
    portPieces.push({p:[Math.cos(a)*6.35,Math.sin(a)*6.35,-.5],s:[1.6,.75,.5],r:[0,0,a],c:0x3e4b58});
    if(i%2===0)portLights.push({p:[Math.cos(a)*5,Math.sin(a)*5,.3],s:[.48,.18,.18],r:[0,0,a]});
  }
  port.add(instances(portPieces,alloy),instances(portLights,amber));group.add(port);
  const turretWorld=new THREE.Vector3();
  const total=segmentLength*segmentCount;
  return {
    group,port,turrets,obstacles,
    update(time:number,travel:number,player:THREE.Vector3){
      modules.forEach((module,index)=>{
        module.position.z=((index*segmentLength+travel)%total+total)%total-total+segmentLength*1.3;
      });
      for(const binding of obstacleBindings)binding.item.position.copy(binding.local).add(binding.module.position);
      group.updateMatrixWorld(true);
      for(const turret of turrets){
        turret.getWorldPosition(turretWorld);
        const dx=player.x-turretWorld.x,dy=player.y-turretWorld.y,dz=player.z-turretWorld.z;
        const yaw=turret.userData.yaw as THREE.Group,head=turret.userData.head as THREE.Group;
        yaw.rotation.y=Math.atan2(dx,dz);
        head.rotation.x=-Math.atan2(dy,Math.sqrt(dx*dx+dz*dz));
      }
      for(const rotor of moving)rotor.rotation.z=time*.72;
      amber.emissiveIntensity=2.5+Math.sin(time*3.5)*.35;
    },
  };
}
