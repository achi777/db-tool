import { useEffect, useState } from 'react'
import type { ConnectionConfig, Engine, SafeConnectionConfig } from '@shared/types'
import { PanelLeftClose } from 'lucide-react'
import { IconDatabase, engineColor } from '../treeIcons'
import { IconConnect, IconDisconnect, IconEdit, IconDelete, IconNew, IconTest, IconSave, IconClose } from '../actionIcons'
import { useStore } from '../store'

const ENGINE_PORTS: Record<Engine, number | undefined> = {
  postgres: 5432,
  mysql: 3306,
  mariadb: 3306,
  oracle: 1521,
  mssql: 1433,
  sqlite: undefined
}

function blankForm(): ConnectionConfig {
  return {
    id: '',
    name: '',
    engine: 'postgres',
    host: 'localhost',
    port: 5432,
    user: 'dbtool',
    password: 'dbtool',
    database: 'dbtool_dev'
  }
}

export function ConnectionManager(): JSX.Element {
  const connections = useStore((s) => s.connections)
  const activeTab = useStore((s) => s.getActiveTab())
  const activeId = activeTab?.connectionId ?? null
  const connectedIds = useStore((s) => s.connectedIds)
  const refreshConnections = useStore((s) => s.refreshConnections)
  const connect = useStore((s) => s.useConnectionInActiveTab)
  const disconnect = useStore((s) => s.disconnect)
  const setTabConnection = useStore((s) => s.setTabConnection)
  const saveConnection = useStore((s) => s.saveConnection)
  const deleteConnection = useStore((s) => s.deleteConnection)
  const setSidebarCollapsed = useStore((s) => s.setSidebarCollapsed)
  const newConnSignal = useStore((s) => s.newConnSignal)

  const [showForm, setShowForm] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [form, setForm] = useState<ConnectionConfig>(blankForm())
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [testing, setTesting] = useState(false)
  const [confirmDel, setConfirmDel] = useState<SafeConnectionConfig | null>(null)
  const [secureAvailable, setSecureAvailable] = useState(true)

  useEffect(() => {
    void refreshConnections()
    void window.dbApi.secureStorageAvailable().then(setSecureAvailable)
  }, [refreshConnections])

  // File ▸ New Connection (native menu, TASK 72) bumps newConnSignal — reveal the
  // sidebar and open the add-connection form, exactly like the in-app button.
  useEffect(() => {
    if (newConnSignal === 0) return
    setSidebarCollapsed(false)
    startAdd()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newConnSignal])

  // Whether the connection being edited already has a stored (encrypted) secret.
  const editingHasPassword = isEditing && !!(form as SafeConnectionConfig).hasStoredPassword && !form.clearPassword

  // Every default is seeded as a real saved connection in main, so the list is
  // simply the saved connections — all with the same action set.
  const shown = connections

  function update<K extends keyof ConnectionConfig>(key: K, value: ConnectionConfig[K]): void {
    setForm((f) => ({ ...f, [key]: value }))
  }

  function onEngineChange(engine: Engine): void {
    setForm((f) => ({ ...f, engine, port: ENGINE_PORTS[engine] ?? f.port }))
  }

  function startAdd(): void {
    setForm({ ...blankForm(), id: `conn-${Date.now()}` })
    setIsEditing(false)
    setTestMsg(null)
    setShowForm(true)
  }

  // Edit an existing connection: prefill everything except the password (which
  // the renderer never receives — blank means "keep the stored one").
  function startEdit(c: SafeConnectionConfig): void {
    setForm({ ...blankForm(), ...c, password: '', clearPassword: false })
    setIsEditing(true)
    setTestMsg(null)
    setShowForm(true)
  }

  async function onTest(): Promise<void> {
    setTesting(true)
    setTestMsg(null)
    const res = await window.dbApi.testConnection(form)
    setTesting(false)
    setTestMsg({ ok: res.ok, text: res.message ?? (res.ok ? 'OK' : 'Failed') })
  }

  async function onSave(): Promise<void> {
    if (!form.name.trim()) {
      setTestMsg({ ok: false, text: 'Name is required' })
      return
    }
    const wasConnected = connectedIds.includes(form.id)
    const saved = await saveConnection(form)
    if (!saved) {
      setTestMsg({ ok: false, text: 'Save failed' })
      return
    }
    if (saved.warning) {
      // Secure storage unavailable — the secret wasn't persisted. Keep the form
      // open with the warning so the user knows.
      setTestMsg({ ok: false, text: saved.warning })
      return
    }
    setShowForm(false)
    if (isEditing) {
      // Apply new settings on the next Connect (disconnect the live session).
      if (wasConnected) await disconnect(saved.id)
    } else if (activeTab) {
      setTabConnection(activeTab.id, saved.id)
    }
    setIsEditing(false)
  }

  async function doDelete(id: string): Promise<void> {
    await deleteConnection(id) // store/main disconnects if live + removes from userData
    setConfirmDel(null)
  }

  async function onRowClick(c: SafeConnectionConfig): Promise<void> {
    if (!connectedIds.includes(c.id)) await connect(c.id)
    else if (activeTab) setTabConnection(activeTab.id, c.id)
  }

  return (
    <div className="panel" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="panel-header tree-header">
        <span>Connections</span>
        <button className="sidebar-collapse-btn" title="Collapse sidebar" onClick={() => setSidebarCollapsed(true)}>
          <PanelLeftClose size={14} />
        </button>
      </div>

      <div className="conn-list">
        {shown.map((c) => {
          const isConnected = connectedIds.includes(c.id)
          return (
            <div
              key={c.id}
              className={'conn-item' + (activeId === c.id ? ' active' : '')}
              onClick={() => void onRowClick(c)}
            >
              <div className="conn-head">
                <span
                  className={'conn-state ' + (isConnected ? 'on' : 'off')}
                  title={isConnected ? 'connected' : 'disconnected'}
                />
                <IconDatabase className="conn-engine-icon" title={c.engine} style={{ color: engineColor(c.engine) }} />
                <span className={`badge ${c.engine}`}>{c.engine}</span>
                <span className="conn-name">{c.name}</span>
              </div>
              <div className="conn-meta">
                {c.engine === 'sqlite' ? c.filePath : `${c.host}:${c.port}/${c.database} — ${c.user}`}
              </div>
              {/* Identical actions for every connection, every engine. Compact
                  icon-only in this narrow sidebar (tooltips give the label). */}
              <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                {isConnected ? (
                  <button className="conn-action-btn" title="Disconnect" aria-label="Disconnect" onClick={() => void disconnect(c.id)}>
                    <IconDisconnect />
                  </button>
                ) : (
                  <button className="conn-action-btn primary" title="Connect" aria-label="Connect" onClick={() => void connect(c.id)}>
                    <IconConnect />
                  </button>
                )}
                <button className="conn-action-btn" title="Edit connection" aria-label="Edit connection" onClick={() => startEdit(c)}>
                  <IconEdit />
                </button>
                <button className="conn-action-btn danger" title="Delete connection" aria-label="Delete connection" onClick={() => setConfirmDel(c)}>
                  <IconDelete />
                </button>
              </div>
            </div>
          )
        })}
      </div>

      <div style={{ padding: 8, borderTop: '1px solid var(--border)' }}>
        {!showForm ? (
          <button className="icon-text-btn primary" style={{ width: '100%' }} title="Add a connection" onClick={startAdd}>
            <IconNew />Add connection
          </button>
        ) : (
          <div className="form-wrap" style={{ padding: 0 }}>
            <div className="section-title">{isEditing ? 'Edit connection' : 'New connection'}</div>
            <div className="field">
              <label>Name</label>
              <input value={form.name} onChange={(e) => update('name', e.target.value)} />
            </div>
            <div className="field">
              <label>Engine</label>
              <select value={form.engine} onChange={(e) => onEngineChange(e.target.value as Engine)}>
                <option value="postgres">PostgreSQL</option>
                <option value="mysql">MySQL</option>
                <option value="mariadb">MariaDB</option>
                <option value="oracle">Oracle</option>
                <option value="mssql">SQL Server</option>
                <option value="sqlite">SQLite</option>
              </select>
            </div>

            {form.engine === 'sqlite' ? (
              <div className="field">
                <label>File path</label>
                <input
                  value={form.filePath ?? ''}
                  placeholder="C:\\path\\to\\db.sqlite"
                  onChange={(e) => update('filePath', e.target.value)}
                />
              </div>
            ) : (
              <>
                <div className="field">
                  <label>Host</label>
                  <input value={form.host ?? ''} onChange={(e) => update('host', e.target.value)} />
                </div>
                <div className="field">
                  <label>Port</label>
                  <input
                    type="number"
                    value={form.port ?? ''}
                    onChange={(e) => update('port', Number(e.target.value))}
                  />
                </div>
                {form.engine === 'mssql' && (
                  <div className="field">
                    <label>Authentication</label>
                    <select value={form.authType ?? 'sql'} onChange={(e) => update('authType', e.target.value as 'sql' | 'windows')}>
                      <option value="sql">SQL Server Authentication</option>
                      <option value="windows">Windows Authentication (Integrated)</option>
                    </select>
                  </div>
                )}
                {!(form.engine === 'mssql' && form.authType === 'windows') && (
                  <>
                    <div className="field">
                      <label>User</label>
                      <input value={form.user ?? ''} onChange={(e) => update('user', e.target.value)} />
                    </div>
                    <div className="field">
                      <label>Password</label>
                      <input
                        type="password"
                        value={form.password ?? ''}
                        disabled={!!form.clearPassword}
                        placeholder={
                          form.clearPassword ? '(will be cleared)'
                          : editingHasPassword ? '••••••••• (unchanged)'
                          : ''
                        }
                        onChange={(e) => update('password', e.target.value)}
                      />
                      {editingHasPassword && (
                        <label className="param-check" style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                          <input
                            type="checkbox"
                            checked={!!form.clearPassword}
                            onChange={(e) => setForm((f) => ({ ...f, clearPassword: e.target.checked, password: '' }))}
                          />
                          Clear stored password
                        </label>
                      )}
                      {!secureAvailable && (
                        <div className="msg err" style={{ marginTop: 4 }}>
                          ⚠ Secure storage unavailable — passwords cannot be encrypted and will not be saved. Enter it each session.
                        </div>
                      )}
                    </div>
                  </>
                )}
                {form.engine === 'oracle' ? (
                  <>
                    <div className="field">
                      <label>Service name</label>
                      <input
                        value={form.serviceName ?? ''}
                        placeholder="e.g. XEPDB1"
                        onChange={(e) => update('serviceName', e.target.value)}
                      />
                    </div>
                    <div className="field">
                      <label>SID (optional)</label>
                      <input
                        value={form.sid ?? ''}
                        placeholder="legacy alternative to service name"
                        onChange={(e) => update('sid', e.target.value)}
                      />
                    </div>
                    <div className="field">
                      <label>Driver mode</label>
                      <select value={form.driverMode ?? 'thin'} onChange={(e) => update('driverMode', e.target.value as 'thin' | 'thick')}>
                        <option value="thin">Thin (default — pure JS, Oracle 12.1+)</option>
                        <option value="thick">Thick (needs Oracle Instant Client)</option>
                      </select>
                    </div>
                  </>
                ) : (
                  <div className="field">
                    <label>Database</label>
                    <input value={form.database ?? ''} onChange={(e) => update('database', e.target.value)} />
                  </div>
                )}
                {form.engine === 'mssql' && (
                  <div className="field">
                    <label>Options</label>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <label className="param-check" style={{ display: 'flex', gap: 6 }} title="Encrypt the connection with TLS" aria-label="Encrypt connection (TLS)">
                        <input
                          type="checkbox"
                          checked={form.encrypt ?? true}
                          onChange={(e) => update('encrypt', e.target.checked)}
                        />
                        Encrypt (TLS)
                      </label>
                      <label
                        className="param-check"
                        style={{ display: 'flex', gap: 6 }}
                        title="Needed for local or self-signed certificates"
                        aria-label="Trust server certificate — needed for local or self-signed certificates"
                      >
                        <input
                          type="checkbox"
                          checked={form.trustServerCertificate ?? true}
                          onChange={(e) => update('trustServerCertificate', e.target.checked)}
                        />
                        Trust server certificate
                      </label>
                    </div>
                  </div>
                )}
              </>
            )}

            <div className="row-actions">
              <button
                className="icon-text-btn icon-only"
                onClick={() => void onTest()}
                disabled={testing}
                title={testing ? 'Testing…' : 'Test connection'}
                aria-label={testing ? 'Testing…' : 'Test connection'}
              >
                <IconTest />
              </button>
              <button
                className="icon-text-btn primary icon-only"
                onClick={() => void onSave()}
                title="Save"
                aria-label="Save"
              >
                <IconSave />
              </button>
              <button
                className="icon-text-btn icon-only"
                onClick={() => { setShowForm(false); setIsEditing(false) }}
                title="Cancel"
                aria-label="Cancel"
              >
                <IconClose />
              </button>
            </div>
            {testMsg && <div className={'msg ' + (testMsg.ok ? 'ok' : 'err')}>{testMsg.text}</div>}
          </div>
        )}
      </div>

      {confirmDel && (
        <div className="modal-backdrop" onClick={() => setConfirmDel(null)}>
          <div className="modal" style={{ width: 420 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">Delete connection</div>
            <p style={{ fontSize: 12, lineHeight: 1.5 }}>
              Delete saved connection “<b>{confirmDel.name}</b>”? This only removes it from DB&nbsp;Tool and does{' '}
              <b>not</b> affect the database.
            </p>
            <div className="row-actions" style={{ justifyContent: 'flex-end' }}>
              <button onClick={() => setConfirmDel(null)}>Cancel</button>
              <button className="icon-text-btn danger-btn" onClick={() => void doDelete(confirmDel.id)}>
                <IconDelete />Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
