/** CSS viewport size and pixel ratio, from SE through the large Pro iPhones.
 *  Keep landscape too: iOS does not enforce the manifest orientation. */
export const iphoneScreens = [
  [375, 667, 2], [414, 736, 3], [375, 812, 3], [414, 896, 2],
  [414, 896, 3], [390, 844, 3], [393, 852, 3], [402, 874, 3],
  [428, 926, 3], [430, 932, 3], [440, 956, 3],
] as const;

export const appleStartupImages = iphoneScreens.flatMap(([width, height, ratio]) =>
  (['portrait', 'landscape'] as const).map((orientation) => ({
    url: `/splash/iphone-${width}-${height}-${ratio}-${orientation}.png`,
    media: `(device-width: ${width}px) and (device-height: ${height}px) and (-webkit-device-pixel-ratio: ${ratio}) and (orientation: ${orientation})`,
  })),
);
