/**
 * [M-36] The money-column inventory — every Decimal column that holds money,
 * a rate or a percentage, annotated with the UNIT it is stored in. The census
 * test walks the Prisma DMMF and fails on any money-ish Decimal column that
 * is not listed here, so a new money column is born annotated or not at all.
 *
 * Units:
 *   MAJOR_WHOLE  whole units of the row's currency (GYD today) — the platform's
 *                storage unit; integers in practice, Decimal(12,2) at rest
 *   MAJOR_2DP    major units with two decimals (ads billing, bank and
 *                settlement figures that carry cents)
 *   USD_MAJOR    US dollars, two decimals (USD pricing, the ID-gate threshold)
 *   FX_RATE      local units per 1 USD (a rate, not money)
 *   PERCENT      a percentage (a rate, not money)
 *
 * Basis: read from the column's writers and readers at the time of M-36;
 * the two-decimal annotations follow the ads-money helper and the bank /
 * settlement modules, which round to cents.
 */
export type MoneyUnit = 'MAJOR_WHOLE' | 'MAJOR_2DP' | 'USD_MAJOR' | 'FX_RATE' | 'PERCENT';

export interface MoneyColumn {
  model: string;
  field: string;
  unit: MoneyUnit;
}

/** The regex the census applies to a Decimal field's name to call it money-ish. */
export const MONEY_FIELD_PATTERN = /amount|fee|total|price|fare|discount|tip|balance|gyd|usd|cost|spend|subtotal|deposit|credit|debit|value|rate|float|minimum|markup|budget|cap|revenue|earning|payout|refund|charge|pay|money|cash|gross|net|share|surcharge|changefor|roundingincrement|perkm|sales|collection|receivable|payable|funding/i;

