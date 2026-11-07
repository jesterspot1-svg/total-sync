import { object } from './model';

// Explicit portable fields. Unknown fields stay on the device, including future credentials.
const fields: Record<string, string> = {
  calendar: 'showWeekNumber confirmCreate shouldConfirmBeforeCreate showWeeklyNote wordsPerDot weekStart weeklyNoteFormat weeklyNoteTemplate weeklyNoteFolder localeOverride',
  dataview: 'renderNullAs taskCompletionTracking taskCompletionUseEmojiShorthand taskCompletionText taskCompletionDateFormat recursiveSubTaskCompletion warnOnEmptyResult refreshEnabled refreshInterval defaultDateFormat defaultDateTimeFormat maxRecursiveRenderDepth tableIdColumnName tableGroupColumnName showResultCount inlineQueryPrefix inlineJsQueryPrefix inlineQueriesInCodeblocks enableInlineDataview prettyRenderInlineFieldsInLivePreview prettyRenderInlineFields dataviewJsKeyword',
  'obsidian-auto-link-title': 'shouldReplaceText shouldUseBetterLink shouldNotReplaceTitle shouldFetchTitleOnPaste shouldFetchTitleOnInsert shouldFetchTitleOnDrop useBetterLink titleCase excludedDomains',
  'obsidian-book-search-plugin': 'folder fileNameFormat frontmatter content useDefaultFrontmatter defaultFrontmatterKeyType templateFile serviceProvider localePreference openPageOnCompletion showCoverImageInSearch enableCoverImageSave enableCoverImageEdgeCurl coverImagePath askForLocale',
  'obsidian-outliner': `styleLists debug stickCursor betterEnter betterVimO betterTab selectAll listLines listLineAction dnd
    stickCursorIntoTheContent stickCursorOutOfTheContent betterLists improveStyleOfLists drawVerticalLines verticalLineClickAction dragAndDrop debugMode`,
  'obsidian-zotero-desktop-connector': 'noteImportFolder pdfExportImageDPI pdfExportImageFormat pdfExportImageQuality citeFormats exportFormats citeSuggestTemplate openNoteAfterImport whichNotesToOpenAfterImport shouldConcat',
  'obsidian42-brat': 'notificationsEnabled selectLatestPluginVersionByDefault',
  'pdf-annotator': 'annotationMarkdownSettings defaultDarkMode useDarkModeDark defaultReadingMode',
  'periodic-notes': 'daily weekly monthly quarterly yearly',
  'remotely-save': '',
  'telegram-sync': 'connectionStatusIndicatorType defaultMessageDelimiter parallelMessageProcessing topicNames',
  'templater-obsidian': 'command_timeout templates_folder auto_jump_to_cursor enable_folder_templates folder_templates enable_file_templates file_templates syntax_highlighting enabled_templates_hotkeys',
  'vk-inbox': 'targetNotePath audioFolder autoSyncIntervalMinutes',
  'zotero-highlights-sync': 'language bookTemplatePath annotationsTemplatePath annotationTemplatePath',
  zotlit: 'logLevel citationEditorSuggester showCitekeyInSuggester literatureNoteFolder template updateAnnotBlock updateOverwrite autoPairEta autoTrim imgExcerptImport imgExcerptPath',
  'obsidian-excalidraw-plugin': `showTabTitlebarButtons copyLinkToElemenetAnchorTo100 copyFrameLinkByName disableDoubleClickTextEditing
    folder cropFolder annotateFolder embedUseExcalidrawFolder templateFilePath fontAssetsPath loadChineseFonts loadJapaneseFonts loadKoreanFonts
    compress decompressForMDView autosave autosaveIntervalDesktop drawingFilenamePrefix drawingEmbedPrefixWithFilename drawingFilnameEmbedPostfix drawingFilenameDateTime useExcalidrawExtension
    cropSuffix cropPrefix annotateSuffix annotatePrefix annotatePreserveSize displaySVGInPreview previewImageType displayExportedImageIfAvailable previewMatchObsidianTheme
    width height overrideObsidianFontSize dynamicStyling isLeftHanded desktopUIMode iframeMatchExcalidrawTheme matchTheme matchThemeAlways matchThemeTrigger defaultMode defaultPenMode
    penModeDoubleTapEraser penModeSingleFingerPanning penModeCrosshairVisible panWithRightMouseButton renderImageInMarkdownReadingMode renderImageInHoverPreviewForMDNotes renderImageInMarkdownToPDF
    allowPinchZoom allowWheelZoom zoomToFitOnOpen zoomToFitOnResize zoomToFitMaxLevel zoomStep zoomMin zoomMax linkPrefix urlPrefix parseTODO todo done hoverPreviewWithoutCTRL linkOpacity
    openInAdjacentPane showSecondOrderLinks focusOnFileTab openInMainWorkspace showLinkBrackets syncElementLinkWithText allowCtrlClick forceWrap pageTransclusionCharLimit wordWrappingDefault removeTransclusionQuoteSigns
    pngExportScale exportWithTheme exportWithBackground exportPaddingSVG exportEmbedScene keepInSync autoexportSVG autoexportPNG autoExportLightAndDark autoexportExcalidraw embedType embedMarkdownCommentLinks embedWikiLink embedPlaceholderImage
    experimentalFileType experimentalFileTag experimentalLivePreview fadeOutExcalidrawMarkup loadPropertySuggestions fieldSuggester customPens numberOfCustomPens
    pdfScale pdfBorderBox pdfFrame pdfGapSize pdfGroupPages pdfLockAfterImport pdfNumColumns pdfNumRows pdfDirection pdfImportScale gridSettings laserSettings embeddableMarkdownDefaults markdownNodeOneClickEditing canvasImmersiveEmbed
    modifierKeyConfig slidingPanesSupport areaZoomLimit longPressDesktop doubleClickLinkOpenViewMode modifierKeyOverrides showSplashscreen pdfSettings disableContextMenu defaultTrayMode mdSVGwidth mdSVGmaxHeight`,
};

