import * as THREE from 'three';
import { clamp, damp, dampV, lerp, smoothstep, easeInOutCubic, easeOutCubic } from '../core/mathx';
import {
  COL_IMP_LASER, COL_REBEL_LASER, COL_TORPEDO, COL_TURBO,
  DS_RADIUS, PORT_S, PORT_RADIUS, TRENCH_DEPTH, TRENCH_HALF_WIDTH,
  MERIDIAN_CORRIDOR_S0, MERIDIAN_CORRIDOR_S1,
  trenchToWorld, trenchRadial, trenchForward, worldToTrench, portPosition,
} from '../core/constants';
import { audio } from '../core/audio';
import type { World, Wingman, TorpedoRun } from './world';
import { createTorpedoVisual } from '../shaders/torpedo';
import { centreAt, floorAt, halfWidthAt } from '../world/trench';

export type PhaseName =
  | 'title' | 'approach' | 'squadron' | 'intercept' | 'dive' | 'entry'
  | 'trench' | 'targeting' | 'torpedo' | 'escape' | 'destruction' | 'outro' | 'end';

interface PhaseDef { name: PhaseName; dur: number; }

const PHASES: PhaseDef[] = [
  { name: 'approach', dur: 18 },
  { name: 'squadron', dur: 16 },
  { name: 'intercept', dur: 24 },
  { name: 'dive', dur: 16 },
  { name: 'entry', dur: 7 },
  { name: 'trench', dur: 999 },     // event-driven, ends near the port
  { name: 'targeting', dur: 9 },
  { name: 'torpedo', dur: 9 },
  { name: 'escape', dur: 11 },
  { name: 'destruction', dur: 22 },
  { name: 'outro', dur: 10 },
  { name: 'end', dur: 9999 },
];

/* scratch */
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _tc = { s: 0, lateral: 0, up: 0 };
const _e = new THREE.Euler();
const _radial = new THREE.Vector3(), _fwd = new THREE.Vector3();
const _hit = { point: new THREE.Vector3(), normal: new THREE.Vector3(), kind: '' };

/** trench-local waypoint -> world */
function P(s: number, lat: number, up: number) { return trenchToWorld(s, lat, up, new THREE.Vector3()); }

export class Sequence {
  w: World;
  phaseIndex = 0;
  phaseTime = 0;
  time = 0;
  running = false;

  private radioQueue: { t: number; who: string; text: string }[] = [];
  private radioIdx = 0;
  private tieWaves = 0;
  private trenchTIEsSpawned = false;
  private lastAutoFire = 0;
  private killCount = 0;
  private retireTimer = 0;
  private realKills = 0;
  private chaseWaves = 0;
  private lockTimer = 0;
  private torpFired = false;
  private destructionStarted = false;
  private surfaceExplodeTimer = 0;
  private hullDamageApplied = 0;

  constructor(world: World) {
    this.w = world;
    this.buildRadio();
  }

  get phase(): PhaseName { return PHASES[this.phaseIndex].name; }

  start(interactive: boolean) {
    const w = this.w;
    w.interactive = interactive;
    w.cinematic = !interactive;
    w.ship.autopilot = !interactive;
    this.running = true;
    this.time = 0;
    this.phaseIndex = -1;
    w.hud.setTorpedoes(2);
    w.hud.setShield(1);
    w.hud.setVisible(true);
    this.nextPhase();
    audio.setDrone(0.35);
  }

  // ------------------------------------------------------------------ phases
  private nextPhase() {
    this.phaseIndex++;
    this.phaseTime = 0;
    const p = this.phase;
    this.w.phase = p;
    this.onEnterPhase(p);
  }

