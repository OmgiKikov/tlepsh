/**
 * The serve API's event stream: one bounded, restart-ephemeral fan-out of
 * observations the operator's UI needs while a decision is in flight.
 *
 * It obeys the same rules as the Evidence Explorer's live view (invariant 11):
 * the frames are provisional development-only observations, they are never
 * evidence and never a second journal, a subscriber failure can never change
 * execution or durable state, and sealed holdout runs never reach it — the
 * candidate experiment attaches no listener to a sealed arm, so there is
 * nothing here to filter. Run frames arrive already bounded and redacted by
 * the `run-events` seam; nothing else is ever published.
 */

const MAX_FRAMES = 256;
const MAX_TOTAL_BYTES = 512 * 1024;
const MAX_FRAME_BYTES = 24 * 1024;
const MAX_SUBSCRIBERS = 4;

export type ServeEventName =
	| "hello"
	| "workbench-changed"
	| "run-progress"
	| "confirmation-opened"
	| "confirmation-closed"
	| "operation-settled";

export interface ServeEventFrame {
	sequence: number;
	event: ServeEventName;
	data: string;
}

export type ServeEventSubscriber = (frame: ServeEventFrame) => boolean;

export type ServeEventSubscription =
	| { kind: "full" }
	| {
		kind: "subscribed";
		frames: readonly ServeEventFrame[];
		droppedBeforeSequence: number;
		unsubscribe(): void;
	};

export interface ServeEventHub {
	publish(event: ServeEventName, data: unknown): void;
	subscribe(afterSequence: number, subscriber: ServeEventSubscriber): ServeEventSubscription;
	subscriberCount(): number;
	close(): void;
}

function frameBytes(frame: ServeEventFrame): number {
	return Buffer.byteLength(frame.data, "utf8") + 32;
}

export function createServeEventHub(): ServeEventHub {
	const frames: ServeEventFrame[] = [];
	const subscribers = new Set<ServeEventSubscriber>();
	let totalBytes = 0;
	let nextSequence = 1;
	let droppedBeforeSequence = 0;
	let closed = false;

	return {
		publish(event, data): void {
			if (closed) return;
			let serialized: string;
			try {
				serialized = JSON.stringify(data ?? null) ?? "null";
			} catch {
				// An unserializable observation is dropped, never partially emitted.
				return;
			}
			if (Buffer.byteLength(serialized, "utf8") > MAX_FRAME_BYTES) return;
			const frame: ServeEventFrame = { sequence: nextSequence, event, data: serialized };
			nextSequence += 1;
			frames.push(frame);
			totalBytes += frameBytes(frame);
			while (frames.length > MAX_FRAMES || totalBytes > MAX_TOTAL_BYTES) {
				const removed = frames.shift();
				if (!removed) break;
				totalBytes -= frameBytes(removed);
				droppedBeforeSequence = removed.sequence;
			}
			for (const subscriber of [...subscribers]) {
				let keep = false;
				try {
					keep = subscriber(frame);
				} catch {
					keep = false;
				}
				if (!keep) subscribers.delete(subscriber);
			}
		},
		subscribe(afterSequence, subscriber): ServeEventSubscription {
			if (closed) {
				return { kind: "subscribed", frames: [], droppedBeforeSequence, unsubscribe: () => undefined };
			}
			if (subscribers.size >= MAX_SUBSCRIBERS) return { kind: "full" };
			subscribers.add(subscriber);
			return {
				kind: "subscribed",
				frames: frames.filter((frame) => frame.sequence > afterSequence),
				droppedBeforeSequence,
				unsubscribe(): void {
					subscribers.delete(subscriber);
				},
			};
		},
		subscriberCount: () => subscribers.size,
		close(): void {
			closed = true;
			subscribers.clear();
			frames.length = 0;
			totalBytes = 0;
		},
	};
}
