import { useCallback, useEffect, useState } from 'react'
import type { FeatureInfo, FeatureStatusEntry } from '../../../shared/features'
import { useI18n } from '../i18n'
import './workspace-tray.css'

interface AssetView {
  id: string
  name: string
  mime: string
  bytes: number
  width?: number
  height?: number
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 对话里的“工作区”卡片：
 *  - 状态卡完全由 features 列表驱动（声明 contributes.statusCard 的已启用插件）；
 *  - 卡片的按钮来自插件发布的 status.actions，点击统一走 features:invoke；
 *  - 本地资产库仍然通用；插入图片由设计插件的 design.insert-image 命令完成。
 *
 * 这里刻意不出现任何 `design*` 入口判断：设计插件被禁用后，它的状态卡与按钮
 * 自然从列表里消失，而资产库本身不受影响。
 */
export function WorkspaceTray(): React.JSX.Element {
  const { t } = useI18n()
  const [features, setFeatures] = useState<FeatureInfo[]>([])
  const [statuses, setStatuses] = useState<FeatureStatusEntry[]>([])
  const [featureErrors, setFeatureErrors] = useState<string[]>([])
  const [assets, setAssets] = useState<AssetView[]>([])
  const [note, setNote] = useState('')
  const [lastExport, setLastExport] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [featureList, featureStatus, assetList] = await Promise.all([
        window.cobrowse.featuresList(),
        window.cobrowse.featuresStatus(),
        window.cobrowse.assetsList()
      ])
      setFeatures(featureList.features)
      setFeatureErrors(featureList.errors ?? [])
      setStatuses(featureStatus.statuses ?? [])
      setAssets(assetList.assets ?? [])
    } catch {
      /* 面板刚启动时 IPC 可能还没就绪，下一次 features:changed 会补上 */
    }
  }, [])

  useEffect(() => {
    void refresh()
    const off = window.cobrowse.onFeaturesChanged((payload) => {
      setFeatures(payload.features)
      setStatuses(payload.statuses)
      setFeatureErrors(payload.errors ?? [])
    })
    return off
  }, [refresh])

  const statusOf = (featureId: string): FeatureStatusEntry['status'] | null =>
    statuses.find((entry) => entry.id === featureId)?.status ?? null

  const invoke = async (featureId: string, command: string): Promise<void> => {
    setBusy(true)
    try {
      const result = await window.cobrowse.featuresInvoke(command, undefined, featureId)
      if (!result.ok) {
        const payload = result.result as { canceled?: boolean } | undefined
        if (!payload?.canceled) setNote(result.error ?? t('feature.invokeFailed', { err: command }))
        return
      }
      const payload = result.result as { path?: string } | undefined
      if (payload?.path) setLastExport(payload.path)
      setNote('')
    } catch (error) {
      setNote((error as Error)?.message ?? t('feature.invokeFailed', { err: command }))
    } finally {
      setBusy(false)
      await refresh()
    }
  }

  const pasteAsset = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await window.cobrowse.assetsPaste()
      setAssets(result.assets ?? [])
      setNote(result.ok ? '已从剪贴板导入' : result.error ?? '剪贴板里没有图片')
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

  const insertImage = async (asset: AssetView): Promise<void> => {
    setBusy(true)
    try {
      const result = await window.cobrowse.designInsertImage(asset.id)
      setNote(result.ok ? `已插入 ${asset.name}（从上方状态卡打开画布）` : result.error ?? '插入失败')
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const cards = features.filter(
    (feature) => feature.enabled && feature.manifest.contributes.statusCard
  )

  return (
    <div className="ws-tray">
      {cards.map((feature) => {
        const status = statusOf(feature.manifest.id)
        const actions =
          status?.actions ??
          (feature.manifest.contributes.toolbar ?? []).map((item) => ({
            id: item.id,
            label: item.label,
            command: item.command
          }))
        const tone = status?.tone ?? 'info'
        return (
          <div className="ws-card" key={feature.manifest.id}>
            <div className="ws-card-head">
              <span className="ws-card-title">{feature.manifest.name}</span>
              {status && (
                <span
                  className={`ws-dot ${tone === 'warn' || tone === 'error' ? 'dirty' : 'clean'}`}
                  title={status.text}
                />
              )}
            </div>
            <div className="ws-card-meta">{status?.text ?? feature.manifest.description}</div>
            {status?.detail && <div className="ws-card-meta">{status.detail}</div>}
            {actions.length > 0 && (
              <div className="ws-card-actions">
                {actions.map((action) => (
                  <button
                    key={action.id}
                    disabled={busy}
                    title={action.command}
                    onClick={() => void invoke(feature.manifest.id, action.command)}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )
      })}

      <div className="ws-assets">
        <div className="ws-assets-head">
          <span>本地资产</span>
          <span className="ws-assets-buttons">
            <button className="ws-import" disabled={busy} onClick={() => void pasteAsset()}>粘贴图片</button>
            <button className="ws-import" disabled={busy} onClick={() => void importAssets()}>+ 导入</button>
          </span>
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
        {lastExport && (
          <div className="ws-export">
            <div className="ws-export-path" title={lastExport}>{lastExport}</div>
            <div className="ws-export-actions">
              <button onClick={() => void window.cobrowse.showItemInFolder(lastExport)}>打开文件夹</button>
              <button onClick={() => void window.cobrowse.copyText(lastExport)}>复制路径</button>
            </div>
          </div>
        )}
      </div>
      {featureErrors.length > 0 && (
        <div className="ws-note" title={featureErrors.join('\n')}>
          {featureErrors[featureErrors.length - 1]}
        </div>
      )}
    </div>
  )
}