  private onEnterPhase(p: PhaseName) {
    const w = this.w;
    const d = w.director;
    switch (p) {
      case 'approach': {
        w.ship.setPath([
          P(-15500, 5200, 150000), P(-14200, 3600, 120000),
          P(-12900, 2300, 88000), P(-11600, 1400, 62000),
        ], 18, _radial.copy(trenchRadial(-13000)).clone());
        w.hud.setMode('cinematic');
        w.hud.title('A LONG TIME AGO…', 'BATTLE OF YAVIN', 4.6);
        d.play('wide-station', this.time, 0);
        break;
      }
      case 'squadron': {
        w.ship.setPath([
          P(-11600, 1400, 62000), P(-11000, 900, 54000),
          P(-10400, 300, 46000), P(-9900, -120, 40000),
        ], 16, trenchRadial(-10500).clone());
        w.xwing.sfoilTarget = 1;
        for (const wm of w.wingmen) wm.craft.sfoilTarget = 1;
        d.play('alongside', this.time, 1.6);
        audio.beep(520, 0.12, 0.15);
        break;
      }
      case 'intercept': {
        w.ship.setPath([
          P(-9900, -120, 40000), P(-9750, 620, 38200), P(-9600, -480, 36400),
          P(-9450, 380, 34700), P(-9300, -150, 33200), P(-9150, 120, 32000),
        ], 24, trenchRadial(-8500).clone());
        this.spawnTIEWave(4, 1050);
        w.hud.setMode('combat');
        d.play('ties-approach', this.time, 1.4);
        audio.setDrone(0.6, 62);
        break;
      }
      case 'dive': {
        w.ship.setPath([
          P(-9150, 120, 32000), P(-8500, 40, 19000), P(-7700, 0, 9000),
          P(-7100, 0, 4000), P(-6700, 0, 1700), P(-6400, 0, 900),
        ], 16, trenchRadial(-5000).clone());
        w.ties.breakOff();
        d.play('dive', this.time, 1.5);
        break;
      }
      case 'entry': {
        {
          const ep = new THREE.Vector3();
          w.ship.trenchEntryPoint(-2800, ep);
          w.ship.setPath([
            P(-6400, 0, 900), P(-5600, 0, 470), P(-4700, 0, 180),
            P(-3900, 0, 10), P(-3300, 0, -40), ep,
          ], 7, trenchRadial(-4200).clone());
        }
        d.play('trench-entry', this.time, 1.2);
        w.hud.setLetterbox(0);
        break;
      }
      case 'trench': {
        w.ship.enterTrench(-2800);
        w.ship.autopilot = !w.interactive;
        w.hud.setMode('combat');
        for (const wm of w.wingmen) wm.inTrench = true;
        d.play('trench-chase', this.time, 1.1);
        audio.setDrone(0.8, 55);
        break;
      }
      case 'targeting': {
        w.hud.setMode('targeting');
        this.lockTimer = 0;
        d.play('targeting', this.time, 1.0);
        audio.setDrone(0.95, 49);
        break;
      }
      case 'torpedo': {
        this.torpFired = false;
        d.play('torpedo-launch', this.time, 0.7);
        break;
      }
      case 'escape': {
        const s0 = this.w.ship.s;
        w.ship.setPath([
          P(s0, w.ship.lateral, w.ship.up), P(s0 + 900, 0, -20),
          P(s0 + 1900, 0, 260), P(s0 + 3200, 0, 2400),
          P(s0 + 4800, 0, 14000), P(s0 + 6400, 0, 40000), P(s0 + 7800, 0, 90000),
        ], 11, trenchRadial(s0 + 3000).clone());
        w.hud.setMode('cinematic');
        w.hud.setLock(0, false);
        d.play('escape-climb', this.time, 0.9);
        break;
      }
      case 'destruction': {
        w.ship.mode = 'free';
        w.ship.autopilot = true;
        w.ship.freeSpeed = 17000;
        trenchRadial(PORT_S + 8000, _radial);
        w.ship.freeDir.copy(_radial).normalize();
        w.destruction.start(w.stationCenter, DS_RADIUS, 7);
        this.destructionStarted = true;
        w.destroyed = true;
        d.play('destruction-wide', this.time, 1.2);
        audio.rumble(9, 1.0);
        audio.setDrone(0.5, 41);
        break;
      }
      case 'outro': {
        // ease off the throttle: at 17 km/s the ship would outrun the far plane
        // and the dying station would vanish out of the back of the shot
        w.ship.freeSpeed = 900;
        d.play('escape-final', this.time, 2.0);
        w.hud.setMode('cinematic');
        audio.setDrone(0.42, 73);
        break;
      }
      case 'end': {
        w.hud.title('THE DEATH STAR IS DESTROYED', 'RED FIVE, RETURNING', 13);
        w.hud.radio('BASE', 'All wings, return to base. Great shot, Red Five.', 6);
        w.hud.setLetterbox(1);
        break;
      }
      default: break;
    }
  }

  // ------------------------------------------------------------------ update
  update(dt: number, _time: number) {
    if (!this.running) return;
    const w = this.w;
    this.time += dt;
    this.phaseTime += dt;
    w.seqTime = this.time;
    w.phaseTime = this.phaseTime;

    const p = this.phase;

    // --- ship ---
    w.ship.update(dt, this.time, w.input, p === 'trench' ? w.trench : null);
    w.shipObj.position.copy(w.ship.position);
    w.shipObj.quaternion.copy(w.ship.quaternion);
    w.xwing.throttle = clamp(0.55 + (w.ship.boosting ? 0.45 : 0.28), 0, 1);
    w.xwing.update(dt, this.time, w.camera);

    this.updateWingmen(dt);
    this.updateWeapons(dt);
    this.updateTIEs(dt);
    this.updateTurrets(dt);
    this.updateEnemyFire(dt);
    this.updateTorpedoes(dt);
    this.updateHUD(dt);
    this.updateRadio();
    this.updatePhaseLogic(dt);

    audio.setEngine(w.ship.mode === 'trench' ? 0.85 : 0.6, w.ship.boosting ? 1 : 0);
  }

