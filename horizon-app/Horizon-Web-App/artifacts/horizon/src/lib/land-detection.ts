import { destinationPoint, type GeoPoint } from './geodesy';

type PolygonCoordinates = number[][][];
type MultiPolygonCoordinates = number[][][][];

export type GeoJsonFeature = {
  type: 'Feature';
  properties?: Record<string, unknown>;
  geometry:
    | { type: 'Polygon'; coordinates: PolygonCoordinates }
    | { type: 'MultiPolygon'; coordinates: MultiPolygonCoordinates };
};

export type GeoJsonFeatureCollection = {
  type: 'FeatureCollection';
  features: GeoJsonFeature[];
};

export type LandCategory =
  | 'continental-mass'
  | 'significant-country'
  | 'large-island'
  | 'small-island';

export type LandArea = {
  id: number;
  name: string;
  continent: string | null;
  category: LandCategory;
  bbox: [west: number, south: number, east: number, north: number];
  feature: GeoJsonFeature;
};

function pointInRing(point: GeoPoint, ring: number[][]) {
  let inside = false;
  const x = point.longitude;
  const y = point.latitude;

  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const [xi, yi] = ring[index];
    const [xj, yj] = ring[previous];
    const intersects =
      yi > y !== yj > y &&
      x < ((xj - xi) * (y - yi)) / (yj - yi || Number.EPSILON) + xi;
    if (intersects) inside = !inside;
  }

  return inside;
}

function pointInPolygon(point: GeoPoint, polygon: PolygonCoordinates) {
  if (!pointInRing(point, polygon[0])) return false;
  return polygon.slice(1).every((hole) => !pointInRing(point, hole));
}

function pointInFeature(point: GeoPoint, feature: GeoJsonFeature) {
  if (feature.geometry.type === 'Polygon') {
    return pointInPolygon(point, feature.geometry.coordinates);
  }
  return feature.geometry.coordinates.some((polygon) => pointInPolygon(point, polygon));
}

function polygonAreaSqKm(polygon: PolygonCoordinates) {
  const ring = polygon[0];
  if (!ring || ring.length < 3) return 0;
  const meanLatitude = ring.reduce((sum, coordinate) => sum + coordinate[1], 0) / ring.length;
  const latitudeScale = 111.32;
  const longitudeScale = 111.32 * Math.cos((meanLatitude * Math.PI) / 180);
  let area = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const next = (index + 1) % ring.length;
    area += ring[index][0] * ring[next][1] - ring[next][0] * ring[index][1];
  }
  return Math.abs(area / 2) * latitudeScale * longitudeScale;
}

function featureAreaSqKm(feature: GeoJsonFeature) {
  if (feature.geometry.type === 'Polygon') return polygonAreaSqKm(feature.geometry.coordinates);
  return feature.geometry.coordinates.reduce((sum, polygon) => sum + polygonAreaSqKm(polygon), 0);
}

function featureBounds(feature: GeoJsonFeature): LandArea['bbox'] {
  const coordinates: number[][] = [];
  const collect = (value: unknown): void => {
    if (
      Array.isArray(value) &&
      value.length >= 2 &&
      typeof value[0] === 'number' &&
      typeof value[1] === 'number'
    ) {
      coordinates.push(value as number[]);
      return;
    }
    if (Array.isArray(value)) value.forEach(collect);
  };
  collect(feature.geometry.coordinates);

  const longitudes = coordinates.map(([longitude]) => longitude);
  const latitudes = coordinates.map(([, latitude]) => latitude);
  return [
    Math.min(...longitudes),
    Math.min(...latitudes),
    Math.max(...longitudes),
    Math.max(...latitudes),
  ];
}

function classifyLand(feature: GeoJsonFeature, areaSqKm: number): LandCategory {
  const populationRank = Number(feature.properties?.POP_RANK ?? 99);
  const continent = String(feature.properties?.CONTINENT ?? '');

  if (areaSqKm >= 1_000_000 || (continent && populationRank <= 10 && areaSqKm >= 250_000)) {
    return 'continental-mass';
  }
  if (areaSqKm >= 25_000 || populationRank <= 18) return 'significant-country';
  if (areaSqKm >= 5_000) return 'large-island';
  return 'small-island';
}

export function buildLandIndex(collection: GeoJsonFeatureCollection) {
  return collection.features.map((feature, id) => {
    const areaSqKm = featureAreaSqKm(feature);
    return {
      id,
      name: String(feature.properties?.NAME_PT ?? feature.properties?.NAME ?? 'Área terrestre'),
      continent: typeof feature.properties?.CONTINENT === 'string'
        ? feature.properties.CONTINENT
        : null,
      category: classifyLand(feature, areaSqKm),
      bbox: featureBounds(feature),
      feature,
    } satisfies LandArea;
  });
}

export function findLandAt(point: GeoPoint, index: LandArea[], includeIslands = true) {
  return index.find((area) => {
    const [west, south, east, north] = area.bbox;
    const inBounds = point.latitude >= south &&
      point.latitude <= north &&
      (west <= east
        ? point.longitude >= west && point.longitude <= east
        : point.longitude >= west || point.longitude <= east);
    return inBounds && pointInFeature(point, area.feature);
  }) ?? null;
}

export function findFirstLargeLand(
  origin: GeoPoint,
  heading: number,
  index: LandArea[],
  maxDistanceKm = 20_000,
) {
  // The observer normally starts on land. First leave that starting area,
  // then look for the next land transition across the ocean.
  const originLand = findLandAt(origin, index);
  let previousDistance = 0;
  let previousLand = originLand;
  let leftOriginLand = !originLand;

  const stepFor = (distance: number) => {
    if (distance < 20) return 1;
    if (distance < 200) return 2;
    if (distance < 1_000) return 5;
    if (distance < 5_000) return 15;
    return 30;
  };

  for (let distance = 1; distance <= maxDistanceKm; distance += stepFor(distance)) {
    const point = destinationPoint(origin, heading, distance);
    const land = findLandAt(point, index);

    if (!leftOriginLand) {
      if (!land || land.id !== originLand?.id) {
        leftOriginLand = true;
      } else {
        previousDistance = distance;
        previousLand = land;
        continue;
      }
    }

    const isNewLand = !!land && land.id !== originLand?.id;
    if (isNewLand && !previousLand) {
      let low = previousDistance;
      let high = distance;
      for (let iteration = 0; iteration < 16; iteration += 1) {
        const middle = (low + high) / 2;
        const middleLand = findLandAt(destinationPoint(origin, heading, middle), index);
        if (middleLand && middleLand.id !== originLand?.id) high = middle;
        else low = middle;
      }
      return {
        area: land,
        distanceKm: high,
        point: destinationPoint(origin, heading, high),
      };
    }

    previousDistance = distance;
    previousLand = isNewLand ? land : null;
  }

  return null;
}
