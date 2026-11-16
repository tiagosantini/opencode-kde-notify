/**
 * Notification building and delivery through `notify-send` (D-Bus).
 *
 * The module is pure: process execution is injected, which keeps the tests
 * independent from OpenCode and from the graphical session.
 */

import { DESKTOP_ENTRY } from './desktop.ts';

export type Urgency = 'low' | 'normal' | 'critical';

export interface Notice {
  readonly title: string;
  readonly body: string;
  readonly icon: string;
  readonly urgency: Urgency;
  /** Milliseconds; `0` keeps the bubble sticky on Plasma. */
  readonly expire: number;
}

export const APP_NAME = 'OpenCode';
export const MAX_BODY = 220;

type ExecCallback = (error: Error | null) => void;
export type ExecFile = (command: string, args: readonly string[], callback: ExecCallback) => void;
export type Log = (message: string, error?: unknown) => void;

/** Collapses whitespace and limits the text shown in the bubble. */
export function compact(value: string | undefined, fallback: string): string {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return fallback;
  return text.length > MAX_BODY ? `${text.slice(0, MAX_BODY - 1)}…` : text;
}

export function buildArgs(notice: Notice): string[] {
  return [
    `--app-name=${APP_NAME}`,
    `--icon=${notice.icon}`,
    `--urgency=${notice.urgency}`,
    `--expire-time=${notice.expire}`,
    // Gives Plasma an identity to resolve; otherwise the notification lands in
    // the `@other` bucket, which is excluded from the history by default.
    `--hint=string:desktop-entry:${DESKTOP_ENTRY}`,
    notice.title,
    notice.body,
  ];
}

/** Creates the notification sender; failures never interrupt OpenCode. */
export function createSender(exec: ExecFile, log: Log = () => {}): (notice: Notice) => void {
  return (notice) => {
    exec('notify-send', buildArgs(notice), (error) => {
      if (!error) return;
      if ((error as { code?: string }).code === 'ENOENT') {
        log('[kde-notify] notify-send not found; notification skipped');
        return;
      }
      log(`[kde-notify] notify-send failed: ${error.message}`, error);
    });
  };
}