  private updatePhaseLogic(dt: number) {
    const w = this.w;
    const p = this.phase;
    const def = PHASES[this.phaseIndex];

    switch (p) {
      case 'intercept': {
        // rolling waves so there is always a head-on pass in frame
        {
          // a steady drumbeat of head-on passes so something is always inbound
          const waveAt = [3.2, 6.6, 10.0, 13.4, 16.8, 20.2];
          const sides = [1, -1, 0, 1, -1, 0];
          for (let i = 0; i < waveAt.length; i++) {
            if (this.phaseTime > waveAt[i] && this.tieWaves < i + 2) {
              this.spawnTIEWave(i % 2 === 0 ? 3 : 2, 850 + (i % 3) * 120, sides[i]);
            }
          }
          // and a pair running ahead of us on each camera beat
          if (this.phaseTime > 7.4 && this.chaseWaves < 1) { this.chaseWaves = 1; this.spawnTIEChase(2, 340, -1); }
          if (this.phaseTime > 14.6 && this.chaseWaves < 2) { this.chaseWaves = 2; this.spawnTIEChase(2, 300, 1); }
          if (this.phaseTime > 20.0 && this.chaseWaves < 3) { this.chaseWaves = 3; this.spawnTIEChase(2, 320, 0); }
        }
        // camera beats
        if (this.phaseTime > 7.5 && w.director.currentShotName === 'ties-approach') w.director.play('dogfight-chase', this.time, 1.2);
        if (this.phaseTime > 15.5 && w.director.currentShotName === 'dogfight-chase') w.director.play('dogfight-side', this.time, 1.0);
        if (this.phaseTime > 20 && w.director.currentShotName === 'dogfight-side') w.director.play('dogfight-chase2', this.time, 0.9);
        if (this.phaseTime >= def.dur) this.nextPhase();
        break;
      }
      case 'squadron': {
        if (this.phaseTime > 8.4 && w.director.currentShotName === 'alongside') w.director.play('sfoil-detail', this.time, 1.1);
        if (this.phaseTime >= def.dur) this.nextPhase();
        break;
      }
      case 'dive': {
        if (this.phaseTime > 8.5 && w.director.currentShotName === 'dive') w.director.play('surface-skim', this.time, 1.4);
        if (this.phaseTime >= def.dur) this.nextPhase();
        break;
      }
      case 'trench': {
        const prog = clamp((w.ship.s + 2800) / (PORT_S - 5800 + 2800), 0, 1);
        w.trenchProgress = prog;
        // spawn pursuing TIEs about a third of the way down
        if (!this.trenchTIEsSpawned && prog > 0.3) {
          this.trenchTIEsSpawned = true;
          trenchToWorld(w.ship.s - 1500, 0, -48, _v);
          trenchForward(w.ship.s, _fwd);
          w.ties.setBounds(null);
          w.ties.spawn(_v, _fwd, 3, { mode: 'pursue', variant: 'fighter', spread: 1.8, speed: 470 });
          w.hud.radio('BASE', 'Three marks at two-ten. Watch your back.');
        }
        // cinematic inserts only when the player is not flying
        if (w.cinematic) {
          const beats: [number, string][] = [
            [0.10, 'trench-side'], [0.17, 'trench-chase'], [0.34, 'trench-cockpit'],
            [0.43, 'trench-chase'], [0.56, 'trench-low'], [0.64, 'trench-chase'],
            [0.78, 'trench-side2'], [0.84, 'trench-chase'],
          ];
          for (const [at, shot] of beats) {
            if (prog >= at && this.lastBeat < at) { w.director.play(shot, this.time, 0.85); this.lastBeat = at; }
          }
        }
        if (w.ship.s >= PORT_S - 5800) this.nextPhase();
        break;
      }
      case 'targeting': {
        // slow to a steady attack run and centre up
        w.ship.throttle = damp(w.ship.throttle, 0.86, 1.4, dt);
        this.lockTimer += dt;
        const lock = clamp((this.lockTimer - 1.0) / 4.2, 0, 1);
        w.lockProgress = lock;
        w.locked = lock >= 1;
        if (w.locked && !this._lockBeeped) { this._lockBeeped = true; audio.beep(1400, 0.16, 0.3); }
        if (this.phaseTime > 5.4 && w.director.currentShotName === 'targeting') w.director.play('targeting-port', this.time, 1.0);
        if (this.phaseTime >= def.dur) this.nextPhase();
        break;
      }
      case 'torpedo': {
        if (!this.torpFired && this.phaseTime > 0.8) { this.fireTorpedoes(); this.torpFired = true; }
        if (this.phaseTime > 1.5 && w.director.currentShotName === 'torpedo-launch') w.director.play('torpedo-track', this.time, 0.8);
        if (this.phaseTime > 4.0 && w.director.currentShotName === 'torpedo-track') w.director.play('port-entry', this.time, 0.55);
        if (this.phaseTime > 5.1 && w.director.currentShotName === 'port-entry') w.director.play('shaft', this.time, 0.35);
        if (this.phaseTime > 6.7 && w.director.currentShotName === 'shaft') {
          w.director.play('core-hit', this.time, 0.4);
          portPosition(_v);
          trenchRadial(PORT_S, _radial);
          _v.addScaledVector(_radial, -2400);
          w.fx.explosion(_v, 320, { debris: 40, light: true, smoke: true, shock: true });
          w.director.shake.add(0.9);
          audio.explosion(2.2, 1.0);
        }
        if (this.phaseTime >= def.dur) this.nextPhase();
        break;
      }
      case 'escape': {
        if (this.phaseTime > 4.5 && w.director.currentShotName === 'escape-climb') w.director.play('escape-wide', this.time, 1.6);
        if (this.phaseTime >= def.dur) this.nextPhase();
        break;
      }
      case 'destruction': {
        const t = w.destruction.elapsed as number;
        if (t > 4.0 && w.director.currentShotName === 'destruction-wide') w.director.play('destruction-core', this.time, 1.3);
        if (t > 6.4 && w.director.currentShotName === 'destruction-core') w.director.play('destruction-primary', this.time, 0.9);
        if (t > 11.0 && w.director.currentShotName === 'destruction-primary') w.director.play('shockwave', this.time, 1.1);
        if (t > 16.5 && w.director.currentShotName === 'shockwave') w.director.play('escape-final', this.time, 1.8);
        if (this.phaseTime >= def.dur) this.nextPhase();
        break;
      }
      case 'outro': {
        if (this.phaseTime > 7 && w.director.currentShotName === 'escape-final') w.director.play('outro-drift', this.time, 2.4);
        if (this.phaseTime >= def.dur) this.nextPhase();
        break;
      }
      default: {
        if (this.phaseTime >= def.dur && this.phaseIndex < PHASES.length - 1) this.nextPhase();
      }
    }
  }
  private lastBeat = -1;
  private _lockBeeped = false;

