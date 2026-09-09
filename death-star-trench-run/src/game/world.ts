import * as THREE from 'three';
import type { Engine } from '../core/engine';
import type { Input } from '../core/input';
import type { PlayerShip } from './flight';
import type { Director } from '../camera/director';

/** Everything the sequence + camera shots can reach. Loosely typed on purpose
 *  so modules stay decoupled; the concrete types are attached at boot. */
export interface World {
  engine: Engine;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  input: Input;
  ship: PlayerShip;
  director: Director;

  hud: any;
  fx: any;
  destruction: any;
  space: any;
  deathStar: any;
  trench: any;
  ties: any;
  xwing: any;
  wingmen: Wingman[];

  /** live scene objects the camera shots aim at */
  shipObj: THREE.Object3D;
  portPos: THREE.Vector3;
  stationCenter: THREE.Vector3;
  torpedoes: TorpedoRun[];

  /** nearest engaged TIE (or null) — the camera uses it to frame the dogfight */
  focus: THREE.Vector3 | null;
  focusDist: number;

  phase: string;
  phaseTime: number;
  seqTime: number;
  cinematic: boolean;
  interactive: boolean;
  trenchProgress: number;   // 0..1
  lockProgress: number;
  locked: boolean;
  destroyed: boolean;
}

export interface Wingman {
  craft: any;                    // XWing
  obj: THREE.Object3D;
  offset: THREE.Vector3;
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  alive: boolean;
  name: string;
  dieAt: number;                 // sequence time at which it is destroyed (-1 = survives)
  inTrench: boolean;
  wobble: number;
  seeded?: boolean;
}

export interface TorpedoRun {
  visual: any;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  curve: THREE.CatmullRomCurve3 | null;
  t: number;
  duration: number;
  alive: boolean;
  entered: boolean;
  delay: number;
}
