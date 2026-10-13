'use strict';

const SIDES = ['left', 'right'];
const VIDEO_EXTENSIONS = new Set([
  'mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'hevc', 'h265', 'av1',
  'ts', 'm2ts', 'mts', 'mpg', 'mpeg', 'ogv',
]);
const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'tif', 'tiff',
]);

const SYNC_SAMPLE_INTERVAL_MS = 50;
const UI_UPDATE_INTERVAL_MS = 250;
const SINGLE_VIDEO_CONTROLLER_INTERVAL_MS = 250;
const FRAME_SAMPLE_MAX_AGE_MS = 300;
const MIN_SYNC_DEADBAND_SECONDS = 0.004;
const MAX_SYNC_DEADBAND_SECONDS = 0.020;
const MIN_HOLD_THRESHOLD_SECONDS = 0.012;
const MAX_HOLD_THRESHOLD_SECONDS = 0.050;
const MIN_HARD_SYNC_SECONDS = 0.100;
const MAX_HARD_SYNC_SECONDS = 0.300;
const MAX_RATE_CORRECTION = 0.020;
const RATE_UPDATE_INTERVAL_MS = 400;
const HARD_DRIFT_SAMPLE_COUNT = 8;
const HARD_SYNC_COOLDOWN_MS = 5000;
const CLOCK_HOLD_TIMEOUT_MS = 900;
const BUFFER_HOLD_DELAY_MS = 90;
const BUFFER_RECOVERY_DELAY_MS = 120;
const DRIFT_HISTORY_SIZE = 7;
const TIMELINE_STEPS = 1000;
const FULLSCREEN_CONTROLS_IDLE_MS = 3000;
const FULLSCREEN_REVEAL_ZONE_PX = 120;
const FULLSCREEN_POINTER_LEAVE_GRACE_MS = 250;
const FULLSCREEN_CURSOR_IDLE_MS = 3000;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 8;
const WHEEL_ZOOM_PER_NOTCH = 1.1;
const VERTICAL_SPLIT_DEFAULT_ZOOM = 1.22;

const dom = {
  comparison: document.querySelector('#comparison'),
  filePicker: document.querySelector('#filePicker'),
  clearButton: document.querySelector('#clearButton'),
  playButton: document.querySelector('#playButton'),
  playIcon: document.querySelector('#playIcon'),
  playLabel: document.querySelector('#playLabel'),
  stepBackButton: document.querySelector('#stepBackButton'),
  stepForwardButton: document.querySelector('#stepForwardButton'),
  timeline: document.querySelector('#timeline'),
  timeOutput: document.querySelector('#timeOutput'),
  rateSelect: document.querySelector('#rateSelect'),
  loopToggle: document.querySelector('#loopToggle'),
  muteButton: document.querySelector('#muteButton'),
  audioSourceSelect: document.querySelector('#audioSourceSelect'),
  leftAudioOption: document.querySelector('#leftAudioOption'),
  rightAudioOption: document.querySelector('#rightAudioOption'),
  volumeSlider: document.querySelector('#volumeSlider'),
  volumeOutput: document.querySelector('#volumeOutput'),
  splitModeButton: document.querySelector('#splitModeButton'),
  overlapModeButton: document.querySelector('#overlapModeButton'),
  singleModeButton: document.querySelector('#singleModeButton'),
  horizontalLayoutButton: document.querySelector('#horizontalLayoutButton'),
  verticalLayoutButton: document.querySelector('#verticalLayoutButton'),
  zoomResetButton: document.querySelector('#zoomResetButton'),
  zoomOutput: document.querySelector('#zoomOutput'),
  statsButton: document.querySelector('#statsButton'),
  helpButton: document.querySelector('#helpButton'),
  wipeDivider: document.querySelector('#wipeDivider'),
  dropZone: document.querySelector('#dropZone'),
  statusText: document.querySelector('#statusText'),
  syncText: document.querySelector('#syncText'),
  toast: document.querySelector('#toast'),
};

function createSlot(side) {
  return {
    side,
    root: document.querySelector(`.media-pane[data-side="${side}"]`),
    stage: document.querySelector(`.media-pane[data-side="${side}"] .media-stage`),
    video: document.querySelector(`#${side}Video`),
    image: document.querySelector(`#${side}Image`),
    empty: document.querySelector(`#${side}Empty`),
    badges: document.querySelector(`#${side}Badges`),
    stats: document.querySelector(`#${side}Stats`),
    title: document.querySelector(`#${side}Title`),
    summary: document.querySelector(`#${side}Summary`),
    metadata: document.querySelector(`#${side}Metadata`),
    file: null,
    objectUrl: null,
    kind: null,
    aspectRatio: 0,
    aspectFamily: 'unknown',
    probe: null,
    capability: null,
    ready: false,
    actualFps: 0,
    frameCounter: 0,
    frameWindowStartedAt: performance.now(),
    lastPresentedFrames: 0,
    lastDroppedFrames: 0,
    lastQualityFrames: 0,
    lastQualitySampleAt: performance.now(),
    frameCallbackId: null,
    latestFrame: null,
    buffering: false,
    bufferTimer: null,
    videoClickTimer: null,
    syncHeld: false,
    loadGeneration: 0,
  };
}

const slots = {
  left: createSlot('left'),
  right: createSlot('right'),
};

const state = {
  nextSide: 'left',
  playing: false,
  seeking: false,
  mode: 'split',
  singleSide: 'right',
  layout: 'horizontal',
  dividerPercent: 50,
  playbackRate: 1,
  audioMuted: false,
  audioSource: 'right',
  preferredAudioSource: 'right',
  volume: 1,
  zoom: 1,
  statsVisible: false,
  syncTimerId: null,
  syncTickRunning: false,
  lastUiUpdateAt: 0,
  lastRateAdjustmentAt: 0,
  lastHardSyncAt: 0,
  driftSeconds: 0,
  filteredDriftSeconds: 0,
  driftHistory: [],
  hardDriftSamples: 0,
  unexpectedPauseSamples: 0,
  clockHoldSide: null,
  clockHoldStartedAt: 0,
  resyncInProgress: false,
  resyncCount: 0,
  loopCount: 0,
  bufferHoldActive: false,
  bufferRecoveryTimer: null,
  synchronizationGeneration: 0,
  lastSyncReason: 'idle',
  pendingSyncLabel: 'Sync idle',
  runtimeInfo: null,
  borderlessFullscreen: false,
  removeFullscreenListener: null,
  performanceWarningShown: false,
  toastTimer: null,
  dividerRaf: null,
  fullscreenControlsTimer: null,
  fullscreenCursorTimer: null,
  fullscreenPointerNearBottom: false,
  lastFullscreenKeyboardActivityAt: Number.NEGATIVE_INFINITY,
};

function extensionOf(fileName) {
  const dot = fileName.lastIndexOf('.');
  return dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : '';
}

function classifyFile(file) {
  if (file.type.startsWith('video/')) {
    return 'video';
  }
  if (file.type.startsWith('image/')) {
    return 'image';
  }

  const extension = extensionOf(file.name);
  if (VIDEO_EXTENSIONS.has(extension)) {
    return 'video';
  }
  if (IMAGE_EXTENSIONS.has(extension)) {
    return 'image';
  }
  return null;
}

function escapeText(value) {
  return String(value ?? '');
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function classifyAspectRatio(ratio) {
  const commonRatios = [
    [1, 'square'],
    [4 / 3, 'standard'],
    [3 / 2, 'classic-wide'],
    [16 / 10, 'widescreen'],
    [16 / 9, 'widescreen'],
    [1.85, 'cinema-wide'],
    [2, 'wide'],
    [21 / 9, 'ultrawide'],
    [2.39, 'ultrawide'],
  ];
  const common = commonRatios.find(([value]) => Math.abs(ratio - value) / value <= 0.025);
  if (common) {
    return common[1];
  }
  if (ratio < 1) {
    return 'portrait';
  }
  return ratio > 2 ? 'ultrawide' : 'custom-wide';
}

function updateSlotAspectRatio(slot, width, height) {
  const safeWidth = Number(width);
  const safeHeight = Number(height);
  if (
    !Number.isFinite(safeWidth)
    || !Number.isFinite(safeHeight)
    || safeWidth <= 0
    || safeHeight <= 0
  ) {
    return;
  }

  slot.aspectRatio = safeWidth / safeHeight;
  slot.aspectFamily = classifyAspectRatio(slot.aspectRatio);
  slot.root.style.setProperty('--media-aspect-ratio', slot.aspectRatio.toFixed(8));
  slot.root.dataset.aspectFamily = slot.aspectFamily;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    seconds = 0;
  }
  const milliseconds = Math.floor((seconds % 1) * 1000);
  const totalSeconds = Math.floor(seconds);
  const secs = totalSeconds % 60;
  const mins = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);

  const base = hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

  return `${base}.${String(milliseconds).padStart(3, '0')}`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '—';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** index)).toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
}

function formatBitrate(bitsPerSecond) {
  if (!Number.isFinite(bitsPerSecond) || bitsPerSecond <= 0) {
    return '—';
  }
  if (bitsPerSecond >= 1_000_000_000) {
    return `${(bitsPerSecond / 1_000_000_000).toFixed(2)} Gbps`;
  }
  if (bitsPerSecond >= 1_000_000) {
    return `${(bitsPerSecond / 1_000_000).toFixed(2)} Mbps`;
  }
  return `${(bitsPerSecond / 1_000).toFixed(0)} Kbps`;
}

function codecLabel(codecName) {
  const labels = {
    h264: 'H.264 / AVC',
    hevc: 'H.265 / HEVC',
    av1: 'AV1',
    vp9: 'VP9',
    vp8: 'VP8',
    prores: 'Apple ProRes',
    mpeg4: 'MPEG-4 Part 2',
    theora: 'Theora',
  };
  return labels[codecName] || String(codecName || 'Unknown').toUpperCase();
}

function setStatus(message) {
  dom.statusText.textContent = message;
}

function showToast(message) {
  window.clearTimeout(state.toastTimer);
  dom.toast.textContent = message;
  dom.toast.hidden = false;
  state.toastTimer = window.setTimeout(() => {
    dom.toast.hidden = true;
  }, 6000);
}


function hideFullscreenControls() {
  state.fullscreenControlsTimer = null;
  if (!state.borderlessFullscreen) {
    return;
  }
  document.documentElement.classList.add('fullscreen-controls-hidden');
}