  // ------------------------------------------------------------------ wingmen
  private updateWingmen(dt: number) {
    const w = this.w;
    for (const wm of w.wingmen) {
      if (!wm.alive) continue;
      if (wm.dieAt > 0 && this.time >= wm.dieAt) { this.killWingman(wm); continue; }
      const off = wm.inTrench ? _v.copy(wm.offset).multiplyScalar(1).setZ(wm.offset.z * 2.2) : _v.copy(wm.offset);
      off.applyQuaternion(w.ship.quaternion).add(w.ship.position);
      wm.wobble += dt;
      off.x += Math.sin(wm.wobble * 0.83 + wm.offset.x) * 3.2;
      off.y += Math.sin(wm.wobble * 1.17 + wm.offset.z) * 2.4;
      // carry the smoothed position along with the leader first: a plain
      // exponential filter in world space would trail by v/lambda, which is
      // over a kilometre at approach speed
      if (!wm.seeded) { wm.pos.copy(off); wm.quat.copy(w.ship.quaternion); wm.seeded = true; }
      else wm.pos.addScaledVector(w.ship.velocity, dt);
      dampV(wm.pos, off, 3.4, dt);
      // keep them out of the trench walls
      if (wm.inTrench) {
        worldToTrench(wm.pos, _tc);
        _tc.lateral = clamp(_tc.lateral, -TRENCH_HALF_WIDTH + 12, TRENCH_HALF_WIDTH - 12);
        _tc.up = clamp(_tc.up, -TRENCH_DEPTH + 12, -8);
        trenchToWorld(_tc.s, _tc.lateral, _tc.up, wm.pos);
      }
      wm.quat.slerp(w.ship.quaternion, 1 - Math.exp(-4 * dt));
      wm.obj.position.copy(wm.pos);
      wm.obj.quaternion.copy(wm.quat);
      wm.craft.throttle = 0.8;
      wm.craft.update(dt, this.time, w.camera);
    }
  }

  private killWingman(wm: Wingman) {
    const w = this.w;
    wm.alive = false;
    wm.obj.visible = false;
    w.fx.explosion(wm.pos, 16, { debris: 26, light: true, smoke: true });
    audio.explosion(0.9, 0.8);
    w.hud.radio('LUKE', `${wm.name.toUpperCase()}, PULL UP!`);
    w.hud.flashDamage(0.5);
    w.director.shake.add(0.5);
  }

