import './secret-files';
import { connectSelfCheckRedis, formatSelfCheck, runPaymentsSelfCheck, type SelfCheckPart } from '../modules/billing/payments-self-check';

/**
 * [PT-5] `node dist/boot/payments-self-check.js [card] [mmg]` — run on the
 * server (deploy/owner/swift-payments-setup.command runs it in a one-off API
 * container). Prints only OK / FAIL lines and exits 0 when every line is OK.
 * Nothing a provider answers, and no setting's value, is ever printed.
 */
async function main(): Promise<number> {
  const asked = process.argv.slice(2).filter((a): a is SelfCheckPart => a === 'card' || a === 'mmg');
  const parts: SelfCheckPart[] = asked.length ? asked : ['card', 'mmg'];
  const redis = parts.includes('card') ? await connectSelfCheckRedis(process.env['REDIS_URL']) : undefined;
  try {
    const lines = await runPaymentsSelfCheck(parts, process.env, redis ? { redis } : {});
    // eslint-disable-next-line no-console
    console.log(formatSelfCheck(lines));
    return lines.every((l) => l.ok) ? 0 : 1;
  } finally {
    redis?.disconnect();
  }
}

main().then((code) => process.exit(code), () => {
  // eslint-disable-next-line no-console
  console.log('FAIL the self-check could not run');
  process.exit(1);
});
