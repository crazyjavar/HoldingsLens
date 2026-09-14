import type { RefreshResult } from './types.js';
export declare function getLastRefreshTime(): string | null;
export declare function refreshHoldings(options?: {
    force?: boolean;
}): Promise<RefreshResult>;