  // ------------------------------------------------------------------ weapons
  private cannonIdx = 0;
  private lastWingFire = 0;
  private wingFireIdx = 0;
  private updateWeapons(dt: number) {
    const w = this.w;
    const p = this.phase;
    const combat = p === 'intercept' || p === 'trench' || p === 'dive';
    let wantFire = false;

    if (w.interactive && w.input.isDown('Space')) wantFire = true;
    if (!w.interactive || w.ship.autopilot) {
      // autopilot: fire when a TIE is roughly in front
      if (combat && this.time - this.lastAutoFire > 0.16) {
        const tgt = this.pickAutoTarget();
        if (tgt) {
          wantFire = true;
          this.lastAutoFire = this.time;
        }
      }
    }

    if (wantFire && combat && w.ship.canFireLaser()) {
      w.ship.didFireLaser();
      const pair = this.cannonIdx % 2;
      this.cannonIdx++;
      for (const i of pair === 0 ? [0, 3] : [1, 2]) {
        w.xwing.getCannonTip(i, _v);
        // converge on the auto target if there is one, else straight ahead
        const tgt = this.pickAutoTarget();
        if (tgt) _v2.copy(tgt).sub(_v).normalize();
        else w.ship.getForward(_v2);
        w.fx.laser(_v, _v2, { color: COL_REBEL_LASER, team: 'rebel', speed: 2400, length: 22, radius: 0.36 });
      }
      audio.laser(1.0, 0.35);
    }

    // wingmen shoot too — it is what sells the dogfight
    if (combat && this.time - this.lastWingFire > 0.42) {
      this.lastWingFire = this.time;
      const live = w.wingmen.filter((x) => x.alive);
      if (live.length) {
        const wm = live[(this.wingFireIdx++) % live.length];
        let best: any = null, bestD = 4200;
        for (const t of w.ties.ties) {
          if (!t.alive) continue;
          const d = t.position.distanceTo(wm.pos);
          if (d < bestD) { bestD = d; best = t; }
        }
        if (best) {
          for (const sx of [-1, 1]) {
            _v.set(sx * 5.4, 0.4, -3.4).applyQuaternion(wm.quat).add(wm.pos);
            _v2.copy(best.position).sub(_v).normalize();
            _e.set((Math.random() - 0.5) * 0.045, (Math.random() - 0.5) * 0.045, 0, 'XYZ');
            _v2.applyQuaternion(_q2.setFromEuler(_e));
            w.fx.laser(_v, _v2, { color: COL_REBEL_LASER, team: 'rebel', speed: 2400, length: 22, radius: 0.34 });
          }
        }
      }
    }

    // torpedo fire (manual)
    if (w.interactive && w.input.wasPressed('KeyF') && this.phase === 'targeting' && w.locked && !this.torpFired) {
      this.phaseTime = PHASES[this.phaseIndex].dur;   // jump to the torpedo phase
    }
  }

  private pickAutoTarget(): THREE.Vector3 | null {
    const w = this.w;
    let best: THREE.Vector3 | null = null;
    let bestScore = -1;
    w.ship.getForward(_v3);
    for (const t of w.ties.ties) {
      if (!t.alive) continue;
      _v.copy(t.position).sub(w.ship.position);
      const d = _v.length();
      if (d < 40 || d > 4200) continue;
      _v.divideScalar(d);
      const dot = _v.dot(_v3);
      if (dot < 0.86) continue;
      const score = dot - d / 6000;
      if (score > bestScore) { bestScore = score; best = t.position; }
    }
    return best;
  }

  // ------------------------------------------------------------------ TIEs
  private spawnTIEWave(n: number, ahead = 2200, side = 0) {
    const w = this.w;
    w.ship.getForward(_fwd);
    w.ship.getRight(_v3);
    w.ship.getUp(_v2);
    _v.copy(w.ship.position)
      .addScaledVector(_fwd, ahead)
      .addScaledVector(_v3, side * 110 + 40)
      .addScaledVector(_v2, 70 - side * 45);
    w.ties.setBounds(DS_RADIUS + 900);
    const back = _fwd.clone().negate();
    w.ties.spawn(_v, back, n - 1, { mode: 'attack', variant: 'fighter', spread: 2.4, speed: 430 });
    if (this.tieWaves === 0) {
      w.ties.spawn(_v.clone().addScaledVector(_v2, 190), back, 1, { mode: 'attack', variant: 'interceptor', spread: 1.2, speed: 470 });
    } else if (this.tieWaves === 2) {
      w.ties.spawn(_v.clone().addScaledVector(_v2, 190), back, 1, { mode: 'attack', variant: 'advanced', spread: 1.0, speed: 450 });
    } else {
      w.ties.spawn(_v.clone().addScaledVector(_v2, 190), back, 1, { mode: 'attack', variant: 'interceptor', spread: 1.2, speed: 470 });
    }
    this.tieWaves++;
  }

  /** Fighters that run *with* the player so the chase camera has something to
   *  shoot at instead of a blur that crosses frame in a tenth of a second. */
  private spawnTIEChase(n: number, ahead: number, side: number) {
    const w = this.w;
    w.ship.getForward(_fwd);
    w.ship.getRight(_v3);
    w.ship.getUp(_v2);
    _v.copy(w.ship.position)
      .addScaledVector(_fwd, ahead)
      .addScaledVector(_v3, side * 90)
      .addScaledVector(_v2, 24);
    w.ties.spawn(_v, _fwd.clone(), n, { mode: 'evade', variant: 'fighter', spread: 1.5, speed: 360 });
  }

  /** retire fighters that have drifted out of the fight, without an explosion */
  private retireFarTIEs(maxDist: number) {
    const w = this.w;
    for (const t of w.ties.ties) {
      if (!t.alive) continue;
      const d = t.position.distanceTo(w.ship.position);
      if (d > maxDist || (t.mode === 'flee' && d > maxDist * 0.55)) w.ties.kill(t, SILENT_FX);
    }
  }

