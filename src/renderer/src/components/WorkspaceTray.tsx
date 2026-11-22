import { useCallback, useEffect, useState } from 'react'
import './workspace-tray.css'

interface AssetView {
  id: string
  name: string
  mime: string
  bytes: number
  width?: number
  height?: number
}

interface DesignView {
  name: string
  round: number
  dirty: boolean
  canUndo: boolean
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 对话里的"工作区"卡片：设计画布状态 + 本地资产。
 *
 * 这是把设计能力接进对话的入口，而不是把画布塞进气泡：
 *  - 卡片只显示状态和动作，编辑仍在画布标签里完成；
 *  - 资产是本地库（内容寻址），点一下插入为图片节点；
 *  - 不重复实现渲染，不复制设计文档状态。
 */
export function WorkspaceTray(): React.JSX.Element {
  const [design, setDesign] = useState<DesignView | null>(null)
  const [assets, setAssets] = useState<AssetView[]>([])
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [state, list] = await Promise.all([window.cobrowse.designState(), window.cobrowse.assetsList()])
      setDesign(
        state.ok && state.state
          ? {
              name: state.name ?? state.state.projectId,
              round: state.state.version,
              dirty: state.state.dirty,
              canUndo: state.state.canUndo
            }
          : null
      )
      setAssets(list.assets ?? [])
    } catch {
      /* 面板刚启动时 IPC 可能还没就绪，下一次轮询会补上 */
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 3000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const openCanvas = async (): Promise<void> => {
    await window.cobrowse.designOpenCanvas()
  }

  const undo = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await window.cobrowse.designUndo()
      setNote(result && 'ok' in result && result.ok ? '已撤销一步' : '没有可撤销的操作')
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const commit = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await window.cobrowse.designCommit('从对话提交')
      setNote(result?.ok ? '已提交一轮' : result?.error ?? '提交失败')
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const importAssets = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await window.cobrowse.assetsImportDialog()
      if (result.canceled) return
      setAssets(result.assets ?? [])
      setNote(result.ok ? `已导入 ${result.imported.length} 个资产` : result.errors?.[0] ?? '导入失败')
    } finally {
      setBusy(false)
    }
  }

  const exportSite = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await window.cobrowse.designExport()
      if (result.canceled) return
      setNote(
        result.ok
          ? `已导出：${result.path ?? ''}（请把整个 site 文件夹一起发）`
          : result.error ?? '导出失败'
      )
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const insertImage = async (asset: AssetView): Promise<void> => {
    setBusy(true)
    try {
      const result = await window.cobrowse.designInsertImage(asset.id)
      if (result.ok) {
        await window.cobrowse.designOpenCanvas()
        setNote(`已插入 ${asset.name}`)
      } else {
        setNote(result.error ?? '插入失败')
      }
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ws-tray">
      {design ? (
        <div className="ws-card">
          <div className="ws-card-head">
            <span className="ws-card-title">设计画布 · {design.name}</span>
            <span className={`ws-dot ${design.dirty ? 'dirty' : 'clean'}`} title={design.dirty ? '有未提交改动' : '已提交'} />
          </div>
          <div className="ws-card-meta">
            第 {design.round} 轮 · {design.dirty ? '有未提交改动' : '已提交'}
          </div>
          <div className="ws-card-actions">
            <button disabled={busy} onClick={() => void openCanvas()}>打开画布</button>
            <button disabled={busy || !design.canUndo} onClick={() => void undo()}>撤销</button>
            <button disabled={busy} onClick={() => void commit()}>保存</button>
            <button disabled={busy} onClick={() => void exportSite()}>导出</button>
          </div>
        </div>
      ) : (
        <div className="ws-card">
          <div className="ws-card-head">
            <span className="ws-card-title">设计画布</span>
          </div>
          <div className="ws-card-meta">还没有打开设计项目</div>
          <div className="ws-card-actions">
            <button disabled={busy} onClick={() => void openCanvas()}>打开画布</button>
          </div>
        </div>
      )}

      <div className="ws-assets">
        <div className="ws-assets-head">
          <span>本地资产</span>
          <button className="ws-import" disabled={busy} onClick={() => void importAssets()}>+ 导入</button>
        </div>
        {assets.length === 0 ? (
          <div className="ws-assets-empty">导入图片或文件，用于设计、分析或溯源</div>
        ) : (
          <div className="ws-asset-list">
            {assets.slice(0, 12).map((asset) => (
              <button
                key={asset.id}
                className="ws-asset"
                disabled={busy}
                title={`点击把「${asset.name}」插入到画布`}
                onClick={() => void insertImage(asset)}
              >
                <span className="ws-asset-name">{asset.name}</span>
                <span className="ws-asset-action">插入到画布 →</span>
                {asset.width && asset.height ? (
                  <span className="ws-asset-meta">{asset.width}×{asset.height}</span>
                ) : (
                  <span className="ws-asset-meta">{sizeLabel(asset.bytes)}</span>
                )}
              </button>
            ))}
          </div>
        )}
        {note && <div className="ws-note">{note}</div>}
      </div>
    </div>
  )
}
