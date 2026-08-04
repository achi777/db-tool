// Electron MAIN entry. Creates the window with a locked-down webPreferences,
// registers typed IPC handlers, and wires lifecycle. NO DB code lives inline
// here — it's all behind the drivers/IPC layer.
import { app, BrowserWindow, Menu, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { disposeAll, registerIpc } from './ipc'
import { buildAppMenu } from './menu'
import { loadUiState } from './store'
import { IPC, type ThemeMode } from '@shared/types'

let mainWin: BrowserWindow | null = null

const isDev = !!process.env['ELECTRON_RENDERER_URL']

// Dev-only: expose CDP so chrome-devtools-mcp can attach for UI testing.
// Off unless VB_DEBUG_PORT is set; never enabled in production. Must be set
// before app is ready, hence at module top level.
if (process.env['VB_DEBUG_PORT']) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env['VB_DEBUG_PORT'])
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    show: false,
    title: 'DB Tool',
    // TASK 72: show the native application menu bar (discoverable Theme/About/etc.).
    autoHideMenuBar: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      // Security posture required by the task: renderer is fully isolated and
      // has no Node access. All privileged work goes through the preload API.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWin = win
  win.on('ready-to-show', () => win.show())

  // TASK 72: native application menu, additive — its items dispatch the SAME
  // actions the in-app buttons use. The View ▸ Theme checkmark reflects the
  // persisted theme; the renderer notifies MAIN on change to refresh it.
  const theme: ThemeMode = loadUiState().theme === 'light' ? 'light' : 'dark'
  Menu.setApplicationMenu(buildAppMenu(win, theme))

  // Open external links in the OS browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  // Headless smoke mode: exercise the DB layer against the TASK 01 databases
  // and quit. Never opens a window. Used for autonomous verification.
  if (process.env['SMOKE']) {
    const { runSmoke } = await import('./smoke')
    try {
      await runSmoke()
      app.exit(0)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[smoke] fatal', err)
      app.exit(1)
    }
    return
  }

  registerIpc()
  // Rebuild the menu when the renderer changes the theme, so the View ▸ Theme
  // checkmark stays in sync (whether toggled from the menu or the status bar).
  ipcMain.on(IPC.menuThemeChanged, (_e, theme: ThemeMode) => {
    if (mainWin) Menu.setApplicationMenu(buildAppMenu(mainWin, theme === 'light' ? 'light' : 'dark'))
  })
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async (e) => {
  // Best-effort clean shutdown of DB pools.
  e.preventDefault()
  await disposeAll()
  app.exit(0)
})

// Silence unused warning in dev builds where isDev may be unreferenced.
void isDev
