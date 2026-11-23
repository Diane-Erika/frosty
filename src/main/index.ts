import { app, BrowserWindow, ipcMain, screen } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import type { Scene, WindowRect } from '../shared/types'

const SKIP_OWNERS = new Set([
  'Dock',
  'Window Server',
  'WindowManager',
  'Control Center',
  'Notification Center',
  'SystemUIServer',
  'Spotlight',
  'loginwindow',
  'Wallpaper',
  'Screenshot',
  'TextInputMenuAgent',
  'Windows Explorer',
  'Windows Shell Experience Host',
  'Search',
  'Start'
])
const SKIP_TITLES = new Set(['Program Manager', 'Taskbar'])

// import for get-window, incase it cant be imported this is a safe way
type GetWindows = typeof import('get-windows')
let getWindows: GetWindows | null = null

async function loadGetWindows(): Promise<void> {
  try {
    getWindows = await import('get-windows')
  } catch (error) {
    console.warn('get-windows not available, taskbar snow only:', error)
  }
}

async function buildScene(): Promise<Scene> {
  const display = screen.getPrimaryDisplay()
  const screenBounds = display.bounds // the whole screen
  const workArea = display.workArea // the screen minus the taskbar
  const windows: WindowRect[] = []

  if (getWindows) {
    const openWindowList = await getWindows.openWindows({
      accessibilityPermission: false,
      screenRecordingPermission: false
    })
    for (const win of openWindowList) {
      if (win.owner.processId === process.pid) continue // our own overlay
      if (SKIP_OWNERS.has(win.owner.name) || SKIP_TITLES.has(win.title)) continue

      let rect = {
        x: win.bounds.x,
        y: win.bounds.y,
        width: win.bounds.width,
        height: win.bounds.height
      }
      if (process.platform === 'win32') rect = screen.screenToDipRect(null, rect) // fix display scaling

      if (rect.width < 120 || rect.height < 60) continue // too small
      const coversAll =
        rect.x <= screenBounds.x &&
        rect.y <= screenBounds.y &&
        rect.x + rect.width >= screenBounds.x + screenBounds.width &&
        rect.y + rect.height >= screenBounds.y + screenBounds.height
      if (coversAll) continue // desktop or fullscreen
      const offScreen =
        rect.x + rect.width <= screenBounds.x ||
        rect.x >= screenBounds.x + screenBounds.width ||
        rect.y + rect.height <= screenBounds.y ||
        rect.y >= screenBounds.y + screenBounds.height
      if (offScreen) continue

      windows.push({
        id: String(win.id),
        x: rect.x - screenBounds.x,
        y: rect.y - screenBounds.y,
        w: rect.width,
        h: rect.height
      })
    }
  }

  const bar = {
    x1: workArea.x - screenBounds.x,
    x2: workArea.x - screenBounds.x + workArea.width,
    y: workArea.y - screenBounds.y + workArea.height
  }
  return { bar, windows }
}

async function poll(): Promise<void> {
  try {
    if (overlay && !overlay.isDestroyed()) {
      overlay.webContents.send('scene', await buildScene())
    }
  } catch (error) {
    console.warn('poll failed:', error)
  }
  setTimeout(poll, 150)
}

let overlay: BrowserWindow | null = null

function createWindow(): void {
  const display = screen.getPrimaryDisplay()

  overlay = new BrowserWindow({
    ...display.bounds,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true, // no taskbar button
    focusable: false, // never steals keyboard focus from your apps
    alwaysOnTop: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false // keep animating even when "in the background"
    }
  })

  overlay.setAlwaysOnTop(true, 'screen-saver') // above everything
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  overlay.setIgnoreMouseEvents(true, { forward: true })

  // Developer tools in a separate window, only while developing
  if (is.dev) overlay.webContents.openDevTools({ mode: 'detach' })

  // Load the page: dev server URL while developing, built file in production
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    overlay.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    overlay.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

if (!app.requestSingleInstanceLock()) app.quit()

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  const refit = (): void => overlay?.setBounds(screen.getPrimaryDisplay().bounds)
  screen.on('display-metrics-changed', refit)
  screen.on('display-added', refit)
  screen.on('display-removed', refit)
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  ipcMain.on('set-ignore', (_event, ignore) => {
    overlay?.setIgnoreMouseEvents(!!ignore, { forward: true })
  })

  loadGetWindows().then(poll)
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