export const MONEY_COLUMNS: readonly MoneyColumn[] = [
  { model: 'AdBooking', field: 'amount', unit: 'MAJOR_2DP' },
  { model: 'AdCampaign', field: 'totalAmount', unit: 'MAJOR_2DP' },
  { model: 'AdInvoice', field: 'amount', unit: 'MAJOR_2DP' },
  { model: 'AdInvoice', field: 'refundedAmount', unit: 'MAJOR_2DP' },
  { model: 'AdPlacement', field: 'weeklyPrice', unit: 'MAJOR_2DP' },
  { model: 'AdStatsDaily', field: 'spend', unit: 'MAJOR_2DP' },
  { model: 'Advertiser', field: 'creditBalance', unit: 'MAJOR_2DP' },
  { model: 'AdsSettings', field: 'platformFeePct', unit: 'PERCENT' },
  { model: 'BillingEvent', field: 'amount', unit: 'MAJOR_WHOLE' },
  { model: 'BillingEvent', field: 'amountUsd', unit: 'USD_MAJOR' },
  { model: 'BillingEvent', field: 'fxRateUsed', unit: 'FX_RATE' },
  { model: 'Cart', field: 'tipAmount', unit: 'MAJOR_WHOLE' },
  { model: 'CountryConfig', field: 'floatL1', unit: 'MAJOR_WHOLE' },
  { model: 'CountryConfig', field: 'floatL2', unit: 'MAJOR_WHOLE' },
  { model: 'CountryConfig', field: 'floatL3', unit: 'MAJOR_WHOLE' },
  { model: 'CountryConfig', field: 'idGateThresholdUsd', unit: 'USD_MAJOR' },
  { model: 'CountryConfig', field: 'usdExchangeRate', unit: 'FX_RATE' },
  { model: 'Customer', field: 'totalSpent', unit: 'MAJOR_WHOLE' },
  { model: 'DeliveryCashSettlement', field: 'amount', unit: 'MAJOR_WHOLE' },
  // [A-11] What the payer attested they transferred; same unit as the claim it
  // must equal.
  { model: 'ReimbursementClaim', field: 'paidAmount', unit: 'MAJOR_WHOLE' },
  // [A-13] What the settler attested they refunded; same unit as refundAmount.
  { model: 'ReturnRequest', field: 'refundPaidAmount', unit: 'MAJOR_WHOLE' },
  // [W-26] What each side ATTESTED changed hands. Same unit as the amount
  // above by construction: the ledger refuses any figure that is not it.
  { model: 'DeliveryCashSettlement', field: 'riderAttestedAmount', unit: 'MAJOR_WHOLE' },
  { model: 'DeliveryCashSettlement', field: 'storeAttestedAmount', unit: 'MAJOR_WHOLE' },
  { model: 'DeliveryRun', field: 'cashToCollectTotal', unit: 'MAJOR_WHOLE' },
  { model: 'DepositConfirmation', field: 'deltaGyd', unit: 'MAJOR_2DP' },
  { model: 'DepositConfirmation', field: 'depositedGyd', unit: 'MAJOR_2DP' },
  { model: 'Earning', field: 'amount', unit: 'MAJOR_WHOLE' },
  { model: 'FeeReceipt', field: 'amount', unit: 'MAJOR_WHOLE' },
  { model: 'FxRate', field: 'rate', unit: 'FX_RATE' },
  { model: 'Item', field: 'basePrice', unit: 'MAJOR_WHOLE' },
  { model: 'LedgerEntry', field: 'credit', unit: 'MAJOR_WHOLE' },
  { model: 'LedgerEntry', field: 'debit', unit: 'MAJOR_WHOLE' },
  { model: 'MmgAgentPayment', field: 'amount', unit: 'MAJOR_WHOLE' },
  { model: 'Option', field: 'additionalPrice', unit: 'MAJOR_WHOLE' },
  { model: 'Order', field: 'deliveryFee', unit: 'MAJOR_WHOLE' },
  { model: 'Order', field: 'discount', unit: 'MAJOR_WHOLE' },
  { model: 'Order', field: 'serviceFee', unit: 'MAJOR_WHOLE' },
  { model: 'Order', field: 'subtotalBase', unit: 'MAJOR_WHOLE' },
  { model: 'Order', field: 'subtotalCustomer', unit: 'MAJOR_WHOLE' },
  { model: 'Order', field: 'subtotalMarkup', unit: 'MAJOR_WHOLE' },
  { model: 'Order', field: 'taxAmount', unit: 'MAJOR_WHOLE' },
  { model: 'Order', field: 'taxiFareBase', unit: 'MAJOR_WHOLE' },
  { model: 'Order', field: 'taxiFarePerKm', unit: 'MAJOR_WHOLE' },
  { model: 'Order', field: 'taxiFarePerMin', unit: 'MAJOR_WHOLE' },
  { model: 'Order', field: 'taxiFareTotal', unit: 'MAJOR_WHOLE' },
  { model: 'Order', field: 'tipAmount', unit: 'MAJOR_WHOLE' },
  { model: 'Order', field: 'totalAmount', unit: 'MAJOR_WHOLE' },
  { model: 'OrderItem', field: 'basePrice', unit: 'MAJOR_WHOLE' },
  { model: 'OrderItem', field: 'markedUpPrice', unit: 'MAJOR_WHOLE' },
  { model: 'OrderItem', field: 'markupAmount', unit: 'MAJOR_WHOLE' },
  { model: 'OrderItem', field: 'substitutePrice', unit: 'MAJOR_WHOLE' },
  { model: 'OrderItem', field: 'totalBase', unit: 'MAJOR_WHOLE' },
  { model: 'OrderItem', field: 'totalCustomer', unit: 'MAJOR_WHOLE' },
  { model: 'OrderItem', field: 'totalMarkup', unit: 'MAJOR_WHOLE' },
  { model: 'OrderItemOption', field: 'basePrice', unit: 'MAJOR_WHOLE' },
  { model: 'OrderItemOption', field: 'markedUpPrice', unit: 'MAJOR_WHOLE' },
  { model: 'OrderItemOption', field: 'markupAmount', unit: 'MAJOR_WHOLE' },
  { model: 'PayoutRequest', field: 'amount', unit: 'MAJOR_WHOLE' },
  { model: 'PayoutRequest', field: 'fee', unit: 'MAJOR_WHOLE' },
  { model: 'PayoutRequest', field: 'netAmount', unit: 'MAJOR_WHOLE' },
  { model: 'PrepaidBalance', field: 'balance', unit: 'MAJOR_WHOLE' },
  { model: 'PriceBookEntry', field: 'amountUsd', unit: 'USD_MAJOR' },
  { model: 'PromoCode', field: 'discountValue', unit: 'MAJOR_WHOLE' },
  { model: 'PromoCode', field: 'maxDiscount', unit: 'MAJOR_WHOLE' },
  { model: 'PromoCode', field: 'minOrderAmount', unit: 'MAJOR_WHOLE' },
  { model: 'PromoRedemption', field: 'deliveryDiscount', unit: 'MAJOR_WHOLE' },
  { model: 'PromoRedemption', field: 'discountValue', unit: 'MAJOR_WHOLE' },
  { model: 'PromoRedemption', field: 'goodsDiscount', unit: 'MAJOR_WHOLE' },
  { model: 'PromoRedemption', field: 'maxDiscount', unit: 'MAJOR_WHOLE' },
  { model: 'PromoRedemption', field: 'tipDiscount', unit: 'MAJOR_WHOLE' },
  { model: 'PromoTerms', field: 'discountValue', unit: 'MAJOR_WHOLE' },
  { model: 'PromoTerms', field: 'maxDiscount', unit: 'MAJOR_WHOLE' },
  { model: 'PromoTerms', field: 'minOrderAmount', unit: 'MAJOR_WHOLE' },
  { model: 'ProviderPayment', field: 'amount', unit: 'MAJOR_WHOLE' },
  { model: 'ReimbursementClaim', field: 'amount', unit: 'MAJOR_WHOLE' },
  { model: 'ReturnRequest', field: 'refundAmount', unit: 'MAJOR_WHOLE' },
  { model: 'ReturnRequest', field: 'refundInferredAmount', unit: 'MAJOR_WHOLE' },
  { model: 'Rider', field: 'committedFloat', unit: 'MAJOR_WHOLE' },
  { model: 'Rider', field: 'floatLimit', unit: 'MAJOR_WHOLE' },
  { model: 'RunStop', field: 'cashToCollect', unit: 'MAJOR_WHOLE' },
  { model: 'RunStop', field: 'changeFor', unit: 'MAJOR_WHOLE' },
  { model: 'ServiceJob', field: 'quoteAmount', unit: 'MAJOR_WHOLE' },
  { model: 'Settlement', field: 'netSales', unit: 'MAJOR_2DP' },
  { model: 'Settlement', field: 'goodsSales', unit: 'MAJOR_2DP' },
  { model: 'Settlement', field: 'vendorPromoDiscount', unit: 'MAJOR_2DP' },
  { model: 'Settlement', field: 'sponsorReceivable', unit: 'MAJOR_2DP' },
  { model: 'Settlement', field: 'customerCollection', unit: 'MAJOR_2DP' },
  { model: 'Settlement', field: 'feeFunding', unit: 'MAJOR_2DP' },
  { model: 'Settlement', field: 'moverPayable', unit: 'MAJOR_2DP' },
  { model: 'Settlement', field: 'totalBase', unit: 'MAJOR_2DP' },
  { model: 'Settlement', field: 'totalDiscount', unit: 'MAJOR_2DP' },
  { model: 'Settlement', field: 'totalMarkup', unit: 'MAJOR_2DP' },
  { model: 'SettlementBatch', field: 'depositedGyd', unit: 'MAJOR_2DP' },
  { model: 'SettlementBatch', field: 'expectedNetGyd', unit: 'MAJOR_2DP' },
  { model: 'SettlementBatch', field: 'grossGyd', unit: 'MAJOR_2DP' },
  { model: 'SettlementBatch', field: 'providerFeeGyd', unit: 'MAJOR_2DP' },
  { model: 'SettlementImport', field: 'computedTotal', unit: 'MAJOR_2DP' },
  { model: 'SettlementImport', field: 'controlTotal', unit: 'MAJOR_2DP' },
  { model: 'Subscription', field: 'customRate', unit: 'MAJOR_WHOLE' },
  { model: 'Subscription', field: 'weeklyRate', unit: 'MAJOR_WHOLE' },
  { model: 'SubscriptionPayment', field: 'amount', unit: 'MAJOR_WHOLE' },
  { model: 'SubscriptionRefund', field: 'amount', unit: 'MAJOR_WHOLE' },
  { model: 'TenantBillingCurrency', field: 'roundingIncrement', unit: 'MAJOR_WHOLE' },
  { model: 'TopUpCommand', field: 'amount', unit: 'MAJOR_WHOLE' },
  { model: 'Transaction', field: 'amount', unit: 'MAJOR_WHOLE' },
  { model: 'Transaction', field: 'balanceAfter', unit: 'MAJOR_WHOLE' },
  { model: 'User', field: 'walletBalance', unit: 'MAJOR_WHOLE' },
  { model: 'Vendor', field: 'minOrderAmount', unit: 'MAJOR_WHOLE' },
  { model: 'Zone', field: 'deliveryBaseFee', unit: 'MAJOR_WHOLE' },
  { model: 'Zone', field: 'deliveryPerKm', unit: 'MAJOR_WHOLE' },
  { model: 'ZoneFare', field: 'fare', unit: 'MAJOR_WHOLE' },
];

export function moneyUnitOf(model: string, field: string): MoneyUnit | null {
  return MONEY_COLUMNS.find((c) => c.model === model && c.field === field)?.unit ?? null;
}
