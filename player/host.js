/**
 * A browser host for the Marquee Surface engine.
 *
 * It calls the engine from requestAnimationFrame, draws each RenderItem on a
 * stage element, and reports back with the item's token: the first frame, a
 * video's completion, or a failure. Everything about WHAT is on screen and
 * WHEN is the engine's; this file only knows about pixels.
 *
 * The host frame rules (specification §5.8):
 *   - Hold the previous frame until the next item's first frame is ready. The
 *     next item is built in a hidden layer and revealed only once it can show;
 *     nothing flashes to black between items.
 *   - Clear the stage only for a `blank` item (an authored "show nothing").
 *     An empty working set produces no item, so the last frame simply stays.
 *   - Stop a trimmed video on the last frame before its out-point, found from
 *     the frames the browser actually presents.
 *   - Play video with its sound. Muting is a local device choice. A browser
 *     may refuse sound until someone interacts with the page; then the video
 *     plays muted and the host says so, and sound returns on the first click
 *     or key press.
 */

import { boardPageAt } from "../engine/dist/index.js";

const CSS = `
.mq-stage { position: relative; overflow: hidden; background: #000; }
.mq-layer { position: absolute; inset: 0; background: #000; }
.mq-layer.mq-loading { visibility: hidden; }
.mq-backing { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.mq-content { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; display: block; }
.mq-board { position: absolute; inset: 0; box-sizing: border-box; padding: 6% 7%;
  color: #f0f4f8; font: 500 clamp(12px, 2.6vmin, 40px)/1.35 system-ui, -apple-system, "Segoe UI", sans-serif;
  display: flex; flex-direction: column; gap: 3vmin; }
.mq-board header { display: flex; justify-content: space-between; align-items: baseline; gap: 2vmin;
  border-bottom: 2px solid rgba(240, 244, 248, .35); padding-bottom: 2vmin; }
.mq-board h1 { margin: 0; font-size: 1.9em; font-weight: 700; letter-spacing: .01em; }
.mq-board time { font-variant-numeric: tabular-nums; font-size: 1.3em; opacity: .9; }
.mq-board ol { list-style: none; margin: 0; padding: 0; display: grid; gap: 1.6vmin; }
.mq-board li { display: grid; grid-template-columns: 8.5em 1fr auto; gap: 2vmin; align-items: baseline;
  padding: 1.4vmin 2vmin; border-radius: 1vmin; background: rgba(0, 0, 0, .28); }
.mq-board li.past { opacity: .45; }
.mq-board li.now { background: rgba(63, 185, 80, .30); }
.mq-board li.next { background: rgba(88, 166, 255, .22); }
.mq-board .when { font-variant-numeric: tabular-nums; opacity: .85; }
.mq-board .state { font-size: .75em; text-transform: uppercase; letter-spacing: .08em; opacity: .85; }
.mq-board .page { font-size: .75em; opacity: .7; }
`;

let styled = false;

function once(target, ok, fail = "error") {
  return new Promise((resolve, reject) => {
    const onOk = () => { target.removeEventListener(fail, onFail); resolve(); };
    const onFail = () => { target.removeEventListener(ok, onOk); reject(new Error(mediaError(target))); };
    target.addEventListener(ok, onOk, { once: true });
    target.addEventListener(fail, onFail, { once: true });
  });
}

function mediaError(el) {
  const code = el?.error?.code;
  const names = { 1: "aborted", 2: "network error", 3: "cannot decode", 4: "format not supported" };
  return el?.error ? `media error: ${names[code] ?? code}${el.error.message ? ` (${el.error.message})` : ""}` : "media error";
}

function afterPaint(fn) {
  requestAnimationFrame(() => requestAnimationFrame(fn));
}

export class BrowserHost {
  /**
   * @param {object} o
   * @param {object} o.engine     a Surface engine (createEngine)
   * @param {HTMLElement} o.stage where to draw
   * @param {object} o.media      a MediaStore: urlFor(mediaFileId) → a held URL, or null
   * @param {(event: object) => void} [o.onTrace]            every trace event, as it happens
   * @param {(showNow: number, projected: boolean) => void} [o.onTick]
   * @param {(message: string | null) => void} [o.onNotice] host notices for the operator (sound)
   * @param {boolean} [o.muted]   the device's local mute choice
   */
  constructor({ engine, stage, media, onTrace, onTick, onNotice, muted = false }) {
    this.engine = engine;
    this.stage = stage;
    this.media = media;
    this.onTrace = onTrace;
    this.onTick = onTick;
    this.onNotice = onNotice;
    this.muted = muted;
    this.soundBlocked = false;
    this.soundUnlocked = false;
    this.running = false;
    this.shown = null;   // the job on screen
    this.loading = null; // the job being prepared
    this.clock = null;   // formatter for a board's header clock
    if (!styled) {
      const style = document.createElement("style");
      style.textContent = CSS;
      document.head.append(style);
      styled = true;
    }
    stage.classList.add("mq-stage");
    const unlock = () => {
      this.soundUnlocked = true;
      if (this.soundBlocked) {
        this.soundBlocked = false;
        this.onNotice?.(null);
        const video = this.shown?.video;
        if (video && !this.muted) video.muted = false;
      }
    };
    addEventListener("pointerdown", unlock);
    addEventListener("keydown", unlock);
  }

