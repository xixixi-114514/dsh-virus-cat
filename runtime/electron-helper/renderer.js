'use strict';

/**
 * dsh-virus-cat · renderer
 * 画一只像素外的、纯手绘的桌面猫；点它会喵，点多了就变成视频里那只发光的猫。
 * 所有音效都是 WebAudio 现场合成的，不需要任何音频素材。
 */

const api = window.vc || { mode: 'cat', id: 0, kind: 'boom', ready() {}, hover() {}, click() {}, onMessage() { return () => {}; } };
const IS_FX = api.mode === 'fx';

// ---------------------------------------------------------------- 主音量
// 所有音频元素都记下自己的基准音量，滑块只改 MASTER_VOL，实际音量 = base * MASTER
let MASTER_VOL = 1;
const AUDIO_ELS = [];
function setVol(el, base) {
  if (!el) return el;
  if (AUDIO_ELS.indexOf(el) < 0) AUDIO_ELS.push(el);
  el.__base = base;
  try { el.volume = Math.max(0, Math.min(1, base * MASTER_VOL)); } catch {}
  return el;
}
function applyMasterVolume(v) {
  MASTER_VOL = Math.max(0, Math.min(1, Number(v)));
  for (const el of AUDIO_ELS) {
    try { el.volume = Math.max(0, Math.min(1, el.__base * MASTER_VOL)); } catch {}
  }
}
// 录制用底色：green → 绿幕，black → 黑底，也可以直接给 #RRGGBB；空 = 正常透明
function parseBg(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!s || s === 'none' || s === 'transparent') return '';
  if (s === 'green') return '#00fe00';
  if (s === 'black') return '#000000';
  if (s === 'white') return '#ffffff';
  return /^#?[0-9a-f]{6}$/.test(s) ? (s[0] === '#' ? s : '#' + s) : '';
}
let RECBG = parseBg(api.bg);
let PRESSED = false; // 本次按下是否已经通知过主进程（防止点菜单键被误判成点猫）
const SUN = { last: 0, t: 0 };
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');

const W = 210; // 逻辑画布边长（正方形窗口）
let unit = 1; // 逻辑单位 → CSS px
let dpr = 1;

function resize() {
  const w = Math.max(1, window.innerWidth);
  const h = Math.max(1, window.innerHeight);
  dpr = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  unit = Math.min(w, h) / W;
  ctx.setTransform(unit * dpr, 0, 0, unit * dpr, 0, 0);
}
window.addEventListener('resize', resize);

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rand = (a, b) => a + Math.random() * (b - a);
const now = () => performance.now() / 1000;

// ---------------------------------------------------------------- 喵叫声源
// 'synth' = 内置合成的喵（默认）；其它值 = 用户自放的音效文件名（assets/audio/ 下）
// 音源清音由主进程扫目录后通过 soundinit / soundset 下发：SOUNDS = [{file, base, el?}]
let MEOW_KIND = 'synth';
let SOUNDS = [];
let MEOW_EL = null;
function findSound(kind) {
  for (const s of SOUNDS) if (s.file === kind) return s;
  return null;
}
function makeSoundEl(s) {
  const el = new Audio('assets/audio/sounds/' + encodeURIComponent(s.file) + (s.v ? '?v=' + s.v : ''));
  el.preload = 'auto';
  el.__base = s.base == null ? 1 : s.base;
  return el;
}
function applySoundList() {
  for (const s of SOUNDS) {
    if (s.el) continue;
    try { s.el = makeSoundEl(s); } catch { s.el = null; }
  }
  if (MEOW_KIND !== 'synth' && !findSound(MEOW_KIND)) MEOW_KIND = 'synth';
  MEOW_EL = null;
}
function playCustomMeow(pitch = 1) {
  const s = findSound(MEOW_KIND);
  if (!s) { sfx.meow(0, 1, 1); return; }
  try {
    if (!s.el) s.el = makeSoundEl(s);
    const el = s.el;
    el.__base = s.base == null ? 1 : s.base;
    el.currentTime = 0;
    el.playbackRate = Math.max(0.8, Math.min(1.25, pitch));
    const p = el.play();
    if (p && p.catch) p.catch(() => {});
  } catch {}
}

// ------------------------------------------------------------------ 音效
class Sfx {
  constructor() {
    this.ac = null;
    this.master = null;
    this.droneHandle = null;
    this.heartTimer = 0;
  }

  ensure() {
    if (!this.ac) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this.ac = new AC();
      this.master = this.ac.createGain();
      this.master.gain.value = 0.55;
      this.master.connect(this.ac.destination);
    }
    if (this.ac.state === 'suspended') this.ac.resume().catch(() => {});
    return this.ac;
  }

  get t() {
    return this.ac ? this.ac.currentTime : 0;
  }

  band(type, freq, q) {
    const ac = this.ac;
    const f = ac.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
  }

  noiseBuffer(sec) {
    const ac = this.ac;
    const len = Math.max(1, Math.floor(ac.sampleRate * sec));
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  /** 喵。variant: 0 普通, 1 短促“咪”, 2 拉长委屈喵 */
  meow(variant = 0, pitch = 1, vol = 1) {
    const ac = this.ensure();
    if (!ac) return;
    const t0 = ac.currentTime + 0.012;
    const f0 = (300 + Math.random() * 55) * pitch * (variant === 2 ? 0.94 : 1);
    const dur = variant === 1 ? 0.32 : variant === 2 ? 0.78 : 0.5;

    const out = ac.createGain();
    out.gain.value = 0;
    out.connect(this.master);

    // 声源：正弦谐波堆叠（比锯齿暖得多），幅度按 1/n^1.2 衰减
    const src = ac.createGain();
    src.gain.value = 0.9;
    const oscs = [];
    const HARM = 11;
    for (let n = 1; n <= HARM; n++) {
      const o = ac.createOscillator();
      o.type = 'sine';
      const g = ac.createGain();
      g.gain.value = 0.52 / Math.pow(n, 1.2);
      o.frequency.value = f0 * n;
      o.connect(g).connect(src);
      oscs.push({ o, g, n });
    }

    // 基频曲线：起音略低 → 快速上扬 → 稳住 → 尾巴塌下去（"喵~"的形状）
    const curve = variant === 1 ? [0.72, 1.02, 0.98, 0.86, 0.7] : [0.58, 1.05, 1.0, 0.74, 0.5];
    const at = [0, 0.14, 0.42, 0.78, 1];
    for (const { o, n } of oscs) {
      const f = o.frequency;
      f.setValueAtTime(f0 * n * curve[0], t0);
      for (let i = 1; i < curve.length; i++) {
        f.exponentialRampToValueAtTime(f0 * n * curve[i], t0 + dur * at[i]);
      }
    }

    // 鼻音 /m/ 起音：低通从 420Hz 扫开到 4k，模拟嘴巴张开
    const nasal = ac.createBiquadFilter();
    nasal.type = 'lowpass';
    nasal.frequency.setValueAtTime(420, t0);
    nasal.frequency.exponentialRampToValueAtTime(4200, t0 + dur * 0.22);
    nasal.Q.value = 0.7;

    const mix = ac.createGain();
    mix.gain.value = 1;
    src.connect(nasal).connect(mix);

    // 颤音 + 粗糙抖动（真猫叫不是纯音）
    const vib = ac.createOscillator();
    vib.type = 'triangle';
    vib.frequency.value = rand(7.5, 11);
    const vibGain = ac.createGain();
    vibGain.gain.value = f0 * 0.022;
    vib.connect(vibGain);
    for (const { o } of oscs) vibGain.connect(o.frequency);

    const rough = ac.createOscillator();
    rough.type = 'sawtooth';
    rough.frequency.value = rand(26, 44);
    const roughGain = ac.createGain();
    roughGain.gain.value = f0 * 0.012;
    rough.connect(roughGain);
    for (const { o } of oscs) roughGain.connect(o.frequency);

    // 三个共振峰：m(a) → e → o 的滑动
    for (const [f1, f2, q, g] of [
      [760, 520, 5.2, 1.0],
      [1850, 1150, 8, 0.55],
      [3100, 2550, 10, 0.26],
    ]) {
      const bp = this.band('bandpass', f1, q);
      bp.frequency.setValueAtTime(f1, t0);
      bp.frequency.exponentialRampToValueAtTime(f2, t0 + dur * 0.85);
      const bg = ac.createGain();
      bg.gain.value = g;
      mix.connect(bp).connect(bg).connect(out);
    }

    // 气息
    const ns = ac.createBufferSource();
    ns.buffer = this.noiseBuffer(Math.min(0.6, dur));
    const nf = this.band('bandpass', 2300, 1.1);
    const ng = ac.createGain();
    ng.gain.setValueAtTime(0, t0);
    ng.gain.linearRampToValueAtTime(0.07, t0 + 0.03);
    ng.gain.exponentialRampToValueAtTime(0.0008, t0 + dur * 0.7);
    ns.connect(nf).connect(ng).connect(out);

    // 短促“咪”的颤喉
    let trill = null;
    if (variant === 1) {
      trill = ac.createOscillator();
      trill.type = 'sine';
      trill.frequency.value = 26;
      const tg = ac.createGain();
      tg.gain.value = 0.35;
      trill.connect(tg).connect(out.gain);
    }

    const peak = 0.32 * vol;
    out.gain.setValueAtTime(0, t0);
    out.gain.linearRampToValueAtTime(peak, t0 + 0.03);
    out.gain.linearRampToValueAtTime(peak * 0.85, t0 + dur * 0.4);
    out.gain.exponentialRampToValueAtTime(0.0012, t0 + dur);

    vib.start(t0);
    rough.start(t0);
    for (const { o } of oscs) o.start(t0);
    ns.start(t0);
    if (trill) trill.start(t0);
    const stop = t0 + dur + 0.1;
    vib.stop(stop);
    rough.stop(stop);
    for (const { o } of oscs) o.stop(stop);
    ns.stop(stop);
    if (trill) trill.stop(stop);
  }

  /** 低音持续轰鸣（恐怖段落） */
  drone(on, level = 0.5) {
    const ac = this.ensure();
    if (!ac) return;
    if (!on) {
      if (this.droneHandle) {
        const h = this.droneHandle;
        this.droneHandle = null;
        try {
          h.gain.gain.cancelScheduledValues(ac.currentTime);
          h.gain.gain.setTargetAtTime(0, ac.currentTime, 0.4);
          setTimeout(() => h.nodes.forEach((n) => { try { n.stop(); } catch {} }), 1600);
        } catch {}
      }
      return;
    }
    if (this.droneHandle) return;
    const t0 = ac.currentTime;
    const gain = ac.createGain();
    gain.gain.value = 0;
    gain.gain.setTargetAtTime(0.12 * level, t0, 0.8);
    gain.connect(this.master);
    const lp = this.band('lowpass', 420, 0.8);
    lp.connect(gain);
    const nodes = [];
    for (const [freq, type, amp] of [
      [55, 'sine', 0.55],
      [58.6, 'sawtooth', 0.22],
      [110.4, 'triangle', 0.14],
      [164.8, 'sine', 0.06],
    ]) {
      const o = ac.createOscillator();
      o.type = type;
      o.frequency.value = freq;
      const g = ac.createGain();
      g.gain.value = amp;
      o.connect(g).connect(lp);
      o.start(t0);
      nodes.push(o);
    }
    // 缓慢起伏
    const lfo = ac.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.17;
    const lg = ac.createGain();
    lg.gain.value = 0.05 * level;
    lfo.connect(lg).connect(gain.gain);
    lfo.start(t0);
    nodes.push(lfo);
    this.droneHandle = { gain, nodes };
  }

  /** 心跳 */
  heartbeat(on) {
    const ac = this.ensure();
    if (!ac) return;
    if (!on) {
      if (this.heartTimer) clearInterval(this.heartTimer);
      this.heartTimer = 0;
      return;
    }
    if (this.heartTimer) return;
    const thump = (vol) => {
      const ac2 = this.ensure();
      if (!ac2) return;
      const t0 = ac2.currentTime;
      const o = ac2.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(78, t0);
      o.frequency.exponentialRampToValueAtTime(38, t0 + 0.16);
      const g = ac2.createGain();
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(0.32 * vol, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0006, t0 + 0.22);
      o.connect(g).connect(this.master);
      o.start(t0);
      o.stop(t0 + 0.26);
    };
    thump(1);
    this.heartTimer = setInterval(() => {
      thump(1);
      setTimeout(() => thump(0.55), 190);
    }, 760);
  }

  /** 升级提示音 */
  riser(level = 1) {
    const ac = this.ensure();
    if (!ac) return;
    const t0 = ac.currentTime;
    const o = ac.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(180, t0);
    o.frequency.exponentialRampToValueAtTime(900 + 300 * level, t0 + 0.5);
    const g = ac.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.1, t0 + 0.08);
    g.gain.exponentialRampToValueAtTime(0.0005, t0 + 0.6);
    const bp = this.band('bandpass', 900, 2);
    o.connect(bp).connect(g).connect(this.master);
    o.start(t0);
    o.stop(t0 + 0.62);
  }

  /** 故障噪声 */
  glitch(vol = 1) {
    const ac = this.ensure();
    if (!ac) return;
    const t0 = ac.currentTime;
    const src = ac.createBufferSource();
    src.buffer = this.noiseBuffer(0.18);
    const hp = this.band('highpass', 1200, 0.7);
    const g = ac.createGain();
    g.gain.setValueAtTime(0, t0);
    for (let i = 0; i < 6; i++) {
      g.gain.setValueAtTime(Math.random() * 0.18 * vol, t0 + i * 0.028);
    }
    g.gain.linearRampToValueAtTime(0.0008, t0 + 0.18);
    src.connect(hp).connect(g).connect(this.master);
    src.start(t0);
    src.stop(t0 + 0.2);
  }

  /** 爆炸 */
  // 撞墙"Q 弹"的闷响：短促低频 + 一点噪声
  thud(vol = 1) {
    const ac = this.ensure();
    if (!ac) return;
    const t0 = ac.currentTime;
    const o = ac.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(190, t0);
    o.frequency.exponentialRampToValueAtTime(70, t0 + 0.12);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(0.22 * vol, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0005, t0 + 0.18);
    o.connect(g).connect(this.master);
    o.start(t0);
    o.stop(t0 + 0.2);
    const ns = ac.createBufferSource();
    ns.buffer = this.noiseBuffer(0.2);
    const bp = ac.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 900;
    bp.Q.value = 1.2;
    const ng = ac.createGain();
    ng.gain.setValueAtTime(0.12 * vol, t0);
    ng.gain.exponentialRampToValueAtTime(0.0004, t0 + 0.13);
    ns.connect(bp).connect(ng).connect(this.master);
    ns.start(t0);
    ns.stop(t0 + 0.16);
  }

  boom(vol = 1) {
    const ac = this.ensure();
    if (!ac) return;
    const t0 = ac.currentTime;
    // 低频冲击
    const sub = ac.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(150, t0);
    sub.frequency.exponentialRampToValueAtTime(32, t0 + 1.1);
    const sg = ac.createGain();
    sg.gain.setValueAtTime(0.0001, t0);
    sg.gain.linearRampToValueAtTime(0.85 * vol, t0 + 0.02);
    sg.gain.exponentialRampToValueAtTime(0.0006, t0 + 1.3);
    sub.connect(sg).connect(this.master);
    sub.start(t0);
    sub.stop(t0 + 1.35);
    // 噪声爆裂
    const ns = ac.createBufferSource();
    ns.buffer = this.noiseBuffer(1.6);
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(5200, t0);
    lp.frequency.exponentialRampToValueAtTime(240, t0 + 1.4);
    const ng = ac.createGain();
    ng.gain.setValueAtTime(0.0001, t0);
    ng.gain.linearRampToValueAtTime(0.5 * vol, t0 + 0.03);
    ng.gain.exponentialRampToValueAtTime(0.0005, t0 + 1.6);
    ns.connect(lp).connect(ng).connect(this.master);
    ns.start(t0);
    ns.stop(t0 + 1.7);
  }
}