function scheduleFullscreenControlsHide(delayMs = FULLSCREEN_CONTROLS_IDLE_MS) {
  window.clearTimeout(state.fullscreenControlsTimer);
  state.fullscreenControlsTimer = window.setTimeout(
    hideFullscreenControls,
    Math.max(0, delayMs)
  );
}

function hideFullscreenCursor() {
  state.fullscreenCursorTimer = null;
  if (
    state.borderlessFullscreen
    && state.playing
    && !state.fullscreenPointerNearBottom
  ) {
    document.documentElement.classList.add('fullscreen-cursor-hidden');
  }
}

function showFullscreenCursorAndArmAutoHide() {
  document.documentElement.classList.remove('fullscreen-cursor-hidden');
  window.clearTimeout(state.fullscreenCursorTimer);
  state.fullscreenCursorTimer = null;

  if (state.borderlessFullscreen && state.playing) {
    state.fullscreenCursorTimer = window.setTimeout(
      hideFullscreenCursor,
      FULLSCREEN_CURSOR_IDLE_MS
    );
  }
}

function updateFullscreenCursorAutoHide() {
  if (state.borderlessFullscreen && state.playing) {
    showFullscreenCursorAndArmAutoHide();
    return;
  }

  window.clearTimeout(state.fullscreenCursorTimer);
  state.fullscreenCursorTimer = null;
  document.documentElement.classList.remove('fullscreen-cursor-hidden');
}

function hideFullscreenControlsFromScreenClick() {
  if (!state.borderlessFullscreen) {
    return;
  }
  window.clearTimeout(state.fullscreenControlsTimer);
  hideFullscreenControls();
}

function showFullscreenControls({ autoHide = true } = {}) {
  if (!state.borderlessFullscreen) {
    return;
  }

  document.documentElement.classList.remove('fullscreen-controls-hidden');
  window.clearTimeout(state.fullscreenControlsTimer);
  state.fullscreenControlsTimer = null;
  if (autoHide) {
    scheduleFullscreenControlsHide();
  }
}

function pointerClientY(event) {
  if (Number.isFinite(event.clientY)) {
    return event.clientY;
  }
  const touch = event.touches?.[0] || event.changedTouches?.[0];
  return Number.isFinite(touch?.clientY) ? touch.clientY : null;
}

function handleFullscreenPointerActivity(event) {
  if (!state.borderlessFullscreen) {
    return;
  }

  showFullscreenCursorAndArmAutoHide();
  const clientY = pointerClientY(event);
  if (clientY === null) {
    return;
  }

  const nearBottom = clientY >= window.innerHeight - FULLSCREEN_REVEAL_ZONE_PX;
  const wasNearBottom = state.fullscreenPointerNearBottom;
  const isTouch = event.pointerType === 'touch' || event.type.startsWith('touch');
  state.fullscreenPointerNearBottom = nearBottom && !isTouch;

  if (nearBottom) {
    showFullscreenControls({ autoHide: isTouch });
    return;
  }

  if (wasNearBottom) {
    const keyboardTimeRemaining = Math.max(
      0,
      FULLSCREEN_CONTROLS_IDLE_MS
        - (performance.now() - state.lastFullscreenKeyboardActivityAt)
    );
    scheduleFullscreenControlsHide(
      Math.max(FULLSCREEN_POINTER_LEAVE_GRACE_MS, keyboardTimeRemaining)
    );
  }
}

function applyBorderlessFullscreenState(active) {
  const fullscreen = Boolean(active);
  state.borderlessFullscreen = fullscreen;
  document.documentElement.classList.toggle('borderless-fullscreen', fullscreen);
  document.body.classList.toggle('borderless-fullscreen', fullscreen);
  window.clearTimeout(state.fullscreenControlsTimer);
  state.fullscreenControlsTimer = null;
  window.clearTimeout(state.fullscreenCursorTimer);
  state.fullscreenCursorTimer = null;
  state.fullscreenPointerNearBottom = false;
  state.lastFullscreenKeyboardActivityAt = Number.NEGATIVE_INFINITY;

  if (fullscreen) {
    showFullscreenControls();
  } else {
    document.documentElement.classList.remove('fullscreen-controls-hidden');
  }
  updateFullscreenCursorAutoHide();

  dom.comparison.setAttribute('aria-label', fullscreen
    ? 'Borderless fullscreen media comparison area'
    : 'Media comparison area');
}

async function toggleBorderlessFullscreen() {
  try {
    const active = await window.desktopApi.toggleBorderlessFullscreen();
    applyBorderlessFullscreenState(active);
  } catch (error) {
    console.error('Borderless fullscreen could not be toggled:', error);
    showToast('Borderless fullscreen could not be toggled.');
  }
}

async function initializeBorderlessFullscreen() {
  state.removeFullscreenListener = window.desktopApi.onBorderlessFullscreenChanged(
    applyBorderlessFullscreenState
  );

  try {
    const active = await window.desktopApi.getBorderlessFullscreenState();
    applyBorderlessFullscreenState(active);
  } catch (error) {
    console.warn('Initial fullscreen state is unavailable:', error);
  }
}

function addChip(container, label, tone = 'neutral') {
  const chip = document.createElement('span');
  chip.className = `chip chip-${tone}`;
  chip.textContent = label;
  container.append(chip);
}

function setMetadata(container, entries) {
  container.replaceChildren();
  for (const [label, value] of entries) {
    const wrapper = document.createElement('dl');
    wrapper.className = 'metadata-item';

    const term = document.createElement('dt');
    term.textContent = label;

    const definition = document.createElement('dd');
    definition.textContent = value || '—';

    wrapper.append(term, definition);
    container.append(wrapper);
  }
  container.hidden = entries.length === 0;
}

function getLoadedVideos() {
  return SIDES
    .map((side) => slots[side])
    .filter((slot) => slot.kind === 'video' && slot.file);
}

function getMasterSlot() {
  const videos = getLoadedVideos();
  return videos[0] || null;
}

function getSlaveSlot(master) {
  return getLoadedVideos().find((slot) => slot !== master) || null;
}

function slotTimelineStart(slot) {
  try {
    if (slot.video.seekable.length > 0) {
      const start = slot.video.seekable.start(0);
      if (Number.isFinite(start) && start >= 0) {
        return start;
      }
    }
  } catch (error) {
    console.debug('Media timeline start is not available yet:', error);
  }
  return 0;
}

function comparisonTimeForSlot(slot, mediaTime = slot.video.currentTime || 0) {
  return Math.max(0, mediaTime - slotTimelineStart(slot));
}

function mediaTimeForComparison(slot, comparisonTime) {
  return slotTimelineStart(slot) + Math.max(0, comparisonTime);
}

function comparisonDuration() {
  const videos = getLoadedVideos();
  const durations = videos
    .map((slot) => {
      const duration = slot.video.duration;
      return Number.isFinite(duration)
        ? Math.max(0, duration - slotTimelineStart(slot))
        : 0;
    })
    .filter((duration) => duration > 0);

  if (durations.length === 0) {
    return 0;
  }
  return durations.length > 1 ? Math.min(...durations) : durations[0];
}

function currentComparisonTime() {
  const master = getMasterSlot();
  return master ? comparisonTimeForSlot(master) : 0;
}

function updateTransportAvailability() {
  const videos = getLoadedVideos();
  const enabled = videos.length > 0;

  dom.playButton.disabled = !enabled;
  dom.stepBackButton.disabled = !enabled;
  dom.stepForwardButton.disabled = !enabled;
  dom.timeline.disabled = !enabled || comparisonDuration() <= 0;
  dom.clearButton.disabled = !SIDES.some((side) => slots[side].file);
  updateAudioAvailability();

  if (!enabled && state.playing) {
    pausePlayback();
  }
}

function applyAudioState() {
  for (const side of SIDES) {
    const slot = slots[side];
    slot.video.volume = state.volume;
    slot.video.muted = state.audioMuted || side !== state.audioSource;
  }

  dom.muteButton.textContent = state.audioMuted ? 'Audio off' : 'Audio on';
  dom.muteButton.setAttribute('aria-pressed', String(state.audioMuted));
  dom.muteButton.title = state.audioMuted ? 'Enable audio (M)' : 'Mute audio (M)';
  dom.audioSourceSelect.value = state.audioSource;
  dom.volumeSlider.value = String(Math.round(state.volume * 100));
  dom.volumeOutput.textContent = `${Math.round(state.volume * 100)}%`;
}

function updateAudioAvailability() {
  const loadedSides = SIDES.filter((side) => (
    slots[side].kind === 'video' && slots[side].file
  ));
  const enabled = loadedSides.length > 0;

  dom.leftAudioOption.disabled = !loadedSides.includes('left');
  dom.rightAudioOption.disabled = !loadedSides.includes('right');
  dom.muteButton.disabled = !enabled;
  dom.audioSourceSelect.disabled = !enabled;
  dom.volumeSlider.disabled = !enabled;

  if (enabled) {
    state.audioSource = loadedSides.includes(state.preferredAudioSource)
      ? state.preferredAudioSource
      : loadedSides[0];
  }
  applyAudioState();
}

function toggleAudioMuted() {
  if (getLoadedVideos().length === 0) {
    return;
  }
  state.audioMuted = !state.audioMuted;
  applyAudioState();
  setStatus(state.audioMuted
    ? 'Audio muted.'
    : `${state.audioSource === 'left' ? 'Left' : 'Right'} audio enabled.`);
}

function setZoom(zoom) {
  state.zoom = clamp(Number(zoom) || 1, MIN_ZOOM, MAX_ZOOM);
  const zoomed = Math.abs(state.zoom - 1) > 0.0001;
  const zoomPercent = Math.round(state.zoom * 100);

  dom.comparison.style.setProperty('--video-zoom', state.zoom.toFixed(4));
  dom.comparison.classList.toggle('zoom-active', zoomed);
  dom.zoomOutput.textContent = `${zoomPercent}%`;
  dom.zoomResetButton.classList.toggle('button-primary', zoomed);
  dom.zoomResetButton.setAttribute(
    'aria-label',
    `Reset synchronized video zoom, currently ${zoomPercent} percent`
  );
}

function defaultZoomForView() {
  return state.mode === 'split' && state.layout === 'vertical'
    ? VERTICAL_SPLIT_DEFAULT_ZOOM
    : 1;
}

function resetZoomToViewDefault() {
  setZoom(defaultZoomForView());
}

