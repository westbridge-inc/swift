// [COORD 18 Oct, option S] A person's Standing (rider, driver, provider) is built from whole groups of ratings
// (the API sends `groupSize`): each sparkline bar is one group, and every figure moves only after a whole new
// group, so no rating can be matched to one trip. The card says so, so a still bar is never read as "no ratings".
export function standingGroupNote(groupSize: number | undefined): string | null {
  return groupSize && groupSize > 1
    ? `Each bar is ${groupSize} ratings. Your rating moves only after every ${groupSize}, so no rating can be matched to one trip.`
    : null;
}
