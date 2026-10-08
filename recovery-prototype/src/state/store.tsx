// Prototype state container. Plain React state persisted to localStorage so the
// demo survives a refresh. This is NOT production persistence.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createSeedData, SCHEMA_VERSION } from '../data/mockData';
import { toClientView, type ClientCaseView } from '../domain/clientView';
import type { AppData } from '../domain/types';

const STORAGE_KEY = 'rre-stage1-demo';

function load(): AppData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as AppData;
      if (parsed.schemaVersion === SCHEMA_VERSION) return parsed;
    }
  } catch {
    // Corrupt or unavailable storage: fall back to seed data.
  }
  return createSeedData();
}

interface Store {
  data: AppData;
  /**
   * Applies a transition. Returns an error message instead of throwing so
   * screens can show it inline.
   */
  apply: (fn: (d: AppData) => AppData) => string | null;
  reset: () => void;
  setDemoClient: (clientId: string) => void;
}

const StoreContext = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<AppData>(load);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      // Storage full or blocked; the demo still works in memory.
    }
  }, [data]);

  // Ref mirrors state so transitions run synchronously and can report errors.
  const dataRef = useRef(data);
  const commit = useCallback((next: AppData) => {
    dataRef.current = next;
    setData(next);
  }, []);

  const apply = useCallback(
    (fn: (d: AppData) => AppData) => {
      try {
        commit(fn(dataRef.current));
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    },
    [commit],
  );

  const reset = useCallback(() => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    commit(createSeedData());
  }, [commit]);

  const setDemoClient = useCallback(
    (clientId: string) => commit({ ...dataRef.current, demoClientId: clientId }),
    [commit],
  );

  const value = useMemo(() => ({ data, apply, reset, setDemoClient }), [data, apply, reset, setDemoClient]);
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore() {
  const s = useContext(StoreContext);
  if (!s) throw new Error('useStore must be used inside StoreProvider');
  return s;
}

/** Client screens use this: returns only client-safe projections for the demo client. */
export function useClientCases(): { clientName: string; currency: string; cases: ClientCaseView[] } {
  const { data } = useStore();
  const client = data.clients.find((c) => c.id === data.demoClientId);
  const cases = data.cases.filter((c) => c.clientId === data.demoClientId).map(toClientView);
  return { clientName: client?.businessName ?? 'Unknown client', currency: client?.currency ?? 'NGN', cases };
}

/** A single client-safe case view, or null if it does not belong to the demo client. */
export function useClientCase(id: string): { view: ClientCaseView | null; currency: string } {
  const { cases, currency } = useClientCases();
  return { view: cases.find((c) => c.id === id) ?? null, currency };
}
