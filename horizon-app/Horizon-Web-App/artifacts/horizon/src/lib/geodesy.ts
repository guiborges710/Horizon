export const EARTH_RADIUS_KM = 6371;

export type GeoPoint = {
  latitude: number;
  longitude: number;
};

function toRadians(value: number) {
  return (value * Math.PI) / 180;
}

function toDegrees(value: number) {
  return (value * 180) / Math.PI;
}

export function normalizeLongitude(longitude: number) {
  return ((longitude + 540) % 360) - 180;
}

export function normalizeBearing(bearing: number) {
  return ((bearing % 360) + 360) % 360;
}

export function angularDifference(first: number, second: number) {
  return Math.abs(((first - second + 540) % 360) - 180);
}

export function calculateDistance(from: GeoPoint, to: GeoPoint) {
  const latitudeDelta = toRadians(to.latitude - from.latitude);
  const longitudeDelta = toRadians(to.longitude - from.longitude);
  const latitudeOne = toRadians(from.latitude);
  const latitudeTwo = toRadians(to.latitude);
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(latitudeOne) *
      Math.cos(latitudeTwo) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function calculateBearing(from: GeoPoint, to: GeoPoint) {
  const latitudeOne = toRadians(from.latitude);
  const latitudeTwo = toRadians(to.latitude);
  const longitudeDelta = toRadians(to.longitude - from.longitude);
  const y = Math.sin(longitudeDelta) * Math.cos(latitudeTwo);
  const x =
    Math.cos(latitudeOne) * Math.sin(latitudeTwo) -
    Math.sin(latitudeOne) * Math.cos(latitudeTwo) * Math.cos(longitudeDelta);
  return normalizeBearing(toDegrees(Math.atan2(y, x)));
}

export function destinationPoint(
  origin: GeoPoint,
  bearing: number,
  distanceKm: number,
): GeoPoint {
  const angularDistance = distanceKm / EARTH_RADIUS_KM;
  const bearingRadians = toRadians(bearing);
  const latitudeOne = toRadians(origin.latitude);
  const longitudeOne = toRadians(origin.longitude);
  const latitudeTwo = Math.asin(
    Math.sin(latitudeOne) * Math.cos(angularDistance) +
      Math.cos(latitudeOne) *
        Math.sin(angularDistance) *
        Math.cos(bearingRadians),
  );
  const longitudeTwo =
    longitudeOne +
    Math.atan2(
      Math.sin(bearingRadians) *
        Math.sin(angularDistance) *
        Math.cos(latitudeOne),
      Math.cos(angularDistance) - Math.sin(latitudeOne) * Math.sin(latitudeTwo),
    );

  return {
    latitude: toDegrees(latitudeTwo),
    longitude: normalizeLongitude(toDegrees(longitudeTwo)),
  };
}
