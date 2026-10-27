import { CircleAlert, CloudOff, Eye, EyeOff, Languages, LoaderCircle, Lock, MapPinned, Radio, Zap } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { ApiError } from '../api/client';
import { BrandMark } from '../components/BrandMark';
import { useTitle } from '../lib/hooks';
import { keys, readJson, writeJson } from '../lib/storage';
import { signIn } from '../lib/sync';
import { useApp } from '../store/app';

type Lang = 'en' | 'ar';

const TEXT = {
  en: {
    title: 'Sign in',
    heroTitle: 'Anything you need, brought right to you.',
    hero: ['Ask for something in seconds', 'Follow every step until it arrives', 'Live updates on every device'],
    tagline: 'Your personal family delivery service',
    expired: 'You’ve been signed out. Please sign in again.',
    offline: 'You’re offline. Connect to the internet to sign in.',
    username: 'Username',
    password: 'Password',
    needUsername: 'Enter your username.',
    needPassword: 'Enter your password.',
    show: 'Show password',
    hide: 'Hide password',
    signIn: 'Sign in',
    signingIn: 'Signing in…',
    foot: 'A private app for your family. Accounts are set up by whoever runs MomExpress.',
    other: 'عربي',
    error: (err: unknown) => (err instanceof ApiError ? err.message : 'Something went wrong. Please try again.'),
  },
  ar: {
    title: 'الدخول',
    heroTitle: 'كل ما تحتاجينه، يصلك إلى مكانك.',
    hero: ['اطلبي ما تريدين بضغطة واحدة', 'اعرفي متى يصل طلبك', 'كل شيء يتحدّث مباشرة'],
    tagline: 'خدمة التوصيل الخاصة بالعائلة',
    expired: 'تم تسجيل خروجك. ادخلي مرة أخرى من فضلك.',
    offline: 'لا يوجد إنترنت. اتصلي بالإنترنت لتدخلي.',
    username: 'اسم المستخدم',
    password: 'كلمة المرور',
    needUsername: 'اكتبي اسم المستخدم.',
    needPassword: 'اكتبي كلمة المرور.',
    show: 'إظهار كلمة المرور',
    hide: 'إخفاء كلمة المرور',
    signIn: 'دخول',
    signingIn: 'جارٍ الدخول…',
    foot: 'تطبيق خاص بالعائلة.',
    other: 'English',
    error: (err: unknown) => {
      if (!(err instanceof ApiError)) return 'حدث خطأ. حاولي مرة أخرى.';
      if (err.isNetwork) return 'لا يوجد اتصال بالإنترنت. حاولي مرة أخرى.';
      if (err.code === 'invalid_credentials') return 'اسم المستخدم أو كلمة المرور غير صحيحة.';
      if (err.code === 'rate_limited') return 'محاولات كثيرة. انتظري قليلاً ثم حاولي مرة أخرى.';
      return 'لم نستطع الدخول. حاولي مرة أخرى.';
    },
  },
};

export function LoginPage() {
  // Arabic unless this device was last used by the runner (see startSession).
  const [lang, setLang] = useState<Lang>(() => readJson<Lang>(keys.lang) ?? 'ar');
  const t = TEXT[lang];
  useTitle(t.title);
  const expired = useApp((s) => s.signedOutReason === 'expired');
  const offline = useApp((s) => s.connection === 'offline');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    const html = document.documentElement;
    html.lang = lang;
    html.dir = lang === 'ar' ? 'rtl' : 'ltr';
    return () => {
      html.lang = 'en';
      html.dir = 'ltr';
    };
  }, [lang]);

  const switchLang = () => {
    const next = lang === 'ar' ? 'en' : 'ar';
    writeJson(keys.lang, next);
    setLang(next);
    setFieldErrors({});
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const errs: Record<string, string> = {};
    if (!username.trim()) errs.username = t.needUsername;
    if (!password) errs.password = t.needPassword;
    setFieldErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    setError(null);
    try {
      await signIn(username.trim(), password);
    } catch (err) {
      setError(err ?? new Error());
      setBusy(false);
    }
  };

  return (
    <div className={`login${lang === 'ar' ? ' login-ar' : ''}`}>
      <section className="login-hero" aria-hidden="true">
        <div className="login-hero-inner">
          <BrandMark size={72} />
          <h2>{t.heroTitle}</h2>
          <ul>
            <li>
              <Zap /> {t.hero[0]}
            </li>
            <li>
              <MapPinned /> {t.hero[1]}
            </li>
            <li>
              <Radio /> {t.hero[2]}
            </li>
          </ul>
        </div>
        <div className="login-blob one" />
        <div className="login-blob two" />
      </section>

      <main className="login-main">
        <div className="login-card">
          <div className="login-brand">
            <BrandMark size={60} />
            <h1>{lang === 'ar' ? <span className="gradient-text">ماما إكسبريس</span> : <>Mom<span className="gradient-text">Express</span></>}</h1>
            <p className="muted">{t.tagline}</p>
          </div>

          {expired && !error && (
            <div className="banner banner-info" role="status">
              <Lock aria-hidden="true" />
              <span>{t.expired}</span>
            </div>
          )}
          {offline && (
            <div className="banner banner-offline" role="status">
              <CloudOff aria-hidden="true" />
              <span>{t.offline}</span>
            </div>
          )}
          {error !== null && (
            <div className="banner banner-error" role="alert">
              <CircleAlert aria-hidden="true" />
              <span>{t.error(error)}</span>
            </div>
          )}

          <form className="stack gap-16" onSubmit={submit} noValidate>
            <div className={`field${fieldErrors.username ? ' invalid' : ''}`}>
              <label className="label" htmlFor="username">
                {t.username}
              </label>
              <input
                id="username"
                className="input"
                dir="ltr"
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                aria-invalid={!!fieldErrors.username}
                aria-describedby={fieldErrors.username ? 'username-error' : undefined}
                autoFocus
              />
              {fieldErrors.username && (
                <span className="field-error" id="username-error">
                  <CircleAlert aria-hidden="true" /> {fieldErrors.username}
                </span>
              )}
            </div>
            <div className={`field${fieldErrors.password ? ' invalid' : ''}`}>
              <label className="label" htmlFor="password">
                {t.password}
              </label>
              <div className="input-wrap">
                <input
                  id="password"
                  className="input"
                  dir="ltr"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  aria-invalid={!!fieldErrors.password}
                  aria-describedby={fieldErrors.password ? 'password-error' : undefined}
                />
                <button type="button" className="icon-btn" onClick={() => setShowPassword((v) => !v)} aria-label={showPassword ? t.hide : t.show}>
                  {showPassword ? <EyeOff /> : <Eye />}
                </button>
              </div>
              {fieldErrors.password && (
                <span className="field-error" id="password-error">
                  <CircleAlert aria-hidden="true" /> {fieldErrors.password}
                </span>
              )}
            </div>
            <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={busy}>
              {busy ? (
                <>
                  <LoaderCircle className="spin" aria-hidden="true" /> {t.signingIn}
                </>
              ) : (
                t.signIn
              )}
            </button>
          </form>

          <p className="login-foot">
            <Lock aria-hidden="true" /> {t.foot}
          </p>
          <button type="button" className="btn btn-ghost btn-sm login-lang" onClick={switchLang} lang={lang === 'ar' ? 'en' : 'ar'}>
            <Languages aria-hidden="true" /> {t.other}
          </button>
        </div>
      </main>
    </div>
  );
}