const sfx = new Sfx();

// ------------------------------------------------------------------ 状态
const S = {
  tier: 0,
  heat: 0,
  dir: 1,
  mode: 'drift',
  squash: 0,
  bounce: 0,
  bounceHoriz: false,
  shake: 0,
  dying: false,
  t: 0, // 由主进程提供，用于让动画同步
  local: Math.random() * 100,
  blinkIn: rand(1.6, 4.2),
  blink: 0,
  pops: [],
  embers: [],
  hover: false,
  girlSeed: Math.random() * 100,
  girlFlash: 0,
  boomFlash: 0,
  lastTier: 0,
  idleMeowIn: rand(14, 30),
  lastGlitch: 0,
  started: false,
  glitchFlash: 0,
  vx: 0,
  vy: 0,
  spin: 0,
  spinVel: 0,
  spinning: false,
  spinIdx: 0,
  spinAcc: 0,
  musicT: 0,
  playStage: 0,
  noGlow: false,
  sun: 0,
  dash: false,
  seqAt: 0,
  musicOn: false,
  sceneAudioOn: false,
  idleAnim: false,
};

// ------------------------------------------------------------------ 声音
// 不再单独放 BGM：直接用两个旋转视频自带的音轨。第一次点击后才允许出声。
function startMusic() {
  if (S.musicOn) return;
  S.musicOn = true;
  for (const v of [VID.v1, VID.v2]) {
    if (!v) continue;
    v.muted = false;
    setVol(v, 0);
  }
  // 在用户手势里先把复合音频创建并试播一下，解锁后面的自动播放
  if (!runAudio) {
    try {
      runAudio = new Audio('assets/audio/scene2345678.mp3');
      runAudio.loop = false;
      setVol(runAudio, 0.85);
    } catch {
      runAudio = null;
    }
  }
  if (runAudio) {
    try {
      const pr = runAudio.play();
      if (pr && pr.then) pr.then(() => { runAudio.pause(); runAudio.currentTime = 0; }).catch(() => {});
      else { runAudio.pause(); runAudio.currentTime = 0; }
    } catch {}
  }
}

// 第二段 + 第三段共用一条音频（scene23.mp3，25.50s）：
// 第二段一开始就播，跑到跑图阶段时不重头放，所以两段之间是连续的
let runAudio = null;
function startRunAudio() {
  if (S.sceneAudioOn) return;
  S.sceneAudioOn = true;
  if (!runAudio) {
    try {
      runAudio = new Audio('assets/audio/scene2345678.mp3');
      runAudio.loop = false;
      setVol(runAudio, 0.85);
    } catch {
      runAudio = null;
    }
  }
  if (!runAudio) return;
  try {
    runAudio.currentTime = 0;
    const p = runAudio.play();
    if (p && p.catch) p.catch(() => {});
  } catch {}
  setTimeout(() => {
    try {
      api.dbg({ kind: 'scene-audio', paused: !!runAudio.paused, t: Number(runAudio.currentTime.toFixed(2)), err: runAudio.error ? runAudio.error.code : 0 });
    } catch {}
  }, 500);
}
function stopRunAudio() {
  S.sceneAudioOn = false;
  if (!runAudio) return;
  try {
    runAudio.pause();
    runAudio.currentTime = 0;
    api.dbg({ kind: 'scene-audio-stop', paused: !!runAudio.paused, t: Number(runAudio.currentTime.toFixed(2)) });
  } catch {}
}

// 第四段音频（分数音频.mp3，1.54s）：接在第二+第三段放完之后
let scoreAudio = null;
function startScoreAudio() {
  stopRunAudio();
  S.scoreAudioOn = true;
  if (!scoreAudio) {
    try {
      scoreAudio = new Audio('assets/audio/score.mp3');
      scoreAudio.loop = false;
      setVol(scoreAudio, 0.85);
    } catch {
      scoreAudio = null;
    }
  }
  if (!scoreAudio) return;
  try {
    scoreAudio.currentTime = 0;
    const p = scoreAudio.play();
    if (p && p.catch) p.catch(() => {});
  } catch {}
  setTimeout(() => {
    try {
      api.dbg({ kind: 'score-audio', paused: !!scoreAudio.paused, t: Number(scoreAudio.currentTime.toFixed(2)), err: scoreAudio.error ? scoreAudio.error.code : 0 });
    } catch {}
  }, 400);
}
function stopScoreAudio() {
  S.scoreAudioOn = false;
  if (!scoreAudio) return;
  try {
    scoreAudio.pause();
    scoreAudio.currentTime = 0;
  } catch {}
}

// 第五段音频（assets/audio/stage5.mp3，3.00s）：第四段放完接着放，猫不发光、继续旋转
let stage5Audio = null;
function startStage5Audio() {
  stopRunAudio();
  stopScoreAudio();
  if (!stage5Audio) {
    try {
      stage5Audio = new Audio('assets/audio/stage5.mp3');
      stage5Audio.loop = false;
      setVol(stage5Audio, 0.9);
    } catch {
      stage5Audio = null;
    }
  }
  if (!stage5Audio) return;
  try {
    stage5Audio.currentTime = 0;
    const p = stage5Audio.play();
    if (p && p.catch) p.catch(() => {});
  } catch {}
  setTimeout(() => {
    try {
      api.dbg({ kind: 'stage5-audio', paused: !!stage5Audio.paused, t: Number(stage5Audio.currentTime.toFixed(2)), err: stage5Audio.error ? stage5Audio.error.code : 0 });
    } catch {}
  }, 400);
}
// 第七段音频（assets/audio/stage7.mp3，3.24s）：三只猫一起播放旋转视频
let stage7Audio = null;
function startStage7Audio() {
  try {
    if (!stage7Audio) {
      stage7Audio = new Audio('assets/audio/stage7.mp3');
      stage7Audio.loop = false;
      setVol(stage7Audio, 0.9);
    }
  } catch {
    stage7Audio = null;
  }
  if (!stage7Audio) return;
  try {
    stage7Audio.currentTime = 0;
    const p = stage7Audio.play();
    if (p && p.catch) p.catch(() => {});
  } catch {}
  setTimeout(() => {
    try {
      api.dbg({ kind: 'stage7-audio', paused: !!stage7Audio.paused, t: Number(stage7Audio.currentTime.toFixed(2)), err: stage7Audio.error ? stage7Audio.error.code : 0 });
    } catch {}
  }, 500);
}


// 第八段音频（assets/audio/stage8.mp3，2.53s）：四只猫先静态 0.2s，再一起播旋转视频到音频结束
let stage8Audio = null;
function startStage8Audio() {
  try {
    if (!stage8Audio) {
      stage8Audio = new Audio('assets/audio/stage8.mp3');
      stage8Audio.loop = false;
      setVol(stage8Audio, 0.9);
    }
  } catch {
    stage8Audio = null;
  }
  if (!stage8Audio) return;
  // 音频一放完立刻通知主进程收工：和声音同一时刻四只一起消失
  try {
    stage8Audio.onended = () => {
      try { api.stage8Ended(); } catch {}
    };
  } catch {}
  try {
    stage8Audio.currentTime = 0;
    const p = stage8Audio.play();
    if (p && p.catch) p.catch(() => {});
  } catch {}
  setTimeout(() => {
    try {
      api.dbg({ kind: 'stage8-audio', paused: !!stage8Audio.paused, t: Number(stage8Audio.currentTime.toFixed(2)), err: stage8Audio.error ? stage8Audio.error.code : 0 });
    } catch {}
  }, 500);
}

function stopStage8Audio() {
  try {
    if (!stage8Audio) return;
    stage8Audio.pause();
    stage8Audio.currentTime = 0;
  } catch {}
}function stopStage7Audio() {
  try {
    if (!stage7Audio) return;
    stage7Audio.pause();
    stage7Audio.currentTime = 0;
  } catch {}
}
// 第六段音频（assets/audio/stage6.mp3，3.29s）：两只猫一起播放旋转视频
let stage6Audio = null;
function startStage6Audio() {
  try {
    if (!stage6Audio) {
      stage6Audio = new Audio('assets/audio/stage6.mp3');
      stage6Audio.loop = false;
      setVol(stage6Audio, 0.9);
    }
  } catch {
    stage6Audio = null;
  }
  if (!stage6Audio) return;
  try {
    stage6Audio.currentTime = 0;
    const p = stage6Audio.play();
    if (p && p.catch) p.catch(() => {});
  } catch {}
  setTimeout(() => {
    try {
      api.dbg({ kind: 'stage6-audio', paused: !!stage6Audio.paused, t: Number(stage6Audio.currentTime.toFixed(2)), err: stage6Audio.error ? stage6Audio.error.code : 0 });
    } catch {}
  }, 500);
}

function stopStage6Audio() {
  try {
    if (!stage6Audio) return;
    stage6Audio.pause();
    stage6Audio.currentTime = 0;
  } catch {}
}

function stopStage5Audio() {
  if (!stage5Audio) return;
  try {
    stage5Audio.pause();
    stage5Audio.currentTime = 0;
  } catch {}
}

// ------------------------------------------------------------------ 调色
function palette(tier) {
  if (tier >= 2) {
    return {
      fur: '#fffdf4',
      furShade: '#efe6c8',
      belly: '#ffffff',
      stripe: '#e4d3a0',
      outline: '#a8791a',
      ear: '#fff8e6',
      earInner: '#ffdf8a',
      nose: '#ff9ab8',
      eye: '#fffbe0',
      pupil: '#8a5f00',
      glow: '#ffc821',
      glowStrength: 16,
      whisker: '#fff3c4',
      blush: 'rgba(255,190,90,0.4)',
    };
  }
  if (tier >= 1) {
    return {
      fur: '#e3ad6d',
      furShade: '#cf9754',
      belly: '#fbf0da',
      stripe: '#a46c2e',
      outline: '#74451a',
      ear: '#eeb0b6',
      earInner: '#f6c3c9',
      nose: '#e8879a',
      eye: '#ffe27a',
      pupil: '#5a4210',
      glow: '#ffcb45',
      glowStrength: 14,
      whisker: '#fff4e0',
      blush: 'rgba(232,135,154,0.28)',
    };
  }
  return {
    fur: '#d9a05c',
    furShade: '#c4894a',
    belly: '#f7e7c8',
    stripe: '#a9702f',
    outline: '#6b431d',
    ear: '#e8a8ae',
    earInner: '#f3b6bd',
    nose: '#e8879a',
    eye: '#ffffff',
    pupil: '#33251a',
    glow: '#ffd84a',
    glowStrength: 0,
    whisker: '#f6ecd8',
    blush: 'rgba(227,150,160,0.25)',
  };
}

// ------------------------------------------------------------------ 猫素材
// 想用自己的猫图：把图片丢进 runtime/electron-helper/assets/ 目录，名字用
// cat.png / cat.webp / cat.jpg 之一即可（有透明背景最好；要是白底图，
// 会自动把四角的那种底色抠掉）。没有文件时用下面手绘的猫。
let CAT_SRC = null; // 处理好的 canvas
let catImgReady = false;
const tintCache = new Map();

