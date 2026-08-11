import {
  angularDifference,
  calculateBearing,
  calculateDistance,
  type GeoPoint,
} from './geodesy';
import { DEFAULT_HORIZONTAL_FOV, getArPosition, type ArPosition } from './ar-position';

export type TouristPoint = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  category: 'landmark' | 'beach' | 'natural' | 'hotel';
  description?: string;
  importance: number;
  city: string;
  country: string;
};

// Coordinates sourced from OpenStreetMap search results for the named places.
// This registry is intentionally data-only so more regions can be added later.
const CATEGORY_PRIORITY: Record<TouristPoint['category'], number> = {
  landmark: 4,
  hotel: 3,
  natural: 2,
  beach: 1,
};

export const TOURIST_POINTS: TouristPoint[] = [
  {
    id: 'forte-de-copacabana',
    name: 'FORTE DE COPACABANA',
    latitude: -22.9864393,
    longitude: -43.1872003,
    category: 'landmark',
    description: 'Museu histórico na ponta de Copacabana',
    importance: 1,
    city: 'Rio de Janeiro',
    country: 'Brasil',
  },
  {
    id: 'pao-de-acucar',
    name: 'PÃO DE AÇÚCAR',
    latitude: -22.9494891,
    longitude: -43.1561568,
    category: 'natural',
    description: 'Morro de referência na entrada da Baía de Guanabara',
    importance: 1,
    city: 'Rio de Janeiro',
    country: 'Brasil',
  },
  {
    id: 'cristo-redentor',
    name: 'CRISTO REDENTOR',
    latitude: -22.9519173,
    longitude: -43.2104585,
    category: 'landmark',
    importance: 1,
    city: 'Rio de Janeiro',
    country: 'Brasil',
  },
  {
    id: 'copacabana-palace',
    name: 'COPACABANA PALACE',
    latitude: -22.9670132,
    longitude: -43.1791849,
    category: 'hotel',
    importance: 0.92,
    city: 'Rio de Janeiro',
    country: 'Brasil',
  },
  {
    id: 'arpoador',
    name: 'ARPOADOR',
    latitude: -22.9885801,
    longitude: -43.1916762,
    category: 'natural',
    importance: 0.82,
    city: 'Rio de Janeiro',
    country: 'Brasil',
  },
];

export type VisibleTouristPoint = TouristPoint & {
  bearing: number;
  distanceKm: number;
  alignment: number;
  position: ArPosition;
};

export function findVisibleTouristPoints(
  origin: GeoPoint,
  heading: number,
  pitchDegrees: number | null,
  horizontalFov = DEFAULT_HORIZONTAL_FOV,
) {
  const points = TOURIST_POINTS
    .map((point) => {
      const target = { latitude: point.latitude, longitude: point.longitude };
      const bearing = calculateBearing(origin, target);
      const distanceKm = calculateDistance(origin, target);
      const alignment = angularDifference(bearing, heading);
      const position = getArPosition(bearing, heading, pitchDegrees, horizontalFov);
      const categoryPriority = CATEGORY_PRIORITY[point.category] ?? 0;
      const specificity = point.importance ?? 0;
      const alignmentScore = Math.max(0, 1 - alignment / 90);
      const score = alignmentScore * 1000 + specificity * 100 + categoryPriority * 10 - Math.min(distanceKm, 200);

      return {
        ...point,
        bearing,
        distanceKm,
        alignment,
        position,
        categoryPriority,
        score,
      };
    })
    .filter((point) => point.alignment <= horizontalFov / 2)
    .sort((first, second) => (
      second.score - first.score ||
      first.alignment - second.alignment ||
      second.importance - first.importance ||
      first.distanceKm - second.distanceKm
    ));

  return points.slice(0, 5);
}
