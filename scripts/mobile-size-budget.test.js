const { test } = require('node:test');
const assert = require('node:assert/strict');
const { measureMobileArtifacts, checkMobileBudgets } = require('./mobile-size-budget');
const { releaseProperties } = require('../apps/mobile/plugins/withReleaseShrinking');
test('sums bundles by platform and checks exact byte limits', () => {
  const files = [ {path:'android/_expo/static/js/index.hbc',bytes:5}, {path:'android/_expo/static/js/chunk.js',bytes:3}, {path:'ios/_expo/static/js/index.hbc',bytes:7}, {path:'android/assets/icon.png',bytes:100} ];
  const actual = measureMobileArtifacts(files);
  assert.deepEqual(actual, {androidJs:8,iosJs:7});
  assert.deepEqual(checkMobileBudgets(actual,{androidJs:8,iosJs:7}),[]);
  assert.match(checkMobileBudgets(actual,{androidJs:7,iosJs:7})[0],/androidJs/);
});
test('requires every declared artifact and rejects invalid sizes', () => {
  assert.match(checkMobileBudgets({}, {apk:80})[0], /missing/i);
  assert.match(checkMobileBudgets({apk:NaN}, {apk:80})[0], /invalid/i);
  assert.match(checkMobileBudgets({apk:81,aab:101}, {apk:80,aab:100}).join(' '),/apk.*aab/);
});
test('enables minification and resource shrinking without duplicate properties', () => {
  const input=[{type:'property',key:'android.enableMinifyInReleaseBuilds',value:'false'},{type:'property',key:'unrelated',value:'keep'}];
  const props=releaseProperties(input);
  for(const key of ['android.enableMinifyInReleaseBuilds','android.enableShrinkResourcesInReleaseBuilds']) {
    assert.deepEqual(props.filter(p=>p.key===key),[{type:'property',key,value:'true'}]);
  }
  assert.deepEqual(releaseProperties(props),props);
  assert.equal(input[0].value,'false');
});