// 旋转视频（assets/video/spin1.mp4 / spin2.mp4，绿幕）：点热之后依次播放
// 播放时逐帧抠绿：drawImage(video) -> getImageData -> 去绿 -> putImageData -> drawImage(canvas)
const VID = { stage: 0, canvas: null, ctx: null, v1: null, v2: null, lastT: -1 };
(function setupVideos() {
  const mk = (src) => {
    const v = document.createElement('video');
    v.src = src;
    v.muted = true;
    v.loop = false;
    v.playsInline = true;
    v.preload = 'auto';
    v.style.cssText = 'position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
    document.body.appendChild(v);
    return v;
  };
  VID.v1 = mk('assets/video/spin1.mp4');
  VID.v2 = mk('assets/video/spin2.mp4');
  VID.canvas = document.createElement('canvas');
  VID.canvas.width = 320;
  VID.canvas.height = 320;
  VID.ctx = VID.canvas.getContext('2d', { willReadFrequently: true });
})();

function setVideoStage(n) {
  // 不做早退：每次都把"该播的播、该停的停"重新钉一遍，
  // 否则 stage 没变但某个 <video> 被别处 play() 起来时会一直静音播下去。
  const changed = VID.stage !== n;
  VID.stage = n;
  if (!changed) {
    for (const [idx, v] of [[1, VID.v1], [2, VID.v2]]) {
      if (!v) continue;
      try {
        if (n > 0 && idx === n) { if (v.paused) void v.play(); }
        else { if (!v.paused) v.pause(); }
      } catch {}
    }
    return;
  }
  const nv = n === 2 ? VID.v2 : VID.v1;
  api.dbg({ kind: 'video-stage', n: n, muted: nv ? nv.muted : null, vol: nv ? nv.volume : null, decoded: nv ? nv.webkitAudioDecodedByteCount : null });
  for (const [idx, v] of [[1, VID.v1], [2, VID.v2]]) {
    if (!v) continue;
    if (n > 0 && idx === n) {
      try {
        v.currentTime = 0;
      } catch {}
      const p = v.play();
      if (p && p.catch) p.catch(() => {});
    } else {
      try {
        v.pause();
      } catch {}
    }
  }
}

function keyedVideoFramebuffer() {
  const v = VID.stage === 2 ? VID.v2 : VID.v1;
  if (!v || v.readyState < 2 || !v.videoWidth) return null;
  const c = VID.ctx;
  if (!c) return null;
  // 同一帧不重复抠（视频 30fps，画布 60fps）
  if (v.currentTime === VID.lastT) return VID.canvas;
  VID.lastT = v.currentTime;
  const W = VID.canvas.width;
  const H = VID.canvas.height;
  c.clearRect(0, 0, W, H);
  c.drawImage(v, 0, 0, W, H);
  if (VID.stage === 0) return null;
  let data;
  try {
    data = c.getImageData(0, 0, W, H);
  } catch {
    return VID.canvas;
  }
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i];
    const g = px[i + 1];
    const b = px[i + 2];
    const mx = r > b ? r : b;
    const dom = g - mx;
    if (dom > 26) {
      px[i + 3] = 0;
    } else if (dom > 6) {
      const k = (26 - dom) / 20;
      px[i + 3] = Math.round(px[i + 3] * k);
      px[i + 1] = mx + 3;
    } else if (dom > 0) {
      px[i + 1] = mx + 3;
    }
  }
  c.putImageData(data, 0, 0);
  return VID.canvas;
}
// 旧方案：GIF 拆帧（assets/spin/f00..f14.png），现在改成放视频，帧序列留着备用
const SPIN_FRAMES = [];
const SPIN_COUNT = 15;
const spinTintCache = new Map();
(function loadSpinFrames() {
  for (let i = 0; i < SPIN_COUNT; i++) {
    const img = new Image();
    img.src = 'assets/spin/f' + String(i).padStart(2, '0') + '.png';
    SPIN_FRAMES.push(img);
  }
})();
function spinFrameReady() {
  for (let i = 0; i < SPIN_FRAMES.length; i++) {
    const im = SPIN_FRAMES[i];
    if (im && im.complete && im.naturalWidth > 0) return true;
  }
  return false;
}
function spinFrame() {
  const f = SPIN_FRAMES[S.spinIdx % SPIN_FRAMES.length];
  if (f && f.complete && f.naturalWidth > 0) return f;
  return null;
}
function tintedSpin(color) {
  const f = spinFrame();
  if (!f) return null;
  const k = S.spinIdx + '|' + color;
  let cv = spinTintCache.get(k);
  if (cv) return cv;
  cv = document.createElement('canvas');
  cv.width = f.naturalWidth;
  cv.height = f.naturalHeight;
  const g = cv.getContext('2d');
  g.drawImage(f, 0, 0);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = color;
  g.fillRect(0, 0, cv.width, cv.height);
  spinTintCache.set(k, cv);
  return cv;
}

function loadCatAsset(paths) {
  if (!paths.length) return;
  const img = new Image();
  img.onload = () => prepareCatImage(img);
  img.onerror = () => loadCatAsset(paths.slice(1));
  img.src = paths[0];
}

function prepareCatImage(img) {
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (!w || !h) return;
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  let keyed = false;
  try {
    const data = g.getImageData(0, 0, w, h);
    const px = data.data;
    const at = (x, y) => (y * w + x) * 4;
    const corners = [at(0, 0), at(w - 1, 0), at(0, h - 1), at(w - 1, h - 1)];
    const opaque = corners.every((i) => px[i + 3] > 240);
    if (opaque) {
      let r = 0;
      let gg = 0;
      let b = 0;
      for (const i of corners) {
        r += px[i];
        gg += px[i + 1];
        b += px[i + 2];
      }
      r /= 4;
      gg /= 4;
      b /= 4;
      for (let i = 0; i < px.length; i += 4) {
        const dr = px[i] - r;
        const dg = px[i + 1] - gg;
        const db = px[i + 2] - b;
        if (Math.sqrt(dr * dr + dg * dg + db * db) < 56) px[i + 3] = 0;
      }
      g.putImageData(data, 0, 0);
      keyed = true;
    }
  } catch {
    /* 读像素失败就原样用 */
  }
  CAT_SRC = cv;
  catImgReady = true;
  tintCache.clear();
  api.dbg({ kind: 'cat-image', w, h, keyed });
}

loadCatAsset(['assets/cat.png', 'assets/cat.webp', 'assets/cat.jpg', 'assets/cat.gif']);

function tintedCat(color) {
  if (tintCache.has(color)) return tintCache.get(color);
  const cv = document.createElement('canvas');
  cv.width = CAT_SRC ? CAT_SRC.width : 2;
  cv.height = CAT_SRC ? CAT_SRC.height : 2;
  const g = cv.getContext('2d');
  if (CAT_SRC) g.drawImage(CAT_SRC, 0, 0);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = color;
  g.fillRect(0, 0, cv.width, cv.height);
  tintCache.set(color, cv);
  return cv;
}

// ------------------------------------------------------------------ 绘制：猫
function drawTail(c, p, t, moving) {
  const sway = Math.sin(t * (moving ? 7.5 : 2.4) + 0.6) * (moving ? 7 : 10);
  c.save();
  c.strokeStyle = p.fur;
  c.lineWidth = 11;
  c.lineCap = 'round';
  c.beginPath();
  c.moveTo(-26, -26);
  c.quadraticCurveTo(-56, -30 + sway * 0.4, -50 - sway * 0.35, -66 + sway);
  c.stroke();
  // 尾巴条纹
  c.strokeStyle = p.stripe;
  c.lineWidth = 4;
  c.lineCap = 'butt';
  c.beginPath();
  c.moveTo(-42, -38 + sway * 0.35);
  c.lineTo(-40, -47 + sway * 0.5);
  c.stroke();
  c.beginPath();
  c.moveTo(-48 - sway * 0.2, -52 + sway * 0.75);
  c.lineTo(-46 - sway * 0.2, -60 + sway * 0.85);
  c.stroke();
  // 尾巴尖（和视频里一样是白色的）
  c.fillStyle = p.tier >= 2 ? '#ffffff' : '#f4e2c0';
  c.beginPath();
  c.arc(-50 - sway * 0.35, -66 + sway, 5.4, 0, Math.PI * 2);
  c.fill();
  c.restore();
}

function drawLegs(c, p, t, moving) {
  const phase = t * 10;
  const swing = moving ? Math.sin(phase) * 5 : 0;
  const swing2 = moving ? Math.cos(phase) * 5 : 0;
  const legs = [
    [-18 - swing * 0.5, -10, 11, 15],
    [16 + swing * 0.5, -10, 11, 15],
    [-25 + swing2 * 0.4, -12, 10, 14],
    [23 - swing2 * 0.4, -12, 10, 14],
  ];
  for (const [x, y, w, h] of legs) {
    c.fillStyle = p.fur;
    c.strokeStyle = p.outline;
    c.lineWidth = 2;
    roundRect(c, x - w / 2, y, w, h, 5);
    c.fill();
    c.stroke();
    // 小爪子
    c.fillStyle = p.belly;
    roundRect(c, x - w / 2 + 2, y + h - 4.5, w - 4, 4, 2);
    c.fill();
  }
}

function roundRect(c, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + rr, y);
  c.arcTo(x + w, y, x + w, y + h, rr);
  c.arcTo(x + w, y + h, x, y + h, rr);
  c.arcTo(x, y + h, x, y, rr);
  c.arcTo(x, y, x + w, y, rr);
  c.closePath();
}

function drawHead(c, p, t) {
  // 耳朵
  c.fillStyle = p.fur;
  c.strokeStyle = p.outline;
  c.lineWidth = 2;
  for (const sx of [-1, 1]) {
    c.beginPath();
    c.moveTo(sx * 22, -74);
    c.lineTo(sx * 12, -96);
    c.lineTo(sx * 2, -78);
    c.closePath();
    c.fill();
    c.stroke();
    c.fillStyle = p.earInner;
    c.beginPath();
    c.moveTo(sx * 19, -76);
    c.lineTo(sx * 12.5, -89);
    c.lineTo(sx * 6.5, -79);
    c.closePath();
    c.fill();
    c.fillStyle = p.fur;
  }

  // 头
  c.fillStyle = p.fur;
  c.strokeStyle = p.outline;
  c.lineWidth = 2;
  c.beginPath();
  c.ellipse(0, -64, 26, 23, 0, 0, Math.PI * 2);
  c.fill();
  c.stroke();

  // 额头条纹
  c.strokeStyle = p.stripe;
  c.lineWidth = 3.2;
  c.lineCap = 'round';
  c.beginPath();
  c.moveTo(-6, -84);
  c.lineTo(-4, -78);
  c.moveTo(1, -86);
  c.lineTo(1.5, -78);
  c.moveTo(8, -84);
  c.lineTo(6, -78);
  c.stroke();

  // 腮红
  c.fillStyle = p.blush;
  c.beginPath();
  c.ellipse(-17, -58, 6.2, 4.2, 0, 0, Math.PI * 2);
  c.ellipse(17, -58, 6.2, 4.2, 0, 0, Math.PI * 2);
  c.fill();

  // 眼睛
  const eyeY = -66;
  const closed = S.blink > 0 || S.dying;
  for (const sx of [-1, 1]) {
    if (closed) {
      c.strokeStyle = p.pupil;
      c.lineWidth = 2.6;
      c.beginPath();
      c.arc(sx * 10, eyeY, 6, 0.25 * Math.PI, 0.75 * Math.PI);
      c.stroke();
      continue;
    }
    c.fillStyle = p.eye;
    c.beginPath();
    c.ellipse(sx * 10, eyeY, 7, 7.6, 0, 0, Math.PI * 2);
    c.fill();
    if (S.tier >= 1) {
      c.save();
      c.shadowColor = p.glow;
      c.shadowBlur = 12 + S.tier * 4;
      c.fillStyle = p.eye;
      c.beginPath();
      c.ellipse(sx * 10, eyeY, 7, 7.6, 0, 0, Math.PI * 2);
      c.fill();
      c.restore();
    }
    c.fillStyle = p.pupil;
    c.beginPath();
    c.ellipse(sx * 10 + S.dir * 1.6, eyeY + 0.6, 3.6, 5.4, 0, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = 'rgba(255,255,255,0.92)';
    c.beginPath();
    c.arc(sx * 10 + 2.6, eyeY - 2.6, 1.9, 0, Math.PI * 2);
    c.fill();
  }

  // 鼻子 + 嘴
  c.fillStyle = p.nose;
  c.beginPath();
  c.moveTo(-2.6, -55);
  c.lineTo(2.6, -55);
  c.lineTo(0, -51.6);
  c.closePath();
  c.fill();
  c.strokeStyle = p.outline;
  c.lineWidth = 1.6;
  c.beginPath();
  c.moveTo(0, -51.6);
  c.lineTo(0, -49.4);
  c.stroke();
  c.beginPath();
  c.arc(-3.1, -49.4, 3.1, 0.1 * Math.PI, 0.9 * Math.PI);
  c.arc(3.1, -49.4, 3.1, 0.1 * Math.PI, 0.9 * Math.PI);
  c.stroke();

  // 胡须
  c.strokeStyle = p.whisker;
  c.lineWidth = 1.2;
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      c.beginPath();
      c.moveTo(sx * 12, -57 + i * 3);
      c.quadraticCurveTo(sx * 26, -58 + i * 4.2, sx * 33, -55 + i * 5.4);
      c.stroke();
    }
  }
}

