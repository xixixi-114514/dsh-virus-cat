'use strict';

/**
 * dsh-virus-cat · electron helper (main process)
 *
 * 一只在桌面上乱飘的猫。点它会喵，点多了就会……变成视频里那样。
 * 主进程负责：窗口生命周期 + 物理模拟 + 点击/热度升级逻辑 + 爆炸特效窗。
 * 渲染进程（renderer.js）只负责画猫和发声。
 */

const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

// electron.exe 是 GUI 程序，console.log 收不到；统一写日志文件
const LOG_PATH =
  process.env.DSH_VC_LOG ||
  path.join(process.env.LOCALAPPDATA || require('node:os').tmpdir(), 'dsh-virus-cat', 'helper.log');
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args
    .map((a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()))
    .join(' ')}`;
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > 512 * 1024) {
      fs.writeFileSync(LOG_PATH, '');
    }
    fs.appendFileSync(LOG_PATH, line + '\n');
  } catch {}
}

// ---------------------------------------------------------------- switches
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
if (process.env.DSH_VC_GPU !== '1') app.disableHardwareAcceleration();
app.setName('dsh-virus-cat-helper');

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const SCALE = clamp(num(process.env.DSH_VC_SCALE, 1), 0.6, 2.2);
const WIN = Math.round(210 * SCALE); // 每只猫一个正方形透明窗
const SPEED = clamp(num(process.env.DSH_VC_SPEED, 1), 0.2, 3);
const MAX_CATS = clamp(Math.round(num(process.env.DSH_VC_MAX_CATS, 5)), 1, 8);
const FOCUSABLE = process.env.DSH_VC_FOCUSABLE === '1';
const EXIT_AFTER_MS = num(process.env.DSH_VC_EXIT_AFTER_MS, 0);
// 调试：DSH_VC_PIN="800,500" 把猫钉在屏幕坐标处
const PIN = (() => {
  const m = /^(-?\d+)\s*,\s*(-?\d+)$/.exec(String(process.env.DSH_VC_PIN || '').trim());
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
})();

// 热度阈值：0 普通猫 → 1 眼睛发光 → 2 白猫(视频同款) → 3 女孩脸 → 4 爆炸
const T1 = 3;
const T2 = 6;
const T3 = 9;
const T4 = 16;

const HELPER_DIR = __dirname;
const INDEX_HTML = path.join(HELPER_DIR, 'index.html');
const ASSETS_DIR = path.join(HELPER_DIR, 'assets');

const primary = () => screen.getPrimaryDisplay();

/** 一只猫 */
const TEST_HEAT = Number(process.env.DSH_VC_TEST_HEAT || 0);

class Cat {
  constructor(id, opts = {}) {
    this.id = id;
    this.heat = opts.heat ?? TEST_HEAT;
    this.tier = 0;
    this.cx = opts.cx ?? 0;
    this.cy = opts.cy ?? 0;
    this.vx = 0;
    this.vy = 0;
    this.dir = 1;
    this.mode = 'drift';
    this.modeT = 0;
    this.speed = 130;
    this.target = null;
    this.lastClickAt = 0;
    this.idleAnim = false;
    this.idleTimer = null;
    this.idleAnimAt = Date.now();
    this.lastIdleAt = Date.now();
    this.volume = SETTINGS.volume;
    this.k = SETTINGS.size;
    this.ghost = !!SETTINGS.ghost;
    this.menuWin = null;
    this.squash = 0;
    this.shake = 0;
    this.ttl = opts.ttl ?? Infinity;
    this.dying = false;
    this.dead = false;
    this.win = null;
    this.ready = false;
    this.hover = false;
    this.sentAt = 0;
    this.t = 0;
    this.dragging = false;
    this.pressed = false;
    this.playing = false;
    this.seqTimers = [];
    this.anchor = null;
    this.orbitA = Math.random() * Math.PI * 2;
    this.orbitR = 0;
    this.clicks = 0;
  }
}

/** 爆炸 / 故障特效窗 */
class Fx {
  constructor(kind, cx, cy, size) {
    this.kind = kind;
    this.cx = cx;
    this.cy = cy;
    this.size = size;
    this.win = null;
    this.dead = false;
  }
}

const cats = new Map();
const fxs = new Set();

// ---------------------------------------------------------------- 设置（音量 / 体型 / 靠近才现身）
// 中文用户名下 APPDATA/LOCALAPPDATA 经过某些宿主会变成乱码，所以默认就放在 helper 自己目录下，
// 需要换地方再用 DSH_VC_SETTINGS 指定完整路径。
const SETTINGS_PATH = process.env.DSH_VC_SETTINGS || path.join(HELPER_DIR, 'settings.json');
const SETTINGS_DIR = path.dirname(SETTINGS_PATH);
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) || {}; } catch { return {}; }
}
function saveSettings(o) {
  try { fs.mkdirSync(SETTINGS_DIR, { recursive: true }); fs.writeFileSync(SETTINGS_PATH, JSON.stringify(o, null, 2)); } catch {}
}
const SETTINGS = Object.assign({ volume: 1, size: 1, ghost: false, recbg: false, meow: 'synth' }, loadSettings());
log('[virus-cat] settings loaded path=' + SETTINGS_PATH + ' => ' + JSON.stringify(SETTINGS));

// ---------------------------------------------------------------- 自定义音效
// 把 mp3/wav/ogg/m4a... 丢进 assets/audio/sounds/ 就会自动出现在「叫声」里，
// 选中的那个文件名记在 settings.json；文件被删掉就自动退回内置合成喵。
const SOUND_DIR = path.join(ASSETS_DIR, 'audio', 'sounds');
const SOUND_EXT = /\.(mp3|wav|ogg|m4a|aac|flac|webm|opus)$/i;
const SOUND_VERSION = Date.now();
function soundList() {
  let names = [];
  try {
    names = fs.readdirSync(SOUND_DIR).filter((n) => SOUND_EXT.test(n) && !n.startsWith('.'));
  } catch { names = []; }
  names.sort((a, b) => a.localeCompare(b, 'zh'));
  return names.map((file) => ({ file, base: 1, v: SOUND_VERSION }));
}
function normalizeMeow() {
  if (SETTINGS.meow === 'synth') return;
  if (!soundList().some((s) => s.file === SETTINGS.meow)) SETTINGS.meow = 'synth';
}
normalizeMeow();
function soundSrc(file) {
  return 'assets/audio/' + encodeURIComponent(file) + '?v=' + SOUND_VERSION;
}
function winSize(cat) {
  return Math.max(80, Math.round(WIN * (cat && cat.k ? cat.k : 1)));
}
let catSeq = 0;
let ticker = null;
let lastTick = 0;
const bootAt = Date.now();

// ---------------------------------------------------------------- utilities
function makeCatWindow(cat) {
  const WS = winSize(cat);
  const win = new BrowserWindow({
    width: WS,
    height: WS,
    x: Math.round(cat.cx - WS / 2),
    y: Math.round(cat.cy - WS / 2),
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    focusable: FOCUSABLE,
    backgroundColor: '#00000000',
    enableLargerThanScreen: true,
    show: false,
    webPreferences: {
      preload: path.join(HELPER_DIR, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(INDEX_HTML, { query: { mode: 'cat', id: String(cat.id), bg: RECBG } });
  win.once('ready-to-show', () => {
    if (!cat.dead) win.showInactive();
  });
  win.webContents.on('render-process-gone', () => {
    cat.dead = true;
    try { win.destroy(); } catch {}
  });
  // 页面加载好之后把可用音效清单和当前选中项同步过去
  win.webContents.on('did-finish-load', () => {
    setTimeout(() => {
      try {
        if (!win.isDestroyed()) win.webContents.send('vc:msg', { type: 'soundlist', list: soundList(), kind: SETTINGS.meow });
      } catch {}
    }, 120);
  });
  cat.win = win;
  return win;
}

function catState(cat) {
  return {
    type: 'state',
    tier: cat.tier,
    heat: cat.heat,
    clicks: cat.clicks,
    dir: cat.dir,
    mode: cat.mode,
    squash: Math.round(cat.squash * 100) / 100,
    shake: Math.round(cat.shake * 100) / 100,
    dying: cat.dying,
    vx: Math.round(cat.vx),
    vy: Math.round(cat.vy),
    t: Math.round(cat.t * 100) / 100,
  };
}

function send(cat, msg) {
  if (!cat.win || cat.win.isDestroyed()) return;
  try { cat.win.webContents.send('vc:msg', msg); } catch {}
}

function sendAll(msg) {
  for (const cat of cats.values()) send(cat, msg);
}

function trayState() {
  return { type: 'world', cats: cats.size, maxCats: MAX_CATS };
}

// ---------------------------------------------------------------- behaviour
function randInWorkArea(pad) {
  const wa = primary().workArea;
  return {
    x: wa.x + pad + Math.random() * Math.max(1, wa.width - pad * 2),
    y: wa.y + pad + Math.random() * Math.max(1, wa.height - pad * 2),
  };
}

// 病毒式瞬移：直接闪到屏幕另一处，带一圈烟
function glitchJump(cat) {
  const wa = primary().workArea;
  const pad = WIN / 2 + 6;
  const p = randInWorkArea(pad);
  cat.cx = p.x;
  cat.cy = p.y;
  cat.vx = randFloat(-40, 40);
  cat.vy = randFloat(-40, 40);
  cat.mode = 'glitch';
  cat.speed = 60;
  cat.modeT = 0.35 + Math.random() * 0.5;
  cat.target = null;
  const id = cat.win ? cat.win.id : 0;
  send(cat, { type: 'teleport', id });
}

function randFloat(a, b) {
  return a + Math.random() * (b - a);
}

function stepCat(cat, dt) {
  cat.t += dt;

  // 跑图阶段：正方形里乱撞，碰到边按 15°~90° 随机拐弯
  if (cat.seqPhase === 'trail') {
    const wa = primary().workArea;
    cat.cx = wa.x + wa.width / 2;
    cat.cy = wa.y + wa.height / 2;
    setCatBounds(cat);
    return;
  }
  if (cat.seqPhase === 'dash') {
    stepDash(cat, dt);
    return;
  }

  // 第四段：停在屏幕正中，继续发光
  if (cat.seqPhase === 'center') {
    stepCenter(cat);
    return;
  }

  // 序列播放中：先停在下边中间（第一段），第二段开始才一路升到屏幕最上面
  if (cat.seqPhase === 'hold' || cat.seqPhase === 'rise') {
    const wa = primary().workArea;
    const endY = wa.y + WIN / 2 + 10;
    cat.cx = wa.x + wa.width / 2;
    if (cat.seqPhase === 'rise') {
      const p = Math.min(1, (Date.now() - cat.riseAt) / SEQ_D2);
      const ease = 1 - Math.pow(1 - p, 2.2);
      cat.cy = cat.riseFromY + (endY - cat.riseFromY) * ease;
    } else {
      cat.cy = wa.y + wa.height - WIN / 2 - 4;
    }
    cat.vx = 0;
    cat.vy = 0;
    if (cat.win && !cat.win.isDestroyed()) {
      try {
        cat.win.setBounds({ x: Math.round(cat.cx - WIN / 2), y: Math.round(cat.cy - WIN / 2), width: WIN, height: WIN });
      } catch {}
      if (cat.ready && cat.t - cat.sentAt > 1 / 30) {
        cat.sentAt = cat.t;
        send(cat, catState(cat));
      }
      if (Date.now() - (cat.posLogAt || 0) > 900) {
        cat.posLogAt = Date.now();
        log('[virus-cat] seq pos', cat.seqPhase, Math.round(cat.cx) + ',' + Math.round(cat.cy));
      }
    }
    return;
  }

  if (cat.squash > 0) cat.squash = Math.max(0, cat.squash - dt * 3.2);
  if (cat.shake > 0) cat.shake = Math.max(0, cat.shake - dt * 2.4);

  // 热度衰减：约 5.5s 掉 1 点
  if (!cat.dying && cat.heat > 0) cat.heat = Math.max(TEST_HEAT, Math.max(0, cat.heat - dt * 0.18));
  const tier = cat.heat >= T4 - 0.2 ? 4 : cat.heat >= T3 ? 3 : cat.heat >= T2 ? 2 : cat.heat >= T1 ? 1 : 0;
  if (tier !== cat.tier) {
    cat.tier = tier;
    send(cat, { type: 'tier', tier });
  }

  // 克隆猫寿命
  if (cat.ttl !== Infinity) {
    cat.ttl -= dt;
    if (cat.ttl <= 0 && !cat.dying) {
      cat.dying = true;
      send(cat, { type: 'dying' });
    }
  }
  if (cat.dying) {
    cat.modeT -= dt;
    if (cat.modeT < -1.1) {
      cat.dead = true;
      try { cat.win && !cat.win.isDestroyed() && cat.win.destroy(); } catch {}
      return;
    }
  }

  const wa = primary().workArea;
  const pad = WIN / 2 + 4;

  // 兜底：按下超过 8 秒还没收到 release（窗口曾经穿透把 mouseup 吃掉了）→ 强制收尾
  if (cat.pressed && cat.pressAtMs && Date.now() - cat.pressAtMs > 8000) {
    cat.pressed = false;
    cat.dragging = false;
    log('[virus-cat] press timeout -> reset');
  }

  // 按下后先等等看会不会拖：移动超过 8px 才真的进入拖拽，否则算点击。
  // 指针一律用"页面报上来的屏幕坐标 / ptrUnit"，绝对不能拿轮询光标（窗口一动它就跟自己打架）。
  if (cat.pressed && !cat.dragging) {
    const u = cat.ptrUnit || 1;
    const cur = Number.isFinite(cat.ptrX) ? { x: cat.ptrX / u, y: cat.ptrY / u } : screen.getCursorScreenPoint();
    const at = cat.pressAt || cur;
    if (Math.hypot(cur.x - at.x, cur.y - at.y) > 6) {
      cat.dragging = true;
      cat.lastPtrX = cur.x;
      cat.lastPtrY = cur.y;
      log('[virus-cat] drag start d=' + Math.round(Math.hypot(cur.x - at.x, cur.y - at.y)));
    }
  }

  // 拖拽中：位置完全跟手，不做自己的移动
  if (cat.dragging) {
    // 权威指针 = 系统光标（物理像素）。它不受"窗口自己移动"影响，
    // 不会自我抵消也不会自我加速——这是唯一靠谱的参考。
    const cp = screen.getCursorScreenPoint();
    const px = cp.x;
    const py = cp.y;
    const nowMs = Date.now();
    if (!cat.dragHist) cat.dragHist = [];
    cat.dragHist.push({ t: nowMs, x: px, y: py });
    while (cat.dragHist.length && nowMs - cat.dragHist[0].t > 120) cat.dragHist.shift();

    const disp = cat.win && !cat.win.isDestroyed() ? screen.getDisplayMatching(cat.win.getBounds()) : primary();
    const db = disp.bounds; // 物理像素
    // 屏幕的可拖范围（DIP）直接用工作区，别再用尺寸相除去推：
    // 猫窗只有 210 DIP 宽时 3072/210 会被取整成 7，导致 halfW 只有 307、猫被锁在左上角一块。
    const wa = disp.workArea || disp.bounds;
    let sflReal = 1;
    try { sflReal = realScaleFor(disp, cat.win && !cat.win.isDestroyed() ? cat.win.getBounds().width : 0); } catch (e) { sflReal = 1; }
    const halfW = Math.max(120, Math.round((wa.width || db.width) / sflReal));
    // 底部多给一块：任务栏高约 48 DIP，允许猫窗压过任务栏，贴到物理屏幕最下沿。
    const halfH = Math.max(120, Math.round((wa.height || db.height) / sflReal) + 60);

    // 单位只认一个：物理像素 / DIP。按下时定一次，整段拖动不再改。
    const U = cat.ptrUnit || sflReal;
    const curX = px / U;
    const curY = py / U;
    if (!Number.isFinite(cat.lastPtrX) || !Number.isFinite(cat.lastPtrY)) {
      cat.lastPtrX = curX;
      cat.lastPtrY = curY;
    }
    // 增量积分：猫 += 这次光标 - 上次光标（基准永远是真实光标，不是猫位置）
    cat.cx += curX - cat.lastPtrX;
    cat.cy += curY - cat.lastPtrY;
    cat.lastPtrX = curX;
    cat.lastPtrY = curY;
    if (!Number.isFinite(cat.cx)) cat.cx = halfW / 2;
    if (!Number.isFinite(cat.cy)) cat.cy = halfH / 2;
    // 左右/上只留 6px 余量；底部允许一直压到物理屏幕最下沿（可以骑在任务栏上）
    cat.cx = Math.round(Math.max(6, Math.min(halfW - 6, cat.cx)));
    cat.cy = Math.round(Math.max(6, Math.min(halfH + 40, cat.cy)));
    cat.grabUntil = Date.now() + 250;
    cat.keepBottom = true;
    if (Date.now() - (cat.dragLogAt || 0) > 280) {
      cat.dragLogAt = Date.now();
      log('[virus-cat] drag pick=' + cat.cx + ',' + cat.cy + ' raw=' + px + ',' + py + ' U=' + U + ' half=' + halfW + 'x' + halfH);
    }
    cat.vx = 0;
    cat.vy = 0;
    cat.mode = 'hover';
    placeCat(cat);
    if (cat.win && !cat.win.isDestroyed() && cat.ready && cat.t - cat.sentAt > 1 / 30) {
      cat.sentAt = cat.t;
      send(cat, catState(cat));
    }
    return;
  }

  if (PIN) {
    // 调试模式：钉死在固定位置，方便截图和模拟点击
    cat.cx = PIN.x;
    cat.cy = PIN.y;
    cat.vx = 0;
    cat.vy = 0;
    cat.target = null;
    cat.mode = 'hover';
    cat.dir = 1;
    placeCat(cat);
    if (cat.win && !cat.win.isDestroyed()) {
      if (cat.ready && cat.t - cat.sentAt > 1 / 30) {
        cat.sentAt = cat.t;
        send(cat, catState(cat));
      }
    }
    return;
  }

  if (!cat.dying) {
    if (cat.tier >= 2) {
      // 热起来之后：围着原来待的地方画圈（越热圈越快），不跑远，方便继续点
      if (!cat.anchor) {
        cat.anchor = { x: cat.cx, y: cat.cy };
        cat.orbitR = 20 + cat.tier * 8;
        cat.orbitA = Math.random() * Math.PI * 2;
      }
      cat.mode = 'orbit';
      cat.orbitR += ((20 + cat.tier * 8) - cat.orbitR) * Math.min(1, dt * 1.4);
      cat.orbitA += dt * (0.45 + cat.tier * 0.22);
      const wob = 7 * Math.sin(cat.t * 2.4 + cat.id);
      cat.cx = cat.anchor.x + Math.cos(cat.orbitA) * (cat.orbitR + wob);
      cat.cy = cat.anchor.y + Math.sin(cat.orbitA) * cat.orbitR * 0.6;
      cat.vx = -Math.sin(cat.orbitA) * 90;
      cat.vy = Math.cos(cat.orbitA) * 55;
      cat.shake = Math.max(cat.shake, 0.12 + cat.tier * 0.06);
    } else if (!cat.flinging) {
      // 安静状态：原地待命，速度收敛到 0（甩飞中不能在这里再扣一次速度，否则 0.3 秒就停了）
      cat.anchor = null;
      cat.mode = 'idle';
      cat.vx *= 0.82;
      cat.vy *= 0.82;
      cat.modeT -= dt;
    }
  } else {
    cat.vx *= 0.92;
    cat.vy *= 0.92;
    cat.shake = Math.max(cat.shake, 0.5);
  }

  // 甩飞（Fling）：松手带速度 → 一路飞、撞屏边 Q 弹、摩擦慢慢停
  if (cat.flinging) {
    // 分数步长：速度很快时把一帧拆成几段，避免一帧跨过整个屏幕、穿墙
    const steps = Math.min(6, Math.max(1, Math.ceil((Math.hypot(cat.vx, cat.vy) * dt) / 60)));
    const sdt = dt / steps;
    for (let s = 0; s < steps; s++) {
      cat.cx += cat.vx * sdt;
      cat.cy += cat.vy * sdt;
      // 空气摩擦：前段有冲劲、后段拖着慢慢滑（速度越低摩擦越小，尾巴拉长）
      // 阻力随速度变：快的时候阻力小（几乎不减速，飞得远）、慢下来阻力大（很快停住）
      const spd = Math.hypot(cat.vx, cat.vy);
      const k = Math.min(1, spd / FLING_FAST_SPEED); // 0=慢 1=快
      const fric = FLING_FRICTION_SLOW + (FLING_FRICTION_FAST - FLING_FRICTION_SLOW) * k;
      const drag = Math.exp(-fric * sdt);
      cat.vx *= drag;
      cat.vy *= drag;
      // 撞边：镜面反弹 + 弹性阻尼 + 一点"Q 弹"回弹
      let hit = 0;
      if (cat.cx < wa.x + pad) { cat.cx = wa.x + pad; cat.vx = Math.abs(cat.vx) * FLING_RESTITUTION; hit = Math.max(hit, Math.abs(cat.vx)); }
      if (cat.cx > wa.x + wa.width - pad) { cat.cx = wa.x + wa.width - pad; cat.vx = -Math.abs(cat.vx) * FLING_RESTITUTION; hit = Math.max(hit, Math.abs(cat.vx)); }
      if (cat.cy < wa.y + pad) { cat.cy = wa.y + pad; cat.vy = Math.abs(cat.vy) * FLING_RESTITUTION; hit = Math.max(hit, Math.abs(cat.vy)); }
      if (cat.cy > wa.y + wa.height - (cat.keepBottom ? -(60 - pad) : pad)) { cat.cy = wa.y + wa.height - (cat.keepBottom ? -(60 - pad) : pad); cat.vy = -Math.abs(cat.vy) * FLING_RESTITUTION; hit = Math.max(hit, Math.abs(cat.vy)); }
      if (hit > 0) {
        // 撞墙的"Q 弹"：给渲染层一个挤压脉冲（沿撞击方向压扁），越大越明显
        const amt = Math.min(1, hit / 1600);
        cat.bounce = Math.max(cat.bounce || 0, 0.55 + amt * 0.9);
        send(cat, { type: 'bounce', amt, horiz: Math.abs(cat.vx) > Math.abs(cat.vy) });
        log('[virus-cat] fling bounce v=' + Math.round(cat.vx) + ',' + Math.round(cat.vy));
      }
    }
    // 慢到几乎不动就算停了（顺带打一条调试：每 0.5s 报一次速度，方便确认减速是渐进的）
    if (Date.now() - (cat.flingLogAt || 0) > 800) {
      cat.flingLogAt = Date.now();
      log('[virus-cat] fling fly v=' + Math.round(Math.hypot(cat.vx, cat.vy)));
    }
    if (Math.hypot(cat.vx, cat.vy) < 26) {
      cat.vx = 0;
      cat.vy = 0;
      cat.flinging = false;
      cat.mode = 'idle';
      cat.anchor = { x: cat.cx, y: cat.cy };
      log('[virus-cat] fling settle at', Math.round(cat.cx) + ',' + Math.round(cat.cy));
    }
  } else {

  if (cat.mode !== 'orbit') {
    cat.cx += cat.vx * dt;
    cat.cy += cat.vy * dt;
  }

  // 出界反弹
  if (cat.cx < wa.x + pad) { cat.cx = wa.x + pad; cat.vx = Math.abs(cat.vx) * 0.65; cat.target = null; }
  if (cat.cx > wa.x + wa.width - pad) { cat.cx = wa.x + wa.width - pad; cat.vx = -Math.abs(cat.vx) * 0.65; cat.target = null; }
  if (cat.cy < wa.y + pad) { cat.cy = wa.y + pad; cat.vy = Math.abs(cat.vy) * 0.65; cat.target = null; }
  // 底部：拖到底之后允许停在任务栏上，别每帧被推回来
  const bottomPad = cat.keepBottom ? -(60 - (WIN / 2 + 4)) : pad;
  if (cat.cy > wa.y + wa.height - bottomPad) { cat.cy = wa.y + wa.height - bottomPad; cat.vy = -Math.abs(cat.vy) * 0.65; cat.target = null; }
  }

  if (Math.abs(cat.vx) > 6) cat.dir = cat.vx > 0 ? 1 : -1;

  // 移动窗口
  if (cat.win && !cat.win.isDestroyed()) {
    const sx = cat.shake > 0 ? (Math.random() - 0.5) * cat.shake * 14 : 0;
    const sy = cat.shake > 0 ? (Math.random() - 0.5) * cat.shake * 14 : 0;
    try {
      cat.win.setBounds({
        x: Math.round(cat.cx - WIN / 2 + sx),
        y: Math.round(cat.cy - WIN / 2 + sy),
        width: WIN,
        height: WIN,
      });
    } catch {}
    // 状态 30Hz 就够
    if (cat.ready && cat.t - cat.sentAt > 1 / 30) {
      cat.sentAt = cat.t;
      send(cat, catState(cat));
    }
  }
}

// ---------------------------------------------------------------- escalation
function meow(cat, variant) {
  send(cat, { type: 'meow', variant });
}

function spawnFx(kind, atX, atY) {
  const wa = primary().workArea;
  const size = kind === 'boom' ? Math.round(Math.min(wa.width, wa.height) * 0.95) : Math.round(WIN * 2.4);
  const half = size / 2;
  // 默认在屏幕正中；传了坐标就炸在那只猫身上（并夹住，保证特效窗不出屏）
  const cx = Math.max(wa.x + half, Math.min(wa.x + wa.width - half, atX == null ? wa.x + wa.width / 2 : atX));
  const cy = Math.max(wa.y + half, Math.min(wa.y + wa.height - half, atY == null ? wa.y + wa.height / 2 : atY));
  const fx = new Fx(kind, cx, cy, size);
  const win = new BrowserWindow({
    width: size,
    height: size,
    x: Math.round(cx - size / 2),
    y: Math.round(cy - size / 2),
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    focusable: true,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: path.join(HELPER_DIR, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true);
  win.loadFile(INDEX_HTML, { query: { mode: 'fx', kind, bg: RECBG } });
  win.once('ready-to-show', () => win.showInactive());
  fx.win = win;
  fxs.add(fx);
  const life = kind === 'boom' ? 2600 : 1500;
  setTimeout(() => {
    fx.dead = true;
    try { win.destroy(); } catch {}
    fxs.delete(fx);
  }, life);
  return fx;
}

function explode(cat) {
  cat.heat = 0;
  cat.tier = 0;
  cat.shake = 1;
  cat.squash = 1;
  send(cat, { type: 'tier', tier: 0 });
  sendAll({ type: 'boom' });
  spawnFx('boom');
  // 不做分裂：只有这一只，爆完回到安静状态
  log('[virus-cat] boom (no split)');
}

// 点满 9 下 -> 先消失 2 秒，再出现在屏幕下方中间，一边播放一边升到屏幕中央
const SEQ_START = 9;
// —— 甩飞（松手弹出去）物理参数
const FLING_GAIN = 2.3;         // 指针速度 → 猫初速度的增益（甩得越狠飞得越猛）
const FLING_MIN_SPEED = 180;    // 低于这个速度就当"轻轻放下"，不飞（px/s）
const FLING_MAX_SPEED = 3400;   // 速度上限（太高会在角上疯狂连弹）
const FLING_FRICTION_FAST = 0.16; // 高速阻力（小 → 几乎不减速，一路飞、多弹几下）
const FLING_FRICTION_SLOW = 1.05; // 低速阻力（大 → 慢下来很快就停住，不会一直飘）
const FLING_FAST_SPEED = 1100;    // 判定为快的速度阈值（px/s）
const FLING_RESTITUTION = 0.90; // 撞边弹性（越接近 1 越"Q"，每次损失 10% → 反复弹但会衰减）

const CLICK_GAP_MS = Number(process.env.DSH_VC_CLICKGAP || 400); // 连点间隔超过这个值就不叠加、并倒计时清零
const SEQ_VANISH = 2000; // 消失 2 秒
const SEQ_D1 = Number(process.env.DSH_VC_D1 || 7640); // 测试可缩短 // 第一段视频时长（ms）
const SEQ_D2 = Number(process.env.DSH_VC_D2 || 12590); // 测试可缩短 // 第二段视频时长（ms）

// 可暂停的定时器：演出用 setTimeout 串起来，暂停时要把剩下的时间记下来，恢复时接着走
function seqLater(cat, fn, ms) {
  const rec = { fn, at: Date.now() + ms, remain: 0, id: 0, done: false };
  rec.id = setTimeout(() => { rec.done = true; fn(); }, ms);
  return rec;
}

function clearSeqTimers(cat) {
  for (const t of cat.seqTimers || []) {
    if (t && typeof t === 'object') clearTimeout(t.id);
    else clearTimeout(t);
  }
  cat.seqTimers = [];
}

function pauseSequence(cat, on) {
  cat.paused = !!on;
  const list = cat.seqTimers || [];
  if (on) {
    const now = Date.now();
    for (const t of list) {
      if (!t || typeof t !== 'object' || t.done) continue;
      clearTimeout(t.id);
      t.remain = Math.max(0, t.at - now);
    }
  } else {
    for (const t of list) {
      if (!t || typeof t !== 'object' || t.done) continue;
      t.at = Date.now() + (t.remain || 0);
      t.id = setTimeout(() => { t.done = true; t.fn(); }, t.remain || 0);
    }
  }
  send(cat, { type: 'pause', on: cat.paused });
  log('[virus-cat] pause ->', cat.paused);
}

function setCatBounds(cat) {
  if (!cat.win || cat.win.isDestroyed()) return;
  try {
    const WS = winSize(cat);
    cat.win.setBounds({
      x: Math.round(cat.cx - WS / 2),
      y: Math.round(cat.cy - WS / 2),
      width: WS,
      height: WS,
    });
    if (cat.grabUntil && Date.now() < cat.grabUntil) {
      const got = cat.win.getBounds();
      if (!cat.bbLogAt || Date.now() - cat.bbLogAt > 250) {
        cat.bbLogAt = Date.now();
        log('[virus-cat] bounds want=' + Math.round(cat.cy - WS / 2) + ' got=' + got.y + ' h=' + got.height);
      }
    }
  } catch (e) {
    log('[virus-cat] setBounds error', (e && e.message) || e);
  }
}

// 太阳：一个比猫大得多的大光圈窗口，跟着猫走，越放越亮
function spawnSunWindow(cat) {
  const wa = primary().workArea;
  const size = Math.round(Math.min(wa.width, wa.height) * 0.66);
  const win = new BrowserWindow({
    width: size,
    height: size,
    x: Math.round(cat.cx - size / 2),
    y: Math.round(cat.cy - size / 2),
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    focusable: false,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: path.join(HELPER_DIR, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true);
  win.loadFile(INDEX_HTML, { query: { mode: 'fx', kind: 'sun', bg: RECBG } });
  win.once('ready-to-show', () => win.showInactive());
  cat.sunWin = win;
  cat.sunSize = size;
  log('[virus-cat] sun window on ' + size);
}

function moveSunWindow(cat) {
  if (!cat.sunWin || cat.sunWin.isDestroyed()) return;
  const s = cat.sunSize;
  try {
    cat.sunWin.setBounds({ x: Math.round(cat.cx - s / 2), y: Math.round(cat.cy - s / 2 + 10), width: s, height: s });
  } catch {}
}

function destroySunWindow(cat) {
  try {
    if (cat.sunWin && !cat.sunWin.isDestroyed()) cat.sunWin.destroy();
  } catch {}
  cat.sunWin = null;
}

// 右上角三横杠点开的设置面板
function openMenuWin(cat) {
  if (cat.menuWin && !cat.menuWin.isDestroyed()) {
    try { cat.menuWin.showInactive(); cat.menuWin.moveTop(); } catch {}
    return;
  }
  const wa = primary().workArea;
  const WS = winSize(cat);
  const mw = 300;
  const mh = 380;
  // 面板默认摆在猫的上方、稍微偏右，避免挡住猫也不跑出屏幕。
  // 优先级：演出中 → 钉在 homeAt（用户要求演出期间位置别乱跑）；平时 → 跟着猫现在的位置走，拖到哪面板就开在哪
  const base = (cat.playing && cat.homeAt)
    ? cat.homeAt
    : { x: (cat.anchor ? cat.anchor.x : cat.cx), y: (cat.anchor ? cat.anchor.y : cat.cy) };
  const x = Math.max(wa.x + 8, Math.min(wa.x + wa.width - mw - 8, Math.round(base.x - 40)));
  let y = Math.round(base.y - WS / 2 - mh - 12);
  if (y < wa.y + 8) y = Math.round(base.y + WS / 2 + 12); // 上面放不下就放下面
  y = Math.max(wa.y + 8, Math.min(wa.y + wa.height - mh - 8, y));
  const win = new BrowserWindow({
    width: mw,
    height: mh,
    x: x,
    y: y,
    transparent: true,
    frame: false,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    focusable: true, // 必须能拿焦点，否则滑块/复选框/按钮都点不动
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: path.join(HELPER_DIR, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  cat.menuWin = win;
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(INDEX_HTML, { query: { mode: 'fx', kind: 'menu', v: String(Date.now()) } });
  const sendInit = () => {
    try {
      win.webContents.send('vc:msg', {
        type: 'menu-init',
        volume: SETTINGS.volume,
        size: SETTINGS.size,
        ghost: SETTINGS.ghost,
        recbg: SETTINGS.recbg,
        meow: SETTINGS.meow,
        sounds: soundList(),
        paused: !!cat.paused,
        playing: !!cat.playing,
      });
    } catch {}
  };
  win.once('ready-to-show', () => {
    try {
      win.showInactive();
      win.moveTop();
      // 必须拿到焦点，否则第一次点击会被系统当成"激活窗口"吞掉，复选框/滑块点不动
      win.focus();
    } catch {}
    sendInit();
  });
  win.webContents.once('did-finish-load', () => {
    // 渲染层建好面板之后再补一次，保证 音量/体型/隐身 三个当前值都回填对
    setTimeout(sendInit, 140);
  });
  win.on('closed', () => { cat.menuWin = null; });
  log('[virus-cat] menu opened at', x + ',' + y);
}

// 演出期间用的"固定菜单键"：钉在猫咪的初始位置上，不跟着演出跑，随时能点开菜单暂停
function spawnMenuBtnWin(cat) {
  if (cat.menuBtnWin && !cat.menuBtnWin.isDestroyed()) return;
  const base = cat.homeAt || cat.anchor || { x: cat.cx, y: cat.cy };
  const win = new BrowserWindow({
    width: WIN,
    height: WIN,
    x: Math.round(base.x - WIN / 2),
    y: Math.round(base.y - WIN / 2),
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    focusable: false,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: path.join(HELPER_DIR, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(INDEX_HTML, { query: { mode: 'fx', kind: 'menubtn', bg: RECBG } });
  win.once('ready-to-show', () => { try { win.showInactive(); win.moveTop(); } catch {} });
  win.on('closed', () => { cat.menuBtnWin = null; });
  cat.menuBtnWin = win;
  cat.menuBtnHover = false;
  log('[virus-cat] fixed menu button near', Math.round(base.x) + ',' + Math.round(base.y));
}

function destroyMenuBtnWin(cat) {
  const w = cat.menuBtnWin;
  cat.menuBtnWin = null;
  if (w && !w.isDestroyed()) { try { w.destroy(); } catch {} }
}

function startSequence(cat) {
  clearSeqTimers(cat);
  cat.paused = false;
  spawnMenuBtnWin(cat);
  cancelIdleAnim(cat);
  cat.playing = true;
  cat.clicks = 0;
  cat.heat = 0;
  cat.seqPhase = 'vanish';
  // 记住"原位"：音频放完 / 点停之后要回到这里（用待机锚点，不是被点击时的偏移位置）
  cat.homeAt = { x: cat.anchor ? cat.anchor.x : cat.cx, y: cat.anchor ? cat.anchor.y : cat.cy };
  send(cat, { type: 'sequence', stage: 0 });
  // 注意：这里不能用 win.hide()/show()。Windows 上透明窗 hide→show 之后会一直保持"点击穿透"，
  // 演出结束回来就变成"猫还在但点不动"。改成把窗口变全透明，输入状态始终是活的。
  cat.forceHidden = true;
  try {
    cat.win.setOpacity(0);
    cat.win.setIgnoreMouseEvents(true, { forward: true });
  } catch {}
  log('[virus-cat] sequence vanish (2s)');

  cat.seqTimers.push(seqLater(cat, () => {
      if (!cat.playing) return;
      const wa = primary().workArea;
      cat.seqPhase = 'hold';
      cat.cx = wa.x + wa.width / 2;
      cat.cy = wa.y + wa.height - WIN / 2 - 4;
      cat.riseFromY = cat.cy;
      cat.riseAt = Date.now();
      cat.heat = 6;
      cat.tier = 2;
      setCatBounds(cat);
      try {
        cat.forceHidden = false;
        cat.win.setOpacity(1);
        cat.win.setAlwaysOnTop(true, 'screen-saver');
        cat.win.moveTop();
      } catch {}
      send(cat, { type: 'sequence', stage: 1 });
      log('[virus-cat] sequence appear bottom-center + stage 1');
    }, SEQ_VANISH)
  );

  cat.seqTimers.push(seqLater(cat, () => {
      if (!cat.playing) return;
      cat.heat = 9;
      // 第二段开始，才真正往上升
      cat.seqPhase = 'rise';
      cat.riseFromY = cat.cy;
      cat.riseAt = Date.now();
      send(cat, { type: 'sequence', stage: 2 });
      log('[virus-cat] sequence stage 2 + rise start');
    }, SEQ_VANISH + SEQ_D1)
  );
  cat.seqTimers.push(seqLater(cat, () => {
      if (!cat.playing) return;
      startDash(cat);
    }, SEQ_VANISH + SEQ_D1 + SEQ_D2)
  );
}

// ---------------------------------------------------------------- 跑图阶段
// 视频播完后不结束，而是保持发光、无限循环第二段，让猫在屏幕中间沿大写 M 极速乱跑：正 M → 右转 90° → 左转 90° → 倒过来 180°，循环。
// 第二段 + 第三段共用一条音频（assets/audio/scene23.mp3，25.78s）：
// 前 12.59s 是第二段（边升边亮），后面 13.19s 就是跑图那一整圈
const DASH_SPEED = 6; // 跑图整体倍速
const DASH_BASE = 11710; // 2+3+4 复合音频里第三段：12.59s → 24.283s
const SEQ_CENTER_LEAD = Number(process.env.DSH_VC_CENTER_LEAD || 200); // 猫提前这么多毫秒落到屏幕正中（结尾仍按音频真实结束收工）

// 第四段之后：复制出来的发光猫沿这条线一只只长出来（1536x960 逻辑坐标，运行时按 workArea 换算）
const TRAIL_PATH = [[415.1,356.4],[434.7,338.6],[465,319.6],[498.8,290.5],[536.1,271],[570.5,248.4],[611.7,230.1],[655.3,216.4],[698,207.5],[738.3,193.9],[781,192.1],[822,189.7],[857.6,189.2],[896.1,190.9],[936.4,194.5],[977.3,202.8],[1015.9,210.5],[1056.8,220.6],[1098.3,231.3],[1135.1,244.9],[1173.1,265.6],[1209.2,286.4],[1245.4,307.2],[1279.8,335.6]];
// 待机动作：隔一段时间在原地静音播一遍第一段视频
const IDLE_ANIM_MS = Number(process.env.DSH_VC_IDLE_ANIM || 120000);
const IDLE_ANIM_RATE = Number(process.env.DSH_VC_IDLE_RATE || 0.6);   // 待机动作放慢倍率
const IDLE_ANIM_LEN = Number(process.env.DSH_VC_IDLE_LEN || 10500);  // 半段视频 + 0.6 倍速 ≈ 10.5s

const TRAIL_COUNT = Number(process.env.DSH_VC_TRAIL_COUNT || 10);   // 复制几只
const TRAIL_MS = Number(process.env.DSH_VC_TRAIL_MS || 4200);       // 全部长出来要多久
const TRAIL_SPRITE = Number(process.env.DSH_VC_TRAIL_SPRITE || 132); // 每只多大（逻辑像素）
const AUDIO4_MS = Number(process.env.DSH_VC_AUDIO4 || 1325);
// 第五段音频（assets/audio/stage5.mp3，3.00s）：第四段放完接着放，猫不发光但继续旋转
const AUDIO5_MS = Number(process.env.DSH_VC_AUDIO5 || 2975);
const IMG_LEAD = Number(process.env.DSH_VC_IMG_LEAD || 300);
// 第六段音频（assets/audio/stage6.mp3，3.29s）：开播时两只猫一起改成播放旋转视频
const AUDIO6_MS = Number(process.env.DSH_VC_AUDIO6 || 3225);
// 第六段开头这两只先保持静态图多久（毫秒）
const S6_STATIC_MS = Number(process.env.DSH_VC_S6STATIC || 200);
// 第六段结束前多久两只一起换回静态小猫图
const S6_END_LEAD = Number(process.env.DSH_VC_S6ENDLEAD || 200);
// 第七段音频（assets/audio/stage7.mp3，3.24s）：开头三只保持静态 0.2s，然后一起播旋转视频
const AUDIO7_MS = Number(process.env.DSH_VC_AUDIO7 || 3258);
const S7_STATIC_MS = Number(process.env.DSH_VC_S7STATIC || 200);
// 第七段结束前多久三只一起变回静态小猫图
const S7_END_LEAD = Number(process.env.DSH_VC_S7ENDLEAD || 200);
// 第八段音频（assets/audio/stage8.mp3，2.53s）：开头四只保持静态 0.2s，然后四只一起播旋转视频到结束
const AUDIO8_MS = Number(process.env.DSH_VC_AUDIO8 || 2510);
const S8_STATIC_MS = Number(process.env.DSH_VC_S8STATIC || 200);
const S8_END_LEAD = Number(process.env.DSH_VC_S8ENDLEAD || 200); // 第八段四只小猫比音频结尾提前多久消失
const POST8_SHOW_MS = Number(process.env.DSH_VC_POST8 || 1000); // 音频结束后过多久，初始小猫才重新出现
const DASH_CYCLE = Math.round(DASH_BASE / DASH_SPEED);
const DASH_M = Math.round(DASH_CYCLE / 4); // 每个朝向一个 M
// 四个朝向：正 M → 向右转 90° → 向左转 90° → 倒过来 180°
const M_ROTS = [0, 90, -90, 180];

// 大写 M 的折线（归一化坐标：右上为 +x/+y，原点在中心）
// 左下 → 左上 → 中间谷底 → 右上 → 右下
const M_SHAPE = [
  [-0.5, 0.5],
  [-0.5, -0.5],
  [0, 0.34],
  [0.5, -0.5],
  [0.5, 0.5],
];

// 取第 rot 个朝向（0/90/180/270 度，顺时针）的 M，按半径缩放并居中
function mPoints(rot, rx, ry) {
  const a = (rot * Math.PI) / 2;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const s = Math.min(rx, ry); // 等比，且保证整只猫不会跑出屏幕
  return M_SHAPE.map(([ux, uy]) => {
    const x = ux * s * 1; // 宽度只有一半
    const y = uy * s * 2;
    return { x: x * cos - y * sin, y: x * sin + y * cos };
  });
}

// 按弧长在折线路径上取点，u ∈ [0,1]（不闭合：M 画完就结束，不会多画一条底边）
function polyAt(pts, u) {
  const segs = [];
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    segs.push({ a, b, len });
    total += len;
  }
  let d = Math.max(0, Math.min(0.9999, u)) * total;
  for (const s of segs) {
    if (d <= s.len) {
      const k = s.len > 0 ? d / s.len : 0;
      return { x: s.a.x + (s.b.x - s.a.x) * k, y: s.a.y + (s.b.y - s.a.y) * k };
    }
    d -= s.len;
  }
  return { x: pts[0].x, y: pts[0].y };
}

function spawnCatcher(cat) {
  if (cat.catchWin) return;
  const wa = primary().workArea;
  const win = new BrowserWindow({
    x: wa.x,
    y: wa.y,
    width: wa.width,
    height: wa.height,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    focusable: false,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: path.join(HELPER_DIR, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  // 跑图期间整屏接点击：猫太快，正常"点中它"几乎不可能，干脆点哪儿都算
  win.setIgnoreMouseEvents(false);
  win.loadFile(INDEX_HTML, { query: { mode: 'fx', kind: 'catch', bg: RECBG } });
  win.once('ready-to-show', () => win.showInactive());
  cat.catchWin = win;
}

function destroyCatcher(cat) {
  try {
    if (cat.catchWin) cat.catchWin.destroy();
  } catch {}
  cat.catchWin = null;
}

// 第三/四段共用的"屏幕中心正方形"半边长（想大想小只改 BOX_RATIO）
// 录制底色：green / black / #RRGGBB；设了之后每个窗口都铺不透明底色，任何录屏软件都能拍到
let saveSettingsTimer = null;
let RECBG = process.env.DSH_VC_RECBG || '';
if (!RECBG && SETTINGS.recbg) RECBG = 'green'; // 菜单里勾过"录屏用绿幕底"就默认绿幕
const BOX_RATIO = 0.72;
function boxHalf() {
  const wa = primary().workArea;
  return Math.max(90, ((Math.min(wa.width - WIN, wa.height - WIN) / 2 - 20) * BOX_RATIO));
}

// 第四段：屏幕中心的正方形里，一只只冒出"初始小猫"，后出现的压在前面的上面
// 拆成两步：第三段就先偷偷建好窗口（prepareCrowd），第四段开场瞬间直接显示（showCrowd），
// 这样"猫跳到屏幕正中"和"小猫开始冒出来"是同一帧，不会晚半拍。
function prepareCrowd(cat) {
  if (cat.crowdWin) return;
  const wa = primary().workArea;
  const half = boxHalf();
  const box = Math.round(half * 2);
  // 窗口比正方形大一圈，正方形外面的猫也能完整显示、不被裁掉
  const size = Math.round(box * 2.2);
  const win = new BrowserWindow({
    x: Math.round(wa.x + wa.width / 2 - size / 2),
    y: Math.round(wa.y + wa.height / 2 - size / 2),
    width: size,
    height: size,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    focusable: false,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: path.join(HELPER_DIR, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  // 层级压在主猫窗（screen-saver）之下，旋转猫永远在最上面
  win.setAlwaysOnTop(true, 'floating');
  win.setIgnoreMouseEvents(true, { forward: false });
  win.loadFile(INDEX_HTML, { query: { mode: 'fx', kind: 'crowd', bg: RECBG } });
  win.once('ready-to-show', () => {
    // 提前挂到屏幕上但完全透明：真正要出现时只改 opacity，
    // 省掉 Windows "新窗口显示" 那一两百毫秒的延迟，做到和猫瞬移同一帧。
    try {
      win.setOpacity(0);
      win.showInactive();
      win.setAlwaysOnTop(true, 'floating');
      cat.win.setAlwaysOnTop(true, 'screen-saver');
      cat.win.moveTop();
    } catch {}
    cat.crowdReady = true;
    log('[virus-cat] crowd window prepared', size);
  });
  cat.crowdWin = win;
  cat.crowdReady = false;
  cat.crowdBox = box;
}

function showCrowd(cat) {
  const win = cat.crowdWin;
  if (!win) return;
  try {
    if (!win.isDestroyed()) {
      win.setOpacity(1);
      win.showInactive();
    }
  } catch {}
  // 新窗口会盖到最上面：把猫窗重新压回 crowd 之上
  try {
    cat.win.setAlwaysOnTop(true, 'screen-saver');
    cat.win.moveTop();
  } catch {}
  try {
    win.webContents.send('vc:msg', { type: 'crowd', on: true, ms: AUDIO4_MS + 400, box: cat.crowdBox });
  } catch {}
  log('[virus-cat] crowd shown', cat.crowdBox);
}

function destroyCrowd(cat) {
  try {
    if (cat.crowdWin) cat.crowdWin.destroy();
  } catch {}
  cat.crowdWin = null;
  cat.crowdReady = false;
}

// 第五段/第六段末尾：中间那只换成静态图的同时，再"啪"地多出几只看不出区别的静态小猫
// dx/dy 是相对正中那只的偏移（逻辑像素，y 向下为正）
function spawnStaticCatAt(cat, slot, dx, dy, hidden) {
  if (cat[slot]) return;
  const wa = primary().workArea;
  const size = 220;
  const cx = cat.cx + dx;
  const cy = cat.cy + dy;
  const win = new BrowserWindow({
    width: size,
    height: size,
    x: Math.round(cx - size / 2),
    y: Math.round(Math.max(wa.y + size / 2, Math.min(wa.y + wa.height - size / 2, cy)) - size / 2),
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    focusable: false,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: path.join(HELPER_DIR, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true);
  win.loadFile(INDEX_HTML, { query: { mode: 'fx', kind: 'staticcat', bg: RECBG, v: String(Date.now()), slot: slot } });
  let sent = false;
  const sendIt = () => {
    if (sent || win.isDestroyed()) return;
    sent = true;
    try { win.webContents.send('vc:msg', { type: 'staticcat', on: true, size: 148 }); } catch {}
  };
  win.once('ready-to-show', () => {
    try {
      win.showInactive();
      win.setOpacity(cat[slot + 'Want'] ? 1 : 0); // 先建好、画好；已经要求可见的就别再压回 0
    } catch {}
    setTimeout(sendIt, 120);
  });
  win.webContents.on('did-finish-load', () => setTimeout(sendIt, 60));
  cat[slot] = win;
  cat[slot + 'Want'] = !hidden;
  log('[virus-cat] static cat at', slot, Math.round(cx) + ',' + Math.round(cy));
}

function spawnStaticCatWin(cat, hidden) {
  spawnStaticCatAt(cat, 'staticWin', 0, -300, hidden); // 正上方 300px
}

// 左下角 60° 方向（相对水平线向下 60°，x 向左、y 向下）
// 左下那只：距离和上方那只一样（300px），角度可调（相对水平线向下，默认 50°）
const LL_ANGLE_DEG = Number(process.env.DSH_VC_LLANG || 30);
function spawnStaticCatLowerLeft(cat, dist, hidden) {
  const r = Number(dist) || 300;
  const a = (LL_ANGLE_DEG * Math.PI) / 180;
  const dx = -Math.cos(a) * r;
  const dy = Math.sin(a) * r;
  spawnStaticCatAt(cat, 'staticWin2', dx, dy, !!hidden);
}
// 右下那只：镜像左下，角度可调（相对水平线向下，默认 60°），距离同样 300px
const LR_ANGLE_DEG = Number(process.env.DSH_VC_LRANG || 30);
function spawnStaticCatLowerRight(cat, dist, hidden) {
  const r = Number(dist) || 300;
  const a = (LR_ANGLE_DEG * Math.PI) / 180;
  const dx = Math.cos(a) * r;
  const dy = Math.sin(a) * r;
  spawnStaticCatAt(cat, 'staticWin3', dx, dy, !!hidden);
}
// 和中间那只"同一帧"出现：窗口早就建好并画好了，这里只是把透明度翻回 1
function showStaticCatWin(cat, slot) {
  const list = slot ? [slot] : ['staticWin', 'staticWin2', 'staticWin3'];
  for (const k of list) {
    cat[k + 'Want'] = true;
    const w = cat[k];
    if (!w || w.isDestroyed()) continue;
    try {
      w.setOpacity(1);
      w.showInactive();
    } catch {}
  }
}

function destroyStaticCatWin(cat) {
  for (const k of ['staticWin', 'staticWin2', 'staticWin3']) {
    try { if (cat[k]) cat[k].destroy(); } catch {}
    cat[k] = null;
  }
}

// 第四段结束后铺满整屏的那层：沿着 TRAIL_PATH 长出一串"复制猫"
function spawnTrail(cat) {
  if (cat.trailWin) return;
  const wa = primary().workArea;
  const win = new BrowserWindow({
    x: wa.x,
    y: wa.y,
    width: wa.width,
    height: wa.height,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    focusable: false,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: path.join(HELPER_DIR, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.setIgnoreMouseEvents(true, { forward: false });
  win.loadFile(INDEX_HTML, { query: { mode: 'fx', kind: 'trail', bg: RECBG, v: String(Date.now()) } });
  win.webContents.on('console-message', (_e, _lvl, msg) => log('[trail-console]', msg));
  win.webContents.on('did-finish-load', () => log('[virus-cat] trail page loaded'));
  // 方向按用户画的箭头：从右边开始，一路往左长过去
  const pts = TRAIL_PATH.slice()
    .reverse()
    .map((p) => [p[0] - 1536 / 2 + wa.width / 2, p[1] - 960 / 2 + wa.height / 2]);
  // 视频相位对齐：中间那只的 spin2.mp4 是第三段开始播的（12.59s 一轮），
  // 复制猫要跟它同相，不然每只都在别的角度上
  const loopLen = SEQ_D2 > 0 ? SEQ_D2 / 1000 : 12.59;
  const off = cat.dashAt ? (((Date.now() - cat.dashAt) / 1000) % loopLen) : 0;
  let sent = false;
  const sendTrail = () => {
    if (sent || win.isDestroyed()) return;
    sent = true;
    try {
      win.webContents.send('vc:msg', {
        type: 'trail',
        on: true,
        pts,
        count: TRAIL_COUNT,
        dur: TRAIL_MS,
        sprite: TRAIL_SPRITE,
        off: off,
      });
    } catch {}
    log('[virus-cat] trail window on', TRAIL_COUNT, 'cats');
  };
  win.once('ready-to-show', () => {
    try {
      win.showInactive();
      cat.win.setAlwaysOnTop(true, 'screen-saver');
      cat.win.moveTop();
    } catch {}
    // ready-to-show 可能早于页面里的 IPC 监听注册，等 did-finish-load 再发；再兜一个 500ms 定时器
    setTimeout(sendTrail, 120);
  });
  win.webContents.on('did-finish-load', () => setTimeout(sendTrail, 60));
  cat.trailWin = win;
  log('[virus-cat] trail window bounds', JSON.stringify(win.getBounds()));
}

function destroyTrail(cat) {
  try {
    if (cat.trailWin) cat.trailWin.destroy();
  } catch {}
  cat.trailWin = null;
}

function startDash(cat) {
  clearSeqTimers(cat);
  cat.playing = true;
  cat.seqPhase = 'dash';
  cat.dashT = 0;
  cat.dashV = null;
  cat.dashBounces = 0;
  cat.heat = 12;
  cat.tier = 4;
  cat.dashAt = Date.now();
  spawnCatcher(cat);
  prepareCrowd(cat); // 先把小猫层藏好建出来，第四段开场再显示
  send(cat, { type: 'dash', on: true });
  send(cat, { type: 'sequence', stage: 2 });
  log('[virus-cat] dash start (square bounce 15-90deg, loops video2)');
  // 复合音频（第二+第三段）放完 → 进第四段：瞬移到屏幕正中，样子不变，接第四段音频
  cat.seqTimers.push(seqLater(cat, () => {
      if (!cat.playing || cat.seqPhase !== 'dash') return;
      const wa = primary().workArea;
      cat.seqPhase = 'center';
      cat.dashV = null;
      cat.cx = wa.x + wa.width / 2;
      cat.cy = wa.y + wa.height / 2;
      setCatBounds(cat);
      showCrowd(cat); // 和猫跳到正中同一帧开始冒小猫
      send(cat, { type: 'audio4', on: true });
      log('[virus-cat] stage 4: center + score audio at', Math.round(cat.cx) + ',' + Math.round(cat.cy));
      cat.seqTimers.push(seqLater(cat, () => {
          if (!cat.playing || cat.seqPhase !== 'center') return;
          // 第四段放完 → 第五段：留在正中，不再发光，但继续旋转，接第五段音频
          cat.seqPhase = 'stage5';
          destroyCrowd(cat); // 小猫堆跟着第四段一起散掉，第五段只剩中间这只
          spawnStaticCatWin(cat, true); // 提前隐藏建好上面那只，避免出现时晚半拍
          spawnStaticCatLowerLeft(cat, 300, true); // 左下 60° 那只也提前隐藏建好
  spawnStaticCatLowerRight(cat, 300, true); // 右下 60° 那只同样提前隐藏建好
          send(cat, { type: 'stage5', on: true });
          log('[virus-cat] stage 5: stay center, glow off, keep spinning');
          // 第五段结束前 0.3 秒换成最初那只静态小猫
          cat.seqTimers.push(seqLater(cat, () => {
              if (!cat.playing || cat.seqPhase !== 'stage5') return;
              // 主进程这边也要把热度/等级归零，否则每 30Hz 的 state 会把 tier 又推回 4（静态猫会带金边）
              cat.tier = 0;
              cat.heat = 0;
              cat.squash = 0;
              cat.vx = 0;
              cat.vy = 0;
              cat.mode = 'hover';
              send(cat, { type: 'catimage' });
              showStaticCatWin(cat, 'staticWin');
              log('[virus-cat] stage 5: -0.3s -> back to the original cat sprite');
            }, Math.max(0, AUDIO5_MS - IMG_LEAD))
          );
          cat.seqTimers.push(seqLater(cat, () => {
              if (!cat.playing || cat.seqPhase !== 'stage5') return;
              // 第五段放完 → 第六段：正中那只和上方那只同时改播旋转视频（同一相位）
              startStage6(cat);
            }, AUDIO5_MS)
          );
        }, AUDIO4_MS + SEQ_CENTER_LEAD) // 收工时间仍对齐音频结尾，不因为提前落地而变早
      );
    }, DASH_BASE - SEQ_CENTER_LEAD)
  );
}

// 第六段：正中那只 + 上方那只，同时播放旋转视频
function startStage6(cat) {
  cat.seqPhase = 'stage6';
  // 第六段开头：两只先继续保持静态小猫图 0.2 秒，音频同时开始
  send(cat, { type: 'stage6audio', on: true });
  log('[virus-cat] stage 6: audio start, cats stay static for ' + S6_STATIC_MS + 'ms');
  cat.seqTimers.push(seqLater(cat, () => {
      if (!cat.playing || cat.seqPhase !== 'stage6') return;
      const loopLen = SEQ_D2 > 0 ? SEQ_D2 / 1000 : 12.59;
      const off = cat.dashAt ? (((Date.now() - cat.dashAt) / 1000) % loopLen) : 0;
      send(cat, { type: 'stage6', on: true, off: off });
      if (cat.staticWin && !cat.staticWin.isDestroyed()) {
        try {
          cat.staticWin.webContents.send('vc:msg', { type: 'stage6', on: true, off: off });
        } catch {}
      }
      log('[virus-cat] stage 6: both cats play the rotating video, off=' + off.toFixed(2));
    }, S6_STATIC_MS)
  );
  // 第六段快结束时（和第五段一样）：两只一起换回静态小猫图
  cat.seqTimers.push(seqLater(cat, () => {
      if (!cat.playing || cat.seqPhase !== 'stage6') return;
      cat.tier = 0;
      cat.heat = 0;
      cat.squash = 0;
      cat.vx = 0;
      cat.vy = 0;
      cat.mode = 'hover';
      send(cat, { type: 'catimage' });
      if (cat.staticWin && !cat.staticWin.isDestroyed()) {
        try { cat.staticWin.webContents.send('vc:msg', { type: 'stage6static', on: true }); } catch {}
      }
      showStaticCatWin(cat, 'staticWin2'); // 同一帧再把左下 60 度那只亮出来
      log('[virus-cat] stage 6: -' + S6_END_LEAD + 'ms -> back to the static cat sprites (+ lower-left one)');
    }, Math.max(0, AUDIO6_MS - S6_END_LEAD))
  );
  cat.seqTimers.push(seqLater(cat, () => {
      if (!cat.playing || cat.seqPhase !== 'stage6') return;
      startStage7(cat);
    }, AUDIO6_MS)
  );
}

// 第七段：三只（正中 + 上方 + 左下）先保持静态 0.2 秒，然后一起播放旋转视频
function startStage7(cat) {
  cat.seqPhase = 'stage7';
  send(cat, { type: 'stage7audio', on: true });
  log('[virus-cat] stage 7: audio start, three cats stay static for ' + S7_STATIC_MS + 'ms');
  cat.seqTimers.push(seqLater(cat, () => {
      if (!cat.playing || cat.seqPhase !== 'stage7') return;
      const loopLen = SEQ_D2 > 0 ? SEQ_D2 / 1000 : 12.59;
      const off = cat.dashAt ? (((Date.now() - cat.dashAt) / 1000) % loopLen) : 0;
      send(cat, { type: 'stage7', on: true, off: off });
      for (const slot of ['staticWin', 'staticWin2']) {
        const w = cat[slot];
        if (!w || w.isDestroyed()) continue;
        try { w.webContents.send('vc:msg', { type: 'stage7', on: true, off: off }); } catch {}
      }
      log('[virus-cat] stage 7: three cats play the rotating video, off=' + off.toFixed(2));
    }, S7_STATIC_MS)
  );
  cat.seqTimers.push(seqLater(cat, () => {
      if (!cat.playing || cat.seqPhase !== 'stage7') return;
      // 三只一起变回静态小猫图
      send(cat, { type: 'catimage' });
      cat.tier = 0;
      cat.heat = 0;
      cat.squash = 0;
      cat.vx = 0;
      cat.vy = 0;
      cat.mode = 'hover';
      for (const slot of ['staticWin', 'staticWin2']) {
        const w = cat[slot];
        if (!w || w.isDestroyed()) continue;
        try { w.webContents.send('vc:msg', { type: 'stage6static' }); } catch {}
      }
      showStaticCatWin(cat, 'staticWin3'); // 右下 60° 那只也在同一帧出现
      log('[virus-cat] stage 7: -' + S7_END_LEAD + 'ms -> three cats back to the static sprites');
    }, Math.max(0, AUDIO7_MS - S7_END_LEAD))
  );
  cat.seqTimers.push(seqLater(cat, () => {
      if (!cat.playing || cat.seqPhase !== 'stage7') return;
      startStage8(cat);
    }, AUDIO7_MS)
  );
}
// 第八段：四只（正中 + 上方 + 左上 + 右下）先静态 0.2s，然后一起播放旋转视频到音频结束
function startStage8(cat) {
  cat.seqPhase = 'stage8';
  send(cat, { type: 'stage8audio', on: true });
  log('[virus-cat] stage 8: audio start, four cats stay static for ' + S8_STATIC_MS + 'ms');
  cat.seqTimers.push(seqLater(cat, () => {
      if (!cat.playing || cat.seqPhase !== 'stage8') return;
      const loopLen = SEQ_D2 > 0 ? SEQ_D2 / 1000 : 12.59;
      const off = cat.dashAt ? (((Date.now() - cat.dashAt) / 1000) % loopLen) : 0;
      send(cat, { type: 'stage8', on: true, off: off });
      for (const slot of ['staticWin', 'staticWin2', 'staticWin3']) {
        const w = cat[slot];
        if (!w || w.isDestroyed()) continue;
        try {
          w.setAlwaysOnTop(true, 'screen-saver');
          w.moveTop();
        } catch {}
        try {
          w.setOpacity(0.99);
          setTimeout(() => { try { w.setOpacity(1); } catch {} }, 60);
        } catch {}
        try { w.webContents.send('vc:msg', { type: 'stage8', on: true, off: off }); } catch {}
      }
      log('[virus-cat] stage 8: four cats play the rotating video, off=' + off.toFixed(2));
    }, S8_STATIC_MS)
  );
  cat.seqTimers.push(seqLater(cat, () => {
      if (!cat.playing || cat.seqPhase !== 'stage8') return;
      // 比音频结尾提前 S8_END_LEAD 收工（四只小猫先消失）
      log('[virus-cat] stage 8: -' + S8_END_LEAD + 'ms -> four cats vanish');
      endSequence(cat);
      // 收工后先藏起来，等音频真正放完再过 POST8_SHOW_MS 才让初始小猫出现
      if (cat.win && !cat.win.isDestroyed()) {
        cat.forceHidden = true;
        try { cat.win.setOpacity(0); } catch {}
        log('[virus-cat] pet hidden, show again in ' + (S8_END_LEAD + POST8_SHOW_MS) + 'ms');
        cat.seqTimers.push(seqLater(cat, () => {
          if (!cat.win || cat.win.isDestroyed()) return;
          if (cat.playing) return;
          cat.forceHidden = false;
          cat.win.setOpacity(cat.ghost && !cat.hover ? 0 : 1);
          cat.win.setAlwaysOnTop(true, 'screen-saver');
          cat.win.moveTop();
          log('[virus-cat] pet shown again');
        }, S8_END_LEAD + POST8_SHOW_MS));
      }
    }, Math.max(0, AUDIO8_MS - S8_END_LEAD))
  );
}
// 第四段音频放完：猫留在正中继续发光旋转，小猫堆散掉，改成一串复制猫沿路径长出
function enterTrail(cat) {
  destroyCrowd(cat);
  cat.seqPhase = 'trail';
  cat.dashV = null;
  const wa = primary().workArea;
  cat.cx = wa.x + wa.width / 2;
  cat.cy = wa.y + wa.height / 2;
  setCatBounds(cat);
  spawnTrail(cat);
  log('[virus-cat] trail start: center cat stays, copies along path');
}

// 第四段：停在屏幕正中，继续发光、继续循环视频 2，只换音频
function stepCenter(cat) {
  const wa = primary().workArea;
  // 每 400ms 把猫窗重新提到 crowd 窗口之上
  if (!cat.topAt || Date.now() - cat.topAt > 400) {
    cat.topAt = Date.now();
    try {
      cat.win.setAlwaysOnTop(true, 'screen-saver');
      if (cat.crowdWin) cat.win.moveTop();
    } catch {}
  }
  cat.cx = wa.x + wa.width / 2;
  cat.cy = wa.y + wa.height / 2;
  cat.vx = 0;
  cat.vy = 0;
  if (cat.win && !cat.win.isDestroyed()) {
    try {
      cat.win.setBounds({ x: Math.round(cat.cx - WIN / 2), y: Math.round(cat.cy - WIN / 2), width: WIN, height: WIN });
    } catch {}
    if (cat.ready && cat.t - cat.sentAt > 1 / 30) {
      cat.sentAt = cat.t;
      send(cat, catState(cat));
    }
  }
}

// 跑图：在一个正方形里乱撞，每碰到边就拐弯，拐弯角度随机取 15°~90°
function stepDash(cat, dt) {
  const wa = primary().workArea;
  const cx = wa.x + wa.width / 2;
  const cy = wa.y + wa.height / 2;
  const half = boxHalf(); // 正方形半边长（BOX_RATIO 控制大小）
  const L = cx - half;
  const R = cx + half;
  const T = cy - half;
  const B = cy + half;

  if (!cat.dashV) {
    // 开局随机方向
    const a = Math.random() * Math.PI * 2;
    cat.dashV = { x: Math.cos(a), y: Math.sin(a) };
    cat.dashSpeed = Math.min(wa.width, wa.height) * 3.9; // ≈3600px/s
    cat.dashBounces = 0;
    cat.cx = cx;
    cat.cy = cy;
  }

  const sp = cat.dashSpeed;
  let nx = cat.cx + cat.dashV.x * sp * dt;
  let ny = cat.cy + cat.dashV.y * sp * dt;

  let axis = null;
  if (nx < L) {
    nx = L;
    axis = 'x';
  } else if (nx > R) {
    nx = R;
    axis = 'x';
  }
  if (ny < T) {
    ny = T;
    axis = axis === 'x' ? 'xy' : 'y';
  } else if (ny > B) {
    ny = B;
    axis = axis === 'x' ? 'xy' : 'y';
  }

  if (axis) {
    dashBounce(cat, axis, nx, ny, cx, cy);
    cat.dashBounces += 1;
    if (Date.now() - (cat.bounceLogAt || 0) > 200) {
      cat.bounceLogAt = Date.now();
      log('[virus-cat] dash bounce#' + cat.dashBounces, axis, 'deg=' + (Math.round((cat.lastTurn * 180) / Math.PI) || 0));
    }
  }

  cat.cx = nx;
  cat.cy = ny;
  cat.vx = cat.dashV.x * sp;
  cat.vy = cat.dashV.y * sp;

  if (cat.win && !cat.win.isDestroyed()) {
    try {
      cat.win.setBounds({ x: Math.round(cat.cx - WIN / 2), y: Math.round(cat.cy - WIN / 2), width: WIN, height: WIN });
    } catch {}
    if (cat.ready && cat.t - cat.sentAt > 1 / 60) {
      cat.sentAt = cat.t;
      send(cat, catState(cat));
    }
    if (Date.now() - (cat.posLogAt || 0) > 400) {
      cat.posLogAt = Date.now();
      log('[virus-cat] dash', 'sq', Math.round(cat.cx) + ',' + Math.round(cat.cy));
    }
  }
}

// 碰到某条边：先镜面反射，再随机拐 15°~90°（保证反弹后还朝盒子里走）
function dashBounce(cat, axis, nx, ny, cx, cy) {
  let vx = cat.dashV.x;
  let vy = cat.dashV.y;
  if (axis === 'x' || axis === 'xy') vx = -vx;
  if (axis === 'y' || axis === 'xy') vy = -vy;

  const inwardX = nx <= cx ? 1 : -1;
  const inwardY = ny <= cy ? 1 : -1;

  let best = null;
  for (let i = 0; i < 10; i += 1) {
    const deg = 15 + Math.random() * 75; // 15° ~ 90°
    const sign = Math.random() < 0.5 ? -1 : 1;
    const a = (sign * deg * Math.PI) / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const rx = vx * c - vy * s;
    const ry = vx * s + vy * c;
    const okX = axis.indexOf('x') === -1 || rx * inwardX > 0.05;
    const okY = axis.indexOf('y') === -1 || ry * inwardY > 0.05;
    if (okX && okY) {
      best = { x: rx, y: ry, deg: deg };
      break;
    }
    if (!best) best = { x: rx, y: ry, deg: deg };
  }
  const L2 = Math.hypot(best.x, best.y) || 1;
  cat.dashV = { x: best.x / L2, y: best.y / L2 };
  cat.lastTurn = (best.deg * Math.PI) / 180;
}


function endSequence(cat) {
  destroyMenuBtnWin(cat);
  destroyStaticCatWin(cat);
  clearSeqTimers(cat);
  destroyCatcher(cat);
  destroyCrowd(cat);
  destroyTrail(cat);
  cat.playing = false;
  cat.seqPhase = null;
  cat.clicks = 0;
  cat.heat = 0;
  cat.tier = 0;
  cat.squash = 0;
  cat.dashV = null;
  // 回到原位（序列开始前的位置）
  if (cat.homeAt) {
    cat.cx = cat.homeAt.x;
    cat.cy = cat.homeAt.y;
  }
  cat.anchor = { x: cat.cx, y: cat.cy };
  setCatBounds(cat);
  send(cat, { type: 'dash', on: false });
  send(cat, { type: 'sequence', stage: 0 });
  send(cat, { type: 'tier', tier: 0 });
  log('[virus-cat] sequence end -> idle at', Math.round(cat.cx) + ',' + Math.round(cat.cy));
}

// 菜单里的"停止并回到初始状态"：立刻停音频/视频、中断所有阶段、猫回原位
function resetToIdle(cat) {
  if (!cat || cat.dead) return;
  log('[virus-cat] reset -> idle (menu)');
  cat.paused = false;
  cat.forceHidden = false;
  cat.dashT = 0;
  cat.dashV = null;
  endSequence(cat);
  send(cat, { type: 'pause', on: false });
  send(cat, { type: 'catimage' });
  // 复位后必须把窗口的置顶/可交互状态重新钉一遍：
  // 演出期间窗口被 show/hide、setIgnoreMouseEvents 反复改过，直接 showInactive 会掉层或保持穿透，
  // 表现就是"猫还在、但怎么点都没反应"。
  try {
    if (cat.win && !cat.win.isDestroyed()) {
      if (!cat.win.isVisible()) cat.win.showInactive();
      cat.forceHidden = false;
      cat.win.setAlwaysOnTop(true, 'screen-saver');
      cat.win.moveTop();
      cat.win.setIgnoreMouseEvents(!cat.hover, { forward: true });
      cat.win.setOpacity(cat.ghost && !cat.hover ? 0 : 1);
    }
  } catch {}
}

function cancelIdleAnim(cat) {
  if (!cat || !cat.idleAnim) return;
  cat.idleAnim = false;
  if (cat.idleTimer) { clearTimeout(cat.idleTimer); cat.idleTimer = null; }
  send(cat, { type: 'idleanim', on: false });
  cat.lastIdleAt = Date.now();
}

function startIdleAnim(cat) {
  if (!cat || cat.dead || cat.playing || cat.paused || cat.idleAnim) return;
  cat.idleAnim = true;
  cat.idleAnimAt = Date.now();
  cat.lastIdleAt = Date.now();
  send(cat, { type: 'idleanim', on: true, rate: IDLE_ANIM_RATE });
  log('[virus-cat] idle anim -> play video 2 in place (silent)');
  cat.idleTimer = setTimeout(() => {
    if (!cat.idleAnim) return;
    cat.idleAnim = false;
    cat.idleTimer = null;
    cat.idleAnimAt = Date.now();
    cat.lastIdleAt = Date.now();
    send(cat, { type: 'idleanim', on: false });
    cat.lastIdleAt = Date.now();
    log('[virus-cat] idle anim -> back to static');
  }, IDLE_ANIM_LEN);
}

function onClick(cat) {
  const now = Date.now();
  cancelIdleAnim(cat);
  cat.idleAnimAt = Date.now();
  if (now - cat.lastClickAt < 95) return;
  const gap = now - cat.lastClickAt; // 先算间隔，再更新 lastClickAt
  cat.lastClickAt = now;
  if (cat.playing) {
    // 跑图中点一下 = 停下；播放序列中只是喵一声，不打断
    if (cat.seqPhase === 'dash' || cat.seqPhase === 'trail') {
      endSequence(cat);
      return;
    }
    meow(cat, 1);
    return;
  }
  // 只有间隔 < CLICK_GAP_MS 的连点才叠加；超时就从头数
  if (gap > CLICK_GAP_MS) cat.clicks = 1; else cat.clicks += 1;
  cat.squash = 1;
  const variant = Math.random() < 0.75 ? 0 : 1 + Math.floor(Math.random() * 2);
  log('[virus-cat] click id=' + cat.id + ' clicks=' + cat.clicks + ' gap=' + gap);
  meow(cat, variant);
  // 停手 CLICK_GAP_MS 之后清零
  if (cat.clickResetTimer) clearTimeout(cat.clickResetTimer);
  cat.clickResetTimer = setTimeout(() => {
    cat.clickResetTimer = null;
    if (cat.playing) return;
    if (cat.clicks > 0) log('[virus-cat] click streak cleared (' + cat.clicks + ' -> 0)');
    cat.clicks = 0;
  }, CLICK_GAP_MS);
  if (cat.clicks >= SEQ_START) {
    if (cat.clickResetTimer) { clearTimeout(cat.clickResetTimer); cat.clickResetTimer = null; }
    startSequence(cat);
  }
}

// ---------------------------------------------------------------- 光标命中
// 透明窗口默认点击穿透；主进程轮询光标位置，光标压到猫身上时把该窗口切成可交互。
// 这样小猫四周的透明区域始终可以被点穿，只有猫本体吃点击。
let hoverPollAt = 0;
function pollHover() {
  const p = screen.getCursorScreenPoint();
  for (const cat of cats.values()) {
    if (!cat.win || cat.win.isDestroyed()) continue;
    const kk = cat.k || 1;
    // 命中区比画出来的形状再放大一点（HIT_GROW）：鼠标还没完全压上来窗口就已经可交互，
    // 否则移到按钮上立刻点，第一下会因为窗口还在"穿透"状态而被桌面吃掉。
    const HIT_GROW = 1.45;
    const dx = (p.x - cat.cx) / (58 * kk * HIT_GROW);
    const dy = (p.y - (cat.cy + 2)) / (62 * kk * HIT_GROW);
    // 猫身 + 右上角菜单键都算可交互区域（演出期间猫身上不画菜单键，只有初始位置那个固定窗口）
    const hasBtn = !cat.playing;
    const mbx = cat.cx + 65 * kk;
    const mby = cat.cy - 81 * kk;
    const mdx = (p.x - mbx) / (40 * kk);
    const mdy = (p.y - mby) / (40 * kk);
    // 按住/拖动期间必须一直可交互，否则鼠标一滑出猫身就变成穿透，松手收不到 → 卡在拖动
    const inside = !cat.forceHidden && (cat.pressed || cat.dragging || dx * dx + dy * dy <= 1 || (hasBtn && mdx * mdx + mdy * mdy <= 1));
    // 每次都重钉一遍穿透状态：窗口在演出里被 hide/show、被别的窗口顶上来之后，
    // 之前记录的"可交互"会失效，表现就是猫还在但怎么点都没反应。
    try {
      cat.win.setIgnoreMouseEvents(!inside, { forward: true });
    } catch {}
    if (inside !== cat.hover) {
      cat.hover = inside;
      if (inside) {
        try { cat.win.setAlwaysOnTop(true, 'screen-saver'); } catch {}
      }
      let b = null;
      try { b = cat.win.getBounds(); } catch {}
      log('[virus-cat] hover', cat.id, inside, 'cursor=' + p.x + ',' + p.y, 'cat=' + Math.round(cat.cx) + ',' + Math.round(cat.cy), 'bounds=' + JSON.stringify(b));
      send(cat, { type: 'hover', hover: inside });
    }

    // 演出期间的固定菜单键（自己一个小窗）
    const btn = cat.menuBtnWin;
    if (btn && !btn.isDestroyed()) {
      const base = cat.homeAt || { x: cat.cx, y: cat.cy };
      const bx = base.x + 65 * kk;
      const by = base.y - 81 * kk;
      const onBtn = Math.hypot(p.x - bx, p.y - by) <= 40 * kk;
      if (onBtn !== cat.menuBtnHover) {
        cat.menuBtnHover = onBtn;
        try { btn.setIgnoreMouseEvents(!onBtn, { forward: true }); } catch {}
        try { btn.webContents.send('vc:msg', { type: 'menubtn', on: onBtn }); } catch {}
        if (onBtn) { try { btn.setAlwaysOnTop(true, 'screen-saver'); btn.moveTop(); } catch {} }
      }
    }
  }
}

// ---------------------------------------------------------------- loop

// —— 窗口实时尺寸 ——
// 体型滑块会改窗口大小，但历史代码里到处都用固定的 WIN；只要 cat.k != 1，
// "猫中心 -> 窗口左上角"就会算错 105*(k-1) 像素，鼠标一拖就判成"离猫很远"，
// 于是窗口变穿透、鼠标正在拖的那一下直接丢事件（表现：点了没反应 / 只能抖一下）。

// —— 真实 DPI 系数 ——
// 不能用 db.width / win.width：宠物窗口只有 210 DIP，宽度取整误差会把 2 算成 7。
// 用"这块屏幕物理宽度 / 这台机器最小窗口能有多窄"来推，稳定得到 2（本机实测）。
function realScaleFor(disp, winDips) {
  if (!disp || !disp.bounds) return 1;
  const px = disp.bounds.width || 0;
  if (!px) return 1;
  const dips = winDips || 0;
  // 窗口越窄，px/dips 的取整误差越大（210 宽会算出 7），所以按窗口宽度分档：
  // 窗口 >= 700 DIP 时比值才可信；否则只能用本机默认逻辑宽度兜底。
  if (dips >= 700) return Math.max(1, Math.min(5, Math.round(px / dips)));
  const guess = px / 1536;
  return Math.max(1, Math.min(5, Math.round(guess) || 1));
}

function catWinSize(cat) {
  try {
    if (cat && cat.win && !cat.win.isDestroyed()) {
      const b = cat.win.getBounds();
      if (b && b.width > 0) return b.width;
    }
  } catch (e) {}
  return WIN;
}
function placeCat(cat) {
  if (!cat || !cat.win || cat.win.isDestroyed()) return;
  const WS = catWinSize(cat);
  try {
    cat.win.setBounds({ x: Math.round(cat.cx - WS / 2), y: Math.round(cat.cy - WS / 2), width: WS, height: WS });
  } catch (e) {}
}

function tick() {
  try { tickBody(); } catch (e) { log('[virus-cat] tick error', (e && e.stack) || e); }
}

function tickBody() {
  const now = performance.now();
  const rawDt = (now - lastTick) / 1000 || 0.016;
  const dt = Math.min(0.05, rawDt);
  lastTick = now;
  // 菜单打开时：压在猫窗口上面 + 鼠标离开菜单就自动收起
  for (const cat of cats.values()) {
    if (!cat.menuWin || cat.menuWin.isDestroyed()) continue;
    const mw = cat.menuWin;
    if (Date.now() - (cat.menuRaiseAt || 0) > 300) {
      cat.menuRaiseAt = Date.now();
      try { mw.moveTop(); } catch {}
    }
    const b = mw.getBounds();
    const p = screen.getCursorScreenPoint();
    const inside = p.x >= b.x - 6 && p.x <= b.x + b.width + 6 && p.y >= b.y - 6 && p.y <= b.y + b.height + 6;
    if (inside) {
      cat.menuEntered = true;
      cat.menuAwayAt = 0;
    } else if (cat.menuEntered) {
      if (!cat.menuAwayAt) cat.menuAwayAt = Date.now();
      else if (!cat.playing && Date.now() - cat.menuAwayAt > 450) {
        cat.menuEntered = false;
        const w = cat.menuWin;
        cat.menuWin = null;
        if (w && !w.isDestroyed()) { try { w.destroy(); } catch {} }
      }
    }
  }
  if (now - hoverPollAt > 28) {
    hoverPollAt = now;
    pollHover();
    for (const cat of cats.values()) {
      if (!cat.win || cat.win.isDestroyed()) continue;
      // 播放序列时必须可见：不然开着"平时隐身"就看不到整段演出了
  const want = ((cat.ghost && !cat.hover) && !cat.playing && !cat.pressed) || cat.forceHidden ? 0 : 1;
      try {
        if (Math.abs(cat.win.getOpacity() - want) > 0.001) cat.win.setOpacity(want);
      } catch {}
    }
  }
  for (const cat of cats.values()) {
    if (!cat.dead && !cat.paused) stepCat(cat, dt);
    // 待机看门狗：每秒告诉渲染层"现在应该在待机"，让它清掉任何残留的视频播放
    if (!cat.playing && !cat.idleAnim && Date.now() - (cat.lastIdleAt || 0) > 1000) {
      cat.lastIdleAt = Date.now();
      send(cat, { type: 'idle' });
    }
    // 待机动作：安静一段时间后，在原地静音播一遍第一段视频
    if (!cat.playing && !cat.paused && !cat.idleAnim && Date.now() - (cat.idleAnimAt || 0) > IDLE_ANIM_MS) {
      cat.idleAnimAt = Date.now();
      startIdleAnim(cat);
    }
  }
  for (const [id, cat] of cats) {
    if (cat.dead) cats.delete(id);
  }
  if (cats.size === 0 && Date.now() - bootAt > 4000) {
    // 全部被点死在理论上不会发生；安全退出
    quit('no-cats');
  }
}

// ---------------------------------------------------------------- app
function createInitial() {
  const wa = primary().workArea;
  for (let i = 0; i < Math.max(1, Math.round(num(process.env.DSH_VC_COUNT, 1))); i++) {
    // 默认落在左下角（任务栏上方），不跟别的小宠物抢右下角
    const p =
      i === 0
        ? { x: wa.x + WIN / 2 + 60, y: wa.y + wa.height - WIN / 2 - 40 }
        : randInWorkArea(WIN);
    const cat = new Cat(++catSeq, { cx: p.x, cy: p.y });
    cat.mode = 'idle';
    cat.speed = 0;
    cats.set(cat.id, cat);
    makeCatWindow(cat);
  }
}

let quitting = false;
function quit(reason) {
  if (quitting) return;
  quitting = true;
  log('[virus-cat] quit:', reason);
  clearInterval(ticker);
  for (const cat of cats.values()) {
    try { cat.win && !cat.win.isDestroyed() && cat.win.destroy(); } catch {}
  }
  for (const fx of fxs) {
    try { fx.win && !fx.win.isDestroyed() && fx.win.destroy(); } catch {}
  }
  app.quit();
}

ipcMain.on('vc:ipc-ready', (evt, payload) => {
  const id = Number(payload && payload.id);
  const cat = cats.get(id);
  if (cat && !cat.ready) {
    log('[virus-cat] ipc-ready', payload);
    cat.ready = true;
    send(cat, { type: 'volume', v: cat.volume });
    send(cat, { type: 'hello', scale: SCALE, tier: cat.tier, heat: cat.heat, maxCats: MAX_CATS });
  }
});

ipcMain.on('vc:hover', (evt, hover) => {
  // 由主进程轮询光标决定是否可点击（见 pollHover），这里只做兜底：永远保持穿透
  void evt;
  void hover;
});

ipcMain.on('vc:dashstop', () => {
  for (const cat of cats.values()) {
    if (cat.seqPhase === 'dash' || cat.seqPhase === 'trail') {
      log('[virus-cat] dash stopped by click');
      endSequence(cat);
      return;
    }
  }
});

ipcMain.on('vc:click', (evt) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  if (!win) return;
  for (const cat of cats.values()) {
    if (cat.win === win) {
      onClick(cat);
      return;
    }
  }
});

// 拖动：指针一律用系统光标（screen.getCursorScreenPoint）。它不受"窗口自己移动"影响，
// 是唯一不会被自我抵消/自我加速的参考；页面报的 screenX 只用来"启动"拖动判定。
ipcMain.on('vc:dragmove', (evt, ev) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  if (!win) return;
  for (const cat of cats.values()) {
    if (cat.win !== win) continue;
    if (!cat.pressed) return;
    if (!cat.dragging && cat.pressAt) {
      const p = screen.getCursorScreenPoint();
      const dx = p.x - cat.pressAt.x;
      const dy = p.y - cat.pressAt.y;
      if (Math.hypot(dx, dy) > 5) {
        cat.dragging = true;
        cat.lastPtrX = p.x;
        cat.lastPtrY = p.y;
        log('[virus-cat] drag start at ' + p.x + ',' + p.y);
      }
    }
    return;
  }
});

// 点一下命中：主进程把窗口翻成可交互的，渲染层不用管
ipcMain.on('vc:taphit', () => {});

// 按下：先只记住起点，真的拖出去超过 8px 才进拖拽（避免点击被当成拖动）
ipcMain.on('vc:press', (evt, ev) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  if (!win) return;
  for (const cat of cats.values()) {
    if (cat.win !== win) continue;
    // 点猫本体也算"点外面"：面板开着就顺手关掉，不用非得再点一次三横杠
    if (cat.menuWin && !cat.menuWin.isDestroyed()) {
      const w = cat.menuWin;
      cat.menuWin = null;
      cat.menuEntered = false;
      cat.menuAwayAt = 0;
      try { w.destroy(); } catch {}
      log('[virus-cat] menu closed by cat press');
    }
    // 按下点只用来"什么时候算开始拖"，主进程一律以系统光标（物理像素）为准。
    const cp = screen.getCursorScreenPoint();
    const p = { x: cp.x, y: cp.y };
    cancelIdleAnim(cat);
    cat.idleAnimAt = Date.now();
    cat.pressed = true;
    cat.dragging = false;
    // 单位一次定死：光标物理像素 / DIP。窗口尺寸必须是"宠物窗口"的，
    // 不能用 win.getBounds()（win 可能是菜单窗，宽度 300 -> 算成 10）。
    let ptrUnit = 1;
    try {
      const pw = cat.win && !cat.win.isDestroyed() ? cat.win.getBounds() : null;
      const d0 = screen.getDisplayMatching(pw || { x: p.x, y: p.y, width: 1, height: 1 });
      ptrUnit = realScaleFor(d0, (pw && pw.width) || 0);
    } catch (e) { ptrUnit = 1; }
    cat.ptrUnit = ptrUnit;
    cat.lastPtrX = null;
    cat.lastPtrY = null;
    cat.dragBase = { xp: p.x / ptrUnit, yp: p.y / ptrUnit, cx: cat.cx, cy: cat.cy };
    cat.ptrX = p.x;
    cat.ptrY = p.y;
    cat.pressAt = { x: p.x, y: p.y };
    // 单位已经由显示器/窗口 bounds 现算成 ptrUnit，这里不再从页面坐标猜
    cat.cursorPerDip = 1;
    cat.dragBase.xDip = p.x / cat.cursorPerDip;
    cat.dragBase.yDip = p.y / cat.cursorPerDip;
    cat.pressAtMs = Date.now();
    log('[virus-cat] press at cursor=' + p.x + ',' + p.y + ' cat=' + Math.round(cat.cx) + ',' + Math.round(cat.cy));
    try {
      win.focus();
    } catch {}
    return;
  }
});

// 松开：拖过就算移动，没拖过就算点击（喵 + 升温）
ipcMain.on('vc:release', (evt, ev) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  if (!win) return;
  for (const cat of cats.values()) {
    if (cat.win !== win) continue;
    if (ev && Number.isFinite(ev.sx) && Number.isFinite(ev.sy)) {
      cat.ptrX = ev.sx;
      cat.ptrY = ev.sy;
    }
    const wasDragging = cat.dragging;
    cat.pressed = false;
    cat.dragging = false;
    cat.lastPtrX = undefined;
    cat.lastPtrY = undefined;
    if (wasDragging) {
      // —— 甩出去：按松手前 120ms 的指针速度给猫一个初速度，之后靠 Fling 物理自己飞、撞墙弹、慢慢停
      const hist = cat.dragHist || [];
      cat.dragHist = [];
      let fvx = 0;
      let fvy = 0;
      if (hist.length >= 2) {
        const a = hist[0];
        const b = hist[hist.length - 1];
        const sec = Math.max(0.016, (b.t - a.t) / 1000);
        fvx = ((b.x - a.x) / sec) * FLING_GAIN;
        fvy = ((b.y - a.y) / sec) * FLING_GAIN;
      }
      const sp = Math.hypot(fvx, fvy);
      if (sp > FLING_MIN_SPEED) {
        const cap = FLING_MAX_SPEED;
        const mul = sp > cap ? cap / sp : 1;
        cat.vx = fvx * mul;
        cat.vy = fvy * mul;
        cat.flinging = true;
        cat.flingFrames = 0;
        cat.flingLogAt = 0;
        cat.mode = 'fling';
        log('[virus-cat] fling v=' + Math.round(cat.vx) + ',' + Math.round(cat.vy));
      } else {
        cat.vx = 0;
        cat.vy = 0;
        cat.flinging = false;
      }
      cat.anchor = { x: cat.cx, y: cat.cy };
      // 拖到哪，哪就是新的"家"：菜单面板跟着走，下次演出也从这里开始/回到这里
      cat.homeAt = { x: cat.cx, y: cat.cy };
      log('[virus-cat] dragged to', Math.round(cat.cx) + ',' + Math.round(cat.cy), 'home=' + Math.round(cat.homeAt.x) + ',' + Math.round(cat.homeAt.y));
    } else {
      onClick(cat);
    }
    return;
  }
});

ipcMain.on('vc:dbg', (evt, payload) => {
  log('[virus-cat] dbg', payload);
});

// 第八段音频真正放完（渲染层 Audio 的 ended 事件）→ 立刻收工，和声音同一时刻消失
ipcMain.on('vc:stage8ended', () => {
  const cat = [...cats.values()][0]; // cats 是 Map，不是数组
  if (!cat || !cat.playing || cat.seqPhase !== 'stage8') return;
  log('[virus-cat] stage 8 audio ended -> all cats gone now');
  endSequence(cat);
});
ipcMain.on('vc:fx-ready', () => {});

ipcMain.on('vc:openmenu', () => {
  const cat = [...cats.values()][0];
  if (!cat) return;
  // 开关式：面板开着就关掉（之前这里只会"再抬一次"，所以看起来关不掉）
  if (cat.menuWin && !cat.menuWin.isDestroyed()) {
    const w = cat.menuWin;
    cat.menuWin = null;
    cat.menuEntered = false;
    cat.menuAwayAt = 0;
    try { w.destroy(); } catch {}
    log('[virus-cat] menu closed by button');
    return;
  }
  openMenuWin(cat);
});

function broadcastRecbg(bg) {
  for (const cat of cats.values()) {
    const wins = [cat.win, cat.staticWin, cat.staticWin2, cat.staticWin3, cat.menuWin];
    for (const w of wins) {
      if (!w || w.isDestroyed()) continue;
      try { w.webContents.send('vc:msg', { type: 'recbg', bg: bg }); } catch {}
    }
  }
}

ipcMain.on('vc:setting', (evt, p) => {
  const cat = [...cats.values()][0];
  if (!p || !p.key) return;
  if (p.key === 'volume') {
    SETTINGS.volume = Math.max(0, Math.min(1, Number(p.value)));
    if (cat) { cat.volume = SETTINGS.volume; send(cat, { type: 'volume', v: SETTINGS.volume }); }
  } else if (p.key === 'size') {
    SETTINGS.size = Math.max(0.6, Math.min(1.8, Number(p.value)));
    if (cat) {
      cat.k = SETTINGS.size;
      try {
        if (cat.win && !cat.win.isDestroyed()) {
          const WS = winSize(cat);
          cat.win.setSize(WS, WS);
        }
      } catch {}
      setCatBounds(cat);
    }
  } else if (p.key === 'stop') {
    if (cat) resetToIdle(cat);
  } else if (p.key === 'pause') {
    if (cat) pauseSequence(cat, !!p.value);
  } else if (p.key === 'recbg') {
    SETTINGS.recbg = !!p.value;
    RECBG = SETTINGS.recbg ? 'green' : '';
    broadcastRecbg(RECBG);
  } else if (p.key === 'meow') {
    const want = String(p.value || 'synth');
    const ok = want === 'synth' || soundList().some((s) => s.file === want);
    SETTINGS.meow = ok ? want : 'synth';
    if (cat) send(cat, { type: 'soundlist', list: soundList(), kind: SETTINGS.meow });
  } else if (p.key === 'trymeow') {
    // 试听：只发一声给猫窗口，不写进设置
    if (cat) {
      const want = String(p.value || SETTINGS.meow);
      send(cat, { type: 'soundlist', list: soundList(), kind: want === 'synth' ? 'synth' : SETTINGS.meow });
      send(cat, { type: 'trymeow' });
    }
    return;
  } else if (p.key === 'ghost') {
    SETTINGS.ghost = !!p.value;
    if (cat) {
      cat.ghost = SETTINGS.ghost;
      // 关掉隐身时立刻恢复不透明，别等下一次 28ms 轮询（也不会被卡在 0）
      if (!cat.ghost) {
        try {
          if (cat.win && !cat.win.isDestroyed()) cat.win.setOpacity(1);
        } catch {}
      }
      log('[virus-cat] ghost ->', cat.ghost, 'opacity=', cat.win ? cat.win.getOpacity() : 'n/a');
    }
  }
  // 绿幕底色只是本次运行的临时状态，不写进文件，免得下次启动莫名其妙变绿
  if (saveSettingsTimer) clearTimeout(saveSettingsTimer);
  saveSettingsTimer = setTimeout(() => {
    saveSettingsTimer = null;
    saveSettings(Object.assign({}, SETTINGS, { recbg: false }));
  }, 120);
  log('[virus-cat] setting', p.key, p.value);
});

ipcMain.on('vc:quit', () => quit('ipc-quit'));

app.on('window-all-closed', () => {
  // 保留进程：随时可以再开
});

app.whenReady().then(() => {
  createInitial();
  lastTick = performance.now();
  ticker = setInterval(tick, 16);

  // 宿主断开（DSH 侧管道关闭）→ 自动退出
  if (process.env.DSH_VC_STANDALONE !== '1') {
    process.stdin.on('close', () => quit('stdin-closed'));
    process.stdin.on('end', () => quit('stdin-end'));
    process.stdin.resume();
  }

  if (EXIT_AFTER_MS > 0) setTimeout(() => quit('exit-after'), EXIT_AFTER_MS);
  log('[virus-cat] helper started scale=' + SCALE + ' win=' + WIN + ' cats=' + cats.size);
});

process.on('uncaughtException', (e) => {
  log('[virus-cat] uncaught:', (e && e.stack) || String(e));
});
process.on('SIGTERM', () => quit('sigterm'));
process.on('SIGINT', () => quit('sigint'));