function handleMediaZoomWheel(event) {
  event.preventDefault();
  const normalizedDelta = clamp(event.deltaY, -100, 100);
  const zoomFactor = WHEEL_ZOOM_PER_NOTCH ** (-normalizedDelta / 100);
  setZoom(state.zoom * zoomFactor);
  setStatus(`Synchronized video zoom: ${Math.round(state.zoom * 100)}%.`);
}

function updatePlayButton() {
  dom.playIcon.textContent = state.playing ? 'Ⅱ' : '▶';
  dom.playLabel.textContent = state.playing ? 'Pause' : 'Play';
  document.documentElement.classList.toggle('playback-active', state.playing);
  updateFullscreenCursorAutoHide();
}

function updateTimeline(force = false) {
  const now = performance.now();
  if (!force && now - state.lastUiUpdateAt < UI_UPDATE_INTERVAL_MS) {
    return;
  }

  const duration = comparisonDuration();
  const current = clamp(currentComparisonTime(), 0, duration || 0);
  if (!state.seeking) {
    dom.timeline.value = duration > 0
      ? String(Math.round((current / duration) * TIMELINE_STEPS))
      : '0';
  }
  dom.timeOutput.textContent = `${formatTime(current)} / ${formatTime(duration)}`;
  state.lastUiUpdateAt = now;
}

function resetSyncTracking(reason = 'aligned') {
  state.driftSeconds = 0;
  state.filteredDriftSeconds = 0;
  state.driftHistory.length = 0;
  state.hardDriftSamples = 0;
  state.unexpectedPauseSamples = 0;
  state.clockHoldSide = null;
  state.clockHoldStartedAt = 0;
  state.lastSyncReason = reason;
  state.lastRateAdjustmentAt = 0;

  for (const slot of getLoadedVideos()) {
    slot.latestFrame = null;
    slot.syncHeld = false;
    slot.video.playbackRate = state.playbackRate;
  }
}

function seekAll(seconds) {
  const duration = comparisonDuration();
  const target = clamp(seconds, 0, duration || 0);

  for (const slot of getLoadedVideos()) {
    if (Number.isFinite(slot.video.duration)) {
      slot.latestFrame = null;
      const mediaTarget = mediaTimeForComparison(slot, target);
      slot.video.currentTime = clamp(
        mediaTarget,
        slotTimelineStart(slot),
        slot.video.duration
      );
    }
  }

  resetSyncTracking('seek');
  updateTimeline(true);
}

function frameDurationSeconds() {
  const master = getMasterSlot();
  const fps = master?.probe?.video?.frameRate || master?.actualFps || 30;
  return 1 / clamp(fps, 1, 240);
}

function stepFrame(direction) {
  if (state.playing) {
    pausePlayback();
  }
  seekAll(currentComparisonTime() + (frameDurationSeconds() * direction));
}

function applyPlaybackRate() {
  clearClockHold({ resume: state.playing });
  resetSyncTracking('rate change');

  if (state.playing) {
    for (const slot of getLoadedVideos()) {
      if (!slot.video.paused) {
        scheduleSlotFrameCallback(slot);
      }
    }
  }
}

function waitForPlaybackReady(slot, generation, timeoutMs = 3000) {
  const video = slot.video;
  if (
    !video.seeking
    && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
  ) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (success) => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timer);
      video.removeEventListener('canplay', onReady);
      video.removeEventListener('loadeddata', onReady);
      video.removeEventListener('seeked', onReady);
      video.removeEventListener('error', onError);
      resolve(success && generation === state.synchronizationGeneration);
    };
    const onReady = () => finish(
      !video.seeking
      && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
    );
    const onError = () => finish(false);
    const timer = window.setTimeout(
      () => finish(
        !video.seeking
        && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
      ),
      timeoutMs
    );

    video.addEventListener('canplay', onReady, { once: true });
    video.addEventListener('loadeddata', onReady, { once: true });
    video.addEventListener('seeked', onReady, { once: true });
    video.addEventListener('error', onError, { once: true });
  });
}

function waitForAccurateSeek(slot, target, generation, timeoutMs = 3000) {
  const video = slot.video;
  if (!Number.isFinite(video.duration)) {
    return Promise.resolve(false);
  }

  const clampedTarget = clamp(target, 0, video.duration);
  const tolerance = Math.max(0.002, frameDurationSeconds() * 0.15);
  if (Math.abs(video.currentTime - clampedTarget) <= tolerance && !video.seeking) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (success) => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timer);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
      resolve(success && generation === state.synchronizationGeneration);
    };
    const onSeeked = () => finish(true);
    const onError = () => finish(false);
    const timer = window.setTimeout(() => finish(!video.seeking), timeoutMs);

    video.addEventListener('seeked', onSeeked, { once: true });
    video.addEventListener('error', onError, { once: true });

    try {
      video.currentTime = clampedTarget;
    } catch (error) {
      console.warn('Precise seek failed:', error);
      finish(false);
    }
  });
}

async function alignVideosAt(target, reason, { seekMaster = false } = {}) {
  const videos = getLoadedVideos();
  const master = getMasterSlot();
  if (videos.length === 0 || !master) {
    return false;
  }

  const generation = ++state.synchronizationGeneration;
  const duration = comparisonDuration();
  const clampedTarget = clamp(target, 0, duration || target || 0);

  for (const slot of videos) {
    slot.video.pause();
    slot.video.playbackRate = state.playbackRate;
    slot.latestFrame = null;
  }

  const seekTargets = videos.filter((slot) => seekMaster || slot !== master);
  const seekResults = await Promise.all(seekTargets.map((slot) => {
    const mediaTarget = mediaTimeForComparison(slot, clampedTarget);
    return waitForAccurateSeek(
      slot,
      clamp(
        mediaTarget,
        slotTimelineStart(slot),
        slot.video.duration || mediaTarget
      ),
      generation
    );
  }));

  if (
    generation !== state.synchronizationGeneration
    || seekResults.some((success) => !success)
  ) {
    return false;
  }

  const readyResults = await Promise.all(videos.map(
    (slot) => waitForPlaybackReady(slot, generation)
  ));
  if (
    generation !== state.synchronizationGeneration
    || readyResults.some((success) => !success)
  ) {
    return false;
  }

  resetSyncTracking(reason);
  return true;
}

async function playAlignedVideos(videos) {
  for (const slot of videos) {
    slot.syncHeld = false;
    slot.video.playbackRate = state.playbackRate;
  }

  // Queue both play requests in the same task. Their compositor timestamps are
  // measured immediately afterwards and the strict frame barrier removes any
  // small decoder-start difference without repeatedly seeking.
  const results = await Promise.allSettled(videos.map((slot) => slot.video.play()));
  const failed = results.some((result) => result.status === 'rejected');

  if (failed) {
    for (const slot of videos) {
      slot.video.pause();
    }
    return false;
  }

  for (const slot of videos) {
    scheduleSlotFrameCallback(slot);
  }
  return true;
}

async function startPlayback() {
  const videos = getLoadedVideos();
  if (videos.length === 0 || state.resyncInProgress) {
    return;
  }

  const duration = comparisonDuration();
  const current = currentComparisonTime();
  const restartFromBeginning = duration > 0 && current >= duration - Math.max(0.010, frameDurationSeconds());
  const initialTarget = restartFromBeginning ? 0 : current;

  state.resyncInProgress = true;
  state.bufferHoldActive = false;
  cancelFrameLoop();

  try {
    const aligned = await alignVideosAt(
      initialTarget,
      'play start',
      { seekMaster: restartFromBeginning }
    );
    if (!aligned) {
      showToast('The videos were not ready to start together.');
      return;
    }

    state.playing = true;
    const started = await playAlignedVideos(videos);
    if (!started) {
      state.playing = false;
      showToast('Playback could not start for both videos. Check codec and hardware decode support.');
      return;
    }

    window.desktopApi.setPlaybackActive(true);
    updatePlayButton();
    setStatus('Playing with strict frame-locked synchronization.');
  } finally {
    state.resyncInProgress = false;
    if (state.playing) {
      for (const slot of videos) {
        scheduleSlotFrameCallback(slot);
      }
      scheduleFrameLoop(0);
    } else {
      window.desktopApi.setPlaybackActive(false);
      updatePlayButton();
    }
  }
}

function pausePlayback() {
  state.playing = false;
  state.bufferHoldActive = false;
  state.resyncInProgress = false;
  state.synchronizationGeneration += 1;
  window.clearTimeout(state.bufferRecoveryTimer);
  state.bufferRecoveryTimer = null;

  for (const slot of getLoadedVideos()) {
    window.clearTimeout(slot.bufferTimer);
    slot.bufferTimer = null;
    slot.syncHeld = false;
    slot.video.pause();
    slot.video.playbackRate = state.playbackRate;
    slot.buffering = false;
  }

  window.desktopApi.setPlaybackActive(false);
  cancelFrameLoop();
  resetSyncTracking('paused');
  state.pendingSyncLabel = 'Sync paused';
  updatePlayButton();
  updateTimeline(true);
  dom.syncText.textContent = state.pendingSyncLabel;
  setStatus('Paused.');
}

function togglePlayback() {
  if (state.playing) {
    pausePlayback();
  } else {
    void startPlayback();
  }
}

function cancelFrameLoop() {
  if (state.syncTimerId !== null) {
    window.clearTimeout(state.syncTimerId);
    state.syncTimerId = null;
  }

  state.syncTickRunning = false;

  for (const slot of Object.values(slots)) {
    if (
      slot.frameCallbackId !== null
      && typeof slot.video.cancelVideoFrameCallback === 'function'
    ) {
      slot.video.cancelVideoFrameCallback(slot.frameCallbackId);
    }
    slot.frameCallbackId = null;
  }
}

function updateFrameStats(slot, now) {
  const elapsed = now - slot.lastQualitySampleAt;
  if (elapsed < 500) {
    return;
  }

  const quality = typeof slot.video.getVideoPlaybackQuality === 'function'
    ? slot.video.getVideoPlaybackQuality()
    : null;

  if (quality) {
    const renderedDelta = Math.max(0, quality.totalVideoFrames - slot.lastQualityFrames);
    slot.actualFps = renderedDelta / (elapsed / 1000);
    slot.lastQualityFrames = quality.totalVideoFrames;
    slot.lastDroppedFrames = quality.droppedVideoFrames;
  } else {
    slot.actualFps = slot.frameCounter / (elapsed / 1000);
    slot.frameCounter = 0;
  }

  slot.lastQualitySampleAt = now;
  slot.frameWindowStartedAt = now;
}

