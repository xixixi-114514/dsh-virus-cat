'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const params = new URLSearchParams(window.location.search);
const mode = params.get('mode') || 'cat';
const id = Number(params.get('id') || 0) || 0;
const kind = params.get('kind') || 'boom';
const bg = params.get('bg') || '';
const slot = params.get('slot') || '';

contextBridge.exposeInMainWorld('vc', {
  mode,
  id,
  kind,
  bg,
  slot,
  ready() {
    ipcRenderer.send('vc:ipc-ready', { id });
  },
  hover(h) {
    ipcRenderer.send('vc:hover', !!h);
  },
  click() {
    ipcRenderer.send('vc:click');
  },
  dashStop() {
    ipcRenderer.send('vc:dashstop');
  },
  tapHit() {
    // 主进程轮询说是"命中"才翻成可交互，所以按下那一刻先让它再确认一次
    ipcRenderer.send('vc:taphit');
  },
  press(sx, sy) {
    // screenX/Y 是 CSS 像素（DIP），主进程那边直接拿来用，不再做任何缩放换算
    ipcRenderer.send('vc:press', { sx, sy });
  },
  release(sx, sy) {
    ipcRenderer.send('vc:release', { sx, sy });
  },
  dragMove(sx, sy) {
    ipcRenderer.send('vc:dragmove', { sx, sy });
  },
  quit() {
    ipcRenderer.send('vc:quit');
  },
  openMenu() {
    ipcRenderer.send('vc:openmenu');
  },
  setting(key, value) {
    ipcRenderer.send('vc:setting', { key: key, value: value });
  },
  stage8Ended() {
    ipcRenderer.send('vc:stage8ended');
  },
  dbg(payload) {
    ipcRenderer.send('vc:dbg', payload);
  },
  onMessage(fn) {
    if (typeof fn !== 'function') return () => {};
    const handler = (_evt, msg) => fn(msg);
    ipcRenderer.on('vc:msg', handler);
    return () => ipcRenderer.off('vc:msg', handler);
  },
});
