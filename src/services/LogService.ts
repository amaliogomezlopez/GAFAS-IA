/**
 * LogService — In-app log capture for debugging pipeline, BLE, and AI issues.
 *
 * Stores logs in memory + AsyncStorage. Accessible from Settings > Logs.
 */
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface LogEntry {
  id: string;
  timestamp: number;
  level: LogLevel;
  tag: string;
  message: string;
}

const STORAGE_KEY = '@smartglasses_logs';
const MAX_LOGS = 1000;
const PERSISTED_LOGS = 500;

let logs: LogEntry[] = [];
let listeners: Array<() => void> = [];
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function notify() {
  listeners.forEach((fn) => fn());
}

function shouldMirrorToConsole(level: LogLevel): boolean {
  if (Platform.OS === 'web') return level === 'warn' || level === 'error';
  return true;
}

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    LogService.persist().catch(() => {});
  }, 650);
}

export const LogService = {
  /** Add a log entry */
  log(level: LogLevel, tag: string, message: string): void {
    const entry: LogEntry = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
      level,
      tag,
      message,
    };
    logs.unshift(entry);
    if (logs.length > MAX_LOGS) logs = logs.slice(0, MAX_LOGS);
    notify();
    schedulePersist();

    // Mirror logs during diagnostics so speech and BLE issues are visible immediately.
    if (shouldMirrorToConsole(level)) {
      const prefix = `[${tag}]`;
      switch (level) {
        case 'error': console.error(prefix, message); break;
        case 'warn': console.warn(prefix, message); break;
        default: console.log(prefix, message); break;
      }
    }
  },

  info(tag: string, msg: string) { this.log('info', tag, msg); },
  warn(tag: string, msg: string) { this.log('warn', tag, msg); },
  error(tag: string, msg: string) { this.log('error', tag, msg); },
  debug(tag: string, msg: string) { this.log('debug', tag, msg); },

  /** Get all logs (newest first) */
  getLogs(): LogEntry[] {
    return logs;
  },

  /** Subscribe to log changes */
  subscribe(fn: () => void): () => void {
    listeners.push(fn);
    return () => { listeners = listeners.filter((f) => f !== fn); };
  },

  /** Persist logs to AsyncStorage */
  async persist(): Promise<void> {
    try {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(logs.slice(0, PERSISTED_LOGS)));
    } catch {}
  },

  /** Load persisted logs */
  async load(): Promise<void> {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        const persisted = JSON.parse(raw);
        if (Array.isArray(persisted)) {
          const merged = new Map<string, LogEntry>();
          [...logs, ...persisted].forEach((entry) => {
            if (entry?.id && typeof entry.timestamp === 'number') {
              merged.set(entry.id, entry);
            }
          });
          logs = Array.from(merged.values())
            .sort((a, b) => b.timestamp - a.timestamp)
            .slice(0, MAX_LOGS);
        }
        notify();
      }
    } catch {}
  },

  /** Clear all logs */
  async clear(): Promise<void> {
    logs = [];
    notify();
    try { await AsyncStorage.removeItem(STORAGE_KEY); } catch {}
  },

  /** Export logs as text */
  exportAsText(): string {
    return logs.map((l) => {
      const d = new Date(l.timestamp);
      const time = d.toLocaleString('es-ES', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
      return `${time} [${l.level.toUpperCase()}] [${l.tag}] ${l.message}`;
    }).join('\n');
  },
};