function formatDetectedAspectRatio(ratio) {
  const common = [
    [1, '1:1'],
    [4 / 3, '4:3'],
    [3 / 2, '3:2'],
    [16 / 10, '16:10'],
    [16 / 9, '16:9'],
    [1.85, '1.85:1'],
    [2, '2:1'],
    [21 / 9, '21:9'],
    [2.39, '2.39:1'],
  ].find(([value]) => Math.abs(ratio - value) / value <= 0.025);

  return common ? common[1] : `${ratio.toFixed(2)}:1`;
}

function mediaStatsLines(slot) {
  const sideLabel = slot.side === 'left' ? 'LEFT' : 'RIGHT';
  const video = slot.probe?.video;

  if (slot.kind === 'image') {
    const width = slot.image.naturalWidth || video?.width || 0;
    const height = slot.image.naturalHeight || video?.height || 0;
    const dimensions = width && height ? `${width}×${height}` : 'Dimensions unknown';
    const aspect = slot.aspectRatio > 0
      ? formatDetectedAspectRatio(slot.aspectRatio)
      : 'unknown ratio';
    return [`${sideLabel} · IMAGE · ${dimensions}`, `Aspect ${aspect}`];
  }

  if (!video) {
    return [`${sideLabel} · VIDEO`, 'Inspecting media…'];
  }

  const frameRate = Number(video.frameRate) || 0;
  const probedAspect = video.width > 0 && video.height > 0
    ? video.width / video.height
    : 0;
  const aspect = slot.aspectRatio > 0
    ? formatDetectedAspectRatio(slot.aspectRatio)
    : probedAspect > 0
      ? formatDetectedAspectRatio(probedAspect)
      : 'unknown ratio';
  const decode = slot.capability?.supported === false
    ? 'Decoder unsupported'
    : slot.capability?.smooth === false
      ? 'May drop frames'
      : slot.capability?.smooth === true
        ? 'Smooth decode'
        : 'Decode status unknown';
  const vendor = state.runtimeInfo?.activeGpu?.vendor;
  const power = slot.capability?.powerEfficient === true
    ? vendor && vendor !== 'Unknown'
      ? `Hardware decode · ${vendor}`
      : 'Hardware-efficient decode'
    : slot.capability?.powerEfficient === false
      ? 'Software / high power'
      : 'Power efficiency unknown';

  return [
    `${sideLabel} · ${codecLabel(video.codecName)} · ${video.width}×${video.height}`,
    `${frameRate ? `${frameRate.toFixed(2)} fps` : 'FPS unknown'} · ${video.dynamicRange?.label || 'Range unknown'} · ${video.bitDepth}-bit · ${aspect}`,
    `${decode} · ${power}`,
  ];
}

function renderStats() {
  if (!state.statsVisible) {
    return;
  }

  const master = getMasterSlot();
  for (const side of SIDES) {
    const slot = slots[side];
    if (slot.kind !== 'video') {
      slot.stats.textContent = slot.kind === 'image'
        ? mediaStatsLines(slot).join('\n')
        : '';
      continue;
    }

    const quality = typeof slot.video.getVideoPlaybackQuality === 'function'
      ? slot.video.getVideoPlaybackQuality()
      : null;
    const total = quality?.totalVideoFrames || slot.lastPresentedFrames || 0;
    const dropped = quality?.droppedVideoFrames || slot.lastDroppedFrames || 0;
    const drift = master && slot !== master
      ? `${(state.driftSeconds * 1000).toFixed(1)} ms`
      : 'master clock';

    slot.stats.textContent = [
      ...mediaStatsLines(slot),
      `Live ${slot.actualFps.toFixed(1)} fps · Frames ${total} · Dropped ${dropped}`,
      `Sync ${drift} · Resyncs ${state.resyncCount} · Loops ${state.loopCount}`,
      `Ready ${slot.video.readyState} · Zoom ${Math.round(state.zoom * 100)}%`,
    ].join('\n');
  }
}

function recordVideoFrame(slot, now, metadata) {
  slot.frameCallbackId = null;
  slot.latestFrame = {
    callbackTime: now,
    mediaTime: Number.isFinite(metadata.mediaTime) ? metadata.mediaTime : slot.video.currentTime,
    expectedDisplayTime: Number.isFinite(metadata.expectedDisplayTime)
      ? metadata.expectedDisplayTime
      : now,
    presentedFrames: metadata.presentedFrames || 0,
  };
  slot.lastPresentedFrames = metadata.presentedFrames || slot.lastPresentedFrames;
  slot.frameCounter += 1;
  maybeApplyImmediateFrameBarrier(now);

  // Keep compositor timestamps current. The callback only stores numbers and
  // may engage the lightweight frame barrier; DOM/statistics work stays on the
  // low-frequency controller timer.
  if (
    state.playing
    && !state.bufferHoldActive
    && !state.resyncInProgress
    && !slot.syncHeld
    && !slot.video.paused
  ) {
    scheduleSlotFrameCallback(slot);
  }
}

function scheduleSlotFrameCallback(slot) {
  if (
    !state.playing
    || state.bufferHoldActive
    || state.resyncInProgress
    || slot.syncHeld
    || slot.video.paused
    || slot.kind !== 'video'
    || slot.frameCallbackId !== null
    || typeof slot.video.requestVideoFrameCallback !== 'function'
  ) {
    return;
  }

  slot.frameCallbackId = slot.video.requestVideoFrameCallback(
    (now, metadata) => recordVideoFrame(slot, now, metadata)
  );
}

function estimatedMediaTime(slot, now) {
  const frame = slot.latestFrame;
  if (
    !frame
    || slot.video.seeking
    || now - frame.callbackTime > FRAME_SAMPLE_MAX_AGE_MS
  ) {
    return slot.video.currentTime || 0;
  }

  if (slot.video.paused || slot.syncHeld) {
    return frame.mediaTime;
  }

  // expectedDisplayTime is in the same monotonic time domain as `now`.
  // Allow a small negative delta because callbacks may arrive just before
  // the compositor presents the frame; clamping it to zero biases one stream.
  const elapsedFromDisplay = clamp(
    (now - frame.expectedDisplayTime) / 1000,
    -0.100,
    0.250
  );
  return frame.mediaTime + (elapsedFromDisplay * slot.video.playbackRate);
}

function median(values) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function syncThresholds(master, slave) {
  const masterFps = master.probe?.video?.frameRate || master.actualFps || 30;
  const slaveFps = slave.probe?.video?.frameRate || slave.actualFps || 30;
  const slowerFps = clamp(Math.min(masterFps, slaveFps), 1, 240);
  const frameDuration = 1 / slowerFps;

  return {
    frameDuration,
    deadband: clamp(
      frameDuration * 0.45,
      MIN_SYNC_DEADBAND_SECONDS,
      MAX_SYNC_DEADBAND_SECONDS
    ),
    hold: clamp(
      frameDuration * 1.15,
      MIN_HOLD_THRESHOLD_SECONDS,
      MAX_HOLD_THRESHOLD_SECONDS
    ),
    hard: clamp(
      frameDuration * 6,
      MIN_HARD_SYNC_SECONDS,
      MAX_HARD_SYNC_SECONDS
    ),
  };
}

function applySoftSyncCorrection(slave, filteredDrift, thresholds, now) {
  if (slave.syncHeld) {
    return;
  }

  const absoluteDrift = Math.abs(filteredDrift);
  let targetRate = state.playbackRate;

  if (
    absoluteDrift > thresholds.deadband
    && absoluteDrift < thresholds.hold
  ) {
    const correction = clamp(
      -filteredDrift / 1.5,
      -MAX_RATE_CORRECTION,
      MAX_RATE_CORRECTION
    );
    targetRate = state.playbackRate * (1 + correction);
  }

  const rateDifference = Math.abs(slave.video.playbackRate - targetRate);
  if (
    rateDifference >= 0.001
    && now - state.lastRateAdjustmentAt >= RATE_UPDATE_INTERVAL_MS
  ) {
    slave.video.playbackRate = targetRate;
    state.lastRateAdjustmentAt = now;
  }
}

function clearClockHold({ resume = false } = {}) {
  const heldSide = state.clockHoldSide;
  state.clockHoldSide = null;
  state.clockHoldStartedAt = 0;

  if (!heldSide) {
    return;
  }

  const slot = slots[heldSide];
  slot.syncHeld = false;
  slot.video.playbackRate = state.playbackRate;

  if (
    resume
    && state.playing
    && !state.bufferHoldActive
    && !state.resyncInProgress
    && slot.video.paused
  ) {
    void slot.video.play().then(() => {
      scheduleSlotFrameCallback(slot);
    }).catch((error) => {
      console.warn('Frame-held video could not resume:', error);
      if (state.playing && !state.resyncInProgress) {
        void performHardResync('held decoder could not resume');
      }
    });
  }
}

function engageClockHold(slot, drift, now) {
  if (
    state.clockHoldSide
    || slot.syncHeld
    || slot.video.paused
    || state.bufferHoldActive
    || state.resyncInProgress
  ) {
    return;
  }

  for (const videoSlot of getLoadedVideos()) {
    videoSlot.video.playbackRate = state.playbackRate;
  }
  slot.syncHeld = true;
  slot.video.pause();
  state.clockHoldSide = slot.side;
  state.clockHoldStartedAt = now;
  state.driftHistory = [drift];
  state.filteredDriftSeconds = drift;
  state.pendingSyncLabel = [
    `Frame lock holding ${slot.side}`,
    `${drift >= 0 ? '+' : ''}${(drift * 1000).toFixed(1)} ms`,
  ].join(' · ');
}

function maybeApplyImmediateFrameBarrier(now) {
  if (
    !state.playing
    || state.seeking
    || state.bufferHoldActive
    || state.resyncInProgress
    || state.clockHoldSide
  ) {
    return;
  }

  const master = getMasterSlot();
  const slave = getSlaveSlot(master);
  if (
    !master
    || !slave
    || !master.latestFrame
    || !slave.latestFrame
    || master.video.paused
    || slave.video.paused
    || master.video.seeking
    || slave.video.seeking
  ) {
    return;
  }

  const thresholds = syncThresholds(master, slave);
  const sampleSkewMs = Math.abs(
    master.latestFrame.expectedDisplayTime - slave.latestFrame.expectedDisplayTime
  );
  const maximumComparableSkewMs = clamp(
    thresholds.frameDuration * 2000,
    24,
    80
  );

  // Avoid comparing a fresh compositor sample with a genuinely stale one.
  if (sampleSkewMs > maximumComparableSkewMs) {
    return;
  }

  const drift = comparisonTimeForSlot(
    slave,
    estimatedMediaTime(slave, now)
  ) - comparisonTimeForSlot(
    master,
    estimatedMediaTime(master, now)
  );

  if (Math.abs(drift) >= thresholds.hold) {
    engageClockHold(drift > 0 ? slave : master, drift, now);
  }
}

