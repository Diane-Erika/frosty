import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { Scene, SnowCommand, SnowAPI } from '../shared/types'

const snowAPI: SnowAPI = {
  onScene(callback) {
    const handler = (_event: IpcRendererEvent, scene: Scene): void => callback(scene)
    ipcRenderer.on('scene', handler)
    return () => ipcRenderer.off('scene', handler)
  },

  onCmd(callback) {
    const handler = (_event: IpcRendererEvent, command: SnowCommand): void => callback(command)
    ipcRenderer.on('cmd', handler)
    return () => ipcRenderer.off('cmd', handler)
  },

  setIgnore(ignore) {
    ipcRenderer.send('set-ignore', ignore)
  }
}

contextBridge.exposeInMainWorld('snowAPI', snowAPI)
