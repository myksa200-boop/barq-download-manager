'use strict';
/** الجسر الآمن بين الواجهة (HTML/JS) والعملية الرئيسية — الواجهة لا تصل إلى Node مباشرة */
const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = ['evt:update', 'evt:progress', 'evt:removed', 'evt:reload', 'evt:settings', 'evt:queues', 'evt:external',
  'evt:batch', 'evt:command', 'evt:complete', 'evt:failed', 'evt:sound', 'evt:toast'];

contextBridge.exposeInMainWorld('api', {
  call: async (channel, ...args) => {
    const r = await ipcRenderer.invoke(channel, ...args);
    if (!r.ok) throw new Error(r.error);
    return r.data;
  },
  on: (evt, cb) => {
    if (!EVENTS.includes(evt)) throw new Error('unknown event ' + evt);
    const fn = (_e, ...a) => cb(...a);
    ipcRenderer.on(evt, fn);
    return () => ipcRenderer.removeListener(evt, fn);
  },
  closeWindow: () => ipcRenderer.send('win:close'),
  resizeWindow: (h) => ipcRenderer.send('win:resize', h),
  platform: process.platform,
});