function updateClockHold(rawDrift, thresholds, now) {
  const heldSide = state.clockHoldSide;
  if (!heldSide) {
    return false;
  }

  const heldWasSlave = heldSide === getSlaveSlot(getMasterSlot())?.side;
  const releaseThreshold = thresholds.deadband * 0.35;
  const caughtUp = heldWasSlave
    ? rawDrift <= releaseThreshold
    : rawDrift >= -releaseThreshold;

  if (caughtUp) {
    clearClockHold({ resume: true });
    state.driftHistory = [rawDrift];
    state.filteredDriftSeconds = rawDrift;
    state.hardDriftSamples = 0;
    state.pendingSyncLabel = 'Frame lock reacquired';
    return true;
  }

  if (now - state.clockHoldStartedAt >= CLOCK_HOLD_TIMEOUT_MS) {
    if (now - state.lastHardSyncAt >= HARD_SYNC_COOLDOWN_MS) {
      clearClockHold({ resume: false });
      void performHardResync('frame-lock hold timeout');
    } else {
      clearClockHold({ resume: true });
    }
    return true;
  }

  state.pendingSyncLabel = [
    `Frame lock holding ${heldSide}`,
    `${rawDrift >= 0 ? '+' : ''}${(rawDrift * 1000).toFixed(1)} ms`,
  ].join(' · ');
  return true;
}

async function performHardResync(reason) {
  if (!state.playing || state.resyncInProgress) {
    return;
  }

  const videos = getLoadedVideos();
  const master = getMasterSlot();
  if (!master || videos.length < 2) {
    return;
  }

  state.resyncInProgress = true;
  state.lastHardSyncAt = performance.now();
  state.resyncCount += 1;
  clearClockHold({ resume: false });
  cancelFrameLoop();

  // Freeze the master before selecting the target. Using an extrapolated target
  // while the master is still advancing can build a new offset into the resync.
  for (const slot of videos) {
    slot.syncHeld = false;
    slot.video.pause();
    slot.video.playbackRate = state.playbackRate;
  }

  const masterComparisonTime = comparisonTimeForSlot(master);
  const target = clamp(
    masterComparisonTime,
    0,
    comparisonDuration() || masterComparisonTime
  );

  try {
    const aligned = await alignVideosAt(target, reason, { seekMaster: false });
    if (!aligned) {
      pausePlayback();
      showToast('Automatic resynchronization could not align both videos.');
      return;
    }
    if (!state.playing) {
      return;
    }

    const started = await playAlignedVideos(videos);
    if (!started) {
      pausePlayback();
      showToast('Automatic resynchronization could not restart both videos.');
      return;
    }

    state.pendingSyncLabel = `Frame lock restored · ${reason}`;
    setStatus(`Frame lock restored (${reason}).`);
  } finally {
    state.resyncInProgress = false;
    if (state.playing && !state.bufferHoldActive) {
      for (const slot of videos) {
        scheduleSlotFrameCallback(slot);
      }
      scheduleFrameLoop(controllerIntervalMs());
    }
  }
}

function paintPlaybackUi(now) {
  updateTimeline(true);
  renderStats();
  dom.syncText.textContent = state.pendingSyncLabel;
  state.lastUiUpdateAt = now;
}

function syncControllerTick() {
  state.syncTimerId = null;
  if (!state.playing || state.syncTickRunning) {
    return;
  }

  state.syncTickRunning = true;
  const now = performance.now();

  try {
    const videos = getLoadedVideos();
    for (const slot of videos) {
      scheduleSlotFrameCallback(slot);
      updateFrameStats(slot, now);
    }

    const master = getMasterSlot();
    const slave = getSlaveSlot(master);

    if (state.bufferHoldActive) {
      state.pendingSyncLabel = 'Frame lock held while buffering';
    } else if (
      master
      && slave
      && !state.resyncInProgress
      && !state.seeking
      && !master.video.seeking
      && !slave.video.seeking
    ) {
      const decoderNotReady = [master, slave].find(
        (slot) => (
          !slot.syncHeld
          && slot.video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA
        )
      );

      if (decoderNotReady) {
        holdSynchronizedPlaybackForBuffering(decoderNotReady);
        state.pendingSyncLabel = `Decoder warming · ${decoderNotReady.side}`;
      } else {
        const pausedUnexpectedly = [master, slave].find(
          (slot) => slot.video.paused && !slot.syncHeld
        );

        if (pausedUnexpectedly) {
          state.unexpectedPauseSamples += 1;
          state.pendingSyncLabel = `Waiting for ${pausedUnexpectedly.side} decoder`;
          if (
            state.unexpectedPauseSamples >= 3
            && now - state.lastHardSyncAt >= HARD_SYNC_COOLDOWN_MS
          ) {
            void performHardResync('unexpected decoder pause');
            return;
          }
        } else {
          state.unexpectedPauseSamples = 0;
          if (!master.syncHeld) {
            master.video.playbackRate = state.playbackRate;
          }

          const drift = comparisonTimeForSlot(
            slave,
            estimatedMediaTime(slave, now)
          ) - comparisonTimeForSlot(
            master,
            estimatedMediaTime(master, now)
          );
          const thresholds = syncThresholds(master, slave);
          state.driftSeconds = drift;
          state.driftHistory.push(drift);
          if (state.driftHistory.length > DRIFT_HISTORY_SIZE) {
            state.driftHistory.shift();
          }
          state.filteredDriftSeconds = median(state.driftHistory);

          if (state.clockHoldSide) {
            updateClockHold(drift, thresholds, now);
          } else if (Math.abs(state.filteredDriftSeconds) >= thresholds.hold) {
            // Positive drift means the right/slave stream is ahead; negative
            // drift means the left/master stream is ahead.
            const aheadSlot = state.filteredDriftSeconds > 0 ? slave : master;
            engageClockHold(aheadSlot, state.filteredDriftSeconds, now);
          } else {
            state.hardDriftSamples = 0;
            applySoftSyncCorrection(
              slave,
              state.filteredDriftSeconds,
              thresholds,
              now
            );
            state.pendingSyncLabel = [
              `Frame lock ${drift >= 0 ? '+' : ''}${(drift * 1000).toFixed(1)} ms`,
              `resyncs ${state.resyncCount}`,
            ].join(' · ');
          }

          if (
            !state.clockHoldSide
            && Math.abs(state.filteredDriftSeconds) >= thresholds.hard
          ) {
            state.hardDriftSamples += 1;
            if (
              state.hardDriftSamples >= HARD_DRIFT_SAMPLE_COUNT
              && now - state.lastHardSyncAt >= HARD_SYNC_COOLDOWN_MS
            ) {
              void performHardResync(
                `persistent drift ${(state.filteredDriftSeconds * 1000).toFixed(0)} ms`
              );
              return;
            }
          }
        }
      }
    } else if (master && !slave) {
      state.pendingSyncLabel = `${master.actualFps.toFixed(1)} fps`;
    }

    if (now - state.lastUiUpdateAt >= UI_UPDATE_INTERVAL_MS) {
      paintPlaybackUi(now);
    }
  } finally {
    state.syncTickRunning = false;
    if (state.playing && !state.resyncInProgress) {
      scheduleFrameLoop(controllerIntervalMs());
    }
  }
}

function controllerIntervalMs() {
  return getLoadedVideos().length > 1
    ? SYNC_SAMPLE_INTERVAL_MS
    : SINGLE_VIDEO_CONTROLLER_INTERVAL_MS;
}

function scheduleFrameLoop(delayMs = controllerIntervalMs()) {
  if (!state.playing || state.resyncInProgress) {
    return;
  }

  if (state.syncTimerId !== null) {
    window.clearTimeout(state.syncTimerId);
  }
  state.syncTimerId = window.setTimeout(syncControllerTick, delayMs);
}

function allVideosReadyForSynchronizedPlayback() {
  const videos = getLoadedVideos();
  return videos.length > 0 && videos.every((slot) => (
    !slot.video.seeking
    && slot.video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA
  ));
}

function scheduleBufferRecovery() {
  window.clearTimeout(state.bufferRecoveryTimer);
  state.bufferRecoveryTimer = window.setTimeout(() => {
    state.bufferRecoveryTimer = null;

    if (!state.playing || !state.bufferHoldActive) {
      return;
    }

    if (!allVideosReadyForSynchronizedPlayback()) {
      scheduleBufferRecovery();
      return;
    }

    state.bufferHoldActive = false;
    for (const slot of getLoadedVideos()) {
      slot.buffering = false;
    }
    void performHardResync('buffer recovery');
  }, BUFFER_RECOVERY_DELAY_MS);
}

function enterBufferHold(slot) {
  slot.bufferTimer = null;

  if (
    !state.playing
    || state.resyncInProgress
    || state.bufferHoldActive
    || (
      !slot.video.seeking
      && slot.video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA
    )
  ) {
    return;
  }

  state.bufferHoldActive = true;
  clearClockHold({ resume: false });
  cancelFrameLoop();

  for (const videoSlot of getLoadedVideos()) {
    videoSlot.video.pause();
    videoSlot.video.playbackRate = state.playbackRate;
  }

  state.pendingSyncLabel = `Buffering · ${slot.side} decoder`;
  dom.syncText.textContent = state.pendingSyncLabel;
  setStatus('Playback temporarily held while the slower decoder catches up.');
  scheduleBufferRecovery();
}

function holdSynchronizedPlaybackForBuffering(slot) {
  if (!state.playing || state.resyncInProgress) {
    return;
  }

  slot.buffering = true;
  window.clearTimeout(slot.bufferTimer);
  slot.bufferTimer = window.setTimeout(
    () => enterBufferHold(slot),
    BUFFER_HOLD_DELAY_MS
  );
}

function markBufferRecovered(slot) {
  slot.buffering = false;
  window.clearTimeout(slot.bufferTimer);
  slot.bufferTimer = null;
  window.clearTimeout(slot.videoClickTimer);
  slot.videoClickTimer = null;

  if (state.bufferHoldActive) {
    scheduleBufferRecovery();
  }
}

function updateStatsPanelVisibility() {
  for (const side of SIDES) {
    const visible = state.statsVisible && (
      state.mode !== 'single' || side === state.singleSide
    );
    slots[side].stats.hidden = !visible;
  }
}

