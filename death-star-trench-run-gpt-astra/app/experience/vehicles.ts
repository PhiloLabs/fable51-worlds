import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** All ships use local −Z as their forward axis. Static detail is material-batched. */
type Palette = Record<string, THREE.Material>;
let materials: Palette | undefined;
const V = THREE.Vector3;

function palette(): Palette {
  if (materials) return materials;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 512;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#bcbdb8'; ctx.fillRect(0, 0, 512, 512);
  let seed = 8103;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < 34000; i++) {
    const n = 130 + random() * 100;
    ctx.fillStyle = `rgba(${n},${n},${n},${random() * .16})`;
    ctx.fillRect(random() * 512, random() * 512, 1 + random() * 5, 1);
  }
  for (let y = 0; y < 512; y += 64) {
    for (let x = 0; x < 512; x += 96) {
      ctx.strokeStyle = 'rgba(35,41,44,.30)'; ctx.lineWidth = 1;
      ctx.strokeRect(x + 3, y + 3, 86, 55);
      ctx.fillStyle = `rgba(36,29,25,${random() * .1})`; ctx.fillRect(x + 6, y + 8, 82, 50);
      for (let k = 0; k < 5; k++) {
        const sx = x + random() * 80;
        ctx.fillStyle = 'rgba(30,35,38,.25)'; ctx.fillRect(sx, y + 3, 1, random() * 20);
      }
    }
  }
  const skin = new THREE.CanvasTexture(canvas);
  skin.colorSpace = THREE.SRGBColorSpace;
  skin.wrapS = skin.wrapT = THREE.RepeatWrapping;
  skin.anisotropy = 4;
  const paint = new THREE.MeshStandardMaterial({ color: 0xbec5c8, map: skin, roughness: .63, metalness: .54 });
  const red = new THREE.MeshStandardMaterial({ color: 0x943b2f, map: skin, roughness: .68, metalness: .4 });
  const metal = new THREE.MeshStandardMaterial({ color: 0x727b80, roughness: .39, metalness: .86 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x20282b, roughness: .56, metalness: .72 });
  const black = new THREE.MeshStandardMaterial({ color: 0x080d12, roughness: .82, metalness: .3 });
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x102d3c, metalness: .6, roughness: .16, clearcoat: 1, clearcoatRoughness: .08 });
  const blue = new THREE.MeshStandardMaterial({ color: 0x5b8399, metalness: .7, roughness: .31 });
  const led = new THREE.MeshBasicMaterial({ color: new THREE.Color(0x8ae5ff).multiplyScalar(2), toneMapped: false });
  const solar = new THREE.MeshStandardMaterial({ color: 0x09121a, metalness: .35, roughness: .76, side: THREE.DoubleSide });
  materials = { paint, red, metal, dark, black, glass, blue, led, solar };
  return materials;
}

class Assembly {
  group = new THREE.Group();
  private parts = new Map<THREE.Material, THREE.BufferGeometry[]>();
  add(geometry: THREE.BufferGeometry, material: THREE.Material, position = new V(), rotation = new THREE.Euler(), scale = new V(1, 1, 1)) {
    const matrix = new THREE.Matrix4().compose(position, new THREE.Quaternion().setFromEuler(rotation), scale);
    const g = geometry.clone().applyMatrix4(matrix);
    // Every geometry has a UV set, so all procedural and primitive pieces merge safely.
    if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
    const list = this.parts.get(material) || [];
    list.push(g.index ? g.toNonIndexed() : g); this.parts.set(material, list);
    return this;
  }
  box(w: number, h: number, d: number, material: THREE.Material, x: number, y: number, z: number, rotation?: THREE.Euler) {
    return this.add(new THREE.BoxGeometry(w, h, d), material, new V(x, y, z), rotation);
  }
  cylinder(radius: number, length: number, material: THREE.Material, x: number, y: number, z: number, r2 = radius, radial = 12) {
    return this.add(new THREE.CylinderGeometry(r2, radius, length, radial), material, new V(x, y, z), new THREE.Euler(Math.PI / 2, 0, 0));
  }
  finish() {
    for (const [material, geos] of this.parts) {
      const geo = mergeGeometries(geos, false);
      if (!geo) continue;
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, material);
      mesh.castShadow = true; mesh.receiveShadow = true;
      this.group.add(mesh);
      geos.forEach(g => g.dispose());
    }
    this.parts.clear();
    return this.group;
  }
}

