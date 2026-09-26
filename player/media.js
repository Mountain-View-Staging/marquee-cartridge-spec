/**
 * Media for a browser Surface (specification §7).
 *
 * For every file the cartridge names: choose the rendition to fetch (§7.6),
 * fetch it, verify its size and then its SHA-256 against that rendition's own
 * values (§7.2), and hold it in memory. The host renders only what it holds;
 * an item whose file is not held is reported to the engine as a load failure,
 * which skips it. A missing or rejected file never fails the bootstrap.
 *
 * Plain JavaScript, no dependencies. `crypto.subtle` needs a secure context
 * (https, or localhost).
 */

/** Always decodable in a browser (§7.6). HEVC counts only when probed; HEIC is not probed. */
const BROWSER_SAFE = new Set(["h.264", "jpeg", "png", "webp"]);

function probeHevc() {
  try {
    const v = document.createElement("video");
    return ["hvc1.1.6.L93.B0", "hev1.1.6.L93.B0"].some((c) => v.canPlayType(`video/mp4; codecs="${c}"`) !== "");
  } catch {
    return false;
  }
}

export class MediaStore {
  /**
   * @param {object} o
   * @param {string} o.base          the media base, e.g. "../example"
   * @param {string} o.projectCode   the show code, the keyspace root (§7.1)
   * @param {boolean} [o.preferWifi] the device prefers the wifiOptimized rung (§7.6)
   */
  constructor({ base, projectCode, preferWifi = false }) {
    this.base = base;
    this.projectCode = projectCode;
    this.preferWifi = preferWifi;
    this.decodable = new Set(BROWSER_SAFE);
    if (probeHevc()) this.decodable.add("hevc");
    /** fileId → { url, rendition } */
    this.held = new Map();
    /** fileId → { name, reason, kind } */
    this.failures = new Map();
    /** name → Promise<string url>, so a file named twice is fetched once */
    this.byName = new Map();
  }

  /** The URL of the held rendition of a media file, or null when it is not held. */
  urlFor(mediaFileId) {
    return this.held.get(mediaFileId)?.url ?? null;
  }

  heldRendition(mediaFileId) {
    return this.held.get(mediaFileId)?.rendition ?? null;
  }

  /**
   * §7.6 — the rendition to fetch for one media file: the first the browser
   * can decode of webOptimized (a browser ranks it first), wifiOptimized if the
   * device prefers it, the venue master (optimized, else original), original.
   * When nothing offered decodes, keep the manifest's deliverable and say so.
   */
  choose(snapshot, mediaFileId) {
    const offered = snapshot.variants.get(mediaFileId) ?? [];
    const manifest = snapshot.manifest.get(mediaFileId);
    const byKind = (kind) => offered.find((v) => v.kind === kind);
    const order = [byKind("webOptimized")];
    if (this.preferWifi) order.push(byKind("wifiOptimized"));
    order.push(byKind("optimized") ?? byKind("original"), byKind("original"));
    for (const v of order) {
      if (v && v.codec && this.decodable.has(v.codec.toLowerCase())) {
        return { kind: v.kind, fileName: v.fileName, contentType: v.contentType, codec: v.codec, fileSize: v.fileSize, contentHash: v.contentHash, decodable: true };
      }
    }
    if (!manifest) return null;
    return {
      kind: "deliverable",
      fileName: manifest.deliverableFileName,
      contentType: manifest.contentType,
      codec: null,
      fileSize: manifest.fileSize,
      contentHash: manifest.contentHash,
      decodable: false,
      offered: offered.map((v) => `${v.kind} ${v.codec ?? "(no codec)"}`),
    };
  }

  /**
   * Fetch and verify every image and video the cartridge names. Brand files
   * (typefaces, style books) are not media, and this player draws no styled
   * text, so it leaves them alone.
   */
  async sync(snapshot, { onProgress, concurrency = 4 } = {}) {
    const wanted = [];
    for (const [fileId, file] of snapshot.mediaFiles) {
      if (/^(image|video)\//i.test(file.contentType)) wanted.push(fileId);
    }
    let done = 0;
    const queue = wanted.slice();
    const worker = async () => {
      while (queue.length) {
        const fileId = queue.shift();
        await this.fetchOne(snapshot, fileId);
        onProgress?.(++done, wanted.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, wanted.length) }, worker));
    return { held: this.held.size, wanted: wanted.length, failures: [...this.failures.values()] };
  }

  async fetchOne(snapshot, fileId) {
    const rendition = this.choose(snapshot, fileId);
    if (!rendition) {
      this.failures.set(fileId, { fileId, name: `file ${fileId}`, kind: "manifest", reason: "the cartridge names no deliverable for it" });
      return;
    }
    if (!rendition.decodable) {
      console.warn(`[media] file ${fileId}: nothing offered decodes here (${rendition.offered.join(", ")}); keeping ${rendition.fileName}`);
    }
    let url = this.byName.get(rendition.fileName);
    if (!url) {
      url = this.verified(rendition);
      this.byName.set(rendition.fileName, url);
    }
    try {
      this.held.set(fileId, { url: await url, rendition });
      this.failures.delete(fileId);
    } catch (error) {
      this.byName.delete(rendition.fileName); // retried on a later pass
      this.failures.set(fileId, { fileId, name: rendition.fileName, kind: error.kind ?? "fetch", reason: error.message });
      console.warn(`[media] ${rendition.fileName}: ${error.message}`);
    }
  }

  /** §7.2 — size first (a truncated transfer: retry), then the hash (wrong bytes: retrying will not help). */
  async verified(rendition) {
    const url = `${this.base}/${this.projectCode}/${rendition.fileName}`;
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw Object.assign(new Error(`not fetched: HTTP ${response.status}`), { kind: "fetch" });
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length !== rendition.fileSize) {
      throw Object.assign(new Error(`rejected: ${bytes.length} bytes where the cartridge says ${rendition.fileSize}; a truncated transfer, retrying later`), { kind: "size" });
    }
    if (!crypto?.subtle) throw Object.assign(new Error("cannot be verified: SHA-256 needs a secure context (https or localhost)"), { kind: "hash" });
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
    if (`sha256:${hex}` !== rendition.contentHash.toLowerCase()) {
      throw Object.assign(new Error("rejected: these are not the bytes the cartridge names (SHA-256 differs); retrying will not help"), { kind: "hash" });
    }
    return URL.createObjectURL(new Blob([bytes], { type: rendition.contentType }));
  }

  release() {
    for (const { url } of this.held.values()) URL.revokeObjectURL(url);
    this.held.clear();
    this.byName.clear();
  }
}
