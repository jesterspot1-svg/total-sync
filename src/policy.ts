import { type Channel, idPattern, object, parse, decode, encode, SyncError } from './model';

const reserved = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(?:\.|$)/i;
const markdown = /\.(md|canvas|base)$/i;
const pluginId = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/;
const semver = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:[-+][a-zA-Z0-9.-]{1,64})?$/;
export const EXCALIDRAW_ID = 'obsidian-excalidraw-plugin';
export const EXCALIDRAW_PROFILE = 'plugins/' + EXCALIDRAW_ID + '/preferences.json';
export const CALENDAR_PROFILE = 'plugins/calendar/preferences.json';
const core = new Set([
  'hotkeys.json', 'appearance.json', 'app.json', 'core-plugins.json',
  'core-plugins-migration.json', 'daily-notes.json', 'templates.json',
  'graph.json', 'page-preview.json', 'switcher.json', 'backlink.json',
  'outgoing-link.json', 'tag-pane.json', 'word-count.json', 'canvas.json',
]);

export function portablePath(path: string): string {
  const normalized = path.normalize('NFC');
  if (!normalized || normalized.length > 1024) throw new SyncError('path');
  for (const segment of normalized.split('/')) {
    if (!segment || segment.startsWith('.') || segment.length > 240 || /[. ]$/.test(segment)
      || reserved.test(segment) || /[<>:"|?*\\]/.test(segment)
      || Array.from(segment).some(char => {
        const code = char.codePointAt(0) ?? 0;
        return code < 32 || code === 127 || (code >= 0xd800 && code <= 0xdfff);
      })) {
      throw new SyncError('path');
    }
  }
  return normalized;
}

export function pathKey(path: string): string {
  return path.normalize('NFC').toUpperCase();
}

export function safePluginId(value: string): boolean {
  return pluginId.test(value);
}

export function safeVersion(value: string): boolean {
  return semver.test(value);
}

export function inChannel(channel: Channel, path: string): boolean {
  if (portablePath(path) !== path) return false;
  if (channel === 'content') return !/^TotalSync-Recovery(?:\/|$)/i.test(path);
  if (channel === 'shared-state') return path === 'bookmarks.json';
  if (core.has(path) || /^snippets\/[^/]+\.css$/i.test(path)
    || /^themes\/[^/]+\/(?:theme\.css|manifest\.json)$/.test(path)
    || preferenceProjector(path)) return true;
  const inventory = /^inventory\/([^/]+)\.json$/.exec(path);
  return !!inventory?.[1] && idPattern.test(inventory[1]);
}

export function isNote(path: string): boolean {
  return markdown.test(path);
}

const secretKey = /pass(?:word|phrase|wd)?|secret|token|(?:api|private|access|client|encrypt|signing)[\s_-]*key|credential|authorization|cookie|session[_-]?id|webdav|auth[_-]?(?:key|data)|license[_-]?key/i;

function safeJson(value: unknown, depth = 0): boolean {
  if (depth > 40) return false;
  if (Array.isArray(value)) return value.every(item => safeJson(item, depth + 1));
  if (!object(value)) return true;
  return Object.entries(value).every(([key, item]) =>
    !secretKey.test(key) && !['__proto__', 'constructor', 'prototype'].includes(key) && safeJson(item, depth + 1));
}

export function calendarPreferences(value: unknown): Record<string, boolean | string | number> {
  const result: Record<string, boolean | string | number> = {};
  if (!object(value)) return result;
  for (const key of ['showWeekNumber', 'confirmCreate', 'shouldConfirmBeforeCreate', 'showWeeklyNote']) {
    if (typeof value[key] === 'boolean') result[key] = value[key];
  }
  if (Number.isInteger(value.wordsPerDot) && Number(value.wordsPerDot) > 0 && Number(value.wordsPerDot) <= 10000) {
    result.wordsPerDot = Number(value.wordsPerDot);
  }
  if (typeof value.weekStart === 'string' && /^(?:locale|sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/i.test(value.weekStart)) {
    result.weekStart = value.weekStart;
  }
  return result;
}

const drawingToggles = [
  'showTabTitlebarButtons', 'copyLinkToElemenetAnchorTo100', 'copyFrameLinkByName',
  'disableDoubleClickTextEditing', 'embedUseExcalidrawFolder', 'compress', 'decompressForMDView',
  'drawingEmbedPrefixWithFilename', 'useExcalidrawExtension', 'annotatePreserveSize',
  'displayExportedImageIfAvailable', 'previewMatchObsidianTheme', 'overrideObsidianFontSize',
  'isLeftHanded', 'iframeMatchExcalidrawTheme', 'matchTheme', 'matchThemeAlways', 'matchThemeTrigger',
  'penModeDoubleTapEraser', 'penModeSingleFingerPanning', 'penModeCrosshairVisible',
  'renderImageInMarkdownReadingMode', 'renderImageInHoverPreviewForMDNotes', 'renderImageInMarkdownToPDF',
  'allowPinchZoom', 'allowWheelZoom', 'zoomToFitOnOpen', 'zoomToFitOnResize',
  'openInAdjacentPane', 'showSecondOrderLinks', 'focusOnFileTab', 'openInMainWorkspace', 'showLinkBrackets',
  'syncElementLinkWithText', 'parseTODO', 'hoverPreviewWithoutCTRL', 'allowCtrlClick', 'forceWrap',
  'removeTransclusionQuoteSigns', 'exportWithTheme', 'exportWithBackground', 'exportEmbedScene',
  'autoexportSVG', 'autoexportPNG', 'autoExportLightAndDark', 'autoexportExcalidraw', 'embedMarkdownCommentLinks',
  'embedWikiLink', 'embedPlaceholderImage', 'experimentalLivePreview', 'fadeOutExcalidrawMarkup',
  'loadPropertySuggestions', 'fieldSuggester', 'pdfBorderBox', 'pdfFrame', 'pdfGroupPages',
  'pdfLockAfterImport', 'markdownNodeOneClickEditing', 'canvasImmersiveEmbed', 'doubleClickLinkOpenViewMode',
  'showSplashscreen', 'disableContextMenu',
] as const;
const drawingNumbers: Record<string, readonly [number, number]> = {
  autosaveIntervalDesktop: [0, 3_600_000], zoomToFitMaxLevel: [0.01, 100], zoomStep: [0.001, 10],
  zoomMin: [0.001, 100], zoomMax: [0.001, 100], linkOpacity: [0, 1],
  pageTransclusionCharLimit: [0, 100_000], wordWrappingDefault: [0, 10_000],
  pngExportScale: [0.1, 10], exportPaddingSVG: [0, 5_000], pdfScale: [0.01, 100],
  pdfGapSize: [0, 5_000], pdfNumColumns: [1, 200], pdfNumRows: [1, 200],
  pdfImportScale: [0.01, 100], mdSVGwidth: [1, 20_000], mdSVGmaxHeight: [1, 20_000],
};
const drawingModes: Record<string, readonly string[]> = {
  previewImageType: ['PNG', 'SVGIMG', 'SVG'], desktopUIMode: ['tray', 'compact', 'mobile', 'default'],
  defaultMode: ['normal', 'view', 'zen'], defaultPenMode: ['never', 'mobile', 'always'],
  embedType: ['excalidraw', 'PNG', 'SVG'], pdfDirection: ['down', 'right'],
};

export function excalidrawPreferences(value: unknown): Record<string, boolean | string | number> {
  const result: Record<string, boolean | string | number> = {};
  if (!object(value)) return result;
  for (const key of drawingToggles) {
    const field = value[key];
    if (typeof field === 'boolean') result[key] = field;
  }
  for (const [key, [min, max]] of Object.entries(drawingNumbers)) {
    const field = value[key];
    if (typeof field === 'number' && Number.isFinite(field) && field >= min && field <= max) result[key] = field;
  }
  for (const [key, choices] of Object.entries(drawingModes)) {
    const field = value[key];
    if (typeof field === 'string' && choices.includes(field)) result[key] = field;
  }
  for (const key of ['folder', 'cropFolder', 'annotateFolder', 'fontAssetsPath']) {
    const field = value[key];
    if (typeof field !== 'string') continue;
    try {
      if (field === '' || field === portablePath(field)) result[key] = field;
    } catch {
      // Absolute, hidden and platform-specific paths are local preferences.
    }
  }
  for (const key of ['drawingFilenamePrefix', 'drawingFilenameDateTime', 'drawingFilnameEmbedPostfix',
    'cropSuffix', 'cropPrefix', 'annotateSuffix', 'annotatePrefix', 'linkPrefix', 'urlPrefix', 'todo', 'done']) {
    const field = value[key];
    if (typeof field === 'string' && field.length <= 100 && !/[<>:"|?*\\/]/.test(field)
      && Array.from(field).every(char => char.codePointAt(0)! >= 32)) result[key] = field;
  }
  for (const key of ['width', 'height']) {
    const field = value[key];
    if (typeof field === 'string' && /^(?:\d{1,5}(?:\.\d{1,2})?(?:px|%|em|rem|vw|vh)?)?$/.test(field)) result[key] = field;
  }
  return result;
}

export function preferenceProjector(path: string) {
  if (path === CALENDAR_PROFILE) return calendarPreferences;
  if (path === EXCALIDRAW_PROFILE) return excalidrawPreferences;
  return undefined;
}

export function mergePreferences(
  existing: unknown, incoming: unknown, project: typeof calendarPreferences,
): Record<string, unknown> {
  if (!object(existing) || !object(incoming)) throw new SyncError('configuration');
  const approved = project(incoming);
  if (Object.keys(approved).length !== Object.keys(incoming).length) throw new SyncError('configuration');
  const merged = { ...existing };
  for (const key of Object.keys(project(existing))) delete merged[key];
  return { ...merged, ...approved };
}

export function catalogInstallCommand(vault: string, id: string, enable: boolean): string | undefined {
  if (!vault || !safePluginId(id) || id === 'total-sync' || /[\r\n‘’]/.test(vault)) return undefined;
  return "obsidian 'vault=" + vault.replace(/'/g, "''") + "' plugin:install id=" + id + (enable ? ' enable' : '');
}

export function checkPayload(channel: Channel, path: string, bytes: ArrayBuffer): void {
  if (!inChannel(channel, path)) throw new SyncError('path');
  if (channel === 'content') return;
  if (bytes.byteLength > 2 * 1024 * 1024) throw new SyncError('size');
  if (path.toLowerCase().endsWith('.css')) {
    let css: string;
    try {
      css = decode(bytes).replace(/\/\*[\s\S]*?\*\//g, '');
    } catch {
      throw new SyncError('configuration');
    }
    if (/\\|@\s*import|\b(?:url|src|image|(?:-webkit-)?image-set)\s*\(/i.test(css)) {
      throw new SyncError('configuration');
    }
    return;
  }
  const data = parse(bytes);
  if (path.startsWith('inventory/')) {
    if (!Array.isArray(data) || data.length > 5000 || !data.every(row =>
      object(row) && Object.keys(row).length === 3 && typeof row.id === 'string'
      && safePluginId(row.id) && row.id !== 'total-sync' && typeof row.version === 'string'
      && safeVersion(row.version) && typeof row.enabled === 'boolean')) throw new SyncError('configuration');
    return;
  }
  const project = preferenceProjector(path);
  if (project) {
    if (!object(data) || Object.keys(data).length !== Object.keys(project(data)).length
      || (path === EXCALIDRAW_PROFILE && Object.keys(data).length === 0)) {
      throw new SyncError('configuration');
    }
    return;
  }
  if (channel === 'shared-state' && (!object(data) || !Array.isArray(data.items))) {
    throw new SyncError('configuration');
  }
  if ((!object(data) && !Array.isArray(data)) || !safeJson(data)) throw new SyncError('configuration');
}

export function jsonBytes(value: unknown): ArrayBuffer {
  return encode(JSON.stringify(value));
}
