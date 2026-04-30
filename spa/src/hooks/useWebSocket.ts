// TODO(§6.4): WebSocket connection with exponential backoff + full jitter.

export interface UseWebSocketOptions {
  url: string;
}

export function useWebSocket(_opts: UseWebSocketOptions) {
  return { connected: false };
}
