const V2_DEVICE_PROGRESS_UNAVAILABLE = "当前云端 Vault 尚未激活 Vault Sync v2，暂时不能读取设备 received/applied 游标；请先完成云端 v2 初始化";
const V2_BASELINE_UNAVAILABLE = "当前云端 Vault 已激活 Vault Sync v2，但基线尚未准备完成；已暂停同步，请稍后重试或联系支持";

export interface VaultSyncCapabilityState {
  activeProtocolVersion: number;
  canRead: boolean;
  baselineReady: boolean;
}

export function resolveVaultSyncProtocol(capabilities: VaultSyncCapabilityState | null): "v1" | "v2" {
  if (!capabilities || capabilities.activeProtocolVersion === 1) return "v1";
  if (capabilities.activeProtocolVersion !== 2) {
    throw Object.assign(new Error("云端返回了不支持的 Vault Sync 协议版本"), { code: "vault_sync_protocol_unsupported" });
  }
  if (!capabilities.canRead) {
    throw Object.assign(new Error("服务端已切换到 Vault 同步 v2，但当前设备没有读取权限；为保护本地数据，已暂停同步"), {
      code: "vault_sync_v2_read_unavailable",
    });
  }
  if (!capabilities.baselineReady) {
    throw Object.assign(new Error(V2_BASELINE_UNAVAILABLE), { code: "vault_sync_v2_baseline_not_ready" });
  }
  return "v2";
}

export interface VaultSyncDeviceProgressGateway<TProgress> {
  getCapabilities(): Promise<{ activeProtocolVersion: number }>;
  getV2DeviceProgress(): Promise<TProgress>;
}

export async function fetchV2DeviceProgressWhenActive<TProgress>(
  gateway: VaultSyncDeviceProgressGateway<TProgress>,
): Promise<TProgress> {
  const capabilities = await gateway.getCapabilities();
  if (capabilities.activeProtocolVersion !== 2) {
    throw new Error(V2_DEVICE_PROGRESS_UNAVAILABLE);
  }
  return gateway.getV2DeviceProgress();
}
