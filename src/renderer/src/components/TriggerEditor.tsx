import CodeMirror from '@uiw/react-codemirror'
import { sql } from '@codemirror/lang-sql'
import { useStore } from '../store'
import { buildTriggerStatements } from '@shared/triggerDdl'
import type { TriggerSpec } from '@shared/types'
import { IconApply } from '../actionIcons'

const TIMINGS: Record<string, string[]> = {
  postgres: ['BEFORE', 'AFTER', 'INSTEAD OF'],
  mysql: ['BEFORE', 'AFTER'],
  sqlite: ['BEFORE', 'AFTER', 'INSTEAD OF'],
  // INSTEAD OF applies to VIEWS only, so table triggers offer BEFORE/AFTER.
  mariadb: ['BEFORE', 'AFTER'],
  oracle: ['BEFORE', 'AFTER'],
  // SQL Server has NO BEFORE triggers — only AFTER (FOR) and INSTEAD OF.
  mssql: ['AFTER', 'INSTEAD OF']
}
const EVENTS = ['INSERT', 'UPDATE', 'DELETE']

/** Dialect-aware editor for a trigger (PG function+trigger; MySQL/SQLite body). */
export function TriggerEditor(): JSX.Element {
  const tab = useStore((s) => s.getActiveTab())
  const engineOf = useStore((s) => s.engineOf)
  const setTriggerEditor = useStore((s) => s.setTriggerEditor)
  const applyTriggerEditor = useStore((s) => s.applyTriggerEditor)
  const theme = useStore((s) => s.theme)

  if (!tab?.triggerEditor) return <div className="empty">No trigger open.</div>
  const te = tab.triggerEditor
  const spec = te.spec
  const engine = engineOf(tab.connectionId) ?? 'postgres'
  const isPg = engine === 'postgres'
  const isOracle = engine === 'oracle'
  const isMssql = engine === 'mssql'
  // Row/statement level is selectable on PG and Oracle; MySQL/SQLite are row-only.
  // SQL Server triggers are set-based (no row/statement concept) — hide it.
  const levelSelectable = isPg || isOracle
  const isEdit = te.mode === 'edit'

  const patch = (p: Partial<TriggerSpec>): void => setTriggerEditor(tab.id, { spec: { ...spec, ...p }, message: null })

  let previewSql = ''
  let previewErr: string | null = null
  try {
    previewSql = buildTriggerStatements(engine, spec, te.mode).sql
  } catch (err) {
    previewErr = (err as Error).message
  }

  return (
    <div className="trg-editor">
      <div className="trg-toolbar">
        <span className="obj-kind">{isEdit ? 'EDIT' : 'NEW'} trigger</span>
        <label className="seq-field">
          <span>name</span>
          <input value={spec.name} onChange={(e) => patch({ name: e.target.value })} />
        </label>
        <label className="seq-field">
          <span>timing</span>
          <select value={spec.timing} onChange={(e) => patch({ timing: e.target.value as TriggerSpec['timing'] })}>
            {(TIMINGS[engine] ?? TIMINGS.postgres).map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label className="seq-field">
          <span>event</span>
          <select value={spec.event} onChange={(e) => patch({ event: e.target.value as TriggerSpec['event'] })}>
            {EVENTS.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        {!isMssql && (
          <label className="seq-field">
            <span>for each</span>
            <select
              value={spec.level}
              disabled={!levelSelectable}
              onChange={(e) => patch({ level: e.target.value as TriggerSpec['level'] })}
              title={levelSelectable ? '' : 'MySQL/SQLite support row-level triggers only'}
            >
              <option value="ROW">ROW</option>
              {levelSelectable && <option value="STATEMENT">STATEMENT</option>}
            </select>
          </label>
        )}
        {isOracle && spec.level === 'ROW' && (
          <label className="seq-field" title="Optional row condition, e.g. NEW.STATUS = 'ACTIVE' (no surrounding parens)">
            <span>when</span>
            <input
              value={spec.whenClause ?? ''}
              placeholder="(optional condition)"
              onChange={(e) => patch({ whenClause: e.target.value })}
            />
          </label>
        )}
        <span className="spacer" />
        {isEdit && (
          <span className="trg-note">
            {isOracle ? 'edit = CREATE OR REPLACE (in place)' : isMssql ? 'edit = CREATE OR ALTER (in place)' : 'edit = DROP + CREATE (in a transaction)'}
          </span>
        )}
        <button className="primary icon-text-btn" disabled={te.applying || !!previewErr} onClick={() => void applyTriggerEditor(tab.id)}>
          <IconApply /> {te.applying ? 'Applying…' : isEdit ? 'Apply (recreate)' : 'Create trigger'}
        </button>
      </div>

      <div className="trg-body">
        <div className="trg-editors">
          <span className="on-tbl">ON <b>{spec.table}</b></span>
          {isPg ? (
            <>
              <label className="seq-field">
                <span>trigger function name</span>
                <input value={spec.functionName} onChange={(e) => patch({ functionName: e.target.value })} />
              </label>
              <div className="section-title">Function body (plpgsql) — <code>RETURN NEW;</code> for row triggers</div>
              <div className="trg-cm">
                <CodeMirror
                  value={spec.functionBody}
                  theme={theme}
                  extensions={[sql()]}
                  onChange={(v) => patch({ functionBody: v })}
                  basicSetup={{ lineNumbers: true, foldGutter: false, autocompletion: true }}
                />
              </div>
            </>
          ) : (
            <>
              <div className="section-title">
                Trigger body — refer to{' '}
                {isOracle ? (
                  <>
                    <code>:NEW.</code>/<code>:OLD.</code> columns (PL/SQL block, ends in <code>END;</code>)
                  </>
                ) : isMssql ? (
                  <>
                    the <code>inserted</code>/<code>deleted</code> pseudo-tables (statement-level; <code>AS BEGIN … END</code>)
                  </>
                ) : (
                  <>
                    <code>NEW.</code>/<code>OLD.</code> columns
                  </>
                )}
              </div>
              <div className="trg-cm">
                <CodeMirror
                  value={spec.body}
                  theme={theme}
                  extensions={[sql()]}
                  onChange={(v) => patch({ body: v })}
                  basicSetup={{ lineNumbers: true, foldGutter: false, autocompletion: true }}
                />
              </div>
            </>
          )}
        </div>

        <div className="trg-preview">
          <div className="section-title" style={{ marginTop: 0 }}>Statements to run</div>
          <pre className="ddl-pre">{previewErr ? `-- ${previewErr}` : previewSql}</pre>
          {previewErr && <div className="ddl-danger">⚠ {previewErr}</div>}
          {te.message && <div className={'msg ' + (te.message.startsWith('❌') ? 'err' : 'ok')}>{te.message}</div>}
        </div>
      </div>
    </div>
  )
}
