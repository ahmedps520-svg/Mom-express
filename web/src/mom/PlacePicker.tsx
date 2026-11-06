import { Check } from 'lucide-react';
import { useState } from 'react';
import { PLACES } from './ar';

/** "أين أنتِ؟": big buttons for the usual places, or type another one. */
export function PlacePicker({ value, onChange, focusOther = true }: { value: string; onChange: (place: string) => void; focusOther?: boolean }) {
  const [typing, setTyping] = useState(() => value !== '' && !PLACES.includes(value));
  const [other, setOther] = useState(() => (value !== '' && !PLACES.includes(value) ? value : ''));

  return (
    <>
      <h2 className="m-q">أين أنتِ؟</h2>
      <div className="m-places" role="radiogroup" aria-label="أين أنتِ؟">
        {PLACES.map((p) => (
          <button
            key={p}
            type="button"
            role="radio"
            aria-checked={!typing && value === p}
            className="m-choice"
            onClick={() => {
              setTyping(false);
              onChange(p);
            }}
          >
            {!typing && value === p && <Check aria-hidden="true" />} {p}
          </button>
        ))}
        <button
          type="button"
          role="radio"
          aria-checked={typing}
          className="m-choice"
          onClick={() => {
            setTyping(true);
            onChange(other);
          }}
        >
          {typing && <Check aria-hidden="true" />} مكان آخر
        </button>
      </div>
      {typing && (
        <input
          className="m-input"
          aria-label="اكتبي المكان"
          placeholder="اكتبي المكان…"
          maxLength={40}
          value={other}
          autoFocus={focusOther}
          onChange={(e) => {
            setOther(e.target.value);
            onChange(e.target.value);
          }}
        />
      )}
    </>
  );
}
