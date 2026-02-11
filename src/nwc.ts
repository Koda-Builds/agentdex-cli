/**
 * NWC (Nostr Wallet Connect) payment utility using Alby SDK
 */

import { NWCClient } from '@getalby/sdk';

export interface PaymentResult {
  preimage: string;
  paid: boolean;
}

/**
 * Pay a bolt11 invoice via NWC
 */
export async function payInvoice(nwcUri: string, bolt11: string): Promise<PaymentResult> {
  const client = new NWCClient({ nostrWalletConnectUrl: nwcUri });

  try {
    const response = await client.payInvoice({ invoice: bolt11 });
    return { preimage: response.preimage, paid: true };
  } finally {
    client.close();
  }
}
