#!/usr/bin/env node
/* eslint-env node */
const fs = require('node:fs');
const path = require('node:path');
const LIMITS = { androidJs: 8 * 1024 ** 2, iosJs: 8 * 1024 ** 2, apk: 100 * 1024 ** 2, aab: 100 * 1024 ** 2 };
function measureMobileArtifacts(files) {
  const sizes = {};
  for (const platform of ['android','ios']) {
    const entries = files.filter(file => file.path.startsWith(`${platform}/`) && /\.(?:js|hbc)$/.test(file.path));
    if (entries.length) sizes[`${platform}Js`] = entries.reduce((sum, file) => sum + file.bytes, 0);
  }
  return sizes;
}
function checkMobileBudgets(sizes, limits) {
  return Object.entries(limits).flatMap(([key, limit]) => {
    if (!(key in sizes)) return [`${key}: missing artifact`];
    if (!Number.isSafeInteger(sizes[key]) || sizes[key] <= 0) return [`${key}: invalid size`];
    return sizes[key] > limit ? [`${key}: ${sizes[key]} bytes exceeds ${limit} bytes`] : [];
  });
}
function main(argv) {
  const options = {};
  for(let i=0;i<argv.length;i+=2) {
    if(!['--manifest','--apk','--aab','--out'].includes(argv[i]) || !argv[i+1]) throw new Error('Use --manifest <file> or --apk <file> --aab <file>, plus --out <file>');
    options[argv[i]] = argv[i+1];
  }
  if(!options['--out'] || (!options['--manifest'] && !options['--apk'] && !options['--aab'])) throw new Error('Artifact inputs and --out are required');
  const sizes = {}; const limits = {};
  if(options['--manifest']) {
    const manifest = JSON.parse(fs.readFileSync(options['--manifest'],'utf8'));
    if(!Array.isArray(manifest.files)) throw new Error('Invalid artifact manifest');
    Object.assign(sizes,measureMobileArtifacts(manifest.files));
    Object.assign(limits,{androidJs:LIMITS.androidJs,iosJs:LIMITS.iosJs});
  }
  if(options['--apk'] || options['--aab']) {
    Object.assign(limits,{apk:LIMITS.apk,aab:LIMITS.aab});
    for(const kind of ['apk','aab']) if(options[`--${kind}`]) sizes[kind]=fs.statSync(options[`--${kind}`]).size;
  }
  const failures = checkMobileBudgets(sizes,limits);
  const report = { version:1, nativeArchitecture: options['--apk'] ? 'arm64-v8a CI reference build' : undefined, sizes, limits, failures };
  fs.mkdirSync(path.dirname(options['--out']),{recursive:true});
  fs.writeFileSync(options['--out'],JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
  if(process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,`\nMobile size budget (bytes)\n\n| Artifact | Measured | Limit |\n|---|---:|---:|\n${Object.entries(limits).map(([k,v])=>`| ${k} | ${sizes[k] ?? 'MISSING'} | ${v} |`).join('\n')}\n`);
  if(failures.length) process.exitCode=1;
}
module.exports={measureMobileArtifacts,checkMobileBudgets,LIMITS};
if(require.main===module) { try { main(process.argv.slice(2)); } catch(error) { console.error(error.message); process.exitCode=1; } }
