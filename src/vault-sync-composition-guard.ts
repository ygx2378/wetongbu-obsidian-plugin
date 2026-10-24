import type { App } from "obsidian";
import { normalizeVaultPath, portableVaultPathKey } from "./shared/vault-sync-protocol.mjs";

type CompositionBinding = {
  root: any;
  leaf: any;
  activePathKey: string | null;
  onStart: (event: Event) => void;
  onEnd: (event: Event) => void;
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
) {
  const workspace: any = (app as any).workspace;
  const bindings = new Map<any, CompositionBinding>();
  const activeByPath = new Map<string, Set<CompositionBinding>>();

  const addActive = (key: string, binding: CompositionBinding) => {
    const active = activeByPath.get(key) ?? new Set<CompositionBinding>();
    active.add(binding);
    activeByPath.set(key, active);
  };

  const removeActive = (key: string, binding: CompositionBinding) => {
    const active = activeByPath.get(key);
    active?.delete(binding);
    if (active?.size === 0) activeByPath.delete(key);
  };

  const currentPathKey = (binding: CompositionBinding) => pathKey(binding.leaf?.view?.file?.path);

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
    for (const [root, binding] of bindings) {
      root.removeEventListener("compositionstart", binding.onStart, true);
      root.removeEventListener("compositionend", binding.onEnd, true);
      endComposition(binding, false);
    }
    bindings.clear();
    activeByPath.clear();
  }

  refresh();
  return { refresh, isComposing, dispose };
}
