/**
 * Session boards (specification §4.7).
 *
 * What a board looks like is a product decision per Surface platform, so the
 * engine does not draw one and does not lay one out. When a board goes on
 * screen, the engine asks an injected board resolver what the board says and
 * how many pages it has, once per RenderItem, so every page agrees on "now".
 * The board lasts duration × pages (§5.8), timed on the show clock.
 *
 * This package ships only a minimal resolver: one page, the set's sessions
 * in start order, each marked past / now / next / later. A host with a real
 * board layout injects its own.
 */

import type { Session, SessionSet, SessionSetEntry, Snapshot } from "./model.js";

export interface BoardContext {
  /** The show clock when the board was chosen. */
  readonly showNow: number;
  /** The venue timezone, for presenting times. */
  readonly timezone: string;
  /** The set's scheduled sessions, sorted by (startTime, id). */
  readonly entries: readonly SessionSetEntry[];
  readonly sessions: ReadonlyMap<number, Session>;
  readonly snapshot: Snapshot;
}

export interface BoardResolution {
  /** What the board says, in whatever shape the host's board view reads. */
  readonly model: unknown;
  /** At least 1. */
  readonly pageCount: number;
  /** The page with the current or next session, 0-based. */
  readonly anchorPage: number;
}

export type BoardResolver = (set: SessionSet, context: BoardContext) => BoardResolution;

export type SessionState = "past" | "now" | "next" | "later";

export interface MinimalBoardSession {
  readonly id: number;
  readonly name: string;
  readonly startTime: number;
  readonly endTime: number;
  readonly room: string | null;
  readonly state: SessionState;
}

export interface MinimalBoardModel {
  readonly title: string;
  readonly timezone: string;
  readonly sessions: readonly MinimalBoardSession[];
}

/** One page: the set's sessions in start order. */
export const minimalBoardResolver: BoardResolver = (set, context) => {
  let nextMarked = false;
  const sessions = context.entries.map((entry): MinimalBoardSession => {
    let state: SessionState;
    if (entry.endTime <= context.showNow) state = "past";
    else if (entry.startTime <= context.showNow) state = "now";
    else if (!nextMarked) {
      nextMarked = true;
      state = "next";
    } else state = "later";
    return Object.freeze({
      id: entry.id,
      name: context.sessions.get(entry.sessionId)?.name ?? "",
      startTime: entry.startTime,
      endTime: entry.endTime,
      room: entry.roomName,
      state,
    });
  });
  const model: MinimalBoardModel = Object.freeze({ title: set.name, timezone: context.timezone, sessions: Object.freeze(sessions) });
  return { model, pageCount: 1, anchorPage: 0 };
};

/**
 * The page on screen `showNow`, for a board whose first frame was at
 * `sinceShow`: pages advance every `pageDuration` seconds of show time from
 * the anchor page, wrapping. The host flips pages from each tick's `showNow`,
 * so the board and a clock drawn on it never disagree.
 */
export function boardPageAt(
  board: { readonly pageCount: number; readonly anchorPage: number; readonly pageDuration: number },
  sinceShow: number,
  showNow: number,
): number {
  const elapsed = Math.max(0, showNow - sinceShow);
  const turned = Math.floor(elapsed / (board.pageDuration * 1000));
  return (board.anchorPage + turned) % Math.max(1, board.pageCount);
}