  private updateTIEs(dt: number) {
    const w = this.w;
    this.retireTimer -= dt;
    if (this.retireTimer <= 0) {
      this.retireTimer = 0.75;
      if (this.phase === 'intercept' || this.phase === 'dive') this.retireFarTIEs(4200);
      else if (this.phase !== 'trench') this.retireFarTIEs(2600);
    }
    _target.position.copy(w.ship.position);
    _target.quaternion.copy(w.ship.quaternion);
    _target.velocity.copy(w.ship.velocity);
    _target.radius = 8;
    w.ties.update(dt, this.time, _target, w.fx);

    // pick the camera's combat focus: nearest alive TIE, biased toward ones ahead
    let bestD = Infinity, bestT: any = null;
    w.ship.getForward(_v3);
    for (const t of w.ties.ties) {
      if (!t.alive) continue;
      _v.copy(t.position).sub(w.ship.position);
      const d = _v.length();
      if (d > 3400) continue;
      const ahead = _v.dot(_v3) / Math.max(d, 1);
      const score = d * (ahead > 0 ? 1 : 2.2);
      if (score < bestD) { bestD = score; bestT = t; }
    }
    w.focus = bestT ? bestT.position : null;
    w.focusDist = bestT ? bestT.position.distanceTo(w.ship.position) : Infinity;
    if (this.realKills > this.killCount) {
      this.killCount = this.realKills;
      audio.explosion(0.7, 0.65);
      w.director.shake.add(0.16);
    }
  }

  /**
   * Incoming fire the camera can actually see. The TIE AI fires on its own, but
   * a dogfight only *reads* when bolts are streaking past the lens, so during
   * the intercept we also drive deliberate near-misses from whichever fighters
   * are in front of the player.
   */
  private enemyFireT = 0;
  private updateEnemyFire(dt: number) {
    const w = this.w;
    const p = this.phase;
    if (p !== 'intercept' && p !== 'dive' && p !== 'trench') return;
    this.enemyFireT -= dt;
    if (this.enemyFireT > 0) return;
    this.enemyFireT = p === 'trench' ? 0.42 : 0.20;

    w.ship.getForward(_fwd);
    let shots = 0;
    for (const t of w.ties.ties) {
      if (!t.alive || shots >= 2) continue;
      _v.copy(w.ship.position).sub(t.position);
      const d = _v.length();
      if (d < 60 || d > 2600) continue;
      _v.divideScalar(d);
      // only fighters that have the player in front of them
      _v2.set(0, 0, -1).applyQuaternion(t.quaternion);
      if (_v.dot(_v2) < 0.55) continue;
      // aim just wide so the bolt whips past the camera instead of hitting
      const miss = 0.010 + Math.random() * 0.028;
      _e.set((Math.random() - 0.5) * miss * 2, (Math.random() - 0.5) * miss * 2, 0, 'XYZ');
      _v3.copy(_v).applyQuaternion(_q2.setFromEuler(_e));
      _v2.copy(t.position).addScaledVector(_v3, 5);
      w.fx.laser(_v2, _v3, { color: COL_IMP_LASER, team: 'imperial', speed: 2100, length: 26, radius: 0.42, muzzleFlash: true });
      shots++;
    }
  }

  // ------------------------------------------------------------------ turrets
  private updateTurrets(dt: number) {
    const w = this.w;
    if (this.phase !== 'trench' && this.phase !== 'targeting' && this.phase !== 'entry') return;
    const turrets = w.trench.turrets as any[];
    if (!turrets) return;
    const ship = w.ship;
    let fired = 0;
    for (const t of turrets) {
      if (!t.alive) continue;
      const ds = t.s - ship.s;
      if (ds < -600 || ds > 2600) continue;
      // aim (lead the target)
      const lead = clamp(Math.abs(ds) / 1400, 0, 1) * 0.55;
      _v.copy(ship.position).addScaledVector(ship.velocity, lead);
      // yaw the head, pitch the barrels
      t.head.getWorldPosition(_v2);
      _v3.copy(_v).sub(_v2);
      t.head.parent?.getWorldQuaternion(_q);
      _q.invert();
      _v3.applyQuaternion(_q);
      // turret barrels fire along local -Z
      const yaw = Math.atan2(-_v3.x, -_v3.z);
      t.head.rotation.y = damp(t.head.rotation.y, yaw, 5, dt);
      const horiz = Math.hypot(_v3.x, _v3.z);
      const pitch = Math.atan2(_v3.y, horiz);
      t.barrels.rotation.x = damp(t.barrels.rotation.x, clamp(pitch, -0.5, 1.3), 5, dt);

      t.cooldown -= dt;
      if (t.cooldown <= 0 && ds > 120 && ds < 2200 && fired < 3) {
        t.cooldown = 1.1 + Math.random() * 1.5;
        fired++;
        _v3.copy(_v).sub(t.muzzle).normalize();
        _v2.copy(t.muzzle).addScaledVector(_v3, 7);
        // deliberate miss most of the time — the near miss is the point
        _e.set((Math.random() - 0.5) * 0.055, (Math.random() - 0.5) * 0.055, 0, 'XYZ');
        _v3.applyQuaternion(_q2.setFromEuler(_e));
        w.fx.laser(_v2, _v3, { color: COL_TURBO, team: 'turbo', speed: 1900, length: 42, radius: 0.85, muzzleFlash: true });
        if (ds < 900) audio.laser(0.55, 0.22);
      }
    }
  }

