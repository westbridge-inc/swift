const { test } = require('node:test');
const assert = require('node:assert/strict');
const { releaseProperties } = require('./withReleaseShrinking');
test('enables minification and resource shrinking without duplicate properties', () => {
  const input=[{type:'property',key:'android.enableMinifyInReleaseBuilds',value:'false'},{type:'property',key:'unrelated',value:'keep'}];
  const props=releaseProperties(input);
  for(const key of ['android.enableMinifyInReleaseBuilds','android.enableShrinkResourcesInReleaseBuilds']) {
    assert.deepEqual(props.filter(p=>p.key===key),[{type:'property',key,value:'true'}]);
  }
  assert.deepEqual(releaseProperties(props),props);
  assert.equal(input[0].value,'false');
});