const forbidden = /pass(?:word|phrase|wd)?|secret|token|(?:api|private|access|client|encrypt|signing)[_-]?key|credential|authorization|cookie|session|deviceId|__proto__|^constructor$|^prototype$|^\$totalSyncDeleted$/i;
const execution = /script|system.?command|shell|startup|trigger_on|enable.*js|allowHtml|pluginList|themesList|updateAtStartup|enableAfterInstall|allowIncompatible/i;
export type Preference = string | number | boolean | null | Preference[] | { [key: string]: Preference };

export function portableValue(value: unknown, depth = 0): value is Preference {
  if (depth > 15) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length <= 100_000
    && !/^[a-z]:[\\/]|^\\\\|^\/(?:Users|home|mnt|Volumes|usr|opt)\/|^file:|[\u0000-\u0008]/i.test(value)
    && !/https?:\/\/[^/\s]+@|(?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]|(?:^|[/\\])\.\.(?:[/\\]|$)/i.test(value);
  if (Array.isArray(value)) return value.length <= 5000 && value.every(item => portableValue(item, depth + 1));
  return object(value) && Object.keys(value).length <= 1000
    && Object.entries(value).every(([key, child]) => !forbidden.test(key) && portableValue(child, depth + 1));
}

export function safePreferenceKey(key: string): boolean {
  return /^[a-zA-Z0-9_.-]{1,120}$/.test(key) && !forbidden.test(key) && !execution.test(key);
}
export function allowedPreference(id: string, key: string, extra: readonly string[] = []): boolean {
  const preset = Object.prototype.hasOwnProperty.call(fields, id) ? fields[id]! : '';
  return safePreferenceKey(key) && (preset.split(/\s+/).includes(key) || extra.includes(key));
}

export function preferences(id: string, raw: unknown, extra: readonly string[] = []): Record<string, Preference> {
  const result: Record<string, Preference> = {};
  if (!object(raw)) return result;
  for (const [key, value] of Object.entries(raw)) {
    if (allowedPreference(id, key, extra) && portableValue(value)) result[key] = value;
  }
  return result;
}

export function preferencesKnown(id: string): boolean { return Object.prototype.hasOwnProperty.call(fields, id); }

export function needsLocalValue(key: string, value: unknown): boolean {
  const populated = typeof value === 'string' ? value.trim().length > 0 : Array.isArray(value) ? value.length > 0 : false;
  return populated && (/token|secret|password|credential|api.?key|aiProviderProfiles|zoteroDataDir|shell_path|whisperExecutablePath|whisperModelPath/i.test(key)
    || (typeof value === 'string' && /^[a-z]:[\\/]|^\\\\/i.test(value)));
}
