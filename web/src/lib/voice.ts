import { supabase } from '../api/client';
import { newClientRequestId } from './id';

// Voice messages: Mom records what she needs, it's uploaded to a private
// storage bucket (only she and the runner can read it, see the
// mx-voice policies in supabase/migrations), and the runner plays it back.

const BUCKET = 'mx-voice';
export const MAX_SECONDS = 60;

export function canRecord(): boolean {
  return typeof MediaRecorder !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);
}

/** MP4/AAC plays everywhere (iPhone and Android), so it's preferred when the browser can record it. */
function pickMimeType(): string {
  const options = ['audio/mp4', 'audio/aac', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  return options.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
}

function extensionFor(type: string): string {
  if (type.includes('mp4') || type.includes('m4a')) return 'm4a';
  if (type.includes('aac')) return 'aac';
  if (type.includes('mpeg')) return 'mp3';
  if (type.includes('ogg')) return 'ogg';
  return 'webm';
}

export interface Recording {
  blob: Blob;
  /** The audio type without codec details, e.g. "audio/mp4". */
  type: string;
  seconds: number;
  /** A local address for listening back before sending. */
  url: string;
}

export class VoiceRecorder {
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;

  /** Asks for the microphone (the first time) and starts recording. */
  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const mimeType = pickMimeType();
    this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    this.chunks = [];
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.start(250);
    this.startedAt = Date.now();
  }

  stop(): Promise<Recording> {
    return new Promise((resolve, reject) => {
      const recorder = this.recorder;
      if (!recorder || recorder.state === 'inactive') {
        reject(new Error('Not recording'));
        return;
      }
      recorder.onstop = () => {
        this.release();
        const type = (recorder.mimeType || this.chunks[0]?.type || 'audio/webm').split(';')[0];
        const blob = new Blob(this.chunks, { type });
        const seconds = Math.min(MAX_SECONDS, Math.max(1, Math.round((Date.now() - this.startedAt) / 1000)));
        resolve({ blob, type, seconds, url: URL.createObjectURL(blob) });
      };
      recorder.stop();
    });
  }

  /** Stops without keeping anything, and lets go of the microphone. */
  cancel(): void {
    try {
      if (this.recorder?.state !== 'inactive') this.recorder?.stop();
    } catch {
      /* already stopped */
    }
    this.release();
  }

  private release(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}

/** Uploads a recording into the person's own folder and returns its path. */
export async function uploadVoice(userId: string, recording: Recording): Promise<string> {
  const path = `${userId}/${newClientRequestId()}.${extensionFor(recording.type)}`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, recording.blob, { contentType: recording.type, upsert: false });
  if (error) throw error;
  return path;
}

const urls = new Map<string, { url: string; until: number }>();

/** A short-lived address to play a voice message from. */
export async function voiceUrl(path: string): Promise<string> {
  const cached = urls.get(path);
  if (cached && cached.until > Date.now()) return cached.url;
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 60 * 60);
  if (error || !data) throw error ?? new Error('No address for this voice message');
  urls.set(path, { url: data.signedUrl, until: Date.now() + 50 * 60_000 });
  return data.signedUrl;
}
