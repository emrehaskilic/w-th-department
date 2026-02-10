import { createHash } from 'crypto';

export interface SnapshotMetadata {
    eventId: number;
    stateHash: string;
    ts: number;
}

/**
 * Computes a stable SHA256 hash of any object by canonicalizing keys
 */
export function computeStateHash(payload: any): string {
    const canonical = JSON.stringify(payload, Object.keys(payload).sort());
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
