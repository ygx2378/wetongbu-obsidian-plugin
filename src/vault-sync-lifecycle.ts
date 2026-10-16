export interface VaultSyncLifecycleInterval {
  pause(): void;
}

export interface VaultSyncLifecycleRetry {
  clear(): void;
  wake(): void;
}

export interface VaultSyncLifecycleScheduler {
  pause(): void;
  resume(): void;
}

export interface VaultSyncLifecycleHandlersOptions {
  isOnline(): boolean;
  isHidden(): boolean;
  setEventOnline(online: boolean): void;
  setEventForeground(foreground: boolean): void;
  eventScheduler: VaultSyncLifecycleScheduler;
  retryScheduler: VaultSyncLifecycleRetry;
  intervalScheduler: VaultSyncLifecycleInterval;
  restartIntervalScheduler(): void;
  resumeAccountLogin(): void;
  requestAutomaticSync(): void;
}

/** Keep the app's offline, foreground, retry, and periodic-sync lanes in step. */
export function createVaultSyncLifecycleHandlers(options: VaultSyncLifecycleHandlersOptions) {
  const pauseAutomaticLanes = () => {
    options.eventScheduler.pause();
    options.retryScheduler.clear();
    options.intervalScheduler.pause();
  };

  return {
    focus() {
      options.resumeAccountLogin();
      if (!options.isHidden() && options.isOnline()) options.retryScheduler.wake();
      options.requestAutomaticSync();
    },
    online() {
      options.setEventOnline(true);
      if (!options.isHidden()) {
        options.eventScheduler.resume();
        options.retryScheduler.wake();
        options.restartIntervalScheduler();
      } else {
        pauseAutomaticLanes();
      }
      options.requestAutomaticSync();
    },
    offline() {
      options.setEventOnline(false);
      pauseAutomaticLanes();
    },
    visibilityChange() {
      const foreground = !options.isHidden();
      options.setEventForeground(foreground);
      if (!foreground) {
        pauseAutomaticLanes();
        return;
      }
      if (options.isOnline()) {
        options.eventScheduler.resume();
        options.restartIntervalScheduler();
      }
      options.resumeAccountLogin();
      if (options.isOnline()) options.retryScheduler.wake();
      options.requestAutomaticSync();
    },
  };
}