function updateSingleSide(side, announce = false) {
  state.singleSide = side === 'right' ? 'right' : 'left';
  const showRight = state.singleSide === 'right';

  dom.comparison.classList.toggle('single-show-left', !showRight);
  dom.comparison.classList.toggle('single-show-right', showRight);
  slots.left.root.setAttribute('aria-hidden', String(state.mode === 'single' && showRight));
  slots.right.root.setAttribute('aria-hidden', String(state.mode === 'single' && !showRight));
  updateStatsPanelVisibility();

  if (announce) {
    setStatus(`${showRight ? 'Second (Right)' : 'First (Left)'} video shown.`);
  }
}

function switchSingleSide() {
  updateSingleSide(state.singleSide === 'left' ? 'right' : 'left', true);
}

function placeStatsOverlaysForMode(overlap) {
  for (const side of SIDES) {
    const slot = slots[side];
    const target = overlap ? dom.comparison : slot.stage;
    if (slot.stats.parentElement !== target) {
      target.append(slot.stats);
    }
  }
}

function setMode(mode) {
  state.mode = ['split', 'overlap', 'single'].includes(mode) ? mode : 'split';
  resetZoomToViewDefault();
  const overlap = state.mode === 'overlap';
  const single = state.mode === 'single';
  const split = state.mode === 'split';

  dom.comparison.classList.toggle('split-mode', split);
  dom.comparison.classList.toggle('overlap-mode', overlap);
  dom.comparison.classList.toggle('single-mode', single);
  dom.splitModeButton.classList.toggle('active', split);
  dom.overlapModeButton.classList.toggle('active', overlap);
  dom.singleModeButton.classList.toggle('active', single);
  dom.splitModeButton.setAttribute('aria-pressed', String(split));
  dom.overlapModeButton.setAttribute('aria-pressed', String(overlap));
  dom.singleModeButton.setAttribute('aria-pressed', String(single));
  dom.horizontalLayoutButton.disabled = !split;
  dom.verticalLayoutButton.disabled = !split;
  dom.wipeDivider.hidden = !overlap;
  placeStatsOverlaysForMode(overlap);
  updateSingleSide(state.singleSide);

  if (single) {
    setStatus(
      `Single-video comparison enabled. Click the screen to switch; ${state.singleSide === 'left' ? 'First (Left)' : 'Second (Right)'} is shown.`
    );
  } else {
    setStatus(overlap ? 'Wipe comparison enabled.' : 'Split comparison enabled.');
  }
}

function setLayout(layout) {
  const vertical = layout === 'vertical';
  state.layout = vertical ? 'vertical' : 'horizontal';
  resetZoomToViewDefault();
  dom.comparison.classList.toggle('horizontal-layout', !vertical);
  dom.comparison.classList.toggle('vertical-layout', vertical);
  dom.horizontalLayoutButton.classList.toggle('active', !vertical);
  dom.verticalLayoutButton.classList.toggle('active', vertical);
  dom.horizontalLayoutButton.setAttribute('aria-pressed', String(!vertical));
  dom.verticalLayoutButton.setAttribute('aria-pressed', String(vertical));
  setStatus(vertical
    ? 'Video screens stacked vertically.'
    : 'Video screens arranged horizontally.');
}

function setDividerPercent(percent) {
  state.dividerPercent = clamp(percent, 1, 99);
  dom.comparison.style.setProperty('--divider-percent', `${state.dividerPercent}%`);
  dom.wipeDivider.setAttribute('aria-valuenow', String(Math.round(state.dividerPercent)));
}

function queueDividerFromPointer(clientX) {
  const rect = dom.comparison.getBoundingClientRect();
  const percent = ((clientX - rect.left) / rect.width) * 100;

  if (state.dividerRaf !== null) {
    cancelAnimationFrame(state.dividerRaf);
  }
  state.dividerRaf = requestAnimationFrame(() => {
    setDividerPercent(percent);
    state.dividerRaf = null;
  });
}

function clearSlot(slot) {
  slot.loadGeneration += 1;

  if (
    slot.frameCallbackId !== null
    && typeof slot.video.cancelVideoFrameCallback === 'function'
  ) {
    slot.video.cancelVideoFrameCallback(slot.frameCallbackId);
  }
  slot.frameCallbackId = null;
  slot.latestFrame = null;
  window.clearTimeout(slot.bufferTimer);
  slot.bufferTimer = null;
  slot.buffering = false;
  slot.syncHeld = false;

  if (slot.objectUrl) {
    URL.revokeObjectURL(slot.objectUrl);
  }

  slot.video.pause();
  slot.video.removeAttribute('src');
  slot.video.load();
  slot.image.removeAttribute('src');
  slot.video.hidden = true;
  slot.image.hidden = true;
  slot.empty.hidden = false;
  slot.file = null;
  slot.objectUrl = null;
  slot.kind = null;
  slot.aspectRatio = 0;
  slot.aspectFamily = 'unknown';
  slot.root.style.removeProperty('--media-aspect-ratio');
  delete slot.root.dataset.aspectFamily;
  slot.probe = null;
  slot.capability = null;
  slot.ready = false;
  slot.actualFps = 0;
  slot.frameCounter = 0;
  slot.frameWindowStartedAt = performance.now();
  slot.lastQualityFrames = 0;
  slot.lastQualitySampleAt = performance.now();
  slot.lastPresentedFrames = 0;
  slot.lastDroppedFrames = 0;
  slot.badges.replaceChildren();
  slot.stats.textContent = '';
  slot.title.textContent = 'No media loaded';
  slot.summary.textContent = '—';
  slot.metadata.replaceChildren();
  slot.metadata.hidden = true;
}

function clearAll() {
  pausePlayback();
  resetZoomToViewDefault();
  for (const side of SIDES) {
    clearSlot(slots[side]);
  }
  state.nextSide = 'left';
  state.singleSide = 'right';
  updateSingleSide('right');
  state.driftSeconds = 0;
  state.filteredDriftSeconds = 0;
  state.driftHistory.length = 0;
  state.clockHoldSide = null;
  state.clockHoldStartedAt = 0;
  state.resyncCount = 0;
  state.loopCount = 0;
  state.bufferHoldActive = false;
  state.lastSyncReason = 'idle';
  state.pendingSyncLabel = 'Sync idle';
  dom.timeline.value = '0';
  dom.timeOutput.textContent = '00:00.000 / 00:00.000';
  dom.syncText.textContent = 'Sync idle';
  updateTransportAvailability();
  setStatus('Ready. Open one or two media files.');
}

function metadataEntries(file, probe, kind) {
  const video = probe?.video;
  const audio = probe?.audio;
  const container = probe?.container;
  if (kind === 'image') {
    return [
      ['Type', file.type || `image/${extensionOf(file.name) || 'unknown'}`],
      ['Resolution', video?.width && video?.height ? `${video.width} × ${video.height}` : '—'],
      ['Pixel format', video?.pixelFormat || '—'],
      ['File size', formatBytes(file.size)],
    ];
  }

  if (!video) {
    return [
      ['Type', file.type || 'Media'],
      ['File size', formatBytes(file.size)],
    ];
  }

  const range = [
    video.colorPrimaries,
    video.colorTransfer,
    video.colorSpace,
    video.colorRange,
  ].filter(Boolean).join(' / ');

  return [
    ['Codec', `${codecLabel(video.codecName)}${video.profile ? ` · ${video.profile}` : ''}`],
    ['Resolution', `${video.width} × ${video.height}`],
    ['Frame rate', video.frameRate ? `${video.frameRate.toFixed(3)} fps` : '—'],
    ['Bitrate', formatBitrate(video.bitrate || container?.bitrate)],
    ['Pixel format', `${video.pixelFormat || '—'} · ${video.bitDepth}-bit`],
    ['Dynamic range', video.dynamicRange?.label || 'Unknown'],
    ['Color', range || '—'],
    ['Container', container?.longName || container?.names?.join(', ') || '—'],
    ['Duration', formatTime(video.duration || container?.duration)],
    ['File size', formatBytes(file.size)],
    ['Audio', audio ? `${audio.codecName.toUpperCase()} · ${audio.channels} ch · ${audio.sampleRate} Hz` : 'None'],
    ['Codec tag', video.codecTag || '—'],
  ];
}

function mimeForFile(file, probe) {
  const extension = extensionOf(file.name);
  if (file.type && file.type.startsWith('video/')) {
    return file.type;
  }
  if (['mp4', 'm4v', 'mov'].includes(extension)) {
    return 'video/mp4';
  }
  if (extension === 'webm') {
    return 'video/webm';
  }
  if (extension === 'mkv') {
    return 'video/x-matroska';
  }
  if (['ts', 'm2ts', 'mts'].includes(extension)) {
    return 'video/mp2t';
  }

  const formatNames = probe?.container?.names || [];
  if (formatNames.includes('webm')) {
    return 'video/webm';
  }
  if (formatNames.some((name) => ['mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2'].includes(name))) {
    return 'video/mp4';
  }
  if (formatNames.includes('matroska')) {
    return 'video/x-matroska';
  }
  return 'video/mp4';
}

function avcCodecString(video) {
  const profiles = {
    baseline: '42',
    'constrained baseline': '42',
    main: '4D',
    high: '64',
    'high 10': '6E',
  };
  const profileKey = String(video.profile || '').toLowerCase();
  const profile = profiles[profileKey] || '64';
  const level = clamp(Number(video.level) || 40, 0, 255)
    .toString(16)
    .toUpperCase()
    .padStart(2, '0');
  return `avc1.${profile}00${level}`;
}

function codecString(video) {
  const codecTag = String(video.codecTag || '').toLowerCase();
  switch (video.codecName) {
    case 'h264':
      return codecTag.startsWith('avc') ? codecTag : avcCodecString(video);
    case 'hevc':
      return codecTag === 'hev1' || codecTag === 'hvc1' ? codecTag : 'hvc1';
    case 'av1':
      return `av01.0.08M.${video.bitDepth >= 10 ? '10' : '08'}`;
    case 'vp9':
      return video.bitDepth >= 10 ? 'vp09.02.10.10' : 'vp09.00.10.08';
    case 'vp8':
      return 'vp8';
    case 'theora':
      return 'theora';
    default:
      return codecTag || video.codecName || '';
  }
}