function drawCat(c) {
  if (catImgReady) {
    drawCatImage(c);
    return;
  }
  const p = palette(S.tier);
  const t = S.local;
  const moving = S.mode === 'dart' || S.mode === 'drift' || S.mode === 'edge';
  const bob = moving ? Math.sin(t * 11) * 2.2 : Math.sin(t * 2.1) * 1.1;
  const dyingK = S.dying ? 1 : 0;

  c.save();
  c.translate(105, 156 - dyingK * 12);
  // 点击压扁
  const sq = S.squash;
  c.scale(1 + sq * 0.17, 1 - sq * 0.17);
  if (S.dir < 0) c.scale(-1, 1);
  c.translate(0, bob);

  // 地面阴影
  c.save();
  c.globalAlpha = 0.22 * (1 - dyingK * 0.8);
  const sg = c.createRadialGradient(0, 4, 2, 0, 4, 34);
  sg.addColorStop(0, 'rgba(0,0,0,0.75)');
  sg.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = sg;
  c.beginPath();
  c.ellipse(0, 5, 34, 9, 0, 0, Math.PI * 2);
  c.fill();
  c.restore();

  // 发光
  if (p.glowStrength > 0) {
    c.save();
    c.shadowColor = p.glow;
    c.shadowBlur = p.glowStrength;
    c.globalAlpha = 0.95;
  }

  drawTail(c, p, t, moving);
  drawLegs(c, p, t, moving);

  // 身体
  c.fillStyle = p.fur;
  c.strokeStyle = p.outline;
  c.lineWidth = 2;
  c.beginPath();
  c.ellipse(0, -32, 33, 25, 0, 0, Math.PI * 2);
  c.fill();
  c.stroke();

  // 肚皮
  c.fillStyle = p.belly;
  c.beginPath();
  c.ellipse(2, -24, 20, 13, 0, 0, Math.PI * 2);
  c.fill();

  // 背部条纹
  c.strokeStyle = p.stripe;
  c.lineWidth = 3.4;
  c.lineCap = 'round';
  c.beginPath();
  c.moveTo(-16, -48);
  c.lineTo(-13, -39);
  c.moveTo(-5, -53);
  c.lineTo(-3, -43);
  c.moveTo(7, -52);
  c.lineTo(8, -42);
  c.stroke();

  drawHead(c, p, t);

  if (p.glowStrength > 0) c.restore();
  c.restore();
}

// ------------------------------------------------------------------ 绘制：女孩
function girlAlpha(t) {
  if (S.tier < 3) return 0;
  const seed = S.girlSeed;
  const slow = Math.sin(t * 0.63 + seed);
  const fast = Math.sin(t * 13.7 + seed * 1.7);
  const mid = Math.sin(t * 3.1 + seed * 0.6);
  let a = 0;
  if (slow > -0.35) a = 0.52 + 0.3 * fast;
  if (mid > 0.86) a = 0.95;
  return clamp(a, 0, 0.97);
}

function drawGirl(c, t) {
  const a = girlAlpha(t);
  if (a < 0.02) return;
  const jx = Math.sin(t * 21) * 1.6 + (S.hover ? 0 : 1);
  const jy = Math.cos(t * 17) * 1.2;
  c.save();
  c.globalAlpha = a;
  c.translate(105 + jx, 108 + jy);

  // 后面的头发
  c.fillStyle = '#241f28';
  c.beginPath();
  c.ellipse(0, -2, 30, 36, 0, 0, Math.PI * 2);
  c.fill();
  // 双马尾
  c.beginPath();
  c.ellipse(-30, 8, 8, 20, -0.28, 0, Math.PI * 2);
  c.ellipse(30, 8, 8, 20, 0.28, 0, Math.PI * 2);
  c.fill();

  // 脸
  const fg = c.createRadialGradient(0, -4, 4, 0, -2, 30);
  fg.addColorStop(0, '#efe6d2');
  fg.addColorStop(0.7, '#ded2b8');
  fg.addColorStop(1, '#b7a888');
  c.fillStyle = fg;
  c.beginPath();
  c.ellipse(0, -2, 24, 29, 0, 0, Math.PI * 2);
  c.fill();

  // 刘海
  c.fillStyle = '#241f28';
  c.beginPath();
  c.moveTo(-24, -18);
  c.quadraticCurveTo(0, -40, 24, -18);
  c.quadraticCurveTo(12, -22, 2, -14);
  c.quadraticCurveTo(-8, -24, -24, -18);
  c.fill();

  // 眼窝
  c.fillStyle = '#171318';
  c.beginPath();
  c.ellipse(-9.5, -4, 6.4, 8.2, 0, 0, Math.PI * 2);
  c.ellipse(9.5, -4, 6.4, 8.2, 0, 0, Math.PI * 2);
  c.fill();
  // 眼中一点点白
  c.fillStyle = 'rgba(255,255,255,0.9)';
  c.beginPath();
  c.arc(-8.2, -6.4, 1.5, 0, Math.PI * 2);
  c.arc(10.8, -6.4, 1.5, 0, Math.PI * 2);
  c.fill();
  // 嘴
  c.strokeStyle = '#5b4a46';
  c.lineWidth = 1.5;
  c.beginPath();
  c.moveTo(-4, 12);
  c.quadraticCurveTo(0, 14.4, 4, 12);
  c.stroke();

  // 竖纹（像旧录像带）
  c.globalAlpha = a * 0.35;
  c.fillStyle = 'rgba(0,0,0,0.55)';
  for (let i = -2; i <= 2; i++) {
    c.fillRect(i * 11 - 2, -34, 1.6, 62);
  }
  c.restore();
}

// 用素材图渲染：贴图 + 呼吸/压扁/翻面 + 发光 + 白猫化
function drawCatImage(c) {
  const p = palette(S.tier);
  const t = S.local;
  const moving = S.mode === 'dart' || S.mode === 'drift' || S.mode === 'edge' || S.mode === 'glitch';
  const bob = moving ? Math.sin(t * 11) * 2.4 : Math.sin(t * 2.1) * 1.2;
  const dyingK = S.dying ? 1 : 0;
  // 转起来的时候用视频帧（绿幕已经在 keyedVideoFramebuffer 里抠掉）
  const useVideo = VID.stage > 0 && !!VID.canvas && VID.canvas.width > 0;
  const SRC = useVideo ? VID.canvas : CAT_SRC;
  if (!SRC) return;
  const box = 148;
  const k = box / Math.max(SRC.width, SRC.height);
  const w = SRC.width * k;
  const h = SRC.height * k;

  // 残影（速度快的时候）
  const spd = Math.hypot(S.vx || 0, S.vy || 0);
  if (spd > 60 && S.tier <= 2) {
    c.save();
    c.globalAlpha = 0.16;
    for (let i = 3; i >= 1; i--) {
      const ox = -(S.vx / 60) * i * 3.2;
      const oy = -(S.vy / 60) * i * 3.2;
      c.globalAlpha = 0.15 - i * 0.03;
      c.drawImage(SRC, 105 + ox - w / 2, 154 + oy - h, w, h);
    }
    c.restore();
  }

  c.save();
  c.translate(105, 154 - dyingK * 12);
  // 细微的绕圈浮动：越热飘得越明显
  const orbitR = S.tier >= 2 ? 8 + 4 * Math.sin(t * 0.6) : 2.5;
  c.translate(Math.cos(t * 1.15) * orbitR, Math.sin(t * 1.45) * orbitR * 0.7);
  const sq = S.squash;
  // 撞墙弹性：bounce 冲高后按弹簧回落到 0，形成"Q 弹"
  if (S.bounce > 0.001) {
    S.bounce *= Math.pow(0.0016, 1 / 60); // 每帧衰减，约 0.35s 弹回
    if (S.bounce < 0.02) S.bounce = 0;
  }
  const bo = S.bounce || 0;
  const bx = S.bounceHoriz ? 1 - bo * 0.22 : 1 + bo * 0.14;
  const by = S.bounceHoriz ? 1 + bo * 0.14 : 1 - bo * 0.22;
  c.scale((1 + sq * 0.16) * bx, (1 - sq * 0.16) * by);
  if (S.dir < 0) c.scale(-1, 1);
  c.translate(0, bob);

  // 地面阴影
  c.save();
  c.globalAlpha = 0.24 * (1 - dyingK * 0.8);
  const sg = c.createRadialGradient(0, 2, 2, 0, 2, 36);
  sg.addColorStop(0, 'rgba(0,0,0,0.75)');
  sg.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = sg;
  c.beginPath();
  c.ellipse(0, 3, 34, 9, 0, 0, Math.PI * 2);
  c.fill();
  c.restore();

  // 旋转：用静态猫图时绕身体中心转；放视频时它自己就在转，不用再转
  if (!useVideo && Math.abs(S.spin) > 0.0005) {
    c.translate(0, -h * 0.5);
    c.rotate(S.spin);
    c.translate(0, h * 0.5);
  }

  if (p.glowStrength > 0) {
    c.save();
    c.shadowColor = p.glow;
    c.shadowBlur = p.glowStrength + 10;
  }
  c.drawImage(SRC, -w / 2, -h, w, h);
  if (p.glowStrength > 0) c.restore();

  // 阶段染色：一阶段一层暖光；二阶段起像体内有灯（叠加而不是盖白）
  // 播序列时完全不染色，先保持视频原样，亮度交给下面 stage 2 的提亮逻辑
  if (S.tier >= 1 && !S.playStage) {
    c.save();
    if (useVideo) {
      // 视频没有剪影可染色，用 canvas filter 提亮，越热越白
      c.globalCompositeOperation = 'lighter';
      c.filter = S.tier >= 2 ? 'brightness(2.3) saturate(0.2)' : 'brightness(1.5) sepia(0.2)';
      c.globalAlpha = S.tier >= 2 ? 0.32 + 0.1 * Math.sin(t * 4.2) : 0.22 + 0.06 * Math.sin(t * 3.1);
      c.drawImage(SRC, -w / 2, -h, w, h);
      c.filter = 'none';
    } else {
      c.globalCompositeOperation = 'lighter';
      const tintW = tintedCat('#fff2c0');
      const tintPure = tintedCat('#ffffff');
      const tintWarm = tintedCat('#ffcf78');
      if (S.tier >= 2) {
        c.globalAlpha = 0.22 + 0.1 * Math.sin(t * 4.2);
        if (tintW) c.drawImage(tintW, -w / 2, -h, w, h);
        c.globalAlpha = 0.16;
        if (tintPure) c.drawImage(tintPure, -w / 2, -h, w, h);
      } else {
        c.globalAlpha = 0.14 + 0.06 * Math.sin(t * 3.1);
        if (tintWarm) c.drawImage(tintWarm, -w / 2, -h, w, h);
      }
    }
    c.restore();
  }

  // 三阶段起：RGB 分离的故障重影
  if (S.tier >= 3 && Math.random() < 0.4) {
    c.save();
    c.globalCompositeOperation = 'lighter';
    c.globalAlpha = 0.17;
    const off = 3 + Math.random() * 4;
    if (useVideo) {
      c.filter = 'sepia(1) saturate(6) hue-rotate(-40deg)';
      c.drawImage(SRC, -w / 2 - off, -h, w, h);
      c.filter = 'sepia(1) saturate(6) hue-rotate(160deg)';
      c.drawImage(SRC, -w / 2 + off, -h, w, h);
      c.filter = 'none';
    } else {
      const tintR = tintedCat('#ff2f6d');
      const tintC = tintedCat('#2ffff0');
      if (tintR) c.drawImage(tintR, -w / 2 - off, -h, w, h);
      if (tintC) c.drawImage(tintC, -w / 2 + off, -h, w, h);
    }
    c.restore();
  }

  // 第二段：让视频本身一点点变亮，白光慢慢涨到最大（不铺金色）
  if (S.playStage === 2 && !S.noGlow) {
    const b0 = Math.min(1, Math.max(0, S.sun || 0));
    const b = Math.pow(b0, 1.35); // 前面慢、后面快
    c.save();
    c.globalCompositeOperation = 'lighter';
    // 第一层：原色提亮（保持猫的样子）
    c.globalAlpha = 0.18 + 0.42 * b;
    c.filter = `brightness(${(1.1 + 1.7 * b).toFixed(3)}) saturate(${Math.max(0, 1 - 0.95 * b).toFixed(3)})`;
    c.drawImage(SRC, -w / 2, -h, w, h);
    // 第二层：白光，带柔边，逐渐盖过原色
    c.filter = `brightness(${(1.6 + 2.6 * b).toFixed(3)}) saturate(0)`;
    c.globalAlpha = 0.14 + 0.72 * b;
    c.shadowColor = `rgba(255,255,255,${(0.25 + 0.6 * b).toFixed(3)})`;
    c.shadowBlur = 6 + 34 * b;
    c.drawImage(SRC, -w / 2, -h, w, h);
    c.shadowBlur = 0;
    c.filter = 'none';
    // 最后一段：整只烧成白剪影
    if (b0 > 0.3) {
      c.globalAlpha = Math.min(0.96, ((b0 - 0.3) / 0.7) * 0.96);
      c.filter = 'brightness(0) invert(1)';
      c.drawImage(SRC, -w / 2, -h, w, h);
      c.filter = 'none';
    }
    c.restore();
  }
  c.restore();
}

// ------------------------------------------------------------------ 绘制：光、粒子
function drawSpotlights(c, t) {
  const a = S.tier >= 2 ? 0.13 + 0.05 * Math.sin(t * 1.7) : 0;
  if (a <= 0.005) return;
  for (const [x0, rot, len] of [
    [58, 0.3, 150],
    [152, -0.3, 150],
  ]) {
    c.save();
    c.translate(x0, -4);
    c.rotate(rot);
    const g = c.createLinearGradient(0, 0, 0, len);
    g.addColorStop(0, `rgba(255,248,205,${a})`);
    g.addColorStop(0.65, `rgba(255,240,170,${a * 0.45})`);
    g.addColorStop(1, 'rgba(255,235,150,0)');
    c.fillStyle = g;
    c.beginPath();
    c.moveTo(-7, 0);
    c.lineTo(7, 0);
    c.lineTo(52, len);
    c.lineTo(-16, len);
    c.closePath();
    c.fill();
    c.restore();
  }
}

