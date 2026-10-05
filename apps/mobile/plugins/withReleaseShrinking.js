/* eslint-env node */
const { withGradleProperties } = require('expo/config-plugins');
const RELEASE_KEYS = ['android.enableMinifyInReleaseBuilds','android.enableShrinkResourcesInReleaseBuilds'];
function releaseProperties(input) {
  return [
    ...input.filter(item => item.type !== 'property' || !RELEASE_KEYS.includes(item.key)),
    ...RELEASE_KEYS.map(key => ({type:'property',key,value:'true'})),
  ];
}
function withReleaseShrinking(config) {
  return withGradleProperties(config, cfg => { cfg.modResults=releaseProperties(cfg.modResults); return cfg; });
}
module.exports=withReleaseShrinking;
module.exports.releaseProperties=releaseProperties;