  // ------------------------------------------------------------------ torpedoes
  private fireTorpedoes() {
    const w = this.w;
    portPosition(_v3);
    trenchRadial(PORT_S, _radial);
    for (let i = 0; i < 2; i++) {
      const t = w.torpedoes[i];
      w.xwing.getTorpedoTube(i, _v);
      w.ship.getForward(_v2);
      const pts: THREE.Vector3[] = [
        _v.clone(),
        _v.clone().addScaledVector(_v2, 520),
        _v.clone().addScaledVector(_v2, 1180).addScaledVector(_radial, -14),
        // level off just above the floor, then drop into the shaft
        _v3.clone().addScaledVector(_radial, 46).addScaledVector(_v2, 300),
        _v3.clone().addScaledVector(_radial, 14).addScaledVector(_v2, 34 + i * 8),
        _v3.clone().addScaledVector(_radial, -70),
        _v3.clone().addScaledVector(_radial, -260),
      ];
      // slight lateral separation between the two torpedoes
      for (let k = 0; k < 3; k++) pts[k].addScaledVector(_v2.clone().cross(_radial).normalize(), (i === 0 ? -1 : 1) * 9);
      t.curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.2);
      t.t = 0;
      t.duration = 3.7;
      t.delay = i * 0.22;
      t.alive = true;
      t.entered = false;
      t.visual.object.visible = true;
      t.visual.setIntensity(1);
    }
    audio.torpedo();
    w.hud.radio('LUKE', 'Torpedoes away!');
    w.hud.setTorpedoes(0);
    w.director.shake.add(0.2);
  }

  private updateTorpedoes(dt: number) {
    const w = this.w;
    for (const t of w.torpedoes) {
      if (!t.alive || !t.curve) continue;
      if (t.delay > 0) { t.delay -= dt; continue; }
      const prev = _v.copy(t.pos);
      t.t = Math.min(t.t + dt, t.duration);
      const u = t.t / t.duration;
      t.curve.getPointAt(clamp(u * u * 0.22 + u * 0.78, 0, 1), t.pos);
      t.vel.copy(t.pos).sub(prev).divideScalar(Math.max(dt, 1e-4));
      t.visual.object.position.copy(t.pos);
      t.visual.update(dt, this.time, w.camera, t.vel);
      // did it pass the port mouth?
      if (!t.entered) {
        worldToTrench(t.pos, _tc);
        if (_tc.up < -TRENCH_DEPTH - 4 && Math.abs(_tc.s - PORT_S) < 260) {
          t.entered = true;
          w.fx.impact(t.pos, trenchRadial(PORT_S, _v2), COL_TORPEDO, 4);
          audio.beep(220, 0.3, 0.3);
        }
      }
      if (u >= 1) {
        t.alive = false;
        t.visual.object.visible = false;
        t.visual.setIntensity(0);
      }
    }
  }

  // ------------------------------------------------------------------ HUD
  private updateHUD(dt: number) {
    const w = this.w;
    const h = w.hud;
    h.setSpeed(w.ship.speed, w.ship.boosting);
    h.setShield(w.ship.shield);
    h.setLasers(w.ship.canFireLaser(), w.ship.laserHeat);
    h.setProgress(clamp(this.time / 215, 0, 1));
    h.setPhase(this.phase.toUpperCase());

    if (this.phase === 'targeting' || this.phase === 'torpedo') {
      h.setLock(w.lockProgress, w.locked);
      portPosition(_v);
      const d = _v.distanceTo(w.ship.position);
      h.setRange(d);
      _v2.copy(_v).project(w.camera);
      const vis = _v2.z < 1 && Math.abs(_v2.x) < 1.3 && Math.abs(_v2.y) < 1.3;
      const size = clamp(2400 / Math.max(d, 60), 26, 190);
      h.setTargetBox(_v2.x, _v2.y, size, vis, w.locked);
    } else {
      h.setRange(null);
      h.setTargetBox(0, 0, 0, false, false);
      h.setLock(0, false);
    }

    if (this.phase === 'trench' || this.phase === 'intercept') {
      // reticle sits slightly ahead of the ship's nose
      w.ship.getForward(_v);
      _v2.copy(w.ship.position).addScaledVector(_v, 900).project(w.camera);
      h.setReticle(_v2.x, _v2.y, _v2.z < 1);
    } else {
      h.setReticle(0, 0, false);
    }

    if (w.ship.hitFlash > 0.5 && this._lastFlash < this.time - 0.3) {
      this._lastFlash = this.time;
      h.flashDamage(w.ship.hitFlash);
    }
    h.setLetterbox(w.director.letterbox);
  }
  private _lastFlash = 0;

  // ------------------------------------------------------------------ radio
  private buildRadio() {
    this.radioQueue = [
      { t: 2.0, who: 'BASE', text: 'All wings report in.' },
      { t: 5.4, who: 'RED LEADER', text: 'Red Leader standing by.' },
      { t: 7.6, who: 'WEDGE', text: 'Red Two standing by.' },
      { t: 9.6, who: 'BIGGS', text: 'Red Three standing by.' },
      { t: 12.0, who: 'LUKE', text: 'Red Five standing by.' },
      { t: 18.6, who: 'RED LEADER', text: 'Lock S-foils in attack position.' },
      { t: 25.0, who: 'BASE', text: 'We are in position. Stand by.' },
      { t: 34.6, who: 'BIGGS', text: 'Enemy fighters coming in — point three five!' },
      { t: 40.0, who: 'WEDGE', text: 'They came from behind!' },
      { t: 47.0, who: 'RED LEADER', text: 'Watch it — you have got one on your tail!' },
      { t: 58.5, who: 'RED LEADER', text: 'This is it. Cut the chatter, Red Two.' },
      { t: 66.0, who: 'LUKE', text: 'Going in. Accelerating to attack speed.' },
      { t: 74.0, who: 'BEN', text: 'Use the Force, Luke.' },
      { t: 84.0, who: 'BIGGS', text: 'Hurry up, Luke — they are coming in much faster this time.' },
      { t: 96.0, who: 'WEDGE', text: 'I can hold them off. Go!' },
      { t: 112.0, who: 'BASE', text: 'Heavy fire, zone five.' },
      { t: 128.0, who: 'BIGGS', text: 'You are all clear, kid. Now blow this thing and go home!' },
    ];
  }
  private updateRadio() {
    while (this.radioIdx < this.radioQueue.length && this.radioQueue[this.radioIdx].t <= this.time) {
      const r = this.radioQueue[this.radioIdx++];
      this.w.hud.radio(r.who, r.text);
    }
    // phase-triggered lines
    if (this.phase === 'targeting' && this.phaseTime > 1.0 && !this._rt1) { this._rt1 = true; this.w.hud.radio('BEN', 'Let go, Luke.'); }
    if (this.phase === 'targeting' && this.phaseTime > 6.2 && !this._rt2) { this._rt2 = true; this.w.hud.radio('LUKE', 'Lock on. Almost there…'); }
    if (this.phase === 'escape' && this.phaseTime > 2.6 && !this._rt3) { this._rt3 = true; this.w.hud.radio('BASE', 'Great shot, kid — that was one in a million!'); }
    if (this.phase === 'destruction' && this.phaseTime > 8.5 && !this._rt4) { this._rt4 = true; this.w.hud.title('', '', 0.1); }
  }
  private _rt1 = false; private _rt2 = false; private _rt3 = false; private _rt4 = false;

  // ------------------------------------------------------------------ hit test
  makeHitTest() {
    const w = this.w;
    return (from: THREE.Vector3, to: THREE.Vector3, team: string) => {
      if (team === 'rebel') {
        const h = w.ties.hitTest(from, to);
        if (h) {
          if (w.ties.damage(h.tie, 45)) { w.ties.kill(h.tie, w.fx); this.realKills++; }
          _hit.point.copy(h.point); _hit.normal.copy(h.normal); _hit.kind = 'ship';
          return _hit;
        }
      } else {
        // does it hit the player?
        _v.copy(to).sub(from);
        const len = _v.length() || 1;
        _v.divideScalar(len);
        _v2.copy(w.ship.position).sub(from);
        const t = clamp(_v2.dot(_v), 0, len);
        _v3.copy(from).addScaledVector(_v, t);
        const d = _v3.distanceTo(w.ship.position);
        if (d < 9) {
          w.ship.takeDamage(0.09);
          w.director.shake.add(0.32);
          audio.beep(180, 0.1, 0.25);
          _hit.point.copy(_v3); _hit.normal.copy(_v3).sub(w.ship.position).normalize(); _hit.kind = 'player';
          return _hit;
        }
      }
      // world / station surface — use the trench's real drifting profile
      const r = to.length();
      if (r < DS_RADIUS + 4) {
        worldToTrench(to, _tc);
        const inRange = _tc.s > MERIDIAN_CORRIDOR_S0 && _tc.s < MERIDIAN_CORRIDOR_S1;
        if (inRange) {
          const c = centreAt(_tc.s), hw = halfWidthAt(_tc.s), fl = floorAt(_tc.s);
          const off = _tc.lateral - c;
          if (Math.abs(off) < hw && _tc.up > fl) return null;      // open trench air
          if (Math.abs(off) < hw) {                                 // through the floor
            trenchToWorld(_tc.s, _tc.lateral, fl, _hit.point);
            trenchRadial(_tc.s, _hit.normal);
            _hit.kind = 'floor';
            return _hit;
          }
          if (_tc.up < 0) {                                         // side wall
            _hit.point.copy(to);
            _hit.normal.set(0, 0, off > 0 ? -1 : 1);
            _hit.kind = 'wall';
            return _hit;
          }
          return null;
        }
        if (_tc.up < 0) {
          _hit.point.copy(to);
          _hit.normal.copy(to).normalize();
          _hit.kind = 'surface';
          return _hit;
        }
      }
      return null;
    };
  }

  /** total sequence length estimate, for the progress bar */
  get estimatedTotal() { return 215; }
}

/** kill() with no visuals — used to quietly retire fighters that left the fight */
const SILENT_FX = {
  laser() { }, explosion() { }, debrisBurst() { }, muzzleFlash() { }, sparks() { },
};

const _target = {
  position: new THREE.Vector3(),
  quaternion: new THREE.Quaternion(),
  velocity: new THREE.Vector3(),
  radius: 8,
};
