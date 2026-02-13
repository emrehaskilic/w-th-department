import { createHash } from 'crypto';

export interface SnapshotMetadata {
    eventId: number;
    stateHash: string;
    ts: number;
}

/**
 * Computes a stable SHA256 hash of any object by canonicalizing keys
 */
const sortedKeyCache = new Map<string, string[]>();

function getSortedTopLevelKeys(payload: Record<string, unknown>): string[] {
    const keys = Object.keys(payload);
    const signature = keys.join('\x1f');
    const cached = sortedKeyCache.get(signature);
    if (cached) {
        return cached;
    }
    const sorted = [...keys].sort();
    sortedKeyCache.set(signature, sorted);
    return sorted;
}

export function computeStateHash(payload: any): string {
    const canonical = payload && typeof payload === 'object'
        ? JSON.stringify(payload, getSortedTopLevelKeys(payload as Record<string, unknown>))
        : JSON.stringify(payload);
    return createHash('sha256').update(canonical).digest('hex');
}

export class SnapshotTracker {
    private currentEventId = 0;

    public next(payload: any): SnapshotMetadata {
        this.currentEventId++;
        return {
            eventId: this.currentEventId,
            stateHash: computeStateHash(payload),
            ts: Date.now(),
        };
    }
}
