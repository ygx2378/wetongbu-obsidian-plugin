import type { App } from "obsidian";
import { normalizeVaultPath, portableVaultPathKey } from "./shared/vault-sync-protocol.mjs";

type CompositionBinding = {
  root: any;
  leaf: any;
  activePathKey: string | null;
  onStart: (event: Event) => void;
  onEnd: (event: Event) => void;
};

type RenameCompositionBinding = {
  path: string;
  key: string;
};

function pathKey(rawPath: unknown): string | null {
  if (typeof rawPath !== "string") return null;
  const normalized = normalizeVaultPath(rawPath);
  return normalized ? portableVaultPathKey(normalized) ?? normalized : null;
}

/**
 * Track native IME composition per Markdown view so a preedit buffer is never
 * treated as a stable local revision. Other Vault paths remain eligible to sync.
 */
export function createVaultSyncCompositionGuard(
  app: App,
  onCompositionEnd: (path: string) => void,
  compositionEventRoot: EventTarget | null = typeof document === "undefined" ? null : document,
) {
  const workspace: any = (app as any).workspace;
  const bindings = new Map<any, CompositionBinding>();
  const activeByPath = new Map<string, Set<object>>();
  const renameBindings = new Map<EventTarget, RenameCompositionBinding>();

  const addActive = (key: string, binding: object) => {
    const active = activeByPath.get(key) ?? new Set<object>();
    active.add(binding);
    activeByPath.set(key, active);
  };

  const removeActive = (key: string, binding: object) => {
    const active = activeByPath.get(key);
    active?.delete(binding);
    if (active?.size === 0) activeByPath.delete(key);
  };

  const currentPathKey = (binding: CompositionBinding) => pathKey(binding.leaf?.view?.file?.path);

  const renamePathFromTarget = (target: EventTarget | null) => {
    const element = target as any;
    const row = element?.closest?.(".nav-file-title[data-path]")
      ?? element?.parentElement?.closest?.(".nav-file-title[data-path]");
    const rawPath = row?.dataset?.path ?? row?.getAttribute?.("data-path");
    const path = typeof rawPath === "string" ? normalizeVaultPath(rawPath) : "";
    const key = path ? pathKey(path) : null;
    return path && key ? { path, key } : null;
  };

  const onRenameCompositionStart = (event: Event) => {
    const target = event.target;
    if (!target) return;
    const next = renamePathFromTarget(target);
    if (!next) return;
    const previous = renameBindings.get(target);
    if (previous) removeActive(previous.key, previous as object);
    const binding: RenameCompositionBinding = next;
    renameBindings.set(target, binding);
    addActive(binding.key, binding);
  };

  const onRenameCompositionEnd = (event: Event) => {
    const target = event.target;
    if (!target) return;
    const binding = renameBindings.get(target);
    if (!binding) return;
    const current = renamePathFromTarget(target);
    if (current && current.key !== binding.key) {
      removeActive(binding.key, binding);
      binding.path = current.path;
      binding.key = current.key;
      addActive(binding.key, binding);
    }
    renameBindings.delete(target);
    removeActive(binding.key, binding);
    onCompositionEnd(binding.path);
  };

  compositionEventRoot?.addEventListener("compositionstart", onRenameCompositionStart, true);
  compositionEventRoot?.addEventListener("compositionend", onRenameCompositionEnd, true);

  const endComposition = (binding: CompositionBinding, notify: boolean) => {
    const key = binding.activePathKey;
    if (!key) return;
    binding.activePathKey = null;
    removeActive(key, binding);
    if (notify) {
      const path = normalizeVaultPath(binding.leaf?.view?.file?.path ?? "");
      if (path) onCompositionEnd(path);
    }
  };

  function refresh() {
    const leaves = typeof workspace?.getLeavesOfType === "function"
      ? workspace.getLeavesOfType("markdown") ?? [] : [];
    const currentRoots = new Set<any>();

    for (const leaf of leaves) {
      const view = leaf?.view;
      const root = view?.containerEl;
      if (!root || typeof root.addEventListener !== "function") continue;
      currentRoots.add(root);
      let binding = bindings.get(root);
      if (!binding) {
        binding = { root, leaf, activePathKey: null, onStart: () => {}, onEnd: () => {} };
        binding.onStart = () => {
          const nextKey = currentPathKey(binding!);
          if (!nextKey) return;
          if (binding!.activePathKey) endComposition(binding!, false);
          binding!.activePathKey = nextKey;
          addActive(nextKey, binding!);
        };
        binding.onEnd = () => {
          if (!binding!.activePathKey) return;
          const nextKey = currentPathKey(binding!);
          if (nextKey && nextKey !== binding!.activePathKey) {
            removeActive(binding!.activePathKey, binding!);
            binding!.activePathKey = nextKey;
            addActive(nextKey, binding!);
          }
          endComposition(binding!, true);
        };
        root.addEventListener("compositionstart", binding.onStart, true);
        root.addEventListener("compositionend", binding.onEnd, true);
        bindings.set(root, binding);
      }
      binding.leaf = leaf;
      const nextKey = currentPathKey(binding);
      if (binding.activePathKey && nextKey && nextKey !== binding.activePathKey) {
        removeActive(binding.activePathKey, binding);
        binding.activePathKey = nextKey;
        addActive(nextKey, binding);
      }
    }

    for (const [root, binding] of bindings) {
      if (currentRoots.has(root)) continue;
      root.removeEventListener("compositionstart", binding.onStart, true);
      root.removeEventListener("compositionend", binding.onEnd, true);
      endComposition(binding, true);
      bindings.delete(root);
    }
  }

  function isComposing(rawPath: string): boolean {
    const key = pathKey(rawPath);
    return !!key && (activeByPath.get(key)?.size ?? 0) > 0;
  }

  function dispose() {
    compositionEventRoot?.removeEventListener("compositionstart", onRenameCompositionStart, true);
    compositionEventRoot?.removeEventListener("compositionend", onRenameCompositionEnd, true);
    for (const [root, binding] of bindings) {
      root.removeEventListener("compositionstart", binding.onStart, true);
      root.removeEventListener("compositionend", binding.onEnd, true);
      endComposition(binding, false);
    }
    renameBindings.clear();
    bindings.clear();
    activeByPath.clear();
  }

  refresh();
  return { refresh, isComposing, dispose };
}