async function queryDecodeCapability(slot) {
  const videoInfo = slot.probe?.video;
  if (!videoInfo) {
    return null;
  }

  const mime = mimeForFile(slot.file, slot.probe);
  const codec = codecString(videoInfo);
  const contentType = codec ? `${mime}; codecs="${codec}"` : mime;
  const canPlay = slot.video.canPlayType(contentType);

  const result = {
    contentType,
    canPlay,
    supported: canPlay !== '',
    smooth: null,
    powerEfficient: null,
  };

  if (!navigator.mediaCapabilities?.decodingInfo) {
    return result;
  }

  const config = {
    type: 'file',
    video: {
      contentType,
      width: Math.max(videoInfo.width, 1),
      height: Math.max(videoInfo.height, 1),
      bitrate: Math.max(videoInfo.bitrate || slot.probe.container?.bitrate || 1, 1),
      framerate: Math.max(videoInfo.frameRate || 30, 1),
    },
  };

  const dynamicRange = videoInfo.dynamicRange;
  if (dynamicRange?.gamut) {
    config.video.colorGamut = dynamicRange.gamut;
  }
  if (dynamicRange?.transfer) {
    config.video.transferFunction = dynamicRange.transfer;
  }
  if (dynamicRange?.metadataType) {
    config.video.hdrMetadataType = dynamicRange.metadataType;
  }

  try {
    const capability = await navigator.mediaCapabilities.decodingInfo(config);
    result.supported = capability.supported;
    result.smooth = capability.smooth;
    result.powerEfficient = capability.powerEfficient;
  } catch (error) {
    console.warn('MediaCapabilities rejected configuration:', contentType, error);
  }

  return result;
}

function renderProbe(slot) {
  const video = slot.probe?.video;
  slot.badges.replaceChildren();

  if (slot.kind === 'image') {
    addChip(slot.badges, 'Image', 'neutral');
    if (video?.width && video?.height) {
      addChip(slot.badges, `${video.width}×${video.height}`, 'neutral');
      slot.summary.textContent = `${video.width}×${video.height} · ${formatBytes(slot.file?.size)}`;
    } else {
      slot.summary.textContent = formatBytes(slot.file?.size);
    }
    setMetadata(slot.metadata, metadataEntries(slot.file, slot.probe, slot.kind));
    return;
  }

  if (!video) {
    addChip(slot.badges, 'Media', 'neutral');
    slot.summary.textContent = formatBytes(slot.file?.size);
    setMetadata(slot.metadata, metadataEntries(slot.file, slot.probe, slot.kind));
    return;
  }

  const frameRate = Number(video.frameRate) || 0;
  const dynamicRange = video.dynamicRange || {
    label: 'Unknown',
    isHdr: false,
  };

  addChip(slot.badges, codecLabel(video.codecName), 'neutral');
  addChip(slot.badges, `${video.width}×${video.height}`, 'neutral');
  addChip(slot.badges, frameRate ? `${frameRate.toFixed(2)} fps` : 'FPS unknown', frameRate > 60 ? 'warn' : 'neutral');
  addChip(
    slot.badges,
    dynamicRange.label,
    dynamicRange.isHdr ? 'good' : 'neutral'
  );

  if (slot.capability) {
    if (!slot.capability.supported) {
      addChip(slot.badges, 'Decoder unsupported', 'bad');
    } else if (slot.capability.smooth === false) {
      addChip(slot.badges, 'May drop frames', 'warn');
    } else if (slot.capability.smooth === true) {
      addChip(slot.badges, 'Smooth decode', 'good');
    }

    if (slot.capability.powerEfficient === true) {
      const vendor = state.runtimeInfo?.activeGpu?.vendor;
      const hardwareLabel = vendor && vendor !== 'Unknown'
        ? `Hardware decode · ${vendor} GPU active`
        : 'Hardware-efficient decode';
      addChip(slot.badges, hardwareLabel, 'good');
    } else if (slot.capability.powerEfficient === false) {
      addChip(slot.badges, 'Software / high power', 'warn');
    }
  }

  slot.summary.textContent = [
    codecLabel(video.codecName),
    `${video.bitDepth}-bit`,
    frameRate ? `${frameRate.toFixed(2)} fps` : 'FPS unknown',
  ].join(' · ');

  setMetadata(slot.metadata, metadataEntries(slot.file, slot.probe, slot.kind));
}

async function loadSlot(slot, file) {
  const kind = classifyFile(file);
  if (!kind) {
    showToast(`Unsupported file type: ${file.name}`);
    return;
  }

  if (state.playing) {
    pausePlayback();
  }
  clearSlot(slot);
  state.loopCount = 0;
  const loadGeneration = slot.loadGeneration;

  slot.file = file;
  slot.kind = kind;
  slot.objectUrl = URL.createObjectURL(file);
  slot.title.textContent = file.name;
  slot.empty.hidden = true;

  if (kind === 'video') {
    slot.video.hidden = false;
    slot.video.src = slot.objectUrl;
    slot.video.playbackRate = state.playbackRate;
    applyAudioState();
    slot.video.load();
  } else {
    slot.image.hidden = false;
    slot.image.src = slot.objectUrl;
  }

  addChip(slot.badges, 'Inspecting…', 'neutral');
  slot.summary.textContent = formatBytes(file.size);
  updateTransportAvailability();
  setStatus(`Loading ${file.name}…`);

  try {
    const probe = await window.desktopApi.probeFile(file);
    if (slot.loadGeneration !== loadGeneration || slot.file !== file) {
      return;
    }
    slot.probe = probe;
    if (slot.kind === 'video') {
      slot.capability = await queryDecodeCapability(slot);
      if (slot.loadGeneration !== loadGeneration || slot.file !== file) {
        return;
      }
    }
    renderProbe(slot);
    setStatus(`${file.name} loaded.`);
  } catch (error) {
    if (slot.loadGeneration !== loadGeneration || slot.file !== file) {
      return;
    }
    slot.badges.replaceChildren();
    addChip(slot.badges, kind === 'video' ? 'Video' : 'Image', 'neutral');
    addChip(slot.badges, 'Metadata unavailable', 'warn');
    setMetadata(slot.metadata, metadataEntries(file, null, kind));
    showToast(`Could not inspect ${file.name}: ${error.message}`);
  }

  updateTransportAvailability();
  updateTimeline(true);
  renderStats();
}

async function loadFiles(fileList) {
  hideDropOverlay();

  const files = Array.from(fileList || []).slice(0, 2);
  if (files.length === 0) {
    dom.filePicker.value = '';
    return;
  }

  resetZoomToViewDefault();
  try {
    if (files.length === 2) {
      await Promise.all([
        loadSlot(slots.left, files[0]),
        loadSlot(slots.right, files[1]),
      ]);
      state.nextSide = 'left';
    } else {
      const side = state.nextSide;
      await loadSlot(slots[side], files[0]);
      state.nextSide = side === 'left' ? 'right' : 'left';
    }
  } finally {
    dom.filePicker.value = '';
    hideDropOverlay();
    maybeWarnAboutDecodeCapacity();
  }
}

function toggleStats() {
  state.statsVisible = !state.statsVisible;
  dom.statsButton.setAttribute('aria-pressed', String(state.statsVisible));
  dom.statsButton.classList.toggle('button-primary', state.statsVisible);
  updateStatsPanelVisibility();
  renderStats();
}


async function restartWarmLoop() {
  if (!state.playing || state.resyncInProgress) {
    return;
  }

  const videos = getLoadedVideos();
  if (videos.length === 0) {
    return;
  }

  state.resyncInProgress = true;
  state.bufferHoldActive = false;
  clearClockHold({ resume: false });
  cancelFrameLoop();

  // Keep the same HTMLVideoElement instances and object URLs alive. Chromium
  // can retain its demuxer, decoder, OS file cache, and GPU-backed decode
  // surfaces; only the playback position is reset.
  for (const slot of videos) {
    slot.syncHeld = false;
    slot.video.pause();
    slot.video.playbackRate = state.playbackRate;
  }

  try {
    const aligned = await alignVideosAt(0, 'warm loop restart', { seekMaster: true });
    if (!aligned || !state.playing) {
      pausePlayback();
      showToast('The loop restart could not prepare both videos.');
      return;
    }

    const started = await playAlignedVideos(videos);
    if (!started) {
      pausePlayback();
      showToast('The loop restart could not restart both decoders.');
      return;
    }

    state.loopCount += 1;
    state.pendingSyncLabel = `Warm loop ${state.loopCount} · frame lock active`;
    setStatus(`Loop ${state.loopCount} restarted without reloading the media files.`);
    updateTimeline(true);
  } finally {
    state.resyncInProgress = false;
    if (state.playing && !state.bufferHoldActive) {
      for (const slot of videos) {
        scheduleSlotFrameCallback(slot);
      }
      scheduleFrameLoop(0);
    }
  }
}

function handleMediaEnded() {
  if (!state.playing) {
    return;
  }

  if (dom.loopToggle.checked) {
    void restartWarmLoop();
  } else {
    pausePlayback();
  }
}

function handleMediaError(slot) {
  if (!slot.file) {
    return;
  }
  const mediaError = slot.video.error;
  const messages = {
    1: 'Playback was aborted.',
    2: 'A network or file read error occurred.',
    3: 'The media could not be decoded. Check codec, profile, bit depth, and hardware support.',
    4: 'The media container or codec is not supported by this Electron/OS combination.',
  };
  const message = messages[mediaError?.code] || 'The media could not be played.';
  addChip(slot.badges, 'Playback error', 'bad');
  showToast(`${slot.file?.name || 'Media'}: ${message}`);
}

function registerMediaEvents(slot) {
  slot.video.addEventListener('loadedmetadata', () => {
    updateSlotAspectRatio(slot, slot.video.videoWidth, slot.video.videoHeight);
    slot.ready = true;
    slot.video.playbackRate = state.playbackRate;
    updateTransportAvailability();
    updateTimeline(true);
  });

  slot.video.addEventListener('canplay', () => {
    slot.ready = true;
    markBufferRecovered(slot);
    updateTransportAvailability();
  });

  slot.video.addEventListener('playing', () => markBufferRecovered(slot));
  slot.video.addEventListener('seeked', () => markBufferRecovered(slot));
  slot.video.addEventListener('waiting', () => holdSynchronizedPlaybackForBuffering(slot));
  slot.video.addEventListener('stalled', () => holdSynchronizedPlaybackForBuffering(slot));

  slot.video.addEventListener('ended', handleMediaEnded);
  slot.video.addEventListener('error', () => handleMediaError(slot));
  slot.image.addEventListener('load', () => {
    updateSlotAspectRatio(slot, slot.image.naturalWidth, slot.image.naturalHeight);
  });
  slot.stage.addEventListener('click', () => {
    hideFullscreenControlsFromScreenClick();
    window.clearTimeout(slot.videoClickTimer);
    slot.videoClickTimer = null;
    if (state.mode === 'single') {
      slot.videoClickTimer = window.setTimeout(() => {
        slot.videoClickTimer = null;
        switchSingleSide();
      }, 250);
    }
  });
  slot.stage.addEventListener('dblclick', (event) => {
    event.preventDefault();
    window.clearTimeout(slot.videoClickTimer);
    slot.videoClickTimer = null;
    void toggleBorderlessFullscreen();
  });
  slot.stage.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    state.nextSide = slot.side;
    dom.filePicker.click();
  });
  slot.stage.addEventListener('wheel', handleMediaZoomWheel, { passive: false });
}

