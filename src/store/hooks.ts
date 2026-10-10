import { useSyncExternalStore } from 'react';
import { store, AppStore } from './store';

/** Subscribe to the whole store; re-renders on any emit(). */
export function useStore(): AppStore {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

export { store };
