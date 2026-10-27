import { BellRing, Download, LogOut, Smartphone, Type, Volume2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { PublicUser } from '../../../shared/types.js';
import { mx } from '../api/mx';
import { Sheet } from '../components/Sheet';
import { promptInstall, useInstall } from '../lib/install';
import { isIos, sendTestPush } from '../lib/push';
import { playChime } from '../lib/sound';
import { applyUpdate } from '../lib/sw';
import { signOut } from '../lib/sync';
import { usePush } from '../lib/usePush';
import { setState, useApp } from '../store/app';
import { toast } from '../store/toasts';
import { setTextSize, useTextSize, type TextSize } from './textSize';
import { useMomTitle } from './useMomTitle';

function Row({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="m-card m-setting">
      <span className="m-icon tone-default" aria-hidden="true">
        {icon}
      </span>
      <div className="m-grow">
        <h2 className="m-card-title">{title}</h2>
        {children}
      </div>
    </section>
  );
}

function Notifications() {
  const push = usePush('ar');
  const [testing, setTesting] = useState(false);
  const s = push.state.kind;

  return (
    <Row icon={<BellRing />} title="الإشعارات">
      {s === 'checking' && <p className="m-card-status">…</p>}
      {s === 'on' && (
        <>
          <p className="m-card-status">تعمل على هذا الهاتف ✓</p>
          <div className="m-row">
            <button
              type="button"
              className="m-btn m-btn-small"
              disabled={testing}
              onClick={async () => {
                setTesting(true);
                try {
                  const { delivered } = await sendTestPush();
                  toast({ kind: delivered ? 'success' : 'warning', title: delivered ? 'أُرسل إشعار تجريبي' : 'لم يصل الإشعار التجريبي' });
                } catch {
                  toast({ kind: 'error', title: 'لم نستطع إرسال الإشعار التجريبي' });
                } finally {
                  setTesting(false);
                }
              }}
            >
              جرّبي إشعاراً
            </button>
            <button type="button" className="m-btn m-btn-small m-btn-plain" disabled={push.busy} onClick={() => void push.disable()}>
              إيقاف
            </button>
          </div>
        </>
      )}
      {(s === 'off' || s === 'unknown') && (
        <>
          <p className="m-card-status">متوقفة. شغّليها لتعرفي متى يصل طلبك.</p>
          <button type="button" className="m-btn m-btn-small" disabled={push.busy} onClick={() => void push.enable()}>
            تشغيل الإشعارات
          </button>
        </>
      )}
      {s === 'denied' && <p className="m-card-status">ممنوعة في إعدادات الهاتف. اسمحي بالإشعارات لهذا التطبيق من الإعدادات.</p>}
      {s === 'needs-install' && (
        <p className="m-card-status">أضيفي التطبيق إلى الشاشة الرئيسية أولاً: اضغطي زر المشاركة ثم «إضافة إلى الشاشة الرئيسية»، وافتحيه من هناك.</p>
      )}
      {s === 'unsupported' && <p className="m-card-status">هذا المتصفح لا يدعم الإشعارات.</p>}
    </Row>
  );
}

function Sound({ me }: { me: PublicUser }) {
  const [busy, setBusy] = useState(false);
  const on = me.prefs.sound;
  return (
    <Row icon={<Volume2 />} title="الصوت">
      <p className="m-card-status">{on ? 'صوت عند كل تحديث' : 'بدون صوت'}</p>
      <button
        type="button"
        className="m-btn m-btn-small m-btn-plain"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const { user } = await mx.updateMe({ prefs: { sound: !on } });
            setState({ me: user });
            if (!on) playChime('update');
          } catch {
            toast({ kind: 'error', title: 'لم يُحفظ', body: 'تأكدي من الإنترنت وحاولي مرة أخرى.' });
          } finally {
            setBusy(false);
          }
        }}
      >
        {on ? 'إيقاف الصوت' : 'تشغيل الصوت'}
      </button>
    </Row>
  );
}

const SIZES: { value: TextSize; label: string }[] = [
  { value: 'normal', label: 'عادي' },
  { value: 'large', label: 'كبير' },
  { value: 'xlarge', label: 'أكبر' },
];

function TextSizeRow() {
  const size = useTextSize();
  return (
    <Row icon={<Type />} title="حجم الكتابة">
      <div className="m-row" role="radiogroup" aria-label="حجم الكتابة">
        {SIZES.map((s) => (
          <button key={s.value} type="button" role="radio" aria-checked={size === s.value} className="m-choice" onClick={() => setTextSize(s.value)}>
            {s.label}
          </button>
        ))}
      </div>
    </Row>
  );
}

function Install() {
  const { installed, canPrompt } = useInstall();
  if (installed) return null;
  return (
    <Row icon={<Smartphone />} title="ضعي التطبيق على الشاشة الرئيسية">
      {canPrompt ? (
        <button type="button" className="m-btn m-btn-small" onClick={() => void promptInstall()}>
          <Download aria-hidden="true" /> تثبيت
        </button>
      ) : (
        <p className="m-card-status">
          {isIos()
            ? 'في سفاري: اضغطي زر المشاركة ثم «إضافة إلى الشاشة الرئيسية».'
            : 'من قائمة المتصفح (⋮) اختاري «تثبيت التطبيق» أو «إضافة إلى الشاشة الرئيسية».'}
        </p>
      )}
    </Row>
  );
}

export function MomSettings({ me }: { me: PublicUser }) {
  useMomTitle('الإعدادات');
  const updateAvailable = useApp((s) => s.updateAvailable);
  const outbox = useApp((s) => s.outbox);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  return (
    <div className="m-page">
      <h1 className="m-hello">الإعدادات</h1>
      <Notifications />
      <Sound me={me} />
      <TextSizeRow />
      <Install />
      {updateAvailable && (
        <button type="button" className="m-btn" onClick={() => void applyUpdate()}>
          تحديث التطبيق
        </button>
      )}
      <button type="button" className="m-btn m-btn-plain m-btn-danger" onClick={() => setConfirm(true)}>
        <LogOut aria-hidden="true" /> تسجيل الخروج
      </button>

      <Sheet
        open={confirm}
        onClose={() => setConfirm(false)}
        busy={busy}
        title="تسجيل الخروج؟"
        closeLabel="إغلاق"
        description={
          outbox.length > 0
            ? 'لديك طلب لم يُرسل بعد. إذا خرجتِ الآن فلن يُرسل.'
            : 'لن تصلك الإشعارات على هذا الهاتف حتى تدخلي مرة أخرى.'
        }
        actions={
          <>
            <button type="button" className="m-btn m-btn-plain" onClick={() => setConfirm(false)} disabled={busy}>
              لا
            </button>
            <button
              type="button"
              className="m-btn m-btn-danger"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await signOut();
                } catch {
                  toast({ kind: 'error', title: 'لم يتم تسجيل الخروج', body: 'تأكدي من الإنترنت وحاولي مرة أخرى.' });
                  setBusy(false);
                }
              }}
            >
              {busy ? 'جارٍ الخروج…' : 'نعم، اخرجي'}
            </button>
          </>
        }
      />
    </div>
  );
}
