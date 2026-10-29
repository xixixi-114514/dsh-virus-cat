// dsh-virus-cat —— 宿主半侧（Cordis 插件）
//
// 职责极简：把 Electron helper 拉起来，然后托管它的生命周期。
// 所有视觉/交互都在 runtime/electron-helper/ 里（透明置顶小窗 + Canvas 画的猫）。
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-virus-cat';
export const inject = [];

const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const HELPER_DIR = join(PACKAGE_ROOT, 'runtime', 'electron-helper');

function logDir() {
  const base = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local') || tmpdir();
  return join(base, 'dsh-virus-cat');
}

function logTail(msg) {
  try {
    const dir = logDir();
    mkdirSync(dir, { recursive: true });
    const line = `[${new Date().toISOString()}] [virus-cat:host] ${msg}\n`;
    appendFileSync(join(dir, 'host.log'), line);
  } catch {
    /* 日志失败不影响主流程 */
  }
}

// 找 Electron：环境变量 > DSH 自己下好的 > electron 缓存
function findElectron() {
  const candidates = [
    process.env.DSH_VC_ELECTRON,
    join(homedir(), '.dsh', 'electron', 'electron.exe'),
    join(homedir(), '.dsh', 'electron', 'electron'),
    join(homedir(), 'AppData', 'Local', 'electron', 'electron.exe'),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

export function apply(ctx) {
  if (process.platform !== 'win32' && process.platform !== 'darwin' && process.platform !== 'linux') {
    logTail(`unsupported platform: ${process.platform}`);
    return;
  }
  if (!existsSync(HELPER_DIR)) {
    logTail(`helper dir missing: ${HELPER_DIR}`);
    return;
  }
  const electron = findElectron();
  if (!electron) {
    logTail('electron binary not found (set DSH_VC_ELECTRON to override)');
    return;
  }

  let child = null;
  let disposed = false;
  let restarts = 0;
  let restartTimer = null;

  const start = () => {
    if (disposed || child) return;
    const env = { ...process.env };
    // DSH 桌面进程自己跑在 ELECTRON_RUN_AS_NODE=1 下，直接继承会让 electron.exe 当成 node 起来
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.DSH_VC_STANDALONE;
    try {
      mkdirSync(logDir(), { recursive: true });
    } catch {
      /* ignore */
    }
    env.DSH_VC_LOG = env.DSH_VC_LOG || join(logDir(), 'helper.log');
    env.DSH_VC_HOST_PID = String(process.pid);

    try {
      child = spawn(electron, [HELPER_DIR], {
        env,
        cwd: PACKAGE_ROOT,
        stdio: ['pipe', 'ignore', 'ignore'],
        windowsHide: true,
      });
      logTail(`spawned ${electron} pid=${child.pid}`);
    } catch (err) {
      logTail(`spawn failed: ${err && err.message}`);
      child = null;
      return;
    }

    child.on('error', (err) => logTail(`child error: ${err && err.message}`));

    child.on('exit', (code, signal) => {
      logTail(`child exit code=${code} signal=${signal}`);
      child = null;
      if (disposed || restarts >= 5) return;
      restarts += 1;
      restartTimer = setTimeout(start, 1500);
      if (restartTimer.unref) restartTimer.unref();
    });
  };

  const stop = () => {
    disposed = true;
    if (restartTimer) clearTimeout(restartTimer);
    if (child) {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      child = null;
    }
  };

  start();

  // 插件被卸载/停用 / 宿主退出时收摊
  try {
    ctx.on('dispose', stop);
  } catch {
    /* 老版本 cordis 没有 dispose 事件，忽略 */
  }
  const onExit = () => stop();
  process.once('exit', onExit);
}
