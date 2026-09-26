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
/** One page: the set's sessions in start order. */
export const minimalBoardResolver = (set, context) => {
    let nextMarked = false;
    const sessions = context.entries.map((entry) => {
        let state;
        if (entry.endTime <= context.showNow)
            state = "past";
        else if (entry.startTime <= context.showNow)
            state = "now";
        else if (!nextMarked) {
            nextMarked = true;
            state = "next";
        }
        else
            state = "later";
        return Object.freeze({
            id: entry.id,
            name: context.sessions.get(entry.sessionId)?.name ?? "",
            startTime: entry.startTime,
            endTime: entry.endTime,
            room: entry.roomName,
            state,
        });
    });
    const model = Object.freeze({ title: set.name, timezone: context.timezone, sessions: Object.freeze(sessions) });
    return { model, pageCount: 1, anchorPage: 0 };
};
/**
 * The page on screen `showNow`, for a board whose first frame was at
 * `sinceShow`: pages advance every `pageDuration` seconds of show time from
 * the anchor page, wrapping. The host flips pages from each tick's `showNow`,
 * so the board and a clock drawn on it never disagree.
 */
export function boardPageAt(board, sinceShow, showNow) {
    const elapsed = Math.max(0, showNow - sinceShow);
    const turned = Math.floor(elapsed / (board.pageDuration * 1000));
    return (board.anchorPage + turned) % Math.max(1, board.pageCount);
}