function beamBetween(a: THREE.Vector3, b: THREE.Vector3, radius: number) {
  const delta = b.clone().sub(a);
  const geometry = new THREE.CylinderGeometry(radius, radius, delta.length(), 6);
  geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new V(0, 1, 0), delta.normalize()));
  geometry.translate(...a.clone().add(b).multiplyScalar(.5).toArray());
  return geometry;
}

function sectionHull(sections: Array<[number, number, number, number]>) {
  const positions: number[] = [], uv: number[] = [], indices: number[] = [];
  const ring = [[-1, .22], [-.77, 1], [.77, 1], [1, .22], [1, -.37], [.7, -1], [-.7, -1], [-1, -.37]];
  for (let s = 0; s < sections.length; s++) {
    const [z, w, top, bottom] = sections[s];
    ring.forEach(([x, y], i) => { positions.push(x * w, y >= 0 ? y * top : -y * bottom, z); uv.push(i / 8, (z + 9) / 8); });
    if (s) for (let j = 0; j < 8; j++) {
      const a = (s - 1) * 8 + j, b = (s - 1) * 8 + (j + 1) % 8, c = s * 8 + j, d = s * 8 + (j + 1) % 8;
      indices.push(a, d, b, a, c, d);
    }
  }
  for (let i = 1; i < 7; i++) { indices.push(0, i, i + 1); const o = (sections.length - 1) * 8; indices.push(o, o + i + 1, o + i); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(indices); g.computeVertexNormals();
  return g;
}

function panelPolygon(points: Array<[number, number]>, thickness: number) {
  const shape = new THREE.Shape();
  shape.moveTo(points[0][0], points[0][1]);
  points.slice(1).forEach(p => shape.lineTo(p[0], p[1])); shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: true, bevelThickness: .025, bevelSize: .025, bevelSegments: 1, curveSegments: 1 });
  // Shape x/y maps to a wing's x/z.
  g.rotateX(Math.PI / 2); g.translate(0, thickness / 2, 0);
  return g;
}

