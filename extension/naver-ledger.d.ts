interface Scope { kind: 'naver-region'; code: string; name: string; filter?: Record<string, unknown>; sort?: string }
interface Ledger { scope: Scope; pages: number; ids: string[]; next: unknown[]; ended: boolean; signatures: Record<string,string>; total?: number; seed?: unknown; query?: string; invalid?: string }
interface Coverage { code: string; pages: number; total: number | null; received: number; stored: number | null; complete: boolean; reason: string }
declare const api: {
  TYPES: string[];
  scope(value: unknown): Scope;
  endpoint(url: string): boolean;
  create(value: unknown): Ledger;
  accept(ledger: Ledger, capture: {url: string; status: number | null; requestBody: string | null; body: string}): void;
  coverage(ledger: Ledger, stored?: number | null): Coverage;
  nextRequest(ledger: Ledger, template: unknown): Record<string, unknown> | null;
  matchesFilter(scope: Scope, filter: unknown): boolean;
  summary(filter: Record<string, unknown>): string;
  conditions(filter: Record<string, unknown>): {label: string; value: string}[];
};
declare global { var HNW_NAVER_LEDGER: typeof api; }
export {};
