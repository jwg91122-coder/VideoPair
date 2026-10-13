'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
function resolveFfprobePath() {
  if (process.env.FFPROBE_PATH) {
    return process.env.FFPROBE_PATH;
  }

  const ffprobeInstaller = require('@ffprobe-installer/ffprobe');
  return ffprobeInstaller.path.replace(
    /app\.asar([/\\])/,
    'app.asar.unpacked$1'
  );
}

const FFPROBE_PATH = resolveFfprobePath();

const FRAME_RATE_FALLBACK = 0;

function parseRatio(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== 'string' || !value) {
    return FRAME_RATE_FALLBACK;
  }

  const [numerator, denominator = '1'] = value.split('/').map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return FRAME_RATE_FALLBACK;
  }
  return numerator / denominator;
}

function parseInteger(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function inferBitDepth(stream) {
  const declared = parseInteger(stream.bits_per_raw_sample || stream.bits_per_sample);
  if (declared > 0) {
    return declared;
  }

  const pixelFormat = String(stream.pix_fmt || '');
  const match = pixelFormat.match(/(?:p|gbrp|gray)(10|12|14|16)(?:le|be)?$/i)
    || pixelFormat.match(/(?:^|[^0-9])(10|12|14|16)(?:le|be)?$/i);
  return match ? Number(match[1]) : 8;
}

function normalizeSideData(sideDataList) {
  if (!Array.isArray(sideDataList)) {
    return [];
  }

  return sideDataList.map((item) => ({
    type: item.side_data_type || '',
    maxContent: item.max_content || item.max_content_light_level || null,
    maxAverage: item.max_average || item.max_pic_average_light_level || null,
    minLuminance: item.min_luminance || null,
    maxLuminance: item.max_luminance || null,
    dvProfile: item.dv_profile ?? null,
    dvLevel: item.dv_level ?? null,
  }));
}

function detectDynamicRange(stream, bitDepth, sideData) {
  const transfer = String(stream.color_transfer || '').toLowerCase();
  const primaries = String(stream.color_primaries || '').toLowerCase();
  const codecTag = String(stream.codec_tag_string || '').toLowerCase();
  const sideDataText = sideData.map((item) => item.type).join(' ').toLowerCase();

  if (
    codecTag.startsWith('dv')
    || sideDataText.includes('dovi')
    || sideDataText.includes('dolby vision')
  ) {
    return {
      label: 'Dolby Vision',
      isHdr: true,
      transfer: 'pq',
      gamut: 'rec2020',
      // Dolby Vision is proprietary and is not represented by the standardized
      // MediaCapabilities HDR metadata enum.
      metadataType: undefined,
    };
  }

  if (transfer === 'smpte2084' || transfer === 'smpte-st-2084') {
    const dynamicMetadata = sideDataText.includes('smpte 2094-40')
      || sideDataText.includes('hdr10+');
    return {
      label: dynamicMetadata ? 'HDR10+' : 'HDR10 / PQ',
      isHdr: true,
      transfer: 'pq',
      gamut: primaries.includes('2020') ? 'rec2020' : undefined,
      metadataType: dynamicMetadata ? 'smpteSt2094-40' : 'smpteSt2086',
    };
  }

  if (transfer === 'arib-std-b67' || transfer === 'hlg') {
    return {
      label: 'HLG',
      isHdr: true,
      transfer: 'hlg',
      gamut: primaries.includes('2020') ? 'rec2020' : undefined,
      metadataType: undefined,
    };
  }

  const wideColor = primaries.includes('2020') || primaries.includes('p3');
  return {
    label: wideColor && bitDepth >= 10 ? 'Wide color (SDR transfer)' : 'SDR',
    isHdr: false,
    transfer: 'srgb',
    gamut: primaries.includes('2020') ? 'rec2020' : primaries.includes('p3') ? 'p3' : 'srgb',
    metadataType: undefined,
  };
}

function normalizeVideoStream(stream) {
  if (!stream) {
    return null;
  }

  const frameRate = parseRatio(stream.avg_frame_rate) || parseRatio(stream.r_frame_rate);
  const bitDepth = inferBitDepth(stream);
  const sideData = normalizeSideData(stream.side_data_list);
  const dynamicRange = detectDynamicRange(stream, bitDepth, sideData);

  return {
    index: stream.index,
    codecName: stream.codec_name || 'unknown',
    codecLongName: stream.codec_long_name || '',
    codecTag: stream.codec_tag_string || '',
    profile: stream.profile || '',
    level: parseInteger(stream.level),
    width: parseInteger(stream.width),
    height: parseInteger(stream.height),
    codedWidth: parseInteger(stream.coded_width),
    codedHeight: parseInteger(stream.coded_height),
    pixelFormat: stream.pix_fmt || '',
    bitDepth,
    frameRate,
    averageFrameRate: stream.avg_frame_rate || '',
    realFrameRate: stream.r_frame_rate || '',
    frameCount: parseInteger(stream.nb_frames),
    bitrate: parseInteger(stream.bit_rate),
    colorRange: stream.color_range || '',
    colorSpace: stream.color_space || '',
    colorTransfer: stream.color_transfer || '',
    colorPrimaries: stream.color_primaries || '',
    chromaLocation: stream.chroma_location || '',
    fieldOrder: stream.field_order || '',
    startTime: Number(stream.start_time) || 0,
    duration: Number(stream.duration) || 0,
    dynamicRange,
    sideData,
  };
}

function normalizeAudioStream(stream) {
  if (!stream) {
    return null;
  }
  return {
    index: stream.index,
    codecName: stream.codec_name || 'unknown',
    codecLongName: stream.codec_long_name || '',
    profile: stream.profile || '',
    sampleRate: parseInteger(stream.sample_rate),
    channels: parseInteger(stream.channels),
    channelLayout: stream.channel_layout || '',
    bitrate: parseInteger(stream.bit_rate),
  };
}

async function probeMedia(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new TypeError('A valid local media path is required.');
  }

  const stats = await fs.stat(filePath);
  if (!stats.isFile()) {
    throw new Error('The selected item is not a regular file.');
  }

  const { stdout } = await execFileAsync(
    FFPROBE_PATH,
    [
      '-hide_banner',
      '-v', 'error',
      '-show_format',
      '-show_streams',
      '-print_format', 'json',
      filePath,
    ],
    {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      timeout: 20_000,
      windowsHide: true,
    }
  );

  const metadata = JSON.parse(stdout);
  const streams = Array.isArray(metadata.streams) ? metadata.streams : [];
  const format = metadata.format || {};
  const videoStream = streams.find((stream) => stream.codec_type === 'video');
  const audioStream = streams.find((stream) => stream.codec_type === 'audio');

  return {
    name: path.basename(filePath),
    size: stats.size,
    container: {
      names: String(format.format_name || '').split(',').filter(Boolean),
      longName: format.format_long_name || '',
      duration: Number(format.duration) || 0,
      bitrate: parseInteger(format.bit_rate),
      startTime: Number(format.start_time) || 0,
      tags: format.tags || {},
    },
    video: normalizeVideoStream(videoStream),
    audio: normalizeAudioStream(audioStream),
  };
}

module.exports = {
  probeMedia,
};