function drawAura(c, t) {
  if (S.tier >= 3) {
    // 身边一圈"脏"的暗雾，让它周围的桌面看着像被污染了
    const dg = c.createRadialGradient(105, 102, 22, 105, 102, 104);
    dg.addColorStop(0, 'rgba(8,3,12,0.46)');
    dg.addColorStop(0.62, 'rgba(8,3,12,0.2)');
    dg.addColorStop(1, 'rgba(8,3,12,0)');
    c.fillStyle = dg;
    c.beginPath();
    c.arc(105, 102, 104, 0, Math.PI * 2);
    c.fill();
  }
  if (S.tier < 1) return;
  const strength = S.tier >= 2 ? 0.7 : 0.3;
  const pulse = 0.85 + 0.15 * Math.sin(t * 3.4);
  const p = palette(S.tier);
  const g = c.createRadialGradient(105, 105, 6, 105, 105, 92);
  g.addColorStop(0, `rgba(255,236,150,${0.26 * strength * pulse})`);
  g.addColorStop(0.45, `rgba(255,208,74,${0.13 * strength * pulse})`);
  g.addColorStop(1, 'rgba(255,200,60,0)');
  c.fillStyle = g;
  c.beginPath();
  c.arc(105, 105, 96, 0, Math.PI * 2);
  c.fill();
  void p;
}

function spawnPop(x, y, n = 8, hue = 45) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = rand(20, 90);
    S.pops.push({
      x,
      y,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp - 30,
      life: rand(0.35, 0.7),
      max: 0.7,
      size: rand(1.4, 3.2),
      hue,
    });
  }
}

function updatePops(dt) {
  for (const p of S.pops) {
    p.life -= dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vy += 160 * dt;
  }
  S.pops = S.pops.filter((p) => p.life > 0);
  // 白猫附近的余烬
  if (S.tier >= 2) {
    if (Math.random() < 0.55) {
      S.embers.push({
        x: 105 + rand(-46, 46),
        y: 128 + rand(-6, 12),
        vy: rand(-42, -16),
        vx: rand(-10, 10),
        life: rand(0.5, 1.3),
        max: 1.3,
        size: rand(1, 2.6),
      });
    }
  }
  for (const e of S.embers) {
    e.life -= dt;
    e.x += e.vx * dt;
    e.y += e.vy * dt;
  }
  S.embers = S.embers.filter((e) => e.life > 0);
}

const MENU_BTN = { x: 170, y: 24, r: 19 }; // 猫窗口右上角，别再往下掉
function drawMenuButton(c) {
  c.save();
  c.fillStyle = 'rgba(30,26,28,0.72)';
  c.beginPath();
  c.arc(MENU_BTN.x, MENU_BTN.y, MENU_BTN.r, 0, Math.PI * 2);
  c.fill();
  c.strokeStyle = 'rgba(255,255,255,0.5)';
  c.lineWidth = 1.2;
  c.stroke();
  c.fillStyle = 'rgba(255,248,238,0.95)';
  for (let i = -1; i <= 1; i++) {
    c.fillRect(MENU_BTN.x - 8.5, MENU_BTN.y + i * 5.6 - 1.5, 17, 3);
  }
  c.restore();
}
function hitMenuButton(x, y) {
  // 热区比圆点略大，手指/鼠标不用压得很准
  const dx = x - MENU_BTN.x;
  const dy = y - MENU_BTN.y;
  const rr = MENU_BTN.r + 14; // 跟主进程的 40 单位热区对齐（略小一点，避免误触）
  return dx * dx + dy * dy <= rr * rr;
}

function drawPops(c) {
  for (const p of S.pops) {
    const k = clamp(p.life / p.max, 0, 1);
    c.globalAlpha = k;
    c.fillStyle = `hsl(${p.hue} 100% ${68 + 20 * k}%)`;
    c.beginPath();
    c.arc(p.x, p.y, p.size * k, 0, Math.PI * 2);
    c.fill();
  }
  for (const e of S.embers) {
    const k = clamp(e.life / e.max, 0, 1);
    c.globalAlpha = k * 0.9;
    c.fillStyle = `hsl(${rand(38, 52)} 100% 72%)`;
    c.beginPath();
    c.arc(e.x, e.y, e.size, 0, Math.PI * 2);
    c.fill();
  }
  c.globalAlpha = 1;
}

// ------------------------------------------------------------------ 猫的循环
let lastFrame = 0;