  start() {
    if (this.running) return;
    this.running = true;
    const frame = () => {
      if (!this.running) return;
      this.tick();
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  /** One pass of the display loop. The engine's output object is reused: read it now. */
  tick() {
    const out = this.engine.tick(Date.now(), performance.now());
    const { showNow, projected, renderItem } = out;
    this.report(out.trace);
    if (renderItem) this.present(renderItem);
    this.paintBoard(showNow);
    this.onTick?.(showNow, projected);
  }

  setMuted(muted) {
    this.muted = muted;
    const video = this.shown?.video;
    if (video) video.muted = this.effectiveMuted();
  }

  effectiveMuted() {
    return this.muted || (this.soundBlocked && !this.soundUnlocked);
  }

  report(events) {
    if (!events || events.length === 0) return;
    for (const event of events) this.onTrace?.(event);
  }

  // ── putting items on screen ─────────────────────────────────────────────────

  present(item) {
    this.abandon();
    if (item.kind === "blank") {
      this.clear();
      return;
    }
    const layer = document.createElement("div");
    layer.className = "mq-layer mq-loading";
    this.stage.append(layer);
    const job = { item, layer, video: null, backingVideo: null, board: null, done: false, cancelled: false };
    this.loading = job;
    this.build(job).then(
      () => { if (!job.cancelled) this.reveal(job); },
      (error) => {
        if (job.cancelled) return;
        this.dispose(job);
        this.loading = null;
        this.report(this.engine.onLoadFailed(item.token, error.message));
      },
    );
  }

  async build(job) {
    const { item } = job;
    if (item.backing) await this.buildBacking(job, item.backing);
    if (item.kind === "sessionBoard") {
      this.buildBoard(job);
      return;
    }
    const url = this.media.urlFor(item.media.mediaFileId);
    if (!url) throw new Error(`file ${item.media.mediaFileId} is not held`);
    if (item.media.isVideo) await this.buildVideo(job, url);
    else await this.buildImage(job, url);
  }

  async buildImage(job, url) {
    const img = new Image();
    img.className = "mq-content";
    img.alt = job.item.name;
    img.src = url;
    await img.decode().catch(() => { throw new Error("the image could not be decoded"); });
    job.layer.append(img);
  }

  async buildVideo(job, url) {
    const { media } = job.item;
    const video = document.createElement("video");
    video.className = "mq-content";
    video.playsInline = true;
    video.preload = "auto";
    video.muted = this.effectiveMuted();
    job.video = video;
    job.layer.append(video);
    const ready = once(video, "loadedmetadata");
    video.src = url;
    await ready;
    if (media.start > 0) {
      const seeked = once(video, "seeked");
      video.currentTime = media.start;
      await seeked;
    } else if (video.readyState < 2) {
      await once(video, "loadeddata");
    }
  }

  async buildBacking(job, backing) {
    const url = this.media.urlFor(backing.mediaFileId);
    if (!url) {
      console.warn(`[host] backing file ${backing.mediaFileId} is not held; drawing without it`);
      return;
    }
    try {
      if (/^video\//i.test(backing.contentType)) {
        const video = document.createElement("video");
        video.className = "mq-backing";
        // A backing loops under the content and never advances the rotation.
        // This host keeps it silent: the content's sound is the one that matters.
        Object.assign(video, { muted: true, loop: true, playsInline: true, preload: "auto" });
        const ready = once(video, "loadeddata");
        video.src = url;
        await ready;
        job.backingVideo = video;
        job.layer.prepend(video);
      } else {
        const img = new Image();
        img.className = "mq-backing";
        img.alt = "";
        img.src = url;
        await img.decode();
        job.layer.prepend(img);
      }
    } catch (error) {
      console.warn(`[host] backing file ${backing.mediaFileId}: ${error.message}; drawing without it`);
    }
  }

  buildBoard(job) {
    const { board, name } = job.item;
    const model = board.model;
    const el = document.createElement("div");
    el.className = "mq-board";
    const header = document.createElement("header");
    const title = document.createElement("h1");
    title.textContent = model?.title ?? name;
    const clock = document.createElement("time");
    header.append(title, clock);
    el.append(header);
    const list = document.createElement("ol");
    const zone = model?.timezone;
    const hm = new Intl.DateTimeFormat("en-GB", { timeZone: zone || "UTC", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    for (const s of model?.sessions ?? []) {
      const li = document.createElement("li");
      li.className = s.state;
      const when = document.createElement("span");
      when.className = "when";
      when.textContent = `${hm.format(s.startTime)}–${hm.format(s.endTime)}`;
      const what = document.createElement("span");
      what.textContent = s.name;
      const state = document.createElement("span");
      state.className = "state";
      state.textContent = s.state === "later" || s.state === "past" ? "" : s.state;
      li.append(when, what, state);
      list.append(li);
    }
    el.append(list);
    const page = document.createElement("div");
    page.className = "page";
    el.append(page);
    job.layer.append(el);
    job.board = { clock, page, zone };
    this.clock = new Intl.DateTimeFormat("en-GB", { timeZone: zone || "UTC", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  }

  /** The board's clock and page come from the same showNow the engine used this tick. */
  paintBoard(showNow) {
    const job = this.shown;
    if (!job?.board) return;
    job.board.clock.textContent = this.clock.format(showNow);
    const { pageCount } = job.item.board;
    if (pageCount > 1) {
      const page = boardPageAt(job.item.board, this.engine.currentSince, showNow);
      job.board.page.textContent = `page ${page + 1} of ${pageCount}`;
    }
  }

  reveal(job) {
    this.loading = null;
    job.layer.classList.remove("mq-loading");
    for (const el of [...this.stage.children]) {
      if (el !== job.layer && el.classList.contains("mq-layer")) this.disposeLayer(el);
    }
    if (this.shown && this.shown !== job) this.shown.done = true;
    this.shown = job;
    job.backingVideo?.play().catch(() => {});
    if (job.video) this.startVideo(job);
    if (job.board) this.paintBoard(this.engine.showNow);
    afterPaint(() => {
      if (this.shown === job && !job.cancelled) this.report(this.engine.onFirstFrame(job.item.token));
    });
  }

  startVideo(job) {
    const { video } = job;
    const { media } = job.item;
    video.addEventListener("ended", () => this.completed(job));
    video.addEventListener("error", () => this.failed(job, mediaError(video)));
    if (media.durationSource === "window" && media.duration !== null) this.stopAt(job, media.start + media.duration);
    video.muted = this.effectiveMuted();
    video.play().catch((error) => {
      if (job.done || job.cancelled) return;
      if (error.name === "NotAllowedError" && !video.muted) {
        this.soundBlocked = true;
        this.onNotice?.("The browser is holding back sound until someone clicks or presses a key here.");
        video.muted = true;
        video.play().catch((again) => this.failed(job, again.message));
      } else if (error.name !== "AbortError") {
        this.failed(job, error.message);
      }
    });
  }

  /**
   * Stop on the last frame before the out-point.
   *
   * The clip's frame duration is learned from the frames the browser reports
   * presenting (media time over frames presented, so it holds even when the
   * callbacks themselves arrive several frames apart). After each presented
   * frame: if the next frame would reach the out-point, pause now; if the next
   * callback might come too late, pause on a timer at the last frame's time.
   */
  stopAt(job, outPoint) {
    const { video } = job;
    let timer = 0;
    const stop = () => {
      clearTimeout(timer);
      if (job.done || job.cancelled) return;
      video.pause();
      this.completed(job);
    };
    const pauseAtLastFrame = (frame) => {
      clearTimeout(timer);
      const wait = ((outPoint - frame - video.currentTime) * 1000) / (video.playbackRate || 1);
      timer = setTimeout(stop, Math.max(0, wait));
    };
    if (typeof video.requestVideoFrameCallback === "function") {
      let lastTime = null;
      let lastCount = 0;
      let frame = null;
      let gap = 0;
      const step = (_now, meta) => {
        if (job.done || job.cancelled) return;
        const t = meta.mediaTime;
        if (lastTime !== null && t > lastTime) {
          const frames = meta.presentedFrames - lastCount;
          if (frames > 0) frame = Math.min(frame ?? Infinity, (t - lastTime) / frames);
          gap = Math.max(gap, t - lastTime);
        }
        lastTime = t;
        lastCount = meta.presentedFrames;
        const f = frame ?? 1 / 30;
        if (t + f >= outPoint - 1e-3) return stop();
        if (t + Math.max(gap, f) + f >= outPoint - 1e-3) pauseAtLastFrame(f);
        video.requestVideoFrameCallback(step);
      };
      video.requestVideoFrameCallback(step);
      return;
    }
    // Without frame callbacks: a timer on the playhead, assuming 30 frames a second.
    video.addEventListener("playing", () => pauseAtLastFrame(1 / 30), { once: true });
  }

  completed(job) {
    if (job.done || job.cancelled) return;
    job.done = true;
    this.report(this.engine.onMediaCompleted(job.item.token));
  }

  failed(job, reason) {
    if (job.done || job.cancelled) return;
    job.done = true;
    this.report(this.engine.onLoadFailed(job.item.token, reason));
  }

  // ── clearing ────────────────────────────────────────────────────────────────

  /** A newer item supersedes one still being prepared. */
  abandon() {
    const job = this.loading;
    if (!job) return;
    job.cancelled = true;
    this.dispose(job);
    this.loading = null;
  }

  /** An authored blank: the only time the stage is cleared. */
  clear() {
    if (this.shown) this.shown.done = true;
    for (const el of [...this.stage.children]) if (el.classList.contains("mq-layer")) this.disposeLayer(el);
    this.shown = null;
  }

  dispose(job) {
    this.disposeLayer(job.layer);
  }

  disposeLayer(layer) {
    for (const video of layer.querySelectorAll("video")) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
    layer.remove();
  }
}
