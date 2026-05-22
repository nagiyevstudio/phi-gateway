export interface RequestLogEntry {
  timestamp: string;
  method: string;
  url: string;
  statusCode: number;
  clientId: string;
  clientLabel: string;
  durationMs: string;
  ip: string;
  modelAlias?: string;
  upstreamModelKey?: string;
  error?: string;
}

const MAX_LOGS = 100;
const logBuffer: RequestLogEntry[] = [];

export function addRequestLog(entry: RequestLogEntry): void {
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOGS) {
    logBuffer.shift(); // Remove oldest entry
  }
}

export function getRequestLogs(): RequestLogEntry[] {
  // Return logs in reverse chronological order (newest first)
  return [...logBuffer].reverse();
}
