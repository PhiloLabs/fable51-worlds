/** Small, original procedural score and spacecraft soundscape. No network assets. */
export class MissionAudio {
  private ctx:AudioContext|null=null;
  private master:GainNode|null=null;
  private engine:OscillatorNode|null=null;
  private engineGain:GainNode|null=null;
  private hum:OscillatorNode[]=[];
  private lastBeat=-1;
  muted=true;
  async enable(){
    if(!this.ctx){
      this.ctx=new AudioContext(); this.master=this.ctx.createGain();this.master.gain.value=.24;this.master.connect(this.ctx.destination);
      const filter=this.ctx.createBiquadFilter();filter.type='lowpass';filter.frequency.value=420;filter.connect(this.master);
      this.engineGain=this.ctx.createGain();this.engineGain.gain.value=.075;this.engineGain.connect(filter);
      this.engine=this.ctx.createOscillator();this.engine.type='sawtooth';this.engine.frequency.value=48;this.engine.connect(this.engineGain);this.engine.start();
      for(const f of [55,82.41,110.12,164.81]){const o=this.ctx.createOscillator(),g=this.ctx.createGain();o.type='sine';o.frequency.value=f;g.gain.value=.028;o.connect(g);g.connect(this.master);o.start();this.hum.push(o)}
    }
    await this.ctx.resume();this.muted=false;this.master!.gain.setTargetAtTime(.24,this.ctx.currentTime,.2);
  }
  mute(value:boolean){this.muted=value;if(this.master&&this.ctx)this.master.gain.setTargetAtTime(value?0:.24,this.ctx.currentTime,.1)}
  update(time:number,boost:number,danger:boolean){
    if(!this.ctx||this.muted)return;
    this.engine?.frequency.setTargetAtTime(42+boost*36+(danger?18:0),this.ctx.currentTime,.25);
    const beat=Math.floor(time/(danger?.48:1.2));
    if(beat!==this.lastBeat){this.lastBeat=beat;this.tone(danger?55:41.2,'sine',.13,.11);if(beat%4===0)this.tone([220,261.63,293.66,164.81][Math.floor(beat/4)%4],'triangle',1.8,.035)}
  }
  tone(freq:number,type:OscillatorType,duration:number,volume:number,to?:number){if(!this.ctx||this.muted||!this.master)return;const o=this.ctx.createOscillator(),g=this.ctx.createGain(),t=this.ctx.currentTime;o.type=type;o.frequency.setValueAtTime(freq,t);if(to)o.frequency.exponentialRampToValueAtTime(to,t+duration);g.gain.setValueAtTime(volume,t);g.gain.exponentialRampToValueAtTime(.0001,t+duration);o.connect(g);g.connect(this.master);o.start();o.stop(t+duration);o.onended=()=>{o.disconnect();g.disconnect()}}
  laser(){this.tone(740,'sawtooth',.14,.065,95)}
  torpedo(){this.tone(150,'sine',1.2,.35,1100)}
  impact(){this.tone(90,'sawtooth',.32,.15,18)}
  explosion(){this.tone(44,'sawtooth',6,.45,12);this.tone(27,'sine',9,.45,16)}
  dispose(){void this.ctx?.close()}
}
