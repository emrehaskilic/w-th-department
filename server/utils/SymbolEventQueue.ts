type Processor = (event: any) => Promise<void>;

export class SymbolEventQueue {
    private queue: any[] = [];
    private processing = false;
    private symbol: string;
    private processor: Processor;

    constructor(symbol: string, processor: Processor) {
        this.symbol = symbol;
        this.processor = processor;
    }

    public enqueue(event: any) {
        this.queue.push(event);
        this.processNext();
    }

    private async processNext() {
        if (this.processing || this.queue.length === 0) return;

        this.processing = true;
        const event = this.queue.shift();

        try {
            await this.processor(event);
        } catch (e) {
            console.error(`[Queue] Error processing ${this.symbol}:`, e);
        } finally {
            this.processing = false;
            // Immediate recurse for next in queue
            setImmediate(() => this.processNext());
        }
    }

    public getQueueLength() {
        return this.queue.length;
    }
}
