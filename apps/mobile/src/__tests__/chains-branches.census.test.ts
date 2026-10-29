import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// [CHAINS PR2 · owner 29 Oct 2026] The branch screens say what the server decides, and act one branch at a time.
//  - Add a branch: the trial line (free until the shared trial's end only if Swift approves the branch before it,
//    else billed from approval: REVIEW-M #2211 S4-2), the trial belongs to the business (a branch closed during it
//    still uses it up: N1), a person checks every new branch, the weekly fee ticked for THIS branch, confirm-it's-you.
//  - Every store switcher names a branch waiting for Swift's approval.
//  - Bulk open/pause and bulk hours go through each branch's own route (named by its id), one after another.
//  - Team: one person to several branches in one add (vendorIds).
// ---------------------------------------------------------------------------

const SRC = join(process.cwd(), 'src');
const read = (p: string) => readFileSync(join(SRC, p), 'utf8');

describe('[CHAINS] add a branch', () => {
  const screen = read('modules/vendor/screens/VendorAddBranchScreen.tsx');
  it('says the trial line, the business-owned trial and the person check, from lib/branches', () => {
    expect(screen).toMatch(/branchTrialLine\(t\.sharedTrialEndsAt, feeLabel\)/);
    expect(screen).toMatch(/BRANCH_COPY\.trialBelongsToBusiness/);
    expect(screen).toMatch(/BRANCH_COPY\.checkFirst/);
  });
  it('sends the branch\'s own fee tick, behind confirm-it\'s-you', () => {
    expect(screen).toMatch(/useAddBranch\(stepUp\.withStepUp\)/);
    expect(screen).toMatch(/business, weeklyFeeAck: fee\.ack, publicPhone: callUs\.trim\(\),/);
    expect(screen).toMatch(/\{stepUp\.sheet\}/);
  });
  // [REVIEW-F #2220 S3-1] What go-live needs from the owner comes with the add.
  it('asks for the number customers can call (required, the call-us card\'s own disclosure); the branch phone is the private line', () => {
    expect(screen).toMatch(/<PublicCallNumberField value=\{callUs\} onChange=\{setCallUs\} required \/>/);
    expect(screen).toMatch(/const callUsAsk = callUs\.trim\(\) \? null : 'Add the number customers can call';/);
    expect(screen).toMatch(/blocker \?\? callUsAsk \?\? feeAsk/);
    expect(screen).toMatch(/placeholder="Branch phone \(Swift’s contact line, private\)"/);
    const card = read('components/PublicCallNumberCard.tsx');
    expect(card).toMatch(/\{PUBLIC_CALL_COPY\.separate\}/g);
    expect(card.match(/\{PUBLIC_CALL_COPY\.separate\}/g)).toHaveLength(2);
  });
  it('offers a restaurant\'s food handlers tick in the server\'s words, sent only when ticked for those words', () => {
    expect(screen).toMatch(/const food = t\?\.foodHandlers && typeof t\.foodHandlers\.tick === 'string'/);
    expect(screen).toMatch(/const foodKey = food \? `\$\{type\}\|\$\{food\.version\}` : null;/);
    expect(screen).toMatch(/\.\.\.\(food && foodTicked \? \{ foodHandlers: \{ accept: true as const, attestationVersion: food\.version \} \} : \{\}\)/);
    expect(screen).toMatch(/<T variant="body" style=\{\{ flex: 1 \}\}>\{food\.tick\}<\/T>/);
  });
  it('is registered and reachable', () => {
    const stack = read('modules/vendor/VendorStack.tsx');
    expect(stack).toMatch(/name="VendorAddBranch" component=\{VendorAddBranchScreen\}/);
    expect(stack).toMatch(/name="VendorBranches" component=\{VendorBranchesScreen\}/);
    expect(read('modules/vendor/screens/VendorBranchesScreen.tsx')).toMatch(/navigate\?\.\('VendorAddBranch'\)/);
    expect(read('modules/vendor/screens/VendorAccountScreen.tsx')).toMatch(/navigation\.navigate\('VendorBranches'\)/);
  });
});

