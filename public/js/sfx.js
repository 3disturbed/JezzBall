// Procedural WebAudio SFX — no assets, everything synthesized. Volume is a
// single master gain; muted until the first user gesture unlocks the context.
let ctx = null;
let master = null;
let muted = localStorage.getItem('jb-muted') === '1';

function ensure() {
  if (!ctx) {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.5;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}
document.addEventListener('pointerdown', () => ensure(), { once: true });

function tone({ freq = 440, dur = 0.1, type = 'sine', gain = 0.3, slide = 0, delay = 0 }) {
  if (muted) return;
  const c = ensure();
  const t = c.currentTime + delay;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + dur + 0.02);
}

function noise({ dur = 0.2, gain = 0.25, delay = 0, low = false }) {
  if (muted) return;
  const c = ensure();
  const t = c.currentTime + delay;
  const len = Math.floor(c.sampleRate * dur);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = c.createBufferSource();
  src.buffer = buf;
  const g = c.createGain();
  g.gain.value = gain;
  let node = src;
  if (low) {
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 600;
    src.connect(f);
    node = f;
  }
  node.connect(g).connect(master);
  src.start(t);
}

export const sfx = {
  toggleMute() {
    muted = !muted;
    localStorage.setItem('jb-muted', muted ? '1' : '0');
    if (master) master.gain.value = muted ? 0 : 0.5;
    return muted;
  },
  click: () => tone({ freq: 700, dur: 0.05, type: 'square', gain: 0.12 }),
  thunk: () => tone({ freq: 180, dur: 0.08, type: 'triangle', gain: 0.3, slide: -60 }),
  clunk: () => {
    tone({ freq: 95, dur: 0.16, type: 'triangle', gain: 0.45, slide: -30 });
    noise({ dur: 0.08, gain: 0.1, low: true });
  },
  shatter: () => {
    noise({ dur: 0.3, gain: 0.4 });
    tone({ freq: 240, dur: 0.25, type: 'sawtooth', gain: 0.2, slide: -160 });
  },
  stun: () => tone({ freq: 130, dur: 0.2, type: 'square', gain: 0.2, slide: -40 }),
  capture: (combo = 1) => {
    const base = 320 * Math.min(combo, 4);
    [0, 4, 7, 12].forEach((semi, i) =>
      tone({ freq: base * 2 ** (semi / 12), dur: 0.12, type: 'triangle', gain: 0.22, delay: i * 0.05 })
    );
  },
  split: () => tone({ freq: 900, dur: 0.2, type: 'sawtooth', gain: 0.2, slide: -500 }),
  power: () => [440, 660, 880].forEach((f, i) => tone({ freq: f, dur: 0.1, gain: 0.2, delay: i * 0.06 })),
  hurry: () => [220, 220, 330].forEach((f, i) => tone({ freq: f, dur: 0.15, type: 'square', gain: 0.25, delay: i * 0.16 })),
  beep: () => tone({ freq: 550, dur: 0.09, gain: 0.2 }),
  go: () => tone({ freq: 880, dur: 0.25, gain: 0.3 }),
  victory: () => [523, 659, 784, 1046].forEach((f, i) => tone({ freq: f, dur: 0.25, type: 'triangle', gain: 0.25, delay: i * 0.12 })),
  defeat: () => [330, 277, 220, 165].forEach((f, i) => tone({ freq: f, dur: 0.3, type: 'triangle', gain: 0.25, delay: i * 0.15 })),
  roundEnd: () => [440, 550].forEach((f, i) => tone({ freq: f, dur: 0.2, gain: 0.2, delay: i * 0.1 })),
};
