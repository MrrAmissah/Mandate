import { DomainError } from '../domain/errors.js';
import { issueSupersedingReceipt, verifyReceiptWithRegistry } from '../domain/receipts.js';
import { assertObject, requiredString } from '../domain/validate.js';
import {
  findReceiptSuccessor,
  lockReceiptForSupersession,
  saveSupersedingReceipt
} from '../store/receipt-supersession.js';

export async function supersedeReceipt({
  transaction,
  ownership,
  receiptId,
  input,
  signer,
  signingKeys,
  now = new Date()
}) {
  assertObject(input);
  const reason = requiredString(input.reason, 'reason');
  const predecessor = await lockReceiptForSupersession(transaction, ownership, receiptId);
  if (!predecessor) {
    throw new DomainError('RECEIPT_NOT_FOUND', 'The receipt does not exist.', 404);
  }
  if (!await verifyReceiptWithRegistry(predecessor, signingKeys, {
    queryable: transaction?.queryable,
    lock: Boolean(transaction?.queryable)
  })) {
    throw new DomainError(
      'RECEIPT_NOT_VERIFIABLE',
      'The predecessor receipt cannot be verified with a trusted key.',
      409
    );
  }
  const successor = await findReceiptSuccessor(transaction, ownership, receiptId);
  if (successor) {
    throw new DomainError(
      'RECEIPT_ALREADY_SUPERSEDED',
      'This receipt already has a superseding receipt.',
      409,
      { successorReceiptId: successor.id }
    );
  }

  const replacement = issueSupersedingReceipt({
    receipt: predecessor,
    reason,
    signer,
    now
  });
  return saveSupersedingReceipt(transaction, ownership, replacement);
}
