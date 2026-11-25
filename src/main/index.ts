import { app, BrowserWindow, ipcMain, Menu, nativeImage, screen, Tray } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import type { Scene, SnowCommand, WindowRect } from '../shared/types'


// A 16×16 snowflake, drawn pixel by pixel
function createTrayIcon(): Electron.NativeImage {
  const size = 16
  const pixels = Buffer.alloc(size * size * 4) // 4 bytes per pixel (blue, green, red, alpha), all transparent
  const isMac = process.platform === 'darwin'
  const shade = isMac ? 0 : 255 // black on macOS (it recolors it), white elsewhere

  const setPixel = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= size || y >= size) return
    const offset = (y * size + x) * 4
    pixels[offset] = shade     // blue
    pixels[offset + 1] = shade // green
    pixels[offset + 2] = shade // red
    pixels[offset + 3] = 255   // alpha: fully visible
  }

  const center = 8
  for (let step = -6; step <= 6; step++) { // straight arms, 13 px long
    setPixel(center + step, center)
    setPixel(center, center + step)
  }
  for (let step = -4; step <= 4; step++) { // diagonal arms, 9 px long
    setPixel(center + step, center + step)
    setPixel(center + step, center - step)
  }
  const tips = [[0, -6], [0, 6], [-6, 0], [6, 0], [-4, -4], [4, 4], [-4, 4], [4, -4]]
  for (const [tipX, tipY] of tips) { // a small "+" dot at the end of each arm
    for (const [nearX, nearY] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
      setPixel(center + tipX + nearX, center + tipY + nearY)
    }
  }

  const image = nativeImage.createFromBitmap(pixels, { width: size, height: size })
  if (isMac) image.setTemplateImage(true) // macOS turns it white or black to match the menu bar
  return image
}


let tray: Tray | null = null // keep it in a variable, or it gets cleaned up and disappears

function sendCommand(command: SnowCommand): void {
  overlay?.webContents.send('cmd', command)
}

function createTray(): void {
  tray = new Tray(createTrayIcon())
  tray.setToolTip('Desktop Snow')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: 'Snowing',
        type: 'checkbox',
        checked: true,
        click: (item) => sendCommand({ type: 'snowing', value: item.checked })
      },
      {
        label: 'Focus mode',
        type: 'checkbox',
        checked: false,
        click: (item) => sendCommand({ type: 'focus', value: item.checked })
      },
      { type: 'separator' },
      { label: 'Light', type: 'radio', click: () => sendCommand({ type: 'rate', value: 0.4 }) },
      { label: 'Normal', type: 'radio', checked: true, click: () => sendCommand({ type: 'rate', value: 1 }) },
      { label: 'Blizzard', type: 'radio', click: () => sendCommand({ type: 'rate', value: 3 }) },
      { type: 'separator' },
      { label: 'Refill snow', click: () => sendCommand({ type: 'refill' }) },
      { label: 'Clear all snow', click: () => sendCommand({ type: 'clear' }) },
      { label: 'Quit', click: () => app.quit() }
    ])
  )
  tray.on('click', () => tray?.popUpContextMenu())
}




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

    let active: WindowRect | undefined
      if (getWindows) {
        const activeWin = await getWindows.activeWindow({
          accessibilityPermission: false,
          screenRecordingPermission: false
        })
        const skip =
          !activeWin ||
          activeWin.owner.processId === process.pid ||
          SKIP_OWNERS.has(activeWin.owner.name) ||
          SKIP_TITLES.has(activeWin.title) // e.g. the desktop itself
        if (activeWin && !skip) {
          let rect = { x: activeWin.bounds.x, y: activeWin.bounds.y, width: activeWin.bounds.width, height: activeWin.bounds.height }
          if (process.platform === 'win32') rect = screen.screenToDipRect(null, rect)
          active = {
            id: String(activeWin.id),
            x: rect.x - screenBounds.x,
            y: rect.y - screenBounds.y,
            w: rect.width,
            h: rect.height
          }
        }
      }

  const bar = {
    x1: workArea.x - screenBounds.x,
    x2: workArea.x - screenBounds.x + workArea.width,
    y: workArea.y - screenBounds.y + workArea.height
  }
  return { bar, windows, active }
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
  electronApp.setAppUserModelId('com.frosty.app')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()
  createTray()
  app.dock?.hide() // macOS only: no Dock icon for a background app

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
