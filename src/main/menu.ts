// Native application menu (TASK 72). Purely ADDITIVE — every item duplicates an
// EXISTING action: renderer-owned actions are dispatched over IPC (the renderer
// maps them to the same store handlers the buttons use); Edit uses standard
// Electron roles; Quit/Website are native. Accelerators that TASK 71 already
// binds are shown with registerAccelerator:false so the shortcut fires the single
// existing handler (no double-binding), while the menu still displays the key.
import { Menu, shell, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import { IPC, type MenuAction, type ThemeMode } from '@shared/types'

const WEBSITE = 'https://codemake.co'

export function buildAppMenu(win: BrowserWindow, theme: ThemeMode): Menu {
  const send = (action: MenuAction) => (): void => {
    win.webContents.send(IPC.menuAction, action)
  }
  // A menu item that DISPLAYS a TASK-71 accelerator but does not register it, so
  // the key still routes to the single existing handler (the capture-phase
  // window listener) instead of firing twice.
  const displayAccel = (accelerator: string): Partial<MenuItemConstructorOptions> => ({ accelerator, registerAccelerator: false })

  const isMac = process.platform === 'darwin'

  const template: MenuItemConstructorOptions[] = []

  if (isMac) {
    template.push({
      label: 'DB Tool',
      submenu: [
        { label: 'About DB Tool', click: send('about') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    })
  }

  template.push({
    label: 'File',
    submenu: [
      { label: 'New Connection', click: send('newConnection') },
      { label: 'New Query Tab', ...displayAccel('CmdOrCtrl+T'), click: send('newTab') },
      { type: 'separator' },
      { label: 'Import Data…', click: send('import') },
      { label: 'Export Data…', click: send('export') },
      { type: 'separator' },
      { label: 'Dump to SQL File…', click: send('dump') },
      { label: 'Execute SQL File…', click: send('restore') },
      { type: 'separator' },
      isMac ? { role: 'close' } : { role: 'quit', label: 'Exit' }
    ]
  })

  template.push({
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
      { type: 'separator' },
      // CodeMirror's built-in search handles Ctrl/Cmd+F when the editor is focused;
      // the click focuses the editor and opens that search panel.
      { label: 'Find in Editor…', ...displayAccel('CmdOrCtrl+F'), click: send('find') }
    ]
  })

  template.push({
    label: 'View',
    submenu: [
      {
        label: 'Theme',
        submenu: [
          { label: 'Light', type: 'radio', checked: theme === 'light', click: send('themeLight') },
          { label: 'Dark', type: 'radio', checked: theme === 'dark', click: send('themeDark') }
        ]
      },
      { type: 'separator' },
      { label: 'Toggle Sidebar', ...displayAccel('CmdOrCtrl+B'), click: send('toggleSidebar') },
      { label: 'Toggle Filter SQL Panel', click: send('toggleFilterSql') },
      { label: 'Refresh Schema', click: send('refreshSchema') }
    ]
  })

  template.push({
    label: 'Query',
    submenu: [
      { label: 'Run Query', ...displayAccel('CmdOrCtrl+Enter'), click: send('runQuery') },
      { type: 'separator' },
      { label: 'New Tab', ...displayAccel('CmdOrCtrl+T'), click: send('newTab') },
      { label: 'Close Tab', ...displayAccel('CmdOrCtrl+W'), click: send('closeTab') },
      { type: 'separator' },
      { label: 'Query History', click: send('toggleHistory') }
    ]
  })

  template.push({
    label: 'Tools',
    submenu: [
      { label: 'Data Transfer…', click: send('transfer') },
      { label: 'ER Diagram', click: send('erDiagram') },
      { label: 'Saved Filters', click: send('savedFilters') }
    ]
  })

  template.push({
    label: 'Help',
    submenu: [
      { label: 'Keyboard Shortcuts', ...displayAccel('F1'), click: send('shortcuts') },
      ...(isMac ? [] : [{ label: 'About', click: send('about') } as MenuItemConstructorOptions]),
      { type: 'separator' },
      { label: 'Website', click: () => void shell.openExternal(WEBSITE) }
    ]
  })

  return Menu.buildFromTemplate(template)
}
