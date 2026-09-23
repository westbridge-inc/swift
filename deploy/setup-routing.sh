#!/usr/bin/env bash
# Swift — build the OSRM data for the routing stack.
#
# Run before `docker compose -f deploy/docker-compose.routing.yml up -d`, and
# again whenever you want fresher OpenStreetMap data.
#
# WHY YOU WOULD RE-RUN IT: Swift's ETAs are only as good as Guyana's OSM data,
# and that data improves when people map Georgetown — including you. A street
# added today reaches this app only after this script re-imports the extract.
#
# Pass --refresh to discard the cached .pbf and pull the current one. Without
# it an existing download is reused, which is why a stack can quietly run on
# data that is months old.
set -euo pipefail
cd "$(dirname "$0")"

REFRESH=0
[ "${1:-}" = "--refresh" ] && REFRESH=1

DATA="routing-data/osrm"
PBF="guyana-latest.osm.pbf"
URL="https://download.geofabrik.de/south-america/${PBF}"
IMAGE="osrm/osrm-backend:v5.25.0"

mkdir -p "$DATA"
cd "$DATA"

if [ "$REFRESH" = "1" ]; then
  echo "→ refreshing: discarding the cached extract and every file built from it"
  rm -f "$PBF" guyana-latest.osrm*
fi

if [ -f "$PBF" ]; then
  echo "→ using the extract already here, built $(date -r "$PBF" '+%Y-%m-%d')"
  echo "  (re-run with --refresh to pull today's OpenStreetMap data)"
else
  echo "→ downloading $URL"
  curl -fLO "$URL"
fi

echo "→ extract";   docker run --rm -v "$PWD:/data" "$IMAGE" osrm-extract -p /opt/car.lua "/data/$PBF"
echo "→ partition"; docker run --rm -v "$PWD:/data" "$IMAGE" osrm-partition /data/guyana-latest.osrm
echo "→ customize"; docker run --rm -v "$PWD:/data" "$IMAGE" osrm-customize /data/guyana-latest.osrm

echo
echo "OSRM data ready. The staging sequence deploy/pilot-up.sh starts routing privately."
echo
echo "The API reaches these only on swift-pilot-private:"
echo "  MAPS_PROVIDER=osrm    OSRM_URL=http://osrm:5000"
echo "  BATCH_PLANNER=vroom   VROOM_URL=http://vroom:3000 (optional planner profile)"
echo "  PLACES_PROVIDER=osm   PHOTON_URL=http://photon:2322  NOMINATIM_URL=http://nominatim:8080 (optional geocoding profile)"