function frame() {
  const ms = performance.now();
  const dt = Math.min(0.05, lastFrame ? (ms - lastFrame) / 1000 : 0.016);
  lastFrame = ms;
  S.local += dt;
  S.t += dt;

  // 眨眼
  S.blinkIn -= dt;
  if (S.blinkIn <= 0) {
    S.blink = 0.13;
    S.blinkIn = rand(2.2, 6.4);
  }
  if (S.blink > 0) S.blink = Math.max(0, S.blink - dt);

  if (S.boomFlash > 0) S.boomFlash = Math.max(0, S.boomFlash - dt * 2.2);
  if (S.glitchFlash > 0) S.glitchFlash = Math.max(0, S.glitchFlash - dt * 3.6);
  updatePops(dt);

  // 偶发的、自己叫的喵（病毒感）
  if (S.started && !S.dying) {
    S.idleMeowIn -= dt;
    if (S.idleMeowIn <= 0) {
      S.idleMeowIn = rand(18, 42);
      if (S.tier <= 1) sfx.meow(1, rand(0.95, 1.15), 0.45);
    }
  }
  // 三阶段时偶尔的故障声
  if (S.tier >= 3 && S.t - S.lastGlitch > rand(3, 7)) {
    S.lastGlitch = S.t;
    sfx.glitch(0.5);
  }

  ctx.clearRect(0, 0, W, W);
  // 录制模式：铺一层不透明底色（DSH_VC_RECBG=green/black/#RRGGBB），任何录屏软件都能拍到
  if (RECBG) {
    ctx.fillStyle = RECBG;
    ctx.fillRect(0, 0, W, W);
  }

  // 转：像"旋转猫"那样一直转圈（参考视频约 1 圈 / 3 秒），点热了就拧得飞快
  const spinTarget = S.dying || !S.spinning ? 0 : Math.min(30, 2.1 + S.heat * 1.5 + S.musicT * 0.45);
  S.spinVel += (spinTarget - S.spinVel) * Math.min(1, dt * 2.0);
  S.spin += S.spinVel * dt;
  if (S.spin > Math.PI * 2) S.spin -= Math.PI * 2;

  // 视频阶段：点热之后依次放 spin1（低阶段）/ spin2（高阶段）
  const wantStage = S.dying ? 0 : (S.playStage || (S.idleAnim ? 2 : 0));
  // 太阳亮度：第二段视频（12.59s）里从 0 一点点烧到 1；跑图阶段常亮
  if (S.dash) {
    S.sun = 1;
  } else if (S.playStage === 2 && S.sunAt) {
    S.sun = Math.min(1, (performance.now() - S.sunAt) / 12590);
  } else if (S.sun !== 0) {
    S.sun = 0;
  }
  if (wantStage !== VID.stage) setVideoStage(wantStage);
  if (VID.stage > 0) keyedVideoFramebuffer();

  // 动图播放：一张一帧 100ms，热度/音乐越高播得越快
  if (S.spinning && !S.dying) {
    const rate = Math.min(4.5, 0.9 + S.heat * 0.42 + S.musicT * 0.08);
    S.spinAcc += dt * rate;
    while (S.spinAcc >= 0.1) {
      S.spinAcc -= 0.1;
      S.spinIdx = (S.spinIdx + 1) % SPIN_COUNT;
    }
  }

  // 声音：直接用视频自带的音轨（看哪个阶段在放就调它的音量）
  if (S.musicOn) {
    const wantVol = clamp(VID.stage > 0 ? 0.45 + S.tier * 0.09 : 0, 0, 0.9);
    const act = VID.stage === 2 ? VID.v2 : VID.v1;
    for (const v of [VID.v1, VID.v2]) {
      if (!v) continue;
      const target = v === act ? wantVol * MASTER_VOL : 0;
      v.volume += (target - v.volume) * Math.min(1, dt * 3.2);
    }
    if (act && !act.paused) S.musicT = act.currentTime;
  }

  const shakeK = S.shake;
  if (shakeK > 0) {
    ctx.save();
    ctx.translate(rand(-3, 3) * shakeK, rand(-3, 3) * shakeK);
  }

  // 播放序列时不要金色光晕/光柱/女孩/粒子，保持"视频本身"的样子
  const seqMode = S.playStage > 0;
  if (!seqMode) {
    drawAura(ctx, S.local);
    drawSpotlights(ctx, S.local);
    drawGirl(ctx, S.local);
  }

  ctx.save();
  if (S.dying) ctx.globalAlpha = clamp(1 + (S.local - (S.dyingAt || S.local)), 0, 1);
  drawCat(ctx);
  ctx.restore();

  if (!seqMode) drawPops(ctx);

  if (S.boomFlash > 0.01) {
    ctx.fillStyle = `rgba(255,250,220,${S.boomFlash * 0.55})`;
    ctx.fillRect(0, 0, W, W);
  }

  // 瞬移/故障时的横条撕裂
  if (S.glitchFlash > 0.02) {
    ctx.save();
    for (let i = 0; i < 4; i++) {
      const y = rand(0, W);
      const hh = rand(2, 10);
      const col = Math.random() < 0.5 ? '255,64,148' : '64,255,246';
      ctx.fillStyle = `rgba(${col},${0.2 * S.glitchFlash})`;
      ctx.fillRect(0, y, W, hh);
    }
    ctx.restore();
  }

  if (shakeK > 0) ctx.restore();

  // 演出期间猫身上不画三横杠（固定在初始位置那个窗口负责），只在平时悬停时出现
  if (!seqMode && S.hover && !S.dying) drawMenuButton(ctx);

  if (!IS_FX) requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ FX（爆炸）窗
const FX = { t: 0, done: false, last: 0 };
function fxFrame() {
  const ms = performance.now();
  const dt = Math.min(0.05, FX.last ? (ms - FX.last) / 1000 : 0.016);
  FX.last = ms;
  FX.t += dt;
  const k = clamp(FX.t / 2.4, 0, 1);
  const cx = W / 2;
  const cy = W / 2;
  ctx.clearRect(0, 0, W, W);
  if (RECBG) { ctx.fillStyle = RECBG; ctx.fillRect(0, 0, W, W); }

  // 全屏白闪
  const flash = Math.max(0, 1 - k * 6);
  if (flash > 0.01) {
    ctx.fillStyle = `rgba(255,250,215,${flash * 0.85})`;
    ctx.fillRect(0, 0, W, W);
  }

  // 冲击波
  const ringR = 40 + 300 * k;
  ctx.strokeStyle = `rgba(255,226,150,${Math.max(0, 0.55 - k)})`;
  ctx.lineWidth = 8 * (1 - k) + 1;
  ctx.beginPath();
  ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
  ctx.stroke();

  // 火球
  if (k < 0.85) {
    const r = 30 + 260 * k;
    const g = ctx.createRadialGradient(cx, cy, 2, cx, cy, r);
    const fade = Math.max(0, 1 - k * 1.15);
    g.addColorStop(0, `rgba(255,252,230,${fade})`);
    g.addColorStop(0.3, `rgba(255,214,96,${fade * 0.95})`);
    g.addColorStop(0.62, `rgba(232,124,36,${fade * 0.8})`);
    g.addColorStop(0.85, `rgba(140,58,14,${fade * 0.45})`);
    g.addColorStop(1, 'rgba(80,30,6,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // 烟团
  ctx.save();
  ctx.globalAlpha = Math.max(0, 0.5 - k * 0.5);
  for (let i = 0; i < 14; i++) {
    const ang = (i / 14) * Math.PI * 2 + k * 1.4;
    const dist = 40 + 190 * Math.pow(k, 0.7);
    const rr = 26 + 34 * k;
    const g = ctx.createRadialGradient(
      cx + Math.cos(ang) * dist,
      cy + Math.sin(ang) * dist * 0.7,
      1,
      cx + Math.cos(ang) * dist,
      cy + Math.sin(ang) * dist * 0.7,
      rr,
    );
    g.addColorStop(0, 'rgba(90,70,52,0.55)');
    g.addColorStop(1, 'rgba(60,46,36,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx + Math.cos(ang) * dist, cy + Math.sin(ang) * dist * 0.7, rr, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // 飞溅的火星
  for (let i = 0; i < 90; i++) {
    const seed = i * 12.9898;
    const ang = (seed % 1) * Math.PI * 2 + Math.sin(seed) * 0.4;
    const sp = 60 + (seed % 37) * 26;
    const dist = sp * FX.t * (1 - k * 0.35);
    const px = cx + Math.cos(ang) * dist;
    const py = cy + Math.sin(ang) * dist + 120 * FX.t * FX.t;
    const a = Math.max(0, 1 - k * 1.5);
    if (a <= 0) continue;
    ctx.globalAlpha = a;
    ctx.fillStyle = i % 3 === 0 ? '#fff3b8' : i % 3 === 1 ? '#ffc247' : '#ff8a2b';
    ctx.beginPath();
    ctx.arc(px, py, 1.2 + (seed % 2.4), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  if (FX.t > 2.5) return;
  requestAnimationFrame(fxFrame);
}

// ------------------------------------------------------------------ 消息
function onMsg(msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'volume': {
      applyMasterVolume(msg.v);
      break;
    }
    case 'pause': {
      S.paused = !!msg.on;
      const media = [...document.querySelectorAll('video,audio')];
      if (S.paused) {
        S.pausedEls = media.filter((el) => !el.paused);
        for (const el of S.pausedEls) { try { el.pause(); } catch {} }
      } else {
        for (const el of S.pausedEls || []) { try { el.play(); } catch {} }
        S.pausedEls = [];
      }
      break;
    }
    case 'soundlist': {
      SOUNDS = Array.isArray(msg.list) ? msg.list : [];
      if (typeof msg.kind === 'string') MEOW_KIND = msg.kind;
      applySoundList();
      paintMewButtons();
      break;
    }
    case 'trymeow': {
      sfx.ensure();
      playCustomMeow(1);
      break;
    }
    case 'recbg': {
      // 录制模式开关：绿幕底一开，录屏软件（窗口捕获/游戏栏）也能拍到猫
      RECBG = parseBg(msg.bg);
      break;
    }
    case 'hello': {
      S.tier = msg.tier || 0;
      S.heat = msg.heat || 0;
      if (typeof msg.clicks === 'number') S.clicks = msg.clicks;
      S.started = true;
      break;
    }
    case 'audio4': {
      // 第四段：样子不变（还是发光 + 循环视频 2）。音频是 2+3+4 一整条，
      // 这里不重新起播，让它顺着放，正好接上第四段那 1.55 秒。
      if (msg.on) api.dbg({ kind: 'stage4', on: true, t: runAudio ? Number(runAudio.currentTime.toFixed(2)) : -1 });
      break;
    }
    case 'catimage':
      // 换回最初那只静态小猫：停视频、关掉所有发光/染色
      S.playStage = 0;
      S.noGlow = false;
      S.sun = 0;
      S.sunAt = 0;
      S.tier = 0;
      S.spinning = false;
      S.dash = false;
      // 换回初始小猫：不转、也不要点击那种弹一下的效果
      S.spin = 0;
      S.spinVel = 0;
      S.squash = 0;
      S.vx = 0;
      S.vy = 0;
      S.mode = 'hover';
      setVideoStage(0);
      break;
    case 'stage7audio':
      // 第七段音频已经并进 scene234567.mp3，这里不再单独起播
      api.dbg({ kind: 'stage7-in-track' });
      break;
    case 'stage8audio':
      // 第八段音频已经在 scene2345678.mp3 这条整轨里，不再单独起播
      api.dbg({ kind: 'stage8-in-track' });
      break;
    case 'stage8':
      // 第八段：正中那只改播旋转视频（和另外三只同步）
      S.playStage = 2;
      S.noGlow = true;
      S.sun = 0;
      S.spinning = false;
      S.spin = 0;
      S.spinVel = 0;
      S.squash = 0;
      S.dash = false;
      setVideoStage(2);
      if (VID.v2) {
        try {
          VID.v2.loop = true;
          VID.v2.muted = true;
          const len = VID.v2.duration && isFinite(VID.v2.duration) ? VID.v2.duration : 12.59;
          VID.v2.currentTime = (Number(msg.off) || 0) % len;
          void VID.v2.play();
        } catch {}
      }
      break;
    case 'stage7':
      // 第七段：正中那只改播旋转视频（和另外两只同步）
      S.playStage = 2;
      S.noGlow = true;
      S.sun = 0;
      S.spinning = false;
      S.spin = 0;
      S.spinVel = 0;
      S.squash = 0;
      S.dash = false;
      setVideoStage(2);
      if (VID.v2) {
        try {
          VID.v2.loop = true;
          VID.v2.muted = true;
          const len = VID.v2.duration && isFinite(VID.v2.duration) ? VID.v2.duration : 12.59;
          VID.v2.currentTime = (Number(msg.off) || 0) % len;
          void VID.v2.play();
        } catch {}
      }
      break;
    case 'stage6audio':
      // 第二~六段是同一条轨（scene234567.mp3），这里不用再起播，只记一条日志
      api.dbg({ kind: 'stage6-in-track', at: Number(msg.at) || 0 });
      break;
    case 'stage6':
      // 第六段：正中那只改回播放旋转视频（不发光，和上方那只同步）
      S.playStage = 2;
      S.noGlow = true;
      S.sun = 0;
      S.spinning = false;
      S.spin = 0;
      S.spinVel = 0;
      S.squash = 0;
      S.dash = false;
      setVideoStage(2);
      if (VID.v2) {
        try {
          VID.v2.loop = true;
          VID.v2.muted = true;
          const len = VID.v2.duration && isFinite(VID.v2.duration) ? VID.v2.duration : 12.59;
          VID.v2.currentTime = (Number(msg.off) || 0) % len;
          void VID.v2.play();
        } catch {}
      }
      break;
    case 'stage5':
      // 第二~五段是同一条音频轨（scene2345.mp3），这里不再单独起播
      S.noGlow = true;
      S.sun = 0;
      if (VID.v2) {
        try {
          VID.v2.loop = true;
          VID.v2.muted = true;
          void VID.v2.play();
        } catch {}
      }
      break;
    case 'dash': {
      // 跑图阶段：保持结尾的发光、无限循环第二段视频，同时放"乱跑"音频
      S.dash = !!msg.on;
      if (S.dash) {
        S.playStage = 2;
        S.sun = 1;
        S.tier = 3;
        setVideoStage(2);
        if (VID.v2) {
          try {
            VID.v2.loop = true;
            VID.v2.currentTime = 0;
            VID.v2.play();
            VID.v2.muted = true; // 声音全交给 scene23.mp3，视频本身静音
          } catch {}
        }
        startRunAudio(); // 已经在播的话这里会直接返回，不会重头开始
        api.dbg({ kind: 'dash', on: true });
      } else {
        if (VID.v2) {
          try {
            VID.v2.loop = false;
            VID.v2.muted = false;
          } catch {}
        }
        stopRunAudio();
        stopScoreAudio();
        stopStage5Audio();
        stopStage6Audio();
        stopStage7Audio();
        // 第八段音频不在这里停：让它在提前消失之后把最后 0.4 秒放完（onended 里自己收尾）
        api.dbg({ kind: 'dash', on: false });
      }
      break;
    }
    case 'idleanim': {
      // 待机动作：原地、静音播一遍第一段视频，不放光不上升
      if (msg.on) {
        S.idleAnim = true;
        try {
          if (VID.v2) {
            VID.v2.loop = false;
            VID.v2.muted = true;
            VID.v2.volume = 0;
            VID.v2.currentTime = 0;
            // 慢放：默认 0.6 倍速（只走一部分内容，看起来更慢更缓）
            VID.v2.playbackRate = Number(msg.rate) || 0.6;
          }
        } catch {}
        setVideoStage(2);
        api.dbg({ kind: 'idleanim', on: true, stage: 2 });
      } else {
        S.idleAnim = false;
        setVideoStage(0);
        try {
          if (VID.v2) {
            VID.v2.muted = false;
            VID.v2.currentTime = 0;
            VID.v2.playbackRate = 1;
          }
        } catch {}
        api.dbg({ kind: 'idleanim', on: false });
      }
      break;
    }
    case 'idle': {
      if (S.idleAnim) break; // 待机动作期间别把它清掉
      // 看门狗：待机时如果还在播视频（延迟消息/残留循环），强制拉回普通静态小猫
      let playing = false;
      try { playing = (VID.v1 && !VID.v1.paused) || (VID.v2 && !VID.v2.paused); } catch {}
      if (S.playStage || playing) {
        S.playStage = 0;
        S.noGlow = false;
        S.sun = 0;
        S.tier = 0;
        S.spinning = false;
        S.dash = false;
        S.spin = 0;
        S.spinVel = 0;
        setVideoStage(0);
        stopRunAudio();
        api.dbg({ kind: 'idle-guard', fixed: true });
      }
      break;
    }
    case 'sequence': {
      // 主进程按时间推进：1 = 第一段视频，2 = 第二段，0 = 播完回到初始
      const prevStage = S.playStage;
      S.playStage = msg.stage || 0;
      if (!S.playStage) {
        // 收工：把第五/第六段的音频一起停掉
        stopStage5Audio();
        stopStage6Audio();
        stopStage7Audio();
      }
      if (S.playStage > 0) S.noGlow = false; // 新一轮序列：发光重新打开
      if (S.playStage > 0 && VID.v2) VID.v2.playbackRate = 1;
      setVideoStage(S.playStage);
      if (S.playStage > 0 && prevStage === 0) S.seqAt = performance.now();
      if (S.playStage === 2 && prevStage !== 2) {
        S.sunAt = performance.now();
        // 第二段一开始就把"第二段+第三段"的复合音频接上，跑图阶段不再重放
        if (VID.v1) {
          try {
            VID.v1.muted = true;
            VID.v1.pause();
          } catch {}
        }
        if (VID.v2) {
          try {
            VID.v2.muted = true;
          } catch {}
        }
        startRunAudio();
      }
      if (S.playStage === 0) {
        stopRunAudio();
        if (VID.v1) {
          try {
            VID.v1.muted = false;
          } catch {}
        }
        if (VID.v2) {
          try {
            VID.v2.muted = false;
            VID.v2.loop = false;
          } catch {}
        }
        S.tier = 0;
        S.spinning = false;
        S.spin = 0;
        S.spinVel = 0;
        S.spinIdx = 0;
        S.spinAcc = 0;
        S.musicT = 0;
        S.sun = 0;
        S.seqAt = 0;
      } else {
        S.tier = S.playStage === 2 ? 3 : 2;
        S.spinning = true;
      }
      break;
    }
    case 'state': {
      S.tier = msg.tier;
      S.heat = msg.heat;
      if (typeof msg.clicks === 'number') S.clicks = msg.clicks;
      S.dir = msg.dir >= 0 ? 1 : -1;
      S.mode = msg.mode;
      S.squash = msg.squash;
      S.heatBreathe = msg.heat;
      if (msg.shake > S.shake) S.shake = msg.shake;
      if (msg.dying && !S.dying) {
        S.dying = true;
        S.dyingAt = S.local;
      }
      if (!msg.dying) S.dying = false;
      S.vx = msg.vx || 0;
      S.vy = msg.vy || 0;
      break;
    }
    case 'bounce': {
      // 撞屏边的 Q 弹：沿撞击方向压扁一下，然后自己弹回来
      S.bounce = Math.max(S.bounce || 0, msg.amt || 0.6);
      S.bounceHoriz = !!msg.horiz;
      if (sfx && sfx.thud) sfx.thud(0.4 + (msg.amt || 0.5) * 0.6);
      break;
    }
    case 'tier': {
      const prev = S.tier;
      S.tier = msg.tier;
      if (msg.tier > prev) {
        sfx.riser(msg.tier);
        spawnPop(105, 92, 14);
      }
      if (msg.tier >= 2) sfx.drone(true, msg.tier >= 3 ? 0.7 : 0.5);
      else sfx.drone(false);
      if (msg.tier >= 3) sfx.heartbeat(true);
      else sfx.heartbeat(false);
      break;
    }
    case 'teleport': {
      sfx.ensure();
      S.glitchFlash = 1;
      S.shake = Math.max(S.shake, 0.35);
      sfx.glitch(0.75);
      spawnPop(105, 104, 14, 50);
      break;
    }
    case 'hover': {
      S.hover = !!msg.hover;
      document.body.style.cursor = S.hover ? 'pointer' : 'default';
      break;
    }
    case 'meow': {
      sfx.ensure();
      if (MEOW_KIND === 'synth') sfx.meow(msg.variant | 0, 1, 1);
      else playCustomMeow(msg.pitch || 1);
      spawnPop(105, 100, 7);
      if (Math.random() < 0.18) setTimeout(() => {
        if (MEOW_KIND === 'synth') sfx.meow(1, 1.12, 0.8);
        else playCustomMeow(1.1);
      }, 190);
      break;
    }
    case 'boom': {
      S.boomFlash = 1;
      S.shake = 1;
      S.spinVel = 0;
      S.spin = 0;
      S.spinning = false;
      S.spinIdx = 0;
      S.spinAcc = 0;
      try {
        if (VID.v1) VID.v1.currentTime = 0;
        if (VID.v2) VID.v2.currentTime = 0;
      } catch {}
      sfx.boom(0.9);
      sfx.drone(false);
      sfx.heartbeat(false);
      break;
    }
    case 'dying': {
      S.dying = true;
      S.dyingAt = S.local;
      sfx.drone(false);
      sfx.heartbeat(false);
      break;
    }
    default:
      break;
  }
}

// ------------------------------------------------------------------ 输入
function hitTest(x, y) {
  const dx = (x - 105) / 66;
  const dy = (y - 108) / 66;
  return dx * dx + dy * dy <= 1;
}

function cssToLogical(ev) {
  const rect = canvas.getBoundingClientRect();
  const w = rect.width || 1;
  const h = rect.height || 1;
  return {
    x: clamp(((ev.clientX - rect.left) / w) * W, 0, W),
    y: clamp(((ev.clientY - rect.top) / h) * W, 0, W),
  };
}

if (!IS_FX) {
  window.addEventListener('mousemove', (ev) => {
    const { x, y } = cssToLogical(ev);
    // 只负责"变亮"：hover 的真假由主进程 pollHover 权威下发，
    // 否则窗口在穿透/非穿透之间切换时鼠标事件稀疏，按钮会一闪一闪。
    const over = hitTest(x, y) || (!S.playStage && hitMenuButton(x, y)); // 演出中猫身上不再有菜单键
    document.body.style.cursor = over ? 'pointer' : 'default';
    if (over && !S.hover) {
      S.hover = true;
      api.hover(true);
    }
  });
  window.addEventListener('mouseleave', () => {
    document.body.style.cursor = 'default';
  });
  // 拖动时窗口会跟着跑，clientX/Y 会"自己跳"，所以位移一律用 screenX/screenY（屏幕绝对坐标），
  // 这样按住猫往哪拖，猫就跟着走，不会因为窗口移动而打架。
  let lastSX = 0;
  let lastSY = 0;
  window.addEventListener('mousedown', (ev) => {
    const { x, y } = cssToLogical(ev);
    if (!S.playStage && hitMenuButton(x, y)) {
      ev.preventDefault();
      api.openMenu();
      return;
    }
    if (!hitTest(x, y)) return;
    if (ev.button === 0) {
      PRESSED = true;
      lastSX = ev.screenX;
      lastSY = ev.screenY;
      // 把按下瞬间的光标位置一起报上去：主进程轮询光标可能微微滞后，
      // 拖动时用这个点当基准，猫才会跟手而不是"一拖就跳"
      api.press(ev.screenX, ev.screenY);
      sfx.ensure();
      startMusic();
      // 点小猫：不旋转、不发光，只做一点点压扁
      S.squash = 1;
    }
  });
  // 主进程轮询确认"光标确实命中"之后再开始拖动（避免压在窗口边缘误判）
  // 拖动时不能只靠窗口内的 mousemove：窗口跟着光标跑，光标很容易滑出小窗，
  // 事件就断了（表现就是"能甩出去但拖不动"）。这里按 60fps 主动把光标位置报给主进程，
  // 用 requestAnimationFrame + 窗口内最后一次已知位置兜底。
  let lastMoveSent = 0;
  window.addEventListener('mousemove', (ev) => {
    if (!PRESSED) return;
    lastSX = ev.screenX;
    lastSY = ev.screenY;
    lastMoveSent = performance.now();
    api.dragMove(ev.screenX, ev.screenY);
  });
  (function dragPump() {
    if (PRESSED && lastSX && lastSY) api.dragMove(lastSX, lastSY);
    requestAnimationFrame(dragPump);
  })();
  window.addEventListener('mouseup', (ev) => {
    // 只有真的按下过才发 release：点菜单键时 mousedown 提前 return 了，
    // 如果这里无条件 release，主进程会把它当成"点了一下猫"而多记一次连点。
    if (ev.button === 0 && PRESSED) {
      PRESSED = false;
      api.release(ev.screenX || lastSX, ev.screenY || lastSY);
    }
  });
  // 拖拽时鼠标可能会滑出小窗，兜底松开
  window.addEventListener('blur', () => {
    if (PRESSED) {
      PRESSED = false;
      api.release(lastSX, lastSY);
    }
  });
  window.addEventListener('contextmenu', (ev) => ev.preventDefault());
}

// ------------------------------------------------------------------ 太阳（金色大光晕，跟着猫走）
function sunFrame() {
  const ms = performance.now();
  const dt = Math.min(0.05, SUN.last ? (ms - SUN.last) / 1000 : 0.016);
  SUN.last = ms;
  SUN.t += dt;
  const p = Math.min(1, SUN.t / 12.59); // 第二段视频 12.59s，亮度一路涨
  const cx = W / 2;
  const cy = W / 2;
  ctx.clearRect(0, 0, W, W);
  if (RECBG) { ctx.fillStyle = RECBG; ctx.fillRect(0, 0, W, W); }
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const flicker = 1 + Math.sin(SUN.t * 9.0) * 0.04 + Math.sin(SUN.t * 23.0) * 0.02;
  const outer = (26 + 74 * Math.pow(p, 1.35)) * flicker;
  const g1 = ctx.createRadialGradient(cx, cy, 1, cx, cy, outer);
  g1.addColorStop(0, `rgba(255,252,235,${0.34 + 0.5 * p})`);
  g1.addColorStop(0.22, `rgba(255,232,150,${0.26 + 0.46 * p})`);
  g1.addColorStop(0.5, `rgba(255,190,66,${0.14 + 0.34 * p})`);
  g1.addColorStop(0.78, `rgba(255,150,30,${0.05 + 0.16 * p})`);
  g1.addColorStop(1, 'rgba(255,140,20,0)');
  ctx.fillStyle = g1;
  ctx.beginPath();
  ctx.arc(cx, cy, outer, 0, Math.PI * 2);
  ctx.fill();
  // 中间那团更实的白光
  const core = (10 + 34 * Math.pow(p, 1.2)) * flicker;
  const g2 = ctx.createRadialGradient(cx, cy, 1, cx, cy, core);
  g2.addColorStop(0, `rgba(255,255,250,${0.3 + 0.6 * p})`);
  g2.addColorStop(0.5, `rgba(255,240,180,${0.18 + 0.4 * p})`);
  g2.addColorStop(1, 'rgba(255,220,120,0)');
  ctx.fillStyle = g2;
  ctx.beginPath();
  ctx.arc(cx, cy, core, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  if (SUN.t > 13.4) return;
  requestAnimationFrame(sunFrame);
}

// -------------------------------------------- 第四段：中心正方形里不断冒出的初始小猫
const CROWD = { on: false, list: [], queue: [], nextAt: 0, interval: 16, sprite: 22 };

// 在一个不规则的"云团"里撒点（打乱顺序），既不方也不出界
function buildCrowdQueue(boxPx) {
  const cssSize = Math.max(1, Math.min(window.innerWidth, window.innerHeight));
  const u = cssSize / W; // 1 逻辑单位 = u 个 CSS px
  const box = Math.max(80, boxPx || cssSize / 2.2); // 参考边长（CSS px）
  // 猫的显示尺寸恒为参考边长的 21%（约 100px），再换算成逻辑单位
  CROWD.sprite = (box * 0.21) / u;
  const cx = W / 2;
  const cy = W / 2;
  // 云团范围放大到参考边长的 0.78 倍半径，但不越过窗口
  const maxR = Math.max(20, W / 2 - CROWD.sprite * 0.5 - 4);
  const R = Math.min(maxR, (box * 0.78) / u);
  const phase = Math.random() * Math.PI * 2;
  // 半径随角度起伏 → 轮廓不规则，不是圆也不是方
  const wobble = (a) => 0.72 + 0.2 * Math.sin(3 * a + phase) + 0.08 * Math.sin(7 * a - phase * 1.7);
  const minD = CROWD.sprite * 0.5;
  const total = 90; // 数量
  const rings = 7;
  const cells = [];
  for (let ring = 1; ring <= rings; ring += 1) {
    const frac = ring / rings;
    const remain = total - cells.length;
    const count = ring === rings ? remain : Math.max(1, Math.round((total * ring) / 28));
    for (let i = 0; i < count; i += 1) {
      const a = (i / count) * Math.PI * 2 + Math.random() * 1.1 + ring * 1.9;
      const reach = Math.min(maxR, R * wobble(a) * Math.pow(frac, 0.85));
      const rr = reach * (0.84 + Math.random() * 0.3);
      cells.push({
        x: cx + Math.cos(a) * rr + (Math.random() - 0.5) * minD * 0.7,
        y: cy + Math.sin(a) * rr * 0.94 + (Math.random() - 0.5) * minD * 0.7,
      });
    }
  }
  for (let i = cells.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = cells[i];
    cells[i] = cells[j];
    cells[j] = t;
  }
  api.dbg({ kind: 'crowd-grid', W: Math.round(W), R: Math.round(R), sprite: Math.round(CROWD.sprite), cells: cells.length });
  return cells;
}

function crowdFrame(now) {
  const ms = now || performance.now();
  const w = W;
  const h = W;
  while (CROWD.on && CROWD.queue.length && ms >= CROWD.nextAt) {
    const cell = CROWD.queue.shift();
    CROWD.list.push({ x: cell.x, y: cell.y, born: ms });
    CROWD.nextAt = ms + CROWD.interval;
  }
  ctx.clearRect(0, 0, w, h);
  if (RECBG) { ctx.fillStyle = RECBG; ctx.fillRect(0, 0, W, W); }
  const src = catImgReady ? CAT_SRC : null;
  const s = CROWD.sprite;
  const ratio = src ? src.height / src.width : 1.17;
  for (let i = 0; i < CROWD.list.length; i += 1) {
    const c = CROWD.list[i];
    const age = Math.min(1, (ms - c.born) / 80);
    ctx.save();
    ctx.globalAlpha = age;
    if (src) ctx.drawImage(src, c.x - s / 2, c.y - (s * ratio) / 2, s, s * ratio);
    ctx.restore();
  }
  requestAnimationFrame(crowdFrame);
}

// ----------------------------------------- 第四段之后：沿路径长出的"复制猫"
// 复制猫 = 直接放第二段那段视频（绿幕），逐帧抠绿 + 白热，和中间那只一模一样的渲染
const TVID = { v: null, canvas: null, ctx: null, lastT: -1 };

function setupTrailVideo() {
  if (TVID.v) return;
  const v = document.createElement('video');
  v.src = 'assets/video/spin2.mp4';
  v.muted = true;
  v.loop = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.style.cssText = 'position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
  document.body.appendChild(v);
  const p = v.play();
  if (p && p.catch) p.catch(() => {});
  TVID.v = v;
  const cv = document.createElement('canvas');
  cv.width = 320;
  cv.height = 320;
  TVID.canvas = cv;
  TVID.ctx = cv.getContext('2d', { willReadFrequently: true });
}

function keyedTrailFrame() {
  const v = TVID.v;
  if (!v || v.readyState < 2 || !v.videoWidth) return null;
  const ctx2 = TVID.ctx;
  if (!ctx2) return null;
  if (v.currentTime === TVID.lastT) return TVID.canvas;
  TVID.lastT = v.currentTime;
  const w = TVID.canvas.width;
  const h = TVID.canvas.height;
  ctx2.clearRect(0, 0, w, h);
  ctx2.drawImage(v, 0, 0, w, h);
  let data;
  try {
    data = ctx2.getImageData(0, 0, w, h);
  } catch {
    return TVID.canvas;
  }
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i];
    const g = px[i + 1];
    const b = px[i + 2];
    const mx = r > b ? r : b;
    const dom = g - mx;
    if (dom > 26) {
      px[i + 3] = 0;
    } else if (dom > 6) {
      px[i + 3] = Math.round(px[i + 3] * ((26 - dom) / 20));
      px[i + 1] = mx + 3;
    } else if (dom > 0) {
      px[i + 1] = mx + 3;
    }
  }
  ctx2.putImageData(data, 0, 0);
  return TVID.canvas;
}
const TRAIL = { on: false, pts: [], lens: [], count: 0, dur: 4600, start: 0, sprite: 100, total: 1 };

function buildTrailPath(pts, unitsPerCssPx) {
  const k = unitsPerCssPx > 0 ? unitsPerCssPx : 1;
  TRAIL.pts = (pts || []).map((p) => ({ x: p[0] * k, y: p[1] * k }));
  TRAIL.lens = [0];
  let acc = 0;
  for (let i = 1; i < TRAIL.pts.length; i += 1) {
    acc += Math.hypot(TRAIL.pts[i].x - TRAIL.pts[i - 1].x, TRAIL.pts[i].y - TRAIL.pts[i - 1].y);
    TRAIL.lens.push(acc);
  }
  TRAIL.total = acc || 1;
}

function trailAt(u) {
  const d = u * TRAIL.total;
  let i = 1;
  while (i < TRAIL.lens.length - 1 && TRAIL.lens[i] < d) i += 1;
  const a = TRAIL.pts[i - 1] || { x: 0, y: 0 };
  const b = TRAIL.pts[i] || a;
  const seg = Math.max(1e-6, TRAIL.lens[i] - TRAIL.lens[i - 1]);
  const k = Math.min(1, Math.max(0, (d - TRAIL.lens[i - 1]) / seg));
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
}

function trailFrame(now) {
  try {
  const ms = now || performance.now();
  const t = ms - TRAIL.start;
  ctx.clearRect(0, 0, W, W);
  if (RECBG) {
    ctx.fillStyle = RECBG;
    ctx.fillRect(0, 0, W, W);
  }
  if (TRAIL.on && TRAIL.pts.length > 1) {
    const n = TRAIL.count;
    const step = TRAIL.dur / Math.max(1, n);
    const src = keyedTrailFrame();
    const fallback = src ? null : spinFrameReady() ? spinFrame() : null;
    if (!TRAIL.dbgOnce) {
      TRAIL.dbgOnce = 1;
      api.dbg({
        kind: 'trail-frame',
        on: !!TRAIL.on,
        n: n,
        dur: TRAIL.dur,
        pts: TRAIL.pts.length,
        total: Math.round(TRAIL.total),
        hasVideo: !!src,
        videoW: src ? src.width : 0,
        hasSpin: !!fallback,
        unit: unit,
        W: W,
        innerW: window.innerWidth,
        innerH: window.innerHeight,
      });
    }
    for (let i = 0; i < n; i += 1) {
      const born = i * step;
      if (t < born) break;
      const age = Math.min(1, (t - born) / 240);
      const p = trailAt((i + 0.5) / n);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.globalAlpha = Math.min(1, 0.25 + 0.75 * age);
      const sz = TRAIL.sprite;
      const gr = sz * 0.8;
      const g = ctx.createRadialGradient(0, 0, sz * 0.12, 0, 0, gr);
      g.addColorStop(0, 'rgba(255,252,240,0.5)');
      g.addColorStop(0.5, 'rgba(255,250,235,0.16)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.9 * age;
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, gr, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = Math.min(1, 0.25 + 0.75 * age);
      ctx.globalCompositeOperation = 'source-over';
      if (src || fallback) {
        const img = src || fallback;
        const w = sz;
        const h = (img.height / img.width) * sz;
        ctx.filter = 'brightness(2.1) saturate(0.45) contrast(1.1)';
        ctx.shadowColor = 'rgba(255,246,214,0.85)';
        ctx.shadowBlur = sz * 0.18;
        ctx.drawImage(img, -w / 2, -h / 2, w, h);
        ctx.filter = 'brightness(0) invert(1)';
        ctx.globalAlpha = 0.62 * age;
        ctx.drawImage(img, -w / 2, -h / 2, w, h);
        ctx.shadowBlur = 0;
        ctx.filter = 'none';
      }
      ctx.restore();
    }
  }
  } catch (err) {
    if (!TRAIL.err) {
      TRAIL.err = 1;
      api.dbg({ kind: 'trail-error', msg: String(err && err.message), stack: String(err && err.stack).slice(0, 300) });
    }
  }
  requestAnimationFrame(trailFrame);
}

// ------------------------------------------------------------------ 菜单窗
function buildMenuUI() {
  document.body.innerHTML = '';
  document.body.style.margin = '0';
  document.body.style.background = 'transparent';
  document.body.style.overflow = 'hidden';
  const style = document.createElement('style');
  style.textContent = [
    '.panel{position:fixed;inset:0;box-sizing:border-box;padding:14px 16px;border-radius:16px;',
    'background:rgba(26,22,26,.93);color:#f4efe8;font:13px/1.45 "Segoe UI",system-ui,sans-serif;',
    'border:1px solid rgba(255,255,255,.12);box-shadow:0 12px 32px rgba(0,0,0,.5);}',
    '.title{font-size:12px;letter-spacing:.16em;color:#ffd9a0;margin:0 0 12px}',
    '.row{display:flex;align-items:center;gap:10px;margin:12px 0}',
    '.row label{flex:0 0 42px;color:#cfc6bd}',
    '.row input[type=range]{flex:1;accent-color:#ff9d4d}',
    '.val{flex:0 0 42px;text-align:right;color:#ffd9a0;font-variant-numeric:tabular-nums}',
    '.chk{display:flex;align-items:center;gap:8px;margin-top:14px;color:#e9e1d8}',
    '.chk input{width:16px;height:16px;accent-color:#ff9d4d}',
    '.tip{margin-top:12px;color:#8d857d;font-size:11px}',
    '#pse{width:100%;padding:8px 10px;border-radius:10px;border:1px solid rgba(255,157,77,.5);',
    'background:rgba(255,157,77,.14);color:#ffd9a0;font:13px "Segoe UI",system-ui,sans-serif;cursor:pointer}',
    '#pse:hover{background:rgba(255,157,77,.26)}',
    '.seg{display:flex;flex-wrap:wrap;flex:1;gap:6px}',
    '.seg button{flex:0 1 auto;min-width:76px;padding:6px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.18);',
    'background:rgba(255,255,255,.06);color:#cfc6bd;font:12px "Segoe UI",system-ui,sans-serif;cursor:pointer;',
    'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:150px}',
    '.seg button.on{background:rgba(255,157,77,.22);border-color:rgba(255,157,77,.75);color:#ffd9a0}',
    '.sndtip{margin-top:6px;color:#8d857d;font-size:11px;line-height:1.5;word-break:break-all}',
    '.mini{padding:4px 12px;border-radius:8px;border:1px solid rgba(255,255,255,.2);',
    'background:rgba(255,255,255,.08);color:#e9e1d8;font:12px "Segoe UI",system-ui,sans-serif;cursor:pointer}',
    '.mini:hover{background:rgba(255,255,255,.16)}',
  ].join('');
  document.head.appendChild(style);
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.innerHTML =
    '<div class="title">小猫设置</div>' +
    '<div class="row"><label>音量</label><input id="vol" type="range" min="0" max="100" step="1"><span class="val" id="volv">100</span></div>' +
    '<div class="row"><label>体型</label><input id="siz" type="range" min="60" max="180" step="1"><span class="val" id="sizv">100%</span></div>' +
    '<div class="row"><label>叫声</label><div class="seg" id="seg"></div></div>' +
    '<div class="row" style="margin-top:-6px"><label></label><button id="try" class="mini">试听</button></div>' +
    '<div class="sndtip">想加自己的音效：把 mp3/wav 丢进<br><b>assets\\audio\\sounds\\</b>，回来点开面板就会多一个按钮</div>' +
    '<label class="chk"><input id="gst" type="checkbox"> 平时隐身，鼠标靠近才出现</label>' +
    '<label class="chk" style="margin-top:8px"><input id="rcb" type="checkbox"> 录屏用绿幕底（录制时猫才拍得到）</label>' +
    '<div class="row" style="margin-top:14px"><button id="pse">⏹ 停止并回到初始状态</button></div>' +
    '<div class="tip">拖动即时生效，设置会记住</div>';
  document.body.appendChild(panel);
  const vol = panel.querySelector('#vol');
  const siz = panel.querySelector('#siz');
  const gst = panel.querySelector('#gst');
  const rcb = panel.querySelector('#rcb');
  const seg = panel.querySelector('#seg');
  const volv = panel.querySelector('#volv');
  const sizv = panel.querySelector('#sizv');
  let mewKind = 'synth';
  const paintMewButtons = () => {
    if (!seg) return;
    seg.innerHTML = '';
    const items = [{ file: 'synth', label: '合成喵' }].concat((SOUNDS || []).map((s) => ({ file: s.file, label: s.file.replace(/\.[^.]+$/, '') })));
    for (const it of items) {
      const b = document.createElement('button');
      b.textContent = it.label;
      b.title = it.file;
      b.className = it.file === mewKind ? 'on' : '';
      b.addEventListener('click', () => {
        mewKind = it.file;
        paintMewButtons();
        api.setting('meow', mewKind);
        api.setting('trymeow', mewKind);
      });
      seg.appendChild(b);
    }
  };
  window.paintMewButtons = () => paintMewButtons();
  window.setSoundState = (list, kind) => {
    SOUNDS = Array.isArray(list) ? list : [];
    mewKind = typeof kind === 'string' && kind ? kind : 'synth';
    paintMewButtons();
  };
  api.onMessage((msg) => {
    if (!msg || msg.type !== 'menu-init') return;
    vol.value = Math.round((msg.volume == null ? 1 : msg.volume) * 100);
    siz.value = Math.round((msg.size == null ? 1 : msg.size) * 100);
    gst.checked = !!msg.ghost;
    rcb.checked = !!msg.recbg;
    mewKind = msg.meow || 'synth';
    window.setSoundState(msg.sounds, mewKind);
    volv.textContent = vol.value;
    sizv.textContent = siz.value + '%';
  });
  vol.addEventListener('input', () => {
    volv.textContent = vol.value;
    api.setting('volume', Number(vol.value) / 100);
  });
  siz.addEventListener('input', () => {
    sizv.textContent = siz.value + '%';
    api.setting('size', Number(siz.value) / 100);
  });
  panel.querySelector('#try').addEventListener('click', () => { api.setting('trymeow', mewKind); });
  gst.addEventListener('change', () => api.setting('ghost', gst.checked));
  rcb.addEventListener('change', () => api.setting('recbg', rcb.checked));
  const pse = panel.querySelector('#pse');
  // 停掉整段演出：音乐/视频立刻静音，猫回到初始位置（不是暂停）
  pse.addEventListener('click', () => {
    api.setting('stop', true);
    try { window.close(); } catch {}
  });
  document.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('mousedown', (e) => {
    if (e.target === document.body) {
      try { window.close(); } catch {}
    }
  });
}

// ------------------------------------------------------------------ 启动
resize();
if (IS_FX) {
  window.addEventListener('resize', resize);
  if (String(api.kind) === 'menu') {
    buildMenuUI();
  } else if (String(api.kind) === 'sun') {
    requestAnimationFrame(sunFrame);
  } else if (String(api.kind) === 'catch') {
    // 跑图期间盖在整屏上的"接点击"透明层：点哪儿都算点猫
    document.body.style.background = 'transparent';
    window.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      api.dashStop();
    });
    window.addEventListener('contextmenu', (e) => e.preventDefault());
  } else if (String(api.kind) === 'crowd') {
    // 第四段：正方形里一只只冒出的"初始小猫"，后出现的画在上面
    api.onMessage((msg) => {
      if (!msg || msg.type !== 'crowd') return;
      CROWD.on = !!msg.on;
      if (CROWD.on) {
        CROWD.list.length = 0;
        CROWD.queue = buildCrowdQueue(Number(msg.box) || 0);
        // 出现得快一点：用整段音频的前 45% 时间就把 49 只铺完
        const ms = Number(msg.ms) || 1600;
        CROWD.interval = Math.max(1, (ms * 0.08) / Math.max(1, CROWD.queue.length));
        CROWD.nextAt = 0;
      }
    });
    requestAnimationFrame(crowdFrame);
  } else if (String(api.kind) === 'trail') {
    // 第四段之后：一串发光旋转猫沿着手画的那条线一只只长出来
    api.onMessage((msg) => {
      if (!msg || msg.type !== 'trail') return;
      TRAIL.on = !!msg.on;
      if (TRAIL.on) {
        setupTrailVideo();
        buildTrailPath(msg.pts || [], 1 / unit);
        TRAIL.count = Number(msg.count) || 26;
        TRAIL.dur = Number(msg.dur) || 4600;
        TRAIL.sprite = Math.max(6, (Number(msg.sprite) || 112) / unit);
        TRAIL.start = performance.now();
        api.dbg({ kind: 'trail', unit: Math.round(unit * 100) / 100, count: TRAIL.count, pts: TRAIL.pts.length, sprite: Math.round(TRAIL.sprite) });
      }
    });
    requestAnimationFrame(trailFrame);
  } else if (String(api.kind) === 'menubtn') {
    // 演出期间钉在初始位置的三横杠：只画按钮，点它开菜单。
    // 平时隐藏，光标靠近（主进程 pollHover 判定）才显示 —— 和猫身上的按钮一样。
    let btnOn = false;
    document.body.style.opacity = '0';
    window.addEventListener('mousedown', (ev) => {
      const { x, y } = cssToLogical(ev);
      if (hitMenuButton(x, y)) api.openMenu();
    });
    window.addEventListener('mousemove', (ev) => {
      const { x, y } = cssToLogical(ev);
      document.body.style.cursor = hitMenuButton(x, y) ? 'pointer' : 'default';
    });
    if (typeof api.onMessage === 'function') {
      api.onMessage((msg) => {
        if (!msg) return;
        if (msg.type === 'menubtn') {
          btnOn = !!msg.on;
          document.body.style.opacity = btnOn ? '1' : '0';
        } else if (msg.type === 'recbg') {
          RECBG = parseBg(msg.bg);
        }
      });
    }
    const mbFrame = () => {
      ctx.clearRect(0, 0, W, W);
      if (RECBG) { ctx.fillStyle = RECBG; ctx.fillRect(0, 0, W, W); }
      if (btnOn) drawMenuButton(ctx);
      requestAnimationFrame(mbFrame);
    };
    requestAnimationFrame(mbFrame);
  } else if (String(api.kind) === 'staticcat') {
    // 第五段末尾：上方突然出现的那只静态小猫；第六段开始改播旋转视频（不转贴图）
    const SC = { on: false, size: 148, video: false };
    api.onMessage((msg) => {
      if (!msg) return;
      if (msg.type === 'staticcat') {
        SC.on = !!msg.on;
        // 提前把视频准备好（第六段一到就能和中间那只同一帧切过去，不会卡半拍）
        if (SC.on) setupTrailVideo();
        // msg.size 是 CSS px，画布用的是 210 单位空间，要除以 unit
        SC.size = (Number(msg.size) || 148) / unit;
        api.dbg({ kind: 'staticcat', on: SC.on, size: SC.size });
      } else if (msg.type === 'stage6static') {
        // 第六段末尾：这只也换回静态小猫图
        SC.video = false;
        try { if (TVID.v) TVID.v.pause(); } catch {}
        api.dbg({ kind: 'staticcat-static-again', on: true });
      } else if (msg.type === 'stage6' || msg.type === 'stage7' || msg.type === 'stage8') {
        setupTrailVideo();
        SC.video = !!msg.on;
        if (SC.video && TVID.v) {
          try {
            const len = TVID.v.duration && isFinite(TVID.v.duration) ? TVID.v.duration : 12.59;
            TVID.v.currentTime = (Number(msg.off) || 0) % len;
            void TVID.v.play();
          } catch {}
        }
        api.dbg({ kind: 'staticcat-video', on: SC.video, off: Number(msg.off) || 0 });
      }
    });
    const scFrame = () => {
      ctx.clearRect(0, 0, W, W);
      if (RECBG) { ctx.fillStyle = RECBG; ctx.fillRect(0, 0, W, W); }
      if (SC.on) {
        // 兜底：视频万一被浏览器暂停（隐藏窗口/自动播放策略），每帧试着拉起来
        if (SC.video && TVID.v && TVID.v.paused) { try { void TVID.v.play(); } catch {} }
        const src = SC.video ? keyedTrailFrame() : (catImgReady ? CAT_SRC : null);
        if (src) {
          // 和中间那只同一套缩放规则：最长边 = SC.size
          const k = SC.size / Math.max(src.width, src.height);
          const w = src.width * k;
          const hh = src.height * k;
          ctx.drawImage(src, W / 2 - w / 2, W / 2 - hh / 2, w, hh);
        }
      }
      requestAnimationFrame(scFrame);
    };
    requestAnimationFrame(scFrame);
  } else if (String(api.kind) === 'boom') {
    // 爆炸音在 FX 窗里放，猫窗只闪
    try { sfx.boom(1); } catch {}
    requestAnimationFrame(fxFrame);
  } else {
    requestAnimationFrame(fxFrame);
  }
} else {
  api.onMessage(onMsg);
  api.ready();
  requestAnimationFrame(frame);
}