const glowVertex = `varying vec2 vUv; varying vec3 vLocal; void main(){vUv=uv;vLocal=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`;
function engineMaterial(plume: boolean) {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uBoost: { value: 0 }, uPlume: { value: plume ? 1 : 0 } },
    vertexShader: glowVertex,
    fragmentShader: `precision highp float;
      varying vec2 vUv; varying vec3 vLocal; uniform float uTime; uniform float uBoost; uniform int uPlume;
      void main(){
        float r = length(vLocal.xy)/.53;
        float pulse = .93+.07*sin(uTime*37.+vLocal.z*13.);
        float n = sin(vLocal.z*35.-uTime*24.+sin(vUv.x*38.+uTime*11.));
        float end = uPlume==1 ? clamp(1.-vLocal.z/2.7,0.,1.) : 1.;
        float energy=pow(max(0.,1.-r),1.5)*pulse;
        vec3 color=mix(vec3(1.,.075,.27),vec3(1.,.72,.49),pow(energy,.45));
        color=mix(color,vec3(1.,.89,.80),pow(energy,4.));
        float alpha=uPlume==1 ? end*end*(.45+.09*n) : clamp(energy*2.5,0.,1.);
        gl_FragColor=vec4(color*(3.2+uBoost*1.3)*(energy+.28),alpha*end);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
  });
}

export interface XWing {
  group: THREE.Group;
  update(time: number, attack: number, boost?: number): void;
  engines: THREE.Object3D[];
  muzzlePoints: THREE.Object3D[];
}

export function createXWing(): XWing {
  const p = palette(), body = new Assembly();
  body.group.name = 'Red squadron · T-65 starfighter';
  body.add(sectionHull([[-8.9, .09, .11, -.14], [-7.9, .30, .19, -.23], [-4.4, .64, .32, -.36], [-2.1, .9, .44, -.44], [.5, 1.12, .47, -.52], [3.5, 1.06, .40, -.5], [4.5, .86, .30, -.34]]), p.paint);
  const noseStripe = new THREE.BufferGeometry();
  noseStripe.setAttribute('position', new THREE.Float32BufferAttribute([-.035,.14,-8.6,.035,.14,-8.6,-.17,.292,-5.4,.17,.292,-5.4,-.22,.356,-3.8,.22,.356,-3.8],3));
  noseStripe.setIndex([0,2,1,1,2,3,2,4,3,3,4,5]); noseStripe.computeVertexNormals();
  body.add(noseStripe,p.red);
  body.box(1.45, .24, 3.05, p.dark, 0, .51, 1.6);
  body.box(1.63, .08, 1.5, p.paint, 0, .64, 3.3);
  body.box(.6, .08, 1.2, p.red, 0, .697, 3.4);
  // Visible longitudinal seams, cheek armour, nose sensors, service recesses.
  for (const side of [-1, 1]) {
    body.box(.025, .07, 4.0, p.dark, side * .49, .04, -5.25, new THREE.Euler(0, side * -.062, 0));
    body.box(.14, .31, 2.15, p.red, side * 1.06, -.02, 1.1);
    body.box(.1, .2, 1.3, p.metal, side * .94, -.21, -1.2);
    body.cylinder(.105, 2.9, p.metal, side * .77, -.32, .05, .085, 8);
    body.box(.20, .035, .6, p.dark, side * .63, .421, -2.2);
    for (let i = 0; i < 7; i++) body.box(.09, .075, .07, p.metal, side * .9, .38, 2.3 + i * .19);
    body.cylinder(.105, .24, p.black, side * .22, .02, -8.1, .075, 8);
    body.box(.27, .07, 1.3, p.dark, side * .7, -.5, 2.1);
    body.box(.21, .045, .81, p.metal, side * .7, -.55, 2.1);
  }
  // A low, tapered cockpit with faceted glazing and thin structural frames.
  const canopy = [new V(-.44, .40, -3.62), new V(.44, .40, -3.62), new V(-.70, .52, .20), new V(.70, .52, .20), new V(-.34, .94, -2.0), new V(.34, .94, -2.0), new V(-.48, 1.18, -.1), new V(.48, 1.18, -.1)];
  const glassGeometry = new THREE.BufferGeometry();
  glassGeometry.setAttribute('position', new THREE.Float32BufferAttribute(canopy.flatMap(v => v.toArray()), 3));
  glassGeometry.setIndex([0, 5, 1, 0, 4, 5, 4, 7, 5, 4, 6, 7, 0, 6, 4, 0, 2, 6, 1, 7, 3, 1, 5, 7, 2, 7, 6, 2, 3, 7]);
  glassGeometry.computeVertexNormals(); body.add(glassGeometry, p.glass);
  [[0,1],[0,4],[1,5],[4,5],[4,6],[5,7],[6,7],[6,2],[7,3],[0,2],[1,3],[2,3]].forEach(([a,b]) => body.add(beamBetween(canopy[a],canopy[b],.039),p.metal));
  body.add(beamBetween(new V(0,.406,-3.6),new V(0,.95,-2.0),.032),p.paint);
  // Astromech dome, socket, coloured access panels, and the exposed rear power plant.
  body.cylinder(.48, .65, p.dark, 0, .72, 1.02);
  body.add(new THREE.CylinderGeometry(.36,.36,.32,16),p.paint,new V(0,.77,1.04));
  body.add(new THREE.SphereGeometry(.36,16,8,0,Math.PI*2,0,Math.PI/2),p.metal,new V(0,.93,1.04));
  body.box(.14,.14,.06,p.blue,0,1.07,.704);
  body.box(.07,.055,.065,p.led,-.16,1.0,.706);
  for(let i=0;i<5;i++) body.box(.78,.07,.08,p.metal,0,.66,1.76+i*.19);
  body.cylinder(.45, .35, p.dark, 0, -.05, 4.45);
  body.cylinder(.30, .38, p.metal, 0, -.05, 4.57);
  const group = body.finish();
  const engineCore = engineMaterial(false), flame = engineMaterial(true);
  const engines: THREE.Object3D[] = [], muzzlePoints: THREE.Object3D[] = [];
  const foils: { group: THREE.Group; side: number; tier: number }[] = [];
  const plumes: THREE.Mesh[] = [];
  for (const side of [-1, 1]) for (const tier of [-1, 1]) {
    const wing = new Assembly();
    wing.add(panelPolygon([[0,-1.28],[1.6,-1.17],[6.65,.27],[6.8,1.6],[3.25,1.47],[0,1.02]],.115),p.paint);
    wing.add(panelPolygon([[2.55,-.78],[3.65,-.49],[3.9,1.44],[2.76,1.35]],.02),p.red,new V(0,.081,0));
    wing.add(panelPolygon([[5.35,-.01],[6.2,.19],[6.35,1.52],[5.52,1.49]],.02),p.red,new V(0,.081,0));
    wing.add(panelPolygon([[.5,-.93],[2.35,-.78],[2.6,.9],[.5,.83]],.065),p.dark,new V(0,.1,0));
    wing.box(2.8,.06,.07,p.metal,3.5,.11,1.12);
    wing.add(beamBetween(new V(.1,.08,-1.13),new V(6.61,.08,.35),.037),p.metal);
    wing.box(.35,.29,1.45,p.dark,.42,0,0);
    for(let i=0;i<5;i++) wing.box(.9,.08,.065,p.metal,1.48,.15,-.66+i*.24);
    // Distinct intake, cylindrical nacelle and aft exhaust assembly.
    wing.cylinder(.59,3.75,p.paint,1.38,tier*.13,.55,.62,20);
    wing.cylinder(.64,.18,p.metal,1.38,tier*.13,-1.36,.64,20);
    wing.cylinder(.535,.2,p.black,1.38,tier*.13,-1.49,.535,20);
    wing.cylinder(.29,.19,p.metal,1.38,tier*.13,-1.62,.29,12);
    wing.cylinder(.15,.22,p.dark,1.38,tier*.13,-1.76,.06,12);
    for(let k=0;k<8;k++) {
      const a=k*Math.PI/4;
      wing.add(beamBetween(new V(1.38+Math.cos(a)*.17,tier*.13+Math.sin(a)*.17,-1.61),new V(1.38+Math.cos(a)*.50,tier*.13+Math.sin(a)*.50,-1.56),.025),p.metal);
      wing.box(.09,.09,.80,p.dark,1.38+Math.cos(a)*.55,tier*.13+Math.sin(a)*.55,1.90);
    }
    wing.cylinder(.50,1.16,p.dark,1.38,tier*.13,2.96,.55,20);
    for(let k=0;k<5;k++) wing.cylinder(.555,.06,p.metal,1.38,tier*.13,2.57+k*.19,.555,20);
    wing.cylinder(.58,.22,p.paint,1.38,tier*.13,3.52,.58,20);
    wing.cylinder(.485,.08,p.black,1.38,tier*.13,3.65,.485,20);
    // Wingtip cannon: cooling barrel, collar, long tip and targeting prongs.
    wing.box(.30,.31,1.27,p.paint,6.75,0,.83);
    wing.cylinder(.19,2.9,p.paint,6.75,0,-.18,.16,12);
    wing.cylinder(.105,2.85,p.metal,6.75,0,-2.73,.065,10);
    wing.cylinder(.15,.36,p.dark,6.75,0,-1.24,.15,12);
    wing.cylinder(.10,.2,p.dark,6.75,0,-4.19,.10,10);
    for(let k=0;k<5;k++) wing.cylinder(.211,.043,p.dark,6.75,0,-.94+k*.27,.211,12);
    wing.box(.40,.045,.5,p.metal,6.75,0,-3.46);
    wing.box(.045,.40,.5,p.metal,6.75,0,-3.46);
    const foil=wing.finish();
    foil.position.set(side*1.0,tier*.22,.3); foil.scale.x=side;
    foil.name = `${side < 0 ? 'port' : 'starboard'} ${tier > 0 ? 'upper' : 'lower'} S-foil`;
    foils.push({group:foil,side,tier}); group.add(foil);
    const engine=new THREE.Object3D(); engine.position.set(1.38,tier*.13,3.7); foil.add(engine); engines.push(engine);
    const core = new THREE.Mesh(new THREE.CircleGeometry(.51,24),engineCore); engine.add(core);
    const plumeGeometry = new THREE.ConeGeometry(.51,2.7,20,1,true); plumeGeometry.rotateX(Math.PI/2); plumeGeometry.translate(0,0,1.35);
    const plume=new THREE.Mesh(plumeGeometry,flame); engine.add(plume); plumes.push(plume);
    const muzzle=new THREE.Object3D(); muzzle.position.set(6.75,0,-4.4); foil.add(muzzle); muzzlePoints.push(muzzle);
  }
  return { group, engines, muzzlePoints, update(time, attack, boost=0) {
    const spread = .024 + THREE.MathUtils.clamp(attack,0,1)*.285;
    for(const foil of foils) foil.group.rotation.z=foil.side*foil.tier*spread;
    engineCore.uniforms.uTime.value=flame.uniforms.uTime.value=time;
    engineCore.uniforms.uBoost.value=flame.uniforms.uBoost.value=boost;
    for(const plume of plumes) plume.scale.z=1+boost*.8+.04*Math.sin(time*17);
  } };
}

let tieGeometry: Array<{geometry:THREE.BufferGeometry; material:THREE.Material}> | undefined;
function createTIEGeometry() {
  const p=palette(), a=new Assembly();
  a.add(new THREE.SphereGeometry(.88,20,12),p.metal);
  a.add(new THREE.SphereGeometry(.72,16,12),p.dark,new V(0,0,-.32),new THREE.Euler(),new V(1,1,.7));
  a.cylinder(.62,.08,p.glass,0,0,-.91,.62,8);
  a.add(new THREE.TorusGeometry(.625,.065,6,8),p.paint,new V(0,0,-.963));
  a.add(new THREE.TorusGeometry(.205,.035,4,8),p.metal,new V(0,0,-1.01));
  for(let i=0;i<8;i++) {
    const angle=i*Math.PI/4;
    a.add(beamBetween(new V(Math.cos(angle)*.19,Math.sin(angle)*.19,-1.01),new V(Math.cos(angle)*.59,Math.sin(angle)*.59,-.974),.03),p.paint);
  }
  a.add(new THREE.CylinderGeometry(.23,.23,4.55,10),p.dark,new V(),new THREE.Euler(0,0,Math.PI/2));
  a.add(new THREE.CylinderGeometry(.29,.29,1.18,8),p.paint,new V(-1.05,0,0),new THREE.Euler(0,0,Math.PI/2));
  a.add(new THREE.CylinderGeometry(.29,.29,1.18,8),p.paint,new V(1.05,0,0),new THREE.Euler(0,0,Math.PI/2));
  a.box(.42,.17,.6,p.dark,0,.84,.04);
  a.cylinder(.13,.32,p.dark,0,0,.86,.13,12);
  for(const side of [-1,1]) {
    a.cylinder(.08,.6,p.metal,side*.37,-.48,-.83,.065,8);
    a.cylinder(.04,.1,p.led,side*.37,-.48,-1.17,.04,8);
    const corners=[new V(side*2.25,2.65,-1.03),new V(side*2.25,1.55,-2.03),new V(side*2.25,-1.55,-2.03),new V(side*2.25,-2.65,-1.03),new V(side*2.25,-1.55,1.12),new V(side*2.25,1.55,1.12)];
    const geometry=new THREE.BufferGeometry();
    const verts=[side*2.25,0,-.34,...corners.flatMap(c=>c.toArray())];
    const indices=[];
    for(let i=0;i<6;i++) indices.push(0,i+1,(i+1)%6+1);
    geometry.setAttribute('position',new THREE.Float32BufferAttribute(verts,3)); geometry.setIndex(indices); geometry.computeVertexNormals();
    a.add(geometry,p.solar);
    for(let i=0;i<6;i++) {
      a.add(beamBetween(corners[i],corners[(i+1)%6],.10),p.paint);
      a.add(beamBetween(new V(side*2.27,0,-.34),corners[i],.044),p.metal);
    }
    // Fine raised photovoltaic ribs catch a grazing light without individual objects.
    for(let y=-2.35;y<=2.35;y+=.145) {
      const extent = Math.abs(y)>1.55 ? (2.65-Math.abs(y))/1.1 : 1;
      const front=-1.03-extent;
      const back=-1.03+extent*2.15;
      a.add(beamBetween(new V(side*2.268,y,front+.04),new V(side*2.268,y,back-.04),.012),p.blue);
    }
    a.add(new THREE.CylinderGeometry(.37,.37,.12,8),p.paint,new V(side*2.30,0,-.34),new THREE.Euler(0,0,Math.PI/2));
  }
  const finished=a.finish();
  return finished.children.map(child=>{const m=child as THREE.Mesh;return {geometry:m.geometry,material:m.material as THREE.Material};});
}

export function createTIE(): {group:THREE.Group;update(time:number):void} {
  if(!tieGeometry) tieGeometry=createTIEGeometry();
  const group=new THREE.Group(); group.name='Imperial interceptor';
  tieGeometry.forEach(part=>group.add(new THREE.Mesh(part.geometry,part.material)));
  return {group,update(_time:number){ /* Flight steering is owned by the battle director. */ }};
}
