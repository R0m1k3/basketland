import type { InputHTMLAttributes } from 'react';

/** Champ de formulaire : libellé, saisie, aide facultative. */
export default function Field({
  label,
  hint,
  id,
  ...input
}: { label: string; hint?: string; id: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div>
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      <input id={id} className="field" {...input} />
      {hint && <p className="field-hint">{hint}</p>}
    </div>
  );
}
