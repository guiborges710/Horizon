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
    id: 'praia-do-leme',
    name: 'PRAIA DO LEME',
    latitude: -22.9644465,
    longitude: -43.1698569,
    category: 'beach',
    importance: 0.82,
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
  {
    id: 'praia-de-copacabana',
    name: 'PRAIA DE COPACABANA',
    latitude: -22.9757003,
    longitude: -43.1866161,
    category: 'beach',
    importance: 0.9,
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
  return TOURIST_POINTS
    .map((point) => {
      const target = { latitude: point.latitude, longitude: point.longitude };
      const bearing = calculateBearing(origin, target);
      const distanceKm = calculateDistance(origin, target);
      const position = getArPosition(bearing, heading, pitchDegrees, horizontalFov);
      return {
        ...point,
        bearing,
        distanceKm,
        alignment: angularDifference(bearing, heading),
        position,
      };
    })
    .filter((point) => point.alignment <= horizontalFov / 2)
    .sort((first, second) => (
      first.alignment - second.alignment ||
      second.importance - first.importance ||
      first.distanceKm - second.distanceKm
    ))
    .slice(0, 5);
}
