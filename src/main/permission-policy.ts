/**
 * Electron 的原始权限名 → 用户可理解的类别。
 *
 * 类型是 `Record<ElectronPermission, PermissionCategory>`，而 `ElectronPermission`
 * 取自 `Session['setPermissionRequestHandler']` 的签名——**Electron 将来新增权限时，
 * 这里会直接编译失败**，而不是悄悄落到 `other`（那等于默认放行一个没人评估过的能力）。
 * 这是本模块唯一的存在理由，请不要把它改成 `Record<string, …>`。
 */
import type { Session } from 'electron'
import type { PermissionCategory } from '../shared/permissions'

type PermissionRequestHandler = Parameters<Session['setPermissionRequestHandler']>[0]
type ElectronPermission = Parameters<NonNullable<PermissionRequestHandler>>[1]

export const PERMISSION_CATEGORY: Record<ElectronPermission, PermissionCategory> = {
  // 全屏 / 显示
  fullscreen: 'fullscreen',
  'automatic-fullscreen': 'fullscreen',

  // DRM（付费视频）
  mediaKeySystem: 'drm',

  // 存储与后台同步（内嵌 SSO 读登录态要靠 storage-access）
  'persistent-storage': 'storage',
  'storage-access': 'storage',
  'top-level-storage-access': 'storage',
  'background-sync': 'storage',
  'periodic-background-sync': 'storage',
  'background-fetch': 'storage',

  // 保持唤醒（看视频不息屏）
  'screen-wake-lock': 'wake',
  'system-wake-lock': 'wake',
  'idle-detection': 'wake',

  // 低风险杂项
  'web-printing': 'print',
  'window-management': 'print',
  'payment-handler': 'print',
  'web-app-installation': 'print',

  // 指针 / 键盘锁定（在线 3D、游戏）
  pointerLock: 'pointer',
  keyboardLock: 'pointer',

  // 剪贴板写入：无害（只能写净化后的文本），任何窗口直接放行
  'clipboard-sanitized-write': 'clipboard-write',

  // 摄像头 / 麦克风
  media: 'media',

  // 通知
  notifications: 'notifications',

  // 定位
  geolocation: 'geolocation',
  'geolocation-approximate': 'geolocation',

  // 读取剪贴板
  'clipboard-read': 'clipboard-read',
  'deprecated-sync-clipboard-read': 'clipboard-read',

  // 屏幕共享
  'display-capture': 'display-capture',
  'captured-surface-control': 'display-capture',

  // 本地文件
  fileSystem: 'file-system',

  // 传感器与周边（可撤回）
  sensors: 'sensors',
  'local-fonts': 'sensors',
  'speaker-selection': 'sensors',
  midi: 'sensors',

  // 唤起外部应用（可启动任意协议）
  openExternal: 'open-external',

  // 硬件直通 / 身体相关：高危，默认拒绝，只有显式放行才开
  serial: 'device',
  usb: 'device',
  hid: 'device',
  midiSysex: 'device',
  'smart-card': 'device',
  nfc: 'device',
  vr: 'device',
  ar: 'device',
  'hand-tracking': 'device',

  // 内网探测
  'local-network': 'local-network',
  'local-network-access': 'local-network',
  'loopback-network': 'local-network',

  // 兜底：未识别的权限先当作有隐私含义 → ask，不允许静默放行
  unknown: 'other'
}

/** 单点查询；`undefined` 说明映射表漏了（正常情况下编译期就挡住了）。 */
export function categoryForPermission(permission: string): PermissionCategory | null {
  return Object.prototype.hasOwnProperty.call(PERMISSION_CATEGORY, permission)
    ? PERMISSION_CATEGORY[permission as ElectronPermission]
    : null
}
