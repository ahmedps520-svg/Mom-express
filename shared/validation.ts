import { z } from 'zod';
import { LIMITS, NOTIFICATION_CATEGORIES } from './constants.js';

// Input validation shared by the request form and the API. Messages are written
// for people, because the form shows them as they are.

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();
const tidy = (s: string) => s.replace(/\r\n/g, '\n').trim();

const title = z
  .string({ error: 'Tell us what you need.' })
  .transform(collapse)
  .pipe(
    z
      .string()
      .min(1, 'Tell us what you need.')
      .max(LIMITS.title, `Keep the title under ${LIMITS.title} characters.`),
  );

const location = z
  .string({ error: 'Choose where it should go.' })
  .transform(collapse)
  .pipe(
    z
      .string()
      .min(1, 'Choose where it should go.')
      .max(LIMITS.location, `Keep the location under ${LIMITS.location} characters.`),
  );

const longText = (max: number, label: string) =>
  z
    .string()
    .transform(tidy)
    .pipe(z.string().max(max, `Keep the ${label} under ${max} characters.`));

export const priorityField = z.enum(['normal', 'high', 'urgent'], { error: 'Choose a priority.' });

const description = longText(LIMITS.description, 'description');
const notes = longText(LIMITS.notes, 'notes');

export const createRequestSchema = z.object({
  title,
  description: description.default(''),
  location,
  priority: priorityField,
  notes: notes.default(''),
  clientRequestId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,64}$/, 'Invalid request id.'),
  quickType: z.enum(['water', 'snack', 'help', 'medicine']).nullable().default(null),
});

// Every field is optional so Mom can change just one thing; fields that are
// left out keep their current value.
export const updateRequestSchema = z
  .object({ title, description, location, priority: priorityField, notes })
  .partial()
  .refine(
  (v) => Object.values(v).some((x) => x !== undefined),
  'Nothing to update.',
);

export const etaSchema = z.object({
  etaMinutes: z
    .number({ error: 'Choose an ETA in minutes.' })
    .int('Use whole minutes.')
    .min(LIMITS.etaMinMinutes, `The ETA must be at least ${LIMITS.etaMinMinutes} minute.`)
    .max(LIMITS.etaMaxMinutes, `The ETA can be at most ${LIMITS.etaMaxMinutes} minutes.`),
});

export const optionalEtaSchema = z.object({
  etaMinutes: etaSchema.shape.etaMinutes.optional(),
});

export const reasonSchema = z.object({
  reason: z
    .string()
    .transform(collapse)
    .pipe(z.string().max(LIMITS.reason, `Keep the reason under ${LIMITS.reason} characters.`))
    .optional(),
});

export const loginSchema = z.object({
  username: z.string().trim().min(1, 'Enter your username.').max(64),
  password: z.string().min(1, 'Enter your password.').max(LIMITS.passwordMax),
});

const allNotificationTypes = [
  ...new Set(Object.values(NOTIFICATION_CATEGORIES).flatMap((cats) => cats.map((c) => c.type))),
] as [string, ...string[]];

export const updateMeSchema = z
  .object({
    displayName: z
      .string()
      .transform(collapse)
      .pipe(z.string().min(1, 'Enter a name.').max(LIMITS.displayName, `Keep your name under ${LIMITS.displayName} characters.`))
      .optional(),
    prefs: z
      .object({
        push: z.partialRecord(z.enum(allNotificationTypes), z.boolean()).optional(),
        sound: z.boolean().optional(),
        theme: z.enum(['system', 'light', 'dark']).optional(),
      })
      .optional(),
  })
  .refine((v) => v.displayName !== undefined || v.prefs !== undefined, 'Nothing to update.');

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password.').max(LIMITS.passwordMax),
  newPassword: z
    .string()
    .min(LIMITS.passwordMin, `Use at least ${LIMITS.passwordMin} characters.`)
    .max(LIMITS.passwordMax, 'That password is too long.'),
});

export const pushSubscriptionSchema = z.object({
  subscription: z.object({
    endpoint: z.url().max(1000).refine((u) => u.startsWith('https://'), 'Push endpoint must use HTTPS.'),
    keys: z.object({
      p256dh: z.string().min(1).max(200),
      auth: z.string().min(1).max(100),
    }),
  }),
});

export const markReadSchema = z
  .object({
    ids: z.array(z.number().int().positive()).max(500).optional(),
    requestId: z.number().int().positive().optional(),
    all: z.literal(true).optional(),
  })
  .refine((v) => v.ids || v.requestId || v.all, 'Say which notifications to mark as read.');

/** Turns zod issues into `{ field: message }` for showing next to inputs. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.length ? String(issue.path[0]) : '_';
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}
