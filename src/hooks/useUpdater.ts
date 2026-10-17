import { useSyncExternalStore } from 'react';
import { updater, type UpdateState } from '../lib/updater';

/** The update's state (lib/updater.ts), redrawn as it moves along. */
export function useUpdater(): UpdateState {
  return useSyncExternalStore(updater.subscribe, updater.getSnapshot);
}