describe('[CHAINS] every store switcher names a branch waiting for Swift', () => {
  for (const file of ['VendorOps.tsx', 'VendorStoreBlocked.tsx', 'VendorBillingSuspended.tsx', 'BusinessSetup.tsx']) {
    it(file, () => {
      const text = read(`modules/vendor/screens/${file}`);
      expect(text).toMatch(/label=\{storeLabel\((s|candidate)\)\}/);
      expect(text).not.toMatch(/<Chip[^>]*label=\{(s|candidate)\.name\}[^>]*selected=\{(s|candidate)\.id === store\.id\}/);
    });
  }
});

describe('[CHAINS] a branch not live yet names the owner\'s next step, with a way to it (REVIEW-F #2220 S3-1)', () => {
  it('the Branches screen lists them with the steps and a button that opens the branch', () => {
    const screen = read('modules/vendor/screens/VendorBranchesScreen.tsx');
    expect(screen).toMatch(/const notLive = stores\.filter\(\(s\) => awaitingApproval\(s\)\);/);
    expect(screen).toMatch(/const steps = ownerStepWords\(s\);/);
    expect(screen).toMatch(/goLiveOf\(s\)\?\.waitingFor === 'OWNER' \? \(\s*<PillButton label=\{BRANCH_COPY\.finishButton\}[^>]*\s*onPress=\{\(\) => setSelectedStore\(s\.id\)\}/);
  });
  it('the branch\'s own waiting screen says whose turn it is', () => {
    expect(read('modules/vendor/screens/BusinessSetup.tsx')).toMatch(/\{goLiveLine\(store\) \?\? BRANCH_COPY\.checkFirst\}/);
  });
  it('the all-branches orders error offers Try again (no pull-to-refresh there: REVIEW-F S4-1)', () => {
    const screen = read('modules/vendor/screens/VendorBranchesScreen.tsx');
    expect(screen).not.toMatch(/Pull to try again/);
    expect(screen).toMatch(/ordersQ\.isError \? <ErrorState onRetry=\{\(\) => void ordersQ\.refetch\(\)\}/);
  });
});

describe('[CHAINS] bulk actions use each branch\'s own route, one branch at a time', () => {
  const screen = read('modules/vendor/screens/VendorBranchesScreen.tsx');
  it('pause / take orders and hours', () => {
    expect(screen).toMatch(/runBulk\('pause', \(id\) => vendorApi\.toggleOrdersAt\(id, false\)\)/);
    expect(screen).toMatch(/runBulk\('take', \(id\) => vendorApi\.toggleOrdersAt\(id, true\)\)/);
    expect(screen).toMatch(/forEachBranch\(hoursTargets, \(id\) => vendorApi\.setHoursAt\(id, hours\)\)/);
    const api = read('services/api.ts');
    expect(api).toMatch(/toggleOrdersAt: \(vendorId: string, acceptingOrders: boolean\) =>\s+api\.put\('\/vendor\/vendor\/toggle-orders', \{ acceptingOrders \}, \{ headers: \{ \[VENDOR_STORE_HEADER\]: vendorId \} \}\)/);
    expect(api).toMatch(/setHoursAt: \(vendorId: string, [^)]*\) =>\s+api\.put\('\/vendor\/hours', \{ hours \}, \{ headers: \{ \[VENDOR_STORE_HEADER\]: vendorId \} \}\)/);
  });
  it('the menu copy names its branch and keeps its key for a retry', () => {
    expect(read('services/api.ts')).toMatch(/api\.post\('\/vendor\/menu\/copy', \{ fromStoreId, copyKey \}, \{ headers: \{ \[VENDOR_STORE_HEADER\]: toStoreId \} \}\)/);
    expect(screen).toMatch(/const \[copyKey, setCopyKey\] = useState\(newCopyKey\)/);
  });
});

describe('[CHAINS] one person to several branches', () => {
  it('the team add sends vendorIds with this store first', () => {
    const text = read('modules/vendor/screens/VendorAccountScreen.tsx');
    expect(text).toMatch(/const vendorIds = here\?\.id && also\.length > 0 \? \[here\.id, \.\.\.also\] : undefined;/);
    expect(text).toMatch(/addStaff\.mutate\(\{ phone: p, role, \.\.\.\(vendorIds \? \{ vendorIds \} : \{\}\) \}/);
  });
  it('offers only branches open on Swift (the server refuses a waiting, suspended or closed one: REVIEW-F S4-3)', () => {
    expect(read('modules/vendor/screens/VendorAccountScreen.tsx')).toMatch(/\.filter\(\(s: any\) => s\.id !== here\?\.id && s\.status === 'ACTIVE'\)/);
  });
});
