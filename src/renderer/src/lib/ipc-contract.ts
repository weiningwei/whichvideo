import type { IPC, LibraryEvent } from '@shared/types'

/** IPC JSON is untrusted at runtime; TypeScript's invoke<T> does not check its shape. */
type Guard<T> = (value: unknown) => value is T
type GuardValue<G> = G extends Guard<infer T> ? T : never

const text: Guard<string> = (value): value is string => typeof value === 'string'
const number: Guard<number> = (value): value is number => typeof value === 'number' && Number.isFinite(value)
const boolean: Guard<boolean> = (value): value is boolean => typeof value === 'boolean'
const empty: Guard<void> = (value): value is void => value == null

function oneOf<const T extends readonly string[]>(...values: T): Guard<T[number]> {
  return (value): value is T[number] => typeof value === 'string' && values.includes(value)
}

function nullable<T>(guard: Guard<T>): Guard<T | null> {
  return (value): value is T | null => value === null || guard(value)
}

function optional<T>(guard: Guard<T>): Guard<T | undefined> {
  return (value): value is T | undefined => value === undefined || guard(value)
}

function array<T>(guard: Guard<T>): Guard<T[]> {
  return (value): value is T[] => Array.isArray(value) && value.every(guard)
}

function shape<const S extends Record<string, Guard<unknown>>>(fields: S): Guard<{ [K in keyof S]: GuardValue<S[K]> }> {
  const entries = Object.entries(fields)
  return (value): value is { [K in keyof S]: GuardValue<S[K]> } =>
    value !== null && typeof value === 'object' && !Array.isArray(value) &&
    entries.every(([key, guard]) => guard((value as Record<string, unknown>)[key]))
}

const video = shape({
  id: number, path: text, pathKey: text, name: text, dir: text, ext: text,
  size: number, mtimeMs: number, duration: nullable(number), width: nullable(number),
  height: nullable(number), videoCodec: nullable(text), frameCount: number,
  status: oneOf('pending', 'indexing', 'ready', 'failed'), error: nullable(text),
  addedAt: number, indexedAt: nullable(number), folderId: nullable(number),
  processedTimestamps: array(number), samplingOverride: nullable(oneOf('uniform', 'scene')),
  processedMs: number, fileHash: nullable(text)
})
const folder = shape({
  id: number, path: text, pathKey: text, name: text, pinned: boolean,
  enabled: boolean, recursive: boolean, watchState: oneOf('watching', 'idle', 'missing', 'error'),
  message: nullable(text), addedAt: number, lastScanAt: nullable(number)
})
const stats = shape({
  videos: number, indexedVideos: number, pendingVideos: number, failedVideos: number,
  frames: number, totalBytes: number, folders: number, watching: number
})
const status = shape({
  running: boolean, active: number, queued: number, total: number, done: number,
  failed: number, currentPath: nullable(text), startedAt: nullable(number),
  finishedAt: nullable(number), lastError: nullable(text)
})
const settings = shape({
  framesPerVideo: number, uniformIntervalSeconds: number, concurrency: number, minHashScore: number, maxResults: number,
  awaitWriteMs: number, pruneOnDelete: boolean, samplingMode: oneOf('uniform', 'scene'),
  updateCheck: boolean, keepFrameImages: boolean
})
const importResult = shape({
  added: number, duplicates: number, skipped: number, failed: number,
  scanned: number, folders: number, firstError: optional(text),
  failures: array(shape({ path: text, reason: text, folderId: nullable(number) }))
})
const mediaTools = shape({
  ready: boolean, source: oneOf('environment', 'configured', 'path', 'system', 'development', 'missing'),
  directory: nullable(text), configuredDirectory: nullable(text), ffmpeg: nullable(text), ffprobe: nullable(text), message: text
})
const frameProgress = shape({
  videoId: number, done: number, total: number, phase: optional(oneOf('detecting', 'extracting'))
})
const searchMatch = shape({
  video, score: number, hashScore: number, colorScore: number,
  timeSeconds: number, frameIndex: number, hashDistance: number
})
const searchResponse = shape({
  query: shape({ width: number, height: number, colorScoreHint: number }),
  matchCount: number, comparedFrames: number, elapsedMs: number, found: boolean,
  matches: array(searchMatch), error: optional(text),
  errorCode: optional(oneOf('invalid-input', 'unsupported-protocol', 'http-error', 'timeout',
    'too-large', 'too-many-redirects', 'network', 'no-image', 'decode-failed', 'internal')),
  queryImageUrl: optional(text)
})

