export type MandateReceipt = Readonly<Record<string, unknown> & {
  keyId: string;
  algorithm: string;
  signature: string;
}>;

export type MandateVerificationKey = Readonly<{
  keyId: string;
  algorithm: string;
  publicKeyPem: string;
  status: string;
}>;

export type MandateVerificationKeySet =
  | readonly MandateVerificationKey[]
  | Readonly<{ keys: readonly MandateVerificationKey[] }>;

export type ReceiptVerificationReason =
  | 'VALID'
  | 'INVALID_RECEIPT'
  | 'UNSUPPORTED_ALGORITHM'
  | 'KEY_NOT_FOUND'
  | 'KEY_NOT_VERIFIABLE'
  | 'INVALID_KEY'
  | 'INVALID_SIGNATURE';

export type ReceiptVerificationResult = Readonly<{
  valid: boolean;
  reason: ReceiptVerificationReason;
  keyId: string | null;
  algorithm: string | null;
}>;

export const RECEIPT_VERIFICATION_REASONS: Readonly<{
  VALID: 'VALID';
  INVALID_RECEIPT: 'INVALID_RECEIPT';
  UNSUPPORTED_ALGORITHM: 'UNSUPPORTED_ALGORITHM';
  KEY_NOT_FOUND: 'KEY_NOT_FOUND';
  KEY_NOT_VERIFIABLE: 'KEY_NOT_VERIFIABLE';
  INVALID_KEY: 'INVALID_KEY';
  INVALID_SIGNATURE: 'INVALID_SIGNATURE';
}>;

export function canonicalize(value: unknown): string;

export function verifyMandateReceipt(
  receipt: MandateReceipt | unknown,
  keySet: MandateVerificationKeySet | unknown
): ReceiptVerificationResult;
