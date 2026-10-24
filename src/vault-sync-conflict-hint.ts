type RemoteRenameConflictHintInput = {
  fileId: string;
  eventType: string;
  path: string;
  previousPath: string | null;
};

export type RemoteRenameTargetIdentity = "same" | "different" | "unknown";

/** Compare a local target path with verified, active baseline identity records only. */
export function classifyRemoteRenameTargetIdentity(
  item: RemoteRenameConflictHintInput,
  baselineEntries: ReadonlyArray<{ fileId: string; path: string; isDeleted: boolean }>,
): RemoteRenameTargetIdentity {
  if (item.eventType !== "rename" || !item.previousPath || item.previousPath === item.path) return "unknown";
  const targetEntries = baselineEntries.filter((entry) => !entry.isDeleted && entry.path === item.path);
  if (targetEntries.length !== 1) return "unknown";
  return targetEntries[0].fileId === item.fileId ? "same" : "different";
}

/** Explain the local path collision without implying that either copy is disposable. */
export function describeRemoteRenameConflictHint(
  item: RemoteRenameConflictHintInput,
  targetOccupiedByAnotherPath: boolean,
  sourceIsCurrentDevice = false,
  targetIdentity: RemoteRenameTargetIdentity = "unknown",
): string | null {
  if (item.eventType !== "rename" || !item.previousPath || item.previousPath === item.path) return null;
  if (targetOccupiedByAnotherPath) {
    if (targetIdentity === "same") {
      return "本机同步基线记录目标路径与远端改名属于同一文件身份；仍需核对当前正文，确认前不会覆盖本机文件。";
    }
    if (targetIdentity === "different") {
      return "本机同步基线记录目标路径属于另一文件（文件身份不同）；本机文件和远端改名都会保留，不会互相覆盖。";
    }
    if (sourceIsCurrentDevice) {
      return "改名事件来自本机设备，但本机同步基线不足以判断目标文件身份；请先核对，来源设备相同不足以证明文件身份，核对前不会覆盖。";
    }
    return "本机已有文件占用改名后的目标路径，且本机同步基线不足以判断文件身份；同步已暂停以避免覆盖。请先核对原路径和目标路径。";
  }
  return "当前改名无法安全自动应用；同步保留了冲突，请检查本机原路径和目标路径后再处理。";
}
