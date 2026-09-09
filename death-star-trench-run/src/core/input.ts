export class Input {
  private down = new Set<string>();
  private pressed = new Set<string>();
  pointer = { x: 0, y: 0, down: false };
  /** true as soon as the player touches any flight control */
  anyFlightInput = false;

  constructor(target: HTMLElement | Window = window) {
    addEventListener('keydown', (e) => {
      const k = e.code;
      if (!this.down.has(k)) this.pressed.add(k);
      this.down.add(k);
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(k)) e.preventDefault();
      if (FLIGHT_KEYS.has(k)) this.anyFlightInput = true;
    });
    addEventListener('keyup', (e) => { this.down.delete(e.code); });
    addEventListener('blur', () => { this.down.clear(); });
    addEventListener('pointermove', (e) => {
      this.pointer.x = (e.clientX / innerWidth) * 2 - 1;
      this.pointer.y = -((e.clientY / innerHeight) * 2 - 1);
    });
    addEventListener('pointerdown', () => { this.pointer.down = true; });
    addEventListener('pointerup', () => { this.pointer.down = false; });
  }

  isDown(...codes: string[]) { return codes.some((c) => this.down.has(c)); }
  wasPressed(...codes: string[]) { return codes.some((c) => this.pressed.has(c)); }
  /** call once per frame, at the very end */
  endFrame() { this.pressed.clear(); }

  axis(neg: string[], pos: string[]) {
    return (this.isDown(...pos) ? 1 : 0) - (this.isDown(...neg) ? 1 : 0);
  }
}
const FLIGHT_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'KeyF', 'ShiftLeft', 'ShiftRight']);
