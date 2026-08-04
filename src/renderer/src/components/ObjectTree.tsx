import type { MouseEvent as ReactMouseEvent } from 'react'
import { IconRefresh } from '../actionIcons'
import type { ExtensionRef, IndexInfo, MatViewRef, PackageRef, RoutineRef, SequenceRef, TableRef, TriggerRef, TypeRef, ViewRef } from '@shared/types'
import { useStore, type ObjCategory, type TreeColumn } from '../store'
import {
  Chevron,
  ChevronSpacer,
  Spinner,
  IconColumn,
  IconColumnFk,
  IconColumnPk,
  IconColumnsCat,
  IconFunction,
  IconFunctionsCat,
  IconIndex,
  IconIndexUnique,
  IconIndexesCat,
  IconPackage,
  IconPackagesCat,
  IconProcedure,
  IconProceduresCat,
  IconSchema,
  IconSequence,
  IconSequencesCat,
  IconMatViewsCat,
  IconTypesCat,
  IconExtensionsCat,
  IconMatView,
  IconType,
  IconExtension,
  IconTable,
  IconTablesCat,
  IconTrigger,
  IconTriggersCat,
  IconView,
  IconViewsCat
} from '../treeIcons'

export function ObjectTree(): JSX.Element {
  const activeTab = useStore((s) => s.getActiveTab())
  const connectedIds = useStore((s) => s.connectedIds)
  const treeByConn = useStore((s) => s.treeByConn)
  const toggleSchema = useStore((s) => s.toggleSchema)
  const toggleCategory = useStore((s) => s.toggleCategory)
  const openTable = useStore((s) => s.openTable)
  const openEditView = useStore((s) => s.openEditView)
  const openEditRoutine = useStore((s) => s.openEditRoutine)
  const openEditPackagePart = useStore((s) => s.openEditPackagePart)
  const openEditSequence = useStore((s) => s.openEditSequence)
  const openEditMatView = useStore((s) => s.openEditMatView)
  const toggleTableExpand = useStore((s) => s.toggleTableExpand)
  const toggleTableColumns = useStore((s) => s.toggleTableColumns)
  const toggleTableTriggers = useStore((s) => s.toggleTableTriggers)
  const openEditTrigger = useStore((s) => s.openEditTrigger)
  const toggleTableIndexes = useStore((s) => s.toggleTableIndexes)
  const openEditIndex = useStore((s) => s.openEditIndex)
  const refreshTree = useStore((s) => s.refreshTree)
  const engineOf = useStore((s) => s.engineOf)
  const openContextMenu = useStore((s) => s.openContextMenu)

  const connId = activeTab?.connectionId ?? null
  const isConnected = !!connId && connectedIds.includes(connId)
  const tree = connId ? treeByConn[connId] : undefined
  const gridTable = activeTab?.gridTable ?? null
  const engine = engineOf(connId)
  const isSqlite = engine === 'sqlite'
  const isPostgres = engine === 'postgres'
  // PostgreSQL, MariaDB (10.3+), and Oracle have standalone sequences; MySQL/SQLite don't.
  const hasSequences = engine === 'postgres' || engine === 'mariadb' || engine === 'oracle'
  const loading = (key: string): boolean => tree?.loadingKeys.includes(key) ?? false

  /** A collapsible category row (schema-level or per-table). */
  const catRow = (
    key: string,
    label: string,
    count: number,
    Icon: typeof IconViewsCat,
    onToggle: () => void,
    onCtx: (e: ReactMouseEvent) => void,
    sub?: 'sub'
  ): JSX.Element => {
    const open = tree?.expandedCats.includes(key) ?? false
    return (
      <div className={'tree-node category' + (sub ? ' tree-sub' : '')} onClick={onToggle} onContextMenu={onCtx}>
        <Chevron open={open} />
        <Icon className="cat-icon" />
        <span className="tree-label">{label}</span>
        {loading(key) ? <Spinner /> : <span className="tree-count">{count || ''}</span>}
      </div>
    )
  }

  /** Subtle empty/placeholder row shown under an open, empty category. */
  const emptyRow = (text: string, sub2?: boolean): JSX.Element => (
    <div className={'tree-empty-row' + (sub2 ? ' tree-sub2' : ' tree-sub')}>{text}</div>
  )

  return (
    <div className="panel">
      <div className="panel-header tree-header">
        <span>Objects</span>
        {isConnected && connId && (
          <span
            className="refresh-link"
            title="Refresh schema (tree + autocomplete)"
            onClick={() => {
              void refreshTree(connId)
            }}
          >
            <IconRefresh size={13} />
          </span>
        )}
      </div>
      {!isConnected ? (
        <div className="empty">Connect a database (pick one for this tab) to browse objects.</div>
      ) : !tree || tree.schemas.length === 0 ? (
        <div className="empty">No schemas found.</div>
      ) : (
        <div className="tree-body">
          {tree.schemas.map((schema) => {
            const isOpen = tree.expanded.includes(schema)
            const tables: TableRef[] = tree.tablesBySchema[schema] ?? []
            const views: ViewRef[] = tree.viewsBySchema[schema] ?? []
            const functions: RoutineRef[] = tree.functionsBySchema[schema] ?? []
            const procedures: RoutineRef[] = tree.proceduresBySchema[schema] ?? []
            const packages: PackageRef[] = tree.packagesBySchema[schema] ?? []
            const sequences: SequenceRef[] = tree.sequencesBySchema[schema] ?? []
            const matviews: MatViewRef[] = tree.matviewsBySchema[schema] ?? []
            const types: TypeRef[] = tree.typesBySchema[schema] ?? []
            const extensions: ExtensionRef[] = tree.extensionsBySchema[schema] ?? []
            const tablesOpen = tree.expandedCats.includes(`${schema}::tables`)
            const viewsOpen = tree.expandedCats.includes(`${schema}::views`)
            const fnsOpen = tree.expandedCats.includes(`${schema}::functions`)
            const procsOpen = tree.expandedCats.includes(`${schema}::procedures`)
            const pkgsOpen = tree.expandedCats.includes(`${schema}::packages`)
            const seqsOpen = tree.expandedCats.includes(`${schema}::sequences`)
            const mvOpen = tree.expandedCats.includes(`${schema}::matviews`)
            const typesOpen = tree.expandedCats.includes(`${schema}::types`)
            const extsOpen = tree.expandedCats.includes(`${schema}::extensions`)
            const schemaCtx = (e: ReactMouseEvent): void => {
              e.preventDefault()
              if (connId) openContextMenu({ x: e.clientX, y: e.clientY, target: { kind: 'schema', connectionId: connId, schema } })
            }
            return (
              <div key={schema}>
                <div className="tree-node schema" onClick={() => connId && void toggleSchema(connId, schema)} onContextMenu={schemaCtx} title={schema}>
                  <Chevron open={isOpen} />
                  <IconSchema className="schema-icon" />
                  <span className="tree-label">{schema}</span>
                </div>
                {isOpen && (
                  <>
                    {/* Tables */}
                    {catRow(`${schema}::tables`, 'Tables', tables.length, IconTablesCat, () => connId && void toggleCategory(connId, schema, 'tables' as ObjCategory), schemaCtx)}
                    {tablesOpen && tables.map((t) => {
                      const selected = gridTable && gridTable.schema === t.schema && gridTable.table === t.name
                      const tExpanded = tree.expandedTables.includes(`${schema}::${t.name}`)
                      const colsOpen = tree.expandedCats.includes(`${schema}::${t.name}::columns`)
                      const columns: TreeColumn[] = tree.columnsByTable[`${schema}::${t.name}`] ?? []
                      const trigsOpen = tree.expandedCats.includes(`${schema}::${t.name}::triggers`)
                      const triggers: TriggerRef[] = tree.triggersByTable[`${schema}::${t.name}`] ?? []
                      const idxOpen = tree.expandedCats.includes(`${schema}::${t.name}::indexes`)
                      const indexes: IndexInfo[] = tree.indexesByTable[`${schema}::${t.name}`] ?? []
                      const isView = t.type === 'view'
                      return (
                        <div key={'t.' + t.name}>
                          <div
                            className={'tree-node table' + (selected ? ' selected' : '')}
                            onClick={() => void openTable(t)}
                            onContextMenu={(e) => {
                              e.preventDefault()
                              if (connId) openContextMenu({ x: e.clientX, y: e.clientY, target: { kind: 'table', connectionId: connId, schema: t.schema, table: t.name } })
                            }}
                            title={`${t.name} (${t.type})`}
                          >
                            <span
                              className="tree-caret"
                              title="Show columns / triggers / indexes"
                              onClick={(e) => {
                                e.stopPropagation()
                                if (connId) toggleTableExpand(connId, schema, t.name)
                              }}
                            >
                              <Chevron open={tExpanded} />
                            </span>
                            {isView ? <IconView className="obj-icon view" /> : <IconTable className="obj-icon table" />}
                            <span className="tree-label">{t.name}</span>
                          </div>
                          {tExpanded && (
                            <>
                              {/* Columns */}
                              {catRow(
                                `${schema}::${t.name}::columns`,
                                'Columns',
                                columns.length,
                                IconColumnsCat,
                                () => connId && void toggleTableColumns(connId, schema, t.name),
                                (e) => e.preventDefault(),
                                'sub'
                              )}
                              {colsOpen &&
                                (columns.length === 0 && !loading(`${schema}::${t.name}::columns`)
                                  ? emptyRow('No columns', true)
                                  : columns.map((c) => (
                                      <div
                                        className={'tree-node column tree-sub2' + (c.nullable ? '' : ' notnull')}
                                        key={'c.' + c.name}
                                        title={`${c.name} ${c.type}${c.nullable ? '' : ' NOT NULL'}${c.isPrimaryKey ? ' · PK' : ''}${c.isForeignKey ? ' · FK' : ''}`}
                                      >
                                        <ChevronSpacer />
                                        {c.isPrimaryKey ? (
                                          <IconColumnPk className="col-pk" title="primary key" />
                                        ) : c.isForeignKey ? (
                                          <IconColumnFk className="col-fk" title="foreign key" />
                                        ) : (
                                          <IconColumn className="col-dot" />
                                        )}
                                        <span className="tree-label">{c.name}</span>
                                        <span className="tree-sig col-type">{c.type}</span>
                                      </div>
                                    )))}

                              {/* Triggers */}
                              {catRow(
                                `${schema}::${t.name}::triggers`,
                                'Triggers',
                                triggers.length,
                                IconTriggersCat,
                                () => connId && void toggleTableTriggers(connId, schema, t.name),
                                (e) => {
                                  e.preventDefault()
                                  if (connId) openContextMenu({ x: e.clientX, y: e.clientY, target: { kind: 'triggersCat', connectionId: connId, schema, table: t.name } })
                                },
                                'sub'
                              )}
                              {trigsOpen &&
                                (triggers.length === 0 && !loading(`${schema}::${t.name}::triggers`)
                                  ? emptyRow('No triggers', true)
                                  : triggers.map((tr) => (
                                      <div
                                        key={'tr.' + tr.name}
                                        className="tree-node object tree-sub2"
                                        onClick={() => connId && void openEditTrigger(connId, schema, t.name, tr.name)}
                                        onContextMenu={(e) => {
                                          e.preventDefault()
                                          if (connId) openContextMenu({ x: e.clientX, y: e.clientY, target: { kind: 'trigger', connectionId: connId, schema, table: t.name, name: tr.name, enabled: tr.status ? tr.status === 'ENABLED' : undefined } })
                                        }}
                                        title={`${tr.timing} ${tr.event} on ${t.name}${tr.status ? ` — ${tr.status}` : ''}${tr.valid && tr.valid !== 'VALID' ? ` — ${tr.valid}` : ''}`}
                                      >
                                        <ChevronSpacer />
                                        <IconTrigger className="obj-icon trigger" />
                                        <span className="tree-label">{tr.name}</span>
                                        <span className="tree-sig">{tr.timing} {tr.event}</span>
                                        {tr.status === 'DISABLED' && <span className="sys-tag">DISABLED</span>}
                                        {tr.valid && tr.valid !== 'VALID' && <span className="sys-tag warn">{tr.valid}</span>}
                                      </div>
                                    )))}

                              {/* Indexes */}
                              {catRow(
                                `${schema}::${t.name}::indexes`,
                                'Indexes',
                                indexes.length,
                                IconIndexesCat,
                                () => connId && void toggleTableIndexes(connId, schema, t.name),
                                (e) => {
                                  e.preventDefault()
                                  if (connId) openContextMenu({ x: e.clientX, y: e.clientY, target: { kind: 'indexesCat', connectionId: connId, schema, table: t.name } })
                                },
                                'sub'
                              )}
                              {idxOpen &&
                                (indexes.length === 0 && !loading(`${schema}::${t.name}::indexes`)
                                  ? emptyRow('No indexes', true)
                                  : indexes.map((ix) => (
                                      <div
                                        key={'ix.' + ix.name}
                                        className={'tree-node object tree-sub2' + (ix.constraintBacked ? ' muted' : '')}
                                        onClick={() => connId && !ix.constraintBacked && openEditIndex(connId, schema, t.name, ix.name)}
                                        onContextMenu={(e) => {
                                          e.preventDefault()
                                          if (connId) openContextMenu({ x: e.clientX, y: e.clientY, target: { kind: 'index', connectionId: connId, schema, table: t.name, name: ix.name, constraintBacked: ix.constraintBacked } })
                                        }}
                                        title={`${ix.constraintBacked ? '(constraint-backed / system — read-only, drop the constraint in the Table Designer instead) ' : ''}${ix.unique ? 'UNIQUE ' : ''}(${ix.columns.join(', ')})${ix.status && ix.status !== 'VALID' ? ` — ${ix.status}` : ''}`}
                                      >
                                        <ChevronSpacer />
                                        {ix.unique ? <IconIndexUnique className="obj-icon index-u" /> : <IconIndex className="obj-icon index" />}
                                        <span className="tree-label">{ix.name}</span>
                                        <span className="tree-sig">({ix.columns.join(', ')})</span>
                                        {ix.status && ix.status !== 'VALID' && <span className="sys-tag">{ix.status}</span>}
                                      </div>
                                    )))}
                            </>
                          )}
                        </div>
                      )
                    })}
                    {tablesOpen && tables.length === 0 && !loading(`${schema}::tables`) && emptyRow('No tables')}

                    {/* Views */}
                    {catRow(`${schema}::views`, 'Views', views.length, IconViewsCat, () => connId && void toggleCategory(connId, schema, 'views' as ObjCategory), schemaCtx)}
                    {viewsOpen &&
                      (views.length === 0 && !loading(`${schema}::views`)
                        ? emptyRow('No views')
                        : views.map((v) => (
                            <div
                              key={'v.' + v.name}
                              className="tree-node object"
                              onClick={() => connId && void openEditView(connId, schema, v.name)}
                              onContextMenu={(e) => {
                                e.preventDefault()
                                if (connId) openContextMenu({ x: e.clientX, y: e.clientY, target: { kind: 'view', connectionId: connId, schema, name: v.name } })
                              }}
                              title={`View ${v.name}`}
                            >
                              <ChevronSpacer />
                              <IconView className="obj-icon view" />
                              <span className="tree-label">{v.name}</span>
                            </div>
                          )))}

                    {/* Functions / Procedures */}
                    {isSqlite ? (
                      <div className="tree-node muted" title="SQLite has no stored routines">
                        <ChevronSpacer />
                        <span className="tree-label">Functions / Procedures — n/a</span>
                      </div>
                    ) : (
                      <>
                        {catRow(`${schema}::functions`, 'Functions', functions.length, IconFunctionsCat, () => connId && void toggleCategory(connId, schema, 'functions' as ObjCategory), schemaCtx)}
                        {fnsOpen &&
                          (functions.length === 0 && !loading(`${schema}::functions`)
                            ? emptyRow('No functions')
                            : functions.map((f) => (
                                <div
                                  key={'f.' + f.name}
                                  className="tree-node object"
                                  onClick={() => connId && void openEditRoutine(connId, f)}
                                  onContextMenu={(e) => {
                                    e.preventDefault()
                                    if (connId) openContextMenu({ x: e.clientX, y: e.clientY, target: { kind: 'routine', connectionId: connId, schema, name: f.name, routineKind: 'function', signature: f.signature } })
                                  }}
                                  title={`${f.name}${f.signature ?? ''}${f.status && f.status !== 'VALID' ? ` — ${f.status}` : ''}`}
                                >
                                  <ChevronSpacer />
                                  <IconFunction className="obj-icon fn" />
                                  <span className="tree-label">{f.name}</span>
                                  <span className="tree-sig">{f.signature}</span>
                                  {f.status && f.status !== 'VALID' && <span className="sys-tag warn">{f.status}</span>}
                                </div>
                              )))}
                        {catRow(`${schema}::procedures`, 'Procedures', procedures.length, IconProceduresCat, () => connId && void toggleCategory(connId, schema, 'procedures' as ObjCategory), schemaCtx)}
                        {procsOpen &&
                          (procedures.length === 0 && !loading(`${schema}::procedures`)
                            ? emptyRow('No procedures')
                            : procedures.map((p) => (
                                <div
                                  key={'p.' + p.name}
                                  className="tree-node object"
                                  onClick={() => connId && void openEditRoutine(connId, p)}
                                  onContextMenu={(e) => {
                                    e.preventDefault()
                                    if (connId) openContextMenu({ x: e.clientX, y: e.clientY, target: { kind: 'routine', connectionId: connId, schema, name: p.name, routineKind: 'procedure', signature: p.signature } })
                                  }}
                                  title={`${p.name}${p.signature ?? ''}${p.status && p.status !== 'VALID' ? ` — ${p.status}` : ''}`}
                                >
                                  <ChevronSpacer />
                                  <IconProcedure className="obj-icon proc" />
                                  <span className="tree-label">{p.name}</span>
                                  <span className="tree-sig">{p.signature}</span>
                                  {p.status && p.status !== 'VALID' && <span className="sys-tag warn">{p.status}</span>}
                                </div>
                              )))}
                      </>
                    )}

                    {/* Packages (Oracle only) */}
                    {engine === 'oracle' && (
                      <>
                        {catRow(`${schema}::packages`, 'Packages', packages.length, IconPackagesCat, () => connId && void toggleCategory(connId, schema, 'packages' as ObjCategory), schemaCtx)}
                        {pkgsOpen &&
                          (packages.length === 0 && !loading(`${schema}::packages`)
                            ? emptyRow('No packages')
                            : packages.map((pk) => (
                                <div
                                  key={'pkg.' + pk.name}
                                  className="tree-node object"
                                  onClick={() => connId && void openEditPackagePart(connId, schema, pk.name, 'packageSpec')}
                                  onContextMenu={(e) => {
                                    e.preventDefault()
                                    if (connId) openContextMenu({ x: e.clientX, y: e.clientY, target: { kind: 'package', connectionId: connId, schema, name: pk.name, hasBody: pk.hasBody } })
                                  }}
                                  title={`Package ${pk.name} — spec ${pk.status ?? '?'}${pk.hasBody ? `, body ${pk.bodyStatus ?? '?'}` : ' (no body)'}`}
                                >
                                  <ChevronSpacer />
                                  <IconPackage className="obj-icon pkg" />
                                  <span className="tree-label">{pk.name}</span>
                                  {!pk.hasBody && <span className="sys-tag">spec only</span>}
                                  {((pk.status && pk.status !== 'VALID') || (pk.bodyStatus && pk.bodyStatus !== 'VALID')) && (
                                    <span className="sys-tag warn">INVALID</span>
                                  )}
                                </div>
                              )))}
                      </>
                    )}

                    {/* Sequences (PostgreSQL + MariaDB) */}
                    {hasSequences ? (
                      <>
                        {catRow(`${schema}::sequences`, 'Sequences', sequences.length, IconSequencesCat, () => connId && void toggleCategory(connId, schema, 'sequences' as ObjCategory), schemaCtx)}
                        {seqsOpen &&
                          (sequences.length === 0 && !loading(`${schema}::sequences`)
                            ? emptyRow('No sequences')
                            : sequences.map((sq) =>
                                sq.system ? (
                                  // Oracle IDENTITY-backing ISEQ$$ sequence — click opens a READ-ONLY
                                  // details view; no context menu (never editable/droppable).
                                  <div
                                    key={'sq.' + sq.name}
                                    className="tree-node object muted"
                                    onClick={() => connId && void openEditSequence(connId, schema, sq.name)}
                                    title={`System sequence ${sq.name} — backs an IDENTITY column (read-only; click to view details)`}
                                  >
                                    <ChevronSpacer />
                                    <IconSequence className="obj-icon seq" />
                                    <span className="tree-label">{sq.name} <span className="sys-tag">system</span></span>
                                  </div>
                                ) : (
                                  <div
                                    key={'sq.' + sq.name}
                                    className="tree-node object"
                                    onClick={() => connId && void openEditSequence(connId, schema, sq.name)}
                                    onContextMenu={(e) => {
                                      e.preventDefault()
                                      if (connId) openContextMenu({ x: e.clientX, y: e.clientY, target: { kind: 'sequence', connectionId: connId, schema, name: sq.name } })
                                    }}
                                    title={`Sequence ${sq.name}`}
                                  >
                                    <ChevronSpacer />
                                    <IconSequence className="obj-icon seq" />
                                    <span className="tree-label">{sq.name}</span>
                                  </div>
                                )
                              ))}
                      </>
                    ) : (
                      <div
                        className="tree-node muted"
                        title={engine === 'mysql' ? 'MySQL uses AUTO_INCREMENT' : 'SQLite has no standalone sequences'}
                      >
                        <ChevronSpacer />
                        <span className="tree-label">
                          Sequences — {engine === 'mysql' ? 'n/a (AUTO_INCREMENT)' : 'n/a (SQLite)'}
                        </span>
                      </div>
                    )}

                    {/* PostgreSQL advanced objects (TASK 67) */}
                    {isPostgres && (
                      <>
                        {catRow(`${schema}::matviews`, 'Materialized Views', matviews.length, IconMatViewsCat, () => connId && void toggleCategory(connId, schema, 'matviews' as ObjCategory), schemaCtx)}
                        {mvOpen &&
                          (matviews.length === 0 && !loading(`${schema}::matviews`)
                            ? emptyRow('No materialized views')
                            : matviews.map((mv) => (
                                <div
                                  key={'mv.' + mv.name}
                                  className="tree-node object"
                                  onClick={() => connId && void openEditMatView(connId, schema, mv.name)}
                                  onContextMenu={(e) => { e.preventDefault(); if (connId) openContextMenu({ x: e.clientX, y: e.clientY, target: { kind: 'matview', connectionId: connId, schema, name: mv.name, populated: mv.populated } }) }}
                                  title={`Materialized view ${mv.name}${mv.populated ? '' : ' (not populated — refresh it)'}`}
                                >
                                  <ChevronSpacer />
                                  <IconMatView className="obj-icon view" />
                                  <span className="tree-label">{mv.name}{mv.populated ? '' : <span className="sys-tag"> unpopulated</span>}</span>
                                </div>
                              )))}

                        {catRow(`${schema}::types`, 'Types', types.length, IconTypesCat, () => connId && void toggleCategory(connId, schema, 'types' as ObjCategory), schemaCtx)}
                        {typesOpen &&
                          (types.length === 0 && !loading(`${schema}::types`)
                            ? emptyRow('No user-defined types')
                            : types.map((ty) => (
                                <div
                                  key={'ty.' + ty.name}
                                  className="tree-node object"
                                  onContextMenu={(e) => { e.preventDefault(); if (connId) openContextMenu({ x: e.clientX, y: e.clientY, target: { kind: 'type', connectionId: connId, schema, name: ty.name, typeKind: ty.kind } }) }}
                                  title={ty.kind === 'enum' ? `Enum ${ty.name}: ${(ty.labels ?? []).join(', ')}` : ty.kind === 'composite' ? `Composite ${ty.name}: ${(ty.fields ?? []).map((f) => f.name + ' ' + f.type).join(', ')}` : `Type ${ty.name}`}
                                >
                                  <ChevronSpacer />
                                  <IconType className="obj-icon" />
                                  <span className="tree-label">{ty.name} <span className="sys-tag">{ty.kind}</span></span>
                                </div>
                              )))}

                        {catRow(`${schema}::extensions`, 'Extensions', extensions.length, IconExtensionsCat, () => connId && void toggleCategory(connId, schema, 'extensions' as ObjCategory), (e) => { e.preventDefault(); if (connId) openContextMenu({ x: e.clientX, y: e.clientY, target: { kind: 'extensionsCat', connectionId: connId, schema } }) })}
                        {extsOpen &&
                          (extensions.length === 0 && !loading(`${schema}::extensions`)
                            ? emptyRow('No extensions installed')
                            : extensions.map((ex) => (
                                <div
                                  key={'ex.' + ex.name}
                                  className="tree-node object"
                                  onContextMenu={(e) => { e.preventDefault(); if (connId) openContextMenu({ x: e.clientX, y: e.clientY, target: { kind: 'extension', connectionId: connId, name: ex.name, installedVersion: ex.installedVersion, defaultVersion: ex.defaultVersion } }) }}
                                  title={`Extension ${ex.name} ${ex.installedVersion ?? ''}${ex.comment ? ' — ' + ex.comment : ''}`}
                                >
                                  <ChevronSpacer />
                                  <IconExtension className="obj-icon" />
                                  <span className="tree-label">{ex.name} <span className="sys-tag">{ex.installedVersion}</span></span>
                                </div>
                              )))}
                      </>
                    )}
                  </>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
