/**
 * Status vocabulary (spec §7/§8) — the single set of words used for
 * write/mutation outcomes across the app, mapped to i18n keys and CSS
 * classes so no page invents its own "it worked-ish" label.
 *
 * Kinds:
 *   verified            write landed AND read-back confirmed it
 *   applied-unverified  write was sent; read-back could not confirm
 *   partial             some steps of a multi-step op succeeded
 *   unsupported         the device/firmware cannot do this at all
 *   unverified           available but not yet verified on hardware
 *   failed               the write errored out
 *   pending              queued / in flight
 *
 * `statusTag()` normalises the free-form `result` strings the safety
 * audit log records (`success` / `unverified` / `failed` / …) onto this
 * vocabulary; unknown strings map to `unverified` rather than pretending
 * success (honest-by-default).
 */

export type StatusKind =
  | 'verified'
  | 'applied-unverified'
  | 'partial'
  | 'unsupported'
  | 'unverified'
  | 'failed'
  | 'pending';

export interface StatusTag {
  kind: StatusKind;
  /** i18n key under `status.*`. */
  labelKey: string;
  /** CSS class for the `.status-tag` chip. */
  className: string;
}

const TAGS: Record<StatusKind, StatusTag> = {
  verified: { kind: 'verified', labelKey: 'status.verified', className: 'status-tag tag-verified' },
  'applied-unverified': {
    kind: 'applied-unverified',
    labelKey: 'status.applied-unverified',
    className: 'status-tag tag-warn',
  },
  partial: { kind: 'partial', labelKey: 'status.partial', className: 'status-tag tag-warn' },
  unsupported: {
    kind: 'unsupported',
    labelKey: 'status.unsupported',
    className: 'status-tag tag-muted',
  },
  unverified: { kind: 'unverified', labelKey: 'status.unverified', className: 'status-tag tag-warn' },
  failed: { kind: 'failed', labelKey: 'status.failed', className: 'status-tag tag-error' },
  pending: { kind: 'pending', labelKey: 'status.pending', className: 'status-tag tag-muted' },
};

export function statusTag(kind: StatusKind): StatusTag {
  return TAGS[kind];
}

/**
 * Normalise an audit-log / transaction result string to a StatusKind.
 * Anything unrecognised → 'unverified' (honest default: we cannot claim
 * the write was confirmed).
 */
export function statusKindFor(result: string): StatusKind {
  switch (result) {
    case 'success':
    case 'verified':
    case 'completed':
      return 'verified';
    case 'unverified':
    case 'applied-unverified':
      return 'applied-unverified';
    case 'partial':
      return 'partial';
    case 'unsupported':
      return 'unsupported';
    case 'failed':
    case 'error':
    case 'denied':
      return 'failed';
    case 'pending':
    case 'queued':
      return 'pending';
    default:
      return 'unverified';
  }
}
