import type { VaultSyncOutboxSnapshot, VaultSyncOutboxStore } from "./vault-sync-outbox.ts";
import type { VaultSyncV2Ack, VaultSyncV2ChangePage, VaultSyncV2DeviceSession } from "./vault-sync-v2-remote.ts";

export interface VaultSyncV2InboxRemote {
  startV2DeviceSession(): Promise<VaultSyncV2DeviceSession>;
  getV2Changes(input: {
    protocolEpoch: number;
    sessionGeneration: string;
    after: string;
    through?: string;
    limit: number;
  }): Promise<VaultSyncV2ChangePage>;
  acknowledgeV2Changes(input: VaultSyncV2Ack): Promise<VaultSyncV2Ack>;
}

function fail(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

function sameCursors(left: VaultSyncV2Ack, right: VaultSyncV2Ack): boolean {
  return left.protocolEpoch === right.protocolEpoch
    && left.sessionGeneration === right.sessionGeneration
    && left.receivedCursor === right.receivedCursor
    && left.appliedCursor === right.appliedCursor;
}

/** Persist remote pages before acknowledging receipt; applying files is a separate engine phase. */
export function createVaultSyncV2InboxPump(
  remote: VaultSyncV2InboxRemote,
  journal: VaultSyncOutboxStore,
  options: { pageSize?: number; maxPagesPerRun?: number; maxPendingInboxEntries?: number } = {},
) {
  const pageSize = options.pageSize ?? 100;
  const maxPagesPerRun = options.maxPagesPerRun ?? 100;
  const maxPendingInboxEntries = options.maxPendingInboxEntries ?? 500;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 500
    || !Number.isSafeInteger(maxPagesPerRun) || maxPagesPerRun < 1
    || !Number.isSafeInteger(maxPendingInboxEntries) || maxPendingInboxEntries < 1 || maxPendingInboxEntries > 10_000) {
    throw new Error("Vault v2 inbox pump 参数无效");
  }

  return {
    async runOnce(): Promise<{ pagesReceived: number; snapshot: VaultSyncOutboxSnapshot }> {
      let current = await journal.load();
      if (!current) throw fail("snapshot_required", "尚未安装经验证的远端快照，暂不能接收 v2 增量");

      const session = await remote.startV2DeviceSession();
      if (!Number.isSafeInteger(session.protocolEpoch) || session.protocolEpoch !== current.identity.protocolEpoch) {
        throw fail("epoch_mismatch", "服务端协议代数已变化，需要重新建立快照基线");
      }
      if (!/^[1-9][0-9]*$/.test(session.sessionGeneration) || !/^(0|[1-9][0-9]*)$/.test(session.receivedCursor)
        || !/^(0|[1-9][0-9]*)$/.test(session.appliedCursor)) {
        throw fail("device_session_invalid", "服务端返回的设备会话游标无效");
      }
      if (BigInt(session.receivedCursor) > BigInt(current.receivedCursor)
        || BigInt(session.appliedCursor) > BigInt(current.appliedCursor)) {
        throw fail("snapshot_required", "服务端确认进度领先于本地 journal，需要恢复快照后再继续");
      }

      await journal.setSessionGeneration(session.sessionGeneration);
      current = (await journal.load())!;
      let ack: VaultSyncV2Ack = {
        protocolEpoch: session.protocolEpoch,
        sessionGeneration: session.sessionGeneration,
        receivedCursor: current.receivedCursor,
        appliedCursor: current.appliedCursor,
      };
      if (ack.receivedCursor !== session.receivedCursor || ack.appliedCursor !== session.appliedCursor) {
        const repaired = await remote.acknowledgeV2Changes(ack);
        if (!sameCursors(repaired, ack)) throw fail("ack_mismatch", "服务端没有确认本地已持久的恢复游标");
      }

      let through: string | undefined;
      let pagesReceived = 0;
      while (pagesReceived < maxPagesPerRun) {
        // A conflict holds the contiguous applied cursor, but must not stop
        // receipt of unrelated later files. Keep the durable journal bounded
        // while still allowing the apply engine to process independent items.
        // Applied entries beyond the gap still have to stay in the journal so
        // the contiguous applied cursor can advance after conflict resolution.
        const appliedCursor = BigInt(current.appliedCursor);
        const retainedWindow = current.inbox.filter((entry) => BigInt(entry.cursor) > appliedCursor).length;
        const remainingCapacity = maxPendingInboxEntries - retainedWindow;
        if (remainingCapacity <= 0) return { pagesReceived, snapshot: current };
        const before = current.receivedCursor;
        const page = await remote.getV2Changes({
          protocolEpoch: session.protocolEpoch,
          sessionGeneration: session.sessionGeneration,
          after: before,
          ...(through === undefined ? {} : { through }),
          limit: Math.min(pageSize, remainingCapacity),
        });
        const next = await journal.receivePage(page);
        if (BigInt(next.receivedCursor) < BigInt(before)) throw fail("inbox_cursor_regression", "本地 journal 接收游标发生回退");
        current = next;
        ack = {
          protocolEpoch: session.protocolEpoch,
          sessionGeneration: session.sessionGeneration,
          receivedCursor: current.receivedCursor,
          appliedCursor: current.appliedCursor,
        };
        const acknowledged = await remote.acknowledgeV2Changes(ack);
        if (!sameCursors(acknowledged, ack)) throw fail("ack_mismatch", "服务端确认游标与本地 journal 不一致");
        pagesReceived += 1;
        if (!page.hasMore) return { pagesReceived, snapshot: current };
        if (current.receivedCursor === before) throw fail("inbox_cursor_stalled", "服务端增量页没有推进接收游标");
        through = page.throughCursor;
      }
      throw fail("inbox_page_limit", "本轮增量页数达到上限；已保存并确认的页面会在下一轮继续");
    },
  };
}
