/**
 * RenderItem: the engine's complete description of what should be on screen.
 * The host draws it and reports back with its token.
 *
 * The engine names things by id (media item, media file, session set); the
 * host maps a media file to the rendition it holds (§7.6) and draws. A new
 * RenderItem supersedes any earlier one that has not reported its first
 * frame: reports carrying an older token are ignored.
 */
export {};