/** Every command must declare a response guard here; adding an IPC channel without one fails typecheck. */
export const responses = {
  library_stats: stats,
  library_status: status,
  library_settings: settings,
  library_data_dir: shape({ dir: text, source: oneOf('env', 'install'), toolsReady: boolean }),
  library_media_tools: mediaTools,
  library_refresh_media_tools: mediaTools,
  library_select_media_tools_dir: mediaTools,
  library_clear_media_tools_dir: mediaTools,
  library_open_ffmpeg_download: empty,
  library_update_settings: settings,
  library_open_database_folder: text,
  library_export_diagnostics: nullable(text),
  library_reset: empty,
  folders_list: array(folder),
  folders_add_dialog: array(folder),
  folders_add_path: folder,
  folders_remove: empty,
  folders_rescan: importResult,
  folders_set_enabled: folder,
  videos_list: shape({ total: number, items: array(video) }),
  videos_get: nullable(video),
  videos_remove: empty,
  videos_remove_many: empty,
  videos_reindex: shape({ count: number }),
  videos_find_duplicates: array(shape({
    videoA: video, videoB: video, score: number, hashScore: number, colorScore: number,
    timeSeconds: number, identicalFile: boolean
  })),
  videos_import: importResult,
  videos_import_paths: importResult,
  videos_import_folder_once: importResult,
  videos_import_images: array(text),
  videos_open: empty,
  videos_reveal: empty,
  videos_thumbnail: nullable(text),
  videos_frame_progress: nullable(frameProgress),
  videos_frame_manifest: array(shape({ frameIndex: number, timeMs: number })),
  videos_match_frame: nullable(text),
  search_path: searchResponse,
  search_data_url: searchResponse,
  search_clipboard: nullable(shape({ dataUrl: text, response: searchResponse })),
  search_url: searchResponse
} satisfies Record<Exclude<(typeof IPC)[keyof typeof IPC], typeof IPC['eventChannel']>, Guard<unknown>>

export function decodeResponse<K extends keyof typeof responses>(command: K, value: unknown): GuardValue<(typeof responses)[K]> {
  const guard = responses[command]
  if (!guard(value)) throw new Error(`后端返回数据不符合约定：${command}`)
  return value as GuardValue<(typeof responses)[K]>
}

const eventGuards = {
  status: shape({ status }),
  'video-updated': shape({ video }),
  'video-removed': shape({ videoId: number, path: text }),
  'folder-updated': shape({ folder }),
  'folder-removed': shape({ folderId: number }),
  stats: shape({ stats }),
  notice: shape({ level: oneOf('info', 'warn', 'error'), message: text }),
  'settings-updated': shape({ settings }),
  'duplicate-scan-progress': shape({ done: number, total: number }),
  'import-progress': shape({
    id: number, processed: number, total: number, added: number,
    skipped: number, failed: number, finished: boolean
  })
} satisfies Record<LibraryEvent['type'], Guard<unknown>>

export function decodeEvent(value: unknown): LibraryEvent {
  if (value === null || typeof value !== 'object' || !('type' in value)) {
    throw new Error('后端事件缺少 type')
  }
  const type = value.type
  if (typeof type !== 'string' || !(type in eventGuards)) {
    throw new Error(`未知后端事件：${String(type)}`)
  }
  const guard = eventGuards[type as keyof typeof eventGuards]
  if (!guard(value)) throw new Error(`后端事件数据不符合约定：${type}`)
  return value as LibraryEvent
}
