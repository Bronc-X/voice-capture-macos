"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("voiceDesktop", {
  platform: process.platform,
  requestMicrophone: () => ipcRenderer.invoke("voice:microphone"),
  saveFile: (filename, bytes) => ipcRenderer.invoke("voice:save", { filename, bytes })
});
