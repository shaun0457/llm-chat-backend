import type { Message } from "./schemas.js";

export type BusEvent =
  | Readonly<{ type: "delta"; text: string }>
  | Readonly<{ type: "terminal"; message: Message }>;

export type BusListener = (event: BusEvent) => void;

/**
 * One generation's text so far plus its live subscribers. `snapshot()` and `subscribe()` are
 * synchronous, so a reader that calls both in one step sees every character exactly once.
 * Publishing never awaits a subscriber, and a subscriber that throws is reported and skipped:
 * it can never fail or slow the generation.
 */
export interface MessageBus {
  append(text: string): void;
  snapshot(): string;
  /** Returns the unsubscribe function; a closed bus accepts no subscribers. */
  subscribe(listener: BusListener): () => void;
  /** Publishes the terminal message, if any, then drops every subscriber. Idempotent. */
  close(terminal?: Message): void;
}

export function createBus(onListenerError: (error: unknown) => void): MessageBus {
  let text = "";
  let closed = false;
  const listeners = new Set<BusListener>();

  const publish = (event: BusEvent): void => {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (error) {
        onListenerError(error);
      }
    }
  };

  return {
    append(delta) {
      if (closed || delta.length === 0) {
        return;
      }
      text += delta;
      publish({ type: "delta", text: delta });
    },
    snapshot: () => text,
    subscribe(listener) {
      if (closed) {
        return () => {};
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close(terminal) {
      if (closed) {
        return;
      }
      closed = true;
      if (terminal !== undefined) {
        publish({ type: "terminal", message: terminal });
      }
      listeners.clear();
    },
  };
}
