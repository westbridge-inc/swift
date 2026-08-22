/**
 * [F-228 / F-027-02] The ONE way this app asks the browser where you are.
 *
 * Every caller used to carry its own copy of the same fallback: if the
 * browser had no geolocation API, denied the prompt, or timed out, substitute
 * the Georgetown city centre (6.8013, -58.1551) and carry on as though the
 * device had reported it. F-228 fixed one of those copies. The reviewer found
 * three more, on higher-consequence paths — a saved customer address, a
 * vendor's registered business location, and a TAXI PICKUP submitted to
 * dispatch. A guessed pickup sends a real driver to a place the passenger is
 * not standing.
 *
 * So there is one implementation now, and it has no fallback to miss. A
 * coordinate is either what the device reported or an error a human can act
 * on. Callers must surface the message; none of them may substitute a
 * default.
 */

export interface Coords {
  lat: number;
  lng: number;
}

/**
 * @param purpose completes the sentence "We need your location to …" — keep it
 *                specific, because the message is the entire recourse the
 *                person has.
 */
export function currentCoords(purpose: string, timeoutMs = 8000): Promise<Coords> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      reject(new Error(`This browser can’t share your location, so we can’t ${purpose}. Use the Swift app instead.`));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      (err) => reject(new Error(
        err.code === err.PERMISSION_DENIED
          ? `We need your location to ${purpose} — allow location access and try again.`
          : `We couldn’t get your location just now, so we can’t ${purpose}. Move somewhere with a clearer signal and try again.`,
      )),
      { timeout: timeoutMs, enableHighAccuracy: true },
    );
  });
}