for (const side of SIDES) {
  registerMediaEvents(slots[side]);
}

dom.filePicker.addEventListener('change', (event) => loadFiles(event.target.files));
dom.clearButton.addEventListener('click', clearAll);
dom.playButton.addEventListener('click', togglePlayback);
dom.stepBackButton.addEventListener('click', () => stepFrame(-1));
dom.stepForwardButton.addEventListener('click', () => stepFrame(1));

dom.timeline.addEventListener('pointerdown', () => {
  state.seeking = true;
});
dom.timeline.addEventListener('input', () => {
  const duration = comparisonDuration();
  const target = (Number(dom.timeline.value) / TIMELINE_STEPS) * duration;
  seekAll(target);
});
function finishTimelineSeek() {
  if (!state.seeking) {
    return;
  }
  state.seeking = false;
  updateTimeline(true);
  if (state.playing) {
    void performHardResync('timeline seek');
  }
}

dom.timeline.addEventListener('change', finishTimelineSeek);
dom.timeline.addEventListener('pointerup', finishTimelineSeek);
dom.timeline.addEventListener('pointercancel', finishTimelineSeek);

dom.rateSelect.addEventListener('change', () => {
  state.playbackRate = Number(dom.rateSelect.value) || 1;
  applyPlaybackRate();
  setStatus(`Playback speed set to ${state.playbackRate}×.`);
});

dom.muteButton.addEventListener('click', toggleAudioMuted);
dom.audioSourceSelect.addEventListener('change', () => {
  state.audioSource = dom.audioSourceSelect.value === 'right' ? 'right' : 'left';
  state.preferredAudioSource = state.audioSource;
  applyAudioState();
  setStatus(`${state.audioSource === 'left' ? 'Left' : 'Right'} video selected for audio.`);
});
dom.volumeSlider.addEventListener('input', () => {
  state.volume = clamp(Number(dom.volumeSlider.value) / 100, 0, 1);
  applyAudioState();
});

dom.splitModeButton.addEventListener('click', () => setMode('split'));
dom.overlapModeButton.addEventListener('click', () => setMode('overlap'));
dom.singleModeButton.addEventListener('click', () => setMode('single'));
dom.horizontalLayoutButton.addEventListener('click', () => setLayout('horizontal'));
dom.verticalLayoutButton.addEventListener('click', () => setLayout('vertical'));
dom.zoomResetButton.addEventListener('click', () => {
  resetZoomToViewDefault();
  setStatus(
    `Synchronized video zoom reset to ${Math.round(defaultZoomForView() * 100)}%.`
  );
});
dom.statsButton.addEventListener('click', toggleStats);
dom.helpButton.addEventListener('click', () => window.desktopApi.openHelp());

dom.wipeDivider.addEventListener('pointerdown', (event) => {
  dom.wipeDivider.setPointerCapture(event.pointerId);
  queueDividerFromPointer(event.clientX);
});
dom.wipeDivider.addEventListener('pointermove', (event) => {
  if (dom.wipeDivider.hasPointerCapture(event.pointerId)) {
    queueDividerFromPointer(event.clientX);
  }
});
dom.wipeDivider.addEventListener('keydown', (event) => {
  const amount = event.shiftKey ? 5 : 1;
  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    setDividerPercent(state.dividerPercent - amount);
  } else if (event.key === 'ArrowRight') {
    event.preventDefault();
    setDividerPercent(state.dividerPercent + amount);
  } else if (event.key === 'Home' || event.key === 'ArrowUp') {
    event.preventDefault();
    setDividerPercent(50);
  }
});

let dragDepth = 0;
let dragOverlayFailsafeTimer = null;

function isFileDrag(event) {
  const types = Array.from(event.dataTransfer?.types || []);
  return types.includes('Files');
}

function showDropOverlay() {
  window.clearTimeout(dragOverlayFailsafeTimer);
  dom.dropZone.hidden = false;
  dom.dropZone.setAttribute('aria-hidden', 'false');
}

function hideDropOverlay() {
  window.clearTimeout(dragOverlayFailsafeTimer);
  dragOverlayFailsafeTimer = null;
  dragDepth = 0;
  dom.dropZone.hidden = true;
  dom.dropZone.setAttribute('aria-hidden', 'true');
}

function armDropOverlayFailsafe() {
  window.clearTimeout(dragOverlayFailsafeTimer);
  dragOverlayFailsafeTimer = window.setTimeout(hideDropOverlay, 1500);
}

window.addEventListener('dragenter', (event) => {
  if (!isFileDrag(event)) {
    return;
  }

  event.preventDefault();
  dragDepth += 1;
  showDropOverlay();
  armDropOverlayFailsafe();
});

window.addEventListener('dragover', (event) => {
  if (!isFileDrag(event)) {
    return;
  }

  event.preventDefault();
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'copy';
  }
  showDropOverlay();
  armDropOverlayFailsafe();
});

window.addEventListener('dragleave', (event) => {
  if (!isFileDrag(event)) {
    return;
  }

  event.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);

  const leftWindow = event.relatedTarget === null
    && (
      event.clientX <= 0
      || event.clientY <= 0
      || event.clientX >= window.innerWidth
      || event.clientY >= window.innerHeight
    );

  if (dragDepth === 0 || leftWindow) {
    hideDropOverlay();
  }
});

window.addEventListener('drop', (event) => {
  event.preventDefault();
  const files = Array.from(event.dataTransfer?.files || []);
  hideDropOverlay();

  if (files.length > 0) {
    void loadFiles(files).catch((error) => {
      console.error('Dropped media could not be loaded:', error);
      showToast('The dropped media could not be loaded.');
    }).finally(hideDropOverlay);
  }
});

window.addEventListener('blur', hideDropOverlay);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    hideDropOverlay();
  }
});

for (const activityEvent of ['pointermove', 'pointerdown']) {
  window.addEventListener(activityEvent, handleFullscreenPointerActivity, { passive: true });
}
window.addEventListener('touchstart', handleFullscreenPointerActivity, { passive: true });

window.addEventListener('keydown', (event) => {
  const playbackSpace = event.code === 'Space' || event.key === ' ';
  if (!playbackSpace) {
    state.lastFullscreenKeyboardActivityAt = performance.now();
    showFullscreenControls({ autoHide: !state.fullscreenPointerNearBottom });
  }

  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) {
    return;
  }

  if (playbackSpace || event.key.toLowerCase() === 'k') {
    event.preventDefault();
    togglePlayback();
  } else if (event.key === ',') {
    event.preventDefault();
    stepFrame(-1);
  } else if (event.key === '.') {
    event.preventDefault();
    stepFrame(1);
  } else if (event.key === 'ArrowLeft' && state.mode !== 'overlap') {
    event.preventDefault();
    seekAll(currentComparisonTime() - (event.shiftKey ? 5 : 1));
    if (state.playing) {
      void performHardResync('keyboard seek');
    }
  } else if (event.key === 'ArrowRight' && state.mode !== 'overlap') {
    event.preventDefault();
    seekAll(currentComparisonTime() + (event.shiftKey ? 5 : 1));
    if (state.playing) {
      void performHardResync('keyboard seek');
    }
  } else if (event.key.toLowerCase() === 'm') {
    event.preventDefault();
    toggleAudioMuted();
  }
});

window.addEventListener('beforeunload', () => {
  window.clearTimeout(state.fullscreenControlsTimer);
  state.fullscreenControlsTimer = null;
  window.clearTimeout(state.fullscreenCursorTimer);
  state.fullscreenCursorTimer = null;
  state.removeFullscreenListener?.();
  state.removeFullscreenListener = null;
  window.desktopApi.setPlaybackActive(false);
  for (const side of SIDES) {
    if (slots[side].objectUrl) {
      URL.revokeObjectURL(slots[side].objectUrl);
    }
  }
});

function gpuDecodeIsAccelerated(status) {
  return new Set([
    'enabled',
    'enabled_on',
    'enabled_force',
    'enabled_force_on',
    'enabled_readback',
  ]).has(status);
}

function maybeWarnAboutDecodeCapacity() {
  const videos = getLoadedVideos();
  if (
    state.performanceWarningShown
    || videos.length < 2
    || !state.runtimeInfo
  ) {
    return;
  }

  const videoDecode = state.runtimeInfo.gpu?.video_decode;
  const hardwareDecode = gpuDecodeIsAccelerated(videoDecode);
  const demandingStream = videos.some((slot) => {
    const video = slot.probe?.video;
    if (!video) {
      return false;
    }
    const pixelsPerSecond = video.width * video.height * (video.frameRate || 30);
    return (
      pixelsPerSecond >= 1920 * 1080 * 60
      || video.bitDepth >= 10
      || video.codecName === 'hevc'
      || video.codecName === 'av1'
    );
  });
  const capabilityConcern = videos.some((slot) => (
    slot.capability?.smooth === false
    || slot.capability?.powerEfficient === false
  ));

  if (!hardwareDecode && (demandingStream || capabilityConcern)) {
    state.performanceWarningShown = true;
    showToast(
      'Hardware video decoding is unavailable. Two high-resolution, HEVC, HDR, or high-frame-rate streams may stutter regardless of synchronization. Update the GPU driver and ensure Windows is using the high-performance GPU.'
    );
  }
}

async function loadRuntimeInfo() {
  try {
    const runtime = await window.desktopApi.getRuntimeInfo();
    state.runtimeInfo = runtime;
    for (const slot of getLoadedVideos()) {
      renderProbe(slot);
    }
    renderStats();
    maybeWarnAboutDecodeCapacity();
  } catch (error) {
    console.warn('Runtime information is unavailable:', error);
  }
}

clearAll();
void initializeBorderlessFullscreen();
void loadRuntimeInfo();
