import { ArrowRight, LoaderCircle, Mic, RotateCcw, Send, Square, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { PublicUser } from '../../../shared/types.js';
import { ApiError } from '../api/client';
import { VoicePlayer } from '../components/VoicePlayer';
import { newClientRequestId } from '../lib/id';
import { createRequest } from '../lib/sync';
import { canRecord, MAX_SECONDS, uploadVoice, VoiceRecorder, type Recording } from '../lib/voice';
import { toast } from '../store/toasts';
import { num, VOICE_ITEM } from './ar';
import { PlacePicker } from './PlacePicker';
import { useMomTitle } from './useMomTitle';

type Stage = 'ready' | 'starting' | 'recording' | 'recorded' | 'sending';

const clock = (s: number) => `${num(Math.floor(s / 60))}:${num(s % 60).padStart(2, num(0))}`;

/** Mom says what she needs instead of typing it: tap, talk, tap, send. */
export function VoicePage({ me }: { me: PublicUser }) {
  useMomTitle('رسالة صوتية');
  const navigate = useNavigate();
  const [stage, setStage] = useState<Stage>('ready');
  const [seconds, setSeconds] = useState(0);
  const [recording, setRecording] = useState<Recording | null>(null);
  const [place, setPlace] = useState(me.prefs.lastLocation ?? '');
  const [urgent, setUrgent] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const recorder = useRef<VoiceRecorder | null>(null);
  // Kept across retries, so a second try neither uploads twice nor sends twice.
  const uploaded = useRef<{ recording: Recording; path: string } | null>(null);
  const clientRequestId = useMemo(() => newClientRequestId(), []);

  // Count the seconds while recording, and stop at the limit.
  useEffect(() => {
    if (stage !== 'recording') return;
    const started = Date.now();
    setSeconds(0);
    const timer = setInterval(() => {
      const s = Math.floor((Date.now() - started) / 1000);
      setSeconds(s);
      if (s >= MAX_SECONDS) void stop();
    }, 250);
    return () => clearInterval(timer);
  }, [stage]);

  // Let go of the microphone when leaving the screen.
  useEffect(() => () => recorder.current?.cancel(), []);

  const start = async () => {
    setProblem(null);
    setStage('starting');
    try {
      recorder.current = new VoiceRecorder();
      await recorder.current.start();
      setStage('recording');
    } catch (err) {
      recorder.current = null;
      setStage(recording ? 'recorded' : 'ready');
      const name = (err as { name?: string }).name;
      setProblem(
        name === 'NotAllowedError' || name === 'SecurityError'
          ? 'الهاتف لم يسمح باستخدام الميكروفون. اسمحي به لهذا التطبيق من إعدادات الهاتف ثم حاولي مرة أخرى.'
          : 'لم نستطع تشغيل الميكروفون. حاولي مرة أخرى.',
      );
    }
  };

  async function stop() {
    const r = recorder.current;
    if (!r) return;
    recorder.current = null;
    try {
      const rec = await r.stop();
      setRecording(rec);
      setStage('recorded');
    } catch {
      setStage('ready');
      setProblem('لم يُسجَّل شيء. حاولي مرة أخرى.');
    }
  }

  const send = async () => {
    if (!recording || stage === 'sending') return;
    if (!place.trim()) {
      setProblem('اختاري أين أنتِ.');
      return;
    }
    setProblem(null);
    setStage('sending');
    try {
      let path = uploaded.current?.recording === recording ? uploaded.current.path : null;
      if (!path) {
        path = await uploadVoice(me.id, recording);
        uploaded.current = { recording, path };
      }
      const request = await createRequest({
        clientRequestId,
        title: VOICE_ITEM.title,
        description: '',
        location: place.trim(),
        priority: urgent ? 'urgent' : 'normal',
        notes: '',
        quickType: null,
        voicePath: path,
        voiceSeconds: recording.seconds,
      });
      toast({ kind: 'success', title: 'تم إرسال رسالتك ✓' });
      navigate(`/requests/${request.id}`, { replace: true });
    } catch (err) {
      setStage('recorded');
      const offline = !navigator.onLine || (err instanceof ApiError ? err.isNetwork : /fetch|network/i.test(String((err as Error)?.message)));
      setProblem(offline ? 'لا يوجد إنترنت الآن. رسالتك محفوظة هنا، حاولي الإرسال عندما يعود الاتصال.' : 'لم نستطع إرسال الرسالة. حاولي مرة أخرى.');
    }
  };

  if (!canRecord()) {
    return (
      <div className="m-page">
        <Link to="/" className="m-back">
          <ArrowRight aria-hidden="true" /> رجوع
        </Link>
        <p className="m-problem">هذا الهاتف لا يسمح بالتسجيل الصوتي هنا. استخدمي الأزرار أو «شيء آخر».</p>
      </div>
    );
  }

  const recordingNow = stage === 'recording';
  return (
    <div className="m-page">
      <Link to="/" className="m-back">
        <ArrowRight aria-hidden="true" /> رجوع
      </Link>

      {stage !== 'recorded' && stage !== 'sending' ? (
        <section className="m-record">
          <button
            type="button"
            className={`m-mic${recordingNow ? ' on' : ''}`}
            onClick={() => (recordingNow ? void stop() : void start())}
            disabled={stage === 'starting'}
            aria-label={recordingNow ? 'إيقاف التسجيل' : 'ابدئي التسجيل'}
          >
            {stage === 'starting' ? <LoaderCircle className="spin" /> : recordingNow ? <Square /> : <Mic />}
          </button>
          {recordingNow ? (
            <>
              <p className="m-record-time" aria-live="off">
                {clock(seconds)}
              </p>
              <p className="m-record-hint">تكلّمي الآن… واضغطي عندما تنتهين</p>
            </>
          ) : (
            <>
              <h1 className="m-hello">قولي ما تحتاجينه</h1>
              <p className="m-record-hint">اضغطي على الميكروفون وتكلّمي</p>
            </>
          )}
        </section>
      ) : (
        recording && (
          <>
            <section className="m-card m-recorded">
              <span className="m-icon tone-default" aria-hidden="true">
                <Mic />
              </span>
              <span className="m-grow">
                <span className="m-card-title">رسالتك جاهزة</span>
                <span className="m-row">
                  <VoicePlayer voice={{ seconds: recording.seconds }} src={recording.url} lang="ar" className="m-btn m-btn-small m-btn-plain" />
                  <button
                    type="button"
                    className="m-btn m-btn-small m-btn-plain"
                    disabled={stage === 'sending'}
                    onClick={() => {
                      setRecording(null);
                      uploaded.current = null;
                      void start();
                    }}
                  >
                    <RotateCcw aria-hidden="true" /> أعيدي التسجيل
                  </button>
                </span>
              </span>
            </section>

            <PlacePicker value={place} onChange={setPlace} />

            <div className="m-extras">
              <button type="button" className="m-toggle m-urgent" aria-pressed={urgent} onClick={() => setUrgent((u) => !u)}>
                <TriangleAlert aria-hidden="true" /> مستعجل
              </button>
            </div>

            <button type="button" className="m-btn m-btn-send" onClick={() => void send()} disabled={stage === 'sending'}>
              {stage === 'sending' ? <LoaderCircle className="spin" aria-hidden="true" /> : <Send aria-hidden="true" />}
              {stage === 'sending' ? 'جارٍ الإرسال…' : 'أرسل'}
            </button>
          </>
        )
      )}

      {problem && (
        <p className="m-problem" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}
